#!/bin/sh
#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Publishes the environments baked into this image where the engine looks for
# them, then hands off to the normal computing-unit command.
#
# PveManager owns /tmp/texera-pve/venvs/<cuid>/<name>/pve and resolves an
# operator's environment by that path alone (PveManager.getPythonBin). The cuid
# is only known once the pod exists, which is why this runs at startup rather
# than at build time: the environments themselves are fully built into the image
# and this only links them into place.
#
# Each is a symlink, and the per-cuid directory is real, so an environment the
# user creates through the UI still lands beside them and still works.

set -eu

BAKED_ENV_ROOT="${TEXERA_BAKED_ENV_ROOT:-/opt/texera/python-envs}"
VENV_ROOT="/tmp/texera-pve/venvs"

if [ -n "${TEXERA_CU_ID:-}" ] && [ -d "$BAKED_ENV_ROOT" ]; then
  cu_venvs="$VENV_ROOT/$TEXERA_CU_ID"
  mkdir -p "$cu_venvs"

  for env_dir in "$BAKED_ENV_ROOT"/*; do
    [ -d "$env_dir" ] || continue
    name=$(basename "$env_dir")
    if [ ! -e "$cu_venvs/$name" ]; then
      ln -s "$env_dir" "$cu_venvs/$name"
      echo "[baked-env] published '$name' for computing unit $TEXERA_CU_ID"
    fi
  done
else
  echo "[baked-env] TEXERA_CU_ID unset or no baked environments; nothing to publish"
fi

exec "$@"
