# ML Models in Texera — UX options for decision (Tuesday demo)

Goal of this session: **decide the user experience** for bringing & using ML models in workflows.
Three working prototypes are on branch `proto/ml-model-ux` (all reuse the dataset storage stack —
LakeFS/MinIO — plus a new `type` column on the `dataset` table; no new tables). Today is about UX, not
final code. Parent issue: #4198. Format for the demo: a tiny **iris** classifier saved as a
self-contained `.pt` (TorchScript) + `iris.csv`.

---

## The options

| | **B — Model Inference operator** | **A1 — UDF + Model picker (auto-load)** | **A2 — UDF + code insert (manual)** |
|---|---|---|---|
| How the user gets a model | Drag operator, pick model in panel | Pick model in UDF panel | Right-click in code editor → insert |
| Code the user writes | **None** | ~3 lines of inference | Full template (or stub) — editable |
| Model loading | Framework | Framework (`texera_model` ready) | User code (`DatasetFileDocument` + `torch.jit.load`) |
| Output column | **Auto-declared** | Manual ("Extra output column(s)") | Manual ("Extra output column(s)") |
| Flexibility (preprocessing, custom logic) | Low (fixed contract) | High | Highest |
| Non-tech friendliness | **Best** | Medium | Low |
| Model format | Self-contained `.pt` | Self-contained `.pt` | Anything the user codes |
| Framework-agnostic | Yes (PyTorch now, MLflow later) | Torch-coupled in the auto-loader (generalizable) | User's choice |
| Consistency w/ existing ops | Mirrors HuggingFace Inference op | Mirrors dataset picker | — |

**One-line summary:** B = no-code/turnkey; A1 = low-code (picker + you write the inference); A2 = full control.
They're three points on the same spectrum, not exclusive — Texera could ship more than one.

---

## Click-through scripts (same model + data for all three)

### Shared setup (once)
1. Stack up (`docker compose up`), backend services running, frontend `yarn start`.
2. Upload **`iris_classifier.pt`** and **`iris.csv`** into a dataset (e.g. `iris-model`), **commit a version (v1)**.
3. **Make that dataset public** — local-dev only (see Gotcha #1).

### Demo B — Model Inference operator (no code)
1. Canvas: **CSV File Scan** (pick `iris.csv`) → **Model Inference** → **View / Sink**.
2. In Model Inference: **Model** = pick `iris_classifier.pt`; **Feature Columns** = the 4 iris columns;
   **Output Column** = `prediction`.
3. **Run** → `prediction` column shows `0/1/2` (setosa/versicolor/virginica).
- *Talking point:* zero code, output schema handled for you. Closest to "upload a model, use it."

### Demo A1 — UDF + Model picker (auto-load)  ← the synthesis
1. Drop a **Python UDF**. Panel → **Model** field → pick `iris_classifier.pt`.
2. **Edit code content** — no fetch/load code, just use `texera_model`:
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
3. **Retain input columns** = on; **Extra output column(s)**: `prediction : string`.
4. **CSV File Scan (`iris.csv`) → Python UDF** → **Run**.
- *Talking point:* picker like datasets; framework loads the model; user writes only the inference.

### Demo A2 — UDF + code insert (manual / full control)
1. Drop a **Python UDF** → **Edit code content** → **right-click** → **"Load ML Model: insert full template"**
   (or **"…insert loader stub"**) → pick `iris_classifier.pt`.
   - Full = complete working recipe (fetch + inference) you can edit; Stub = commented guidance only.
2. **Retain input columns** = on; **Extra output column(s)**: `prediction : string`.
3. **CSV File Scan → Python UDF** → **Run**.
- *Talking point:* user sees and controls every line, incl. the `DatasetFileDocument` fetch.

---

## Gotchas (call these out — they're decision-relevant)

1. **Model must be public on a locally-run computing unit.** Not a model limitation — Python operators
   fetch files over HTTP from file-service and need the user's JWT, which the managing service injects in
   **production** but a hand-started local unit lacks; the public endpoint is the fallback. JVM operators
   (CSV Scan) aren't affected — they read LakeFS directly with service creds, so private datasets work for
   them. **Open question for the team:** give local units a JWT, or add a service-credential fallback to the
   Python path?
2. **Python UDF (A1/A2) needs the output column declared** ("Extra output column(s)" + "Retain input
   columns"). Miss it → cryptic `KeyError: ... unexpected field 'prediction'`. **Design B avoids this** by
   declaring the schema in the operator — a real non-tech-friendliness gap for the UDF designs.
3. **Model format:** when the framework loads the model (B and A1) it must be self-contained (TorchScript)
   so it loads without the training code. A2 (user code) can load anything. MLflow (the #4198 end-goal)
   standardizes this away.
4. **Rebuild/restart:** Scala changes → `sbt clean compile` + restart services. Python-worker changes →
   just re-run a workflow. Frontend → hot-reload.

---

## Recommendation (straw man — adjust in discussion)
- **Non-technical users / standardization → Design B.** Turnkey, consistent, schema handled.
- **ML power users → Design A2.** Full control.
- **A1 is the middle ground** and may be the best default if we want one UX that scales from simple to custom.
- Not mutually exclusive — B + A1 cover most users. Final shape to be decided with Chen Li's proposal.

## Chen Li's design (3rd option)
_(placeholder — prepare on request)_

---

## Status / what's real
- Built & verified on `proto/ml-model-ux`: storage `type` column, model→worker bridge (+ public fallback),
  Model Inference operator (B), UDF Model picker auto-load (A1), UDF editor insert (A2), shared model picker.
- All on production foundations (asset `type` column, prefix-aware `FileResolver`, `PythonOperatorDescriptor`,
  existing picker) — whichever UX wins is productionizable, not a throwaway.
- Demo artifacts: `~/Downloads/iris_classifier.pt`, `~/Downloads/iris.csv`.
