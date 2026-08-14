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

-- The Python environment a model should be loaded in, chosen by its owner from the
-- environments they already have. NULL means the choice was skipped, and a UDF loading
-- the model runs on the Amber engine's default libraries.
--
-- Replaces the environment that model creation used to provision by itself. The rows it
-- provisioned, named "pve-for-model-<model name>", are ordinary user environments and
-- remain selectable; nothing needs removing.
ALTER TABLE model
    ADD COLUMN IF NOT EXISTS veid INT;

-- ON DELETE SET NULL: deleting an environment a model points at drops the model back to
-- the default libraries rather than blocking the delete. The model itself is unaffected,
-- so the stricter alternative would only strand the environment.
ALTER TABLE model
    DROP CONSTRAINT IF EXISTS model_veid_fkey;
ALTER TABLE model
    ADD CONSTRAINT model_veid_fkey FOREIGN KEY (veid)
        REFERENCES virtual_environments (veid) ON DELETE SET NULL;

COMMIT;
