# StarRocks — Hands-On Notes (a system with BOTH storage AND compute, explained simply)

_A real hands-on log, done **2026-07-13**. Unity Catalog showed us the **catalog/storage** half but has
**no compute**. StarRocks is the opposite kind of system — an **MPP OLAP database that has storage
AND compute in one system** — and it can run in two modes, which is exactly what makes it useful for
us: **shared-nothing** (storage + compute glued together) and **shared-data** (storage and compute
**separated**, the Snowflake-style design). We ran **both**, saw where the bytes actually land, read
the source, and killed the compute to prove the separation._

> **Why we care (Texera):** the open question is how to model **compute** as a resource (Texera's
> "computing units") alongside storage, and whether to separate them. StarRocks is a live, readable
> example of storage-compute separation — including a **"Warehouse"** compute abstraction with an
> on/off lifecycle, the thing UC completely lacks.

Versions: StarRocks **4.1.1** (shared-nothing, allin1 image) and **4.0** (shared-data compose:
FE + CN + MinIO). Source cloned at `~/starrocks-src` (840 MB) to read the internals.

---

## Part 0 · One-paragraph summary

> StarRocks splits into two roles: the **FE (Frontend)** is the **catalog + brain** — it holds all
> metadata (databases, tables, columns) and plans queries; the **BE/CN (Backend / Compute Node)** is
> the **muscle** — it stores data and runs the query. In **shared-nothing** mode the BE keeps table
> data on its **own local disk** (storage and compute glued together — classic MPP). In **shared-data**
> mode the data instead lives in **object storage (S3/MinIO)** and the compute nodes become
> **stateless** — you can kill them and the data is safe; StarRocks even calls a group of compute
> nodes a **"Warehouse"** (same word Snowflake uses). So StarRocks shows both halves in one product:
> a metadata catalog (FE), a storage layer, and a **compute layer you can turn on/off independently**.

---

## Part 1 · The two modes, in plain words

Think of a library:

- **Shared-nothing** = every librarian keeps their own books on the shelf **behind their own desk**.
  Fast (books are right there), but the books and the librarian are **tied together** — lose the desk,
  lose the books; add a librarian and you must also move books to them.
- **Shared-data** = all books live in **one central warehouse** (object storage). Librarians
  (compute) keep **no permanent books** — they fetch what they need (and keep a small cache). Now you
  can **add or remove librarians freely**, and losing one loses **nothing** — the books are in the
  warehouse.

Shared-data is the Snowflake/"cloud-native" design: **storage and compute scale (and fail)
independently**. That independence is the whole point.

