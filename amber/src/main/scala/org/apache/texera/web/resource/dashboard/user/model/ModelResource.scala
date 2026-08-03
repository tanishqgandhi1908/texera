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

package org.apache.texera.web.resource.dashboard.user.model

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.util.LakeFSStorageClient
import org.apache.texera.dao.jooq.generated.tables.pojos.Model
import org.jooq.EnumType

object ModelResource extends LazyLogging {
  // Mirrors file-service's ModelResource.DashboardModel; amber does not depend on file-service.
  // TODO: move these community resource definitions to a centralized package, similar to workflow-core
  case class DashboardModel(
      model: Model,
      ownerEmail: String,
      accessPrivilege: EnumType,
      isOwner: Boolean,
      size: Long
  )

  /** Size of a model's LakeFS repository, or 0 if LakeFS cannot answer. */
  def repositorySizeOrZero(model: Model): Long = {
    try {
      LakeFSStorageClient.retrieveRepositorySize(model.getRepositoryName)
    } catch {
      case e: io.lakefs.clients.sdk.ApiException =>
        logger.error(
          s"LakeFS ApiException for model repository '${model.getRepositoryName}': ${e.getMessage}",
          e
        )
        0L
    }
  }
}
