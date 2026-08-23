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

# AlphaFold 3 on Texera — a custom computing-unit image

A proof of concept for running a workload that Texera's Python virtual environments
**cannot** express, by putting it in the computing-unit image instead.

## What it is proving

[AlphaFold 3](https://github.com/google-deepmind/alphafold3) is the sharpest example
available of a dependency a PVE cannot satisfy, because it fails the model in three
independent ways at once:

| AlphaFold 3 needs | A PVE offers |
| --- | --- |
| Python ≥ 3.12 | a venv built from the image's interpreter — 3.10 |
| a source build (not on PyPI, compiles a C++ extension) | `pip install <spec>`, no build step |
| `jackhmmer` / `nhmmer`, which are executables | Python packages only |

None of these is a matter of effort. A PVE is *a list of pip specs installed into a
venv on the image's Python*, and each row above falls outside that definition. Adding
shell access to a running pod does not fix them either: that shell is the unprivileged
`texera` user (uid 1001), so `apt install hmmer` fails; and anything it did install
would live in the container's writable layer and vanish on the next restart.

An image settles all three at build time, as root, once — and identically for every
computing unit started from it.

## What it is not

This runs AlphaFold 3's **data pipeline**, not structure prediction. Specifically:

- **No GPU inference and no model parameters.** AF3 inference wants an A100/H100 with
  CUDA 12.6, and its weights come from DeepMind under terms of their own. The image
  installs CPU jax deliberately, which keeps ~3 GB of unusable NVIDIA wheels out of it.
- **No 630 GB genetic databases.** The demo searches a few hundred real UniProt
  sequences instead — enough for a genuine alignment, small enough to commit in seconds.

What *is* real: AF3 3.0.5 built from source, `alphafold3.data.tools.jackhmmer` — the
same class AF3's own pipeline calls — and the real `jackhmmer` binary, on Python 3.12,
inside a Texera workflow, searching a database delivered as a mounted model version.

## Build the image

```bash
eval $(minikube -p <profile> docker-env)     # build where the cluster can see it

cd bin/dockerfiles
docker build -f computing-unit-alphafold3.dockerfile \
  --build-arg BASE_IMAGE=texera-local/texera-workflow-execution-coordinator:dev \
  -t texera-local/computing-unit-alphafold3:dev .
```

The build fails rather than the workflow if anything is missing: a verification layer
imports `alphafold3`, `jax`, `pyarrow`, checks `sys.version_info >= (3, 12)` and
resolves `jackhmmer` on `PATH` before the image is tagged.

### How the engine finds the environment

The image builds its environment at `/opt/texera/python-envs/alphafold3/pve` and the
entrypoint symlinks it into `/tmp/texera-pve/venvs/$TEXERA_CU_ID/` at startup, because
`PveManager.getPythonBin` resolves `<root>/<cuid>/<name>/pve/bin/python` and the cuid
is only known once the pod exists. So a UDF selects it exactly like any user-created
environment — "Default Python Environment" off, "Virtual Environment" `alphafold3` —
and nothing in the engine had to change.

The environment also contains `amber/requirements.txt`. That is not optional: the engine
launches its own Python worker with this interpreter, so an environment holding only
AF3 would fail before any user code ran.

## Register it as a computing-unit image

This image is selected per computing unit, so nothing about the pool changes and other
users are unaffected. Push it somewhere Texera can pull from, then register it:

```bash
docker tag computing-unit-alphafold3 <your-registry>/cu-alphafold3:1.0
docker push <your-registry>/cu-alphafold3:1.0
```

In **Admin → CU Images**, add a row with a name (`AlphaFold 3`) and the reference you
just pushed. Texera checks it is a computing-unit image before copying anything, then
mirrors it into the in-cluster registry and marks it `READY`.

It then appears in the **Image** dropdown when creating a computing unit. Only units
started from it run AF3; every other unit keeps the default image.

An earlier version of this demo set `workflowComputingUnitPool.imageName` instead, which
switched the image for *every* computing unit because there was no per-CU selection. There
is now, so that override is gone.

## Run the demo

```bash
bin/demo/alphafold3/fetch-sequence-db.sh      # ~226 reviewed ubiquitin-family sequences
```

Upload `build/ubiquitin_family.fasta` as a model named `alphafold3-seqdb` and commit a
version — a model is staged until a version commits it, and nothing can mount it before
then. Then build a two-operator workflow:

```
Python UDF Source ──▶ Python UDF
 (three sequences)     (env: alphafold3, model: alphafold3-seqdb)
```

- Source operator: [`udf/generate_sequences.py`](udf/generate_sequences.py) — ubiquitin,
  NEDD8 and SUMO1, three real human proteins at deliberately different distances from
  the database.
- Search operator: [`udf/msa_search.py`](udf/msa_search.py) — set **Default Python
  Environment** to false and **Virtual Environment** to `alphafold3`, then pick the
  model version for the `SEQ_DB` row the property panel offers.

## What it produced

Run on minikube, computing unit 21 (2 CPU, 4 GiB, no GPU):

| protein | accession | residues | msa_depth | search_seconds | python | alphafold3 |
| --- | --- | --- | --- | --- | --- | --- |
| ubiquitin | P62979 | 76 | 466 | 0.075 | 3.12.14 | 3.0.5.dev1+g97d20234c |
| NEDD8 | Q15843 | 81 | 459 | 0.274 | 3.12.14 | 3.0.5.dev1+g97d20234c |
| SUMO1 | P63165 | 101 | 322 | 0.297 | 3.12.14 | 3.0.5.dev1+g97d20234c |

Three things in that table are the result:

**`python 3.12.14`**, from an engine whose own interpreter is 3.10 — the operator ran on
a different Python than the process that launched it.

**The alignment depths differ, and in the right order.** Ubiquitin sits in the middle of
the family it is being searched against, NEDD8 close by, SUMO1 at the edge. A search
returning a fixed number, or the same number three times, would not be searching.

**The database was never copied.** The engine log shows the model version mounted rather
than downloaded:

```
Requesting mount of model-10:321f07ad… from node mounter at http://192.168.58.2:8100/mount
Model model-10:321f07ad… mounted at /mnt/texera-mounts/model-10/321f07ad…
```

### The negative control

Change one property — `Default Python Environment` back to true — and the identical
workflow fails:

```
EXECUTION_FAILURE: java.lang.Throwable: No module named 'alphafold3'
```

Which is the point of the whole exercise. The environment selection is load-bearing, and
what it selects is something no PVE could have built. Note that `jackhmmer` is on `PATH`
either way, because it was installed image-wide — the interpreter is what differs.

## Layout

```
fetch-sequence-db.sh          builds the searchable database from UniProt
udf/generate_sequences.py     source operator: three query sequences
udf/msa_search.py             AF3's jackhmmer MSA search
build/                        fetched data; not checked in
```

AlphaFold 3 is licensed CC BY-NC-SA 4.0 and is neither vendored nor redistributed here —
the image clones it at build time. UniProt sequences are CC BY 4.0 and are fetched, not
committed, for the same reason.
