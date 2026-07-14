# Dagster — Hands-On Notes (the closest architectural sibling to Texera)

_A real hands-on log, done **2026-07-13**. Unity Catalog was a **governance catalog** (assets, no
compute); StarRocks was a **SQL engine** (storage+compute separation). **Dagster is an
orchestrator — like Texera itself** — and it's built around exactly the two things Texera is trying
to abstract: **assets** (including models) and **resources** (connections to external systems,
including compute). We installed it, wrote a demo with real assets (a table, a derived table, and an
**ML model**), materialized them, viewed the asset catalog + lineage, **opened its metadata store
(SQLite)**, and read the source for the key abstractions._

Version: Dagster **1.13.13** (pip). Demo project: `~/dagster-demo/demo.py`. Metadata home:
`~/dagster-demo/dagster_home`.

---

## Part 0 · One-paragraph summary

> Dagster is a data **orchestrator** whose central idea is the **Software-Defined Asset (SDA)**: you
> declare each **asset** (a table, a file, an **ML model**) as a Python function, and Dagster tracks
> its **lineage, metadata, and materializations** in an **asset catalog**. Two clean seams keep it
> flexible: **IO Managers** decide *where the asset's bytes are stored* (separating compute from
> storage), and **Executors** decide *where the compute runs* (in-process, multiprocess, Docker,
> **Kubernetes**). **Resources** are injected handles to external systems (a DB, S3, a warehouse).
> Metadata lives in **SQLite by default, Postgres in production**. In short: an asset catalog +
> resource abstraction + storage/compute separation — **the same shape Texera is designing.**

---

## Part 1 · The four abstractions, in plain words

