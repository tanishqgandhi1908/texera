# ML Models — A Primer (for deciding what Texera should support)

Plain-English explanation of what a "model" actually is, the file formats people bring, what
metadata travels with them, and what real users generate. Written to inform design decisions.

---

## 1. The core mental model: a model = weights + architecture (+ preprocessing)

Three parts, and you need them together to actually run a model:

```
┌─────────────────────────────────────────────────────────────┐
│  A trained model                                             │
│                                                              │
│   ① WEIGHTS        the learned numbers (big arrays/tensors)  │
│                    — this is 99% of the file size            │
│                                                              │
│   ② ARCHITECTURE   how to arrange & use those numbers        │
│                    (the layers, the math, the "shape")       │
│                                                              │
│   ③ PREPROCESSING  how to turn raw input into model input    │
│      (optional)    (tokenizer, scaler, label encoder, …)     │
└─────────────────────────────────────────────────────────────┘
```

**Analogy:** the weights are the *numbers filled into a form*; the architecture is *the blank form
itself* (what goes where). Numbers alone are meaningless without the form. That's the whole reason
a model can't "just load like a CSV" — a CSV is only data; a model is data **plus** the recipe for
using it.

The key design question is always: **does the saved file include the architecture, or just the
weights?** If just the weights, you need the architecture from somewhere else (usually the user's
code) — and that's the hard case.

---

## 2. What is a `.pt` file? (and `.pth`)

`.pt` / `.pth` are **just filename conventions for "a PyTorch saved thing."** They tell you almost
nothing about what's inside. Under the hood it's a ZIP archive created by Python's `pickle`. The
*same* `.pt` extension can hold four very different things:

