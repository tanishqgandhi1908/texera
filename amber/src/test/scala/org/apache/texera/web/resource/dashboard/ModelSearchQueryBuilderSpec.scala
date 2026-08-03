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

package org.apache.texera.web.resource.dashboard

import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.dao.jooq.generated.enums.{PrivilegeEnum, UserRoleEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{ModelDao, ModelUserAccessDao, UserDao}
import org.apache.texera.dao.jooq.generated.tables.pojos.{Model, ModelUserAccess, User}
import org.apache.texera.web.resource.dashboard.DashboardResource.SearchQueryParams
import org.apache.texera.web.resource.dashboard.SearchQueryBuilder.MODEL_RESOURCE_TYPE
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.time.OffsetDateTime
import java.util
import scala.jdk.CollectionConverters._

class ModelSearchQueryBuilderSpec
    extends AnyFlatSpec
    with BeforeAndAfterAll
    with Matchers
    with MockTexeraDB {

  private val exampleCreationTime: OffsetDateTime = OffsetDateTime.parse("2025-01-01T00:00:00Z")

  private def makeUser(uid: Int, name: String): User = {
    val user = new User
    user.setUid(Integer.valueOf(uid))
    user.setName(name)
    user.setEmail(s"$name@mail.com")
    user.setRole(UserRoleEnum.REGULAR)
    user.setPassword("123")
    user.setAccountCreationTime(exampleCreationTime)
    user
  }

  private val ownerUser: User = makeUser(1, "model_owner")
  private val otherUser: User = makeUser(2, "model_reader")

  private lazy val modelDao: ModelDao = new ModelDao(getDSLContext.configuration())
  private lazy val modelUserAccessDao: ModelUserAccessDao =
    new ModelUserAccessDao(getDSLContext.configuration())

  private def insertModel(
      mid: Int,
      name: String,
      isPublic: Boolean,
      description: String = "a model",
      framework: String = "pytorch",
      format: String = "safetensors"
  ): Model = {
    val model = new Model
    model.setMid(Integer.valueOf(mid))
    model.setOwnerUid(ownerUser.getUid)
    model.setName(name)
    model.setDescription(description)
    // Spec-scoped so a developer's real LakeFS can never hold a matching repo.
    model.setRepositoryName(s"modelsearchspec-model-$mid")
    model.setIsPublic(isPublic)
    model.setIsDownloadable(true)
    model.setFramework(framework)
    model.setFormat(format)
    modelDao.insert(model)
    model
  }

  private def keywords(ks: String*): util.ArrayList[String] = new util.ArrayList[String](ks.asJava)
  private def ids(is: Int*): util.ArrayList[Integer] =
    new util.ArrayList[Integer](is.map(Integer.valueOf).asJava)

  private def search(
      uid: Integer,
      params: SearchQueryParams,
      includePublic: Boolean
  ): List[Integer] =
    getDSLContext
      .fetch(ModelSearchQueryBuilder.constructQuery(uid, params, includePublic))
      .asScala
      .map(_.get("mid", classOf[Integer]))
      .toList

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    FulltextSearchQueryUtils.usePgroonga = false // embedded postgres has no pgroonga
    val userDao = new UserDao(getDSLContext.configuration())
    userDao.insert(ownerUser)
    userDao.insert(otherUser)
  }

  override protected def afterAll(): Unit = shutdownDB()

  private def clearModels(): Unit = {
    getDSLContext.deleteFrom(MODEL_USER_ACCESS).execute()
    getDSLContext.deleteFrom(MODEL).execute()
  }

  // -- access matrix ----------------------------------------------------------

  "ModelSearchQueryBuilder" should "deduplicate a model shared both publicly and explicitly" in {
    clearModels()
    insertModel(1, "shared_both_ways", isPublic = true)
    modelUserAccessDao.insert(
      new ModelUserAccess(Integer.valueOf(1), ownerUser.getUid, PrivilegeEnum.WRITE)
    )

    search(
      ownerUser.getUid,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE),
      includePublic = true
    ) shouldBe List(1)
  }

  it should "return only public models for an anonymous caller" in {
    clearModels()
    insertModel(1, "public_one", isPublic = true)
    insertModel(2, "private_one", isPublic = false)

    search(
      null,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE),
      includePublic = true
    ) shouldBe List(1)
  }

  it should "return only explicitly-shared models when includePublic is false" in {
    clearModels()
    insertModel(1, "public_one", isPublic = true)
    insertModel(2, "private_shared", isPublic = false)
    modelUserAccessDao.insert(
      new ModelUserAccess(Integer.valueOf(2), otherUser.getUid, PrivilegeEnum.READ)
    )

    search(
      otherUser.getUid,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE),
      includePublic = false
    ) shouldBe List(2)
  }

  it should "union public and explicitly-shared models when includePublic is true" in {
    clearModels()
    insertModel(1, "public_one", isPublic = true)
    insertModel(2, "private_shared", isPublic = false)
    insertModel(3, "private_unshared", isPublic = false)
    modelUserAccessDao.insert(
      new ModelUserAccess(Integer.valueOf(2), otherUser.getUid, PrivilegeEnum.READ)
    )

    search(
      otherUser.getUid,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE),
      includePublic = true
    ).sorted shouldBe List(1, 2)
  }

  // -- full-text search -------------------------------------------------------

  it should "match a keyword against the model name" in {
    clearModels()
    insertModel(1, "sentiment_classifier", isPublic = true)
    insertModel(2, "object_detector", isPublic = true)

    search(
      null,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE, keywords = keywords("sentiment")),
      includePublic = true
    ) shouldBe List(1)
  }

  it should "match a keyword against the framework" in {
    // Regression guard: the Models dashboard page filters on framework today,
    // so unified search must too or migrating the page loses functionality.
    clearModels()
    insertModel(1, "alpha", isPublic = true, framework = "pytorch")
    insertModel(2, "beta", isPublic = true, framework = "tensorflow")

    search(
      null,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE, keywords = keywords("tensorflow")),
      includePublic = true
    ) shouldBe List(2)
  }

  it should "match a keyword against the format" in {
    clearModels()
    insertModel(1, "alpha", isPublic = true, format = "safetensors")
    insertModel(2, "beta", isPublic = true, format = "onnx")

    search(
      null,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE, keywords = keywords("onnx")),
      includePublic = true
    ) shouldBe List(2)
  }

  it should "return nothing for a keyword that matches no model" in {
    clearModels()
    insertModel(1, "alpha", isPublic = true)

    search(
      null,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE, keywords = keywords("nonexistentword")),
      includePublic = true
    ) shouldBe empty
  }

  // -- id filter --------------------------------------------------------------

  it should "restrict results to the requested modelIds" in {
    clearModels()
    insertModel(1, "alpha", isPublic = true)
    insertModel(2, "beta", isPublic = true)

    search(
      null,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE, modelIds = ids(2)),
      includePublic = true
    ) shouldBe List(2)
  }

  it should "return nothing when modelIds names no accessible model" in {
    clearModels()
    insertModel(1, "alpha", isPublic = true)

    search(
      null,
      SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE, modelIds = ids(4242)),
      includePublic = true
    ) shouldBe empty
  }

  // -- toEntry ----------------------------------------------------------------

  it should "build a model DashboardClickableFileEntry with NONE access when unshared" in {
    clearModels()
    insertModel(1, "alpha", isPublic = true)

    val record = getDSLContext
      .fetch(
        ModelSearchQueryBuilder.constructQuery(
          ownerUser.getUid,
          SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE),
          includePublic = true
        )
      )
      .asScala
      .head

    val entry = ModelSearchQueryBuilder.toEntry(ownerUser.getUid, record)
    entry.resourceType shouldBe MODEL_RESOURCE_TYPE
    entry.model.isDefined shouldBe true
    entry.model.get.model.getName shouldBe "alpha"
    entry.model.get.accessPrivilege shouldBe PrivilegeEnum.NONE
    entry.model.get.isOwner shouldBe true
    // LakeFS has no such repository, so the size degrades to 0 instead of dropping the row.
    entry.model.get.size shouldBe 0L
  }

  it should "carry the explicit access privilege through toEntry" in {
    clearModels()
    insertModel(1, "alpha", isPublic = false)
    modelUserAccessDao.insert(
      new ModelUserAccess(Integer.valueOf(1), otherUser.getUid, PrivilegeEnum.WRITE)
    )

    val record = getDSLContext
      .fetch(
        ModelSearchQueryBuilder.constructQuery(
          otherUser.getUid,
          SearchQueryParams(resourceType = MODEL_RESOURCE_TYPE),
          includePublic = false
        )
      )
      .asScala
      .head

    val entry = ModelSearchQueryBuilder.toEntry(otherUser.getUid, record)
    entry.model.get.accessPrivilege shouldBe PrivilegeEnum.WRITE
    entry.model.get.isOwner shouldBe false
  }

  // -- union alignment --------------------------------------------------------

  it should "union with the workflow, project and dataset queries without an arity mismatch" in {
    // The single highest-value assertion for the UnifiedResourceSchema change:
    // every builder must still emit the same ordered column list.
    clearModels()
    insertModel(1, "alpha", isPublic = true)
    val params = SearchQueryParams()

    val q1 =
      WorkflowSearchQueryBuilder.constructQuery(ownerUser.getUid, params, includePublic = true)
    val q2 =
      ProjectSearchQueryBuilder.constructQuery(ownerUser.getUid, params, includePublic = true)
    val q3 =
      DatasetSearchQueryBuilder.constructQuery(ownerUser.getUid, params, includePublic = true)
    val q4 = ModelSearchQueryBuilder.constructQuery(ownerUser.getUid, params, includePublic = true)

    val united = getDSLContext.fetch(q1.unionAll(q2).unionAll(q3).unionAll(q4))
    united.asScala.map(_.get("resourceType", classOf[String])) should contain(MODEL_RESOURCE_TYPE)
  }
}
