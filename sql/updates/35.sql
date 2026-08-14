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

\c texera_db

SET search_path TO texera_db;

BEGIN;

-- The version of `framework` a model was trained against, e.g. "1.5.0" for sklearn.
-- Nullable: models created before this column, and models whose framework is "other",
-- have no version to record. Together with `framework` it is what the model's Python
-- environment installs.
ALTER TABLE model
    ADD COLUMN IF NOT EXISTS framework_version VARCHAR(32);

-- Creating a model now also provisions an environment named "pve-for-model-<model name>".
-- A model name is up to 128 characters, so the 14-character prefix no longer fits in the
-- old VARCHAR(128).
ALTER TABLE virtual_environments
    ALTER COLUMN name TYPE VARCHAR(160);

COMMIT;
