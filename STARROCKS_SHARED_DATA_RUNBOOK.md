# StarRocks Shared-Data — Runbook (run it, view it, see the metadata)

_Focused on **shared-data mode only** (storage and compute separated: data in object storage, compute
in stateless nodes). Step-by-step to **run locally**, **view the data**, and **view the metadata** —
plus what StarRocks actually stores and how you "call" it. For the deeper writeup see
[STARROCKS_HANDSON.md](STARROCKS_HANDSON.md)._

Prereqs (one-time): `sudo apt-get install -y docker.io docker-compose-v2 mariadb-client`

---

## 1. Run it (FE + CN + MinIO, one compose)

The official quickstart compose brings up everything: the **FE** (catalog/brain), a **CN** (stateless
compute), **MinIO** (the object storage), and a helper that creates the MinIO bucket + access key.

```bash
mkdir -p ~/sr-shared-data && cd ~/sr-shared-data
curl -O https://raw.githubusercontent.com/StarRocks/demo/master/documentation-samples/quickstart/docker-compose.yml
sudo docker compose up --detach --wait --wait-timeout 240
```

Check it's healthy:
```bash
sudo docker compose ps          # minio, starrocks-fe, starrocks-cn all "healthy"
```

Confirm it's really **shared-data** (compute node present, **no** backends):
```bash
mysql -h127.0.0.1 -P9030 -uroot -e "SHOW COMPUTE NODES\G"   # 1 node, Alive: true
mysql -h127.0.0.1 -P9030 -uroot -e "SHOW BACKENDS\G"        # empty  <-- no local-disk storage nodes
```

### Point StarRocks at MinIO (one-time: create the storage volume)
This tells StarRocks "put table data in this S3/MinIO bucket." The MinIO creds/bucket come from the
compose file (`miniouser`/`miniopassword`, bucket `starrocks`, service key `AAAA…`/`BBBB…`).
```bash
mysql -h127.0.0.1 -P9030 -uroot <<'SQL'
CREATE STORAGE VOLUME def_volume TYPE = S3
LOCATIONS = ('s3://starrocks/')
PROPERTIES (
  'enabled'='true',
  'aws.s3.region'='us-east-1',
  'aws.s3.endpoint'='http://minio:9000',
  'aws.s3.access_key'='AAAAAAAAAAAAAAAAAAAA',
  'aws.s3.secret_key'='BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'aws.s3.enable_path_style_access'='true'
);
SET def_volume AS DEFAULT STORAGE VOLUME;
SQL
```

### Create a table and put data in it
```bash
mysql -h127.0.0.1 -P9030 -uroot <<'SQL'
CREATE DATABASE IF NOT EXISTS demo;
CREATE TABLE demo.people (id INT, name VARCHAR(50), city VARCHAR(50))
  DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 3;
INSERT INTO demo.people VALUES (1,'alice','irvine'),(2,'bob','LA'),(3,'carol','SF');
SELECT city, count(*) FROM demo.people GROUP BY city;
SQL
```

### Stop / start
```bash
cd ~/sr-shared-data
sudo docker compose stop           # pause everything
sudo docker compose start          # resume
sudo docker compose down           # remove containers (add -v to also wipe MinIO data)
```

---

## 2. View the data (two ways)

**a) Query it (the normal way — this is the "API", see §4):**
```bash
mysql -h127.0.0.1 -P9030 -uroot -e "SELECT * FROM demo.people;"
```

**b) See the actual files sitting in object storage (the whole point of shared-data):**

- **In the browser — MinIO console:** open **http://localhost:9001**, log in `miniouser` /
  `miniopassword`, open bucket **`starrocks`**. You'll see the table's files under
  `<uuid>/db.../.../data/*.dat` (columnar segments), `meta/`, `log/`.
- **On the command line:**
  ```bash
  sudo docker exec minio sh -c \
    "mc alias set my http://localhost:9000 miniouser miniopassword >/dev/null 2>&1; mc ls -r my/starrocks/"
  ```
  Example output — the data lives in MinIO, not on a local disk:
  ```
  <uuid>/db10002/10004/10006/data/0000...c1.dat     <- the columnar data segment
  <uuid>/db10002/10004/10006/meta/...meta           <- tablet metadata
  ```

---

## 3. View the metadata

> Important difference from Unity Catalog: UC kept its metadata in a **SQL database (H2)** you could
> open and query directly. StarRocks keeps its metadata in the **FE's BerkeleyDB-JE edit log**
> (`fe/meta/bdb/*.jdb`), which is a **binary log, not human-readable**. So you **view StarRocks
> metadata through SQL**, not by opening a file.

