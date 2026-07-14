# Unity Catalog — Demo Runbook (copy-paste commands)

_A short cheat-sheet for a live demo: **start the server**, **show the name→location mapping in the
H2 database**, and a **plain-English API reference**. For the deep write-up see
[UNITY_CATALOG_HANDSON.md](UNITY_CATALOG_HANDSON.md)._

Everything lives at `~/unitycatalog-src`. Java is already installed.

```bash
# one line to set Java (needed in every fresh shell before starting the server)
export JAVA_HOME=/usr/lib/jvm/java-1.17.0-openjdk-amd64
```

---

## 1. Start / stop the server (and CLI + UI)

### Start the server
```bash
cd ~/unitycatalog-src
export JAVA_HOME=/usr/lib/jvm/java-1.17.0-openjdk-amd64
bin/start-uc-server
```
- REST API comes up on **http://localhost:8080**.
- Leave this terminal running. (First time only, if the jar is missing: `build/sbt package`.)
- Quick check (another terminal): `curl -s http://localhost:8080/api/2.1/unity-catalog/catalogs | jq`

### Use the command-line tool (CLI)
```bash
cd ~/unitycatalog-src
bin/uc catalog list
bin/uc schema  list --catalog texera_ml
bin/uc volume  list --catalog texera_ml --schema ml
bin/uc model   list --catalog texera_ml --schema ml
```

### Start the web UI (optional, for the visual demo)
```bash
cd ~/unitycatalog-src/ui
yarn start          # serves the UI on http://localhost:3000  (first time only: yarn install)
```
Open **http://localhost:3000**. (The UI needs `server.authorization=disable` — the default — or it
can't log in without Google.)

### Stop everything
```bash
pkill -f "unitycatalog.server.UnityCatalogServer"   # stops the server
pkill -f "react-scripts"                             # stops the UI
# verify both are down:
ss -ltn | grep -E ':8080|:3000' || echo "both stopped"
```

---

## 2. Show the name→location mapping in the H2 database

> The catalog is just a small database that maps **a name → where the bytes live on disk**. Here's how
> to open it and see that.

**IMPORTANT: stop the server first.** H2 is a single-file database and the running server locks it —
you can't open a second connection while it's up.

```bash
# 0) stop the server (see above), then:
export JAVA_HOME=/usr/lib/jvm/java-1.17.0-openjdk-amd64
cd ~/unitycatalog-src

# 1) locate the H2 jar (already downloaded during the build)
H2JAR=$(tr ':' '\n' < server/target/classpath | grep -m1 '/h2-')

# 2) a tiny helper: run any SQL against the DB (user + password are BOTH empty)
uc_sql() {
  java -cp "$H2JAR" org.h2.tools.Shell \
    -url "jdbc:h2:file:$PWD/etc/db/h2db;IFEXISTS=TRUE" -user "" -password "" -sql "$1"
}
```

Now query it:

```bash
# every kind of object has its own table
uc_sql "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='PUBLIC' ORDER BY TABLE_NAME;"

# THE MAPPING — name -> storage location:
uc_sql "SELECT NAME, VOLUME_TYPE, STORAGE_LOCATION FROM UC_VOLUMES;"                 # files/folders (e.g. the CSV)
uc_sql "SELECT NAME, TYPE, DATA_SOURCE_FORMAT, URL FROM UC_TABLES;"                  # Delta tables
uc_sql "SELECT NAME, MAX_VERSION_NUMBER, URL FROM UC_REGISTERED_MODELS;"            # models
uc_sql "SELECT VERSION, STATUS, URL, SOURCE FROM UC_MODEL_VERSIONS;"                # model versions
```

**What you'll see (the point of the demo):** each row is `name → a path on disk`. Example:

```
UC_VOLUMES
  people_csv | EXTERNAL | file:///home/tanishq/uc-demo-csv        <- the CSV folder
  artifacts  | MANAGED  | file:///home/tanishq/uc-managed/__unitystorage/.../volumes

UC_MODEL_VERSIONS
  1 | READY | file:///home/tanishq/uc-managed/__unitystorage/.../models/.../versions/...
```

So "resolve a name" = **look up that row and return the location**. The DB holds only the pointer; the
files live on disk. (Other tables: `UC_CATALOGS`, `UC_SCHEMAS`, `UC_COLUMNS`, `UC_FUNCTIONS`,
`UC_USERS`, and `CASBIN_RULE` = the permission grants.)

**When done, restart the server** (`bin/start-uc-server`) so the API/UI work again.

> Tip: to reset the whole demo to a clean slate, stop the server and delete `etc/db/h2db.mv.db`
> (and the demo folders `~/uc-managed`, `~/uc-demo-csv`). The sample `unity` catalog is re-seeded on
> next start.

