# ML Models — Prior-Art Research Findings (Action Item #1)

**Question researched:** How do production systems store, version, govern, and serve/load
user-provided ML models (esp. PyTorch) as first-class catalog assets, and what should a
LakeFS+MinIO system (Texera) borrow?

**Method:** deep-research pass — 5 search angles, 22 sources fetched, 81 claims extracted,
25 verified with 3-vote adversarial checking (24 confirmed, 1 refuted). Sources are
primary vendor/official docs unless noted.

---

## TL;DR — the two things that decide the design

1. **Model-as-asset is a proven pattern.** MLflow Registry and Unity Catalog both model a
   model as: a *named container* → holding *auto-incrementing versions* → with *mutable
   aliases* (e.g. `Champion`/`production`) and *tags*, addressed by a *stable URI*. Promotion
   = repoint a pointer, not move bytes. This directly validates our `type=MODEL` asset with
   no new tables.

2. **A PyTorch model is NOT loadable like a CSV — and this is the crux.** The common
   `torch.save(model)` (full-object pickle) and `torch.package` store a *reference to the
   model's Python class*, so loading either (a) fails with `No module named X` unless the
   user's training source is importable in the worker, or (b) executes arbitrary code during
   unpickling (**RCE risk** for user-uploaded bytes). Only **ONNX**, **TorchScript**
   (`torch.jit`), and **safetensors/state_dict** are safe/code-free — with the caveat that
   safetensors/state_dict carry weights only and need the architecture declared.

---

## 1 · PyTorch storage & loading semantics (the "mount/load" problem)

| Format | Self-contained (loads w/o user code)? | Safe (no code exec on load)? | Notes |
|---|---|---|---|
| `torch.save(model)` full object | ❌ needs class source importable | ❌ pickle → RCE | Maintainers explicitly recommend *against* this |
| `state_dict` (`torch.save(model.state_dict())`) | ❌ needs architecture to load into | ⚠️ still pickle | Weights only; must rebuild the module first |
| **TorchScript** (`torch.jit.save`) | ✅ carries graph + weights | ✅ | Loads with `torch.jit.load`, no class source |
| `torch.package` | ⚠️ only if model code is *interned*; `extern`-ed deps must resolve in worker | ❌ pickle → RCE | `intern/extern/mock/deny` resolution at export |
| **ONNX** | ✅ standardized op graph + embedded weights | ✅ runs on ONNX Runtime | >2GB uses external-data sibling file; custom ops need kernels |
| **safetensors** | ❌ tensors only, no architecture | ✅ audited, zero-copy, no code exec | HF default; needs consuming code to know the mapping |

