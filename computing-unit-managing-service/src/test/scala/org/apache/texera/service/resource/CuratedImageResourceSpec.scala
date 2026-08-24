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

import org.apache.texera.service.util.ImageMirrorClient
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class CuratedImageResourceSpec extends AnyFlatSpec with Matchers {

  import CuratedImageResource.normaliseRef

  "normaliseRef" should "leave a complete image reference alone" in {
    normaliseRef("texera/cu-alphafold3:1.0") shouldBe "texera/cu-alphafold3:1.0"
  }

  it should "default a missing tag rather than reject it" in {
    normaliseRef("texera/cu-alphafold3") shouldBe "texera/cu-alphafold3:latest"
  }

  // The whole reason this function exists: an administrator curating from a browser will
  // paste the page they are looking at, not a reference they had to construct.
  it should "turn a Docker Hub page address into a pull reference" in {
    normaliseRef("https://hub.docker.com/r/texera/cu-alphafold3") shouldBe
      "texera/cu-alphafold3:latest"
    normaliseRef("hub.docker.com/r/texera/cu-alphafold3") shouldBe "texera/cu-alphafold3:latest"
  }

  it should "tolerate a trailing slash, which a copied address usually has" in {
    normaliseRef("https://hub.docker.com/r/texera/cu-alphafold3/") shouldBe
      "texera/cu-alphafold3:latest"
  }

  // An official image lives under /_/ and is pulled by its bare name, so the path prefix
  // has to come off or the reference would name a repository that does not exist.
  it should "handle a Docker Hub official image" in {
    normaliseRef("https://hub.docker.com/_/ubuntu") shouldBe "ubuntu:latest"
  }

  it should "trim surrounding whitespace" in {
    normaliseRef("  texera/img:1.0  ") shouldBe "texera/img:1.0"
  }

  // The regression this guards: a registry's port contains a colon, and looking for one
  // anywhere in the reference would read ":5000/team/img" as a tag and leave the image
  // untagged.
  it should "not mistake a registry port for a tag" in {
    normaliseRef("myregistry.io:5000/team/img") shouldBe "myregistry.io:5000/team/img:latest"
    normaliseRef("10.96.0.99:5000/texera/computing-unit-master:dev") shouldBe
      "10.96.0.99:5000/texera/computing-unit-master:dev"
  }

  it should "leave a digest-pinned reference untagged" in {
    normaliseRef("texera/img@sha256:abc123") shouldBe "texera/img@sha256:abc123"
  }

  "sourceDigestFrom" should "read the digest a finished mirror printed" in {
    val log =
      """Inspecting texera/cu-alphafold3:1.0
        |Start command: [bin/computing-unit-master] []
        |TEXERA_SOURCE_DIGEST=sha256:0123abc
        |Copying to 10.96.0.99:5000/texera-cu/7:1
        |""".stripMargin
    ImageMirrorClient.sourceDigestFrom(log) shouldBe Some("sha256:0123abc")
  }

  // The regression this guards: the bare exception message can be something as useless as
  // "An error has occurred." when the client fell back to a default API address, which
  // reads as a Texera bug rather than a missing cluster.
  "describeStartFailure" should "name the failure type and where it was talking to" in {
    val described = ImageMirrorClient.describeStartFailure(
      new RuntimeException("An error has occurred.")
    )
    described should include("RuntimeException")
    described should include("An error has occurred.")
    described should include("Kubernetes API address")
    described should include("reachable cluster")
  }

  it should "still say something useful when the exception has no message" in {
    val described = ImageMirrorClient.describeStartFailure(new NullPointerException)
    described should include("NullPointerException")
    described should include("no message")
  }

  it should "return nothing when the mirror failed before printing one" in {
    val log =
      """Inspecting texera/not-a-cu-image:1.0
        |Start command: [/bin/bash] []
        |ERROR: texera/not-a-cu-image:1.0 does not look like a Texera computing-unit image.
        |""".stripMargin
    ImageMirrorClient.sourceDigestFrom(log) shouldBe None
  }
}