| What's inside a `.pt` | Contains | Self-loadable? |
|---|---|---|
| **state_dict** | ② only — a dict of `{layer_name → weights}` | ❌ need the architecture (user's code) |
| **full model** (`torch.save(model)`) | ① + a *reference* to the class (not its source) | ❌ need the class importable + runs pickle (unsafe) |
| **checkpoint** | state_dict + optimizer + epoch + loss (for *resuming training*) | ❌ same as state_dict, plus extra stuff |
| **TorchScript** (`torch.jit.save`) | ① + ② compiled into the file | ✅ **loads anywhere, no user code** |

> **This is the single most important thing to understand:** `.pt` is not one format. When a user
> hands you "a `.pt` file," you don't yet know if it's self-contained or needs their code. That
> ambiguity *is* the problem the manifest/auto-detection solves.

---

## 3. What is TorchScript? (the "good" `.pt`)

TorchScript is PyTorch's way to produce a **self-contained, portable** version of a model. It
compiles the model — **both the architecture and the weights** — into one file that can be loaded
and run **without the original Python class or training code**. Think of it as "compiling" a model
into a standalone program.

Two ways to make it:
- **Tracing** (`torch.jit.trace`) — run one example input through the model and record the
  operations. Simple, but misses `if`/loops (control flow).
- **Scripting** (`torch.jit.script`) — compile the model's Python code directly. Handles control
  flow. More robust.

**Why we care:** TorchScript is the format that lets a non-developer's model run in Texera with
zero code and no security risk. It's what we steer people toward.

*(Newer alternative: `torch.export` / `ExportedProgram` (`.pt2`, 2024+) is PyTorch's next-gen
portable graph format — same spirit as TorchScript, likely the future, but out of near-term scope.)*

---

## 4. The broader format landscape (other frameworks)

| Framework | How models are saved | Self-contained? | Notes |
|---|---|---|---|
| **PyTorch** | `.pt`/`.pth` (state_dict / full / checkpoint) | usually ❌ | needs the class code |
| **PyTorch → TorchScript** | `.pt` via `torch.jit` | ✅ | the portable form |
| **TensorFlow / Keras** | **SavedModel** (a *folder*: `saved_model.pb` + `variables/` + `assets/`) | ✅ | graph is included; loads without user code |
| **Keras (older)** | `.h5` / `.keras` | ✅ (mostly) | single-file |
| **scikit-learn** | Python **pickle** or **`.joblib`** | ⚠️ needs the *library*, not user code (unless custom transformers) | pickle security risk |
| **ONNX** | single `.onnx` file (open standard) | ✅ **and safe** | graph + weights, runs on ONNX Runtime, framework-agnostic |
| **safetensors** | weights only, safe format (no pickle) | ❌ weights only | HF default; needs architecture separately |
| **Hugging Face repo** | a *convention*: `config.json` + weights + tokenizer + README | ✅ with the `transformers` lib | not a format — a folder layout |
| **GGUF** | quantized LLMs for local inference (llama.cpp) | ✅ | LLM-specific; likely out of scope |

**Two patterns to notice:**
- **TensorFlow SavedModel and ONNX bake in the architecture** → self-contained, like TorchScript.
- **PyTorch state_dict and safetensors are weights-only** → you must supply the architecture.
- **scikit-learn is a special middle case:** it needs the sklearn *library* (which the worker has),
  but usually **not** the user's own code — *unless* they wrote custom transformers/estimators.

---

## 5. What "metadata" means for a model (it's layered)

When people say "a model has metadata," they mean several distinct things:

```
1. WEIGHTS            the numbers                          ← always present, the bulk
2. ARCHITECTURE       layer structure / the graph          ← in TorchScript/ONNX/SavedModel; NOT in state_dict
3. PREPROCESSING      tokenizer, scaler, label encoder,    ← often needed; easy to forget!
                      image transforms
4. IO SIGNATURE       input/output shapes, dtypes,         ← needed to wire columns in a workflow
                      what each column means
5. ENVIRONMENT        framework + version, dependencies    ← for reproducible loading
6. PROVENANCE         training data, metrics, author,      ← "nice to have" / model card
                      date, license
```

**The commonly-missed one is #3 (preprocessing).** A model trained on *scaled* features will give
garbage on *raw* features. So a model is frequently **weights + the preprocessing steps used at
training time**. scikit-learn's `Pipeline` bundles them; PyTorch/TF users often ship a tokenizer or
transforms alongside. Any Texera design must account for "the model plus its preprocessing," not
just the weights file.

---

## 6. What real users actually research & generate

Texera's stated audiences are **students** and **bioinformatics researchers**, plus general DS
users. Here's what each typically produces and how they'd use it in a workflow:

| User | What they train | What they save | Difficulty for us |
|---|---|---|---|
| **Student learning ML** | small classifier/regressor; a simple neural net | sklearn `.joblib`, or a PyTorch `state_dict` from a tutorial | mixed — sklearn easy, raw state_dict needs code |
| **Bioinformatics researcher** | "shallow"/classic ML on tabular features — scikit-learn, XGBoost, logistic regression; feature-engineered pipelines | sklearn Pipeline (`.joblib`) — **includes preprocessing** | **easy-ish** (library, not user code) — but pickle risk + custom transformers |
| **Deep-learning researcher** | CNNs/transformers in PyTorch | **checkpoints** (`state_dict` + optimizer) — **needs their model class** | **hard** — the classic "needs the code" case |
| **LLM fine-tuner** | fine-tuned/LoRA language models | Hugging Face format + **safetensors** | specialized; big; likely later |
| **Anyone wanting portability** | any of the above, exported | **ONNX** | **easiest & safest** — the ideal target |

**How they use it in a workflow:** almost always **batch inference** — a trained model applied
row-by-row (or batch) over a data stream: "score every row," "classify each record," "predict a
value per row." That's the Model Inference operator / UDF pattern. (Training *inside* Texera is a
different, much bigger scope — not this effort.)

---

## 7. So what does this mean for decisions?

Sorting every format by "how hard is it to run in Texera with no user code":

```
EASY  ──────────────────────────────────────────────────────────►  HARD
self-contained, no code needed              weights-only / needs the user's code

ONNX ✅        TorchScript ✅      sklearn ⚠️        PyTorch state_dict ❌
TF SavedModel ✅                  (needs library,   / checkpoint ❌
                                   pickle risk)      full-pickle ❌  (also unsafe)
```

Reasonable takeaways to decide from:
- **The no-code path should target the self-contained formats** (TorchScript, ONNX, TF SavedModel)
  — they load with no user code and (ONNX especially) no security risk.
- **scikit-learn is worth supporting early** for the bioinformatics/student audience — it's
  common, and it needs only the *library*, not user code (watch: pickle safety + custom
  transformers + bundled preprocessing).
- **Raw PyTorch state_dict/checkpoints are the hard case** — they need the user's model class.
  Confine them to the code-friendly UDF path, or steer users to export TorchScript/ONNX.
- **Don't forget preprocessing** — supporting "just the weights" isn't enough for many real models;
  the sklearn `Pipeline` (preprocessing + model in one) is actually the *friendliest* real-world
  unit.

This is the map for choosing what to support first vs. later.
