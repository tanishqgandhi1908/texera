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

package org.apache.texera.service.util

import com.typesafe.scalalogging.LazyLogging
import io.fabric8.kubernetes.api.model._
import io.fabric8.kubernetes.api.model.batch.v1.{Job, JobBuilder}
import io.fabric8.kubernetes.client.KubernetesClientBuilder
import org.apache.texera.common.config.CuratedImageConfig

import scala.jdk.CollectionConverters._

/**
  * Copies a curated image from wherever an administrator pointed at into the in-cluster
  * registry, so a computing unit never pulls from an upstream registry when it starts.
  *
  * skopeo rather than a pull-and-push through a daemon: it copies registry to registry
  * directly, needs no Docker socket and no privileged pod, and can inspect an image's
  * config without downloading its layers -- which is what makes validating before copying
  * worth doing at all.
  */
object ImageMirrorClient extends LazyLogging {

  private val client: io.fabric8.kubernetes.client.KubernetesClient =
    new KubernetesClientBuilder().build()

  private def namespace: String = CuratedImageConfig.mirrorNamespace

  /** Printed by the job and read back out of its log, since a Job cannot return a value. */
  private val DigestMarker = "TEXERA_SOURCE_DIGEST="

  /**
    * Validate first, then copy. The inspect fetches only the manifest and config blob --
    * a few kilobytes -- so a reference that is misspelled, private, or simply not a Texera
    * computing-unit image fails within seconds instead of after copying tens of gigabytes.
    *
    * The check looks at Cmd and Entrypoint rather than the whole config, because a match
    * anywhere in the config would also be satisfied by an unrelated environment variable
    * that happened to mention the name.
    */
  private def mirrorScript(sourceRef: String, destRef: String): String =
    s"""set -eu
       |
       |echo "Inspecting $sourceRef"
       |if ! START_CMD=$$(skopeo inspect --config \\
       |  --format '{{.Config.Cmd}} {{.Config.Entrypoint}}' \\
       |  "docker://$sourceRef" 2>&1); then
       |  echo ""
       |  echo "ERROR: could not read $sourceRef from its registry."
       |  echo "$$START_CMD"
       |  echo ""
       |  echo "If that says the manifest is unknown, the tag does not exist. A Docker Hub"
       |  echo "page address carries no tag, so ':latest' was assumed -- and many images do"
       |  echo "not publish one. Register the reference with the tag you want, for example"
       |  echo "'owner/name:1.0'."
       |  echo "If it mentions authorisation, the image is private; only public images can"
       |  echo "be mirrored."
       |  exit 1
       |fi
       |echo "Start command: $$START_CMD"
       |
       |if ! echo "$$START_CMD" | grep -q '${CuratedImageConfig.requiredCommand}'; then
       |  echo ""
       |  echo "ERROR: $sourceRef does not look like a Texera computing-unit image."
       |  echo "Its start command is: $$START_CMD"
       |  echo "A computing-unit image must run '${CuratedImageConfig.requiredCommand}',"
       |  echo "which means being built FROM the Texera computing-unit image."
       |  exit 1
       |fi
       |
       |DIGEST=$$(skopeo inspect --format '{{.Digest}}' "docker://$sourceRef")
       |echo "$DigestMarker$$DIGEST"
       |
       |echo "Copying to $destRef"
       |skopeo copy --dest-tls-verify=false \\
       |  "docker://$sourceRef" "docker://$destRef"
       |echo "Mirrored $sourceRef to $destRef"
       |""".stripMargin

  def startMirror(iid: Int, mirrorNumber: Int, sourceRef: String): Unit = {
    val jobName = CuratedImageConfig.mirrorJobName(iid, mirrorNumber)
    val destRef = CuratedImageConfig.imageTagFor(iid, mirrorNumber)

    // A previous attempt at the same number can only exist if it was abandoned, and its
    // result would be discarded anyway.
    deleteMirror(iid, mirrorNumber)

    val job = mirrorJob(jobName, iid, sourceRef, destRef)
    client.batch().v1().jobs().inNamespace(namespace).resource(job).create()
    logger.info(s"Started mirror $jobName copying $sourceRef to $destRef")
  }

