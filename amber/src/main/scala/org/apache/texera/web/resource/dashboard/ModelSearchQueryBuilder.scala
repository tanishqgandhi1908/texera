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

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.dao.jooq.generated.Tables.{MODEL, MODEL_USER_ACCESS}
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.User.USER
import org.apache.texera.dao.jooq.generated.tables.pojos.{Model, User}
import org.apache.texera.web.resource.dashboard.DashboardResource.DashboardClickableFileEntry
import org.apache.texera.web.resource.dashboard.FulltextSearchQueryUtils.{
  getContainsFilter,
  getDateFilter,
  getFullTextSearchFilter
}
import org.apache.texera.web.resource.dashboard.user.model.ModelResource.{
  DashboardModel,
  repositorySizeOrZero
}
import org.jooq.impl.DSL
import org.jooq.{Condition, GroupField, Record, TableLike}

import scala.jdk.CollectionConverters.CollectionHasAsScala

object ModelSearchQueryBuilder extends SearchQueryBuilder with LazyLogging {
  override protected val mappedResourceSchema: UnifiedResourceSchema = UnifiedResourceSchema(
    resourceType = DSL.inline(SearchQueryBuilder.MODEL_RESOURCE_TYPE),
    name = MODEL.NAME,
    description = MODEL.DESCRIPTION,
    creationTime = MODEL.CREATION_TIME,
    ownerId = MODEL.OWNER_UID,
    repositoryName = MODEL.REPOSITORY_NAME,
    mid = MODEL.MID,
    isModelPublic = MODEL.IS_PUBLIC,
    isModelDownloadable = MODEL.IS_DOWNLOADABLE,
    modelUserAccess = MODEL_USER_ACCESS.PRIVILEGE,
    modelCoverImage = MODEL.COVER_IMAGE,
    modelFramework = MODEL.FRAMEWORK,
    modelFormat = MODEL.FORMAT
  )

  /*
   * constructs the FROM clause for querying models with specific access controls.
   * Same four-case matrix as DatasetSearchQueryBuilder; see its comment.
   */
  override protected def constructFromClause(
      uid: Integer,
      params: DashboardResource.SearchQueryParams,
      includePublic: Boolean = false
  ): TableLike[_] = {
    val baseJoin = MODEL
      .leftJoin(MODEL_USER_ACCESS)
      .on(MODEL_USER_ACCESS.MID.eq(MODEL.MID))
      .and(if (uid == null) DSL.falseCondition() else MODEL_USER_ACCESS.UID.eq(uid))
      .leftJoin(USER)
      .on(USER.UID.eq(MODEL.OWNER_UID))

    val condition: Condition =
      if (uid == null) {
        MODEL.IS_PUBLIC.eq(true)
      } else {
        if (includePublic) {
          MODEL.IS_PUBLIC.eq(true).or(MODEL_USER_ACCESS.UID.isNotNull)
        } else {
          MODEL_USER_ACCESS.UID.isNotNull
        }
      }
    baseJoin.where(condition)
  }

  override protected def constructWhereClause(
      uid: Integer,
      params: DashboardResource.SearchQueryParams
  ): Condition = {
    val splitKeywords = params.keywords.asScala
      .flatMap(_.split("[+\\-()<>~*@\"]"))
      .filter(_.nonEmpty)
      .toSeq

    getDateFilter(
      params.creationStartDate,
      params.creationEndDate,
      MODEL.CREATION_TIME
    )
      .and(getContainsFilter(params.modelIds, MODEL.MID))
      .and(
        // framework and format are searchable, matching the Models dashboard page.
        // Keep this field list in sync with the model PGroonga index in texera_ddl.sql.
        getFullTextSearchFilter(
          splitKeywords,
          List(MODEL.NAME, MODEL.DESCRIPTION, MODEL.FRAMEWORK, MODEL.FORMAT)
        )
      )
  }

  override protected def getGroupByFields: Seq[GroupField] = {
    Seq.empty
  }

  override protected def toEntryImpl(
      uid: Integer,
      record: Record
  ): DashboardResource.DashboardClickableFileEntry = {
    val model = record.into(MODEL).into(classOf[Model])
    val owner = record.into(USER).into(classOf[User])

    val dm = DashboardModel(
      model,
      owner.getEmail,
      Option(
        record.get(
          MODEL_USER_ACCESS.PRIVILEGE,
          classOf[PrivilegeEnum]
        )
      ).getOrElse(PrivilegeEnum.NONE),
      model.getOwnerUid == uid,
      // 0 on LakeFS failure, so a model is never dropped from the result set.
      repositorySizeOrZero(model)
    )
    DashboardClickableFileEntry(
      resourceType = SearchQueryBuilder.MODEL_RESOURCE_TYPE,
      model = Some(dm)
    )
  }
}

class ModelSearchQueryBuilder {}
