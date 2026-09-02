<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Testing curated computing-unit images

Two tests. The first needs no build and exercises the whole pipeline; the second proves a
custom image actually changes what a workflow can do. See
`docs/curated-computing-unit-images.md` for what the feature is.

## This needs a cluster

Mirroring runs as a Kubernetes Job, and the image override is applied to a pod spec. A
*local* computing unit is a JVM process with no image, so it ignores the selection
entirely. **The usual local development setup — docker compose plus the services in an
IDE — cannot exercise any of this**, beyond the admin page rendering and rows appearing in
the table.

Minimum for the mirror to work:

```bash
minikube delete && minikube start --insecure-registry "10.96.0.0/12"
minikube addons enable metrics-server
```

`--insecure-registry` only applies at cluster creation, hence the `delete` — without it the
push is rejected on TLS. Note it does *not* appear in `/etc/docker/daemon.json`; it is passed
as a dockerd flag, so verify it with:

```bash
minikube ssh -- "docker info | grep -A3 'Insecure Registries'"
```

`metrics-server` is optional but worth enabling. Creating a computing unit no longer needs
it -- pod metrics are read best-effort, so a cluster without the addon simply reports no
CPU/memory for a unit instead of failing to create one -- but without it the unit list
shows blank usage.

The registry claims a PVC, so the cluster needs a default StorageClass. minikube provides
one (`standard`, via the `storage-provisioner` addon) and the PVC binds in seconds — the
Rancher local-path provisioner is only needed on a cluster that has none.

Then install the chart (see `docs/getting-started/run-on-kubernetes.md`):

```bash
cd bin/k8s && helm dependency update && cd .. && helm install texera k8s --namespace texera-dev --create-namespace
```

The chart applies `sql/texera_ddl.sql`, which already contains the `cu_image` table, so no
migration needs applying by hand on a fresh install.

> **Memory.** The chart is 20+ pods, and a computing unit runs a ~5.5 GB JVM image. This
> does not fit comfortably in 8 GB. If memory is tight, the mirror alone can be tested
> against a bare cluster — apply only the pool namespace and the `cu-image-registry`
> manifests, and run the computing-unit-managing service from the IDE, where it reaches the
> cluster through `~/.kube/config`. That covers register → validate → mirror, which is the
> part with no prior end-to-end coverage.

---

## Test 1 — smoke test, nothing to build

The engine image is itself a valid curated image, so this needs no Docker Hub account.

1. Sign in as an administrator.
2. **Admin → CU Images**.
3. **Name** `Texera Default test`, **Docker Hub link**
   `ghcr.io/apache/texera-workflow-execution-coordinator:latest`, then **Add**.

Expected: `MIRRORING`, then `READY` on its own — the page polls. **Pulled from** fills in
with `10.96.0.99:5000/texera-cu/1:1`, and the digest appears under the source. **Log**
shows:

```
Inspecting ghcr.io/apache/texera-workflow-execution-coordinator:latest
Start command: [bin/computing-unit-master] [/__cacert_entrypoint.sh]
TEXERA_SOURCE_DIGEST=sha256:f0ccf9cd...
Copying to 10.96.0.99:5000/texera-cu/1:1
Mirrored ... to ...
```

### The rejection path

Add a second row pointing at `alpine:latest`. It must go `FAILED`, with the log explaining
why rather than just failing:

```
ERROR: alpine:latest does not look like a Texera computing-unit image.
Its start command is: [/bin/sh] []
A computing-unit image must run 'computing-unit-master',
which means being built FROM the Texera computing-unit image.
```

This should come back in **seconds**. If it takes minutes, the validate-before-copy
ordering is broken and layers are being downloaded before the check.

---

## Test 2 — a real ML image

`computing-unit-ml.dockerfile` adds **xgboost**, which the stock computing-unit image does
not have. That is what makes it a test rather than a tautology: the same UDF fails on the
stock image and works on this one.

> **Why xgboost and not scikit-learn.** The stock image already ships scikit-learn, torch and
> transformers. An image that only adds scikit-learn therefore proves nothing — the control
> workflow succeeds on both images and the comparison is vacuous. Pick a package the stock
> image genuinely lacks. scikit-learn is still pinned *down* here (1.5.2 against the stock
> 1.7.2) as a second, softer signal: the version the workflow prints tells you which image ran.

```bash
cd bin/demo/curated-images
docker build -f computing-unit-ml.dockerfile -t <your-account>/texera-cu-ml:1.0 .
docker push <your-account>/texera-cu-ml:1.0
```

The build ends with an import check, so a broken image fails there rather than surfacing as
an `ImportError` inside a workflow later.

Register it as `Python ML xgboost`, wait for `READY`, then:

1. Create a computing unit and pick it from the **Image** dropdown.
2. First start pulls ~5.5 GB, so allow time; later units on the same node are fast because
   the layers are cached.
