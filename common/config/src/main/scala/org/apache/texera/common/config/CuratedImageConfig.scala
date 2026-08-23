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

package org.apache.texera.common.config

import com.typesafe.config.{Config, ConfigFactory}

object CuratedImageConfig {

  private val conf: Config = ConfigFactory.parseResources("kubernetes.conf").resolve()

  val enabled: Boolean = conf.getBoolean("curated-images.enabled")

  /** Registry the mirrored copies live in, and what a computing-unit pod pulls from. */
  val registry: String = conf.getString("curated-images.registry")

  val mirrorImage: String = conf.getString("curated-images.mirror-image")
  val mirrorNamespace: String = conf.getString("curated-images.mirror-namespace")
  val mirrorTimeoutSeconds: Int = conf.getInt("curated-images.mirror-timeout-seconds")

  val mirrorCpuRequest: String = conf.getString("curated-images.mirror-cpu-request")
  val mirrorMemoryRequest: String = conf.getString("curated-images.mirror-memory-request")
  val mirrorCpuLimit: String = conf.getString("curated-images.mirror-cpu-limit")
  val mirrorMemoryLimit: String = conf.getString("curated-images.mirror-memory-limit")

  /**
    * What a computing unit runs, so an image that does not provide it cannot be one. The
    * computing-unit image declares it as its CMD; the mirror job checks for it before
    * copying anything, so a wrong image fails in seconds rather than after a long copy.
    */
  val requiredCommand: String = "computing-unit-master"

  /**
    * Where a mirrored copy is pushed to and pulled from. The mirror number is part of the
    * tag so re-mirroring publishes a new reference rather than mutating one that a running
    * pod was started from.
    */
  def imageTagFor(iid: Int, mirrorNumber: Int): String =
    s"$registry/texera-cu/$iid:$mirrorNumber"

  /** Kubernetes object name for one mirror. Unique per attempt so retries never collide. */
  def mirrorJobName(iid: Int, mirrorNumber: Int): String = s"cu-image-mirror-$iid-$mirrorNumber"
}
