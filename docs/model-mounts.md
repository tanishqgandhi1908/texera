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

# Using a model in a Python UDF

A model's files live in LakeFS. A Python UDF needs them as a directory it can open. This
is how one becomes the other.

## Writing the UDF

```python
from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    def open(self):
        model_dir = self.UiParameter("IRIS_MODEL", AttributeType.STRING,
                                     value=Resource.MODEL).value
        self.model = torch.load(f"{model_dir}/model.pt", weights_only=False)
```

`value=Resource.MODEL` changes only where the value comes from. The parameter is still an
ordinary string: the property panel offers the model browser instead of a text box, the
user picks a model and a version, and what the UDF receives is the local directory that
version is mounted at. `Resource.DATASET` does the same for datasets. A resource parameter
must be `AttributeType.STRING` — it holds a path — and that is rejected up front rather
than failing to parse later.

Nothing in the UDF mounts anything. Naming the model is the whole of it.

## What happens when the workflow runs

```
edit / compile   code keeps the version path        no database, no cluster
     │
     ▼
execution starts resolve path -> repository:commit  once per operator
     │           rewrite the code to the mount path
     ▼
worker starts    ask this node's mounter to mount   once per (repository, commit)
     │
     ▼
UDF runs         opens files under the directory
```

Resolution is deliberately not done while compiling. Turning a version path into the
LakeFS repository and commit behind it costs a database round trip, and compilation runs
again on every edit of the workflow being edited — a cost paid hundreds of times for a
workflow that may never run. The answer is also a directory inside a particular computing
unit, which is not something the compiler can know. So compilation keeps the version path
(the generated code stays complete and type-correct, and schema propagation is unaffected)
and `PhysicalOp.executionTimeBinding` holds the rest until the execution starts.

An unselected resource parameter *is* checked on every compile, so it surfaces in the
editor rather than at the start of a run.

## Why the computing unit does not do the mounting

FUSE needs privileges, and the computing-unit pod runs user code. So it does not mount:

```
CU pod (unprivileged)  ──asks──▶  texera-mounter (privileged DaemonSet, one per node)
                                        │ runs GeeseFS
                                        ▼
                                  file-service S3 proxy  ──▶  LakeFS
       ◀──HostToContainer propagation───┘
```

The mounter performs the mount on the node and the pod *receives* it through mount
propagation. The CU pod gains no capability it did not already have — it runs non-root,
with privilege escalation refused and every capability dropped.

## Isolation and authorization

**Isolation is by computing unit.** A pod mounts `/var/lib/texera-mounts/<cuid>` and
nothing above it, and the mounter puts that unit's mounts underneath. Two units mounting
the same model version get two separate mounts and neither can reach the other's. Keying
on repository and commit alone — which is how a model version is named everywhere else —
would quietly collapse them into one shared mount.

**Authorization is the pod's own per-user JWT.** It is handed to GeeseFS as its S3 access
key, and file-service's read-only S3 proxy verifies it and then checks that user's read
access to the model. No global LakeFS credential is given to the mounter or to the pod, so
a mount can never reach further than the user asking for it could.

A commit is immutable, so a mount is created at most once per (repository, commit) per pod
and reused by every later worker.

## Configuration

Both sides have to agree, because the pod reaches its node's mounter on that port and
receives the mount from that host path.

| Chart value | Manager env | Default |
| --- | --- | --- |
| `mounter.port` | `KUBERNETES_MOUNTER_PORT` | `8100` |
| `mounter.hostMountRoot` | `KUBERNETES_MOUNTER_HOST_ROOT` | `/var/lib/texera-mounts` |
| `workflowComputingUnitPool.podNamePrefix` | `KUBERNETES_COMPUTE_UNIT_POD_NAME_PREFIX` | `computing-unit` |

The pod name prefix is in that list because the mounter reads a computing unit's id back
out of its pod name. `bin/k8s/tests/test_helm_values.sh` guards the chart half against
drifting away from what the templates read.

## Limits

- **Kubernetes only.** A local computing unit is a JVM process with no node mounter, so
  mounting is unavailable there and the mount listing is empty rather than an error.
- **Read-only.** A mount exposes a committed version; a UDF cannot write back through it.
- **A mount is not reclaimed until the pod goes.** Nothing unmounts a version that an
  execution has finished with, so a long-lived unit accumulates one mount per distinct
  version it has been asked for.
