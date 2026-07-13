# ML-Model-in-UDF Prototype — All the Code in One Place

_Everything the prototype adds, in one file. Committed on `proto/ml-model-ux` (`2f1cd6576`).
Two lanes: a **single-file** model (`texera_model`, loaded in memory) and a **folder** model
(`texera_model_dir`, materialized to disk) — the latter covers multi-file, sharded, and real
HF/LLM models._

Contents:
1. Backend · Python — `ModelFolderDocument` + exports
2. Backend · Scala — UDF picker + injection, and the file-service `list-files` endpoint
3. Frontend — the picker wiring
4. The 3 model types — how you use each in a UDF
5. Sample-model generators (to reproduce the demos)

---

## 1 · Backend — Python

### `amber/src/main/python/pytexera/storage/model_folder_document.py` (new)

```python
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

    Generalizes ``DatasetFileDocument`` (single file -> in-memory ``BytesIO``) to a
    folder: it enumerates the version's files, then streams each one **to disk**
    (never fully into memory), preserving the relative directory structure. Downloads
    are cached by version so a second run reuses them.
    """

    _CHUNK_BYTES = 1 << 20  # 1 MiB streaming chunks (stream to disk, not memory)

    def __init__(self, folder_path: str):
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
        # The picker hands back a path that may point at a single file *inside* the
        # model version; we always materialize the WHOLE version so the loader sees
        # every sibling file. Anything after owner/name/version is ignored.
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
            return None  # endpoint not reachable -> fall back to manifest
        if resp.status_code != 200:
            return None  # endpoint not deployed (404) -> fall back to manifest
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
```

### Exports

`amber/src/main/python/pytexera/storage/__init__.py`
```python
from .dataset_file_document import DatasetFileDocument
from .model_folder_document import ModelFolderDocument

__all__ = ["DatasetFileDocument", "ModelFolderDocument"]
```

`amber/src/main/python/pytexera/__init__.py` — add the import and the `__all__` entry:
```python
from .storage.model_folder_document import ModelFolderDocument
# ...
    "ModelFolderDocument",
```

---

## 2 · Backend — Scala

### UDF picker + code injection
`common/workflow-operator/.../operator/udf/python/PythonUDFOpDescV2.scala`

Two picker properties:
```scala
  @JsonProperty
  @JsonSchemaTitle("Model")
  @JsonPropertyDescription(
      "Optional: select an uploaded single-file model (.pt). Texera fetches it automatically and " +
      "exposes it to your code as `texera_model` (a loaded TorchScript model) — no loading code needed."
  )
  var modelPath: String = ""

  @JsonProperty
  @JsonSchemaTitle("Model folder")
  @JsonPropertyDescription(
    "Optional: for a multi-file / sharded model (e.g. an LLM), select ANY file inside the model " +
      "version. Texera downloads the WHOLE version to a local directory and exposes its path as " +
      "`texera_model_dir` — load it with your framework, e.g. " +
      "torch.jit.load(f'{texera_model_dir}/model.pt') or from_pretrained(texera_model_dir)."
  )
  var modelFolderPath: String = ""
```

