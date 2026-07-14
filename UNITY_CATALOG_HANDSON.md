# Unity Catalog OSS — Hands-On Notes (explained simply, with examples)

_This is a real hands-on log: I **built** Unity Catalog (UC) from source, **ran** it, **poked every
part of its API**, **turned on its login/permissions system and watched it allow and deny**, and
**opened its web UI**. Everything below actually happened on **2026-07-13** on a 31 GB / 16-core box.
It supersedes the earlier 8 GB run (which could only build + read the sample data — it couldn't do
models, permissions, or the UI)._

> **Why we care (Texera context):** we're designing "models as assets" for Texera. UC is the
> clearest existing example of the design we're aiming at: **one catalog (a directory) over many
> kinds of things, with storage and compute kept separate.** So we study it to borrow the good ideas.

---

## Part 0 · The one-paragraph summary (read this first)

> Unity Catalog is a **directory (a "catalog") that lists things** — catalogs, schemas, tables,
> files ("volumes"), functions, and **models** — and remembers *who owns them, who can see them, and
> where their bytes live*. When you want the actual data, the catalog hands you **a location + a
> short-lived key** and you go read it yourself; **the catalog never carries the data**. It has a
> **login + permissions system** (authentication + authorization) so it can allow or deny each
> request. And crucially, **it runs no compute** — no servers, no model-serving, no "run this
> model." Compute is always some *other* engine's job (Spark, DuckDB, MLflow, or the paid Databricks
> product). That "directory + per-type specialist, storage separate from compute" shape is exactly
> what Texera wants for assets.

---

## Part 1 · The big idea, in plain words (with an analogy)

Think of a **hotel front desk**:

- The **front desk (the catalog)** knows about *everything* — your room, a rental car, a dinner
  reservation — and who each belongs to and who's allowed to use it.
- But the front desk **doesn't personally do everything**. A car request goes to the valet; dinner
  goes to the restaurant; the room goes to housekeeping. **One desk, many specialists.**
- And when you want your car, the valet gives you **the keys and the parking spot number** — you go
  get the car yourself. The desk doesn't drive it to you.

Unity Catalog is that front desk for data:
- **One directory** lists tables, files, functions, and models.
- **Each kind has its own "specialist"** for handing out access (a table is fetched differently from
  a file).
- To read something, you get **"where it is + a temporary key,"** and you read it directly.

Texera today only has **one specialist: "find the file"** (great for datasets and models, which are
files). UC shows how to have a **team of specialists** under one directory — the pattern we want.

---

## Part 2 · Setup (copy-paste reproducible)

```bash
sudo apt-get install -y openjdk-17-jdk-headless          # Java 17
git clone --depth 1 https://github.com/unitycatalog/unitycatalog.git ~/unitycatalog-src
cd ~/unitycatalog-src
export JAVA_HOME=/usr/lib/jvm/java-1.17.0-openjdk-amd64
build/sbt package         # compiles everything → a server jar (~45 seconds, clean, no hacks needed)
bin/start-uc-server       # starts the REST API on http://localhost:8080
# in another shell, the command-line tool (wraps the same API):
bin/uc catalog list
```

- **Data API** (the things): `http://localhost:8080/api/2.1/unity-catalog`
- **Control API** (users/login): `http://localhost:8080/api/1.0/unity-control`
- **Where the catalog remembers everything:** a small **relational database** — an **H2 file** by
  default (`etc/db/h2db.mv.db`), configured in `etc/conf/hibernate.properties`, and **swappable to
  Postgres or MySQL** (example configs shipped). → *This is the same role Texera's Postgres plays.*
- **Where the actual bytes live:** the **local filesystem** under `etc/data/` by default (or S3 /
  Azure / GCS if configured). → *This is the role LakeFS+MinIO play in Texera.*

Version used: `main` @ `aa7388f` (`0.5.0-SNAPSHOT`), OpenJDK 17, sbt 1.9.9.

---

## Part 3 · What UC can hold — the 9 "securable" types (with examples)

UC calls the things it governs **securables**. From the source (`SecurableType`) there are exactly
nine, and **none of them is compute**:

