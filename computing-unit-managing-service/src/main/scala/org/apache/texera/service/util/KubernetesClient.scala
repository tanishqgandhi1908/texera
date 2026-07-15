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

import io.fabric8.kubernetes.api.model._
import io.fabric8.kubernetes.api.model.metrics.v1beta1.PodMetricsList
import io.fabric8.kubernetes.client.KubernetesClientBuilder
import org.apache.texera.common.config.{EnvironmentalVariable, KubernetesConfig}

import scala.jdk.CollectionConverters._

object KubernetesClient {

  // Initialize the Kubernetes client
  private val client: io.fabric8.kubernetes.client.KubernetesClient =
    new KubernetesClientBuilder().build()
  private val namespace: String = KubernetesConfig.computeUnitPoolNamespace
  private val podNamePrefix = "computing-unit"

  def generatePodURI(cuid: Int): String = {
    s"${generatePodName(cuid)}.${KubernetesConfig.computeUnitServiceName}.$namespace.svc.cluster.local:${KubernetesConfig.computeUnitPortNumber}"
  }

  def generatePodName(cuid: Int): String = s"$podNamePrefix-$cuid"

  def podExists(cuid: Int): Boolean = {
    getPodByName(generatePodName(cuid)).isDefined
  }

  def getPodByName(podName: String): Option[Pod] = {
    Option(client.pods().inNamespace(namespace).withName(podName).get())
  }

  def getPodMetrics(cuid: Int): Map[String, String] = {
    val podMetricsList: PodMetricsList = client.top().pods().metrics(namespace)
    val targetPodName = generatePodName(cuid)

    podMetricsList.getItems.asScala
      .collectFirst {
        case podMetrics if podMetrics.getMetadata.getName == targetPodName =>
          podMetrics.getContainers.asScala.flatMap { container =>
            container.getUsage.asScala.map {
              case (metric, value) =>
                metric -> value.toString
            }
          }.toMap
      }
      .getOrElse(Map.empty[String, String])
  }

  def getPodLimits(cuid: Int): Map[String, String] = {
    getPodByName(generatePodName(cuid))
      .flatMap { pod =>
        pod.getSpec.getContainers.asScala.headOption.map { container =>
          val limitsMap = container.getResources.getLimits.asScala.map {
            case (key, value) => key -> value.toString
          }.toMap

          limitsMap
        }
      }
      .getOrElse(Map.empty[String, String])
  }