1. **Software-Defined Asset (SDA)** — the unit of everything. An asset is "a thing that persists" (a
   table, a model) produced by a function. You don't orchestrate *tasks*; you declare *assets* and
   Dagster figures out the order from their dependencies. **Different kinds of assets — a table and a
   model — live in the same catalog.** (This is Texera's "models as assets," native.)
2. **Resource** — a handle to an **external system or config**, injected into assets: a database
   connection, an S3 client, a compute endpoint. (Texera's "resource abstraction": a connection to
   LakeFS/MinIO, or a computing unit.)
3. **IO Manager** — the **storage seam**. Your asset function just `return`s a Python value; the IO
   manager decides *how/where to persist it* (local file, S3, a warehouse table) and how to load it
   back for downstream assets. **Compute logic is decoupled from storage.**
4. **Executor** — the **compute seam**. The same asset graph can run in-process, across processes, or
   on **Docker/Kubernetes** — swap the executor, not the assets. **Orchestration is decoupled from
   the compute backend.**

---

## Part 2 · Setup + the demo

```bash
python3 -m venv ~/dagster-venv && ~/dagster-venv/bin/pip install dagster dagster-webserver
export DAGSTER_HOME=~/dagster-demo/dagster_home && mkdir -p "$DAGSTER_HOME"
cd ~/dagster-demo
dagster dev -f demo.py            # UI on http://localhost:3000
```

The demo (`demo.py`) defines **four assets of different kinds** + a **resource**:
```
raw_people      (kind: table)   ← a resource "storage" is injected here
   │
   ├── city_counts   (kind: table)     -- derived aggregation
   │
sentiment_model (kind: model)          -- an ML MODEL asset, same catalog as the tables
   │
   └────────────┬──────────────
                ▼
           predictions (kind: table)   -- depends on BOTH raw_people AND sentiment_model
```
Each asset attaches **metadata** (row counts, model `accuracy`/`framework`, a table preview). Lineage
is automatic — a downstream asset just names the upstream asset as a function parameter.

---

## Part 3 · What we ran

**Materialize everything (headless CLI):**
```bash
dagster asset materialize --select '*' -f demo.py
```
The log shows the whole story:
- assets ran in dependency order (`raw_people` → `city_counts`; `raw_people` + `sentiment_model` →
  `predictions`);
- each value was **persisted by the IO manager**:
  `Writing file at: .../dagster_home/storage/raw_people using PickledObjectFilesystemIOManager`;
- downstream assets **loaded inputs via the IO manager** (not by re-running upstream);
- each asset emitted an `ASSET_MATERIALIZATION` event with its metadata.

**In the UI (http://localhost:3000):**
- **Catalog → Assets:** all four assets listed with their **group** (`data`, `ml`), **kind**
  (table/model), and **status**.
- **Global Asset Lineage:** the DAG drawn automatically — `predictions` fanning in from
  `raw_people` + `sentiment_model`.
- Click an asset → its **materialization history + metadata** (e.g. `accuracy = 0.91`).

---

## Part 4 · The storage seam (IO Manager) — compute vs storage, made concrete

The asset functions returned plain Python objects. The **IO manager** persisted them — we can see the
actual files:
```
~/dagster-demo/dagster_home/storage/
   raw_people   city_counts   sentiment_model   predictions      <- the pickled asset values
```
From the source (`_core/storage/io_manager.py`), the seam is two methods:
```python
class IOManager:
    def handle_output(self, context, obj): ...   # persist the asset's value
    def load_input(self, context): ...           # fetch it for a downstream asset
```
Swap the IO manager (filesystem → S3 → a warehouse table) and **the asset code doesn't change**.
This is exactly the "compute returns a value; storage is a separate, pluggable concern" idea — the
same separation Texera wants between an operator's logic and where its output lands.

---

## Part 5 · The compute seam (Executor)

From the source (`_core/executor/`): `Executor(ABC)` with `InProcessExecutor`, `MultiprocessExecutor`
(what our run used), and `step_delegating/` — the base for the **Docker/Kubernetes** executors
(`dagster-k8s`, `dagster-docker`), which run **each asset step in its own container/pod**. So the same
asset graph can move from a laptop to k8s by swapping the executor. **Compute is a pluggable backend,
separate from the asset definitions** — directly analogous to Texera running operators on computing
units (pods).

---

## Part 6 · The metadata store (the catalog) — SQLite, like UC's H2

Dagster keeps its metadata in a **relational DB**, SQLite by default, **Postgres in production**
(swap via `dagster.yaml`) — the same H2→Postgres story as Unity Catalog. What we found in
`~/dagster-demo/dagster_home`:

```
history/runs.db            -> runs table (our __ASSET_JOB run = SUCCESS), snapshots, run_tags, kvs
history/runs/index.db      -> the ASSET CATALOG: `asset_keys` + `event_logs` + asset_event_tags
schedules/schedules.db     -> schedules/sensors state
```
The **asset catalog is literally the `asset_keys` table**:
```
["raw_people"]       last_materialization  2026-07-13 22:57:43
["city_counts"]      last_materialization  2026-07-13 22:57:45
["sentiment_model"]  last_materialization  2026-07-13 22:57:43
["predictions"]      last_materialization  2026-07-13 22:57:45
```
plus the `event_logs` table holding every materialization + its metadata. (Source:
`SqliteRunStorage`, `SqliteEventLogStorage`; Postgres equivalents ship in `dagster-postgres`.)

**Contrast:** UC = one table per asset *type* (queryable SQL); StarRocks = a binary BDBJE edit-log;
Dagster = **`asset_keys` + `event_logs`** (queryable SQL). Dagster and UC both keep a **directly
queryable relational catalog** — like Texera's Postgres.

---

## Part 7 · How Dagster compares (and why it's the closest sibling)

| | Unity Catalog | StarRocks | **Dagster** | **Texera** |
|---|---|---|---|---|
| Kind of system | governance catalog | SQL engine | **orchestrator** | **orchestrator** |
| Central abstraction | securable (typed) | table | **asset (SDA)** | operator + asset |
| Models as first-class? | ✅ (model securable) | ❌ | ✅ (an asset of kind `model`) | ✅ (goal) |
| Storage seam | credential vending | StorageVolume | **IO Manager** | LakeFS/MinIO + presign |
| Compute | none | Warehouse | **Executor** (in-proc/multiproc/**k8s**) | computing units (pods) |
| Resource abstraction | credentials/external-loc | storage volume | **Resources** (injected) | (being designed) |
| Metadata store | H2 → Postgres | BDBJE log | **SQLite → Postgres** | Postgres |
| Lineage | basic (deps) | query plans | **first-class asset lineage** | workflow DAG |
| API | REST | SQL | Python defs + GraphQL/UI | REST + UI |

---

## Part 8 · Texera takeaways (the highest-signal of the three studies)

Because Dagster is an **orchestrator like Texera**, its abstractions map almost one-to-one:

1. **The asset is the right central unit — and a model is just an asset with a `kind`.** Dagster puts
   a `table` asset and a `model` asset in the *same* catalog with the *same* lineage/metadata
   machinery. This validates Texera's "models as a `type` of asset, not a new subsystem."
2. **Separate storage from compute with an IO-manager-like seam.** An operator/asset should `return`
   a value; *where it's stored* (LakeFS/MinIO/Iceberg) should be a **pluggable, swappable** concern —
   not baked into the operator. Dagster's `handle_output`/`load_input` is a clean template.
3. **Make compute a pluggable executor.** Dagster runs the *same* asset graph in-process or on k8s by
   swapping the executor. Texera's computing units are the executor backend — keep that seam explicit
   so where-it-runs is independent of what-runs.
4. **A "Resource" abstraction is exactly what Texera's resource-abstraction thread wants.** Dagster
   resources are typed, injected handles to external systems (a store, a compute endpoint). This is
   the concrete shape for Texera's "typed resource + per-type resolver": a LakeFS/MinIO resource, a
   computing-unit resource, each injected where needed.
5. **Keep the catalog a directly-queryable relational DB** (`asset_keys` + events in SQLite→Postgres).
   Matches Texera's Postgres and UC's H2 — and is far better for governance than StarRocks' binary log.
6. **First-class lineage + materialization metadata** (accuracy, row counts, previews) is a feature
   Texera could adopt cheaply for assets — each asset version carrying rich, queryable metadata.

**Where Dagster differs from Texera (so don't copy blindly):** Dagster is **code-first** (assets are
Python declarations, orchestration is build-time), while Texera is a **visual, interactive** workflow
builder with live execution. So borrow Dagster's **data model** (assets, resources, IO managers,
executors) — not its author-in-Python UX.

---

## Appendix · Running state & how to poke it

- **Dagster UI:** running at **http://localhost:3000** (`dagster dev`, `DAGSTER_HOME` at
  `~/dagster-demo/dagster_home`). Note: the lineage view is a heavy canvas; the **Catalog → Assets**
  list is the easiest to read.
- **Re-materialize:** `dagster asset materialize --select '*' -f ~/dagster-demo/demo.py` (with
  `DAGSTER_HOME` exported).
- **See stored asset values:** `ls ~/dagster-demo/dagster_home/storage/`.
- **Query the catalog DB:**
  `python3 -c "import sqlite3;[print(r) for r in sqlite3.connect('$HOME/dagster-demo/dagster_home/history/runs/index.db').execute('SELECT asset_key,last_materialization_timestamp FROM asset_keys')]"`
- **Stop:** `pkill -f "dagster dev"`.

**Bottom line:** Of the three systems, Dagster is the **closest to Texera** — an orchestrator whose
whole design is *assets + resources + pluggable storage (IO managers) + pluggable compute
(executors)*, over a relational catalog. It's the best template for Texera's asset/resource
abstraction; UC adds the governance/credential-vending polish, and StarRocks adds the compute-
lifecycle ("warehouse") thinking.
