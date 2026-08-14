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
