# Extensible Asset Architecture for Texera — Literature & Design Research

**Question:** How should Texera design an *extensible asset abstraction* so user-defined ML
models are the first new asset type and future types (vector indexes, prompts, notebooks) drop
in cleanly — leveraging what LakeFS and Iceberg already provide? Grounded in academic literature,
not just vendor docs.

**Method:** deep-research pass — 5 angles, 23 sources, 111 claims extracted, 25 verified with
3-vote adversarial checking (**24 confirmed, 1 refuted**). Builds on the two prior passes
([model-as-asset](ML_MODELS_RESEARCH_FINDINGS.md), [engine feature-depth](ASSET_STORAGE_ENGINE_RESEARCH.md)).

---

## The core answer

**Adopt a catalog-vs-storage split as the architectural pattern:** one generic **Asset** entity
(id, `type` discriminator, owner, versions, shared fields) + a **per-type typed-metadata
mechanism**, living in a **catalog layer (Postgres)** decoupled from **pluggable byte stores**
(LakeFS for file-like assets — models, artifacts; Iceberg for table-like structured data). This
maps *directly* onto Texera's existing Postgres-metadata + LakeFS/Iceberg-byte-store arrangement
— it's a generalization of what's already there, not a rebuild.

The literature is unanimous that **one entity abstraction can span many heterogeneous asset
types**, and one system (Apache Gravitino) is direct proof for ML-models-as-a-cataloged-type.

---

## 1 · What the literature establishes

