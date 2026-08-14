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
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.enums.{PrivilegeEnum, UserRoleEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{ModelDao, UserDao}
import org.apache.texera.dao.jooq.generated.tables.pojos.{Model, User}
import org.apache.texera.service.MockLakeFS
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import scala.jdk.CollectionConverters._

class ModelResourceSpec
    extends AnyFlatSpec
    with Matchers
    with MockTexeraDB
    with MockLakeFS
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  private val ownerUser: User = {
    val user = new User
    user.setName("model_user")
    user.setPassword("123")
    user.setEmail("model_user@test.com")
    user.setRole(UserRoleEnum.ADMIN)
    user
  }

  private val otherUser: User = {
    val user = new User
    user.setName("model_user2")
    user.setPassword("123")
    user.setEmail("model_user2@test.com")
    user.setRole(UserRoleEnum.ADMIN)
    user
  }

  private val baseModel: Model = {
    val model = new Model
    model.setName("test-model")
    model.setRepositoryName("test-model")
    model.setIsPublic(true)
    model.setIsDownloadable(true)
    model.setDescription("model for test")
    model.setFramework("pytorch")
    model
  }

  private lazy val modelDao = new ModelDao(getDSLContext.configuration())

  lazy val modelResource = new ModelResource()

  lazy val sessionUser = new SessionUser(ownerUser)
  lazy val sessionUser2 = new SessionUser(otherUser)

  private def assertStatus(ex: WebApplicationException, status: Int): Unit =
    ex.getResponse.getStatus shouldEqual status

  override protected def beforeAll(): Unit = {
    super.beforeAll()

    initializeDBAndReplaceDSLContext()

    val userDao = new UserDao(getDSLContext.configuration())
    userDao.insert(ownerUser)
    userDao.insert(otherUser)

    baseModel.setOwnerUid(ownerUser.getUid)
    modelDao.insert(baseModel)
  }

  override protected def afterAll(): Unit = {
    try shutdownDB()
    finally super.afterAll()
  }

  // ===========================================================================
  // createModel
  // ===========================================================================
  "createModel" should "create a model successfully if the user has no model with the same name" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "new-model",
      modelDescription = "description for new model",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = "torchscript"
    )

    val created = modelResource.createModel(request, sessionUser)
    created.model.getName shouldEqual "new-model"
    created.model.getDescription shouldEqual "description for new model"
    created.model.getIsPublic shouldBe false
    created.model.getIsDownloadable shouldBe true
    created.model.getFramework shouldEqual "pytorch"
    created.model.getFormat shouldEqual "torchscript"
    // the LakeFS repository is named after the created model's id
    created.model.getRepositoryName shouldEqual s"model-${created.model.getMid}"
  }

  it should "default the framework to pytorch when none is provided" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "framework-default-model",
      modelDescription = "no framework provided",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "",
      format = null
    )

    val created = modelResource.createModel(request, sessionUser)
    created.model.getFramework shouldEqual "pytorch"
  }

  // ===========================================================================
  // createModel: the model's Python environment
  // ===========================================================================

  /** Saves an environment for `uid` and returns its veid. */
  private def saveEnvironment(uid: Integer, name: String): Integer = {
    import org.apache.texera.dao.jooq.generated.tables.VirtualEnvironments.VIRTUAL_ENVIRONMENTS
    getDSLContext
      .insertInto(VIRTUAL_ENVIRONMENTS)
      .set(VIRTUAL_ENVIRONMENTS.UID, uid)
      .set(VIRTUAL_ENVIRONMENTS.NAME, name)
      .returning(VIRTUAL_ENVIRONMENTS.VEID)
      .fetchOne()
      .getVeid
  }

  /** The number of environments on record, to show that creating a model adds none. */
  private def environmentCount(): Int = {
    import org.apache.texera.dao.jooq.generated.tables.VirtualEnvironments.VIRTUAL_ENVIRONMENTS
    getDSLContext.fetchCount(VIRTUAL_ENVIRONMENTS)
  }

  private def createModelWithEnvironment(
      modelName: String,
      framework: String,
      frameworkVersion: String,
      veid: Integer = null,
      user: SessionUser = sessionUser
  ) =
    modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = modelName,
        modelDescription = "environment selection",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = framework,
        format = null,
        frameworkVersion = frameworkVersion,
        veid = veid
      ),
      user
    )

  it should "record the framework version and the chosen environment" in {
    val veid = saveEnvironment(ownerUser.getUid, "sklearn-15")
    val created = createModelWithEnvironment("sklearn-versioned-model", "sklearn", "1.5.0", veid)

    created.model.getFrameworkVersion shouldEqual "1.5.0"
    created.model.getVeid shouldEqual veid
  }

  it should "create no environment of its own" in {
    val before = environmentCount()
    createModelWithEnvironment("no-provisioning-model", "sklearn", "1.5.0")

    // The version used to be turned into an environment named after the model. It is now
    // descriptive only: the user picks an environment, or none.
    environmentCount() shouldEqual before
  }

  it should "leave the environment unset when the choice is skipped" in {
    val created = createModelWithEnvironment("skipped-environment-model", "sklearn", "1.5.0")

    created.model.getFrameworkVersion shouldEqual "1.5.0"
    created.model.getVeid shouldBe null
  }

  it should "record a version without an environment, and an environment without a version" in {
    createModelWithEnvironment(
      "unversioned-model",
      "sklearn",
      null
    ).model.getFrameworkVersion shouldBe null

    val veid = saveEnvironment(ownerUser.getUid, "versionless-env")
    createModelWithEnvironment(
      "versionless-env-model",
      "other",
      null,
      veid
    ).model.getVeid shouldEqual veid
  }

  it should "reject an environment belonging to another user" in {
    val foreignVeid = saveEnvironment(otherUser.getUid, "not-yours")

    val ex = intercept[BadRequestException] {
      createModelWithEnvironment("foreign-environment-model", "sklearn", "1.5.0", foreignVeid)
    }
    assertStatus(ex, 400)

    modelDao.fetchByName("foreign-environment-model").asScala shouldBe empty
  }

  it should "reject an environment that does not exist" in {
    val ex = intercept[BadRequestException] {
      createModelWithEnvironment("unknown-environment-model", "sklearn", "1.5.0", Int.box(987654))
    }
    assertStatus(ex, 400)

    modelDao.fetchByName("unknown-environment-model").asScala shouldBe empty
  }

  it should "reject an implausible framework version" in {
    val ex = intercept[BadRequestException] {
      createModelWithEnvironment("injected-version-model", "sklearn", "1.5.0; rm -rf /")
    }
    assertStatus(ex, 400)

    // the model itself must not have been created
    modelDao.fetchByName("injected-version-model").asScala shouldBe empty
  }

  // ===========================================================================
  // updateModelEnvironment
  // ===========================================================================

  it should "change and clear a model's environment" in {
    val first = saveEnvironment(ownerUser.getUid, "first-env")
    val second = saveEnvironment(ownerUser.getUid, "second-env")
    val mid =
      createModelWithEnvironment("switchable-env-model", "sklearn", "1.5.0", first).model.getMid

    modelResource.updateModelEnvironment(
      ModelResource.ModelEnvironmentModification(mid, second),
      sessionUser
    )
    modelDao.fetchOneByMid(mid).getVeid shouldEqual second

    // A null veid is the "skip" choice, and has to be reachable after the fact.
    modelResource.updateModelEnvironment(
      ModelResource.ModelEnvironmentModification(mid, null),
      sessionUser
    )
    modelDao.fetchOneByMid(mid).getVeid shouldBe null
  }

  it should "refuse to point a model at another user's environment" in {
    val mine = saveEnvironment(ownerUser.getUid, "mine-to-keep")
    val foreign = saveEnvironment(otherUser.getUid, "still-not-yours")
    val mid = createModelWithEnvironment("guarded-env-model", "sklearn", "1.5.0", mine).model.getMid

    val ex = intercept[BadRequestException] {
      modelResource.updateModelEnvironment(
        ModelResource.ModelEnvironmentModification(mid, foreign),
        sessionUser
      )
    }
    assertStatus(ex, 400)
    modelDao.fetchOneByMid(mid).getVeid shouldEqual mine
  }

  it should "drop a model back to the default libraries when its environment is deleted" in {
    import org.apache.texera.dao.jooq.generated.tables.VirtualEnvironments.VIRTUAL_ENVIRONMENTS
    val veid = saveEnvironment(ownerUser.getUid, "doomed-env")
    val mid =
      createModelWithEnvironment("orphaned-env-model", "sklearn", "1.5.0", veid).model.getMid

    getDSLContext
      .deleteFrom(VIRTUAL_ENVIRONMENTS)
      .where(VIRTUAL_ENVIRONMENTS.VEID.eq(veid))
      .execute()

    // ON DELETE SET NULL: the model survives, pointing at nothing.
    modelDao.fetchOneByMid(mid) should not be null
    modelDao.fetchOneByMid(mid).getVeid shouldBe null
  }

  it should "refuse to create a model if the user already has one with the same name" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "test-model",
      modelDescription = "duplicate name",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )

    assertThrows[BadRequestException] {
      modelResource.createModel(request, sessionUser)
    }
  }

  it should "create a model successfully if another user has one with the same name" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "test-model",
      modelDescription = "same name, different owner",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )

    val created = modelResource.createModel(request, sessionUser2)
    created.model.getName shouldEqual "test-model"
  }

  it should "reject an invalid model name" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "bad name!",
      modelDescription = "invalid name",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )

    assertThrows[BadRequestException] {
      modelResource.createModel(request, sessionUser)
    }
  }

  it should "return a DashboardModel with owner email, WRITE privilege, isOwner=true and size 0" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "dashboard-model",
      modelDescription = "dashboard properties",
      isModelPublic = true,
      isModelDownloadable = false,
      framework = "pytorch",
      format = null
    )

    val dashboard = modelResource.createModel(request, sessionUser)
    dashboard.ownerEmail shouldEqual ownerUser.getEmail
    dashboard.accessPrivilege shouldEqual PrivilegeEnum.WRITE
    dashboard.isOwner shouldBe true
    dashboard.size shouldEqual 0
  }

  // ===========================================================================
  // getModel / listModels
  // ===========================================================================
  "getModel" should "return the dashboard model including its LakeFS repository size" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "get-model",
      modelDescription = "for get",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )
    val created = modelResource.createModel(request, sessionUser)

    val dashboard = modelResource.getModel(created.model.getMid, sessionUser)
    dashboard.model.getMid shouldEqual created.model.getMid
    dashboard.size should be >= 0L
  }

  it should "forbid a stranger from getting a private model" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "private-get-model",
      modelDescription = "private",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )
    val created = modelResource.createModel(request, sessionUser)

    assertThrows[ForbiddenException] {
      modelResource.getModel(created.model.getMid, sessionUser2)
    }
  }

  "listModels" should "include models the user owns" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "listed-model",
      modelDescription = "for list",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )
    val created = modelResource.createModel(request, sessionUser)

    val listed = modelResource.listModels(sessionUser)
    listed.map(_.model.getMid) should contain(created.model.getMid)
  }

  // ===========================================================================
  // deleteModel
  // ===========================================================================
  "deleteModel" should "delete a model successfully if the user owns it" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "delete-model",
      modelDescription = "for delete",
      isModelPublic = false,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )
    val created = modelResource.createModel(request, sessionUser)

    val response = modelResource.deleteModel(created.model.getMid, sessionUser)
    response.getStatus shouldEqual 200
    modelDao.fetchOneByMid(created.model.getMid) shouldBe null
  }

  it should "refuse to delete a model not owned by the user" in {
    val request = ModelResource.CreateModelRequest(
      modelName = "forbidden-delete-model",
      modelDescription = "for forbidden delete",
      isModelPublic = true,
      isModelDownloadable = true,
      framework = "pytorch",
      format = null
    )
    val created = modelResource.createModel(request, sessionUser)

    assertThrows[ForbiddenException] {
      modelResource.deleteModel(created.model.getMid, sessionUser2)
    }
    modelDao.fetchOneByMid(created.model.getMid) should not be null
  }

  it should "surface a LakeFS 404 as NotFoundException when deleting a model whose repo is missing" in {
    val model = new Model
    model.setName("delete-model-no-repo")
    model.setRepositoryName("delete-model-no-repo")
    model.setDescription("for lakefs 404 mapping test")
    model.setOwnerUid(ownerUser.getUid)
    model.setIsPublic(true)
    model.setIsDownloadable(true)
    model.setFramework("pytorch")
    modelDao.insert(model)
    // intentionally no repo created in LakeFS

    val ex = intercept[NotFoundException] {
      modelResource.deleteModel(model.getMid, sessionUser)
    }
    assertStatus(ex, 404)
  }

  // ===========================================================================
  // update name / description / publicity / downloadable
  // ===========================================================================
  "updateModelName" should "rename a model the user can write to" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "rename-me",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    val response = modelResource.updateModelName(
      ModelResource.ModelNameModification(created.model.getMid, "renamed"),
      sessionUser
    )
    response.getStatus shouldEqual 200
    modelDao.fetchOneByMid(created.model.getMid).getName shouldEqual "renamed"
  }

  "updateModelDescription" should "update the description of a model the user can write to" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "describe-me",
        modelDescription = "old",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    val response = modelResource.updateModelDescription(
      ModelResource.ModelDescriptionModification(created.model.getMid, "new description"),
      sessionUser
    )
    response.getStatus shouldEqual 200
    modelDao.fetchOneByMid(created.model.getMid).getDescription shouldEqual "new description"
  }

  "toggleModelPublicity" should "flip the public flag for a writer" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "publicity-model",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    modelResource.toggleModelPublicity(created.model.getMid, sessionUser).getStatus shouldEqual 200
    modelDao.fetchOneByMid(created.model.getMid).getIsPublic shouldBe true
  }

  "toggleModelDownloadable" should "flip the downloadable flag for the owner" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "downloadable-model",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    modelResource
      .toggleModelDownloadable(created.model.getMid, sessionUser)
      .getStatus shouldEqual 200
    modelDao.fetchOneByMid(created.model.getMid).getIsDownloadable shouldBe false
  }

  it should "forbid a non-owner from toggling downloadable" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "downloadable-forbidden-model",
        modelDescription = "d",
        isModelPublic = true,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    assertThrows[ForbiddenException] {
      modelResource.toggleModelDownloadable(created.model.getMid, sessionUser2)
    }
  }

  it should "refuse to rename a model to a name the owner already uses" in {
    modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "dup-target",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )
    val second = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "dup-source",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    assertThrows[BadRequestException] {
      modelResource.updateModelName(
        ModelResource.ModelNameModification(second.model.getMid, "dup-target"),
        sessionUser
      )
    }
  }

  it should "forbid a user without write access from renaming or re-describing a model" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "no-write-updates",
        modelDescription = "d",
        isModelPublic = true,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    assertThrows[ForbiddenException] {
      modelResource.updateModelName(
        ModelResource.ModelNameModification(created.model.getMid, "hijacked"),
        sessionUser2
      )
    }
    assertThrows[ForbiddenException] {
      modelResource.updateModelDescription(
        ModelResource.ModelDescriptionModification(created.model.getMid, "hijacked"),
        sessionUser2
      )
    }
  }

  "updateModelFramework" should "persist a supported framework" in {
    val created = createWith("framework-update", "pytorch", "torchscript")
    modelResource.updateModelFramework(
      ModelResource.ModelFrameworkModification(created.model.getMid, "onnx"),
      sessionUser
    )
    modelResource.getModel(created.model.getMid, sessionUser).model.getFramework shouldEqual "onnx"
  }

  it should "accept the other framework for models outside the known set" in {
    val created = createWith("framework-other", "pytorch", "torchscript")
    modelResource.updateModelFramework(
      ModelResource.ModelFrameworkModification(created.model.getMid, "other"),
      sessionUser
    )
    modelResource.getModel(created.model.getMid, sessionUser).model.getFramework shouldEqual "other"
  }

  it should "reject an unsupported framework" in {
    val created = createWith("framework-bad", "pytorch", "torchscript")
    assertThrows[BadRequestException] {
      modelResource.updateModelFramework(
        ModelResource.ModelFrameworkModification(created.model.getMid, "caffe"),
        sessionUser
      )
    }
  }

  it should "forbid a user without write access" in {
    val created = createWith("framework-forbidden", "pytorch", "torchscript")
    assertThrows[ForbiddenException] {
      modelResource.updateModelFramework(
        ModelResource.ModelFrameworkModification(created.model.getMid, "onnx"),
        sessionUser2
      )
    }
  }

  "updateModelFormat" should "persist a supported format" in {
    val created = createWith("format-update", "pytorch", "torchscript")
    modelResource.updateModelFormat(
      ModelResource.ModelFormatModification(created.model.getMid, "safetensors"),
      sessionUser
    )
    modelResource
      .getModel(created.model.getMid, sessionUser)
      .model
      .getFormat shouldEqual "safetensors"
  }

  it should "reject an unsupported format" in {
    val created = createWith("format-bad", "pytorch", "torchscript")
    assertThrows[BadRequestException] {
      modelResource.updateModelFormat(
        ModelResource.ModelFormatModification(created.model.getMid, "h5"),
        sessionUser
      )
    }
  }

  it should "forbid a user without write access" in {
    val created = createWith("format-forbidden", "pytorch", "torchscript")
    assertThrows[ForbiddenException] {
      modelResource.updateModelFormat(
        ModelResource.ModelFormatModification(created.model.getMid, "onnx"),
        sessionUser2
      )
    }
  }

  // ===========================================================================
  // getPublicModel / listModels public merge
  // ===========================================================================
  "getPublicModel" should "return a public model without authentication" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "public-get-model",
        modelDescription = "d",
        isModelPublic = true,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    val dashboard = modelResource.getPublicModel(created.model.getMid)
    dashboard.model.getMid shouldEqual created.model.getMid
  }

  it should "forbid access to a private model" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "public-get-private-model",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    assertThrows[ForbiddenException] {
      modelResource.getPublicModel(created.model.getMid)
    }
  }

  "getPublicModelVersionList" should "list versions of a public model without authentication" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "public-version-list",
        modelDescription = "d",
        isModelPublic = true,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    modelResource.getPublicModelVersionList(created.model.getMid) shouldBe empty
  }

  it should "forbid listing versions of a private model" in {
    val created = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "public-version-list-private",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser
    )

    assertThrows[ForbiddenException] {
      modelResource.getPublicModelVersionList(created.model.getMid)
    }
  }

  it should "reject an unknown model id" in {
    assertThrows[NotFoundException] {
      modelResource.getPublicModelVersionList(999999)
    }
  }

  "listModels" should "include public models owned by another user" in {
    val othersPublic = modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "others-public-model",
        modelDescription = "d",
        isModelPublic = true,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser2
    )

    val listed = modelResource.listModels(sessionUser)
    val entry = listed.find(_.model.getMid == othersPublic.model.getMid)
    entry should not be empty
    entry.get.isOwner shouldBe false
    entry.get.accessPrivilege shouldEqual PrivilegeEnum.READ
  }

  private def createWith(
      name: String,
      framework: String,
      format: String
  ): ModelResource.DashboardModel =
    modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = name,
        modelDescription = "label checks",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = framework,
        format = format
      ),
      sessionUser
    )

  "createModel" should "accept every supported framework" in {
    ModelResource.SUPPORTED_FRAMEWORKS.zipWithIndex.foreach {
      case (framework, i) =>
        createWith(s"framework-ok-$i", framework, null).model.getFramework shouldEqual framework
    }
  }

  it should "accept every supported format" in {
    ModelResource.SUPPORTED_FORMATS.zipWithIndex.foreach {
      case (format, i) =>
        createWith(s"format-ok-$i", "pytorch", format).model.getFormat shouldEqual format
    }
  }

  it should "reject an unrecognised framework" in {
    val ex = intercept[BadRequestException] {
      createWith("framework-bad", "banana", null)
    }
    ex.getMessage should include("Unsupported framework")
    ex.getMessage should include("pytorch")
  }

  it should "reject an unrecognised format" in {
    intercept[BadRequestException] {
      createWith("format-bad", "pytorch", "docx")
    }.getMessage should include("Unsupported format")
  }

  it should "treat a blank format as unspecified rather than invalid" in {
    createWith("format-blank", "pytorch", "   ").model.getFormat shouldBe null
  }

  it should "trim surrounding whitespace off a label before validating it" in {
    createWith("framework-padded", "  pytorch  ", null).model.getFramework shouldEqual "pytorch"
  }

  // ===========================================================================
  // user-model-owners
  // ===========================================================================
  "retrieveOwners" should "return the distinct owners of the models the user can access" in {
    createWith("owned-by-me-1", "pytorch", null)
    createWith("owned-by-me-2", "pytorch", null)

    val owners = modelResource.retrieveOwners(sessionUser).asScala.toList
    owners should contain(ownerUser.getEmail)
    owners.distinct shouldEqual owners
  }

  it should "not list the owner of a model the user was never granted access to" in {
    modelResource.createModel(
      ModelResource.CreateModelRequest(
        modelName = "private-to-other-user",
        modelDescription = "d",
        isModelPublic = false,
        isModelDownloadable = true,
        framework = "pytorch",
        format = null
      ),
      sessionUser2
    )

    // Access is granted per model, so the other user only shows up once the
    // requester actually holds a model_user_access row for one of their models.
    modelResource.retrieveOwners(sessionUser).asScala.toList should not contain otherUser.getEmail
  }
}
