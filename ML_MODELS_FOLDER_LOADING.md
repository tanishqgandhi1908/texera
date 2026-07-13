# Question 2 — Loading a Model *Folder* in a Python UDF (path resolution)

_How does a Python UDF load a model that is a **folder of files**, when the LakeFS→bytes mapping
lives at the Texera level (not inside the worker process), and the loader opens sibling files by
ordinary local paths? What do others do, and what should Texera do?_

Backed by: a Texera code audit + a research pass (search/fetch/verify completed — **139 claims
confirmed, 14 refuted**; only the final auto-summary crashed, so this is hand-synthesized from the
verified claims).

---

## The answer in one line

**Materialize the whole model version into a local temp directory (preserving relative paths),
cached per version, then hand the loader the local folder path.** This is what Hugging Face, MLflow,
and DVC all do — and it's the only approach that works with the loaders that matter, because most of
them *require a real local directory*.

---

## Why: the decisive fact — most model loaders need a real local folder

The whole question turns on one thing: does the loader accept an in-memory handle, or does it insist
on opening real files by path? Verified, per loader:

| Loader | Accepts bytes / file-like? | Needs a real local folder? |
|---|---|---|
| `torch.load` (state_dict / full) | ✅ `io.BytesIO`, `map_location` | ❌ (single file) |
| `torch.jit.load` (TorchScript) | ✅ file-like | ❌ (single file) |
| `safetensors.torch.load(bytes)` | ✅ in-memory bytes (CPU only) | ❌ (single file) |
| `safetensors.torch.load_file(path)` | ❌ needs a real path (uses **mmap**) | ✅ |
| `transformers from_pretrained` | ❌ opens sibling `config.json` / tokenizer by relative path | ✅ local dir (or a Hub id) |
| `tf.saved_model.load(dir)` | ❌ takes a **directory** only | ✅ |
| `onnx.load` (with external data) | ❌ external weight files must sit in the **same dir** | ✅ |

**Takeaway:** a *single self-contained file* (TorchScript, one safetensors, one ONNX) can be streamed
from bytes with no temp file. But a **folder-of-files model** — TF SavedModel, ONNX+external-data,
HF-style `config.json`+weights+tokenizer, safetensors via `load_file` — needs a **real local
directory** with all siblings present. You cannot intercept those relative `open()` calls from
outside the process. Hence: materialize.

## How the others solve it (all converge on materialize-to-local)

- **Hugging Face `snapshot_download`** — eager full-folder download into a local dir that **preserves
  each file's relative path**, returns the local path. Cache **keyed by commit revision** (immutable),
  content-addressed dedup (identical files stored once across versions), **parallel downloads** (8
  threads), completeness-validated before reuse, and **partial download** via
  `allow_patterns`/`ignore_patterns`.
- **MLflow `download_artifacts`** — returns **only a local filesystem path**; no fsspec/lazy option.
  "MLflow's answer to intra-folder resolution is materialization, not virtual-filesystem
  interception." Materializes into a fresh uniquely-named local dir.
- **DVC `pull`** — cache-first: download to a local cache, then link into the workspace (reflinks/
  hardlinks to avoid copying bytes); supports partial/targeted materialization.
- **Dataiku managed folders** — local-backed = a real path; cloud-backed = streaming (the split shows
  exactly where "real local path" stops being free).

### The two alternatives, and why they lose here
- **FUSE / mount** (make remote look local, lazy per-file fetch): **lakeFS Mount is Enterprise-only
  (not available to us).** DIY options against MinIO — `mountpoint-s3`, `s3fs-fuse`, `goofys` — add
  an operational moving part, and **`mountpoint-s3` has no data cache by default → ~20× slower on
  many small files** (87s vs 4.3s for 1000 small files) and is sequential-write-only. Models are
  often many small files, so a mount is the *worst* fit unless the model is one huge weight file.
- **fsspec** (hand the loader a filesystem object/URL instead of a path): there *is* a
  `LakeFSFileSystem` fsspec implementation, and some loaders use fsspec (PyTorch Lightning loads a
  checkpoint from a remote URL). **But it only helps if the loader supports fsspec** — and the
  folder-loaders above (TF SavedModel, ONNX external-data, `from_pretrained` sibling reads,
  `load_file`) do **not**. So fsspec covers the single-file cases, not the folder case.

---

## What Texera has today (from the code audit)

| Piece | Status |
|---|---|
| Read a **single** file from a UDF (`DatasetFileDocument`) | ✅ exists — presign endpoint + JWT, returns **in-memory `BytesIO`** (never writes to disk) |
| List all files in a version | ✅ in Scala (`retrieveObjectsOfVersion(repo, commit)`) — ❌ **not reachable from Python** (only a hierarchical UI tree endpoint exists) |
| Download a whole folder to a local dir | ❌ missing (Scala can stream a ZIP; nothing materializes locally) |
| Worker temp/cache convention | ⚠️ `/tmp` available, no model-cache pattern |
| Model-loading framework | ❌ not implemented (design docs only) |

