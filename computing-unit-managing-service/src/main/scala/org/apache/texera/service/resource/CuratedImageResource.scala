/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.texera.service.resource

import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import jakarta.annotation.security.RolesAllowed
import jakarta.ws.rs._
import jakarta.ws.rs.core.MediaType
import org.apache.texera.auth.SessionUser
import org.apache.texera.common.config.CuratedImageConfig
import org.apache.texera.dao.SqlServer
import org.apache.texera.service.util.ImageMirrorClient
import org.apache.texera.service.util.ImageMirrorClient.MirrorState
import org.jooq.impl.DSL
import org.jooq.{DSLContext, Record}

import java.sql.Timestamp
import scala.jdk.CollectionConverters._

object CuratedImageResource {

  private def context: DSLContext = SqlServer.getInstance().createDSLContext()

  // Plain DSL rather than generated DAOs: the jOOQ sources are generated against a live
  // database at build time and are not in the repository, so a new table is not reachable
  // through them until that regeneration has happened everywhere. Naming the columns here
  // keeps this table buildable from a clean checkout.
  private val CU_IMAGE = DSL.table(DSL.name("cu_image"))
  private val IID = DSL.field(DSL.name("iid"), classOf[Integer])
  private val NAME = DSL.field(DSL.name("name"), classOf[String])
  private val SOURCE_REF = DSL.field(DSL.name("source_ref"), classOf[String])
  private val SOURCE_DIGEST = DSL.field(DSL.name("source_digest"), classOf[String])
  private val STATUS = DSL.field(DSL.name("status"), classOf[String])
  private val IMAGE_TAG = DSL.field(DSL.name("image_tag"), classOf[String])
  private val MIRROR_NUMBER = DSL.field(DSL.name("mirror_number"), classOf[Integer])
  private val MIRROR_LOG = DSL.field(DSL.name("mirror_log"), classOf[String])
  private val CREATED_BY = DSL.field(DSL.name("created_by"), classOf[Integer])
  private val CREATION_TIME = DSL.field(DSL.name("creation_time"), classOf[Timestamp])
  private val UPDATE_TIME = DSL.field(DSL.name("update_time"), classOf[Timestamp])

  object Status {
    val Pending = "PENDING"
    val Mirroring = "MIRRORING"
    val Ready = "READY"
    val Failed = "FAILED"
  }

  case class CuratedImage(
      iid: Int,
      name: String,
      sourceRef: String,
      sourceDigest: String,
      status: String,
      imageTag: String,
      mirrorNumber: Int,
      creationTime: Long,
      updateTime: Long
  )

  case class CuratedImageRequest(name: String, sourceRef: String)
  case class MirrorLog(iid: Int, status: String, mirrorNumber: Int, log: String)

  private val NamePattern = "^[A-Za-z0-9][A-Za-z0-9._ -]*$".r
  private val MaxNameLength = 128
  private val MaxRefLength = 512

  /**
    * A Docker Hub web address and an image reference are not the same string, and an
    * administrator copying from a browser will naturally paste the former. Accepting both
    * costs a few lines here and removes a confusing failure that would otherwise only
    * surface once the mirror job had already started.
    */
  private[resource] def normaliseRef(raw: String): String = {
    val trimmed = raw.trim.stripSuffix("/")
    val withoutScheme = trimmed.replaceFirst("^https?://", "")
    val repo =
      if (withoutScheme.startsWith("hub.docker.com/r/")) {
        withoutScheme.stripPrefix("hub.docker.com/r/")
      } else if (withoutScheme.startsWith("hub.docker.com/_/")) {
        // A Docker official image: its pull reference is the bare name, not the path.
        withoutScheme.stripPrefix("hub.docker.com/_/")
      } else {
        withoutScheme
      }

    // A tag is only absent if the administrator left it off. Defaulting is friendlier than
    // rejecting, and matches what every container tool does with the same input. The check
    // looks after the last slash so a registry's port is not mistaken for a tag.
    val lastSegment = repo.substring(repo.lastIndexOf('/') + 1)
    if (lastSegment.contains(":") || repo.contains("@sha256:")) repo else s"$repo:latest"
  }

  private def toCuratedImage(record: Record): CuratedImage =
    CuratedImage(
      iid = record.get(IID),
      name = record.get(NAME),
      sourceRef = record.get(SOURCE_REF),
      sourceDigest = record.get(SOURCE_DIGEST),
      status = record.get(STATUS),
      imageTag = record.get(IMAGE_TAG),
      mirrorNumber = record.get(MIRROR_NUMBER),
      creationTime = record.get(CREATION_TIME).getTime,
      updateTime = record.get(UPDATE_TIME).getTime
    )

  /**
    * The image a computing unit should be started from, or None if it is not one that can
    * be started. Unlike the environments this replaces there is no ownership check: a
    * curated image is offered to every user by design.
    */
  def readyImageFor(iid: Int): Option[String] = {
    val record = Option(
      context.select(STATUS, IMAGE_TAG).from(CU_IMAGE).where(IID.eq(iid)).fetchOne()
    )
    record.flatMap { r =>
      if (r.get(STATUS) == Status.Ready) Option(r.get(IMAGE_TAG)) else None
    }
  }

