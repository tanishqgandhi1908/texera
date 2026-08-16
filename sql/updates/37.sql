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

-- Environments: a Dockerfile a user owns, and the image built from it.
--
-- This supersedes virtual_environments as the way to choose what a computing unit
-- runs. A virtual environment could only add pip packages to the engine image's own
-- interpreter, which rules out anything needing a different Python, a system package
-- or a compiler. A Dockerfile has none of those limits.
--
-- virtual_environments is deliberately left in place: environments a user already
-- saved keep working for per-UDF selection, and nothing here migrates or drops them.

\c texera_db

SET search_path TO texera_db;

BEGIN;

CREATE TABLE IF NOT EXISTS environment
(
    eid           SERIAL PRIMARY KEY,
    uid           INT          NOT NULL,
    name          VARCHAR(128) NOT NULL,
    dockerfile    TEXT         NOT NULL,
    -- PENDING once created or edited, BUILDING while a job runs, then READY or FAILED.
    -- A computing unit may only start from an environment that is READY.
    status        VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    -- Where the built image can be pulled from. Null until a build first succeeds.
    image_tag     VARCHAR(512),
    -- Incremented per build and used as the image tag, so a rebuild produces a new
    -- reference instead of mutating one that running pods were started from.
    build_number  INT          NOT NULL DEFAULT 0,
    -- The build's output, kept here so it can still be read once the job that
    -- produced it has been cleaned up.
    build_log     TEXT,
    creation_time TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES "user" (uid) ON DELETE CASCADE,
    UNIQUE (uid, name)
);

CREATE INDEX IF NOT EXISTS idx_environment_uid ON environment (uid);

COMMIT;