```
METASTORE · CATALOG · SCHEMA · TABLE · FUNCTION · VOLUME · REGISTERED_MODEL ·
EXTERNAL_LOCATION · CREDENTIAL
```

Everything has a **3-part name**: `catalog.schema.object` (like `unity.default.numbers`). In plain
terms:

| Securable | In plain words | Example (from the running server) |
|---|---|---|
| **Metastore** | the whole "account" / top of the tree | the server itself |
| **Catalog** | a top-level folder | `unity` (the sample), `texera_ml` (I made) |
| **Schema** | a sub-folder inside a catalog | `unity.default`, `texera_ml.ml` |
| **Table** | structured rows/columns (Delta format) | `unity.default.numbers` (columns `as_int`, `as_double`) |
| **Volume** | a **folder of arbitrary files** | `unity.default.txt_files` (holds `a.txt`, `b.txt`) |
| **Function** | a saved snippet of code | `unity.default.sum` → `"t = x + y + z; return t"` |
| **RegisteredModel** | a **named model** (a container for versions) | `texera_ml.ml.sentiment` (I made) |
| **ModelVersion** | one actual version of a model + its files | `sentiment` **version 1** |
| **ExternalLocation** | a governed storage path + which credential unlocks it | (cloud only) |
| **Credential** | the cloud identity used to make temporary keys | (cloud only) |

Two things worth remembering for Texera:
- **A "Volume" is exactly Texera's dataset/model folder** — a folder of files.
- **A "RegisteredModel → versions" is exactly the model-as-asset shape** we want, and UC keeps model
  **metadata** in the catalog while the model **files** live in storage — the same split Texera uses.

**The catalog only stores *metadata* for tables** (name, columns, where the Delta files are). It does
**not** write table data — an engine like Spark does. Same for functions: UC stores the code text; it
never runs it.

---

## Part 4 · Storing & reading a model, step by step (the ML example I ran)

This is the flow that matters most for Texera. I registered a model called `sentiment` and walked it
through its whole life. In plain words: **make a model → make a version → write its files → "finalize"
it → read it back.**

**First gotcha (worth knowing):** a "managed" thing (where UC owns the storage) needs a **storage
root**. A brand-new catalog with none fails:
```
POST /models {name, catalog_name, schema_name}
→ 400  "None of catalog, schema or storage-root ... has managed location configured."
```
Fix: give the catalog a storage root when you create it. Then everything inside inherits it.

```bash
B=http://localhost:8080/api/2.1/unity-catalog

# 1) a catalog that owns a storage folder
curl -X POST $B/catalogs -d '{"name":"texera_ml","storage_root":"file:///home/tanishq/uc-managed"}'
# 2) a schema inside it
curl -X POST $B/schemas  -d '{"name":"ml","catalog_name":"texera_ml"}'
# 3) the model (a container — it gets its own folder)
curl -X POST $B/models   -d '{"name":"sentiment","catalog_name":"texera_ml","schema_name":"ml"}'
#    → storage_location: .../__unitystorage/catalogs/<uuid>/models/<uuid>
# 4) a version — it starts life as "PENDING_REGISTRATION" (not ready yet)
curl -X POST $B/models/versions \
     -d '{"model_name":"sentiment","catalog_name":"texera_ml","schema_name":"ml","source":"file:///tmp/run","run_id":"run-abc"}'
#    → {version:1, status:"PENDING_REGISTRATION", storage_location:".../versions/<uuid>"}

# 5) YOU write the model files directly into that folder (UC never touches the bytes)
#    NOTE: in this demo these were PLACEHOLDER files, not a real trained model — the point was
#    to exercise the catalog lifecycle, not the model contents. A real client (e.g. MLflow) would
#    write the actual model.pt / MLmodel / weights here in this same step.
echo "TORCHSCRIPT-BYTES" > <version-folder>/model.pt
echo '{"framework":"pytorch"}' > <version-folder>/MLmodel

# 6) FINALIZE — flips PENDING → READY (this is the "commit"). Note: it's a PATCH.
curl -X PATCH "$B/models/texera_ml.ml.sentiment/versions/1/finalize" \
     -d '{"full_name":"texera_ml.ml.sentiment","version":1}'
#    → {version:1, status:"READY"}

# 7) read it back: ask the catalog where it is, then read the bytes yourself
curl "$B/models/texera_ml.ml.sentiment/versions/1"   # gives storage_location
cat <that-location>/model.pt                          # you read the file
```

