# HANDOFF — ML models as assets in Texera (read me first)

_Context bundle for continuing this work on another machine (e.g. a bigger-RAM VM). A fresh Claude
session should read this file + the linked docs to get up to speed._

## What this work is
Add support for **user-provided ML models** in Texera — upload a trained model, pick it in a
workflow, get predictions — reusing the existing **dataset storage stack** (LakeFS + MinIO). A model
is just an asset with `type = MODEL`, no new storage system. Alongside the feature, we researched how
to build a **general, extensible asset/catalog layer** (so models are the first of many future asset
types) by studying LakeFS, Iceberg, Unity Catalog, Snowflake, Kubernetes, Gravitino, DataHub, etc.

## Current status
- **Working prototype** committed on this branch (`proto/ml-model-ux`, commit `2f1cd6576`): load a
  model in a Python UDF, two lanes —
  - single-file (`.pt`/TorchScript) → auto-loaded as `texera_model` (in memory);
  - **folder** model (TF SavedModel, ONNX, HuggingFace, sharded LLM) → `texera_model_dir` (whole
    version materialized to the worker's local disk).
  - Verified end-to-end with single-file, folder, sharded `.bin`, and a real HuggingFace sentiment
    model. Files touched: `ModelFolderDocument` (pytexera), file-service `GET /list-files`,
    `PythonUDFOpDescV2` picker + injection, frontend picker wiring. See `ML_MODELS_PROTOTYPE_CODE.md`.
- **Research + design docs** all live on this branch (see index below).
- **Hands-on external-systems study started:** Unity Catalog OSS was cloned, built, run, and its REST
  API exercised (`UNITY_CATALOG_HANDSON.md`). **Next: Snowflake** (storage-vs-compute + warehouse
  on/off lifecycle) — use its free trial / SnowSQL, not local.

## Branch layout
- `proto/ml-model-ux` — the prototype **and** all the research/design docs (this branch; push target).
- `fix/dataset-sort-newest-first` — unrelated frontend dataset-sort work; its config wip is in a git
  stash ("env-conf"). Not needed for this work.

## Doc index (all on this branch)
- `ML_MODELS_FINDINGS_SUMMARY.md` — brief for the professor (with diagrams).
- `ML_MODELS_PRIMER.md` — what a model / `.pt` / TorchScript / formats actually are.
- `ML_MODELS_STORAGE_DESIGN.md` — concrete storage design (model = folder of files).
- `ML_MODELS_LOADING_COMPLETE.md` — full load flow + all options (the 3 model types).
- `ML_MODELS_FOLDER_LOADING.md` — folder/sharded loading (why materialize to disk).
- `ML_MODELS_PROTOTYPE_CODE.md` — **all prototype code in one place**.
- `ML_MODELS_RESEARCH_FINDINGS.md` — model-as-asset patterns (MLflow/Unity Catalog/PyTorch).
- `ASSET_STORAGE_ENGINE_RESEARCH.md` — LakeFS/Iceberg feature depth vs Texera; OSS-vs-Enterprise.
- `EXTENSIBLE_ASSET_ARCHITECTURE_RESEARCH.md` — the extensible-asset architecture + literature.
- `RESOURCE_ABSTRACTION_RESEARCH.md` / `RESOURCE_ABSTRACTION_SIMPLE.md` — typed-resource + per-type
  resolver; how catalogs resolve; compute stays out of storage-resolution.
- `STORAGE_COMPUTE_CATALOG.md` · `SYSTEMS_DIAGRAMS.md` — storage+compute catalog systems, diagrams.
- `TEXERA_ASSET_ADOPTION_PLAN.md` — how Texera adopts the catalog-over-typed-tables design.
- `UNITY_CATALOG_HANDSON.md` — the hands-on UC session (reproducible).
- `ML_MODELS_MEETING_MINUTES.md` · `ML_MODELS_MEETING_2_MOM.md` — meeting notes.

## Shareable pages (open from any browser)
- Simple explainer: https://claude.ai/code/artifact/b28ab477-6c35-4c29-a1d8-6cb1c6fda158
- Q1 catalog research briefing: https://claude.ai/code/artifact/c230b9c6-5de9-4f9f-b11a-847046c627ad

## The core design conclusion (for quick orientation)
One **catalog** (Postgres) over typed assets, each resolved by its own handler:
- file-like assets (dataset/model/venv) → LakeFS + presigned URL (materialize to local disk to load);
- tables → Iceberg; **computing units → their own lifecycle resolver, NOT the storage path**.
Unity Catalog OSS confirmed this pattern hands-on (catalog/schema/table/volume/model securables,
credential-vending to storage, **zero compute** in the catalog).

## To continue on the VM
```bash
git clone https://github.com/tanishqgandhi1908/texera.git && cd texera
git checkout proto/ml-model-ux          # prototype + all docs are here
claude                                   # then: "read HANDOFF.md and the ML_MODELS_* docs"
```
- **Rebuild what doesn't travel:** the Texera dev stack (Postgres/LakeFS/MinIO) and, for external
  study, the Unity Catalog clone — steps in `UNITY_CATALOG_HANDSON.md`. Live-DB tweaks from the old
  machine (a `dataset.type` column; upload limit 20→1024 MiB) must be re-applied if you run the full
  Texera stack on the VM.
- **Carry the auto-memory (optional):** copy the memory folder
  `~/.claude/projects/-Users-tanishqgandhi-texera/memory/` into the VM's matching Claude project
  memory dir so a fresh session starts with the distilled context. (Not required — this file + the
  docs already brief a new session.)

## Suggested next steps
1. Snowflake hands-on (free trial): `CREATE TABLE` vs `CREATE WAREHOUSE … SUSPEND/RESUME` — see the
   compute lifecycle UC lacks.
2. Optionally run a query engine (DuckDB/Spark) against the UC clone to actually *read* a table via
   credential vending (needs the extra RAM the VM gives).
3. Fold the agreed points into a GitHub design discussion for the community.