  private def mirrorJob(jobName: String, iid: Int, sourceRef: String, destRef: String): Job = {
    val resources = new ResourceRequirementsBuilder()
      .addToRequests("cpu", new Quantity(CuratedImageConfig.mirrorCpuRequest))
      .addToRequests("memory", new Quantity(CuratedImageConfig.mirrorMemoryRequest))
      .addToLimits("cpu", new Quantity(CuratedImageConfig.mirrorCpuLimit))
      .addToLimits("memory", new Quantity(CuratedImageConfig.mirrorMemoryLimit))
      .build()

    new JobBuilder()
      .withNewMetadata()
      .withName(jobName)
      .withNamespace(namespace)
      .addToLabels("texera-cu-image", iid.toString)
      .endMetadata()
      .withNewSpec()
      // A rejected image is rejected deterministically, and a copy that failed on the
      // network is better retried by an administrator who can see why.
      .withBackoffLimit(0)
      .withActiveDeadlineSeconds(CuratedImageConfig.mirrorTimeoutSeconds.toLong)
      .withNewTemplate()
      .withNewMetadata()
      .addToLabels("texera-cu-image", iid.toString)
      .endMetadata()
      .withNewSpec()
      .withRestartPolicy("Never")
      .addNewContainer()
      .withName("skopeo")
      .withImage(CuratedImageConfig.mirrorImage)
      .withCommand("/bin/sh", "-c")
      .withArgs(mirrorScript(sourceRef, destRef))
      .withResources(resources)
      .endContainer()
      .endSpec()
      .endTemplate()
      .endSpec()
      .build()
  }

  sealed trait MirrorState
  object MirrorState {
    case object Running extends MirrorState
    case object Succeeded extends MirrorState
    case object Failed extends MirrorState

    /** The job is gone -- cleaned up, or never created. */
    case object Absent extends MirrorState
  }

  def mirrorState(iid: Int, mirrorNumber: Int): MirrorState = {
    val job = Option(
      client
        .batch()
        .v1()
        .jobs()
        .inNamespace(namespace)
        .withName(CuratedImageConfig.mirrorJobName(iid, mirrorNumber))
        .get()
    )

    job match {
      case None => MirrorState.Absent
      case Some(j) =>
        val status = Option(j.getStatus)
        val succeeded = status.flatMap(s => Option(s.getSucceeded)).exists(_ > 0)
        val failed = status.flatMap(s => Option(s.getFailed)).exists(_ > 0)
        if (succeeded) MirrorState.Succeeded
        else if (failed) MirrorState.Failed
        else MirrorState.Running
    }
  }

  /** The job's output, readable while it runs and after it finishes. */
  def mirrorLog(iid: Int, mirrorNumber: Int): Option[String] = {
    val pods = client
      .pods()
      .inNamespace(namespace)
      .withLabel("job-name", CuratedImageConfig.mirrorJobName(iid, mirrorNumber))
      .list()
      .getItems
      .asScala
      .toList

    pods.headOption.flatMap { pod =>
      try {
        Option(client.pods().inNamespace(namespace).withName(pod.getMetadata.getName).getLog(true))
      } catch {
        // A pod whose container has not started yet has no log, which is an ordinary
        // state during a mirror rather than something to report as an error.
        case e: Throwable =>
          logger.debug(s"No log yet for mirror $iid/$mirrorNumber: ${e.getMessage}")
          None
      }
    }
  }

  /**
    * Explains why submitting a mirror failed, in terms an administrator can act on.
    *
    * The message alone is not enough. A client with no usable kube config falls back to
    * the legacy http://localhost:8080 API address, and whatever answers there produces an
    * opaque failure -- "An error has occurred." if something unrelated is listening on
    * that port, which on a development machine it usually is. That reads as a Texera bug
    * rather than a missing cluster, so the address actually being used is named here.
    */
  def describeStartFailure(e: Throwable): String = {
    val cause = Option(e.getCause).filter(_ ne e)
    val detail = Option(e.getMessage)
      .map(_.trim)
      .filter(_.nonEmpty)
      .getOrElse("no message")
    val master =
      try Option(client.getMasterUrl).map(_.toString).getOrElse("unknown")
      catch { case _: Throwable => "unknown" }

    s"""Could not start the mirror job.
       |
       |  ${e.getClass.getSimpleName}: $detail${cause
      .map(c => s"\n  caused by ${c.getClass.getSimpleName}: ${Option(c.getMessage).getOrElse("")}")
      .getOrElse("")}
       |
       |Kubernetes API address: $master
       |Namespace:              $namespace
       |
       |Mirroring runs as a Kubernetes Job, so this needs a reachable cluster. If the
       |address above is http://localhost:8080 then no kube context is set and the client
       |fell back to that default -- check `kubectl config current-context`, and that the
       |namespace above exists.""".stripMargin
  }