**a) The standard way — SQL `SHOW` + `information_schema`:**
```bash
mysql -h127.0.0.1 -P9030 -uroot <<'SQL'
SHOW CATALOGS;                                  -- top level (default_catalog = internal)
SHOW DATABASES;                                 -- databases
SHOW TABLES FROM demo;                          -- tables in a database
SHOW CREATE TABLE demo.people\G                 -- full DDL (note: storage_volume=def_volume)
DESC demo.people;                               -- columns + types
SELECT * FROM information_schema.tables WHERE table_schema='demo';   -- portable metadata view
SHOW STORAGE VOLUMES;                           -- where data is stored (the MinIO volume)
SHOW WAREHOUSES\G                               -- the COMPUTE resource + its state
SHOW COMPUTE NODES\G                            -- the actual compute nodes in the warehouse
SHOW TABLETS FROM demo.people;                  -- how the table is split into tablets
SQL
```

**b) The FE HTTP API (admin/monitoring — needs basic auth `root:`):**
```bash
curl -s -u root: "http://localhost:8030/api/show_meta_info?action=SHOW_DB_SIZE"   # DB sizes
curl -s        "http://localhost:8030/metrics" | head                            # Prometheus metrics
```

**c) See where the metadata physically lives (not readable, just to know it's there):**
```bash
sudo docker exec starrocks-fe sh -c "ls -la /opt/starrocks/fe/meta/bdb /opt/starrocks/fe/meta/image"
#   bdb/00000000.jdb  = the edit log (every metadata change)
#   image/            = periodic checkpoint snapshots
```

---

## 4. What StarRocks stores, and how you "call" it

### It stores **SQL tables only** — not models or files
StarRocks is an **OLAP SQL database**, so its object model is just:
```
catalog  ->  database  ->  table   (also: view, materialized view)
```
- It stores **structured, columnar table data** — rows and columns.
- **No ML models, no arbitrary-file "volumes", no functions-as-assets** (that was Unity Catalog's
  world). If you want to store a model or a raw CSV *as a governed object*, StarRocks is the wrong
  tool — it wants that data as **table rows**.
- It *can* also **query external tables** (Hive, Iceberg, JDBC) via `CREATE EXTERNAL CATALOG`, but
  those are still **tables**.

### "Compute" here = running **SQL**
The compute (the Warehouse / CN nodes) does **SQL execution** — scans, filters, joins, aggregations.
It is **not** "load a model and run inference." Compute is tied to querying tables.

### The API = **SQL over the MySQL wire protocol**
There is **no REST object-CRUD API** like Unity Catalog's `/catalogs`, `/volumes`, `/models`.
You interact with StarRocks by **sending SQL**:
- **Port 9030 (MySQL protocol)** — the main interface. Use the `mysql` client, or any MySQL driver
  (JDBC/Python/Go…). Everything — create table, insert, query, `SHOW`, grant — is SQL.
- **Port 8030 (FE HTTP)** — a *secondary* HTTP API for **admin/monitoring/loading**, not object CRUD.
  Examples: `/metrics`, `/api/show_meta_info`, `/api/show_proc`, and **Stream Load** starts here.
- **Port 8040 (CN/BE HTTP)** — **data loading** endpoint (Stream Load), e.g.:
  ```
  curl --location-trusted -u root: -H "label:job1" -H "column_separator:," \
       -T people.csv http://localhost:8040/api/demo/people/_stream_load
  ```

**One-line contrast with Unity Catalog:**
> UC = a **governance catalog** with a **REST API** over many asset *types* (tables, files, models,
> functions), and **no compute**. StarRocks = a **SQL database** whose only object is a **table**,
> whose **API is SQL**, and which **has compute** (a Warehouse) that runs those SQL queries.

---

## 5. The 60-second shared-data demo

1. `sudo docker compose up --detach --wait` → `SHOW COMPUTE NODES` (compute) + `SHOW BACKENDS` (empty).
2. Create the `def_volume` storage volume → `SHOW STORAGE VOLUMES`.
3. Create `demo.people`, insert 3 rows, `SELECT`.
4. Open MinIO **http://localhost:9001** (`miniouser`/`miniopassword`) → bucket `starrocks` → see the
   `.dat` files. **The data is in object storage.**
5. `sudo docker stop starrocks-cn` → run a query → `ERROR 5904: Warehouse default_warehouse is not
   available` (compute gone). `sudo docker start starrocks-cn` → query works, **data was safe in
   MinIO the whole time.** ← storage and compute are independent.
