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

-- Lets a model say which Python environment it should be loaded in.
--
-- Many machine learning libraries only load what they wrote themselves -- a scikit-learn
-- 1.5 pickle is not reliably readable by 1.7 -- so loading a model under the wrong library
-- versions fails, or worse, quietly loads something different. Naming an environment its
-- owner already has lets the property panel warn about exactly that case.
--
-- Nullable and defaulting to NULL, so every existing model keeps working exactly as
-- before: no environment named, and loaded on the engine's default libraries.

\c texera_db
SET search_path TO texera_db;

BEGIN;

ALTER TABLE model
    -- The Python environment the model should be loaded in, chosen by its owner from the
    -- environments they already have. NULL means the choice was skipped.
    ADD COLUMN IF NOT EXISTS veid INT;

-- SET NULL rather than CASCADE: deleting the environment drops the model back to the
-- default libraries rather than deleting the model, and rather than blocking the delete.
ALTER TABLE model
    DROP CONSTRAINT IF EXISTS model_veid_fkey;
ALTER TABLE model
    ADD CONSTRAINT model_veid_fkey FOREIGN KEY (veid)
        REFERENCES virtual_environments (veid) ON DELETE SET NULL;

COMMIT;
