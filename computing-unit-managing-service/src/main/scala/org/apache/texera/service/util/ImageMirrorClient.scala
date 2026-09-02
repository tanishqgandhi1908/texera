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
       |START_CMD=$$(skopeo inspect --config \\
       |  --format '{{.Config.Cmd}} {{.Config.Entrypoint}}' \\
       |  "docker://$sourceRef")
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