| | Shared-nothing | Shared-data |
|---|---|---|
| Where table data lives | **BE local disk** | **object storage (S3/MinIO)** |
| Compute node | **BE** (has data) | **CN** (stateless, caches only) |
| Kill a compute node → | you can lose that data copy | **data is safe** (it's in the object store) |
| Scale compute | tied to moving data | **add/remove CN freely** |
| StarRocks calls compute | Backends | **Warehouses** (Snowflake's word) |

---

## Part 2 · Setup (copy-paste)

Both need Docker + a MySQL client (`sudo apt-get install -y docker.io mariadb-client`). StarRocks
speaks the **MySQL protocol** on port **9030**, so you talk to it with the plain `mysql` client.

**Shared-nothing (one container):**
```bash
sudo docker run -d --name starrocks --privileged -p 9030:9030 -p 8030:8030 -p 8040:8040 \
  starrocks/allin1-ubuntu:latest
mysql -h127.0.0.1 -P9030 -uroot -e "SELECT current_version();"
```

**Shared-data (FE + CN + MinIO via compose):**
```bash
mkdir sr-shared-data && cd sr-shared-data
curl -O https://raw.githubusercontent.com/StarRocks/demo/master/documentation-samples/quickstart/docker-compose.yml
sudo docker compose up --detach --wait --wait-timeout 240
# then create a storage volume pointing at the bundled MinIO and make it default (see Part 5)
```

---

## Part 3 · The architecture — FE (catalog) vs BE/CN (storage+compute)

From the source (`~/starrocks-src`), the two roles are clean:

**FE = Frontend = the catalog + planner (Java, `fe/fe-core/.../com/starrocks/`)**
- `catalog/` — the metadata objects: `Database` → `Table` (`OlapTable`, `LakeTable`,
  `MaterializedView`) → `Partition` → `Column`. This is StarRocks' object model (the analog of UC's
  securables).
- `catalog/InternalCatalog` + `catalog/ExternalCatalog` — StarRocks has its **own "catalog"
  concept**: an internal catalog (native tables) **plus external catalogs** (Hive, Iceberg, JDBC…).
  So one FE can front **many storage sources** — the "one catalog over many things" pattern again.
- `journal/` + `journal/bdbje/` — **how metadata is persisted**: an **edit log in BerkeleyDB-JE**
  (`BDBJEJournal`) plus periodic **checkpoint images** (`CheckpointWorker`). Multiple FEs replicate
  this log (Raft-like) for HA.
- `planner/`, `qe/` — parse and plan the SQL, then hand execution to the BE/CN.

**BE / CN = Backend / Compute Node = storage + compute (C++, `be/src/`)**
- `storage/` — the columnar storage engine (tablets, segments, the `.dat` files).
- `exec/` — the query execution (the actual compute).
- `fs/` — filesystem access, including **object storage** (S3) for shared-data.
- `cache/`, `datacache/` — local cache of remote (object-storage) data in shared-data mode.

**We saw the FE metadata on disk** (matches the source):
```
fe/meta/bdb/00000000.jdb     <- the BerkeleyDB-JE edit log (every metadata change)
fe/meta/image/               <- checkpoint snapshots + ROLE + VERSION
```
→ **This is StarRocks' catalog store** — the same *role* as UC's H2 / Texera's Postgres, but built
as a replicated edit-log instead of a SQL table.

---

## Part 4 · Shared-nothing — data lives on the compute node's local disk

What we ran and saw:

```sql
CREATE DATABASE demo;
CREATE TABLE demo.people (id INT, name VARCHAR(50), city VARCHAR(50))
  DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 3 PROPERTIES('replication_num'='1');
INSERT INTO demo.people VALUES (1,'alice','irvine'),(2,'bob','LA'),(3,'carol','SF');
SELECT city, count(*) FROM demo.people GROUP BY city;   -- runs on the BE
```

The table was split by `HASH(id)` into **3 buckets → 3 tablets** (`SHOW TABLETS`: 10007, 10009,
10011, all on `BackendId 10001`). On the BE's **local disk** the actual columnar segments appeared:

```
be/storage/data/<shard>/<tablet_id>/<schema_hash>/<segment>.dat
  e.g. .../data/0/10007/774573613/0200...c2a599_0.dat
```

**Takeaway:** the data (`.dat` segments) sits on the **BE's own disk**, and the query runs on that
same BE. **Storage and compute are the same machine** — fast, but coupled.

---

## Part 5 · Shared-data — data moves to object storage, compute goes stateless

We brought up **FE + CN + MinIO**, then pointed StarRocks at MinIO with a **storage volume**:

```sql
CREATE STORAGE VOLUME def_volume TYPE = S3
LOCATIONS = ('s3://starrocks/')
PROPERTIES (
  'enabled'='true','aws.s3.region'='us-east-1',
  'aws.s3.endpoint'='http://minio:9000',
  'aws.s3.access_key'='...','aws.s3.secret_key'='...',
  'aws.s3.enable_path_style_access'='true'
);
SET def_volume AS DEFAULT STORAGE VOLUME;
```

Then the **same** table + insert as before. Two things were now different:

1. **No Backends, only a Compute Node:** `SHOW BACKENDS` → empty; `SHOW COMPUTE NODES` → 1 CN alive.
2. **The DDL now names the storage volume + a cache:**
   ```
   "storage_volume" = "def_volume",
   "datacache.enable" = "true"
   ```
3. **The data bytes landed in MinIO, not on local disk** (`mc ls -r my/starrocks/`):
   ```
   s3://starrocks/<uuid>/db10002/10004/10006/data/0000...c1.dat      <- the columnar segment
   s3://starrocks/<uuid>/db10002/10004/10006/meta/...meta            <- tablet metadata
   s3://starrocks/<uuid>/db10002/10004/10006/log/...logs
   ```
   Same kind of `.dat` segment as before — but in the **object store**. The CN keeps only a **local
   cache** (`datacache`), not the source of truth.

From the source, this is `LakeTable extends OlapTable`: its storage is a **`StorageVolume`** (object
store location + credentials) via a `FilePathInfo`, plus a `DataCacheInfo`; the tablet↔object mapping
and node management go through **StarOS** (`lake/StarOSAgent`, `SharedDataStorageVolumeMgr`).

---

## Part 6 · The compute lifecycle — "Warehouse" (Snowflake's word), proven by killing it

The best demo: **stop the compute, and watch storage survive.**

```
CN up            → SELECT count(*) FROM demo.people;  → 3          (works)
docker stop CN   → SHOW COMPUTE NODES → Alive: false
                 → SELECT count(*) ...;  →  ERROR 5904: Warehouse default_warehouse is not available.
docker start CN  → CN Alive: true again
                 → SELECT ... → 3 rows back            (data was safe in MinIO the entire time)
```

Two things this nails:

- **Compute is a first-class, disposable resource called a "Warehouse."** `SHOW WAREHOUSES` returns
  `default_warehouse` with a **State** (`AVAILABLE`), `NodeCount`, `RunningSql`, `QueuedSql`. Kill its
  nodes → the warehouse is **not available** → queries fail. This is exactly Snowflake's *virtual
  warehouse*, and it's the compute-lifecycle concept **Unity Catalog has no notion of.**
- **Storage is independent of compute.** The data never moved — it's in MinIO. Compute is
  turn-off-and-on-able without touching storage.

In the source there's a whole `warehouse/` package: `Warehouse.java`, `DefaultWarehouse.java`, and
notably **`WarehouseIdleChecker.java`** — the mechanism behind **auto-suspend** (detect an idle
warehouse and scale it down). *Honest caveat:* multiple **named** warehouses with full
**suspend/resume + elastic autoscaling** is a StarRocks **Enterprise** feature; **OSS** ships the
single `default_warehouse` + the underlying elasticity (add/remove CN via `ALTER SYSTEM ADD COMPUTE
NODE`) and the idle-checker framework. But the **abstraction and lifecycle are real and visible in
OSS**, which is the point.

---

## Part 7 · How StarRocks compares to Unity Catalog and Texera

| Layer | **Unity Catalog (OSS)** | **StarRocks (shared-data)** | **Texera** |
|---|---|---|---|
| Catalog / metadata | the whole product (a DB: H2/Postgres) | **FE** (BDBJE edit-log + image) | Postgres |
| Storage (bytes) | you point it at disk/S3 (no layer of its own) | **object storage** via a **StorageVolume** (+ CN datacache) | **LakeFS + MinIO** |
| Compute | **none** (engines are external) | **CN grouped into a "Warehouse"** with an on/off lifecycle | **computing units (pods)** |
| Storage↔compute | separate by design (catalog only) | **separated** (shared-data) or **coupled** (shared-nothing) | separate (units read from storage) |

**The lesson for Texera's resource abstraction:**
- StarRocks confirms **storage-compute separation is a mainstream, first-class architecture**, not
  exotic — and that **compute deserves its own typed resource with a lifecycle** (the "Warehouse"),
  distinct from the storage/catalog path.
- That maps directly onto the design we'd been sketching: **catalog (Postgres) + storage
  (LakeFS/MinIO) + compute as its own resource with an on/off lifecycle (computing units)** — with
  compute resolved by its *own* handler, never the storage path.
- The **StorageVolume** concept (a named, credentialed object-storage location the engine reads from)
  is the same idea as UC's credential-vending and Texera's LakeFS/MinIO binding — a clean, reusable
  "where + how to reach the bytes" object.

---

## Appendix · Current running state & how to poke it

- **Shared-data stack** (running): `cd ~/sr-shared-data && sudo docker compose ps` — `starrocks-fe`,
  `starrocks-cn`, `minio`. SQL: `mysql -h127.0.0.1 -P9030 -uroot`.
  - MinIO console: http://localhost:9001 (user `miniouser` / pass `miniopassword`), bucket `starrocks`.
  - Demo objects: `demo.people` (a shared-data / LakeTable), storage volume `def_volume` → MinIO.
- **Handy SQL:** `SHOW FRONTENDS` · `SHOW COMPUTE NODES` · `SHOW WAREHOUSES` · `SHOW STORAGE VOLUMES`
  · `SHOW TABLETS FROM demo.people` · `SHOW CREATE TABLE demo.people`.
- **See data in object storage:** `sudo docker exec minio sh -c "mc alias set my http://localhost:9000 miniouser miniopassword; mc ls -r my/starrocks/"`.
- **Compute-lifecycle demo:** `sudo docker stop starrocks-cn` → query fails (`Warehouse ... not
  available`) → `sudo docker start starrocks-cn` → query works, data intact.
- **Stop everything:** `cd ~/sr-shared-data && sudo docker compose down` (add `-v` to also delete the
  MinIO data). Source to read stays at `~/starrocks-src`.

**Bottom line:** StarRocks is the counterpart to Unity Catalog — where UC is *catalog + storage, no
compute*, StarRocks is *catalog + storage + compute*, and its **shared-data mode + Warehouse** show
storage-compute separation and a real compute lifecycle in open source, which is exactly the compute
half UC (and, closed-source, Snowflake) couldn't show us at this depth.
