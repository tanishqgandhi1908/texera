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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.apache.texera.service.resource

import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import jakarta.annotation.security.RolesAllowed
import jakarta.ws.rs._
import jakarta.ws.rs.core.MediaType
import org.apache.texera.auth.SessionUser
import org.apache.texera.common.config.EnvironmentConfig
import org.apache.texera.dao.SqlServer
import org.apache.texera.service.util.EnvironmentBuildClient
import org.apache.texera.service.util.EnvironmentBuildClient.BuildState
import org.jooq.impl.DSL
import org.jooq.{DSLContext, Record}

import java.sql.Timestamp
import scala.jdk.CollectionConverters._

object EnvironmentResource {

  private def context: DSLContext = SqlServer.getInstance().createDSLContext()

  // Plain DSL rather than generated DAOs: the jOOQ sources are generated against a live
  // database at build time and are not in the repository, so a new table is not reachable
  // through them until that regeneration has happened everywhere. Naming the columns here
  // keeps this table buildable from a clean checkout.
  private val ENVIRONMENT = DSL.table(DSL.name("environment"))
  private val EID = DSL.field(DSL.name("eid"), classOf[Integer])
  private val UID = DSL.field(DSL.name("uid"), classOf[Integer])
  private val NAME = DSL.field(DSL.name("name"), classOf[String])
  private val DOCKERFILE = DSL.field(DSL.name("dockerfile"), classOf[String])
  private val STATUS = DSL.field(DSL.name("status"), classOf[String])
  private val IMAGE_TAG = DSL.field(DSL.name("image_tag"), classOf[String])
  private val BUILD_NUMBER = DSL.field(DSL.name("build_number"), classOf[Integer])
  private val BUILD_LOG = DSL.field(DSL.name("build_log"), classOf[String])
  private val CREATION_TIME = DSL.field(DSL.name("creation_time"), classOf[Timestamp])
  private val UPDATE_TIME = DSL.field(DSL.name("update_time"), classOf[Timestamp])

  object Status {
    val Pending = "PENDING"
    val Building = "BUILDING"
    val Ready = "READY"
    val Failed = "FAILED"
  }

  case class Environment(
      eid: Int,
      name: String,
      dockerfile: String,
      status: String,
      imageTag: String,
      buildNumber: Int,
      creationTime: Long,
      updateTime: Long
  )

  case class EnvironmentRequest(name: String, dockerfile: String)
  case class BuildLog(eid: Int, status: String, buildNumber: Int, log: String)
  case class DefaultDockerfile(baseImage: String, dockerfile: String)

  private val NamePattern = "^[A-Za-z0-9][A-Za-z0-9._-]*$".r
  private val MaxNameLength = 128
  private val MaxDockerfileBytes = 256 * 1024

  private def toEnvironment(record: Record): Environment =
    Environment(
      eid = record.get(EID),
      name = record.get(NAME),
      dockerfile = record.get(DOCKERFILE),
      status = record.get(STATUS),
      imageTag = record.get(IMAGE_TAG),
      buildNumber = record.get(BUILD_NUMBER),
      creationTime = record.get(CREATION_TIME).getTime,
      updateTime = record.get(UPDATE_TIME).getTime
    )

  /**
    * The image a computing unit should be started from for this environment, or None if
    * the environment is not one this user can start from.
    *
    * Used by the computing-unit manager, which is why it is here rather than reached
    * through the REST layer.
    */
  def readyImageFor(eid: Int, uid: Int): Option[String] = {
    val record = Option(
      context
        .select(STATUS, IMAGE_TAG)
        .from(ENVIRONMENT)
        .where(EID.eq(eid).and(UID.eq(uid)))
        .fetchOne()
    )
    record.flatMap { r =>
      if (r.get(STATUS) == Status.Ready) Option(r.get(IMAGE_TAG)) else None
    }
  }

  def nameOf(eid: Int): Option[String] =
    Option(context.select(NAME).from(ENVIRONMENT).where(EID.eq(eid)).fetchOne())
      .map(_.get(NAME))
}

