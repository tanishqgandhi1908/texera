# Option B prototype — lazy mount instead of download (branch `proto/ml-model-mount`)

This branch prototypes **Option B** from [ML_MODELS_SCALABLE_LOADING.md](ML_MODELS_SCALABLE_LOADING.md):
instead of downloading a whole model version to the pod's local disk (Option A, on
`proto/ml-model-ux`), the model version is exposed as a **read-only FUSE mount** and files are fetched
**lazily on read**. Same UDF code, same picker — only where the bytes come from changes.

## The only code change
`amber/src/main/python/pytexera/storage/model_folder_document.py` — `download()` now checks
`TEXERA_MODEL_MOUNT_ROOT`. If set and `<root>/<owner>/<name>/<version>/` is a populated mount, it
returns that path directly (no download); otherwise it falls back to the normal download (Option A).
No Scala / operator change — the injected `ModelFolderDocument(...).download()` is unchanged, so the
two approaches are directly comparable.

## How the mount is provisioned (the CSI-driver equivalent, done by ops, not the UDF)
lakeFS OSS ships an **S3 Gateway** (S3-compatible, path style `s3://<repo>/<ref>/<path>`). We mount a
specific **immutable version** (`repo = dataset-{did}`, `ref = version_hash`) with a generic S3 FUSE
tool. In production this is the `mountpoint-s3` CSI driver; locally the prototype uses `rclone mount`:

```
# rclone remote (points at the lakeFS S3 gateway, path-style)
[lakefs]
type = s3
provider = Other
access_key_id = <lakefs key>
secret_access_key = <lakefs secret>
endpoint = http://localhost:8000
force_path_style = true

# mount ONE model version, read-only, lazy VFS cache, at the logical path:
rclone mount "lakefs:dataset-1/<version_hash>" \
  "$TEXERA_MODEL_MOUNT_ROOT/<owner>/<name>/<version>" \
  --read-only --vfs-cache-mode full --daemon
```

Then launch the backend with `TEXERA_MODEL_MOUNT_ROOT=<mount root>` exported (the Python worker
inherits it from the ComputingUnitMaster/Worker JVM).

Note: lakeFS lists **branches** (e.g. `main`) as pseudo-directories but not arbitrary commit IDs, so
you mount at the *version prefix* (`repo/<commit>`) rather than navigating to it — which is exactly the
per-version-volume model a CSI driver uses.

## Verified (sanity test)
- Before load, the VFS cache was empty; after `transformers.pipeline(model=mount_path)` it held **only
  the files the loader read** (~18 MB), no whole-folder pre-download.
- `ModelFolderDocument("/models/texera/tiny-sentiment/v1 - initial").download()` returns the mount path
  and logs `MOUNT mode: … (no download)`; the pipeline loads and predicts correctly.

## Comparing A vs B
| | Branch | What `download()` does | Local disk footprint |
|---|---|---|---|
| **Option A** | `proto/ml-model-ux` | streams every file to `/tmp/texera-models/<version>/` | whole folder, per pod |
| **Option B** | `proto/ml-model-mount` | returns the mount path; FUSE fetches on read | only files actually read, node-shared, evictable |

Watch the worker log line to see which path ran: `MOUNT mode: … (no download)` (B) vs the per-file
download loop (A). Unset `TEXERA_MODEL_MOUNT_ROOT` on this branch to fall back to Option A behavior.

## Verified on Kubernetes (kind) — the production shape

Ran a real single-node k8s cluster (`kind`) with the model exposed to a pod as a mounted volume,
proving the mechanism the production `workflow-computing-unit-manager` would use.

**Pod = two containers** (`bin/k8s`-style computing-unit pod):
- `mounter` (privileged, `/dev/fuse`) — FUSE-mounts `lakefs:dataset-1/<commit>` (the lakeFS **S3
  gateway**, reachable from pods once the node is on the `texera-lakefs` docker network) at a shared
  volume. **This is the role a CSI driver plays in production** (`mountpoint-s3` / `csi-s3`).
- `app` (plain busybox, unprivileged, no S3 client) — reads `/models/tiny-sentiment/*` through the
  shared volume, oblivious that bytes come from lakeFS/MinIO. It read `config.json` and the 17.5 MB
  `model.safetensors` on demand.

**Mapping demo → production:**

| Demo piece | Production equivalent |
|---|---|
| `mounter` container running rclone | **CSI driver** (`mountpoint-s3` CSI, or `csi-s3`) mounting the volume into the pod |
| shared emptyDir + mount propagation | the CSI **PV/PVC** attached to the computing-unit pod |
| `app` container reads `/models/...` | the **computing-unit (worker) pod** running the Python UDF |
| lakeFS S3 gateway on `:8000` | same — OSS gateway exposes `s3://<repo>/<ref>/<path>` |
| I set the pod spec by hand | **`workflow-computing-unit-manager`** builds the pod spec (it already mints the JWT + injects env in the `kubernetes` branch of `ComputingUnitManagingResource`); it would additionally attach the per-version CSI volume and set `TEXERA_MODEL_MOUNT_ROOT` |

**Production integration (where the code changes go):**
1. `ComputingUnitManagingResource` (k8s branch that creates the pod) resolves the workflow's models to
   `(repo=dataset-{did}, commit=version_hash)` from Postgres, and for each adds a **CSI volume + a
   read-only `volumeMount`** at `<TEXERA_MODEL_MOUNT_ROOT>/<owner>/<name>/<version>`, plus the
   `TEXERA_MODEL_MOUNT_ROOT` env var (next to the JWT/endpoint env it already injects).
2. `ModelFolderDocument.download()` (this branch) already returns that mount path when the env is set —
   **no worker code change needed**.
3. The CSI driver caches per node, so all computing-unit pods on a node share fetched bytes; immutable
   versions make the cache always-valid.

Cluster used for the check: `kind` cluster `texera-mount` (node joined to the `texera-lakefs` docker
network). A full Texera Helm deploy was **not** run here — it needs ~30 GB of images vs the ~6 GB free
on this box — but the mount-into-a-pod mechanism, which is the crux of Option B in production, is
verified above.
