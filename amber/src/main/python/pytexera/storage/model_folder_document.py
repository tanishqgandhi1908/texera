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
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

import json
import os
import urllib.parse
from pathlib import Path

import requests

from .dataset_file_document import DatasetFileDocument


class ModelFolderDocument:
    """Materializes a whole model *version* (a folder of files) onto local disk so a
    loader that opens sibling files by real path (TF SavedModel, ONNX external-data,
    transformers ``from_pretrained``, sharded checkpoints, ...) can read them.

    Generalizes ``DatasetFileDocument`` (single file → in-memory ``BytesIO``) to a
    folder: it enumerates the version's files, then streams each one **to disk**
    (never fully into memory — LLM shards can be tens of GB), preserving the relative
    directory structure. Downloads are cached by version so a second run reuses them.

    Usage in a Python UDF::

        from pytexera.storage import ModelFolderDocument
        model_dir = ModelFolderDocument("/models/alice@x.com/my-model/v1").download()
        # now load with any loader that wants a local directory:
        import torch
        model = torch.jit.load(f"{model_dir}/model.pt")

    Enumeration order:
      1. the file-service ``list-files`` endpoint (works for any folder), else
      2. a ``texera_manifest.json`` inside the folder holding ``{"files": [...]}``
         (lets the folder flow work before that endpoint is deployed).
    """

    _CHUNK_BYTES = 1 << 20  # 1 MiB streaming chunks (stream to disk, not memory)

    def __init__(self, folder_path: str):
        """
        :param folder_path:
            "/ownerEmail/name/version" or "/ownerEmail/name/version/subfolder"
            (a leading "/models" or "/datasets" prefix is accepted and stripped).
        """
        parts = folder_path.strip("/").split("/")
        if parts and parts[0] in ("datasets", "models"):
            parts = parts[1:]
        if len(parts) < 3:
            raise ValueError(
                "Invalid model folder path. "
                "Expected: /ownerEmail/name/version[/subfolder]"
            )
        self.owner_email = parts[0]
        self.name = parts[1]
        self.version = parts[2]
        # The picker hands back a path that may point at a single file *inside* the model
        # version (there is no folder-select widget). We always materialize the WHOLE
        # version so the loader sees every sibling file, so anything after
        # owner/name/version (a selected file or subfolder) is intentionally ignored.
        self.subfolder = ""

        self.jwt_token = os.getenv("USER_JWT_TOKEN")
        presign = os.getenv("FILE_SERVICE_GET_PRESIGNED_URL_ENDPOINT") or (
            "http://localhost:9092/api/dataset/presign-download"
        )
        base = presign.rsplit("/", 1)[0]  # ".../api/dataset"
        self.list_endpoint = f"{base}/list-files"
        self.public_list_endpoint = f"{base}/public-list-files"

        self.cache_root = Path(
            os.getenv("TEXERA_MODEL_CACHE_DIR", "/tmp/texera-models")
        )

    # ---- enumeration ----------------------------------------------------------

    def _version_prefix(self) -> str:
        return f"/{self.owner_email}/{self.name}/{self.version}"

    def _folder_logical_path(self) -> str:
        return self._version_prefix() + (f"/{self.subfolder}" if self.subfolder else "")

    def list_files(self) -> list:
        """Returns the model's files as paths relative to the version root."""
        files = self._list_from_endpoint()
        if files is not None:
            return files
        return self._list_from_manifest()

    def _list_from_endpoint(self):
        if self.jwt_token:
            endpoint = self.list_endpoint
            headers = {"Authorization": f"Bearer {self.jwt_token}"}
        else:
            endpoint = self.public_list_endpoint
            headers = {}
        params = {"filePath": urllib.parse.quote(self._folder_logical_path())}
        try:
            with DatasetFileDocument._retry_session() as session:
                resp = session.get(
                    endpoint,
                    headers=headers,
                    params=params,
                    timeout=DatasetFileDocument._REQUEST_TIMEOUT,
                )
        except requests.exceptions.RequestException:
            return None  # endpoint not reachable → fall back to manifest
        if resp.status_code != 200:
            return None  # endpoint not deployed (404) → fall back to manifest
        try:
            files = resp.json().get("files")
        except ValueError:
            return None
        return files or None

    def _list_from_manifest(self) -> list:
        """Fallback: read a ``texera_manifest.json`` in the folder listing its files."""
        manifest_path = self._folder_logical_path() + "/texera_manifest.json"
        try:
            buf = DatasetFileDocument(manifest_path).read_file()
        except RuntimeError as e:
            raise RuntimeError(
                "Could not list the model folder: the file-service 'list-files' "
                "endpoint is unavailable and no 'texera_manifest.json' with a "
                f"'files' list was found in the folder. Underlying error: {e}"
            ) from e
        files = json.load(buf).get("files")
        if not files:
            raise RuntimeError(
                "texera_manifest.json is missing a non-empty 'files' list."
            )
        # manifest lists paths relative to the folder → make version-root-relative
        prefix = f"{self.subfolder}/" if self.subfolder else ""
        return [f"{prefix}{f}" for f in files]

    # ---- materialization ------------------------------------------------------

    def download(self) -> str:
        """Downloads every file to a local dir (cached by version) and returns its path."""
        target = self.cache_root.joinpath(
            self.owner_email, self.name, self.version, self.subfolder
        )
        complete_marker = target / ".texera_complete"
        if complete_marker.exists():
            return str(target)

        target.mkdir(parents=True, exist_ok=True)
        version_root_prefix = f"{self.subfolder}/" if self.subfolder else ""
        for rel in self.list_files():
            # `rel` is version-root-relative; mirror it under `target` relative to subfolder
            local_rel = rel[len(version_root_prefix):] if (
                version_root_prefix and rel.startswith(version_root_prefix)
            ) else rel
            dest = target / local_rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            self._download_one(f"{self._version_prefix()}/{rel}", dest)

        complete_marker.write_text("ok")
        return str(target)

    def _download_one(self, logical_path: str, dest: Path) -> None:
        """Streams one file to disk via its presigned URL (atomic per-file rename)."""
        url = DatasetFileDocument(logical_path).get_presigned_url()
        tmp = dest.with_name(dest.name + ".part")
        try:
            with DatasetFileDocument._retry_session() as session:
                with session.get(
                    url, stream=True, timeout=DatasetFileDocument._REQUEST_TIMEOUT
                ) as resp:
                    if resp.status_code != 200:
                        raise RuntimeError(
                            f"Failed to download '{logical_path}': "
                            f"{resp.status_code} {resp.text[:200]}"
                        )
                    with open(tmp, "wb") as f:
                        for chunk in resp.iter_content(self._CHUNK_BYTES):
                            if chunk:
                                f.write(chunk)
            tmp.replace(dest)
        finally:
            if tmp.exists():
                tmp.unlink()