/**
  * Environments: a Dockerfile a user owns, and the image built from it.
  *
  * The build is asynchronous by nature -- it takes minutes -- so every write here returns
  * as soon as the job is submitted, and the row's status is what the caller polls. That is
  * also what makes the log readable after navigating away: it is kept on the row, not held
  * in a request.
  */
@Path("/environment")
@Produces(Array(MediaType.APPLICATION_JSON))
class EnvironmentResource extends LazyLogging {

  import EnvironmentResource._

  private def requireEnabled(): Unit =
    if (!EnvironmentConfig.enabled) {
      throw new ServiceUnavailableException("Environments are not enabled on this deployment.")
    }

  private def validate(request: EnvironmentRequest): Unit = {
    val name = Option(request.name).map(_.trim).getOrElse("")
    if (!NamePattern.pattern.matcher(name).matches() || name.length > MaxNameLength) {
      throw new BadRequestException(
        "Environment name must start with a letter or digit and contain only letters, " +
          "digits, dots, hyphens and underscores."
      )
    }
    val dockerfile = Option(request.dockerfile).getOrElse("")
    if (dockerfile.trim.isEmpty) {
      throw new BadRequestException("Dockerfile cannot be empty.")
    }
    if (dockerfile.getBytes("UTF-8").length > MaxDockerfileBytes) {
      throw new BadRequestException(s"Dockerfile exceeds $MaxDockerfileBytes bytes.")
    }
    // A Dockerfile reaches the builder through a ConfigMap, and a build that produced no
    // image would fail confusingly later; catching the obvious case here is much clearer.
    if (!dockerfile.linesIterator.exists(_.trim.toUpperCase.startsWith("FROM "))) {
      throw new BadRequestException("Dockerfile must contain a FROM instruction.")
    }
  }

