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
