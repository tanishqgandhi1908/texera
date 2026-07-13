# ML Models in Texera — Concrete Storage Design (simple version)

Plain, concrete answers to 4 questions. No architecture-speak.

---

## The one idea that makes everything simple

**A model is not "a file." A model is a folder of files — exactly like a dataset version.**

Texera already stores a *dataset version* as a set of files in one LakeFS commit. A model version
is the same thing. So **storage is already solved** — we reuse it. What's new is only:
1. a small **manifest file** in the folder that says *how to load it*, and
2. a **loader** in the Python worker, one per framework.

That's the whole trick. Storage never changes as we add frameworks — only the loader does.

---

## Q1 · How to store a PyTorch model (many files, ref pointers, can't load like a CSV)

### Store the whole folder, not a single `.pt`

```
/models/alice@uci.edu/sentiment-net/v1/
├── model.pt              ← the weights (ideally TorchScript = self-contained)
├── config.json           ← architecture / hyperparams (if needed)
├── vocab.txt             ← any aux files the model needs
├── model_code/           ← the user's Python class files (ONLY if not self-contained)
│   └── net.py
└── texera-model.yaml     ← manifest: how to load this (see below)
```

This is stored **exactly like a dataset version**: one LakeFS commit holds all these files
together. Same repo-per-asset, same commit-per-version, same presigned-URL download. **No new
storage code.**

### The manifest — this is what solves "can't load like a CSV"

A CSV is self-describing; a model isn't. So we add one tiny file that describes it:

```yaml
# texera-model.yaml
framework: pytorch
format: torchscript        # torchscript | state_dict | onnx | ...
entry_file: model.pt       # which file to load
code_dir: null             # or "model_code/" if the model needs user classes
inputs:  [{name: text, dtype: string}]
outputs: [{name: label, dtype: string}]
```

The same info is copied into the asset's Postgres row (a `properties` JSON — see Q3), so the UI
can show it and the operator can wire columns **without opening the bytes**.

### Who writes the manifest? Nobody — the system does (this matters for non-developers)

A non-developer never writes YAML. The manifest is produced by two things working together:

1. **Auto-detect on upload.** The backend inspects the uploaded bytes and fills in what it can:
   the **format** (TorchScript vs state_dict vs TF SavedModel vs sklearn `.joblib`), the **entry
   file**, and **whether user code is bundled**. For PyTorch we can classify *without executing
   the file* by statically reading the archive/pickle structure (the safe technique model-
   scanners use) — so we know "TorchScript ✅ self-contained" vs "raw state_dict ❌ needs a class."
2. **A tiny upload wizard** fills only what couldn't be detected, with best guesses pre-selected
   (framework dropdown already on "PyTorch", entry file already chosen). One or two clicks.

**The input/output *columns* are NOT in the manifest.** The user maps them **visually in the
operator panel** at run-time (pick Feature Columns, name the Output Column). So the manifest only
needs `framework + format + entry_file (+ code_dir)` — exactly the auto-detectable parts. Non-devs
configure IO by clicking columns, never by editing text.

**The two upload cases:**

| They upload… | What happens |
|---|---|
| **Only a `.pt`** | Inspect it. **TorchScript →** done, works no-code. **Raw state_dict / full-pickle →** we detect it needs classes we don't have; UI says *"upload the folder with your `.py` files, or re-export as TorchScript"* + the one-line command. **Honest limit:** a bare non-self-contained `.pt` cannot run without its code or conversion — no platform can avoid this. It's why non-devs are steered to TorchScript/ONNX. |
| **A folder** (`.pt` + config + code + …) | Drag-drop the whole folder (same as dataset upload). Backend picks the entry file, detects code files, sets `code_dir` so the worker mounts them. Works — including non-self-contained models. |

### The "reference pointers" problem — it's a *loading* problem, not a *storage* problem

Storage just holds bytes; it doesn't care. The pointer problem shows up at **load time**:

| What the user uploads | Self-contained? | How the worker loads it |
|---|---|---|
| **TorchScript** (`torch.jit.save`) | ✅ yes | `torch.jit.load(model.pt)` — done. **Recommend this.** |
| **ONNX** | ✅ yes | ONNX Runtime — no PyTorch class needed |
| `state_dict` + user's `net.py` | ❌ needs the code | worker adds `model_code/` to `sys.path`, imports the class, then loads weights. This is the **"mounting"** step. |
| full `torch.save(model)` | ❌ needs the code + runs pickle | discourage — needs code AND is a security risk |