  /** What a new environment's editor is pre-filled with. */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("/default-dockerfile")
  def getDefaultDockerfile(@Auth user: SessionUser): DefaultDockerfile = {
    requireEnabled()
    DefaultDockerfile(EnvironmentConfig.baseImage, EnvironmentConfig.defaultDockerfile)
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("")
  def list(@Auth user: SessionUser): List[Environment] = {
    requireEnabled()
    val uid = user.getUid.intValue()
    // Reconciled on read: a build finishes on the cluster, not in this service, so the
    // row only learns about it when someone looks. That keeps the whole feature free of
    // background threads and leader election, at the cost of a status that is stale until
    // the next poll -- which the UI does anyway while a build is running.
    reconcileRunningBuilds(uid)
    context
      .select()
      .from(ENVIRONMENT)
      .where(UID.eq(uid))
      .orderBy(CREATION_TIME.desc())
      .fetch()
      .asScala
      .map(toEnvironment)
      .toList
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("/{eid}")
  def get(@PathParam("eid") eid: Int, @Auth user: SessionUser): Environment = {
    requireEnabled()
    reconcileRunningBuilds(user.getUid.intValue())
    fetchOwned(eid, user.getUid.intValue())
  }

  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Path("")
  def create(request: EnvironmentRequest, @Auth user: SessionUser): Environment = {
    requireEnabled()
    validate(request)
    val uid = user.getUid.intValue()
    val name = request.name.trim

    val exists = context.fetchExists(
      context.selectFrom(ENVIRONMENT).where(UID.eq(uid).and(NAME.eq(name)))
    )
    if (exists) {
      throw new BadRequestException(s"You already have an environment named '$name'.")
    }

    val now = new Timestamp(System.currentTimeMillis())
    val eid = context
      .insertInto(ENVIRONMENT)
      .set(UID, Integer.valueOf(uid))
      .set(NAME, name)
      .set(DOCKERFILE, request.dockerfile)
      .set(STATUS, Status.Pending)
      .set(BUILD_NUMBER, Integer.valueOf(0))
      .set(CREATION_TIME, now)
      .set(UPDATE_TIME, now)
      .returning(EID)
      .fetchOne()
      .get(EID)

    startBuild(eid, request.dockerfile)
    fetchOwned(eid, uid)
  }

  /** Editing an environment rebuilds it: the image is what the Dockerfile says it is. */
  @PUT
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Path("/{eid}")
  def update(
      @PathParam("eid") eid: Int,
      request: EnvironmentRequest,
      @Auth user: SessionUser
  ): Environment = {
    requireEnabled()
    validate(request)
    val uid = user.getUid.intValue()
    val existing = fetchOwned(eid, uid)
    val name = request.name.trim

    if (name != existing.name) {
      val clash = context.fetchExists(
        context.selectFrom(ENVIRONMENT).where(UID.eq(uid).and(NAME.eq(name)).and(EID.ne(eid)))
      )
      if (clash) throw new BadRequestException(s"You already have an environment named '$name'.")
    }

    context
      .update(ENVIRONMENT)
      .set(NAME, name)
      .set(DOCKERFILE, request.dockerfile)
      .set(UPDATE_TIME, new Timestamp(System.currentTimeMillis()))
      .where(EID.eq(eid).and(UID.eq(uid)))
      .execute()

    startBuild(eid, request.dockerfile)
    fetchOwned(eid, uid)
  }

  /** Rebuilds without editing -- for a build that failed on something since fixed. */
  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("/{eid}/rebuild")
  def rebuild(@PathParam("eid") eid: Int, @Auth user: SessionUser): Environment = {
    requireEnabled()
    val uid = user.getUid.intValue()
    val existing = fetchOwned(eid, uid)
    startBuild(eid, existing.dockerfile)
    fetchOwned(eid, uid)
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("/{eid}/logs")
  def logs(@PathParam("eid") eid: Int, @Auth user: SessionUser): BuildLog = {
    requireEnabled()
    val uid = user.getUid.intValue()
    val environment = fetchOwned(eid, uid)

    // While the job exists its pod is the live copy and the stored one is behind; once it
    // is gone the stored copy is all there is. Preferring whichever is longer is how a
    // user gets a complete log in both cases without the endpoint needing to know which
    // phase the build is in.
    val live = EnvironmentBuildClient.buildLog(eid, environment.buildNumber).getOrElse("")
    val stored = Option(
      context.select(BUILD_LOG).from(ENVIRONMENT).where(EID.eq(eid)).fetchOne()
    ).flatMap(r => Option(r.get(BUILD_LOG))).getOrElse("")

    val best = if (live.length >= stored.length) live else stored
    val reconciled = reconcileOne(eid, uid)
    BuildLog(eid, reconciled.status, reconciled.buildNumber, best)
  }

  @DELETE
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("/{eid}")
  def delete(@PathParam("eid") eid: Int, @Auth user: SessionUser): Unit = {
    requireEnabled()
    val uid = user.getUid.intValue()
    fetchOwned(eid, uid)
    EnvironmentBuildClient.deleteAllBuilds(eid)
    context.deleteFrom(ENVIRONMENT).where(EID.eq(eid).and(UID.eq(uid))).execute()
  }

  private def fetchOwned(eid: Int, uid: Int): Environment = {
    val record = Option(
      context.select().from(ENVIRONMENT).where(EID.eq(eid).and(UID.eq(uid))).fetchOne()
    )
    record.map(toEnvironment).getOrElse {
      throw new NotFoundException(s"No environment $eid belonging to you.")
    }
  }

  private def startBuild(eid: Int, dockerfile: String): Unit = {
    // A new build supersedes whatever was already running for this environment. Without
    // this, editing or rebuilding while a build is in flight leaves the old job alive to
    // compete with the new one for the same cluster -- and its result is discarded anyway,
    // because finishing a build only writes back to the row for its own build number.
    EnvironmentBuildClient.deleteAllBuilds(eid)

    val next = context
      .update(ENVIRONMENT)
      .set(BUILD_NUMBER, BUILD_NUMBER.add(1))
      .set(STATUS, Status.Building)
      .set(BUILD_LOG, "")
      .set(UPDATE_TIME, new Timestamp(System.currentTimeMillis()))
      .where(EID.eq(eid))
      .returning(BUILD_NUMBER)
      .fetchOne()
      .get(BUILD_NUMBER)

    try {
      EnvironmentBuildClient.startBuild(eid, next, dockerfile)
    } catch {
      case e: Throwable =>
        // The job never started, so nothing on the cluster will ever move this row off
        // BUILDING. Record why here or the environment sits building forever.
        logger.error(s"Could not start build for environment $eid", e)
        context
          .update(ENVIRONMENT)
          .set(STATUS, Status.Failed)
          .set(BUILD_LOG, s"Could not start the build job: ${e.getMessage}")
          .where(EID.eq(eid))
          .execute()
    }
  }

  private def reconcileRunningBuilds(uid: Int): Unit = {
    val building = context
      .select(EID, BUILD_NUMBER, UPDATE_TIME)
      .from(ENVIRONMENT)
      .where(UID.eq(uid).and(STATUS.eq(Status.Building)))
      .fetch()
      .asScala
      .map(r => (r.get(EID).intValue(), r.get(BUILD_NUMBER).intValue(), r.get(UPDATE_TIME)))
      .toList

    building.foreach {
      case (eid, buildNumber, startedAt) => reconcile(eid, buildNumber, startedAt.getTime)
    }
  }

  private def reconcileOne(eid: Int, uid: Int): Environment = {
    val environment = fetchOwned(eid, uid)
    if (environment.status == Status.Building) {
      reconcile(eid, environment.buildNumber, environment.updateTime)
      fetchOwned(eid, uid)
    } else environment
  }

  // A job is created just after the row is marked BUILDING, and the two are not atomic.
  // Within this window "no such job" means "not submitted yet", not "gone", so the row is
  // left alone rather than being failed by a poll that arrived in between.
  private val JobVisibilityGraceMillis = 120000L

  private def reconcile(eid: Int, buildNumber: Int, startedAtMillis: Long): Unit = {
    // A cluster that cannot be reached right now is a reason to leave the row as it is,
    // not a reason to fail the request that happened to trigger the check. The next read
    // reconciles instead.
    val state =
      try EnvironmentBuildClient.buildState(eid, buildNumber)
      catch {
        case e: Throwable =>
          logger.warn(s"Could not check build state for environment $eid: ${e.getMessage}")
          BuildState.Running
      }

    state match {
      case BuildState.Running => ()

      case BuildState.Succeeded =>
        finish(eid, buildNumber, Status.Ready, Some(EnvironmentConfig.imageTagFor(eid, buildNumber)))

      case BuildState.Failed =>
        finish(eid, buildNumber, Status.Failed, None)

      case BuildState.Absent =>
        if (System.currentTimeMillis() - startedAtMillis < JobVisibilityGraceMillis) {
          // Too soon to conclude anything; the job may not have been created yet.
          ()
        } else {
          // The job was cleaned up before anyone read its result. The image either exists
          // in the registry or it does not, and this service cannot tell after the fact,
          // so the honest outcome is a failure the user can retry rather than a READY
          // that might not pull.
          finish(eid, buildNumber, Status.Failed, None)
        }
    }
  }

  private def finish(
      eid: Int,
      buildNumber: Int,
      status: String,
      imageTag: Option[String]
  ): Unit = {
    // Captured before the job is deleted, because deleting it takes the pod's log with it.
    val log = EnvironmentBuildClient
      .buildLog(eid, buildNumber)
      .getOrElse("The build produced no output, or its log was already cleaned up.")

    val update = context
      .update(ENVIRONMENT)
      .set(STATUS, status)
      .set(BUILD_LOG, log)
      .set(UPDATE_TIME, new Timestamp(System.currentTimeMillis()))

    imageTag
      .map(tag => update.set(IMAGE_TAG, tag))
      .getOrElse(update)
      .where(EID.eq(eid).and(BUILD_NUMBER.eq(Integer.valueOf(buildNumber))))
      .execute()

    EnvironmentBuildClient.deleteBuild(eid, buildNumber)
  }
}