**One generic entity spans many asset types** *(verified 3-0)*
- **GOODS** (Google, SIGMOD 2016) — hides format variety behind ONE uniform "dataset" concept +
  central catalog, spanning files, Bigtable, Spanner, DB servers, and APIs. Notably **post-hoc &
  non-intrusive**: it crawls independent byte stores and builds a catalog *above* them.
  ([paper](https://research.google.com/pubs/archive/45390.pdf))
- **Sawadogo & Darmont survey** (JIIS 2021) — explicitly generalizes "dataset" into a
  type-agnostic **"object"** abstraction (tables, documents, images, video) as the single unit
  metadata attaches to — *precisely the conceptual move Texera needs.*
  ([survey](https://link.springer.com/article/10.1007/s10844-020-00608-7))
- **DataHub GMA** — every type (Dataset, User, Chart, **Model**) is a generic **Entity = type
  discriminator + URN + metadata aspects**, reusing one abstraction rather than per-type schemas.
  ([model](https://docs.datahub.com/docs/metadata-modeling/metadata-model))

**Apache Gravitino = direct proof of Texera's exact goal** *(verified 3-0)*
- Stated goal, verbatim: *"unify the data management in both data and AI assets, including raw
  files, models, etc."* It models **Table, Fileset, Model, Topic** as distinct first-class objects
  in ONE `metalake → catalog → schema → entity` hierarchy, the leaf **discriminated by type**.
- ML models use the **same 3-level namespace** as tables/filesets, adding only a `model → version`
  sub-level. Shipped Apache TLP feature (v1.2.x, 2025-26) — **a new asset type is a
  type-discriminated entity, not a new hierarchy.**
  ([overview](https://gravitino.apache.org/docs/1.2.0/overview/),
  [model catalog](https://gravitino.apache.org/docs/1.2.1/model-catalog/))

**The catalog-vs-storage split is the right pattern** *(verified 3-0)*
- **Lakehouse** (Armbrust et al., CIDR 2021) — key idea: store data in a cheap object store in an
  open format, implement a **transactional metadata layer on top** that defines which objects
  belong to a version. Versioning/ACID live in the *metadata* layer; bulk data stays cheap.
  ([paper](https://people.eecs.berkeley.edu/~matei/papers/2021/cidr_lakehouse.pdf))
- GOODS separates **per-asset salient metadata** (owner, schema, timestamps) from **cross-asset
  relational metadata** (provenance, similarity) — a useful split for Texera's metadata model.

**The metadata layer is where governance & validation belong** *(verified 3-0)*
- Lakehouse: the metadata layer is the natural place for **access control + audit** (gate access
  before issuing object-store credentials) AND **data-quality enforcement** (Delta's schema
  enforcement + constraints API). → Justifies centralizing per-type asset validation in Texera's
  catalog layer, and using **OSS LakeFS pre-commit/pre-merge hooks** for upload-time validation
  (e.g. enforce model file format / IO-signature) — generalizable to any asset type's rules.

## 2 · The data-model decision (the crux for the discussion)

Three options, all preserving the **shared-common-fields + per-type-specific-fields** split —
they differ in *how per-type metadata is stored*:

| Option | Mechanism | Add a new type | Trade-off |
|---|---|---|---|
| **(a) Single entity + typed groups / JSON properties** (GOODS) | One row per asset; common metadata GROUPS (Basic, Content, Provenance, …) or a JSONB `properties` bag | Add keys to the bag — **no schema change** | Simplest; weak typing/validation on per-type fields |
| **(b) Entity-aspect** (DataHub) | Generic entity + composable, **independently-versioned aspects**; ALL aspects for ALL types in ONE `metadata_aspect_v2` table keyed by (urn, aspect, version) | Declare entity/aspect in a **YAML registry** (new aspect also needs a schema) | Most flexible & future-proof; heaviest to build |
| **(c) Table-per-type / data-vault** (Nogueira et al., DOLAP 2018) | Common metadata in **hubs**, per-type in **satellites** | *"any new type… stored in a new satellite"* — a **new table per type** | Strong relational typing; the current per-type-table pain, formalized |

Texera's near-term `type=MODEL`-reusing-the-dataset-table plan is essentially **(a) in embryo**.
The question is whether to make (a) deliberate (add a `type` + `properties` JSONB) or invest in
(b) for the long "many future assets" horizon.

## 3 · Postgres vs. external catalog *(verified 3-0)*

**Delta Lake** (VLDB 2020) frames Texera's exact choice:
- *"just a bunch of objects"* (directories of files) → tool-agnostic but **no atomicity across
  objects, no versioning/audit**.
- **strongly-consistent external metadata service** → governance + speed, but needs a **running
  HA service**, adds query overhead, risks **provider lock-in**.
- **Nessie** applies Git branch/commit/tag semantics to *catalog* metadata and offers
  **cross-table transactions** (one atomic commit spanning many tables) — connects to using OSS
  LakeFS branches for **atomic multi-file model uploads**.
  ([Delta](https://people.eecs.berkeley.edu/~matei/papers/2020/vldb_delta_lake.pdf),
  [Nessie](https://projectnessie.org/))

⚠️ **Refuted claim (1-2):** that a transaction-log-in-the-object-store needs *no* always-on
metadata server. **Do not assume the versioning/metadata layer can live purely in the byte store
without any coordinating service** — Texera's Postgres catalog *is* that coordinating service, and
keeping it is well-justified.

## 4 · Recommendation for Texera — incremental, matches the no-new-tables plan

**Build now (Phase 1 — ships models, minimal):**
- `type` discriminator (`DATASET`|`MODEL`) + a **`properties` JSONB** on the existing asset row —
  this is data-model option (a), done deliberately. Per-type metadata for models:
  `framework`, `format/flavor`, `IO signature`, `alias`. No new tables (matches the plan).
- Reuse the LakeFS/MinIO byte store + `dataset://`-style path for the file-like MODEL type.
- Route by the existing **`DocumentFactory`/`VirtualDocument`** seam — a MODEL is a file-like
  asset, so it rides the LakeFS path; structured assets would route to Iceberg. Keep that routing
  seam explicit.

**Design for (don't necessarily build) — future extensibility:**
- Treat the `type` + `properties` seam as the *generic Asset* abstraction (GOODS/Gravitino
  pattern) so vector indexes / prompts / notebooks attach as new `type` values + property shapes,
  **not new tables**.
- Adopt **OSS LakeFS hooks** for upload-time, per-type validation (generalizes "enforce model
  format on upload" to any asset), and **branches → merge** for atomic multi-file version creation.
- Keep the catalog in **Postgres** (justified over an external catalog service by Delta Lake's
  trade-off analysis); revisit an external/versioned catalog only if cross-asset transactions or
  multi-engine governance become real needs.

## 5 · Key decisions the GitHub discussion should raise

1. **Data model:** single-table + `type` + JSONB properties (a) — vs. DataHub entity-aspect (b)
   — vs. table-per-type/data-vault (c). *Recommendation: (a) now, architected so (b) is a
   non-breaking future migration.* (Open Q: at what scale does (a)→(b) become necessary?)
2. **Version identity:** reuse the **LakeFS commit** as the canonical version, or layer an
   **app-level auto-increment + mutable alias** (Champion/Latest) on top — and how each is
   addressed by a stable URI.
3. **File-like vs table-like routing:** the concrete rule + seam behind the single Asset
   abstraction that sends models/artifacts → LakeFS and structured data → Iceberg. Can one asset
   ever span both engines?
4. **Where validation lives:** which per-type rules (model format, IO-signature) are enforceable
   purely via OSS LakeFS **hooks** over the byte store, vs. which need catalog-layer logic in
   Postgres (cross-asset / relational context).
5. **Metadata store:** confirm Postgres-as-catalog vs. an external/versioned catalog (Nessie-style),
   using Delta Lake's running-service / lock-in / atomicity trade-offs.

## Caveats
- **Scope transfer:** GOODS and Lakehouse/Delta concern heterogeneous dataset *formats* and
  structured *tables*, not arbitrary asset types — applying them to a model/prompt/notebook
  abstraction is a faithful *generalization*, not the papers' stated scope. **Gravitino is the only
  source literally covering ML-models-as-a-cataloged-type**, so model-specific claims lean on it.
- DataHub/Gravitino/Nessie claims rest on primary *vendor* docs (authoritative for their own
  architecture, not independent evaluation). The DataHub GMA repo is somewhat legacy (registry
  mechanism evolved; the entity+aspect *primitive* is unchanged).
- Data-vault's mechanism is a **new satellite table per type** — the table-per-type arm, the
  *opposite* of a JSONB bag; don't conflate the two even though both keep the common/specific split.
