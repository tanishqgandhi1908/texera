# Unity Catalog OSS — Hands-On Notes (ran it, hit the API, made a CSV asset)

_Not theory — this is what happened running Unity Catalog v0.5.0 locally on 2026-07-13, with the
real requests/responses. Ends with what Texera should borrow._

## Setup (reproducible, 8 GB-friendly — no Docker, small JVM)
```bash
git clone --depth 1 https://github.com/unitycatalog/unitycatalog.git ~/unitycatalog-src
cd ~/unitycatalog-src
# one-time fix: the Etsy checkstyle sbt plugin has a commons-collections conflict on this box.
# In project/Checkstyle.scala make `compileJavastyle := { }` a no-op (skips checkstyle).
build/sbt -mem 1536 "server/package"                       # builds server jar + classpath file
java -Xmx512m -cp "$(cat server/target/classpath)" io.unitycatalog.server.UnityCatalogServer
# → REST API on http://localhost:8080/api/2.1/unity-catalog   (auth disabled by default)
```
No prebuilt tarball exists for v0.5.0; you build from source. The server is a small JVM (512 MB heap
was plenty). It ships a sample catalog `unity` and stores everything on the **local filesystem**
under `etc/data/` by default.

## The object model — confirmed live

3-level namespace `catalog.schema.object`. The securable types the server actually governs (from
`SecurableType.java`): **METASTORE · CATALOG · SCHEMA · TABLE · FUNCTION · VOLUME · REGISTERED_MODEL ·
EXTERNAL_LOCATION · CREDENTIAL**. (Note: **no compute type at all.**)

| Term | What it is | Live example (`GET`) |
|---|---|---|
| **Catalog** | top container | `unity` — `GET /catalogs` |
| **Schema** | group in a catalog | `unity.default` — `GET /schemas?catalog_name=unity` |
| **Table** | structured data = a **Delta table** (Parquet + `_delta_log`) | `unity.default.numbers`: `table_type=EXTERNAL`, `data_source_format=DELTA`, `table_id` (uuid), `columns=[as_int INT, as_double DOUBLE]`, `storage_location=file:///…/numbers` |
| **Volume** | a **folder of files** (unstructured) | `unity.default.txt_files` (MANAGED) → holds `a.txt`, `b.txt`; `storage_location=file:///…` |
| **Function** | registered code | `unity.default.sum` → `routine_definition: "t = x + y + z\nreturn t"` |
| **Model** | registered model + versions | `GET /models` → `[]` (none in sample, endpoint works) |

Every object carries **managed vs external**: *managed* = UC owns the storage path
(`etc/data/managed/…`); *external* = you point it at a location you control (`etc/data/external/…`).

## The REST API — confirmed structure

Plain REST, base `…/api/2.1/unity-catalog`, one path per type, addressed by **full name**:
```
/catalogs        /catalogs/{name}
/schemas         /schemas/{full_name}          full_name = unity.default
/tables          /tables/{full_name}           unity.default.numbers
/volumes         /volumes/{name}
/functions       /models  + /models/{full_name}/versions/{version}/finalize
/permissions/{securable_type}/{full_name}   /credentials   /external-locations   /metastore_summary
```
**Credential vending** (the "how a client reaches the bytes" seam), one per storage type:
```
POST /temporary-table-credentials    {table_id, operation}
POST /temporary-volume-credentials   {volume_id, operation}
POST /temporary-path-credentials     {url, operation}
POST /temporary-model-version-credentials
```

## What I created from scratch (the CSV cycle)
```bash
printf 'name,age\nalice,30\nbob,25\ncarol,41\n' > /tmp/uc_demo/people.csv
POST /catalogs   {"name":"texera_demo"}                         → id, created_at
POST /schemas    {"name":"s1","catalog_name":"texera_demo"}     → full_name texera_demo.s1
POST /volumes    {"name":"csv_files", ... "volume_type":"EXTERNAL",
                  "storage_location":"file:///tmp/uc_demo"}     → volume_id, storage_location
GET  /catalogs   → ["texera_demo","unity"]                      # my catalog shows up
```
**"Reading" = resolve then read:** ask the catalog for the volume's `storage_location`
(`file:///tmp/uc_demo`), go there, read the bytes (`cat people.csv` → the 3 rows). The catalog never
serves the data.

## Storage vs compute — settled by running it
- **Credential vending returned all-null creds** (`aws/azure/gcp` = null) for our objects — because
  storage is the **local filesystem**, which needs no token. On **cloud** storage (`s3.*`, `adls.*`,
  `gcs.*` in `server.properties`) it returns a real short-lived credential + the location. Either
  way, the client then reads storage **directly**.
- **Zero compute.** `server.properties` has no compute settings; the API has no compute endpoints;
  the server source has no serving/cluster classes. The only `warehouse` hit in the code is
  Iceberg-REST-catalog terminology (which catalog to use), not compute. → OSS Unity Catalog is a
  **pure catalog/governance layer**; engines (Spark/DuckDB/…) run the compute and just consume the
  catalog + vended creds.

---

## What Texera should borrow (concrete)

1. **Typed-securable model over a 3-level name** — one server, a fixed set of typed objects
   (`type` discriminator) under `catalog.schema.object`. Validates Texera's "asset with a `type`" +
   the shared catalog table. Texera's analog: `owner/name/version` already is a 3-level-ish name.
2. **CRUD-per-type REST API with full-name addressing** — clean template for a generalized Texera
   **Asset API** (`GET/POST /asset`, `/asset/{full_name}`), instead of dataset-only endpoints.
3. **Credential vending = exactly Texera's presigned-URL fetch.** The catalog returns *location +
   (for cloud) a short-lived credential*; the client reads storage itself. Texera already does this
   with LakeFS presigned URLs — so we're aligned with the reference design, not behind it.
4. **`managed` vs `external`** is a useful explicit flag. Texera assets are "managed" (Texera owns
   the LakeFS storage). Worth naming, and it leaves room for "bring-your-own-bucket" later.
5. **Volumes = the folder-of-files primitive** — this is precisely Texera's dataset/model-folder.
   Our model-as-asset maps onto UC's `REGISTERED_MODEL` (with versions) or a volume of files.
6. **Keep compute out of the catalog** — UC confirms it: catalog the computing unit for
   listing/governance, but resolve it with its own lifecycle handler, never the storage/creds path.
7. **Iceberg REST catalog is built in** (`IcebergRestCatalogService`) — relevant since Texera is
   Iceberg-native, but recall the earlier finding: OSS UC's Iceberg REST is read-mostly/preview.

**Next:** Snowflake (the storage-vs-compute + warehouse-lifecycle angle). It's heavier than UC — I'll
use the free trial / SnowSQL rather than anything local, since 8 GB won't run a Snowflake-like engine.
The UC clone + built jar stay on disk; restart the server anytime with the command in Setup.
