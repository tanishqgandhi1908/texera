# LakeFS & Iceberg — Feature Depth vs. Texera's Current Usage

**Question:** What do LakeFS and Apache Iceberg actually offer, how do OSS projects leverage
those features, and which capabilities is Texera currently *not* using? Framed against
Texera's two-stack storage architecture — **infrastructure only, no ML-model concepts.**

**Method:** deep-research pass — 5 angles, 21 sources, 96 claims extracted, 25 verified with
3-vote adversarial checking (**25/25 confirmed**, 1 partial correction noted). Sources are
primary vendor docs unless flagged.

---

## ⚠️ The finding that changes a prior recommendation

**lakeFS Mount (Everest) is Enterprise/Cloud-only — it is NOT in open-source lakeFS.**
It requires lakeFS Enterprise ≥ 1.25.0 or a lakeFS Cloud account; the Everest binary is
obtained by contacting Treeverse. *(verified 3-0, multiple primary sources incl.
[mount docs](https://docs.lakefs.io/reference/mount.html),
[enterprise](https://docs.lakefs.io/enterprise/))*

→ In the earlier (model-focused) research I floated "migrate the Python worker to lakeFS Mount
for lazy/partial loads." **That's off the table** unless Texera adopts Enterprise. Since Texera
runs **OSS lakeFS**, the current design — read metadata from lakeFS, then pull bytes directly
from object storage via **presigned URLs** — *is exactly lakeFS's own recommended decoupled
data-access pattern* ([architecture](https://docs.lakefs.io/understand/architecture/)). So the
Python-over-HTTP presign path is **the right minimal choice, not a gap.** The OSS alternative
to Mount is `lakectl local` (git-like clone/pull), but that's a *full* local download, not lazy
prefetch — no advantage over presigned fetch for single-file reads.

---

## LakeFS — OSS-free vs. Enterprise-gated (decision-critical)

| Capability | Tier | Notes |
|---|---|---|
| Repositories, commits, **branches**, **merge**, **tags** | **OSS ✅** | Core Git-like versioning |
| **Hooks** (pre-commit / pre-merge) | **OSS ✅** | Only 2 event types; error return **blocks** the op |
| Configurable **garbage collection** | **OSS ✅** | Runs as a **Spark job** you operate yourself |
| `lakectl local` (clone/init/pull/checkout/commit/status) | **OSS ✅** | Full download, git-like |
| Presigned URLs / decoupled data access | **OSS ✅** | What Texera already uses |
| **lakeFS Mount (Everest)** — lazy/byte-range mount | **Enterprise 🔒** | ≥1.25.0 or Cloud only |
| **RBAC** / fine-grained access control | **Enterprise 🔒** | OSS has no role-based access control |
| SSO (SAML, ADFS, SCIM) | **Enterprise 🔒** | ⚠️ *OIDC SSO works in OSS* — only SAML/ADFS/LDAP gated (1 verifier correction) |
| lakeFS-as-**Iceberg REST Catalog** | **Enterprise 🔒** | Would unify the two stacks — but paid |
| Standalone/managed GC, metadata search, transactional mirroring | **Enterprise 🔒** | |

**Feature details (all verified):**
- **Hooks** support *exactly two* events — `pre-commit` and `pre-merge`; returning an error
  blocks the operation. This is lakeFS's "CI/CD for data" / data-quality-gate mechanism
  ([hooks](https://lakefs.io/blog/lakefs-hooks/)).
- **GC** removes (1) committed objects deleted/replaced and expired per retention rules, and
  (2) inaccessible uncommitted objects — via a **Spark program** in OSS (operational cost:
  needs a Spark environment) ([GC](https://docs.lakefs.io/v1.62/howto/garbage-collection/gc/)).
- **Branch → validate → merge** is lakeFS's Write-Audit-Publish: write to an isolated branch so
  `main` stays untouched, then **publish atomically via merge**
  ([WAP](https://lakefs.io/blog/how-to-implement-write-audit-publish/)).

## Iceberg — feature depth

- **The catalog is the governance boundary.** An Iceberg catalog is the authoritative metadata
  registry mapping each table → its current `metadata.json`; it owns discovery, atomic
  pointer-swap commits, and namespacing. Access rules set **once at the catalog** are enforced
  uniformly across every engine that connects — securing at the catalog level beats per-engine
  config ([catalog governance](https://medium.com/data-engineering-with-dremio/a-brief-guide-to-the-governance-of-apache-iceberg-tables-7c0a50316e22),
  [Nessie/Polaris](https://www.dremio.com/blog/why-thinking-about-apache-iceberg-catalogs-like-nessie-and-apache-polaris-incubating-matters/)).
- **Native branches & tags (Iceberg ≥ 1.2.0)** — branches are independent, mutable snapshot
  histories; tags are immutable named snapshots. This is the recommended way to do **WAP**:
  write to a staging/audit branch invisible to consumers, run data-quality checks, then publish
  to `main` via a **metadata-only fast-forward merge** (discard the branch if checks fail)
  ([Iceberg branching](https://iceberg.apache.org/docs/latest/branching/),
  [Dremio WAP](https://www.dremio.com/blog/streamlining-data-quality-in-apache-iceberg-with-write-audit-publish-branching/)).
- **Catalog-level versioning (Nessie / Polaris)** goes further: Git-style branches/commits/merge
  across *multiple tables at once* — versioning the whole catalog, not per-table bytes
  ([Nessie](https://lakefs.io/blog/nessie-catalog/)).
- **Maintenance has a strict order** — expire snapshots → remove orphan files → rewrite
  manifests. Running orphan cleanup *before* snapshot expiry can delete files live snapshots
  still reference → **data loss**. High-frequency streaming commits without compaction explode
  file counts (~432k files/day at 5 files/commit every second)
  ([runbook](https://iomete.com/resources/blog/iceberg-maintenance-runbook)).

## The general OSS pattern

**Catalog = metadata/governance layer; storage engine = bytes/versioning.** Both LakeFS and the
Iceberg-catalog world converge on this split: lakeFS versions *bytes* and clients read directly
from object storage; the catalog (Nessie/Polaris/REST) governs *metadata pointers* and is where
access control + multi-table atomicity live. **Versioning migrates up to the catalog** (Nessie
branches, lakeFS branches) rather than living in the file layer.

---

## Map back to Texera (the two-stack architecture)

### Stack A — Datasets on LakeFS (OSS)
| Unused OSS feature | What it would buy Texera | Verdict |
|---|---|---|
| **Branches + merge** | Staged, **atomic multi-file** version uploads: stage on an ephemeral branch, validate, merge to `main` in one atomic step — instead of staging files directly on `main` (current) | **Worth evaluating** — buys atomicity + isolation for large/partial uploads |
| **Hooks (pre-commit/pre-merge)** | Server-side **validation gate on version creation** — enforce file-type/schema/size rules for *any* asset type at commit time, not just in app code | **Worth evaluating** — generalizes cleanly to new asset types |
| **Tags** | Human-friendly immutable version labels instead of raw commit hashes (`version_hash`) | Minor nicety |
| **Mount (Everest)** | Lazy/byte-range reads in the worker | **Not available (Enterprise)** — current presign path is correct |
| **RBAC** | Fine-grained per-asset access control in the storage layer | **Not available (Enterprise)** — Texera's ACLs stay in Postgres/app layer |

### Stack B — Workflow results on Iceberg
| Unused feature | What it would buy | Verdict |
|---|---|---|
| Branches / tags / **WAP** | Validate results on a staging branch before publishing | **Likely overkill** — results are ephemeral runtime data (expired to last snapshot); current append-only + snapshot-scan is the right minimal choice |
| Catalog as governance layer | Central access control across engines | Texera has one engine + app-layer ACLs; low value today |
| Schema/partition evolution, views, metadata tables | Analytical flexibility | Not needed for the current write-once/read-stream results use case |

### The actual "new asset type" pain is app-layer, not engine-layer
Neither LakeFS nor Iceberg features remove Texera's real friction: adding an asset type today
means **a new Postgres table + URI scheme + `FileResolver` branch + `Document` class**. That's a
Texera abstraction gap around the **`VirtualDocument` / `DocumentFactory`** seam — the engines
won't solve it. The transferable *idea* from the OSS world is the **catalog-vs-storage split**:
a single generic "asset registry" (metadata + type + governance) over a shared byte/version
store, rather than a bespoke stack per type.

---

## Key takeaways for the design discussion

1. **Confirm the lakeFS tier first.** Mount, RBAC, SSO(SAML), and lakeFS-as-Iceberg-catalog are
   all **Enterprise-gated**. Any design assuming them needs a licensing decision. On OSS, the
   presigned-URL fetch Texera already uses is the endorsed pattern — don't "fix" it.
2. **lakeFS hooks + branches are the two OSS features most worth adopting** — a pre-commit
   validation hook + branch-per-upload-then-merge gives atomic, validated version creation that
   generalizes to *every* future asset type. Cost: operational (hooks infra) + added write path
   complexity.
3. **Texera's Iceberg usage is already appropriately minimal** for ephemeral results; branches/
   WAP/evolution add complexity without a matching need. Don't adopt them speculatively.
4. **The extensibility win is architectural, not from engine features** — a generic
   asset/resource abstraction over the `VirtualDocument`/`DocumentFactory` seam (catalog-vs-storage
   split), so a new asset type is a registration, not a new stack.
5. **Operational gotchas to respect:** OSS GC needs Spark; Iceberg maintenance is order-sensitive
   (wrong order → data loss) and high-frequency commits need compaction.

## Caveats
- SSO tiering is nuanced: **OIDC SSO works in OSS lakeFS**; only SAML/ADFS/LDAP connectors are
  Enterprise-gated (one verifier refuted the blanket "all SSO is Enterprise" claim).
- Several WAP/catalog-comparison sources are vendor blogs (Dremio/lakeFS), though the core
  branch/tag/WAP mechanics are corroborated by primary Iceberg docs.
- lakeFS Mount tiering was cross-checked across doc versions v1.60–v1.80 and the OSS community
  docs site itself — consistently Enterprise/Cloud-only.