**The folder UC assigns is opaque UUIDs the user never sees:**
```
<storage_root>/__unitystorage/catalogs/<catalog-uuid>/models/<model-uuid>/versions/<version-uuid>/
    model.pt   MLmodel   ...
```
You always refer to it by the friendly name `texera_ml.ml.sentiment` v1; UC maps that to the ugly
path. **This is precisely the job Texera's `FileResolver` does** (logical name → real location).

**The key idea to steal:** the `PENDING → write files → finalize → READY` cycle is a **write-then-
commit**, and once a version is `READY` it's **frozen** (see Part 5). That's the same guarantee a
**LakeFS commit** gives Texera.

*(I ran the same create→read pattern for a Volume and a Function too — identical shape.)*

### A real file example — a CSV in a Volume

A **CSV is a file**, so its natural home is a **Volume** (a folder of files), *not* a Table. (A UC
**Table** is specifically **Delta format** — Parquet + a `_delta_log` — which an engine like Spark or
DuckDB writes; a raw CSV only becomes a queryable Table if an engine first converts it to Delta.)

I did this one **for real** (an actual CSV on disk, not a placeholder):

```bash
# 1) a real CSV
printf 'name,age,city\nalice,30,irvine\nbob,25,LA\ncarol,41,SF\n' > /home/tanishq/uc-demo-csv/people.csv

# 2) register that folder as an EXTERNAL volume (UC governs it; bytes stay where I put them)
curl -X POST $B/volumes -d '{"catalog_name":"texera_ml","schema_name":"ml","name":"people_csv",
     "volume_type":"EXTERNAL","storage_location":"file:///home/tanishq/uc-demo-csv"}'
#    → {full_name:"texera_ml.ml.people_csv", volume_type:"EXTERNAL", storage_location:"file:///home/tanishq/uc-demo-csv"}

# 3) RESOLVE then READ (the whole pattern in two lines):
curl "$B/volumes/texera_ml.ml.people_csv"      # catalog tells you: storage_location = file:///home/tanishq/uc-demo-csv
cat /home/tanishq/uc-demo-csv/people.csv        # you read the bytes yourself → the 3 rows come back
```

- **MANAGED vs EXTERNAL:** above I used **EXTERNAL** = "I already have the file; UC just governs it and
  remembers where it is." A **MANAGED** volume is the other way — UC assigns the folder (under its
  `__unitystorage/...` root) and you write into *that*. Both then read the same "resolve → read" way.
- It shows up immediately in the **CLI** (`bin/uc volume list --catalog texera_ml --schema ml`) and in
  the **UI** (schema `ml` → **Volumes** tab → `people_csv`, with a folder icon).
- Note UC's data API has **no "upload this file" endpoint** and **no "list files in a volume"** — the
  catalog only records *the folder's location*; putting files in and listing them is done against
  storage directly (locally, or via a vended cloud credential). This is the pure catalog-vs-storage
  split again.

---

## Part 5 · "Credential vending" — the key handoff, explained

This is the part Texera cares about most, and it's simpler than it sounds.

**When you want to read a file/table/model, you don't ask UC for the bytes. You ask for a temporary
key.** UC:
1. **Checks you're allowed** (permissions — Part 6).
2. **Figures out what access you need** — read → `SELECT`; read+write → `SELECT` + `UPDATE`.
3. **Mints a short-lived cloud key** scoped to just that path, and returns **the location + the key +
   an expiry time**.
4. **You** then read/write the storage **directly**. UC is now out of the loop.

**How the cloud key is actually made (I read the source):** for AWS, UC's own **"master" identity
assumes your data role** using **AWS STS `AssumeRole`**, and passes a unique **`external_id`** to
prevent a classic security bug (the "confused deputy," where someone tricks a privileged helper into
using its powers on the wrong resource). It gets back a **temporary** credential (it expires), scoped
to the exact path. Azure and GCP do the equivalent (a SAS token / an OAuth token).

