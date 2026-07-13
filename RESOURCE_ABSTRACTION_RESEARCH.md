# Resource Abstraction — How Catalogs Model & Resolve Heterogeneous Resources

_Answers meeting Q1: at a lower (API/data-model) level, what resources do Unity Catalog, Apache
Gravitino, Google GOODS, and Delta/Lakehouse support, what APIs resolve them, and what abstraction
should Texera adopt so non-file resources (e.g. computing units) fit — instead of the current
single `dataset`-table path→file mapping._

**Method:** deep-research pass — 6 angles, 24 sources, 109 claims, 25 verified 3-vote (24 confirmed,
1 refuted). Primary API refs + papers.

---

## The answer in one line

Every system uses the same lower-level pattern: **a typed entity (securable) identified by a
multi-level logical name, plus a PER-TYPE RESOLVER that turns that name into a physical location
(+ scoped credentials) — NOT a single path→file map.** And **all four keep raw compute OUT of the
storage-resolution layer** — compute is a separate control plane that *consumes* the catalog.

So Texera's fix is: generalize the `dataset` path-mapping (and the `VirtualDocument`/`DocumentFactory`
seam) into a **typed-resource + per-type-resolver registry**. Files → storage location + creds;
models → artifact path; tables → metadata pointer; **computing units → URI + lifecycle via their own
resolver** (in the catalog for listing/governance, but bypassing the file-path resolver).

---

## What each system supports + how it resolves (lower level)

| System | Resource types | How a name resolves to bytes/target |
|---|---|---|
| **Unity Catalog** | OSS: catalog, schema, **table, volume, function, model**. Databricks superset ~19 securables (+ external location, storage credential, connection, **service**, …) — all are typed **"securables"** | **Metadata-only control plane — never serves bytes.** Per-type **credential-vending** endpoints: `temporary-table-credentials` (by `table_id`), `temporary-path-credentials` (by `url`), `temporary-volume-credentials` (by `volume_id`) → return **storage URL + short-lived token**; client reads storage directly. Tables via **Iceberg REST `loadTable`** → `metadata-location` + vended creds. |
| **Apache Gravitino** (closest analogue) | Metalake→Catalog→Schema→**Entity**; entity types **Table, Fileset, Model, Topic** — leaf type discriminated by the **parent catalog's type** (`type=FILESET`) | **Fileset** carries a physical `storageLocation`; the logical **`gvfs://…` path** is resolved to physical storage by **GVFS** (a Hadoop-compatible FileSystem) at read time, via a priority hierarchy (fileset → schema → catalog). This is *exactly* Texera's logical-path→file mapping, generalized behind a resolver. |
| **Google GOODS** | One crawled, **post-hoc "dataset"** concept over 6+ backends (GFS, Bigtable, Spanner, DB servers, APIs, files) | Catalog entry = a Bigtable row **keyed by path whose prefix selects the storage system** (`/bigtable/…`, `/gfs/…`); each backend has **its own crawler/handler** ("its own type of metadata and access characteristics"). Acquires "how to access" by **crawling**, not registration. |
| **Delta / Lakehouse** | Tables | Table resolves by **replaying `_delta_log`** (JSON actions: `metaData` + `add`/`remove` file actions), not a static path map. The metastore only maps table **name → metadata location**. |

**The one refuted claim (0-3):** "all UC assets share a uniform three-level `catalog.schema.name`
reference." False — paths/external-locations and some securables are addressed differently. This
*strengthens* the conclusion: even within one system, **resolution is per-type, not uniform.**

## Two findings that matter most for Texera

**1. Typed entity + per-type resolver (the "better abstraction").** None of these systems use one
universal path map. Each resource TYPE has its own way to resolve: a file → storage location +
creds; a table → `metadata.json` → log/manifest replay; a model → artifact path/version; a function
→ code; compute → an endpoint. The catalog holds the typed entity + governance; the *resolver* is
type-specific.

**2. Compute is kept out of the storage-resolution abstraction.** UC's OSS API has zero compute
types; clusters/warehouses "consume" UC, aren't cataloged by it. *(One wrinkle: Databricks recently
added a `SERVICE` securable for model-serving/MCP endpoints — the sole precedent for cataloging a
compute-like/endpoint resource, and it uses its own securable type + resolver, not the file-path
one.)* → **Texera's computing units belong in the catalog for listing/governance, but must NOT ride
the file-path resolver — they need their own lifecycle/endpoint resolver.**