So today a UDF can only pull **one file into memory** — there's no way to enumerate a folder from
Python and no local materialization. That's the gap.

## Recommendation for Texera (OSS LakeFS, presigned-URL fetch)

**Generalize the existing single-file presign fetch into a per-version folder materializer.**

```
UDF asks for model  /models/alice/net/v1
        │
  1. ENUMERATE files in the version
     (new flat-list file-service endpoint, backed by the existing
      Scala retrieveObjectsOfVersion(repo, commitHash))
        │
  2. MATERIALIZE — for each file: presign + HTTP GET (existing mechanism)
     → write to  <cache>/<commitHash>/<relative/path>   (preserve structure)
     → parallelize (thread pool, like HF's 8 workers)
        │
  3. CACHE keyed by COMMIT HASH (immutable version) — reuse if present & complete;
     model versions never change, so the cache is always valid
        │
  4. HAND THE LOADER the local root dir  →  torch.jit.load / from_pretrained /
     tf.saved_model.load / onnx.load all work (siblings are real local files)
```

**Concrete build list:**
1. **One new file-service endpoint** — a *flat* file list for a version (e.g.
   `GET /dataset/{did}/version/{dvid}/files` → `[relativePath, size]`), backed by
   `retrieveObjectsOfVersion`. (Reuses existing auth + LakeFS listing.)
2. **A Python `download_model_folder(logical_path) -> local_dir`** helper in `pytexera` — enumerate
   → loop the existing presign+GET per file → write under a cache dir preserving relative paths →
   return the root. Download to a temp path then atomic-rename per file so partial failures don't
   corrupt the cache.
3. **Cache** at e.g. `/tmp/texera-models/<commitHash>/`, validated by file count/stat; evict by
   size/LRU or on pod teardown.
4. The shared model-load step reads the manifest and calls the right loader on the local dir.

**Two optimizations worth noting:**
- **Single self-contained file → skip materialization.** If the model is one file (TorchScript, a
  lone safetensors, a lone ONNX), stream its bytes and load in memory
  (`torch.jit.load(BytesIO)` / `torch.load(BytesIO)` / `safetensors.torch.load(bytes)`). Only
  *folders* need the temp dir. (One more reason self-contained formats are the easy path.)
- **Partial fetch** — if the manifest names the entry file + needed siblings, use HF-style
  allow-patterns to fetch only those; default to fetching all for correctness.

**When is a FUSE mount actually worth it?** Only for very large *single-weight-file* models where
lazy byte-range streaming beats a full download — and even then, OSS lakeFS has no Mount, so you'd
run `mountpoint-s3` against MinIO (extra ops), which is fine for a few big files but poor for the
many-small-files case models usually are. **Default to materialization; revisit FUSE only if huge
models become common.**

---

## Multi-file / sharded models (e.g. LLMs) — the case that makes this mandatory

Large models (LLMs especially) ship as **sharded checkpoints**: a small **index file**
(`model.safetensors.index.json` or `pytorch_model.bin.index.json`) whose `weight_map` maps each
tensor to a shard file, plus many weight shards (default max **5 GB** each), plus `config.json` and
tokenizer files. `from_pretrained` reads the index, then **opens each shard by its relative
filename**. ([HF docs](https://huggingface.co/docs/transformers/en/models))

```
llm-model/v1/
├── model.safetensors.index.json      ← map: tensor → shard
├── model-00001-of-00008.safetensors  ← shard 1 (~5 GB)
│      … 8 shards …
├── config.json · tokenizer.json
```

**This does NOT break the path mapping** — the logical-path→LakeFS mapping is per-file and keeps
working. It *would* break a naive "stream one file into memory" load (the index's shard references
have nowhere to resolve). Full-folder materialization handles it — but the sharded case adds **three
hard requirements**:

1. **Materialize the ENTIRE version** (all shards) — never skip files for a sharded model.
2. **Preserve exact filenames + relative structure** — the index references shards by name.
3. **Stream each file to DISK, not memory** — LLMs are tens of GB; the current single-file reader
   returns in-memory `BytesIO`, which would exhaust worker RAM on big shards. The folder-materializer
   must write straight to disk, and handle disk limits / caching / cleanup for large models.

## The 30-second version

> "A model folder can't be streamed file-by-file, because loaders like TensorFlow SavedModel, ONNX,
> and HuggingFace open sibling files by real local paths — you can't intercept that from outside the
> process. So everyone (Hugging Face, MLflow, DVC) does the same thing: download the whole version
> into a local temp folder, cached by version, then load from there. Texera should generalize its
> existing single-file presigned fetch into a per-version folder download + cache. Single
> self-contained files can skip this and stream in memory; only multi-file folders need
> materializing. A FUSE mount isn't worth it — and lakeFS Mount is Enterprise-only anyway."