**On local disk (what I saw), there's no key to give — and UC says so plainly:**
| Endpoint | On a `file://` location |
|---|---|
| ask for **model-version** creds | **refuses**: `400 "Cannot request credentials on a model version with a file based storage location"` |
| ask for **volume** creds | returns **all-nulls** (no aws/azure/gcp key, no expiry) |

Both mean the same thing: *local files need no key — just open them.* Real keys only appear when the
storage is actually in the cloud (S3/Azure/GCS configured in `server.properties`).

**Texera is already doing this pattern** — a LakeFS **presigned URL** is exactly "a location + a
short-lived key, go fetch it yourself." So we're aligned with UC, not behind it.

**Bonus rule that enforces immutability:** UC refuses to give **write** keys for a version that's
already **finalized (READY)**. So once you publish a model version, nobody can rewrite it — you'd make
a new version instead. (Same as an immutable LakeFS commit.)

---

## Part 6 · Login & permissions — I turned it on and watched it allow/deny

By default the server runs with **authorization = disabled** (anyone can do anything — fine for
local play). I turned it **on** to see real enforcement. Here's the plain-English version + exactly
what happened.

**Two different questions UC answers:**
- **Authentication = "who are you?"** (proved by a token).
- **Authorization = "are you allowed to do this?"** (checked against granted permissions).

**Turning it on** (`server.authorization=enable` in `etc/conf/server.properties`, then restart). On
startup UC **sets itself up automatically**:
- generates internal signing keys (`etc/conf/private_key.der`, `public_key.der`, `key_id.txt`),
- creates an **admin account** and writes an **admin token** to `etc/conf/token.txt`,
- makes that admin the boss of the whole metastore.

**Important, and convenient:** the **admin path needs no Google/Okta**. External login (Google, etc.)
is only for *end users* to sign in via a browser. For everything scriptable, you just use the admin
token. (An access token is just a small signed JSON blob — a JWT — saying `issuer=internal`,
`sub=<your email>`. UC verifies the signature with its own key and looks you up by email.)

### The allow → deny demo (real output)

```bash
B=http://localhost:8080/api/2.1/unity-catalog
TOK=$(cat etc/conf/token.txt)          # the admin token

# No token at all → blocked
curl $B/catalogs
→ 401 UNAUTHENTICATED "No authorization found."

# Admin token → works, sees everything
curl -H "Authorization: Bearer $TOK" $B/catalogs
→ 200  [texera_demo, texera_ml, unity]

# Make a normal user "bobbie"
curl -H "Authorization: Bearer $TOK" -X POST \
     http://localhost:8080/api/1.0/unity-control/scim2/Users \
     -d '{"displayName":"Bobbie","userName":"bobbie@example.com","emails":[{"value":"bobbie@example.com","primary":true}]}'
```

To act *as bobbie*, I minted bobbie's token locally using **UC's own signing key** (the same key UC
would use after a Google login — no external provider needed for a local test):
```python
# using UC's private_key.der + key_id.txt, sign a JWT: {iss:"internal", sub:"bobbie@example.com", type:"ACCESS"}
```

```bash
BT=$(cat bobbie_token.txt)

# bobbie is logged in but has NO permissions yet:
curl -H "Authorization: Bearer $BT" $B/catalogs
→ 200  {catalogs: []}            # authenticated, but the list is FILTERED to what he can see (nothing)

curl -H "Authorization: Bearer $BT" -X POST $B/catalogs -d '{"name":"bobbies_catalog"}'
→ 403 PERMISSION_DENIED "Access denied."     # not allowed to create

# ADMIN grants bobbie two permissions:
curl -H "Authorization: Bearer $TOK" -X PATCH "$B/permissions/catalog/unity" \
     -d '{"changes":[{"principal":"bobbie@example.com","add":["USE CATALOG"]}]}'
curl -H "Authorization: Bearer $TOK" -X PATCH "$B/permissions/metastore/metastore" \
     -d '{"changes":[{"principal":"bobbie@example.com","add":["CREATE CATALOG"]}]}'

# the SAME bobbie calls now succeed:
curl -H "Authorization: Bearer $BT" $B/catalogs
→ 200  [unity]                    # now he can SEE the catalog he was granted
curl -H "Authorization: Bearer $BT" -X POST $B/catalogs -d '{"name":"bobbies_catalog"}'
→ 200  {name: bobbies_catalog}    # now he can CREATE
```

