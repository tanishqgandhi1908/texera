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

  import CuratedImageResource.{isValidName, normaliseRef}

  // The regression this guards: the pattern used to exclude parentheses, so the names an
  // administrator actually reaches for -- and the ones the demo instructions themselves
  // used -- were rejected with HTTP 400 before anything was created.
  "isValidName" should "accept the names administrators actually type" in {
    isValidName("Texera Default") shouldBe true
    isValidName("Python ML (sklearn)") shouldBe true
    isValidName("PyTorch 2.6 (CUDA 12)") shouldBe true
    isValidName("cu-image_v1.0") shouldBe true
    isValidName("gcc+cuda") shouldBe true
  }

  it should "still refuse anything that is not a plain display name" in {
    isValidName("") shouldBe false
    isValidName("   ") shouldBe false
    // must start alphanumeric, so no leading punctuation or whitespace-only leaders
    isValidName("-leading-hyphen") shouldBe false
    isValidName("(leading-paren)") shouldBe false
    // no quoting, markup, path or shell metacharacters
    isValidName("name\"quote") shouldBe false
    isValidName("<script>") shouldBe false
    isValidName("a/b") shouldBe false
    isValidName("a;rm -rf") shouldBe false
    isValidName("a\nb") shouldBe false
    isValidName("caf\u00e9") shouldBe false
  }

  it should "reject a name longer than the column allows" in {
    isValidName("a" * 128) shouldBe true
    isValidName("a" * 129) shouldBe false
  }

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

  // Guards the same trap normaliseRef guards: the registry address carries a colon for its
  // port, so the tag has to come from the LAST one.
  "splitImageReference" should "split a mirrored reference into registry, repository and tag" in {
    ImageMirrorClient.splitImageReference("10.96.0.99:5000/texera-cu/2:1") shouldBe
      Some(("10.96.0.99:5000", "texera-cu/2", "1"))
    ImageMirrorClient.splitImageReference("registry.example.com/team/img:v1.2") shouldBe
      Some(("registry.example.com", "team/img", "v1.2"))
  }

  it should "refuse anything that is not a registry-qualified, tagged reference" in {
    ImageMirrorClient.splitImageReference("") shouldBe None
    ImageMirrorClient.splitImageReference(null) shouldBe None
    // no tag
    ImageMirrorClient.splitImageReference("10.96.0.99:5000/texera-cu/2") shouldBe None
    // no registry
    ImageMirrorClient.splitImageReference("texera-cu:1") shouldBe None
    // trailing colon, and trailing slash
    ImageMirrorClient.splitImageReference("10.96.0.99:5000/texera-cu/2:") shouldBe None
    ImageMirrorClient.splitImageReference("10.96.0.99:5000/:1") shouldBe None
  }

  // Unreachable must never read as absent: the registry lives at a ClusterIP, which a
  // manager running outside the cluster cannot resolve, and answering "absent" there would
  // block every start on a topology where the check simply cannot run.
  "registryHasImage" should "be undecided rather than negative when it cannot ask" in {
    ImageMirrorClient.registryHasImage("not-a-reference") shouldBe None
    // A port nothing listens on: a connection error, not a 404.
    ImageMirrorClient.registryHasImage("127.0.0.1:1/texera-cu/1:1") shouldBe None
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
