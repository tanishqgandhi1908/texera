# Unity Catalog vs StarRocks vs Dagster — What Texera Should Take From Each

_A design-oriented comparison, grounded in three hands-on studies
([Unity Catalog](UNITY_CATALOG_HANDSON.md) · [StarRocks](STARROCKS_HANDSON.md) ·
[Dagster](DAGSTER_HANDSON.md)). All three were installed/run locally, exercised, and read at the
source level. This distills what each teaches Texera's asset/resource design._

> **Three systems, three angles:** Unity Catalog = the **governance catalog** (assets, no compute);
> StarRocks = the **storage-compute engine** (separation + a compute "warehouse" lifecycle); Dagster
> = the **orchestrator** (assets + resources + pluggable storage/compute) — and being an orchestrator,
> **Dagster is the closest architectural sibling to Texera.** See the three-way table in
> [§ Adding Dagster](#adding-dagster--the-closest-sibling).

---

## TL;DR — they are two halves of Texera's picture

- **Unity Catalog is the *governance catalog* half.** One directory over **many asset *types***
  (tables, files/volumes, **models**, functions), with a REST API, credential-vending to storage,
  and access control — but **zero compute**. This is exactly what Texera's **asset catalog** should
  look like (models-as-assets, one `type` discriminator, storage kept separate).
- **StarRocks is the *storage-compute engine* half.** A SQL database whose **only object is a
  table**, but which shows **storage-compute separation** and a **compute resource with an on/off
  lifecycle (a "Warehouse")** — the thing UC completely lacks. This is the model for Texera's
  **computing units** as a first-class, elastic resource.

**Neither is a drop-in for Texera. Texera = UC-style multi-asset catalog + StarRocks-style
compute-as-a-resource, over Texera's existing LakeFS/MinIO + Iceberg storage.**

---

## Side-by-side

| Dimension | **Unity Catalog (OSS)** | **StarRocks** | **Texera (today / target)** |
|---|---|---|---|
| **What it is** | governance **catalog** (metadata + access, no engine) | **OLAP SQL database** (has an engine) | workflow platform: catalog + storage + compute |
| **Object types** | **many**: catalog·schema·**table·volume·model·function**·external-location·credential | **one**: catalog→database→**table** (+ view, MV) | datasets, **models**, workflows, computing units |
| **Asset extensibility** | add a **new securable type** (a `type` discriminator) | not applicable (it's tables) | wants a **`type`-per-asset** catalog (models first) |
| **Storage** | no storage of its own — points at **disk / S3 / ADLS / GCS** | **object storage** (shared-data) via a **StorageVolume**, or BE local disk (shared-nothing) | **LakeFS+MinIO** (files) + **Iceberg** (results) |
| **Compute** | **none** — engines are external | **Warehouse** = stateless compute nodes, on/off lifecycle | **computing units (k8s pods)** |
| **Storage↔compute** | separate by definition (catalog only) | **separated** (shared-data) — kill compute, data survives | separate (units read from storage) |
| **Metadata store** | a **SQL DB** (H2, swappable Postgres) — directly queryable | **BDBJE edit-log + checkpoint image** — binary, viewed via SQL | **Postgres** (directly queryable) → closer to UC |
| **API** | **REST** object CRUD (`/catalogs`, `/volumes`, `/models`, …) + **credential-vending** endpoints | **SQL over MySQL protocol** (+ HTTP for admin/loading) | REST (dataset/asset APIs) → closer to UC |
| **Reach the bytes** | **credential vending**: catalog returns *location + short-lived key*; client reads storage itself | FE/CN read the **StorageVolume** directly using its configured creds | **presigned URLs** from LakeFS ≈ UC's vending |
| **Access control** | per-securable **grants** (jCasbin), row-filtered listing, deny-by-default | SQL `GRANT`/roles | Postgres/app-layer ACLs on assets |
| **Versioning** | **model versions** (PENDING→finalize→READY, then immutable); table Delta snapshots | table snapshots; **no model/version concept** | **LakeFS commits** = immutable versions |
| **Managed vs external** | explicit flag (UC owns the path vs you point it) | storage volume = external object store | assets are "managed" (Texera owns LakeFS) |

---

## What Texera should borrow from **Unity Catalog**

1. **One catalog, a `type` per asset.** UC's 9 typed securables under one namespace validate Texera's
   plan: a single asset catalog with `type = DATASET | MODEL | …`, adding a type = a catalog change,
   not a new stack.
2. **Model-as-asset with a version lifecycle.** `RegisteredModel → versions`, each
   `PENDING → write files → finalize → READY`, and **finalized = immutable**. Texera gets immutability
   free from LakeFS commits; adopt the explicit lifecycle + a movable alias (e.g. `Champion`) later.
3. **Credential-vending shape = Texera's presigned URLs.** Catalog returns *location + short-lived,
   path-scoped key*; client reads storage directly; catalog never carries bytes. For a future
   bring-your-own-bucket, copy UC's *master-assumes-your-role + external_id* recipe.
4. **Keep compute out of the catalog.** UC deliberately has none — govern the computing unit for
   listing/sharing, but resolve/run it with its **own** lifecycle handler, never the storage path.
5. **Logical name → opaque storage path.** UC hides UUID paths behind friendly names — the same job
   as Texera's `FileResolver`. Keep the user-facing name stable and the physical path relocatable.
6. **REST object API + a queryable SQL metadata store.** UC's REST-per-type + H2/Postgres are the
   right ergonomics for a governance catalog — and match Texera's Postgres far better than StarRocks'
   binary edit-log.

## What Texera should borrow from **StarRocks**

1. **Storage-compute separation is a first-class, mainstream architecture.** Proven live: data in
   object storage, compute stateless — kill the compute, data survives. This is the pattern for
   Texera keeping **computing units** independent of stored assets.
2. **Compute as a typed resource with an on/off lifecycle — the "Warehouse."** `SHOW WAREHOUSES`
   returns a compute object with a **State** (`AVAILABLE`), running/queued work, and an
   **idle-checker** (auto-suspend). This is the concrete model for Texera's **computing units**: a
   catalogued resource that can be started/stopped/scaled, resolved by its own handler. (This is the
   compute-lifecycle UC and closed-source Snowflake couldn't show us at source depth.)
3. **StorageVolume = a named, credentialed storage binding.** A first-class object that says "here's
   an object-store location + how to reach it," which tables reference. Texera's LakeFS/MinIO binding
   is the same idea — worth naming explicitly and making reusable across asset types.
4. **One catalog spanning internal + external sources.** StarRocks' FE has `InternalCatalog` **plus**
   `ExternalCatalog` (Hive/Iceberg/JDBC) — one front over many storage backends. Reinforces routing
   file-like assets → LakeFS and table-like → Iceberg behind one catalog.
5. **A local cache in front of remote storage (`datacache`).** Stateless compute caches
   object-storage data locally. Directly relevant to Texera's model-folder materialization (fetch to
   local disk, cache by version) — StarRocks does exactly this pattern at the engine level.

---

## Adding Dagster — the closest sibling

Dagster is an **orchestrator like Texera**, so it maps more directly than the databases. Its data
model is: **assets** (the unit — a table *or* a model, in one catalog), **resources** (injected
handles to external systems/compute), **IO managers** (the storage seam — where an asset's value is
persisted), and **executors** (the compute seam — where it runs: in-process/multiprocess/**k8s**).
Metadata is a queryable SQLite→Postgres store (the `asset_keys` + `event_logs` tables).

| | Unity Catalog | StarRocks | **Dagster** | **Texera** |
|---|---|---|---|---|
| Kind | governance catalog | SQL engine | **orchestrator** | **orchestrator** |
| Central unit | typed securable | table | **asset (SDA)** | operator + asset |
| Model as first-class | ✅ | ❌ | ✅ (asset kind `model`) | ✅ (goal) |
| Storage seam | credential vending | StorageVolume | **IO Manager** (pluggable) | LakeFS/MinIO + presign |
| Compute | none | Warehouse (on/off) | **Executor** (pluggable, k8s) | computing units (pods) |
| Resource abstraction | credentials/ext-location | storage volume | **Resources** (typed, injected) | (being designed) |
| Metadata store | H2→Postgres | BDBJE log | **SQLite→Postgres** | Postgres |

**What Texera should borrow from Dagster (highest-signal, since it's a sibling):**
1. **The asset as the central unit, with a `kind` — a model is just an asset.** Same catalog +
   lineage + metadata machinery for tables and models. Validates "models as a `type`, not a subsystem."
2. **An IO-manager-like storage seam:** an operator/asset returns a value; *where it's stored*
   (LakeFS/MinIO/Iceberg) is a pluggable concern, not baked into the operator.
3. **A pluggable executor for compute:** the same graph runs locally or on k8s by swapping the
   executor — keep "where it runs" independent of "what runs." (Texera's computing units = the executor.)
4. **A typed, injected "Resource" abstraction** — exactly Texera's resource-abstraction thread: a
   LakeFS/MinIO resource, a computing-unit resource, injected where needed, resolved per type.
5. **First-class lineage + rich materialization metadata** (accuracy, row counts) per asset version —
   cheap to adopt, valuable for governance.

**Don't copy blindly:** Dagster is **code-first** (assets declared in Python at build time); Texera is
a **visual, interactive** builder. Borrow the **data model**, not the author-in-Python UX.

---

## Where each does **not** fit Texera (avoid over-borrowing)

- **StarRocks is a SQL engine, not an asset catalog.** It stores **only tables**; it has no notion of
  a model, a file volume, or a function-as-asset. Texera is **not** building a query engine, so don't
  adopt StarRocks *as* the catalog — take its **architecture ideas** (separation, Warehouse
  lifecycle, StorageVolume), not its object model.
- **StarRocks' metadata store (BDBJE binary edit-log) is the wrong choice for a governance catalog** —
  it's not directly queryable and is tuned for a DB engine's HA, not multi-asset governance. Texera's
  Postgres (like UC's SQL store) is the right call.
- **Unity Catalog has no compute at all** — so it can't teach the computing-unit lifecycle; that gap
  is exactly why we studied StarRocks. Don't expect UC to model Texera's compute.
- **Running UC or StarRocks as a dependency is not the recommendation.** Both are heavy external
  services; Texera already has Postgres + LakeFS/MinIO + Iceberg + k8s. Borrow the **patterns**, build
  on the existing stack.

---

## The synthesized picture for Texera

```
                         ┌───────────────────────────────────────────────┐
   ONE CATALOG           │  Asset/Resource Catalog  (Postgres)            │   ← UC-style: type per asset,
   (governance)          │  type = DATASET | MODEL | … | COMPUTING_UNIT   │     REST API, grants, versions,
                         │  name · owner · sharing · versions · props     │     credential/URL vending
                         └───────────────┬───────────────┬───────────────┘
                                         │ (resolve by type — a specialist per type)
                 ┌───────────────────────┘               └───────────────────────┐
                 ▼  file-like / table-like assets                                 ▼  compute
   ┌─────────────────────────────────────────────┐          ┌──────────────────────────────────────────┐
   │ STORAGE                                       │          │ COMPUTE  (StarRocks "Warehouse" model)     │
   │  files (dataset/model) → LakeFS + MinIO       │          │  computing units (k8s pods)                │
   │  results (tables)      → Iceberg              │          │  own lifecycle: start / stop / idle / scale│
   │  reached via presigned URL (≈ UC vending)     │          │  resolved by its OWN handler, NOT storage  │
   └─────────────────────────────────────────────┘          └──────────────────────────────────────────┘
```

- **Catalog layer** ← Unity Catalog: one directory, a `type` per asset, models-as-assets with
  versions, credential/URL vending, grants; **compute deliberately excluded from the storage path.**
- **Storage layer** ← Texera's existing LakeFS/MinIO (files) + Iceberg (results); a **StorageVolume-
  like** named binding is a clean abstraction to adopt.
- **Compute layer** ← StarRocks: computing units modeled as a **typed resource with an on/off/idle
  lifecycle**, resolved by their own handler — never through the file/storage resolver.

---

## Concrete recommendations / open decisions

1. **Adopt the UC catalog shape now** (models = `type = MODEL` on the asset table + a `properties`
   bag; versions via LakeFS commits; presigned-URL vending). Lowest-risk, matches the existing plan.
2. **Model computing units as a first-class catalogued resource** with an explicit **lifecycle**
   (start/stop/idle/scale) borrowed from StarRocks' Warehouse — listed in the same catalog for
   sharing/permissions, but **resolved by a compute handler, not the storage resolver.**
3. **Name the storage binding.** Introduce a StorageVolume-like object (which LakeFS repo / bucket +
   how to reach it) so datasets, models, and future asset types share one "where the bytes live"
   abstraction.
4. **Reuse the model-folder cache pattern** (StarRocks `datacache`): materialize remote asset files to
   local disk, keyed by immutable version — which the Texera prototype already does for model folders.
5. **Keep Postgres as the catalog store** (UC-style queryable SQL), not a StarRocks-style binary log.
6. **Don't build a query engine.** StarRocks is studied for its *compute-resource architecture*, not
   to be adopted as Texera's catalog or engine.

**Bottom line:** Unity Catalog shows Texera *what the asset catalog should be* (many types, models as
first-class, storage vended not carried, no compute inside). StarRocks shows *what compute should be*
(a separate, typed, on/off resource — the "warehouse"). **Dagster — the closest sibling — shows how an
orchestrator ties it together: assets (incl. models) + a typed resource abstraction + pluggable
storage (IO managers) and compute (executors) over a queryable relational catalog.** Texera's design
is the **union of all three**: a UC-style catalog over LakeFS/MinIO + Iceberg, Dagster-style
asset/resource + storage/compute seams, and StarRocks-style computing units as an independent,
on/off compute resource.