The injection at the top of `getPhysicalOp` (builds the preamble prepended to the user's code):
```scala
    def escapePy(s: String): String = s.trim.replace("\\", "\\\\").replace("\"", "\\\"")
    val modelPreamble = new StringBuilder
    if (modelFolderPath != null && modelFolderPath.trim.nonEmpty) {
      modelPreamble.append(
        s"""# Auto-injected by the Texera model-folder picker: downloads the whole model version
           |# to a local directory and exposes its path as `texera_model_dir`.
           |from pytexera.storage import ModelFolderDocument as _texera_mfd
           |texera_model_dir = _texera_mfd("${escapePy(modelFolderPath)}").download()
           |
           |""".stripMargin
      )
    }
    if (modelPath != null && modelPath.trim.nonEmpty) {
      modelPreamble.append(
        s"""# Auto-injected by the Texera model picker: fetches and loads the selected model.
           |from pytexera.storage import DatasetFileDocument as _texera_dfd
           |import torch as _texera_torch
           |texera_model = _texera_torch.jit.load(_texera_dfd("${escapePy(modelPath)}").read_file())
           |texera_model.eval()
           |
           |""".stripMargin
      )
    }
    val effectiveCode = modelPreamble.toString + code
```
(`effectiveCode` is then passed to `OpExecWithCode(effectiveCode, "python")` in place of `code`.)

### File-service `list-files` endpoint
`file-service/.../service/resource/DatasetResource.scala`

The two routes (auth + public):
```scala
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Path("/list-files")
  def listVersionFiles(
      @QueryParam("filePath") encodedUrl: String,
      @Auth user: SessionUser
  ): Response = {
    generateListFilesResponse(encodedUrl, user.getUid)
  }

  @GET
  @PermitAll
  @Path("/public-list-files")
  def listPublicVersionFiles(
      @QueryParam("filePath") encodedUrl: String
  ): Response = {
    generateListFilesResponse(encodedUrl, null)
  }
```

The resolver helper:
```scala
  private def generateListFilesResponse(encodedUrl: String, uid: Integer): Response = {
    val decodedPath = URLDecoder.decode(encodedUrl, StandardCharsets.UTF_8.name())
    val rawParts = decodedPath.stripPrefix("/").split("/").toList
    val parts =
      if (rawParts.headOption.exists(p => p == "datasets" || p == "models")) rawParts.drop(1)
      else rawParts
    if (parts.length < 3) {
      return Response
        .status(Response.Status.BAD_REQUEST)
        .entity("Expected path: /ownerEmail/datasetName/versionName[/subfolder]")
        .build()
    }
    val ownerEmail = parts.head
    val datasetName = parts(1)
    val versionName = parts(2)
    val subfolder = parts.drop(3).mkString("/")

    withTransaction(context) { ctx =>
      val dataset = getDatasetBy(ownerEmail, datasetName)
      if (!userHasReadAccess(ctx, dataset.getDid, uid)) {
        throw new ForbiddenException(ERR_USER_HAS_NO_ACCESS_TO_DATASET_MESSAGE)
      }
      val versionHash = ctx
        .select(DATASET_VERSION.VERSION_HASH)
        .from(DATASET_VERSION)
        .where(DATASET_VERSION.DID.eq(dataset.getDid))
        .and(DATASET_VERSION.NAME.eq(versionName))
        .fetchOne(DATASET_VERSION.VERSION_HASH)
      if (versionHash == null) {
        throw new NotFoundException(ERR_DATASET_VERSION_NOT_FOUND_MESSAGE)
      }

      val objects = withLakeFSErrorHandling(
        s"listing files of version '$versionName' of dataset '$datasetName'"
      ) {
        LakeFSStorageClient.retrieveObjectsOfVersion(dataset.getRepositoryName, versionHash)
      }
      val prefix = if (subfolder.isEmpty) "" else subfolder + "/"
      val files = objects
        .map(_.getPath)
        .filter(p => prefix.isEmpty || p == subfolder || p.startsWith(prefix))
      Response.ok(Map("files" -> files)).build()
    }
  }
```

---

## 3 · Frontend

`frontend/.../operator-property-edit-frame/operator-property-edit-frame.component.ts`
```typescript
// the Model field on ML operators reuses the dataset file picker to select a model file
if (mappedField.key === "modelPath") {
  mappedField.type = "inputautocomplete";
}

// the Model folder field selects a whole model version (folder) to materialize on the worker
if (mappedField.key === "modelFolderPath") {
  mappedField.type = "inputautocomplete";
}
```

---

## 4 · The 3 model types — how you use each in a UDF

### Type A — single self-contained file (in-memory)
Pick it in the **Model** field → `texera_model` is auto-loaded.
```python
from pytexera import *
import torch

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        cols = ["sepal_length", "sepal_width", "petal_length", "petal_width"]
        x = torch.tensor([[float(tuple_[c]) for c in cols]])
        tuple_["prediction"] = str(int(texera_model(x).argmax(1).item()))
        yield tuple_
```

### Type B — a folder of files (materialized to disk)
Pick any file in the **Model folder** field → `texera_model_dir` (local path).
```python
from pytexera import *
import torch, json

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def open(self):
        self.model = torch.jit.load(f"{texera_model_dir}/model.pt")
        self.model.eval()
        self.labels = json.load(open(f"{texera_model_dir}/labels.json"))  # a SIBLING file
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        cols = ["sepal_length", "sepal_width", "petal_length", "petal_width"]
        x = torch.tensor([[float(tuple_[c]) for c in cols]])
        tuple_["prediction"] = self.labels[int(self.model(x).argmax(1).item())]
        yield tuple_
```

### Type C — sharded / real LLM (loader opens all files internally)
Pick any file in the **Model folder** field → `texera_model_dir`; the library reads the index +
every shard itself.
```python
from pytexera import *
from transformers import pipeline

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def open(self):
        # from_pretrained opens config.json + tokenizer files + every weight shard internally
        self.clf = pipeline("sentiment-analysis", model=texera_model_dir, tokenizer=texera_model_dir)
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["sentiment"] = self.clf(str(tuple_["text"]))[0]["label"]
        yield tuple_
```
*(worker env needs `transformers`; declare the extra output column, e.g. `sentiment : string`.)*

---

## 5 · Sample-model generators (to reproduce the demos)

### Single-file + simple folder — `gen_sample_models.py`
```python
import json
from pathlib import Path
import torch
import torch.nn as nn

OUT = Path.home() / "Downloads" / "texera_sample_models"
OUT.mkdir(parents=True, exist_ok=True)

class IrisNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(4, 16), nn.ReLU(), nn.Linear(16, 3))
    def forward(self, x):
        return self.net(x)

m = IrisNet().eval()

# 1) SINGLE-FILE: self-contained TorchScript (loads with NO user code)
torch.jit.script(m).save(str(OUT / "iris_classifier.pt"))

# 2) FOLDER: self-contained model + sibling files the loader must read together
folder = OUT / "iris_folder_model"; folder.mkdir(exist_ok=True)
torch.jit.script(m).save(str(folder / "model.pt"))
json.dump(["setosa", "versicolor", "virginica"], open(folder / "labels.json", "w"))
json.dump({"files": ["model.pt", "labels.json", "texera_manifest.json"]},
          open(folder / "texera_manifest.json", "w"))
```

### Sharded PyTorch `.bin` model (real LLM shape) — `gen_sharded_pt_model.py`
```python
from pathlib import Path
from transformers import AutoModelForSequenceClassification, AutoTokenizer

SRC = Path.home() / "Downloads" / "texera_sample_models" / "sst2_distilbert"
DST = Path.home() / "Downloads" / "texera_sample_models" / "sst2_sharded_pt"
DST.mkdir(parents=True, exist_ok=True)

model = AutoModelForSequenceClassification.from_pretrained(SRC)
tok = AutoTokenizer.from_pretrained(SRC)
# force many .bin shards + an index (safe_serialization=False -> .bin, not safetensors)
model.save_pretrained(DST, max_shard_size="100MB", safe_serialization=False)
tok.save_pretrained(DST)
```

### Download a real HF model — `download_hf_model.py`
```python
import shutil
from pathlib import Path
from huggingface_hub import snapshot_download

MODEL = "distilbert-base-uncased-finetuned-sst-2-english"
dest = Path.home() / "Downloads" / "texera_sample_models" / "sst2_distilbert"
if dest.exists():
    shutil.rmtree(dest)
snapshot_download(
    MODEL, local_dir=str(dest),
    allow_patterns=["config.json", "*.txt", "tokenizer*.json", "*.safetensors"],
    token=False,  # public model; bypass any expired stored token
)
# upload config.json + model.safetensors + tokenizer_config.json + vocab.txt as one model version
```

---

## Environment notes (already applied to the live dev DB)
- `dataset.type` column added (needed for the branch to compile; JOOQ regenerated).
- `single_file_upload_max_size_mib` raised 20 → 1024 in `site_settings` (for the 268 MB HF model).
- The `transformers` library must be present in the worker's Python env for Type C.