**Recommendation:** the no-code operator accepts **only self-contained** formats (TorchScript/
ONNX). If someone brings a state_dict + code, that's allowed **only in the Python UDF path**,
where they already control the environment. (Details in the earlier
[research findings](ML_MODELS_RESEARCH_FINDINGS.md).)

---

## Q2 · Adding TensorFlow and scikit-learn later — why it's easy

**Storage does not change at all.** A TF SavedModel is a folder; an sklearn model is a
`.joblib` file. Both are "a set of files in a version" — same as PyTorch.

Only **two small things** vary per framework:
1. the `framework` / `format` field in the manifest, and
2. **one loader function** in the worker.

```python
# the ONLY thing you add to support a new framework
LOADERS = {
    "torchscript":    load_torchscript,   # PyTorch (now)
    "onnx":           load_onnx,           # framework-agnostic (now)
    "tf-savedmodel":  load_tensorflow,     # + add this later
    "sklearn-joblib": load_sklearn,        # + add this later
}

def load_model(folder, manifest):
    return LOADERS[manifest["format"]](folder, manifest)
```

Adding TensorFlow = write `load_tensorflow()` + accept the SavedModel folder. **No storage change,
no database change, no new table.** That's the payoff of "a model is just a folder + a manifest."

---

## Q3 · A future asset (venv, etc.) + Unity Catalog compared

### First, the generalization

Once a model is "a folder of files + a `type` + a manifest," **any file-like asset works the
same way**. To add a new asset type you add:
- a new `type` value (e.g. `VENV`),
- a manifest shape for it,
- a handler in the worker (loader / installer / whatever "use it" means).

Stored the same way (LakeFS folder + version). **No new table.** This is the extensible-asset
idea, made concrete.

> **On venvs / computing units:** you're right to separate them. *Storing* a venv (e.g. a packed
> environment or `requirements.txt`) fits the asset model fine. But *activating* it is a **runtime**
> concern (like computing units) — that's a different flow, not a LakeFS-stored-asset concern. So:
> the **storage** part fits here; the **"make it live"** part does not.

### How Unity Catalog does this (the research that was left)

Unity Catalog (Databricks, now also open-source under the Linux Foundation) is a **single catalog
for many asset types**: `tables`, **`volumes` (files)**, `functions`, and **`models`** — all under
one `catalog.schema.object` namespace, each object discriminated by type. This is the exact
"one catalog, many types" pattern.

- **Volumes** = its file-asset primitive (images, PDFs, arbitrary files, and by extension models/
  artifacts). Volumes are **managed** (UC owns the storage lifecycle) or **external** (UC governs,
  storage stays where you put it).
- **Credential vending** = UC hands out **temporary scoped credentials** so external engines read
  volume files directly — this is *conceptually identical to Texera's presigned-URL* approach.
- **Models** = first-class, with versions + aliases (`Champion`).

### Unity Catalog — pros / cons for us

| 👍 Worth borrowing (the *ideas*) | 👎 Why we should NOT adopt UC itself |
|---|---|
| One namespace + **type discriminator** for all asset kinds (tables/files/models) | It's a **big external service** (own server + metastore). Texera already has Postgres + LakeFS — adding UC is heavy and duplicative |
| **Governance separate from storage** (catalog vs volumes) — matches our Postgres + LakeFS split | UC is **Delta/Databricks-native**; Iceberg support is newer and layered on (via **UniForm** + managed Iceberg tables + Iceberg REST Catalog). Texera is Iceberg-native for results → mismatch |
| **Credential vending** ≈ our presigned URLs (already aligned) | UC **volumes have no Git-like versioning/branching** — **LakeFS is *better*** for versioned file assets |
| **Model versions + aliases** (Champion/Latest) | External dependency + lock-in + operational cost |