3. Drop a **Python UDF Source** operator and paste `udf_ml_source.py`. (Use the source
   variant: a plain Python UDF is a transform and needs an upstream operator, so a workflow
   containing only one is *Invalid*. `udf_ml_transform.py` is the transform version if you would
   rather wire up a source in front of it.)
4. Run. Expected: five rows with `xgboost_version` `2.1.1`, `sklearn_version` `1.5.2`, a
   predicted iris species and a confidence each.

### The control — this is what proves it

Register the stock engine image as a second curated image and start a unit from **that**,
then run the same workflow. It must fail:

```
ModuleNotFoundError: No module named 'xgboost'
```

If it succeeds on both, the image selection is not load-bearing and something is wrong.
That failure is the evidence.

> **Prefer the stock image registered as a curated image over "a unit with no image
> selected".** Either works now that `image-name` defaults to the published
> `ghcr.io/apache/texera-workflow-execution-coordinator`, but registering it explicitly
> isolates exactly one variable -- the added package -- rather than also changing which base
> image is used. Historically the default named a private repository, so such a unit
> never left `ImagePullBackOff` and there was no workflow failure to observe at all.

> **In the dev topology the unit dropdown does not route execution.** `proxy.config.json`
> pins `/wsapi` to `localhost:8085`, so every run reaches whichever computing unit is
> reachable there regardless of the selection — which makes the control appear to pass. Run
> this comparison under the full chart, where the frontend is served in-cluster and resolves
> each unit by its own address. To check the two units differ without a workflow at all:
>
> ```bash
> kubectl exec -n texera-workflow-computing-unit-pool <pod> -- python3 -c "import xgboost"
> kubectl get pod <pod> -n texera-workflow-computing-unit-pool -o "jsonpath={.spec.containers[*].image}"
> ```

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Could not start the mirror job`, API address `http://localhost:8080` | No kube context. The client fell back to the legacy default; check `kubectl config current-context`. |
| Row stuck in `MIRRORING` | The Job was created but never reported. `kubectl get jobs -n texera-workflow-computing-unit-pool`, and check the manager's RBAC for `jobs`, `configmaps`, `pods/log`. |
| `FAILED` with a push error | The registry ClusterIP is unreachable, or the runtime does not treat `10.96.0.99:5000` as insecure. |
| `FAILED` instantly with an empty log | The skopeo image could not be pulled inside the cluster. |
| Registry pod `Pending` | No default StorageClass for its PVC. minikube has one; a bare cluster may not. |
| HTTP 400 on **Add** | The name contains a character the validator rejects. Letters, digits, spaces, dots, hyphens, underscores, parentheses and plus signs are allowed. |
| Unit list shows blank CPU/memory | `minikube addons enable metrics-server`. Creation is unaffected; only the reported usage is. |
| Create unit refused, `not a valid JVM heap size` | `jvmMemorySize` takes the JVM's form (`1G`, `512m`), not the Kubernetes form (`1Gi`) the memory limit uses. |
| Create unit refused, `Image N is not available` | The image is not `READY`, or the registry no longer holds its tag after a cluster rebuild — **Refresh** it. |
| Admin page 404s in dev | `/api/cu-image` missing from `frontend/proxy.config.json`; restart the dev server after adding it. |

## What has and has not been verified

**Verified end to end on a real cluster** (minikube, k8s 1.35, services run against it
through `~/.kube/config`):

- the mirror Job is created, runs skopeo, and reports back
- validation accepts a Texera-derived image and rejects `alpine:latest` with the documented
  message, *before* copying any layer
- the digest is resolved and recorded
- the push into the in-cluster registry succeeds over plain HTTP, and the image is really
  there (`GET /v2/_catalog`)
- the row reconciles `MIRRORING` -> `READY` / `FAILED` on its own, and the pod log is
  surfaced through `/api/cu-image/{iid}/log`
- a computing unit starts from the mirrored image -- `spec.containers[].image` is the
  `10.96.0.99:5000/...` reference, the kubelet pulls it from the in-cluster registry, and the
  unit reaches `Running` with the Amber engine up, its database pool connected and its REST
  surface listening, at 0 restarts
- the container runs non-root: `runAsUser: 1001`, `allowPrivilegeEscalation: false`, all
  capabilities dropped, and `id` inside the container reports `uid=1001(texera)`
- registering an already-curated reference is refused, and a name with parentheses is
  accepted

**Also verified under the full Helm chart** (everything in-cluster, reached through the
Envoy gateway rather than the dev proxy):

- the gateway routes `/api/cu-image` to the computing-unit manager, and the manager's
  ServiceAccount may create the mirror Job and read its pod's log
- register -> mirror -> READY, then a unit boots from the mirrored image
- **a workflow executes on that unit and completes**, returning the five rows its source
  UDF produces (`n` 0..4). The `?cuid=` on the `/wsapi` socket is what selects the unit,
  which is the part the dev topology cannot exercise

**Not verified:** re-mirroring an image whose upstream tag has moved, and anything about
retention or garbage collection of superseded tags.