  def nameOf(iid: Int): Option[String] =
    Option(context.select(NAME).from(CU_IMAGE).where(IID.eq(iid)).fetchOne()).map(_.get(NAME))

  /**
    * Brings rows that were mirroring up to date with what the cluster actually did. A
    * mirror finishes on the cluster, not in this service, so a row only learns its outcome
    * when someone looks. That keeps the feature free of background threads and leader
    * election, at the cost of a status that is stale until the next read -- which the UI
    * polls through anyway while a mirror is running.
    */
  private def reconcileRunningMirrors(): Unit = {
    val running = context
      .select(IID, MIRROR_NUMBER, UPDATE_TIME)
      .from(CU_IMAGE)
      .where(STATUS.eq(Status.Mirroring))
      .fetch()
      .asScala
      .toList

    running.foreach { row =>
      val iid = row.get(IID).intValue()
      val mirrorNumber = row.get(MIRROR_NUMBER).intValue()
      val log = ImageMirrorClient.mirrorLog(iid, mirrorNumber)

      ImageMirrorClient.mirrorState(iid, mirrorNumber) match {
        case MirrorState.Running =>
          // Kept fresh so the log can be watched while the copy is still going.
          log.foreach(text => updateLogOnly(iid, text))

        case MirrorState.Succeeded =>
          val text = log.getOrElse("")
          finishMirror(
            iid,
            Status.Ready,
            Some(CuratedImageConfig.imageTagFor(iid, mirrorNumber)),
            ImageMirrorClient.sourceDigestFrom(text),
            text
          )

        case MirrorState.Failed =>
          finishMirror(iid, Status.Failed, None, None, log.getOrElse(""))

        case MirrorState.Absent =>
          // The job is created just after the row is marked MIRRORING and the two are not
          // atomic, so a mirror submitted moments ago legitimately has no job yet. Only a
          // row that has been waiting a while is genuinely orphaned.
          val age = System.currentTimeMillis() - row.get(UPDATE_TIME).getTime
          if (age > AbsentGracePeriodMillis) {
            finishMirror(
              iid,
              Status.Failed,
              None,
              None,
              "The mirror job disappeared before it reported a result."
            )
          }
      }
    }
  }

  private val AbsentGracePeriodMillis = 60_000L

  private def updateLogOnly(iid: Int, log: String): Unit =
    context.update(CU_IMAGE).set(MIRROR_LOG, log).where(IID.eq(iid)).execute()

  private def finishMirror(
      iid: Int,
      status: String,
      imageTag: Option[String],
      sourceDigest: Option[String],
      log: String
  ): Unit = {
    val update = context
      .update(CU_IMAGE)
      .set(STATUS, status)
      .set(MIRROR_LOG, log)
      .set(UPDATE_TIME, new Timestamp(System.currentTimeMillis()))

    // A failed mirror leaves the previous image_tag alone: a unit already running on the
    // last good copy should keep working, and the row's status already says the newest
    // attempt did not land.
    val withTag = imageTag.fold(update)(tag => update.set(IMAGE_TAG, tag))
    val withDigest = sourceDigest.fold(withTag)(digest => withTag.set(SOURCE_DIGEST, digest))
    withDigest.where(IID.eq(iid)).execute()
  }
}

@Path("/cu-image")
@Produces(Array(MediaType.APPLICATION_JSON))
class CuratedImageResource extends LazyLogging {

  import CuratedImageResource._

  private def requireEnabled(): Unit =
    if (!CuratedImageConfig.enabled) {
      throw new ServiceUnavailableException("Curated images are not enabled on this deployment.")
    }

  private def validate(request: CuratedImageRequest): Unit = {
    val name = Option(request.name).map(_.trim).getOrElse("")
    if (!NamePattern.pattern.matcher(name).matches() || name.length > MaxNameLength) {
      throw new BadRequestException(
        "Image name must start with a letter or digit and contain only letters, digits, " +
          "spaces, dots, hyphens and underscores."
      )
    }
    val ref = Option(request.sourceRef).map(_.trim).getOrElse("")
    if (ref.isEmpty) {
      throw new BadRequestException("Docker Hub link cannot be empty.")
    }
    if (ref.length > MaxRefLength) {
      throw new BadRequestException(s"Docker Hub link exceeds $MaxRefLength characters.")
    }
    // Whitespace inside a reference means two things were pasted, or a copy went wrong.
    // Either way the mirror would fail with a much less obvious message.
    if (normaliseRef(ref).exists(_.isWhitespace)) {
      throw new BadRequestException("Docker Hub link cannot contain spaces.")
    }
  }

