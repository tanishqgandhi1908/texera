/**
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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { DatasetFileNode } from "./datasetVersionFileTree";

export interface Model {
  mid: number | undefined;
  ownerUid: number | undefined;
  name: string;
  repositoryName: string | undefined;
  isPublic: boolean;
  isDownloadable: boolean;
  description: string;
  creationTime: number | undefined;
  coverImage: string | undefined;
  framework: string | undefined;
  format: string | undefined;
  /**
   * Version of `framework` the model was trained against, e.g. "1.5.0". Descriptive: it
   * says which Python environment suits the model, but nothing is derived from it.
   */
  frameworkVersion: string | undefined;
  /**
   * The saved Python environment (`virtual_environments.veid`) the model should be loaded
   * in, chosen by its owner from the environments they already have. Undefined means the
   * choice was skipped, and a UDF loading the model runs on the engine's default libraries.
   */
  veid: number | undefined;
}

export interface ModelVersion {
  mvid: number | undefined;
  mid: number;
  creatorUid: number;
  name: string;
  versionHash: string | undefined;
  creationTime: number | undefined;
  fileNodes: DatasetFileNode[] | undefined;
}