**What this teaches (and what Texera should note):**
- **Permissions actually gate every call** once enabled — deny by default, allow only what's granted.
- **Listing is *row-filtered* by permission** — bobbie's "list catalogs" went from empty → showing
  just `unity` after a grant. You only see what you're allowed to see. (Texera's dashboard would want
  the same behavior for shared assets.)
- Permissions are per-securable and follow the 3-level name: grant `USE CATALOG` on `unity`, then
  `USE SCHEMA` on `unity.default`, then `SELECT` on `unity.default.numbers` — you walk down the tree.
- With authorization **disabled** (the earlier run), the permission API accepts calls but doesn't
  store/enforce them — which is why grants looked like no-ops before.

*(For the walkthrough afterward I set authorization back to **disabled**, because the web UI needs
Google configured to log in, and we don't have that here.)*

---

## Part 7 · Compute — there is none in open-source UC (confirmed two ways)

**By reading the code:** searching the whole server for `warehouse|serving|cluster|compute|
inference-endpoint` turns up only (a) `warehouse` used by the Iceberg REST catalog to mean *"which
catalog"* (not compute), and (b) a Spark connector option name. There is **no** model-serving, **no**
cluster, **no** endpoint, and **no** `SERVICE` securable in OSS.

**By reading the config + API:** `server.properties` has zero compute settings; the control API is
only users/login. Nothing starts, stops, or runs anything.

**Where the "compute" traces point:** only to the **paid Databricks product**. The docs' AI
integrations install `unitycatalog-*[databricks]` and use a `DatabricksFunctionClient`; the
model-serving securable (`SERVICE`) is **Databricks-only**. The one "inference" mention in the OSS
docs is **MLflow loading a model from UC and running it itself** — the *engine* computes, UC just
governs.

**Plain conclusion:** OSS Unity Catalog is a **pure catalog/governance layer with no compute**.
That's the exact half Texera would reuse for *assets*; Texera adds the compute half (computing units)
that UC deliberately leaves out. **Storage is governed in the catalog; compute is always a separate
system.**

---

## Part 8 · The Web UI — what to open, what to click, what you'll see

The UI is a small React app that talks to the same `:8080` API. Start it:
```bash
cd ~/unitycatalog-src/ui
yarn install        # one time (installs Node deps)
yarn start          # serves the UI on http://localhost:3000
```
Open **http://localhost:3000**. (If you enabled server authorization in Part 6, turn it back to
`disable` first, or the UI shows nothing because it isn't logged in.)

> It's mostly a **browser** for the catalog — great for *seeing* the structure and confirming what
> your API calls did. **What the UI can create (buttons/modals, verified in the UI source):**
> **Catalog, Schema, and Model** (the empty model *container*). **What it cannot create:** Tables,
> Volumes, Functions, and **model *versions*** — anything that involves writing actual files. Those
> come from the **API or an engine** (e.g. MLflow registers a model version + its files; Spark/DuckDB
> writes a Delta table) and the UI just *shows* them. So a CSV/volume like `people_csv` above appears
> in the UI but was created via the API.

**Guided things to try (each teaches one concept):**

1. **See the whole directory.** The home page lists all **catalogs** (`unity`, plus `texera_ml`,
   `texera_demo`, `bobbies_catalog` that I made via the API). *Takeaway: the UI is just a view of the
   catalog DB — anything you did via curl shows up here.*
2. **Drill the 3-level name.** Click a catalog → see its **schemas**; click a schema → see a tabbed
   panel: **Tables / Volumes / Functions / Models**. *Takeaway: this is the `catalog.schema.object`
   tree made visual.*
3. **Look at the sample table.** `unity` → `default` → **Tables** → `numbers`. You'll see its
   **columns and types** (`as_int`, `as_double`) and its **storage location**. *Takeaway: the catalog
   holds table metadata; the data itself is Delta files on disk.*
4. **Look at a Volume (a folder of files).** `unity` → `default` → **Volumes** → `txt_files`.
   *Takeaway: a Volume ≈ a Texera dataset/model folder.*
5. **Look at a Function.** `unity` → `default` → **Functions** → `sum`. You'll see its saved code
   text. *Takeaway: UC stores code but never runs it.*
6. **Find the model I registered.** `texera_ml` → `ml` → **Models** tab → **`sentiment`** → you'll
   see a **Versions** table with **Version 1** and a **green ✓ = READY**. *Takeaway: this is the exact
   model-as-asset view we want in Texera — a named model with versions and a ready/pending status.*
7. **Create something and watch both sides.** Click **Create Catalog**, name it, then in a terminal
   run `bin/uc catalog list` (or `curl .../catalogs`) — it appears there too. *Takeaway: UI and API
   are two front-ends over one catalog.*
8. **See the "actions" menu.** The **⋮ (more)** button on a catalog/schema offers edit/delete —
   the write operations the UI supports.

**What you will NOT find in the UI (and that's the point):** anything about *running* a model, a
server, or compute. There's no "deploy" or "serve" — because OSS UC has no compute (Part 7). Seeing
that absence in the UI is itself the lesson.

**The screens I captured** (so you know what to expect):
- *Catalogs list* — table of all catalogs + a left-hand Browse tree.
- *Catalog view* (`texera_ml`) — its description + a Schemas table + Create Schema.
- *Schema view* (`texera_ml.ml`) — the Tables/Volumes/Functions/**Models** tabs.
- *Models tab* — the `sentiment` row.
- *Model view* — **Version 1, status green ✓ (READY)**, time registered.

---

## Part 9 · What Texera should borrow (the takeaways)

1. **One directory, a `type` on each thing, a specialist per type.** UC's 9 typed securables under
   one API validate Texera's "asset with a `type`" + a shared catalog table.
2. **Metadata in a relational DB (H2→Postgres) governs bytes on separate storage.** That *is*
   Texera's Postgres + LakeFS/MinIO split. We're aligned with the reference design.
3. **"Credential vending" = Texera's presigned URLs.** Same idea: hand out *location + short-lived,
   path-scoped key*, client reads directly, catalog never carries bytes. If Texera ever adds
   bring-your-own-bucket, copy UC's *master-assumes-your-role + external_id* recipe.
4. **Model = named container → versions, with a `PENDING → finalize → READY` lifecycle, and
   finalized = immutable.** Texera gets the immutability free from LakeFS commits; worth naming
   explicitly, and layering a movable alias (e.g. `Champion`) on top later.
5. **Logical name → opaque storage path** (UC's UUID layout) mirrors Texera's `FileResolver`; keep
   the user-facing name stable and the physical path hidden/relocatable.
6. **Permissions gate every call and *filter lists*.** Deny-by-default, row-filtered listing — the
   behavior Texera's shared-asset dashboard wants.
7. **Keep compute out of the catalog.** UC proves the split twice over: govern the computing unit for
   listing/sharing, but resolve/run it with its **own** lifecycle handler, never the storage path.
8. **`managed` vs `external`** is a useful explicit flag (Texera assets are "managed"); leaves room
   for external/BYO storage later.

---

## Appendix · Current running state & how to poke it

- **UC server:** running on `:8080` (currently **authorization = disabled** for the UI). Restart:
  `cd ~/unitycatalog-src && bin/start-uc-server`.
- **UC web UI:** running on `:3000` (`cd ~/unitycatalog-src/ui && yarn start`).
- **CLI:** `bin/uc catalog list` · `bin/uc model list --catalog texera_ml --schema ml` · etc.
- **My demo objects:** catalog `texera_ml` (root `~/uc-managed`) → schema `ml` → model `sentiment`
  v1 (READY), volume `artifacts`, function `addone`; plus `bobbies_catalog` from the permissions demo.
- **To re-run the permissions demo:** set `server.authorization=enable` in `etc/conf/server.properties`,
  restart, use `etc/conf/token.txt` as the admin token. Set it back to `disable` to use the UI.
- **To add real end-user login (Google/Okta):** follow `docs/server/auth.md` — needs *your own*
  OAuth client ID/secret (a step you do yourself; I did not configure any external provider).

**Next:** Snowflake — the storage-vs-compute + warehouse **SUSPEND/RESUME** lifecycle, i.e. the
compute half UC deliberately omits.