  /** The digest the source tag resolved to, as printed by a successful job. */
  def sourceDigestFrom(log: String): Option[String] =
    log.linesIterator
      .map(_.trim)
      .find(_.startsWith(DigestMarker))
      .map(_.drop(DigestMarker.length).trim)
      .filter(_.nonEmpty)

  /**
    * Whether the registry still holds a mirrored reference: Some(true)/Some(false) when it
    * answered, None when it could not be asked.
    *
    * Worth asking because the catalogue and the registry can disagree. Delete and recreate
    * the cluster -- or just the registry's volume -- and every row still reads READY with an
    * image_tag pointing at something no longer there. A unit started from such a row sits in
    * ImagePullBackOff, which says nothing about the real problem or its fix (re-mirror).
    *
    * Unreachable is deliberately NOT treated as absent. The registry is reachable at a
    * ClusterIP, which a manager running outside the cluster cannot resolve, so answering
    * "absent" there would block every start on a topology where the check simply cannot
    * run. Being unable to check is not evidence of anything.
    */
  def registryHasImage(imageTag: String): Option[Boolean] = {
    val parsed = splitImageReference(imageTag)
    if (parsed.isEmpty) return None
    val (registry, repository, tag) = parsed.get

    try {
      val url = new java.net.URI(s"http://$registry/v2/$repository/manifests/$tag").toURL
      val connection = url.openConnection().asInstanceOf[java.net.HttpURLConnection]
      try {
        connection.setRequestMethod("HEAD")
        connection.setConnectTimeout(RegistryProbeTimeoutMs)
        connection.setReadTimeout(RegistryProbeTimeoutMs)
        // Without this the registry answers 404 for a manifest it does have, because the
        // default Accept does not include the schema the manifest is stored in.
        connection.setRequestProperty(
          "Accept",
          "application/vnd.docker.distribution.manifest.v2+json," +
            "application/vnd.oci.image.manifest.v1+json," +
            "application/vnd.docker.distribution.manifest.list.v2+json," +
            "application/vnd.oci.image.index.v1+json"
        )
        val status = connection.getResponseCode
        if (status == 404) Some(false)
        else if (status >= 200 && status < 400) Some(true)
        else None
      } finally connection.disconnect()
    } catch {
      case e: Throwable =>
        logger.debug(s"Could not ask the registry about $imageTag: ${e.getMessage}")
        None
    }
  }

  private val RegistryProbeTimeoutMs = 3000

  /**
    * Splits "<registry>/<repository>:<tag>" into its three parts.
    *
    * The tag is taken from the LAST colon, because the registry address carries one of its
    * own for the port -- looking for the first would read ":5000/texera-cu/2" as the tag.
    * None for anything that is not a registry-qualified, tagged reference, which is all
    * this ever has to handle: these references are produced by imageTagFor.
    */
  private[service] def splitImageReference(imageTag: String): Option[(String, String, String)] = {
    val reference = Option(imageTag).map(_.trim).getOrElse("")
    val separator = reference.lastIndexOf(':')
    if (separator <= 0 || separator == reference.length - 1) return None
    val (withoutTag, tag) = (reference.substring(0, separator), reference.substring(separator + 1))
    val slash = withoutTag.indexOf('/')
    if (slash <= 0 || slash == withoutTag.length - 1) return None
    // A tag cannot contain a slash; if one appears after the colon the reference is not
    // tagged at all and the "tag" is really part of the repository path.
    if (tag.contains('/')) return None
    Some((withoutTag.substring(0, slash), withoutTag.substring(slash + 1), tag))
  }

  /** Removes one mirror's job. Safe to call when it does not exist. */
  def deleteMirror(iid: Int, mirrorNumber: Int): Unit = {
    val jobName = CuratedImageConfig.mirrorJobName(iid, mirrorNumber)
    try {
      client
        .batch()
        .v1()
        .jobs()
        .inNamespace(namespace)
        .withName(jobName)
        .withPropagationPolicy(DeletionPropagation.BACKGROUND)
        .delete()
    } catch {
      case e: Throwable => logger.warn(s"Could not clean up mirror $jobName: ${e.getMessage}")
    }
  }

  /** Removes every mirror job belonging to an image, for when it is deleted. */
  def deleteAllMirrors(iid: Int): Unit = {
    try {
      client
        .batch()
        .v1()
        .jobs()
        .inNamespace(namespace)
        .withLabel("texera-cu-image", iid.toString)
        .withPropagationPolicy(DeletionPropagation.BACKGROUND)
        .delete()
    } catch {
      case e: Throwable =>
        logger.warn(s"Could not clean up mirrors for image $iid: ${e.getMessage}")
    }
  }
}
