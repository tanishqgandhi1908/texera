<!--
  SESSION NOTES - NOT DOCUMENTATION. DELETE THIS FILE BEFORE OPENING A PR.

  Committed only so the work survives a machine teardown. The permanent docs are
  docs/curated-computing-unit-images.md and bin/demo/curated-images/README.md; the
  corrections these notes justify have already been folded into the latter.
-->

# Texera curated-images demo — teardown record and restore plan

Torn down 2026-08-25 to free ~20 GB for a higher-priority demo.
Rebuild expected ~3-4 days later (early Sept 2026).

## THE GOOD NEWS: nothing irreplaceable was lost

- **The demo image lives on Docker Hub**: `tagandhi19/texera-cu-sklearn:1.0`
  digest `sha256:7e0a8816af8658f9fb639331f27e731b810db776605b5d4e0b6058dc96909d30`
  It does NOT need rebuilding. Admin just re-registers that link and Texera re-mirrors it.
- **The branch is on GitHub**: `tanishqgandhi1908/texera` @ `feat/curated-cu-images`
- **All findings and demo scripts are files in `C:\Users\Texera\dockerImages\`** (see below),
  outside the git tree, and were NOT deleted.

## Files kept (do not delete)

| File | What |
| --- | --- |
| `TEXERA-curated-images-findings.md` | 10 findings from the first end-to-end run — the PR-relevant output |
| `TEXERA-demo-runbook.md` | how to bring the stack back up |
| `demo-sklearn/DEMO-SCRIPT.md` | the 5-minute demo arc for the professor |
| `demo-sklearn/computing-unit-ml.dockerfile` | image definition (xgboost + pinned sklearn) |
| `demo-sklearn/udf_ml_test.py` | UDF for a *transform* Python UDF (needs an input operator) |
| `demo-sklearn/udf_ml_source.py` | UDF for a *Python UDF Source* (no input needed) — USE THIS ONE |
| `TEXERA-RESTORE-LATER.md` | this file |

## What was REMOVED in teardown

- minikube cluster (`minikube delete`) — cluster, registry, PVC, all mirrored images
- LakeFS/MinIO containers and their docker volumes
- All docker images (host + minikube)
- Docker Desktop's WSL data disk contents (the ~12 GB `docker_data.vhdx`)
- `frontend/node_modules`, sbt `target/` dirs, Coursier cache (all re-downloadable)

## What was KEPT installed

JDK 17 (Temurin), Node 24.19, Python 3.12, sbt, kubectl, minikube, Docker Desktop,
IntelliJ IDEA CE, PostgreSQL 17 + pgroonga, the cloned repo.
(If any of these were also removed to hit the disk target, it is noted at the end.)

## HOST CHANGES MADE (still in place — revert if you ever want the machine clean)

1. `C:\Windows\System32\drivers\etc\hosts` — added `127.0.0.1 host.minikube.internal`
   backup at `hosts.texera-backup`
2. `pg_hba.conf` — added minikube/Docker subnets
   backup at `pg_hba.conf.texera-backup`
3. Postgres superuser password set to `postgres` (matches storage.conf defaults)
4. `LongPathsEnabled = 1`
5. WSL2 + VirtualMachinePlatform features enabled

## DATABASE — still present, do not rebuild from scratch

`texera_db` and `texera_iceberg_catalog` were NOT dropped. They already contain the two
non-obvious fixes below. If you DO recreate the DB from `sql/texera_ddl.sql`, you must
re-apply both:

### Fix A — pgroonga TokenMecab is broken on Windows (blocks ALL inserts)

The Windows pgroonga package ships MeCab binaries but NO dictionary, so every insert into
a pgroonga-indexed table fails and the UI just says "Workflow creation failed". Rebuild the
six indexes with TokenBigram — see finding #9 for the exact SQL.

### Fix B — the upstream engine image needs schema this branch lacks

The curated image is upstream `latest`, which is NEWER than this branch. It expects
`user_warehouse` and `workflow_executions.whid`. Without them every execution dies with
`column "whid" of relation "workflow_executions" does not exist`. Apply additively —
see finding after #9.

## RESTORE ORDER (roughly 1-2 hours, mostly waiting)

1. Start Docker Desktop.
2. `cd texera\file-service\src\main\resources && docker compose up -d`  (LakeFS + MinIO)
3. `minikube start --insecure-registry "10.96.0.0/12" --driver=docker --memory=6g --cpus=4 --disk-size=16g`
   `minikube addons enable metrics-server`     <-- REQUIRED, README omits it
4. Apply the registry manifest (rendered copy is in the runbook; or `helm template` it).
   The Rancher local-path provisioner the README asks for is NOT needed on minikube.
5. `cd frontend && corepack yarn install`      (node_modules was deleted)
6. `sbt compile`                                (targets + Coursier cache were deleted;
                                                 jOOQ codegen needs the live DB up)
7. Export classpaths and start services per the runbook, with the env block —
   especially `KUBERNETES_COMPUTING_UNIT_ENABLED=true`, the six `.get`-on-Option vars,
   and `STORAGE_ICEBERG_CATALOG_TYPE=postgres`.
8. Admin -> CU Images -> register `tagandhi19/texera-cu-sklearn:1.0` (name WITHOUT
   parentheses) and `ghcr.io/apache/texera-workflow-execution-coordinator:latest` as the
   control. Wait for READY.
9. Create two units, one per image. Port-forward 8085 to whichever you want to run on.

## WHAT STILL NEEDS WORK (the actual open items)

1. **Fix the README before the PR** — its Test 1/Test 2 names contain parentheses and fail
   the validator with HTTP 400; its control case ("create a unit without an image") cannot
   work because the default image `bobbai/texera-workflow-computing-unit:dev` is
   inaccessible; it omits metrics-server; its local-path step is unnecessary.
2. **Test 2 cannot be demoed properly in the dev topology.** `proxy.config.json` pins
   `/wsapi` to `localhost:8085`, so the unit dropdown does not change where execution runs
   — both runs hit whichever pod is port-forwarded. This is why the control appeared to
   "pass" with xgboost present. Either demo it via `kubectl exec` (no caveat), or run the
   full Helm chart where the frontend is in-cluster and routing works.
3. **Orphan pod on failed create** (finding 7) — a pod survived 96 restarts over 8 hours
   with no DB row. Needs a compensating delete or pod-create-after-commit.
4. **`runAsNonRoot` on the CU pod** — still open from the original handoff, and more
   important now that nobody reviews a Dockerfile.
5. **Migration renumbering** — this branch's `38.sql`/`39.sql` collide with upstream; they
   need to become `41`/`42` on rebase.
6. **Delete `HANDOFF-curated-images.md`** before opening the PR (its own instruction).
7. Only tracked file modified: `common/config/src/main/resources/udf.conf` (python path).
   Do not commit it.

## VERIFIED — do not re-litigate

The feature itself works end to end on a real cluster: register -> validate -> mirror into
the in-cluster registry -> select on a unit -> pod boots from the mirrored image -> workflow
runs and returns rows. Both the accept and reject paths were confirmed, and a unit was
observed Running with `spec.containers[].image = 10.96.0.99:5000/texera-cu/4:1`.
The remaining problems are all environment/docs, not the feature.

## TEARDOWN LESSON (learned the hard way on the 2026-08-26 restore)

**Do NOT free space by deleting `docker_data.vhdx` while Docker Desktop is installed.**
It reclaims the space, but Docker Desktop will not start afterwards — it crashes at
startup on orphaned AF_UNIX socket files that Windows will not let you delete:

    starting services: initializing Ingest server: listening on
    unix://.../Docker/run/sailor-ingest.sock: remove ...: The file cannot be accessed
    by the system.

and then again on `.../docker-secrets-engine/engine.sock`. The files cannot be removed,
only the containing directory can be renamed. Recovery that worked:

1. kill `Docker Desktop`, `com.docker.backend`, `com.docker.build`
2. `wsl --shutdown`, then `wsl --unregister docker-desktop`
3. rename `%LOCALAPPDATA%\Docker\run` and `%LOCALAPPDATA%\docker-secrets-engine`
   (rename, not delete — delete fails)
4. start Docker Desktop; it rebuilds the distro and both directories

**Next time use Docker Desktop -> Troubleshoot -> "Clean / Purge data" instead.** Same
space reclaimed, no orphaned sockets, no manual recovery.

## Restore of 2026-08-26 — what was actually needed

Far less than a fresh setup, because the teardown kept the important state:

- toolchain, IntelliJ, PostgreSQL: never removed, nothing to do
- `texera_db` and `texera_iceberg_catalog`: survived intact, INCLUDING the pgroonga
  TokenBigram fix and the `user_warehouse` + `whid` patch — both verified still present
- `cu_image` rows survived (iid 1 alpine FAILED, iid 2 stock READY, iid 4 xgboost READY)
  but their `image_tag` values point at a registry that no longer exists, so each needs a
  re-mirror (Refresh) once the cluster is back
- workflow wid 6 "XGBoost curated-image demo" survived
- rebuilt: `yarn install` (~6 min), `sbt compile` (~6 min, 0 errors), Docker data disk,
  minikube cluster

## DISK RULES FOR THIS MACHINE (learned 2026-08-26, cost several hours)

The drive is 63 GB with ~40 GB taken by Windows + toolchain, so the Docker VM has roughly
15-18 GB to work in. Two rules make the difference between the demo fitting and not:

### 1. This machine fits ONE computing unit, not two

MEASURED 2026-08-27, correcting an earlier wrong assumption in this file:

    minikube + k8s images                ~3.0 GB
    registry, one curated image          ~1.5 GB
    registry, both images                ~2.5 GB
    FIRST CU image pulled onto the node  ~5.6 GB
    SECOND CU image pulled onto the node ~1.3 GB and still climbing when the disk filled

Total for two units is ~12.5-13 GB of Docker data. After removing Alteryx AND IntelliJ this
drive offers ~16.5 GB, and because the Docker disk only grows (rule 2) there is no margin —
two attempts at the second unit filled the disk and crashed minikube both times.

**The earlier claim in this file that a second unit is "nearly free because it shares base
layers" was WRONG.** That observation came from a case where the image was already present
in the node's docker daemon from a local `docker build`. Pulling a *different* mirrored
repository does not dedupe the same way in practice — the second pull cost over 1.3 GB
before the disk ran out. Do not rely on layer sharing to make room.

So: run ONE curated image and ONE unit. The live demo still shows register -> validate ->
mirror -> unit boots from the mirrored image -> workflow produces xgboost results. The
"control fails with ModuleNotFoundError" contrast cannot be shown live here; cite the
recorded evidence in NOTES-curated-images-session.md, or run it on a bigger machine.

### 2. Docker's virtual disk only ever grows

`docker_data.vhdx` never shrinks. Deleting images, pruning, deleting pods — all free space
*inside* the VM (so future pulls reuse it) but return nothing to Windows. `diskpart compact
vdisk` did not help either. The only reliable reclaim is deleting the disk and letting
Docker rebuild it.

**Correct reclaim sequence** (the naive one leaves Docker crash-looping on orphaned
sockets, see the earlier note):

    1. stop java/kubectl/node + Docker Desktop processes
    2. wsl --shutdown
    3. wsl --unregister docker-desktop
    4. delete %LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx
    5. RENAME (cannot delete) %LOCALAPPDATA%\Docker\run
       and %LOCALAPPDATA%\docker-secrets-engine   <-- do this BEFORE restarting Docker
    6. start Docker Desktop

Doing step 5 up front made Docker start clean first try; skipping it cost two crash cycles.

### Budget that fits

    minikube base + k8s images      ~3 GB
    registry with both images       ~2.2 GB  (they share a base, so this is not 2x)
    node images, pulled in sequence ~3.7 GB
    -------------------------------------------
    total                           ~9 GB, so start with 12 GB+ free

IntelliJ (~3.6 GB) was uninstalled to make room and is NOT needed — the services run as
plain JVMs from exported classpaths. `winget install JetBrains.IntelliJIDEA.Community`
brings it back in minutes if wanted.
