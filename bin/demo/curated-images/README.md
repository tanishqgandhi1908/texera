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
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml
```

`--insecure-registry` only applies at cluster creation, hence the `delete` — without it the
push is rejected on TLS. The local-path provisioner is needed because the registry claims a
PVC; without a StorageClass the registry pod sits `Pending` and every mirror fails.

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
3. **Name** `Texera Default (test)`, **Docker Hub link**
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

`computing-unit-sklearn.dockerfile` adds scikit-learn, which the default image does not
have. That is what makes it a test rather than a tautology: the same UDF fails on the
default image and works on this one.

```bash
cd bin/demo/curated-images
docker build -f computing-unit-sklearn.dockerfile -t <your-account>/texera-cu-sklearn:1.0 .
docker push <your-account>/texera-cu-sklearn:1.0
```

The build ends with an import check, so a broken image fails there rather than surfacing as
an `ImportError` inside a workflow later.

Register it as `Python ML (sklearn)`, wait for `READY`, then:

1. Create a computing unit and pick it from the **Image** dropdown.
2. First start pulls ~5.5 GB, so allow time; later units on the same node are fast because
   the layers are cached.
3. Any source operator → **Python UDF**, pasting `udf_sklearn_test.py`.
4. Run. Expected: five rows with `sklearn_version` `1.5.2`, a predicted iris species and a
   confidence each.

### The control — this is what proves it

Create a second unit **without** selecting an image and run the same workflow. It must fail:

```
ModuleNotFoundError: No module named 'sklearn'
```

If it succeeds on both, the image selection is not load-bearing and something is wrong.
That failure is the evidence.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Could not start the mirror job`, API address `http://localhost:8080` | No kube context. The client fell back to the legacy default; check `kubectl config current-context`. |
| Row stuck in `MIRRORING` | The Job was created but never reported. `kubectl get jobs -n texera-workflow-computing-unit-pool`, and check the manager's RBAC for `jobs`, `configmaps`, `pods/log`. |
| `FAILED` with a push error | The registry ClusterIP is unreachable, or the runtime does not treat `10.96.0.99:5000` as insecure. |
| `FAILED` instantly with an empty log | The skopeo image could not be pulled inside the cluster. |
| Registry pod `Pending` | No StorageClass for its PVC — apply the local-path provisioner. |
| Admin page 404s in dev | `/api/cu-image` missing from `frontend/proxy.config.json`; restart the dev server after adding it. |

## What has and has not been verified

Verified: the skopeo validation and digest commands, against real registries, in both the
accept and reject directions. Backend compiles, and the unit tests cover reference
normalisation, digest parsing and the failure description.

Not verified: the Kubernetes Job that wraps those commands, the push into the in-cluster
registry, and a computing unit actually booting from a mirrored image. Test 1 is the
cheapest way to find out.
