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

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class ModelEnvironmentSpec extends AnyFlatSpec with Matchers {

  "pveName" should "prefix the model name" in {
    ModelEnvironment.pveName("churn-clf") shouldEqual "pve-for-model-churn-clf"
    ModelEnvironment.isModelPveName("pve-for-model-churn-clf") shouldBe true
    ModelEnvironment.isModelPveName("myenv") shouldBe false
  }

  it should "stay within the name column for the longest possible model name" in {
    // Model names are capped at 128 characters; virtual_environments.name holds 160.
    ModelEnvironment.pveName("m" * 128).length should be <= 160
  }

  "packagesFor" should "translate framework labels to their PyPI distributions" in {
    // `sklearn` on PyPI is a stub that refuses to install, and `pytorch` does not exist.
    ModelEnvironment.packagesFor("sklearn", "1.5.0") shouldEqual Map("scikit-learn" -> "==1.5.0")
    ModelEnvironment.packagesFor("pytorch", "2.13.0") shouldEqual Map("torch" -> "==2.13.0")
    ModelEnvironment.packagesFor("tensorflow", "2.16.1") shouldEqual Map("tensorflow" -> "==2.16.1")
    ModelEnvironment.packagesFor("onnx", "1.16.0") shouldEqual Map("onnx" -> "==1.16.0")
  }

  it should "be indifferent to label casing and surrounding space" in {
    ModelEnvironment.packagesFor(" SKLearn ", " 1.5.0 ") shouldEqual Map(
      "scikit-learn" -> "==1.5.0"
    )
  }

  it should "yield nothing when there is no package to install" in {
    ModelEnvironment.packagesFor("other", "1.5.0") shouldBe empty
    ModelEnvironment.packagesFor("unheard-of", "1.5.0") shouldBe empty
    ModelEnvironment.packagesFor(null, "1.5.0") shouldBe empty
  }

  it should "yield nothing without a version, rather than an unpinned install" in {
    ModelEnvironment.packagesFor("sklearn", null) shouldBe empty
    ModelEnvironment.packagesFor("sklearn", "") shouldBe empty
    ModelEnvironment.packagesFor("sklearn", "   ") shouldBe empty
  }

  it should "yield nothing for a version it would not accept" in {
    ModelEnvironment.packagesFor("sklearn", "1.5.0; rm -rf /") shouldBe empty
  }

  "isValidVersion" should "accept the version shapes PyPI publishes" in {
    Seq("1", "1.5", "1.5.0", "1.5.0.1", "2.13.0+cpu", "1.7.2rc1", "0.25.2").foreach { version =>
      withClue(s"$version should be accepted: ")(
        ModelEnvironment.isValidVersion(version) shouldBe true
      )
    }
  }

  it should "reject anything that could reach a pip command line as something else" in {
    Seq(
      "1.5.0; rm -rf /",
      "1.5.0 --index-url http://evil",
      "$(whoami)",
      "../../etc/passwd",
      "latest",
      "",
      null,
      "1." + "9" * 40 // longer than the column
    ).foreach { version =>
      withClue(s"$version should be rejected: ")(
        ModelEnvironment.isValidVersion(version) shouldBe false
      )
    }
  }
}
