<!--
  SESSION NOTES - NOT DOCUMENTATION. DELETE THIS FILE BEFORE OPENING A PR.

  Committed only so the work survives a machine teardown. The permanent docs are
  docs/curated-computing-unit-images.md and bin/demo/curated-images/README.md; the
  corrections these notes justify have already been folded into the latter.
-->

# Findings from first end-to-end run of feat/curated-cu-images

Environment: Windows 11, minikube 1.38.1 (docker driver, k8s 1.35.1), services run
from plain JVMs against the cluster via ~/.kube/config.

## 1. README Test 1 uses a name the validator rejects  (docs bug, blocks the test)

`bin/demo/curated-images/README.md` Test 1 step 3 says:

    **Name** `Texera Default (test)`

`CuratedImageResource.validate` checks `name` against `NamePattern`, which allows only
"letters, digits, spaces, dots, hyphens and underscores". Parentheses are not in that set,
so following the README literally returns:

    HTTP 400
    {"code":400,"message":"Image name must start with a letter or digit and contain only
     letters, digits, spaces, dots, hyphens and underscores."}

Nothing is created and no Job runs. Anyone following the README hits this first.

Fix: rename to `Texera Default test` in the README (or widen NamePattern).
The same applies to `Python ML (sklearn)` in Test 2 -- also parentheses, also rejected.

## 2. The local-path provisioner step is unnecessary on current minikube

README says the registry PVC sits `Pending` without Rancher local-path, and the
troubleshooting table repeats it. minikube 1.38 enables `default-storageclass` +
`storage-provisioner` addons out of the box, giving `standard (default)`
(`k8s.io/minikube-hostpath`). The 50Gi PVC bound to it in ~15s without local-path.

Not harmful, just dead weight -- and the troubleshooting row misleads on minikube.

## 3. `--insecure-registry` is not visible in daemon.json

Verifying the flag the obvious way is misleading:

    minikube ssh -- cat /etc/docker/daemon.json
    # -> no insecure-registries key

It is passed as a dockerd command-line flag instead. The real check:

    minikube ssh -- docker info | grep -A3 'Insecure Registries'
    #  Insecure Registries:
    #   10.96.0.0/12

Worth adding next to the "FAILED with a push error" troubleshooting row, so nobody does a
needless `minikube delete` concluding the flag did not apply.

## 4. "Should come back in seconds" is misleading on a cold cluster

README, rejection path: "This should come back in **seconds**. If it takes minutes, the
validate-before-copy ordering is broken and layers are being downloaded before the check."

On a cold cluster the first mirror of any kind takes ~90s, because the node must first pull
`quay.io/skopeo/stable:v1.16.1` -- 310 MB, measured at 66s here:

    Pulling image "quay.io/skopeo/stable:v1.16.1"
    Successfully pulled ... in 1m5.942s. Image size: 309863367 bytes.

Validation itself was seconds, and ordering was correct (log shows `Inspecting` then
`ERROR`, no `Copying` line -- no layers fetched). But someone running this the first time
sees ~90s and, per the README's own instruction, would wrongly conclude the ordering is
broken.

Suggest: note that the first run includes a one-time skopeo image pull, and that the real
signal for broken ordering is a `Copying` line appearing before the rejection -- not
wall-clock time.

## Verified working (first ever end-to-end run)

Rejection path, fully green:
- Job `cu-image-mirror-1-1` created in `texera-workflow-computing-unit-pool`
- skopeo ran; validation rejected `alpine:latest` with the exact documented message
- `reconcileRunningMirrors` moved the row MIRRORING -> FAILED on its own
- `/api/cu-image/{iid}/log` surfaced the pod log verbatim
- validate-before-copy ordering confirmed correct

## Test 1 ACCEPT path -- PASSED (previously never executed)

POST ghcr.io/apache/texera-workflow-execution-coordinator:latest -> READY in 265s.

    Inspecting ghcr.io/apache/texera-workflow-execution-coordinator:latest
    Start command: [bin/computing-unit-master] [/__cacert_entrypoint.sh]
    TEXERA_SOURCE_DIGEST=sha256:61d1d396ac7a6c2ec3d517d1e86aad997f52c857899e12428c595de2a79dcb84
    Copying to 10.96.0.99:5000/texera-cu/2:1
    ...
    Mirrored ... to 10.96.0.99:5000/texera-cu/2:1

Row: status=READY, imageTag=10.96.0.99:5000/texera-cu/2:1,
sourceDigest=sha256:61d1d396...

Independently confirmed in the registry itself (not just skopeo's word):

    GET /v2/_catalog            -> {"repositories":["texera-cu/2"]}
    GET /v2/texera-cu/2/tags/list -> {"name":"texera-cu/2","tags":["1"]}

So: Job -> validate -> digest -> push into the in-cluster registry all work, and the
insecure-registry/TLS path works. This closes the largest "not verified" item in the
handoff.

### Minor: README's expected imageTag assumes iid 1

README says "Pulled from fills in with 10.96.0.99:5000/texera-cu/1:1". The path segment is
the iid, so if anything was registered earlier (e.g. the alpine rejection row, as in the
README's own ordering) the real value is /2:1. Cosmetic, but it reads as an exact
expectation.

## Disk measurements (for sizing Test 2)

- skopeo streams compressed layers; it does NOT materialise the ~5.5 GB uncompressed image.
- Mirroring the engine image cost ~2.7 GB of host disk (11.1 GB -> 8.4 GB free).
- The 310 MB skopeo image is pulled once per node.

## STILL NOT VERIFIED

A computing unit actually booting from a mirrored image (the pod-spec override in
KubernetesClient.createPod). Test 1 proves the image reaches the registry; nothing yet
proves a pod starts from it.

## 5. The README's "run the manager from the IDE" fallback cannot create a computing unit

README, memory note: "the mirror alone can be tested against a bare cluster -- apply only
the pool namespace and the cu-image-registry manifests, and run the computing-unit-managing
service from the IDE, where it reaches the cluster through ~/.kube/config."

True for mirroring -- that worked exactly as described. But it does NOT extend to creating a
unit, which is the other half of the feature. Two gaps, each fatal and each with a poor
error:

### 5a. Kubernetes CU type is off by default

`kubernetes.conf` has `enabled = false`, so `GET /api/computing-unit/types` returns only
`["local"]` and there is no way to pick a curated image at all -- a local CU is a JVM with
no image. Needs `KUBERNETES_COMPUTING_UNIT_ENABLED=true`.

### 5b. Five env vars are read with `.get` on an Option and have no defaults

`ComputingUnitManagingResource.computingUnitEnvironmentVariables` (line ~111) does
`EnvironmentalVariable.get(...).get` for:

    FILE_SERVICE_GET_PRESIGNED_URL_ENDPOINT
    FILE_SERVICE_UPLOAD_ONE_FILE_TO_DATASET_ENDPOINT
    SCHEDULE_GENERATOR_ENABLE_COST_BASED_SCHEDULE_GENERATOR
    USER_SYS_ENABLED
    MAX_WORKFLOW_WEBSOCKET_REQUEST_PAYLOAD_SIZE_KB
    AUTH_JWT_SECRET

The Helm chart supplies all of these; a standalone process supplies none. Result is

    HTTP 500 {"message":"There was an error processing your request..."}
    java.util.NoSuchElementException: None.get

which says nothing about which variable is missing. Note AUTH_JWT_SECRET must match the
web app's (`auth.conf` default `8a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d`) or tokens minted by
TexeraWebApplication are rejected by the manager.

This is pre-existing, not introduced by this branch -- but the branch's demo instructions
send people down this path, so it is worth either documenting the env block or giving these
sensible dev defaults.

## 6. Creating a Kubernetes CU requires metrics-server, which minikube lacks by default

After fixing 5a/5b, creation still 500s:

    KubernetesClientException: Failure executing: GET at:
    https://127.0.0.1:.../apis/metrics.k8s.io/v1beta1/namespaces/
    texera-workflow-computing-unit-pool/pods. Message: Not Found.

The create path queries pod metrics. minikube does not enable metrics-server by default;
`minikube addons enable metrics-server` is required. The demo README's cluster setup should
include it alongside the local-path line it currently has.

## 7. A failed create can leave an orphan pod behind

The create attempt that 500'd on the missing metrics API (finding 6) still left a running
pod `computing-unit-2` in the pool namespace, crash-looping with 4 restarts. The DB row was
rolled back -- `DELETE /api/computing-unit/2/terminate` returned 404, i.e. the manager no
longer knew about it -- but the pod survived, unreferenced and consuming resources.

So the pod is created inside (or before the end of) the transaction, and a later failure
rolls back the row without removing the pod. Worth checking whether pod creation should be
after the commit, or have a compensating delete on failure. Not specific to curated images,
but curated images make it likelier to hit, since a unit can now fail for a new reason
(image not READY) on that same path.

## 8. jvmMemorySize accepts Kubernetes-style units that break the JVM

Passing `jvmMemorySize: "1Gi"` (valid Kubernetes quantity, and the same format the sibling
`memoryLimit` field requires) is accepted by the API and reaches the container as
`-Xmx1Gi`, which the JVM rejects:

    Invalid maximum heap size: -Xmx1Gi
    Error: Could not create the Java Virtual Machine.

The pod then CrashLoopBackOffs with no indication that the input was at fault. The UI only
offers JVM-style values ("1G"), so this is only reachable via the API -- low severity, but
the two adjacent memory fields taking different unit syntaxes is a trap, and validating it
at the API boundary would be cheap.

## THE LAST UNVERIFIED ITEM IS NOW VERIFIED

"a computing unit actually booting from a mirrored image" -- the item the handoff called
the highest-risk remaining surface -- now has evidence.

Created a kubernetes computing unit with `iid: 2` (the mirrored curated image):

    resource: {"iid":2,
               "imageName":"Texera Default test",
               "curatedImage":"10.96.0.99:5000/texera-cu/2:1", ...}

Cluster side:

    kubectl get pod computing-unit-4 -o jsonpath={.spec.containers[*].image}
    -> 10.96.0.99:5000/texera-cu/2:1

    Events: Pulled - Container image "10.96.0.99:5000/texera-cu/2:1" ... can be accessed
            Created / Started
    Status: 1/1 Running, real CPU metrics reported (921804245n)

So the whole chain works end to end:
  admin registers -> skopeo validates -> mirrored into in-cluster registry ->
  selected on a unit -> KubernetesClient.createPod applies the override ->
  kubelet pulls from 10.96.0.99:5000 over plain HTTP -> container runs.

The container is genuinely the Texera engine, not just any image -- it starts Amber and
forms a pekko cluster node:

    ClusterListener - received member event = MemberUp(Member(pekko://Amber@localhost:2552, Up))

### Why it then exits (environment, not the feature)

    HikariPool$PoolInitializationException: Failed to initialize pool:
    Connection to localhost:5432 refused

The unit inherits `STORAGE_JDBC_URL` from the manager, which points at `localhost:5432`.
On the host that is correct; inside the pod `localhost` is the pod. Under the Helm chart
Postgres runs in-cluster so this never arises -- it is purely an artefact of the
bare-cluster + off-cluster-manager topology the README recommends for low-memory machines.

To make a unit stay up in this topology you would need the host DB reachable from the pod:
add `127.0.0.1 host.minikube.internal` to the Windows hosts file, set
`STORAGE_JDBC_URL=jdbc:postgresql://host.minikube.internal:5432/texera_db?currentSchema=texera_db,public`
(one variable serves both, since the name then resolves on each side), and allow the
minikube subnet in `pg_hba.conf` with `listen_addresses='*'`. Worth a note in the README,
because "run the manager from the IDE" otherwise produces a unit that boots and dies.

## FINAL: a computing unit runs, and stays running, from a mirrored curated image

After wiring the host DB reachable from the pod (hosts entry + pg_hba + repointed
STORAGE_* endpoints at host.minikube.internal), unit cuid 5 came up clean:

    computing-unit-5   1/1   Running   0 restarts   (stable through 60s+)
    spec image: 10.96.0.99:5000/texera-cu/2:1

    [INFO] Started application@...{HTTP/1.1,[http/1.1]}{0.0.0.0:8085}
    [INFO] Started @21215ms

API view:

    "status":"Running"
    "imageName":"Texera Default test"
    "curatedImage":"10.96.0.99:5000/texera-cu/2:1"
    "metrics":{"cpuUsage":"927008712n","memoryUsage":"194716Ki"}

No database errors. The unit registered its full REST surface (including PveResource, so
the untouched Python-virtual-environment feature still initialises alongside curated
images).

Every stage of the feature is now exercised on a real cluster.

## Summary of what changed on the test machine (all reversible)

- `C:\Windows\System32\drivers\etc\hosts`: added `127.0.0.1 host.minikube.internal`
  (backup: `hosts.texera-backup`)
- `pg_hba.conf`: added minikube/Docker subnets (backup: `pg_hba.conf.texera-backup`)
- `udf.conf`: python path set (the only tracked-file edit; do not commit)
- Postgres superuser password set to `postgres` to match storage.conf defaults, so no
  storage.conf edit was needed

## 9. Windows: pgroonga TokenMecab breaks EVERY insert into an indexed table

Not related to curated images -- this blocks the whole app on Windows, including
"create workflow".

`sql/texera_ddl.sql` creates six pgroonga indexes with `tokenizer = 'TokenMecab'`
(workflow, user, project, dataset, dataset_version, model). Index creation succeeds, so
the DDL run looks clean. Every subsequent INSERT then fails:

    ERROR: pgroonga: [insert] failed to set column value:
    [tokenizer][mecab][create][newline] failed to create mecab_model_t:
    D:\a\pgroonga\groonga\vendor\mecab-0.996\src\param.cpp(69)

That `D:\a\...` is the pgroonga CI build machine's path. Cause: the official pgroonga
Windows package (`pgroonga-4.0.8-postgresql-17-x64.zip`) ships the MeCab *binaries* and
licence files but NOT a dictionary. `etc\mecabrc` points at
`etc\mecab\dic\naist-jdic`, which does not exist in the package. So MeCab can never
initialise, and TokenMecab is unusable on Windows as shipped.

Symptom for a developer following the wiki: everything installs cleanly, the DDL applies
with no error, services start -- and then "Workflow creation failed" in the UI with no
clue why unless you read the backend log.

### Fix applied here

Rebuilt the six indexes with `TokenBigram`, same expressions and names:

    DROP INDEX texera_db.idx_workflow_pgroonga;  -- etc, all six
    CREATE INDEX idx_workflow_pgroonga ON texera_db.workflow USING pgroonga (<same expr>)
      WITH (tokenizer='TokenBigram');

Verified: inserts succeed, and full-text search still works --

    SET search_path TO texera_db, public;
    SELECT wid, name FROM texera_db.workflow WHERE (...) &@~ 'smoke';
    -> 4 | pgroonga smoke test

TokenBigram needs no dictionary and is the better general-purpose choice; TokenMecab is
Japanese morphological analysis specifically. Worth either shipping a dictionary in the
Windows setup instructions, or having the DDL fall back to TokenBigram when MeCab cannot
initialise -- the DDL already has tokenizer-detection logic, but it only checks that the
tokenizer is registered, not that it can actually build a model.

Note: pgroonga is installed into the `texera_db` schema, so its operators (`&@~`) need
`search_path` set -- otherwise you get "operator does not exist: text &@~ unknown".

## 10. The default computing-unit image is unreachable, so an imageless unit cannot start

`kubernetes.conf` ships:

    image-name = "bobbai/texera-workflow-computing-unit:dev"

Creating a kubernetes computing unit WITHOUT selecting a curated image uses that value, and
the pull fails:

    Failed to pull image "bobbai/texera-workflow-computing-unit:dev":
    pull access denied for bobbai/texera-workflow-computing-unit,
    repository does not exist or may require 'docker login': denied

The pod sits in ImagePullBackOff indefinitely. Two consequences:

1. In a default-config deployment every unit MUST have a curated image selected -- the
   "absent uses the deployment's default" path in `ComputingUnitManagingResource` is dead
   unless an operator overrides `KUBERNETES_IMAGE_NAME`.
2. **Test 2's control case as written cannot work.** The README says "Create a second unit
   **without** selecting an image and run the same workflow", expecting
   `ModuleNotFoundError`. It never gets that far -- the pod never starts, so there is no
   workflow failure to show, just a stuck unit.

   Better control: register the stock engine image as a curated image and start the control
   unit from THAT. It isolates exactly one variable (the added package) instead of also
   changing which base image is used, and it actually runs.

The default pointing at a personal Docker Hub repo (`bobbai/...`) that is private or gone
looks like leftover development config worth fixing independently of this branch.

## 7b. Orphan pod confirmed, with much stronger evidence

The orphan from finding 7 (`computing-unit-2`) was still present **7h55m later** at
**96 restarts**, crash-looping the whole time. Its DB row was gone --
`DELETE /api/computing-unit/2/terminate` returned 404 -- so nothing in Texera knew about it
and nothing would ever reap it. Had to be removed by hand:

    kubectl delete pod computing-unit-2 -n texera-workflow-computing-unit-pool --force

A compensating delete on the failure path, or creating the pod only after the transaction
commits, would prevent this.

## 11. The branch's dataset path prefix is incompatible with the curated image (BLOCKS file scans)

This is the most consequential finding of the second session, because it breaks the feature's
own demo path in a way Test 1 cannot expose.

The branch renamed the resource path prefix:

    ResourceType (this branch):  Datasets = "datasets"   ->  /datasets/{owner}/{name}/{ver}/{file}
    ResourceType (upstream main): Dataset  = "dataset"   ->  /dataset/{owner}/{name}/{ver}/{file}

`ResourceType.fromPrefix` matches the string exactly (`values.find(_.toString == segment)`),
so neither side accepts the other's form. Now note what the curated image is built from:

    FROM ghcr.io/apache/texera-workflow-execution-coordinator:latest

That is upstream `main`. So a computing unit started from a curated image runs UPSTREAM's
FileResolver, while the host services run the BRANCH's. Any workflow with a file scan fails
inside the unit:

    LogicalPlan - Error resolving file path for ScanSourceOpDesc
    org.apache.commons.vfs2.FileNotFoundException: Could not read from
      "/datasets/texera/iris-species/v1/Iris.csv" because it is not a file.
        at FileResolver$.$anonfun$resolve$6(FileResolver.scala:71)
        at scala.Option.getOrElse(Option.scala:201)

The message is badly misleading: all three resolvers failed and `getOrElse` surfaced the
LOCAL resolver's complaint, so it names a path that was never meant to be local. Resolution
failed; nothing was wrong with the file, LakeFS, the DB, or the network.

Workaround used for the demo: store the singular form `/dataset/...` in the workflow, which
the unit resolves. The host compiling service then cannot resolve it, so the UI may show a
schema warning on the scan operator even though execution succeeds.

Implication for the PR: **a curated image built FROM upstream cannot read datasets created by
a deployment running this branch.** The README instructs building FROM the Texera image and
the obvious base is upstream `latest`, so this is the default path into the bug. Either the
curated image must be built from the same commit as the deployment, or the prefix rename needs
a compatibility shim (accept both segments).

## 12. Nothing makes host-side storage reachable from a computing-unit pod

The README's low-memory topology (services in the IDE, cluster via ~/.kube/config) says
nothing about how the POD reaches Postgres, LakeFS and MinIO on the developer's machine.
Three separate things bite, in order:

1. **`host.minikube.internal` does not resolve inside pods.** It is in the NODE's /etc/hosts
   only. A node-level `nc -z host.minikube.internal 5432` succeeds, which makes the config
   look correct, while the CU dies with `Connection refused` to Postgres. Use the host's WSL
   interface IP instead (here `172.20.16.1`) -- reachable from the pod AND from Windows, so
   one value serves both sides.

2. **`pg_hba.conf` must admit the pod subnets** (added `172.16.0.0/12`, `192.168.65.0/24`,
   `192.168.49.0/24`).

3. **LakeFS signs download URLs with an endpoint the pod cannot reach.** The compose file
   hardcodes `LAKEFS_BLOCKSTORE_S3_PRE_SIGNED_ENDPOINT=http://localhost:9000`, correct for a
   browser on the host and useless inside a pod. No Texera env var fixes this -- it is LakeFS
   configuration. Override it to the host IP.

None of this arises under the full Helm chart, where everything is in-cluster. It only affects
the topology the README actively recommends to people short on RAM.

## 13. Re-registering the same Docker Hub link: storage dedupes, the download does not

Measured directly. Registering `tagandhi19/texera-cu-sklearn:1.0` a second time under a new
name produced a second row and repository:

    /v2/_catalog -> {"repositories":["texera-cu/6","texera-cu/9"]}

Registry storage for BOTH:

    blobs/                        2.2 GB
    repositories/texera-cu/       508 KB

So `registry:2` deduplicates perfectly -- blobs are content-addressed, and the second
repository added only manifests and links. But the mirror Job still pulled the full ~4.3 GB
from Docker Hub again and took the same ~5 minutes, because nothing checks whether that digest
is already mirrored. `create()` tests only the NAME for uniqueness; `source_ref` has no unique
constraint and no digest lookup.

Cheap improvement: before starting a Job, resolve the source digest and check whether an
existing READY row already carries it; if so, the new row could point at the existing tag (or
at least skip the copy). Today a duplicate registration is free in storage but full price in
time and in transient disk.

## 14. cu_image rows survive a cluster rebuild still marked READY

Delete and recreate the cluster (or just the registry PVC) and every row still reads READY
with an `image_tag` pointing at a registry that no longer holds it. Nothing reconciles the
catalogue against the registry, so the next unit created from such a row sits in
ImagePullBackOff with no indication that a re-mirror is needed. `refresh` fixes it, but only
if you know to run it.

## Environment quirks that cost time in session 2

- **FileService exits if MinIO is not up yet.** It retries the dataset bucket 6 times and then
  throws `RuntimeException: Failed to reach the texera dataset bucket after 6 attempts`. Start
  the compose stack and wait for `/minio/health/live` BEFORE starting FileService.
- **The compile API takes a different shape than stored workflow content.** Operator properties
  must be FLATTENED (not nested under `operatorProperties`), and links use
  `fromOpId` / `fromPortId` / `toOpId` / `toPortId` with the op ids as PLAIN STRINGS and ports
  as `{id, internal}` ordinals. Sending the frontend's stored shape returns
  `400 Unable to process JSON` with no hint which field is wrong.
- **The shipped example workflow has a stale dataset path.** `[Demo] Iris classification with a
  mounted PyTorch model.json` uses `/datasets/texera/iris-species/v1 - v1/Iris.csv`, but
  `parsePrefixedPath` wants `/{prefix}/{owner}/{name}/{version}/{file}` -- so `v1`, not
  `v1 - v1`.
- **Docker's WSL disk only grows.** Freeing space inside it returns nothing to Windows, and
  `diskpart compact vdisk` did not help. Deleting `docker_data.vhdx` reclaims it, but Docker
  then crash-loops on orphaned sockets in `%LOCALAPPDATA%\Docker\run` and
  `%LOCALAPPDATA%\docker-secrets-engine` that cannot be deleted, only RENAMED. Rename both
  before restarting Docker. Prefer Docker Desktop's own "Clean / Purge data".