---

## 3. API reference — what each call does (plain English)

Base URL (data plane): `http://localhost:8080/api/2.1/unity-catalog`
Login/users (control plane): `http://localhost:8080/api/1.0/unity-control`

### The mental model
Every call is either **"manage the directory entry"** (create/list/get/delete an object) or
**"get access to the bytes"** (credential vending). The catalog **never sends the file itself** — for
data you get a *location + a temporary key* and read storage yourself.

### Catalog structure (the 3-level namespace `catalog.schema.object`)
| Call | What it does |
|---|---|
| `GET /catalogs` · `POST /catalogs` · `GET/PATCH/DELETE /catalogs/{name}` | list / create / manage **catalogs** (top-level folders). `POST` with `storage_root` to allow managed objects inside. |
| `GET /schemas?catalog_name=` · `POST /schemas` · `.../{full_name}` | list / create / manage **schemas** (sub-folders). |

### The things inside a schema
| Call | What it does |
|---|---|
| `GET /tables?catalog_name=&schema_name=` · `GET /tables/{full_name}` · `POST /tables` · `DELETE` | **tables** = structured Delta data. UC stores only *metadata* (columns + location); an engine writes the Delta files. |
| `GET /volumes?...` · `POST /volumes` · `.../{name}` | **volumes** = a folder of any files (csv, images, …). `MANAGED` = UC picks the folder; `EXTERNAL` = you point it at your path. |
| `GET /functions?...` · `POST /functions` · `.../{name}` | **functions** = saved code snippets. UC stores the text; it does **not** run them. |
| `GET /models?...` · `POST /models` · `GET/PATCH/DELETE /models/{full_name}` | **registered models** = a named container for model versions. |
| `POST /models/versions` · `GET /models/{full_name}/versions[/{n}]` · `PATCH .../{n}/finalize` | **model versions**: create (status `PENDING`) → you write files → **finalize** (→ `READY`, then immutable). |

### Getting to the bytes (credential vending)
| Call | What it does |
|---|---|
| `POST /temporary-volume-credentials` | body `{volume_id, operation: READ_VOLUME\|WRITE_VOLUME}` → returns a **location + short-lived cloud key**. On local `file://` it returns nulls (no key needed — just read the path). |
| `POST /temporary-table-credentials` | same idea for a table (`table_id`, `operation`). |
| `POST /temporary-model-version-credentials` | same for a model version (`catalog/schema/model/version`, `operation`). Refuses on local `file://` and refuses **write** on a finalized version. |
| `POST /temporary-path-credentials` | a key for an arbitrary storage path. |

### Governance
| Call | What it does |
|---|---|
| `GET /permissions/{securable_type}/{full_name}` | list who has which privilege on an object. |
| `PATCH /permissions/{securable_type}/{full_name}` | grant/revoke, body `{changes:[{principal, add:[...], remove:[...]}]}`. Only enforced when `server.authorization=enable`. |
| `POST /scim2/Users` (control plane) | create a user in UC's local database. |
| `POST /auth/tokens` (control plane) | token exchange for login. |
| `GET /credentials` · `GET /external-locations` | the cloud identities + governed paths used for vending (cloud setups). |
| `GET /metastore_summary` | info about the whole metastore (the top of the tree). |

### The two example flows (end to end)

**Read a CSV (a volume):**
```bash
B=http://localhost:8080/api/2.1/unity-catalog
LOC=$(curl -s "$B/volumes/texera_ml.ml.people_csv" | jq -r .storage_location)   # 1. ask WHERE
cat "${LOC#file://}/people.csv"                                                  # 2. read it
```

**Read a model version:**
```bash
B=http://localhost:8080/api/2.1/unity-catalog
LOC=$(curl -s "$B/models/texera_ml.ml.sentiment/versions/1" | jq -r .storage_location)   # 1. ask WHERE
ls  "${LOC#file://}"                                                                       # 2. read it
```

**Both are the same 2 steps: ask the catalog *where*, then read the file yourself.**

---

## 4. 60-second demo script (suggested order)

1. `bin/start-uc-server` → `curl .../catalogs | jq` (the directory).
2. Open the UI at :3000 → click `texera_ml → ml → Models → sentiment → Version 1 (READY)`.
3. Read a file the 2-step way: the CSV flow above (ask where → `cat`).
4. Stop the server → open H2 → `uc_sql "SELECT NAME, STORAGE_LOCATION FROM UC_VOLUMES;"` to show the
   mapping *is* just a database row.
5. Restart the server. Talking point: **catalog = directory (a DB) · storage = files on disk · compute
   = a separate engine.** UC has no compute.
