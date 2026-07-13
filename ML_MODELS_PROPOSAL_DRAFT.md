# Design proposal:


Consolidating the original proposal in #4198 (Supporting ML models) with a concrete, incremental delivery plan.
Goal: align on the approach before writing more code, and gather the community's views

- **Parent issue:** #4198
- **Affected area:** Workflow Engine (Amber), file-service, frontend

---

## 1. Goal

Enable a standardized experience for users to bring and run their own Machine Learning (ML) models within Texera — upload, version, and use models in workflows, the same smooth way we already handle datasets. This requires a unified protocol for the full lifecycle of model saving, loading, and execution.

## 2. Motivation & user personas

Texera serves two user groups with distinct needs:

1. **Students** — learning the fundamentals of Machine Learning and Data Science.
2. **Bioinformatics researchers** — heavy computation such as sequence alignment and "shallow" machine learning (e.g. scikit-learn, classic statistical models).

Today there is **no standardized way** for these users to import and run pre-trained models seamlessly. A standard protocol streamlines this workflow and improves Texera's extensibility.

## 3. Evaluation of alternatives (format/standard)

We explored several options before selecting **MLflow**:

| Option | Pros | Cons |
| --- | --- | --- |
| **Hugging Face** | Excellent standards and ease of use; industry standard for LLMs. | Primarily focused on LLMs / deep learning; no comprehensive solution for the full lifecycle (storage → loading) of general-purpose or "shallow" ML models our audience uses. |
| **ONNX** | Great interoperability for deep-learning models. | Heavily focused on neural networks; less suitable for the broad range of general ML libraries (e.g. scikit-learn) our biomedical users rely on. |
| **MLflow** *(selected)* | Supports a wide variety of libraries — TensorFlow, PyTorch, scikit-learn. Manages the **entire** lifecycle, from standardizing the storage format to loading the model for inference. | — |

## 4. Architecture

The integration leverages two existing architectural features within Texera (storage and the Python operator), plus one unifying idea.

### 4.1 Core principle: a model is a *kind of asset*, not a new subsystem

Datasets already provide everything a model needs: upload, versioning (LakeFS), physical storage (MinIO), access control, and a file picker in the operator panel. Rather than build a parallel stack, we treat **datasets and models as two kinds of one concept ("asset")** and reuse the existing infrastructure.

```
asset
 ├── dataset   (any files)
 └── model     (model files only — enforced on upload)
```

### 4.2 Model storage (via LakeFS) — no new tables

- We reuse the existing **LakeFS** integration to store model artifacts, exactly as we store datasets — **with one key difference: we enforce the model protocol/structure on the files during upload** to guarantee compatibility (raw PyTorch first; MLflow structure later).
- To distinguish the two kinds without new tables, add a single `type` column (`DATASET` | `MODEL`) to the existing `dataset` table. A model is simply a `dataset` row with `type = MODEL`.

The logical path already carries a resource-type segment after #5911, so models slot into the same machinery:

```
/datasets/<owner>/<name>/<version>/<file>
/models/<owner>/<name>/<version>/<file>     <-- new, identical resolution path
```

Full storage chain (the same for datasets and models):

```
logical path  /models/<owner>/<name>/<version>/file.pt
   │  FileResolver  (strips resource-type prefix, looks up Postgres metadata)
   ▼
LakeFS         repo = asset, commit = version
   ▼
MinIO / S3     texera-dataset bucket — the raw bytes
```

### 4.3 Model execution (new operator)

- Introduce a new operator type: **`MLflow`**.
- Built on the existing **Python Native Operator** infrastructure.
- The operator automatically handles loading the model using the standard `mlflow` library and executing inference against the input data stream.
- The model is selected via a picker that mirrors the existing dataset file selector.

### 4.4 Reference diagrams (from #4198)

![Architecture diagram 1](https://github.com/user-attachments/assets/a2d1425f-e404-4e51-be10-f97efe156b5d)

![Architecture diagram 2](https://github.com/user-attachments/assets/06cf1a88-4d9a-4502-ba22-abe90eec3468)

## 5. Proposed delivery (each = one focused PR)

1. **Path prefix** — `/datasets/...` segment, room for `/models/...`. *(#5911, in review)*
2. **Asset type** — add `type` column to `dataset`; regenerate JOOQ. No behavior change.
3. **Resolve `/models/...`** — register the `models` prefix in `FileResolver`.
4. **Model upload/versioning (backend)** — reuse dataset code filtered by `type = MODEL`; enforce the model file format on upload.
5. **Models UI (frontend)** — list / upload / version screens.
6. **Workflow integration** — model picker + the inference operator.
7. **MLflow standardization + polish** — MLflow format enforcement, sharing/public/hub, docs.

## 6. Open questions for the community


Feedback welcome — happy to adjust the plan based on what folks prefer.
