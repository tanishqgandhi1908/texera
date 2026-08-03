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

package org.apache.texera.web.resource.dashboard.hub

import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.dao.jooq.generated.enums.{PrivilegeEnum, UserRoleEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  DatasetDao,
  ModelDao,
  ModelUserAccessDao,
  UserDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{Dataset, Model, ModelUserAccess, User}
import org.apache.texera.web.resource.dashboard.hub.HubResource.{UserRequest, ViewRequest}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.lang.reflect.{InvocationHandler, Method, Proxy}
import java.time.OffsetDateTime
import javax.servlet.http.HttpServletRequest
import scala.jdk.CollectionConverters._

/**
  * Covers the hub surfaces for models: likes, view counts, batch counts, tops and user-access.
  * Model is the third EntityType and, like Dataset, has no clone table.
  */
class HubModelResourceSpec
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

  private lazy val hubResource: HubResource = new HubResource()

  // Dependency-free double: only getRemoteAddr is consulted by recordUserAction.
  private val httpRequest: HttpServletRequest = {
    val handler = new InvocationHandler {
      override def invoke(p: Any, m: Method, args: Array[AnyRef]): AnyRef =
        if (m.getName == "getRemoteAddr") "127.0.0.1"
        else if (m.getReturnType == java.lang.Boolean.TYPE) java.lang.Boolean.FALSE
        else if (m.getReturnType == java.lang.Integer.TYPE) Integer.valueOf(0)
        else null
    }
    Proxy
      .newProxyInstance(
        classOf[HttpServletRequest].getClassLoader,
        Array[Class[_]](classOf[HttpServletRequest]),
        handler
      )
      .asInstanceOf[HttpServletRequest]
  }

  private def actions(as: ActionType*): java.util.List[ActionType] = as.toList.asJava

  private def insertModel(mid: Int, name: String, isPublic: Boolean): Model = {
    val model = new Model
    model.setMid(Integer.valueOf(mid))
    model.setOwnerUid(ownerUser.getUid)
    model.setName(name)
    // Spec-scoped name so a developer's real LakeFS can never hold a matching repo.
    model.setRepositoryName(s"hubmodelspec-model-$mid")
    model.setIsPublic(isPublic)
    model.setIsDownloadable(true)
    model.setDescription(s"description of $name")
    model.setFramework("pytorch")
    model.setFormat("safetensors")
    modelDao.insert(model)
    model
  }

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    val userDao = new UserDao(getDSLContext.configuration())
    userDao.insert(ownerUser)
    userDao.insert(otherUser)
  }

  override protected def afterAll(): Unit = shutdownDB()

  private def clearModels(): Unit = {
    getDSLContext.deleteFrom(MODEL_USER_LIKES).execute()
    getDSLContext.deleteFrom(MODEL_VIEW_COUNT).execute()
    getDSLContext.deleteFrom(MODEL_USER_ACCESS).execute()
    getDSLContext.deleteFrom(USER_ACTION).execute()
    getDSLContext.deleteFrom(MODEL).execute()
    getDSLContext.deleteFrom(DATASET_VIEW_COUNT).execute()
    getDSLContext.deleteFrom(DATASET).execute()
  }

  // -- likes ------------------------------------------------------------------

  "postLike" should "record a like and make isLiked report true" in {
    clearModels()
    insertModel(1, "likeable", isPublic = true)

    val liked = HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(1), EntityType.Model),
      isLike = true
    )

    liked shouldBe true
    HubResource
      .isLikedHelper(
        ownerUser.getUid,
        List(Integer.valueOf(1)).asJava,
        List[EntityType](EntityType.Model).asJava
      )
      .asScala
      .head
      .isLiked shouldBe true
  }

  it should "be a no-op returning false when the model is already liked" in {
    clearModels()
    insertModel(1, "likeable", isPublic = true)
    val req = UserRequest(Integer.valueOf(1), EntityType.Model)
    HubResource.recordLikeAction(httpRequest, ownerUser.getUid, req, isLike = true) shouldBe true

    HubResource.recordLikeAction(httpRequest, ownerUser.getUid, req, isLike = true) shouldBe false
    getDSLContext.fetchCount(MODEL_USER_LIKES) shouldBe 1
  }

  "postUnlike" should "remove the like and make isLiked report false" in {
    clearModels()
    insertModel(1, "likeable", isPublic = true)
    val req = UserRequest(Integer.valueOf(1), EntityType.Model)
    HubResource.recordLikeAction(httpRequest, ownerUser.getUid, req, isLike = true)

    HubResource.recordLikeAction(httpRequest, ownerUser.getUid, req, isLike = false) shouldBe true
    HubResource
      .isLikedHelper(
        ownerUser.getUid,
        List(Integer.valueOf(1)).asJava,
        List[EntityType](EntityType.Model).asJava
      )
      .asScala
      .head
      .isLiked shouldBe false
  }

  it should "return false when unliking a model that was never liked" in {
    clearModels()
    insertModel(1, "likeable", isPublic = true)

    HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(1), EntityType.Model),
      isLike = false
    ) shouldBe false
  }

  // -- views ------------------------------------------------------------------

  "postView" should "insert a view count of 1 and upsert to 2 on the second call" in {
    clearModels()
    insertModel(1, "viewed", isPublic = true)
    val req = ViewRequest(Integer.valueOf(1), ownerUser.getUid, EntityType.Model)

    hubResource.postView(httpRequest, req) shouldBe 1
    hubResource.postView(httpRequest, req) shouldBe 2
  }

  // -- counts -----------------------------------------------------------------

  "getCounts" should "report a clone count of 0 for a model instead of throwing" in {
    clearModels()
    insertModel(1, "counted", isPublic = true)

    val responses = hubResource.getCounts(
      List[EntityType](EntityType.Model).asJava,
      List(Integer.valueOf(1)).asJava,
      actions(ActionType.Clone)
    )

    responses.asScala.head.counts.get(ActionType.Clone) shouldBe 0
  }

  it should "succeed for a model when no actionType is given (defaults include clone)" in {
    clearModels()
    insertModel(1, "counted", isPublic = true)
    HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(1), EntityType.Model),
      isLike = true
    )

    val counts = hubResource
      .getCounts(
        List[EntityType](EntityType.Model).asJava,
        List(Integer.valueOf(1)).asJava,
        actions()
      )
      .asScala
      .head
      .counts

    counts.get(ActionType.Like) shouldBe 1
    counts.get(ActionType.Clone) shouldBe 0
  }

  it should "also succeed for a dataset with the default actionTypes" in {
    // Regression guard: the clone branch used to be skipped by an
    // `etype != Dataset` test rather than by whether a clone table exists.
    clearModels()
    val dataset = new Dataset
    dataset.setDid(Integer.valueOf(1))
    dataset.setOwnerUid(ownerUser.getUid)
    dataset.setName("a_dataset")
    dataset.setDescription("a dataset")
    dataset.setRepositoryName("dataset-1")
    dataset.setIsPublic(true)
    dataset.setIsDownloadable(true)
    new DatasetDao(getDSLContext.configuration()).insert(dataset)

    val responses = hubResource.getCounts(
      List[EntityType](EntityType.Dataset).asJava,
      List(Integer.valueOf(1)).asJava,
      actions()
    )

    responses.asScala.head.counts.get(ActionType.Clone) shouldBe 0
  }

  it should "reject mismatched entityType and entityId list lengths" in {
    a[javax.ws.rs.BadRequestException] should be thrownBy hubResource.getCounts(
      List[EntityType](EntityType.Model, EntityType.Model).asJava,
      List(Integer.valueOf(1)).asJava,
      actions()
    )
  }

  // -- getTops ----------------------------------------------------------------

  "getTops" should "return an empty clone bucket for models rather than a 500" in {
    clearModels()
    insertModel(1, "topped", isPublic = true)

    val tops = hubResource.getTops(EntityType.Model, null, null, null)

    tops.get("like") should not be null
    tops.get("clone").asScala shouldBe empty
  }

  it should "also return an empty clone bucket for datasets with no actionTypes" in {
    // Regression guard: this combination threw IllegalArgumentException before.
    val tops = hubResource.getTops(EntityType.Dataset, null, null, null)
    tops.get("clone").asScala shouldBe empty
  }

  it should "return only public models, most-liked first, capped at the limit" in {
    clearModels()
    insertModel(1, "public_one", isPublic = true)
    insertModel(2, "public_two", isPublic = true)
    insertModel(3, "private_one", isPublic = false)

    // model 2 gets two likes, model 1 one like, model 3 one like but is private
    HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(2), EntityType.Model),
      isLike = true
    )
    HubResource.recordLikeAction(
      httpRequest,
      otherUser.getUid,
      UserRequest(Integer.valueOf(2), EntityType.Model),
      isLike = true
    )
    HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(1), EntityType.Model),
      isLike = true
    )
    HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(3), EntityType.Model),
      isLike = true
    )

    val likeBucket = hubResource
      .getTops(EntityType.Model, actions(ActionType.Like), ownerUser.getUid, null)
      .get("like")
      .asScala
      .toList

    likeBucket.map(_.model.get.model.getMid.intValue()) shouldBe List(2, 1)
    likeBucket.foreach(_.resourceType shouldBe "model")
  }

  it should "honour the limit parameter" in {
    clearModels()
    insertModel(1, "a", isPublic = true)
    insertModel(2, "b", isPublic = true)
    HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(1), EntityType.Model),
      isLike = true
    )
    HubResource.recordLikeAction(
      httpRequest,
      ownerUser.getUid,
      UserRequest(Integer.valueOf(2), EntityType.Model),
      isLike = true
    )

    hubResource
      .getTops(
        EntityType.Model,
        actions(ActionType.Like),
        ownerUser.getUid,
        Integer.valueOf(1)
      )
      .get("like")
      .size() shouldBe 1
  }

  it should "reject an unsupported actionType" in {
    a[javax.ws.rs.BadRequestException] should be thrownBy hubResource.getTops(
      EntityType.Model,
      actions(ActionType.View),
      null,
      null
    )
  }

  // -- getCount ---------------------------------------------------------------

  "getCount" should "count only public models" in {
    clearModels()
    insertModel(1, "public_one", isPublic = true)
    insertModel(2, "private_one", isPublic = false)

    hubResource.getCount(EntityType.Model) shouldBe 1
  }

  // -- fetchDashboardModelsByMids ---------------------------------------------

  "fetchDashboardModelsByMids" should "return an empty list without querying for no ids" in {
    HubResource.fetchDashboardModelsByMids(Seq.empty, ownerUser.getUid) shouldBe List.empty
  }

  it should "return an empty list for an unknown mid" in {
    clearModels()
    HubResource
      .fetchDashboardModelsByMids(Seq(Integer.valueOf(4242)), ownerUser.getUid) shouldBe List.empty
  }

  it should "mark the owner and carry the access privilege" in {
    clearModels()
    insertModel(1, "owned", isPublic = true)
    val access = new ModelUserAccess(Integer.valueOf(1), otherUser.getUid, PrivilegeEnum.READ)
    modelUserAccessDao.insert(access)

    val forOwner = HubResource.fetchDashboardModelsByMids(Seq(Integer.valueOf(1)), ownerUser.getUid)
    forOwner should have size 1
    forOwner.head.isOwner shouldBe true
    forOwner.head.ownerEmail shouldBe ownerUser.getEmail
    forOwner.head.accessPrivilege shouldBe PrivilegeEnum.READ
  }

  it should "report isOwner false for an anonymous caller" in {
    clearModels()
    insertModel(1, "owned", isPublic = true)

    HubResource
      .fetchDashboardModelsByMids(Seq(Integer.valueOf(1)), null)
      .head
      .isOwner shouldBe false
  }

  it should "report size 0 when LakeFS cannot answer, rather than dropping the model" in {
    // No LakeFS is running under the embedded DB, so this exercises the
    // 0-on-failure path that keeps a hub card visible.
    clearModels()
    insertModel(1, "sizeless", isPublic = true)

    val models = HubResource.fetchDashboardModelsByMids(Seq(Integer.valueOf(1)), ownerUser.getUid)
    models should have size 1
    models.head.size shouldBe 0L
  }

  // -- user-access ------------------------------------------------------------

  "userAccess" should "return the uids granted access to a model" in {
    clearModels()
    insertModel(1, "shared", isPublic = false)
    modelUserAccessDao.insert(
      new ModelUserAccess(Integer.valueOf(1), otherUser.getUid, PrivilegeEnum.WRITE)
    )

    val responses = hubResource.userAccess(
      List[EntityType](EntityType.Model).asJava,
      List(Integer.valueOf(1)).asJava
    )

    responses.asScala.head.userIds.asScala.toList shouldBe List(otherUser.getUid)
  }

  it should "return an empty uid list for a model nobody has explicit access to" in {
    clearModels()
    insertModel(1, "unshared", isPublic = true)

    hubResource
      .userAccess(
        List[EntityType](EntityType.Model).asJava,
        List(Integer.valueOf(1)).asJava
      )
      .asScala
      .head
      .userIds
      .asScala shouldBe empty
  }
}