**3. (Corollary) Resolve to location + creds, don't proxy bytes.** All four hand back a
*location + scoped credential* and let the client fetch directly — the catalog never streams data.
**Texera already does exactly this** (presigned URLs from LakeFS). So the current data-plane fetch
is the right, scalable choice — we generalize *around* it, not replace it.

---

## Recommendation for Texera

Generalize the single `dataset`-table path-mapping into a **typed-resource registry + per-type
resolvers** — an elevation of the `VirtualDocument`/`DocumentFactory` scheme routing that already
exists.

```mermaid
flowchart TB
  R["Resource (catalog entry)<br/>id · TYPE · owner · name · versions · properties"]
  R --> DISP{resolve by TYPE<br/>(per-type resolver)}
  DISP -->|DATASET / MODEL / VENV| FR["File resolver<br/>logical path → LakeFS storageLocation<br/>+ presigned URL (fetch bytes)"]
  DISP -->|RESULT| IR["Table resolver<br/>→ Iceberg metadata pointer<br/>(snapshot scan)"]
  DISP -->|COMPUTING_UNIT| CR["Compute resolver<br/>→ URI + resource limits + lifecycle<br/>(create/start/stop/status) — NO bytes"]
  FR --> S1["LakeFS + MinIO"]
  IR --> S2["Iceberg"]
  CR --> S3["K8s pod / endpoint"]
```

- **One catalog** (the generalized asset/resource table) for listing, sharing, governance — spans
  all types (this is what Texera's dashboard `UnifiedResourceSchema` already gestures at).
- **Per-type resolver** replaces the monolithic `FileResolver`: file-like types resolve to a LakeFS
  location + presigned URL (today's path); tables resolve to an Iceberg pointer; **computing units
  resolve to a URI + lifecycle via a compute handler that returns no bytes.**
- **`DocumentFactory` is already a nascent per-type resolver** (routes by URI scheme) — the move is
  to make it a first-class typed-resource registry keyed on the `type` discriminator.

### Key design decisions for the GitHub discussion
1. **Type-discriminator placement** — a per-entity field (UC `securable_type`) vs. a per-container
   type (Gravitino `catalog type=FILESET`). Texera → a per-entity `type` column is simplest.
2. **Register vs. crawl** — UC/Gravitino register "how to access"; GOODS crawls it. Texera →
   register (we control uploads).
3. **Resolver returns location+creds, not bytes** — all four favor this; Texera already does
   (presigned URLs). Keep it — it's what stays scalable.
4. **Compute in the catalog but off the file-path resolver** — computing units get a catalog entry
   (listing/governance/sharing) + their own lifecycle/endpoint resolver; they do NOT get a LakeFS
   path. (Matches the "share a catalog view, not a resolution mechanism" point from the last meeting.)
5. **Per-type versioning** — dataset file versions vs. model versions vs. Iceberg/Delta snapshots
   shouldn't be forced into one version model; each type's resolver owns its version semantics.

## Open questions (carried forward)
- Gravitino's **provider/connector SPI** at the code level (the Java interfaces a new type
  implements) and how closely it maps to `DocumentFactory` — worth a targeted code-level look.
- The exact shape of Databricks' **`SERVICE` securable** (create/resolve/lifecycle) — the one
  real precedent for cataloging a compute-like/endpoint resource, closest to a computing unit.
- The **compute resolver contract** for Texera units (create/start/stop/status/endpoint) — none of
  the four fully model a runtime-lifecycle resource; this is ours to design.
- Unifying **versioning** across heterogeneous types without forcing one version semantics.

## Caveats
- UC/Databricks move fast: volume credential vending, Iceberg REST write, and the `SERVICE`
  securable are **Public Preview**; endpoint versions (2.0/2.1) and the ~19 securable count may drift.
- Gravitino docs cited are v1.0–1.2; v1.3+ adds nested namespaces beyond strict three levels and a
  plural `storageLocations` map (singular still valid).
- GOODS is a 2016 **crawl-based** system — a useful *contrast* (post-hoc discovery), not a template
  for Texera's register-on-upload model.
- A couple of UC claims had 2-1 wording splits but were confirmed by stronger primary Databricks docs.