> ⚠️ **On the Iceberg belief:** "UC does not support Iceberg" is *out of date* — since 2025 UC
> supports it via UniForm, managed Iceberg tables (preview), and an Iceberg REST Catalog. **BUT
> the reported problems are real:** OSS UC's Iceberg REST catalog is currently **read-only** (write/
> create endpoints are still an open feature request, [issue #3](https://github.com/unitycatalog/unitycatalog/issues/3)),
> and UniForm generates Iceberg metadata **asynchronously** so external clients can read a
> **stale** view, with version/feature gaps ([UniForm docs](https://docs.databricks.com/aws/en/delta/uniform)).
> Fair statement: *UC is Delta-first; Iceberg works but is partial/preview with rough edges* —
> which is exactly why we stay Iceberg-native + LakeFS and only borrow UC's concepts.

**Bottom line:** copy Unity Catalog's *concepts* (one catalog, `type` discriminator, files-as-a-
governed-asset, credential vending, model aliases) but implement them on our **existing Postgres +
LakeFS** stack. We don't run Unity Catalog. (Apache **Gravitino** is the closest OSS proof that
models sit as a first-class type next to tables/files in one catalog — see
[architecture research](EXTENSIBLE_ASSET_ARCHITECTURE_RESEARCH.md).)

### What this means for the database (no new table)

```
asset table (today's `dataset` table, lightly extended)
├── id, owner, name, is_public, ...      ← shared fields (already exist)
├── type         DATASET | MODEL | ...   ← NEW: 1 column
└── properties   JSONB                   ← NEW: per-type metadata bag
                 model → {framework, format, entry_file, inputs, outputs, alias}
                 dataset → {…}
```

One column + one JSON bag. Models ship now; venvs/other types later drop into the same two fields.

---

## Q4 · How this fits the Operator + UDF methods we discussed

Both the no-code operator and the UDF consume the **same stored folder + manifest**. The fetch +
load is **shared plumbing** (this is step D1 in the plan).

```
   User picks a model in the panel  →  logical path /models/alice/sentiment-net/v1
                                                │
        ┌───────────────────────────────────────────────────────────────┐
        │  SHARED PLUMBING (worker side)                                  │
        │  1. fetch the model folder via presigned URLs                   │
        │     (the SAME path datasets already use — no new fetch code)    │
        │  2. read texera-model.yaml → format = torchscript               │
        │  3. LOADERS["torchscript"](folder)  →  `texera_model` object    │
        └───────────────────────────────────────────────────────────────┘
                                                │
             ┌──────────────────────────────────┴─────────────────────────────┐
             ▼                                                                  ▼
 ┌─────────────────────────────┐                        ┌──────────────────────────────────┐
 │ Model Inference operator     │                        │ Python UDF (auto-load)            │
 │ (NO CODE)                    │                        │ (LOW CODE)                        │
 │ • framework calls            │                        │ • `texera_model` is preloaded     │
 │   texera_model(feature_cols) │                        │ • user writes ~3 lines:           │
 │ • writes result → output col │                        │     x = torch.tensor([...])       │
 │ • output schema from manifest│                        │     tuple_["label"] =             │
 │   inputs/outputs             │                        │        texera_model(x)...         │
 └─────────────────────────────┘                        └──────────────────────────────────┘
```

- **Shared:** fetch folder → read manifest → run the matching loader → hand back `texera_model`.
  Write it once; both front-ends use it. Adding TF/sklearn later automatically works for **both**
  because they share the loader table from Q2.
- **Operator (no-code):** the framework calls the model for you and uses the manifest's
  `inputs`/`outputs` to wire columns — user writes nothing.
- **UDF (low-code):** `texera_model` is already loaded; the user writes just the inference line.
  This path can also accept the non-self-contained models (state_dict + code), since the user
  controls the code.

---

## The 30-second summary

1. **Store a model like a dataset version** — a folder of files in a LakeFS commit — **plus a tiny
   manifest** describing how to load it. No new storage code, no new table (one `type` column + a
   `properties` JSON).
2. **TF/sklearn later = one loader function each.** Storage and schema don't change.
3. **Future file-assets (venv, …) = a new `type` + manifest + handler.** Same folder storage.
   Borrow Unity Catalog's *ideas*, not the product — we already have the better pieces (LakeFS
   gives versioning UC volumes lack; we're Iceberg-native, UC is Delta-first).
4. **Operator + UDF share one "fetch folder → read manifest → load" step;** they're just two
   front-ends over the same loaded `texera_model`.
