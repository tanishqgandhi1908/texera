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

import org.apache.texera.common.config.KubernetesConfig
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class KubernetesClientSpec extends AnyFlatSpec with Matchers {

  "generatePodName" should "prefix the cuid with computing-unit" in {
    KubernetesClient.generatePodName(42) shouldBe "computing-unit-42"
  }

  it should "handle a cuid of 0" in {
    KubernetesClient.generatePodName(0) shouldBe "computing-unit-0"
  }

  "mountHostPath" should "give each computing unit its own directory under the mount root" in {
    // A model version is named <repository>:<commit> everywhere else, and mounts it at
    // <this>/<repository>/<commit>. So this path is the only thing keeping two computing
    // units that mount the same version from sharing one mount.
    KubernetesClient.mountHostPath(7) should endWith("/7")
    KubernetesClient.mountHostPath(7) should not be KubernetesClient.mountHostPath(8)
  }

  it should "stay under the mount root the mounter daemonset is given" in {
    KubernetesClient.mountHostPath(7) shouldBe s"${KubernetesConfig.mounterHostRoot}/7"
  }
}