**Key facts (verified):**
- PyTorch core author: *"PyTorch internally uses pickle… This is exactly why we recommend
  saving only the state dicts and not whole model objects."* The tutorial confirms pickle
  *"saves a path to the file containing the class, which is used during load time"* — a
  whole-model save is bound to the exact class + directory structure.
  ([pytorch#3678](https://github.com/pytorch/pytorch/issues/3678),
  [tutorial](https://docs.pytorch.org/tutorials/beginner/saving_loading_models))
- **"Mounting a package"** = resolving a `torch.package`'s `extern`-ed dependencies from the
  worker's environment via `importlib`. A package that `extern`s the model's *own* class is
  not loadable without that user code; and `torch.package` *"depends on the pickle module
  which is not secure… will execute arbitrary code during unpickling."* `weights_only=True`
  (PyTorch 2.6 default) does **not** protect `torch.package`.
  ([torch.package](https://docs.pytorch.org/docs/stable/package.html))
- **ONNX** = a single protobuf `ModelProto` (metadata + DAG of standardized operators +
  weights as initializers), runs on ONNX Runtime with no training-framework class present —
  the load-bearing distinction from PyTorch pickle. ([onnx](https://onnx.ai/onnx/intro/python.html))
- **safetensors** = raw tensors + JSON header, Trail-of-Bits-audited to not execute code on
  load; analogous to a `state_dict`. ([safetensors](https://huggingface.co/docs/safetensors/index),
  [audit](https://huggingface.co/blog/safetensors-security-audit))

**➡ Implication for our demo:** the iris demo already uses a self-contained TorchScript `.pt`
— that was the right call. It generalizes: the no-code operator (Design B) and auto-load UDF
(A1) must target self-contained formats; arbitrary `.pt` uploads are a trust + dependency
hazard best confined to the full-control UDF path (A2) with an explicit warning.

## 2 · LakeFS for models

- **lakeFS Mount (Everest)** uses **lazy prefetch**: files download only on access (e.g.
  `cat`, not `ls`), and for large files *"can fetch from lakeFS only the parts actually
  accessed."* A worker can mount `/models/<owner>/<name>/<version>/` and pull only the needed
  file. ([mount docs](https://docs.lakefs.io/v1.64/reference/mount/))
- **Read-only mount pins an immutable commit ID** (branch/tag → resolves to HEAD commit) —
  exactly the reproducible-load primitive model inference needs.
- **Use:** commits/tags for immutable version identity; read-only Mount pinned to a commit for
  reproducible loads; lazy prefetch so the worker doesn't pull whole repos.
- ⚠️ **Caveat:** confirm our lakeFS tier supports Mount/Everest — some Mount capabilities have
  historically been Enterprise/Cloud-gated.

## 3 · Unity Catalog (models-as-governed-assets) — the closest precedent

- Registered Models are *"logical containers for ML models… comprised of any number of Model
  Versions,"* identified by a **three-level name** `catalog.schema.model`.
- **Aliases** are *"a mutable, named reference to a particular version"* — e.g. reassign
  `Champion` to promote a version without touching consumers.
- Since **MLflow 2.16.1**, Unity Catalog is a backing registry for MLflow — i.e. the registry
  metadata layer and the byte-storage layer are cleanly separated.
- **Transferable:** a MODEL is the same catalog object kind as a DATASET, distinguished by
  type, inheriting the asset system's governance/ACLs — direct precedent for our design.
  ([UC docs](https://docs.unitycatalog.io/usage/models/),
  [Databricks](https://docs.databricks.com/aws/en/machine-learning/manage-model-lifecycle/))

## 4 · Cross-system comparison (the model-as-asset pattern)

- **MLflow Model Registry** — the canonical schema to mirror: named registered model →
  auto-incrementing integer versions → mutable aliases + tags → stable URI
  `models:/<name>/<version>` or `models:/<name>@<alias>`, loaded via flavor-specific APIs.
  ([registry](https://mlflow.org/docs/latest/ml/model-registry/))
- **MLmodel file + flavors** — a root YAML declaring supported *flavors* + metadata
  (signature, input_example, run_id, mlflow_version). `python_function` (pyfunc) is a *uniform
  load interface*, **but NOT code-free**: it needs the framework deps present, and custom
  flavors embed user code. **The claim that an MLflow directory is fully self-contained was
  REFUTED (1-2 votes)** — do not assume MLflow packaging eliminates the load-dependency
  problem. ([model docs](https://mlflow.org/docs/latest/ml/model/))
- **Hugging Face Hub** — repo-per-model; a `README.md` **model card** with a YAML metadata
  header holds structured metadata alongside the bytes; safetensors is the default weights
  format. Validates our single-path-per-model + metadata-record layout.
  ([model cards](https://huggingface.co/docs/hub/model-cards))
- **Splunk MLTK** — re-encodes a trained model into a Splunk-specific `.mlmodel` CSV container
  (`algo, model, options`) stored in the app's `lookups/` folder — i.e. a heavy
  standardize-on-ingest approach. A data point for the "enforce structure on upload" option,
  but far more restrictive than we want.

## 5 · Synthesis — concrete recommendations mapped to our plan

### (a) Storage layout under `/models/` → **format-agnostic + a metadata record**
- Do **not** hard-enforce MLflow structure (it isn't code-free anyway, and it's heavy for
  "upload a `.pt`"). Store bytes as-is under `/models/<owner>/<name>/<version>/<file>` plus a
  declared metadata record — mirroring the MLmodel-file / HF-model-card convention.
- **Ties to plan A2/A4:** the "enforce model protocol on upload" step becomes *record + (light)
  validate metadata*, not *transcode*. Enforcement graduates later (raw `.pt` → MLflow).

### (b) Getting bytes to the worker + loading without user code → the D1/D3 decision
- No-code operator (B) and auto-load UDF (A1) should **target self-contained formats**:
  **TorchScript** (`torch.jit.load`) now, **ONNX** (ONNX Runtime) as the framework-agnostic
  path later. These need no user class source and don't execute pickle code.
- Arbitrary `torch.save`/`torch.package` uploads → confine to the **full-control UDF (A2)**
  with an explicit *"requires your model code + is unpickled (code-exec) — trusted models
  only"* warning.
- **Delivery:** migrate the worker fetch (D1) toward **lakeFS Mount** (commit-pinned + lazy)
  for partial/reproducible loads instead of whole-file HTTP pulls — evaluate vs. the current
  file-service HTTP path.

### (c) Metadata/governance fields the `type=MODEL` asset should carry
- `framework` (pytorch/onnx/…), `format`/`flavor` (torchscript/onnx/safetensors/state_dict/
  full-pickle), **IO signature** (input/output tensor schema — needed to wire the no-code
  operator without user code), `version` (auto-increment integer), and a **mutable alias**
  (e.g. `Champion`) for promotion-by-pointer. All lifted from MLflow/Unity Catalog.

### (d) LakeFS features to actually use
- Commits/tags = immutable version identity · read-only Mount pinned to a commit =
  reproducible loads · lazy prefetch = pull only the accessed file. (Confirm tier supports
  Mount.)

---

## Key decisions the GitHub discussion should raise

1. **Format policy:** whitelist safe self-contained formats (ONNX / TorchScript / safetensors)
   for the no-code path, vs. allow arbitrary `.pt` on the UDF path with a pickle-RCE + "needs
   your code" trust warning. (This is the central safety decision.)
2. **Require an IO/tensor signature at registration?** The no-code operator can't wire
   inputs/outputs without one — where does it come from for raw `.pt` vs ONNX vs MLflow?
3. **Version identity:** auto-incrementing integers (MLflow style) vs. reuse lakeFS commit
   IDs/tags — and how mutable aliases (`Champion`) map onto the dataset asset schema **without
   new tables**.
4. **Worker delivery:** migrate from HTTP file-service fetch to lakeFS Mount (lazy/partial,
   commit-pinned) — in scope for phase 1 or later?

## Open questions carried forward
- What is the Python UDF worker's sandbox/isolation model — does it already contain pickle RCE
  from user model bytes, or does that force a safe-format whitelist for untrusted uploads?
- Does our target lakeFS deployment support Mount/Everest (tier-gating)?
- Signature source of truth per format (raw `.pt` has none intrinsically; ONNX and MLflow do).

## Caveats on the research
- PyTorch 2.6 flipped `torch.load(weights_only=True)` by default, but this does **not** protect
  `torch.package` or full-object unpickling of untrusted bytes — the RCE risk is live.
- MLflow pyfunc "universality" is overstated in its own docs: code-free only for built-in named
  flavors, always needs framework deps, custom flavors embed user code.
- ONNX "single file" is default, not universal (>2GB → external-data sibling; custom ops → need
  runtime kernels).
- Unity Catalog alias docs live mainly in Databricks UC docs; confirm OSS Unity Catalog alias
  parity if OSS is our reference.
