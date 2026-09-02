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

-- A computing-unit image an administrator has curated, which any user may then start a
-- computing unit from.
--
-- Rows are global rather than owned: the point of curating is that one trusted list is
-- offered to everybody, so there is no uid here and no per-user access table. created_by
-- records who added the row for auditing, and does not restrict who may use it.
--
-- An administrator supplies a reference to an image in some upstream registry. Texera
-- validates it and copies it into the in-cluster registry, and it is that copy a unit
-- pulls from -- so a unit never depends on an upstream registry being reachable, or on
-- an upstream tag still meaning what it meant when the image was curated.

\c texera_db

SET search_path TO texera_db;

BEGIN;

CREATE TABLE IF NOT EXISTS cu_image
(
    iid            SERIAL PRIMARY KEY,
    -- What users see in the computing-unit dropdown.
    name           VARCHAR(128) NOT NULL,
    -- What the administrator supplied, normalised to an image reference. Kept as given
    -- so a re-mirror pulls from the same place, and so the origin of an image already
    -- mirrored is still answerable.
    source_ref     VARCHAR(512) NOT NULL,
    -- The digest source_ref resolved to when it was last mirrored. A tag can be moved
    -- upstream; this records what was actually copied.
    source_digest  VARCHAR(128),
    -- PENDING once created, MIRRORING while the copy job runs, then READY or FAILED.
    -- A computing unit may only start from a READY image. Constrained rather than left
    -- free text: every writer is in this repository, so a value outside this set is a
    -- bug, and finding it at the boundary beats a unit silently refusing to start.
    status         VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
        CONSTRAINT ck_cu_image_status
            CHECK (status IN ('PENDING', 'MIRRORING', 'READY', 'FAILED')),
    -- Where a computing unit pulls from: the in-cluster registry, not the upstream one.
    -- Null until a mirror first succeeds.
    image_tag      VARCHAR(512),
    -- Incremented per mirror and used as the tag, so re-mirroring publishes a new
    -- reference instead of mutating one that running pods were started from.
    mirror_number  INT          NOT NULL DEFAULT 0,
    -- The mirror job's output, including why validation rejected an image. Kept here so
    -- it outlives the job that produced it.
    mirror_log     TEXT,
    -- Who added this row. Nulled rather than cascaded on user deletion: the image stays
    -- usable, it just no longer says who curated it.
    created_by     INT,
    creation_time  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES "user" (uid) ON DELETE SET NULL,
    UNIQUE (name)
);

-- Registering a reference that is already mirrored should reuse the existing copy rather
-- than pull the whole image again, so the digest is looked up before a copy is started.
CREATE INDEX IF NOT EXISTS idx_cu_image_source_digest ON cu_image (source_digest);

COMMIT;