  def createPod(
      cuid: Int,
      cpuLimit: String,
      memoryLimit: String,
      gpuLimit: String,
      envVars: Map[String, Any],
      shmSize: Option[String] = None
  ): Pod = {
    val podName = generatePodName(cuid)
    if (getPodByName(podName).isDefined) {
      throw new Exception(s"Pod with cuid $cuid already exists")
    }

    // ── Model mount (Option B) — how model folders reach the worker ─────────────
    // LOCAL dev: an operator provisions the FUSE mount out-of-band (e.g. `rclone
    //   mount` against the lakeFS S3 gateway) and exports TEXERA_MODEL_MOUNT_ROOT;
    //   there is no pod to patch, so this block is simply disabled.
    // PRODUCTION (here): the manager mounts a CSI-backed, READ-ONLY PersistentVolume
    //   (provisioned by mountpoint-s3 / csi-s3 over the lakeFS S3 gateway) into the
    //   computing-unit pod and sets TEXERA_MODEL_MOUNT_ROOT. The worker's
    //   ModelFolderDocument.download() then returns <root>/<owner>/<name>/<version>
    //   and the CSI layer fetches files lazily on read — no per-pod whole-folder
    //   download. Toggle with KUBERNETES_MODEL_MOUNT_ENABLED=true.
    val modelMountEnabled =
      EnvironmentalVariable.get("KUBERNETES_MODEL_MOUNT_ENABLED").contains("true")
    val modelMountPath =
      EnvironmentalVariable.get("KUBERNETES_MODEL_MOUNT_PATH").getOrElse("/models")
    val modelMountPvc =
      EnvironmentalVariable.get("KUBERNETES_MODEL_MOUNT_PVC").getOrElse("texera-model-store")
    val modelMountVolumeName = "texera-model-store"

    val effectiveEnvVars =
      if (modelMountEnabled)
        envVars + (EnvironmentalVariable.ENV_TEXERA_MODEL_MOUNT_ROOT -> modelMountPath)
      else envVars

    val envList = effectiveEnvVars
      .map {
        case (key, value) =>
          new EnvVarBuilder()
            .withName(key)
            .withValue(value.toString)
            .build()
      }
      .toList
      .asJava

    // Setup the resource requirements
    val resourceBuilder = new ResourceRequirementsBuilder()
      .addToLimits("cpu", new Quantity(cpuLimit))
      .addToLimits("memory", new Quantity(memoryLimit))

    // Only add GPU resources if the requested amount is greater than 0
    if (gpuLimit != "0") {
      // Use the configured GPU resource key directly
      resourceBuilder.addToLimits(KubernetesConfig.gpuResourceKey, new Quantity(gpuLimit))
    }

    // Build the pod with metadata
    val podBuilder = new PodBuilder()
      .withNewMetadata()
      .withName(podName)
      .withNamespace(namespace)
      .addToLabels("type", "computing-unit")
      .addToLabels("cuid", cuid.toString)
      .addToLabels("name", podName)

    // Start building the pod spec
    val specBuilder = podBuilder
      .endMetadata()
      .withNewSpec()

    // Only add runtimeClassName when using NVIDIA GPU
    if (gpuLimit != "0" && KubernetesConfig.gpuResourceKey.contains("nvidia")) {
      specBuilder.withRuntimeClassName("nvidia")
    }

    val containerBuilder = specBuilder
      .addNewContainer()
      .withName("computing-unit-master")
      .withImage(KubernetesConfig.computeUnitImageName)
      .withImagePullPolicy(KubernetesConfig.computingUnitImagePullPolicy)
      .addNewPort()
      .withContainerPort(KubernetesConfig.computeUnitPortNumber)
      .endPort()
      .withEnv(envList)
      .withResources(resourceBuilder.build())

    // If shmSize requested, mount /dev/shm
    shmSize.foreach { _ =>
      containerBuilder
        .addNewVolumeMount()
        .withName("dshm")
        .withMountPath("/dev/shm")
        .endVolumeMount()
    }

    // Read-only mount of the model store into the worker container (Option B, prod)
    if (modelMountEnabled) {
      containerBuilder
        .addNewVolumeMount()
        .withName(modelMountVolumeName)
        .withMountPath(modelMountPath)
        .withReadOnly(true)
        .endVolumeMount()
    }

    containerBuilder.endContainer()

    // Add tmpfs volume if needed
    shmSize.foreach { size =>
      specBuilder
        .addNewVolume()
        .withName("dshm")
        .withEmptyDir(
          new EmptyDirVolumeSourceBuilder()
            .withMedium("Memory")
            .withSizeLimit(new Quantity(size))
            .build()
        )
        .endVolume()
    }

    // Model-store volume: a CSI/PVC exposing lakeFS model versions, mounted read-only
    // (Option B, production). The PVC is provisioned at deploy time by the S3 CSI driver.
    if (modelMountEnabled) {
      specBuilder
        .addNewVolume()
        .withName(modelMountVolumeName)
        .withNewPersistentVolumeClaim()
        .withClaimName(modelMountPvc)
        .withReadOnly(true)
        .endPersistentVolumeClaim()
        .endVolume()
    }

    val pod = specBuilder
      .withHostname(podName)
      .withSubdomain(KubernetesConfig.computeUnitServiceName)
      .endSpec()
      .build()

    client.resource(pod).inNamespace(namespace).create()
  }

  def deletePod(cuid: Int): Unit = {
    client.pods().inNamespace(namespace).withName(generatePodName(cuid)).delete()
  }
}
