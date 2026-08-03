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

import jakarta.ws.rs._
import jakarta.ws.rs.core._
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.enums.UserRoleEnum
import org.apache.texera.dao.jooq.generated.tables.daos.{DatasetDao, UserDao}
import org.apache.texera.dao.jooq.generated.tables.pojos.{Dataset, User}
import org.apache.texera.service.MockLakeFS
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.io.{ByteArrayInputStream, ByteArrayOutputStream}
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.zip.ZipInputStream
import java.util.{Collections, Date, Locale, Optional}
import scala.util.Random

// Covers the model download surface: presigned single-file URLs (which
// ModelFileDocument also depends on), the version zip, and the cover-image read path.
class ModelDownloadResourceSpec
    extends AnyFlatSpec
    with Matchers
    with MockTexeraDB
    with MockLakeFS
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  private def mkUser(name: String): User = {
    val user = new User
    user.setName(name)
    user.setPassword("123")
    user.setEmail(s"$name@test.com")
    user.setRole(UserRoleEnum.ADMIN)
    user
  }

  private val ownerUser: User = mkUser("model_download_owner")
  private val strangerUser: User = mkUser("model_download_stranger")

  lazy val modelResource = new ModelResource()
  lazy val sessionUser = new SessionUser(ownerUser)
  lazy val strangerSession = new SessionUser(strangerUser)

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    val userDao = new UserDao(getDSLContext.configuration())
    userDao.insert(ownerUser)
    userDao.insert(strangerUser)
  }

  override protected def afterAll(): Unit = {
    try shutdownDB()
    finally super.afterAll()
  }

  // ---------- helpers ----------
  private def urlEnc(raw: String): String =
    URLEncoder.encode(raw, StandardCharsets.UTF_8.name())

  private def uniqueName(prefix: String): String =
    s"$prefix-${System.nanoTime()}-${Random.alphanumeric.take(6).mkString.toLowerCase}"

  private def mkHeaders(contentLength: Long): HttpHeaders =
    new HttpHeaders {
      private val headers = new MultivaluedHashMap[String, String]()
      headers.putSingle(HttpHeaders.CONTENT_LENGTH, contentLength.toString)
      override def getHeaderString(name: String): String = headers.getFirst(name)
      override def getRequestHeaders: MultivaluedMap[String, String] = headers
      override def getRequestHeader(name: String): java.util.List[String] =
        Option(headers.get(name)).getOrElse(Collections.emptyList[String]())
      override def getAcceptableMediaTypes: java.util.List[MediaType] = Collections.emptyList()
      override def getAcceptableLanguages: java.util.List[Locale] = Collections.emptyList()
      override def getMediaType: MediaType = null
      override def getLanguage: Locale = null
      override def getCookies: java.util.Map[String, Cookie] = Collections.emptyMap()
      override def getDate: Date = null
      override def getLength: Int = contentLength.toInt
    }

  private def newModel(
      isPublic: Boolean = false,
      isDownloadable: Boolean = true
  ): ModelResource.DashboardModel =
    modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = uniqueName("dl-model"),
        modelDescription = "for download tests",
        isModelPublic = isPublic,
        isModelDownloadable = isDownloadable,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

  private def upload(mid: Integer, path: String, bytes: Array[Byte]): Unit =
    modelResource
      .uploadOneFileToModel(
        mid,
        urlEnc(path),
        "upload",
        new ByteArrayInputStream(bytes),
        mkHeaders(bytes.length.toLong),
        sessionUser
      )
      .getStatus shouldEqual 200

  /** Creates a model holding one committed file, returning it with its commit hash. */
  private def modelWithCommittedFile(
      path: String = "model.pt",
      bytes: Array[Byte] = Array.fill[Byte](1024)(0x7),
      isPublic: Boolean = false,
      isDownloadable: Boolean = true
  ): (ModelResource.DashboardModel, String) = {
    val model = newModel(isPublic, isDownloadable)
    upload(model.model.getMid, path, bytes)
    val version = modelResource.createModelVersion("v", model.model.getMid, sessionUser)
    (model, version.modelVersion.getVersionHash)
  }

  private def presignedUrlOf(response: Response): String =
    response.getEntity.asInstanceOf[Map[String, String]]("presignedUrl")

  /** MinIO is bound to a fixed host port precisely so presigned URLs resolve here. */
  private def fetch(url: String): Array[Byte] = {
    val stream = new java.net.URL(url).openStream()
    try stream.readAllBytes()
    finally stream.close()
  }

  // ===========================================================================
  // presign-download
  // ===========================================================================
  "getPresignedUrl" should "return a presigned URL that serves the file's bytes" in {
    val bytes = Array.tabulate[Byte](1024)(i => (i % 251).toByte)
    val (model, commitHash) = modelWithCommittedFile(bytes = bytes)

    val response = modelResource.getPresignedUrl(
      urlEnc("model.pt"),
      model.model.getRepositoryName,
      commitHash,
      sessionUser
    )

    response.getStatus shouldEqual 200
    // The URL addresses the physical object, not the logical path, so the only
    // meaningful assertion is that fetching it yields exactly what was uploaded.
    val url = presignedUrlOf(response)
    url should include("X-Amz-Signature")
    fetch(url) shouldEqual bytes
  }

  it should "refuse a caller with no access to the model" in {
    val (model, commitHash) = modelWithCommittedFile()

    assertThrows[ForbiddenException] {
      modelResource.getPresignedUrl(
        urlEnc("model.pt"),
        model.model.getRepositoryName,
        commitHash,
        strangerSession
      )
    }
  }

  it should "refuse a repository that belongs to no model" in {
    assertThrows[ForbiddenException] {
      modelResource.getPresignedUrl(
        urlEnc("model.pt"),
        "model-does-not-exist",
        "deadbeef",
        sessionUser
      )
    }
  }

  it should "reject a repositoryName without a commitHash" in {
    val response = modelResource.getPresignedUrl(urlEnc("model.pt"), "model-1", null, sessionUser)
    response.getStatus shouldEqual Response.Status.BAD_REQUEST.getStatusCode
  }

  it should "reject a commitHash without a repositoryName" in {
    val response = modelResource.getPresignedUrl(urlEnc("model.pt"), null, "abc123", sessionUser)
    response.getStatus shouldEqual Response.Status.BAD_REQUEST.getStatusCode
  }

  "getPresignedUrlWithS3" should "resolve the same file as the non-S3 variant" in {
    val (model, commitHash) = modelWithCommittedFile()

    modelResource
      .getPresignedUrlWithS3(
        urlEnc("model.pt"),
        model.model.getRepositoryName,
        commitHash,
        sessionUser
      )
      .getStatus shouldEqual 200
  }

  "getPublicPresignedUrl" should "serve a file of a public model to an anonymous caller" in {
    val (model, commitHash) = modelWithCommittedFile(isPublic = true)

    modelResource
      .getPublicPresignedUrl(urlEnc("model.pt"), model.model.getRepositoryName, commitHash)
      .getStatus shouldEqual 200
  }

  it should "refuse a file of a private model to an anonymous caller" in {
    val (model, commitHash) = modelWithCommittedFile(isPublic = false)

    assertThrows[ForbiddenException] {
      modelResource.getPublicPresignedUrl(
        urlEnc("model.pt"),
        model.model.getRepositoryName,
        commitHash
      )
    }
  }

  // ===========================================================================
  // versionZip
  // ===========================================================================
  "getModelVersionZip" should "stream a zip holding every file of the version" in {
    val model = newModel()
    val mid = model.model.getMid
    upload(mid, "model.pt", Array.fill[Byte](512)(0x1))
    upload(mid, "tokenizer/vocab.txt", Array.fill[Byte](64)(0x2))
    val version = modelResource.createModelVersion("v1", mid, sessionUser)

    val response =
      modelResource.getModelVersionZip(mid, version.modelVersion.getMvid, null, sessionUser)

    response.getStatus shouldEqual 200
    response.getHeaderString("Content-Disposition") should include(".zip")

    val buffer = new ByteArrayOutputStream()
    response.getEntity.asInstanceOf[StreamingOutput].write(buffer)

    val zip = new ZipInputStream(new java.io.ByteArrayInputStream(buffer.toByteArray))
    val entries = Iterator
      .continually(zip.getNextEntry)
      .takeWhile(_ != null)
      .map(_.getName)
      .toList
    zip.close()

    entries should contain allOf ("model.pt", "tokenizer/vocab.txt")
  }

  it should "accept latest=true instead of an explicit version id" in {
    val (model, _) = modelWithCommittedFile()

    modelResource
      .getModelVersionZip(model.model.getMid, null, java.lang.Boolean.TRUE, sessionUser)
      .getStatus shouldEqual 200
  }

  it should "reject being given both a version id and latest=true" in {
    val (model, _) = modelWithCommittedFile()
    val version = modelResource.retrieveLatestModelVersion(model.model.getMid, sessionUser)

    assertThrows[BadRequestException] {
      modelResource.getModelVersionZip(
        model.model.getMid,
        version.modelVersion.getMvid,
        java.lang.Boolean.TRUE,
        sessionUser
      )
    }
  }

  it should "reject being given neither a version id nor latest=true" in {
    val (model, _) = modelWithCommittedFile()

    assertThrows[BadRequestException] {
      modelResource.getModelVersionZip(model.model.getMid, null, null, sessionUser)
    }
  }

  it should "report not-found for a version whose files were all deleted" in {
    // Deleting the only file is itself a staged change, so a genuinely empty
    // version can be committed — the zip of it has nothing to stream.
    val model = newModel()
    val mid = model.model.getMid
    upload(mid, "only.pt", Array.fill[Byte](64)(0x1))
    modelResource.createModelVersion("v1", mid, sessionUser)
    modelResource.deleteModelFile(mid, urlEnc("only.pt"), sessionUser).getStatus shouldEqual 200
    val emptyVersion = modelResource.createModelVersion("v2-empty", mid, sessionUser)

    val response =
      modelResource.getModelVersionZip(mid, emptyVersion.modelVersion.getMvid, null, sessionUser)

    response.getStatus shouldEqual Response.Status.NOT_FOUND.getStatusCode
  }

  it should "report not-found for a model that has no version yet" in {
    val model = newModel()

    assertThrows[NotFoundException] {
      modelResource.getModelVersionZip(
        model.model.getMid,
        null,
        java.lang.Boolean.TRUE,
        sessionUser
      )
    }
  }

  it should "refuse a caller with no access to the model" in {
    val (model, _) = modelWithCommittedFile()

    assertThrows[ForbiddenException] {
      modelResource.getModelVersionZip(
        model.model.getMid,
        null,
        java.lang.Boolean.TRUE,
        strangerSession
      )
    }
  }

  it should "refuse a non-owner when the model is not downloadable" in {
    // readable because it is public, but the owner disabled downloads
    val (model, _) = modelWithCommittedFile(isPublic = true, isDownloadable = false)

    assertThrows[ForbiddenException] {
      modelResource.getModelVersionZip(
        model.model.getMid,
        null,
        java.lang.Boolean.TRUE,
        strangerSession
      )
    }
  }

  it should "still let the owner download a model that is not downloadable" in {
    val (model, _) = modelWithCommittedFile(isPublic = false, isDownloadable = false)

    modelResource
      .getModelVersionZip(model.model.getMid, null, java.lang.Boolean.TRUE, sessionUser)
      .getStatus shouldEqual 200
  }

  // ===========================================================================
  // Cover image
  // ===========================================================================

  private lazy val accessResource = new ModelAccessResource()

  private def grantRead(mid: Integer): Unit =
    accessResource
      .grantAccess(mid, strangerUser.getEmail, "READ", sessionUser)
      .getStatus shouldEqual 200

  /** Creates a model with a committed image, returning it and the cover path under the version. */
  private def modelWithCover(
      isPublic: Boolean = false,
      isDownloadable: Boolean = true,
      bytes: Array[Byte] = Array.tabulate[Byte](64)(i => (i % 251).toByte)
  ): (ModelResource.DashboardModel, String) = {
    val model = newModel(isPublic, isDownloadable)
    upload(model.model.getMid, "cover.jpg", bytes)
    // createModelVersion derives the stored name (e.g. "v1 - v"), which is the
    // path segment FileResolver matches on — never hardcode it.
    val version = modelResource.createModelVersion("v", model.model.getMid, sessionUser)
    (model, s"${version.modelVersion.getName}/cover.jpg")
  }

  private def setCover(mid: Integer, path: String, user: SessionUser = sessionUser): Response =
    modelResource.updateModelCoverImage(mid, ModelResource.CoverImageRequest(path), user)

  private def anonymous: Optional[SessionUser] = Optional.empty[SessionUser]()
  private def as(u: SessionUser): Optional[SessionUser] = Optional.of(u)

  "updateModelCoverImage" should "persist the normalized cover path" in {
    val (model, coverPath) = modelWithCover()

    setCover(model.model.getMid, coverPath).getStatus shouldEqual 200

    modelResource
      .getModel(model.model.getMid, sessionUser)
      .model
      .getCoverImage shouldEqual coverPath
  }

  it should "resolve against the model, not a dataset of the same owner and name" in {
    // Guards the resource-prefix trap: building the logical path with
    // ResourceType.Datasets compiles fine and silently reads the wrong table.
    val (model, coverPath) = modelWithCover()
    val dataset = new Dataset
    dataset.setOwnerUid(ownerUser.getUid)
    dataset.setName(model.model.getName)
    dataset.setDescription("same name as the model, different resource")
    dataset.setRepositoryName(s"dataset-shadow-${model.model.getMid}")
    dataset.setIsPublic(true)
    dataset.setIsDownloadable(true)
    new DatasetDao(getDSLContext.configuration()).insert(dataset)

    setCover(model.model.getMid, coverPath).getStatus shouldEqual 200
    modelResource.getModelCover(model.model.getMid, as(sessionUser)).getStatus shouldEqual 307
  }

  it should "reject a caller with no access" in {
    val (model, coverPath) = modelWithCover()
    assertThrows[ForbiddenException] { setCover(model.model.getMid, coverPath, strangerSession) }
  }

  it should "reject a READ-only grantee" in {
    val (model, coverPath) = modelWithCover()
    grantRead(model.model.getMid)
    assertThrows[ForbiddenException] { setCover(model.model.getMid, coverPath, strangerSession) }
  }

  it should "reject a traversal path" in {
    val (model, _) = modelWithCover()
    assertThrows[BadRequestException] { setCover(model.model.getMid, "../../escape.jpg") }
  }

  it should "reject a non-image extension" in {
    val (model, coverPath) = modelWithCover()
    assertThrows[BadRequestException] {
      setCover(model.model.getMid, coverPath.replace(".jpg", ".js"))
    }
  }

  it should "reject an empty and a null path" in {
    val (model, _) = modelWithCover()
    assertThrows[BadRequestException] { setCover(model.model.getMid, "") }
    assertThrows[BadRequestException] { setCover(model.model.getMid, null) }
  }

  it should "404 for a model that does not exist" in {
    assertThrows[NotFoundException] { setCover(Integer.valueOf(987654), "v/cover.jpg") }
  }

  it should "surface a path that was never committed as a NotFoundException" in {
    val (model, coverPath) = modelWithCover()
    val missing = coverPath.replace("cover.jpg", "never-committed.jpg")
    assertThrows[NotFoundException] { setCover(model.model.getMid, missing) }
  }

  "getModelCover" should "redirect anonymously to a presigned URL serving the image bytes" in {
    val bytes = Array.tabulate[Byte](64)(i => (i % 251).toByte)
    val (model, coverPath) = modelWithCover(isPublic = true, bytes = bytes)
    setCover(model.model.getMid, coverPath)

    val response = modelResource.getModelCover(model.model.getMid, anonymous)
    response.getStatus shouldEqual 307
    fetch(response.getLocation.toString) shouldEqual bytes
  }

  it should "refuse an anonymous caller on a private model" in {
    val (model, coverPath) = modelWithCover(isPublic = false)
    setCover(model.model.getMid, coverPath)
    assertThrows[ForbiddenException] { modelResource.getModelCover(model.model.getMid, anonymous) }
  }

  it should "refuse an authenticated stranger on a private model" in {
    val (model, coverPath) = modelWithCover(isPublic = false)
    setCover(model.model.getMid, coverPath)
    assertThrows[ForbiddenException] {
      modelResource.getModelCover(model.model.getMid, as(strangerSession))
    }
  }

  it should "allow a READ grantee on a private model" in {
    val (model, coverPath) = modelWithCover(isPublic = false)
    setCover(model.model.getMid, coverPath)
    grantRead(model.model.getMid)

    modelResource
      .getModelCover(model.model.getMid, as(strangerSession))
      .getStatus shouldEqual 307
  }

  it should "serve the cover of a public model even when downloads are disabled" in {
    // Deliberate parity with datasets: a cover is display metadata the owner
    // designated, not model weights, so is_downloadable does not gate it.
    val (model, coverPath) = modelWithCover(isPublic = true, isDownloadable = false)
    setCover(model.model.getMid, coverPath)

    modelResource.getModelCover(model.model.getMid, anonymous).getStatus shouldEqual 307
  }

  it should "404 when no cover image has been set" in {
    val (model, _) = modelWithCover(isPublic = true)
    assertThrows[NotFoundException] { modelResource.getModelCover(model.model.getMid, anonymous) }
  }

  "getModelCoverUrl" should "return a url for the owner of a private model" in {
    val (model, coverPath) = modelWithCover(isPublic = false)
    setCover(model.model.getMid, coverPath)

    val response = modelResource.getModelCoverUrl(model.model.getMid, as(sessionUser))
    response.getStatus shouldEqual 200
    response.getEntity.asInstanceOf[Map[String, String]]("url") should not be null
  }

  it should "refuse a stranger on a private model" in {
    val (model, coverPath) = modelWithCover(isPublic = false)
    setCover(model.model.getMid, coverPath)
    assertThrows[ForbiddenException] {
      modelResource.getModelCoverUrl(model.model.getMid, as(strangerSession))
    }
  }

  it should "return a null url with 200, not 404, when no cover is set" in {
    val (model, _) = modelWithCover(isPublic = true)

    val response = modelResource.getModelCoverUrl(model.model.getMid, anonymous)
    response.getStatus shouldEqual 200
    response.getEntity.asInstanceOf[Map[String, String]]("url") shouldEqual null
  }
}
