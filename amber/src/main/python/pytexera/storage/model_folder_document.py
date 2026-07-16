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
import shutil
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path

import requests

from .dataset_file_document import DatasetFileDocument

try:
    import fcntl  # POSIX only; present in the Linux worker (and macOS dev)
except ImportError:  # pragma: no cover
    fcntl = None


class ModelFolderDocument:
    """Materializes a whole model *version* (a folder of files) onto local disk so a
    loader that opens sibling files by real path (TF SavedModel, ONNX external-data,
    transformers ``from_pretrained``, sharded checkpoints, ...) can read them.

    Strategy (benchmark-backed): **parallel download + a shared, per-version cache**.

    * **A2 — parallel fetch.** Many small files are downloaded concurrently (cross-file
      fan-out); a single large file is downloaded with concurrent **byte-ranges**
      (within-file). Everything streams to disk (never fully into memory) so an
      LLM's tens-of-GB never blow worker RAM.
    * **A5 — shared cache.** ``TEXERA_MODEL_CACHE_DIR`` should point at a volume shared
      by all worker pods (ReadWriteMany: NFS/EFS/CephFS). Since a version is immutable,
      the cache is keyed by ``owner/name/version`` — first run in the cluster downloads,
      every run after (any pod) is instant. A **cross-process lock** stops concurrent
      cold starts from double-downloading, and **content-addressed dedup** (a ``.blobs``
      store keyed by checksum, hard-linked into each version) stores identical files
      once across versions.

    Usage in a Python UDF::

        from pytexera.storage import ModelFolderDocument
        model_dir = ModelFolderDocument("/models/alice@x.com/my-model/v1").download()
        model = from_pretrained(model_dir)

    Tunables (env): ``TEXERA_MODEL_CACHE_DIR`` (shared cache root),
    ``TEXERA_MODEL_DOWNLOAD_CONCURRENCY`` (default 16),
    ``TEXERA_MODEL_RANGE_THRESHOLD_MB`` (default 256 — files bigger use byte-ranges),
    ``TEXERA_MODEL_RANGE_CHUNK_MB`` (default 32).
    """

    _CHUNK_BYTES = 8 << 20  # 8 MiB streaming chunks

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
        # Always materialize the WHOLE version (the picker may hand back a file inside it).
        self.subfolder = ""

        self.jwt_token = os.getenv("USER_JWT_TOKEN")
        presign = os.getenv("FILE_SERVICE_GET_PRESIGNED_URL_ENDPOINT") or (
            "http://localhost:9092/api/dataset/presign-download"
        )
        base = presign.rsplit("/", 1)[0]  # ".../api/dataset"
        self.list_endpoint = f"{base}/list-files"
        self.public_list_endpoint = f"{base}/public-list-files"

        self.cache_root = Path(os.getenv("TEXERA_MODEL_CACHE_DIR", "/tmp/texera-models"))
        self._concurrency = max(1, int(os.getenv("TEXERA_MODEL_DOWNLOAD_CONCURRENCY", "16")))
        self._range_threshold = int(os.getenv("TEXERA_MODEL_RANGE_THRESHOLD_MB", "256")) << 20
        self._range_chunk = max(1, int(os.getenv("TEXERA_MODEL_RANGE_CHUNK_MB", "32"))) << 20

    # ---- enumeration ----------------------------------------------------------

    def _version_prefix(self) -> str:
        return f"/{self.owner_email}/{self.name}/{self.version}"

    def _folder_logical_path(self) -> str:
        return self._version_prefix() + (f"/{self.subfolder}" if self.subfolder else "")

    def list_files(self):
        """Raw file list from the endpoint (list of str or {path,checksum,size}) or manifest."""
        files = self._list_from_endpoint()
        if files is not None:
            return files
        return self._list_from_manifest()

    def _normalized_files(self):
        """Returns [{path, checksum, size}] (version-root-relative), normalizing both the
        newer endpoint shape ({path,checksum,size}) and the older/manifest shape (str)."""
        prefix = f"{self.subfolder}/" if self.subfolder else ""
        out = []
        for entry in self.list_files():
            if isinstance(entry, dict):
                path, checksum, size = entry.get("path"), entry.get("checksum"), entry.get("size")
            else:
                path, checksum, size = entry, None, None
            if path is None:
                continue
            out.append({
                "path": f"{prefix}{path}" if not path.startswith(prefix) else path,
                "checksum": checksum,
                "size": int(size) if size is not None else None,
            })
        return out

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
                resp = session.get(endpoint, headers=headers, params=params,
                                   timeout=DatasetFileDocument._REQUEST_TIMEOUT)
        except requests.exceptions.RequestException:
            return None  # endpoint unreachable → fall back to manifest
        if resp.status_code != 200:
            return None
        try:
            files = resp.json().get("files")
        except ValueError:
            return None
        return files or None

    def _list_from_manifest(self):
        manifest_path = self._folder_logical_path() + "/texera_manifest.json"
        try:
            buf = DatasetFileDocument(manifest_path).read_file()
        except RuntimeError as e:
            raise RuntimeError(
                "Could not list the model folder: the file-service 'list-files' endpoint "
                "is unavailable and no 'texera_manifest.json' with a 'files' list was found. "
                f"Underlying error: {e}"
            ) from e
        files = json.load(buf).get("files")
        if not files:
            raise RuntimeError("texera_manifest.json is missing a non-empty 'files' list.")
        return files

    # ---- materialization (A2 parallel + A5 cache/lock/dedup) -------------------

    def download(self) -> str:
        """Materialize the whole version into a local dir (cached, deduped) and return it."""
        target = self.cache_root.joinpath(self.owner_email, self.name, self.version, self.subfolder)
        complete = target / ".texera_complete"
        if complete.exists():
            return str(target)  # fast path — no lock needed for a finished version

        # A5: one downloader per version across all pods sharing the cache volume.
        with self._version_lock():
            if complete.exists():  # another worker finished while we waited
                return str(target)
            target.mkdir(parents=True, exist_ok=True)
            files = self._normalized_files()
            big = [f for f in files if (f["size"] or 0) > self._range_threshold]
            small = [f for f in files if f not in big]

            # Phase 1: big files — each with concurrent byte-ranges (within-file parallelism).
            for f in big:
                self._materialize(f, target, ranged=True)

            # Phase 2: small files — concurrent across files (cross-file parallelism).
            if small:
                errors = []
                with ThreadPoolExecutor(max_workers=self._concurrency) as ex:
                    futs = {ex.submit(self._materialize, f, target, False): f for f in small}
                    for fut in as_completed(futs):
                        try:
                            fut.result()
                        except Exception as e:  # noqa: BLE001
                            errors.append((futs[fut]["path"], repr(e)))
                if errors:
                    raise RuntimeError(
                        f"Failed to download {len(errors)} file(s); first: {errors[0]}"
                    )

            complete.write_text("ok")
        return str(target)

    def _materialize(self, f, target: Path, ranged: bool) -> None:
        """Place one file into `target`, using the dedup blob store when a checksum is known."""
        rel, checksum, size = f["path"], f["checksum"], f["size"]
        prefix = f"{self.subfolder}/" if self.subfolder else ""
        local_rel = rel[len(prefix):] if (prefix and rel.startswith(prefix)) else rel
        dest = target / local_rel
        if dest.exists() and (size is None or dest.stat().st_size == size):
            return  # already present (resume / partial cache)
        dest.parent.mkdir(parents=True, exist_ok=True)
        logical = f"{self._version_prefix()}/{rel}"

        if checksum:
            blob = self._blobs_dir() / checksum
            if not blob.exists():
                blob.parent.mkdir(parents=True, exist_ok=True)
                self._download_to(logical, blob, size, ranged)
            self._link_or_copy(blob, dest)  # dedup: same bytes stored once, hard-linked
        else:
            self._download_to(logical, dest, size, ranged)

    def _download_to(self, logical_path: str, out_path: Path, size, ranged: bool) -> None:
        url = DatasetFileDocument(logical_path).get_presigned_url()
        if ranged and size and size > self._range_threshold:
            self._ranged_download(url, out_path, size)
        else:
            self._stream_download(url, out_path, logical_path)

    def _stream_download(self, url: str, out_path: Path, logical_path: str) -> None:
        tmp = out_path.with_name(out_path.name + ".part")
        try:
            with DatasetFileDocument._retry_session() as session:
                with session.get(url, stream=True,
                                 timeout=DatasetFileDocument._REQUEST_TIMEOUT) as r:
                    if r.status_code != 200:
                        raise RuntimeError(
                            f"Failed to download '{logical_path}': {r.status_code} {r.text[:200]}"
                        )
                    with open(tmp, "wb") as fh:
                        for chunk in r.iter_content(self._CHUNK_BYTES):
                            if chunk:
                                fh.write(chunk)
            tmp.replace(out_path)
        finally:
            if tmp.exists():
                tmp.unlink()

    def _ranged_download(self, url: str, out_path: Path, size: int) -> None:
        """Download one big file with concurrent byte-range GETs (thread-safe os.pwrite)."""
        tmp = out_path.with_name(out_path.name + ".part")
        fd = os.open(str(tmp), os.O_CREAT | os.O_WRONLY, 0o644)
        try:
            os.ftruncate(fd, size)
            ranges = [(s, min(s + self._range_chunk, size) - 1)
                      for s in range(0, size, self._range_chunk)]

            def fetch(rng):
                start, end = rng
                with DatasetFileDocument._retry_session() as sess:
                    with sess.get(url, headers={"Range": f"bytes={start}-{end}"}, stream=True,
                                  timeout=DatasetFileDocument._REQUEST_TIMEOUT) as r:
                        if r.status_code not in (200, 206):
                            raise RuntimeError(f"range {start}-{end} -> {r.status_code}")
                        off = start
                        for chunk in r.iter_content(self._CHUNK_BYTES):
                            if chunk:
                                os.pwrite(fd, chunk, off)  # positional, thread-safe
                                off += len(chunk)

            errors = []
            with ThreadPoolExecutor(max_workers=self._concurrency) as ex:
                for fut in as_completed([ex.submit(fetch, r) for r in ranges]):
                    try:
                        fut.result()
                    except Exception as e:  # noqa: BLE001
                        errors.append(e)
            if errors:
                raise RuntimeError(f"ranged download of {out_path.name} failed: {errors[0]}")
        finally:
            os.close(fd)
        tmp.replace(out_path)

    # ---- helpers --------------------------------------------------------------

    def _blobs_dir(self) -> Path:
        return self.cache_root / ".blobs"

    @staticmethod
    def _link_or_copy(blob: Path, dest: Path) -> None:
        if dest.exists():
            dest.unlink()
        try:
            os.link(blob, dest)  # hard link — no extra bytes on the same volume
        except OSError:
            shutil.copy2(blob, dest)  # cross-device fallback

    @contextmanager
    def _version_lock(self):
        """Exclusive per-version lock (flock auto-releases if the holder crashes)."""
        if fcntl is None:
            yield
            return
        locks = self.cache_root / ".locks"
        locks.mkdir(parents=True, exist_ok=True)
        key = f"{self.owner_email}__{self.name}__{self.version}__{self.subfolder}".replace("/", "_")
        fd = os.open(str(locks / f"{key}.lock"), os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
