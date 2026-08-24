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

# Handoff — `feat/curated-cu-images`

Working notes for continuing this in another session or on another machine. **Delete this
file before opening a PR** — it is session state, not documentation. The permanent docs are
`docs/curated-computing-unit-images.md` and `bin/demo/curated-images/README.md`.

## What this branch does

Replaces the user-built "environment" feature (a Dockerfile a user typed, which Texera
built with BuildKit) with a list of images an **administrator** registers. A user picks one
when creating a computing unit.

Branch: `feat/curated-cu-images`, on top of `rodeo/pve-demo-1`. Pushed to
`origin` (`tanishqgandhi1908/texera`).

Two commits:

| Commit | What |
| --- | --- |
| `feat(computing-unit): start a unit from an admin-curated image` | the whole feature, −2.3k/+1.9k |
| `fix(computing-unit): route curated images in dev, and say why a mirror could not start` | dev proxy rule, better failure message |

## Where the code is

| Concern | File |
| --- | --- |
| Admin CRUD, status reconcile, ref normalising | `computing-unit-managing-service/.../resource/CuratedImageResource.scala` |
| The skopeo Job: validate then copy | `computing-unit-managing-service/.../util/ImageMirrorClient.scala` |
| Config | `common/config/.../CuratedImageConfig.scala`, `common/config/src/main/resources/kubernetes.conf` |
| Where the image reaches the pod | `ComputingUnitManagingResource.scala` → `KubernetesClient.createPod` |
| Admin UI | `frontend/src/app/dashboard/component/admin/cu-image/` |
| Frontend service | `frontend/src/app/dashboard/service/admin/cu-image/cu-image.service.ts` |
| Schema | `sql/texera_ddl.sql` (`cu_image`), `sql/updates/38.sql` (drop old), `sql/updates/39.sql` (create) |
| Helm | `bin/k8s/values.yaml` (`curatedImages`, `cuImageRegistry`), `templates/base/cu-image-registry/` |

The seam that made this small: `KubernetesClient.createPod` already took an
`image: Option[String]`. Only the source of that string changed.

## State of verification

**Verified.** Backend compiles; 12 backend tests pass; `ngc` template check clean; 64
frontend tests pass across the three affected specs; `helm lint` clean. The skopeo
validation and digest commands were run against real registries in both directions — a
Texera image reports `[bin/computing-unit-master] [/__cacert_entrypoint.sh]` and passes,
`alpine` reports `[/bin/sh] []` and is rejected.

**Not verified.** No end-to-end run. The Kubernetes Job wrapping skopeo, the push into the
in-cluster registry, and a computing unit booting from a mirrored image have never
executed. This is the highest-risk remaining surface — start with Test 1 in
`bin/demo/curated-images/README.md`.

## Open items, roughly in priority order

1. **`runAsNonRoot` on the CU pod.** Absent, so an image omitting `USER texera` runs as
   root. ~5 lines in `KubernetesClient`. More important now than before, because nobody
   reviews a Dockerfile any more.
2. **Migration numbers collide with upstream.** This branch predates upstream's `38`, `39`
   and `40`, so ours need renumbering to `41`/`42` on rebase. Harmless for a fresh install,
   because the chart applies `texera_ddl.sql` directly rather than the update scripts.
3. **Validation lives inside the Job**, which means it cannot run without a cluster. Moving
   it in-process (an HTTP call to the registry manifest API) would make the accept/reject
   half testable in a normal IDE setup and give instant feedback. Deliberate prototype
   tradeoff; revisit if the cluster loop proves slow.
4. **No retention or GC.** `registry:2` has neither, and its garbage collection needs the
   registry offline. Bounded by admin action so it is not urgent, but re-mirroring
   accumulates tags nothing reclaims.
5. **No credential path** for a private upstream image, or for the pull from the in-cluster
   registry (plain HTTP, no auth).

## Environment quirks that cost time

- **jOOQ codegen runs against a live database** and its output is gitignored. When the
  schema changes, `Keys.java` can go stale while table classes regenerate, producing
  confusing `cannot find symbol CU_IMAGE_PKEY` errors. Fix:
  `rm -rf common/dao/src/main/scala/org/apache/texera/dao/jooq/generated common/dao/target`
  and rebuild.
- **This branch predates the upstream auth refactor.** It expects `password`, `google_id`
  and `google_avatar` on `user`; upstream moved them to an `auth_provider` table. On a
  database carrying the newer schema, `common/auth` will not compile. Either build against
  a database created from *this* branch's `texera_ddl.sql`, or patch the newer one
  additively — the columns plus `UNIQUE (google_id)`, which jOOQ needs in order to emit
  `fetchOneByGoogleId`.
- **If you patch an existing database, migrate the password data too.** Adding
  `user.password` as an empty column makes every login return 401, because this branch reads
  that column while the hashes live in `auth_provider.password`. Both sides use jasypt's
  `StrongPasswordEncryptor`, so the hashes are interchangeable:
  `UPDATE "user" u SET password = ap.password FROM auth_provider ap WHERE ap.uid = u.uid AND ap.provider_type = 'LOCAL';`
- **The frontend is yarn 4**, not npm — `npm install` fails on a peer conflict and can leave
  a broken `node_modules`.
- **Prefer `ngc -p tsconfig.json --noEmit` over a production build** to check templates.
  It does the full `strictTemplates` AOT check without webpack or terser, so it finishes
  quickly and in far less memory. `yarn build` can exhaust an 8 GB machine.
- **`frontend/junit.xml` is a committed test report.** Running a subset of tests rewrites
  it, which shows up as a ~9.5k-line deletion in the diff. Restore it before committing.
- **Dev needs a proxy rule.** `/api/cu-image` in `frontend/proxy.config.json`, or requests
  fall through to the web app on 8080 and 404. Restart the dev server after changing it.

## Things deliberately left alone

- **Python virtual environments** (`virtual_environments`, `WorkflowPveService`) are
  untouched. They select an interpreter *within* an image, which is a different question
  from which image a unit runs, and the AlphaFold demo depends on them.
- **The AlphaFold demo** still works; only its "point the cluster at it" section changed,
  because it previously set `workflowComputingUnitPool.imageName` pool-wide — which would
  now make *every* unit run AlphaFold. It registers a curated image instead.
