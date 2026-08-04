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

package org.apache.texera.amber.operator.udf.python

import org.apache.texera.amber.core.storage.FileResolver
import org.apache.texera.common.config.EnvironmentalVariable

import java.nio.file.Paths

/**
  * Shared handling of a Python UDF's UI parameters, between the operator descriptors and
  * [[PythonUdfUiParameterInjector]].
  *
  * Most parameters carry their value straight through to the generated code. A `models`
  * parameter does not: the user picks a model *version*, and what the UDF wants is the
  * directory that version is readable at inside the computing unit. So a models parameter
  * is rewritten here — its stored `/models/owner/name/version` becomes the in-pod mount
  * path — and the version it names is reported back so the physical operator can record
  * that the worker has to mount it.
  *
  * The mount path is derived rather than looked up, because it has to be settled before
  * the worker exists: a mount lands at `<root>/<repository>/<commit>`, and both this and
  * `ModelMountManager` compute it the same way from the same environment variable.
  */
object PythonUdfUiParameterSupport {

  /** Parameter kind that selects a model version rather than free text. */
  val ModelsInputType = "models"

  private val DefaultInPodMountRoot = "/mnt/texera-mounts"

  /**
    * @param parameters   parameters with models values rewritten to their mount paths
    * @param mountedModels variable name -> "<repositoryName>:<commitHash>", for the worker to mount
    */
  case class ResolvedUiParameters(
      parameters: List[UiUDFParameter],
      mountedModels: Map[String, String]
  )

  private def inPodMountRoot: String =
    sys.env
      .get(EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT)
      .map(_.trim)
      .filter(_.nonEmpty)
      .getOrElse(DefaultInPodMountRoot)

  def isModelsParameter(parameter: UiUDFParameter): Boolean =
    Option(parameter.inputType).map(_.trim.toLowerCase).contains(ModelsInputType)

  /**
    * Rewrites models parameters to mount paths and collects the versions to mount.
    * Non-models parameters are returned unchanged.
    */
  def resolve(uiParameters: List[UiUDFParameter]): ResolvedUiParameters = {
    val parameters = Option(uiParameters).getOrElse(List.empty).filter(_ != null)

    val mountedModels = scala.collection.mutable.LinkedHashMap.empty[String, String]

    val resolved = parameters.map { parameter =>
      if (!isModelsParameter(parameter)) parameter
      else {
        val variableName = Option(parameter.attribute).map(_.getName).getOrElse("")
        val modelPath = Option(parameter.value).map(_.trim).getOrElse("")
        if (modelPath.isEmpty) {
          throw new RuntimeException(
            s"No model selected for the models parameter '$variableName'."
          )
        }
        val (repositoryName, commitHash) = FileResolver.resolveModelVersion(modelPath)
        mountedModels += (variableName -> s"$repositoryName:$commitHash")

        val rewritten = new UiUDFParameter()
        rewritten.attribute = parameter.attribute
        rewritten.inputType = parameter.inputType
        rewritten.value = Paths.get(inPodMountRoot, repositoryName, commitHash).toString
        rewritten
      }
    }

    ResolvedUiParameters(resolved, mountedModels.toMap)
  }

  /**
    * Resolves the parameters and injects them into `code`, returning the generated code
    * alongside the model versions the worker must mount for it to run.
    */
  def injectInto(code: String, uiParameters: List[UiUDFParameter]): (String, Map[String, String]) = {
    val ResolvedUiParameters(parameters, mountedModels) = resolve(uiParameters)
    (PythonUdfUiParameterInjector.inject(code, parameters), mountedModels)
  }
}