  /**
    * Every signed-in user may read the list, because the computing-unit dropdown is built
    * from it. Only an administrator may change it -- that restriction is the whole reason
    * this replaced user-supplied Dockerfiles, since a curated image is trusted precisely
    * because a user could not add it.
    */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("")
  def list(@Auth user: SessionUser): List[CuratedImage] = {
    requireEnabled()
    reconcileRunningMirrors()
    context
      .select()
      .from(CU_IMAGE)
      .orderBy(NAME.asc())
      .fetch()
      .asScala
      .map(toCuratedImage)
      .toList
  }

  @GET
  @RolesAllowed(Array("ADMIN"))
  @Path("/{iid}/log")
  def log(@PathParam("iid") iid: Int, @Auth user: SessionUser): MirrorLog = {
    requireEnabled()
    reconcileRunningMirrors()
    val record = Option(
      context.select(STATUS, MIRROR_NUMBER, MIRROR_LOG).from(CU_IMAGE).where(IID.eq(iid)).fetchOne()
    ).getOrElse(throw new NotFoundException(s"No curated image $iid."))

    MirrorLog(
      iid = iid,
      status = record.get(STATUS),
      mirrorNumber = record.get(MIRROR_NUMBER).intValue(),
      log = Option(record.get(MIRROR_LOG)).getOrElse("")
    )
  }

  @POST
  @RolesAllowed(Array("ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Path("")
  def create(request: CuratedImageRequest, @Auth user: SessionUser): CuratedImage = {
    requireEnabled()
    validate(request)
    val name = request.name.trim
    val sourceRef = normaliseRef(request.sourceRef)

    if (context.fetchExists(context.selectFrom(CU_IMAGE).where(NAME.eq(name)))) {
      throw new BadRequestException(s"An image named '$name' already exists.")
    }

    val iid = context
      .insertInto(CU_IMAGE)
      .set(NAME, name)
      .set(SOURCE_REF, sourceRef)
      .set(STATUS, Status.Pending)
      .set(CREATED_BY, Integer.valueOf(user.getUid.intValue()))
      .returning(IID)
      .fetchOne()
      .get(IID)
      .intValue()

    startMirror(iid, sourceRef)
    fetch(iid)
  }

  /**
    * Copies the source again. The reference an administrator gave is usually a tag, and a
    * tag upstream can be moved; this is how a deployment picks up such a change, and how a
    * mirror that failed on the network is retried.
    */
  @POST
  @RolesAllowed(Array("ADMIN"))
  @Path("/{iid}/refresh")
  def refresh(@PathParam("iid") iid: Int, @Auth user: SessionUser): CuratedImage = {
    requireEnabled()
    val record = Option(
      context.select(SOURCE_REF).from(CU_IMAGE).where(IID.eq(iid)).fetchOne()
    ).getOrElse(throw new NotFoundException(s"No curated image $iid."))

    startMirror(iid, record.get(SOURCE_REF))
    fetch(iid)
  }

  @DELETE
  @RolesAllowed(Array("ADMIN"))
  @Path("/{iid}")
  def delete(@PathParam("iid") iid: Int, @Auth user: SessionUser): Unit = {
    requireEnabled()
    // The mirrored layers in the registry are deliberately left behind. A unit started
    // from this image may still be running, and reclaiming them is the registry's own
    // garbage collection to do once nothing references them.
    ImageMirrorClient.deleteAllMirrors(iid)
    val deleted = context.deleteFrom(CU_IMAGE).where(IID.eq(iid)).execute()
    if (deleted == 0) {
      throw new NotFoundException(s"No curated image $iid.")
    }
  }

  /** Marks the row as mirroring and submits the job, in that order. */
  private def startMirror(iid: Int, sourceRef: String): Unit = {
    val mirrorNumber = context
      .select(MIRROR_NUMBER)
      .from(CU_IMAGE)
      .where(IID.eq(iid))
      .fetchOne()
      .get(MIRROR_NUMBER)
      .intValue() + 1

    context
      .update(CU_IMAGE)
      .set(STATUS, Status.Mirroring)
      .set(MIRROR_NUMBER, Integer.valueOf(mirrorNumber))
      .set(MIRROR_LOG, "")
      .set(UPDATE_TIME, new Timestamp(System.currentTimeMillis()))
      .where(IID.eq(iid))
      .execute()

    try {
      ImageMirrorClient.startMirror(iid, mirrorNumber, sourceRef)
    } catch {
      // Without this the row would sit in MIRRORING waiting for a job that was never
      // created, and only the grace period would eventually call it failed.
      case e: Throwable =>
        logger.error(s"Could not start mirror for image $iid", e)
        context
          .update(CU_IMAGE)
          .set(STATUS, Status.Failed)
          .set(MIRROR_LOG, s"Could not start the mirror job: ${e.getMessage}")
          .where(IID.eq(iid))
          .execute()
    }
  }

  private def fetch(iid: Int): CuratedImage =
    Option(context.select().from(CU_IMAGE).where(IID.eq(iid)).fetchOne())
      .map(toCuratedImage)
      .getOrElse(throw new NotFoundException(s"No curated image $iid."))
}
