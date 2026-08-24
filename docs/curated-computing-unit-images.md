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

# Curated computing-unit images

A **curated image** is a container image an administrator has registered. A user picks one
when creating a computing unit, and the unit runs that image instead of the deployment's
default — so a workflow can use libraries, interpreters and system packages the default
image does not have.

## Why an administrator registers it, rather than a user building one

An earlier proof of concept let a user type a Dockerfile that Texera then built. That put
three problems in the platform at once:

| | User-built Dockerfile | Curated image |
| --- | --- | --- |
| What runs in the cluster | arbitrary build instructions a user wrote | a copy of an image an administrator chose |
| Who reviewed the contents | nobody | the administrator who registered it |
| Storage growth | unbounded — every rebuild published a tag nothing reclaimed | bounded by administrator action |

Curating removes all three. An image is trusted precisely because a user could not add it.

## What may be registered

A computing-unit image must contain the Amber engine. The pod sets no command and relies
on the image's own `CMD` being `bin/computing-unit-master`, so an arbitrary public image
would start and immediately exit.

In practice that means the image must be built `FROM` the Texera computing-unit image. The
engine image itself qualifies, which makes it a convenient smoke test:

```
$ skopeo inspect --config --format '{{.Config.Cmd}} {{.Config.Entrypoint}}' \
    docker://ghcr.io/apache/texera-workflow-execution-coordinator:latest
[bin/computing-unit-master] [/__cacert_entrypoint.sh]
```

`bin/demo/curated-images/computing-unit-sklearn.dockerfile` is a worked example.

## The flow

```
CuratedImageResource ──creates──▶ Job (skopeo)
                                    │
                                    │ 1. inspect the config only (a few KB)
                                    │    reject unless Cmd/Entrypoint runs the engine
                                    │ 2. record the digest the tag resolved to
                                    │ 3. copy
                                    ▼
                                 registry ◀── <registry>/texera-cu/<iid>:<n>
                                    │
                                    ▼
                          kubelet pulls it for the CU pod
```

1. **Admin → CU Images** in the sidebar.
2. Give it a **Name** (what users see) and a **Docker Hub link** — an image reference, or a
   Docker Hub page address, which is normalised. Without a tag, `latest` is used.
3. Saving starts a mirror. The row shows `MIRRORING`; **Log** is readable throughout.
4. **Refresh** copies the source again — a tag upstream can move, and this is how that
   change is picked up, and how a mirror that failed on the network is retried.
5. When creating a computing unit, pick it from the **Image** dropdown. Only `READY`
   images appear, and the control hides itself when none are.

### Validate before copying

The inspect fetches a manifest and a config blob — kilobytes — so a reference that is
misspelled, private, or simply not a computing-unit image fails within seconds rather
than after tens of gigabytes. The check reads `Cmd` and `Entrypoint` specifically: a match
anywhere in the whole config would also be satisfied by an unrelated environment variable
that happened to mention the name.

### Why mirror rather than reference

A unit pulls from the in-cluster registry, never from upstream. An upstream outage or rate
limit therefore cannot stop a unit from starting, and a tag moved upstream cannot silently
change what a unit runs. The resolved digest is recorded for the same reason.

Registry persistence is on because of this: an `emptyDir` would discard every mirrored
copy on a pod restart, leaving each image needing a re-mirror before it could be used —
the one thing mirroring exists to prevent.

### Other design notes

- **skopeo, not a pull-and-push.** It copies registry to registry, needs no daemon and no
  privileged pod, and can read an image's config without downloading its layers — which is
  what makes validating first worth doing.
- **The tag carries a mirror number.** Re-mirroring publishes `:<n+1>` rather than
  overwriting `:<n>`, so a unit already running an earlier copy is unaffected.
- **Status is reconciled on read.** A mirror finishes on the cluster, not in the service,
  so a row learns its outcome when someone lists or opens it. That keeps the feature free
  of background threads and leader election; the UI polls while a mirror is in flight.
- **Rows are global.** There is no `uid` and no per-user access table: one curated list is
  offered to everybody. `created_by` is for auditing and does not restrict use.

## Configuration

| Value | Default | Purpose |
| --- | --- | --- |
| `curatedImages.enabled` | `true` | Turns the feature and its API off entirely |
| `curatedImages.mirrorImage` | `quay.io/skopeo/stable:v1.16.1` | What performs the copy |
| `curatedImages.mirrorNamespace` | the computing-unit pool namespace | Where mirror jobs run |
| `curatedImages.mirrorTimeoutSeconds` | `3600` | A mirror past this is killed |
| `cuImageRegistry.clusterIP` | `10.96.0.99` | Pinned; must be inside the Service CIDR the container runtime treats as insecure |
| `cuImageRegistry.persistence.enabled` | `true` | Off means mirrored images are lost if the registry pod restarts |

## Requirements

Mirroring runs as a Kubernetes Job and the image override is applied to a pod spec, so
**the feature needs a cluster**. A *local* computing unit is a JVM process with no image
and ignores the selection entirely — so none of this can be exercised in a purely local
development setup. See `bin/demo/curated-images/README.md`.

## Known limits

- **The registry is plain HTTP with no authentication.** It works only because container
  runtimes are configured to treat the Service CIDR as insecure. A real deployment
  terminates TLS and gives the pull a credential. There is also no credential path for a
  private *upstream* image, so registered references must be public.
- **A curated image can still run as root.** The pod spec sets no `securityContext`, so an
  image that omits `USER texera` runs as root. This should be pinned with
  `runAsUser`/`runAsNonRoot` so the image cannot decide.
- **Removing an image leaves its layers in the registry.** The row and the mirror jobs go;
  the pushed blobs stay until the registry is garbage-collected. `registry:2` has no
  retention and its garbage collection requires taking the registry offline.
- **No quota.** Nothing limits how many images are registered or how large one may be.
