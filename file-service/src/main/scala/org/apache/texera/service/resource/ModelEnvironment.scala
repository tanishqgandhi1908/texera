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

/**
  * The Python environment that goes with a model.
  *
  * A model records the framework and framework version it was trained against, and many
  * machine learning libraries only load what they wrote themselves — a scikit-learn 1.5
  * pickle is not reliably readable by 1.7. Creating a model therefore also provisions a
  * Python virtual environment specification pinned to that pair, so a UDF that loads the
  * model has a ready-made environment to run in.
  *
  * What is provisioned is only the specification (a row in `virtual_environments`): a name
  * and the packages it should contain. Materialising it — creating the venv and running
  * pip — stays where it already was, an explicit action against a chosen computing unit.
  */
object ModelEnvironment {

  /** Prefix for the environment a model provisions. Never a valid user-authored name. */
  private val PveNamePrefix = "pve-for-model-"

  /**
    * PyPI distribution for a framework label, where the two differ. `pytorch` is published
    * as `torch`, and `sklearn` is a deprecated stub that refuses to install — `scikit-learn`
    * is the real distribution. Labels absent here install under their own name.
    *
    * `other` has no distribution: we do not know what to install, so no environment is
    * provisioned for it.
    */
  private val Distributions: Map[String, String] =
    Map(
      "pytorch" -> "torch",
      "sklearn" -> "scikit-learn",
      "tensorflow" -> "tensorflow",
      "onnx" -> "onnx"
    )

  /**
    * Accepts what PyPI accepts, loosely: a dotted release, optionally with a pre/post
    * suffix or a local version, e.g. "1.5.0", "2.13.0+cpu", "1.7.2rc1". Deliberately not a
    * full PEP 440 parser — it exists to keep junk out of a pip command line and to stay
    * within the column's 32 characters.
    */
  private val VersionPattern = "^[0-9]+(\\.[0-9]+){0,3}[A-Za-z0-9.+-]{0,16}$".r

  def isValidVersion(version: String): Boolean =
    version != null && version.length <= 32 && VersionPattern.pattern.matcher(version).matches()

  /** The environment name for a model, e.g. "pve-for-model-churn-clf". */
  def pveName(modelName: String): String = s"$PveNamePrefix$modelName"

  def isModelPveName(name: String): Boolean =
    name != null && name.startsWith(PveNamePrefix)

  /**
    * The packages the model's environment should contain, in the `{name -> "==version"}`
    * shape `virtual_environments.packages` stores.
    *
    * Empty when we cannot name a distribution to install — an unknown or `other` framework,
    * or a missing version. An empty result means no environment is provisioned at all,
    * rather than an environment that installs nothing.
    */
  def packagesFor(framework: String, frameworkVersion: String): Map[String, String] = {
    val label = Option(framework).map(_.trim.toLowerCase).getOrElse("")
    val version = Option(frameworkVersion).map(_.trim).getOrElse("")
    if (version.isEmpty || !isValidVersion(version)) Map.empty
    else Distributions.get(label).map(dist => Map(dist -> s"==$version")).getOrElse(Map.empty)
  }
}
