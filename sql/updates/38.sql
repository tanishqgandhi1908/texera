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

-- Drops the user-built environment feature added in 37.sql.
--
-- A computing-unit image is no longer built inside Texera from a Dockerfile a user
-- typed. It is now an image an administrator has curated, which removes the build
-- pipeline and everything that had to be true for it to be safe: arbitrary
-- user-supplied build instructions, a builder with network access, and an image
-- whose contents nobody reviewed.
--
-- Nothing is migrated. A row here holds a Dockerfile and a reference to an image
-- built from it; neither survives the change, because the replacement is an image
-- reference an administrator supplies rather than a recipe a user wrote. Images
-- already pushed to the registry are unreferenced after this and are reclaimed
-- when the registry is next garbage-collected.

\c texera_db
SET search_path TO texera_db;

BEGIN;

DROP INDEX IF EXISTS idx_environment_uid;
DROP TABLE IF EXISTS environment;

COMMIT;
