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
  * The framework version a model records.
  *
  * Many machine learning libraries only load what they wrote themselves — a scikit-learn
  * 1.5 pickle is not reliably readable by 1.7 — so a model states the version it was
  * trained against. That statement is descriptive: it tells whoever picks the model's
  * Python environment which one to pick, but nothing derives an environment from it. The
  * environment is chosen by the owner from the environments they already have, and may be
  * skipped entirely, in which case the model loads under the engine's default libraries.
  *
  * All that leaves here is keeping an implausible version out of the column.
  */
object ModelEnvironment {

  /**
    * Accepts what PyPI accepts, loosely: a dotted release, optionally with a pre/post
    * suffix or a local version, e.g. "1.5.0", "2.13.0+cpu", "1.7.2rc1". Deliberately not a
    * full PEP 440 parser — it exists to keep junk out of the column, and to stay within its
    * 32 characters.
    */
  private val VersionPattern = "^[0-9]+(\\.[0-9]+){0,3}[A-Za-z0-9.+-]{0,16}$".r

  def isValidVersion(version: String): Boolean =
    version != null && version.length <= 32 && VersionPattern.pattern.matcher(version).matches()
}
