/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTexera, json, text } from "../testing/fake-texera";
import {
  OPERATOR_METADATA,
  computingUnitResponse,
  modelResponse,
  modelVersionResponse,
  mountedModelResponse,
  twoOperatorContent,
  workflowResponse,
} from "../testing/fixtures";
import { startHarness, type Harness } from "../testing/harness";

let harness: Harness | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempFile(name: string, bytes: Uint8Array | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "texera-mcp-test-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

/** A deployment with the model endpoints the tools use, all succeeding. */
function deploymentWithModel(): FakeTexera {
  const deployment = new FakeTexera();
  deployment.get("/api/model/list", () => json([modelResponse()]));
  deployment.get("/api/model/:mid", () => json(modelResponse()));
  deployment.get("/api/model/:mid/version/list", () => json([modelVersionResponse()]));
  deployment.get("/api/model/:mid/diff", () => json([]));
  deployment.post("/api/model/:mid/upload", () => json({ message: "ok" }));
  deployment.post("/api/model/multipart-upload", request => {
    const type = request.query.get("type");
    if (type === "init") return json({ missingParts: [1, 2], completedPartsCount: 0 });
    return json({ message: "ok", filePath: request.query.get("filePath") });
  });
  deployment.post("/api/model/multipart-upload/part", () => text("", 200));
  return deployment;
}

describe("model tools", () => {
  it("lists models with their framework, format and size", async () => {
    const deployment = new FakeTexera().get("/api/model/list", () => json([modelResponse()]));
    harness = await startHarness(deployment);

    const output = await harness.call("model_list");
    expect(output).toContain("iris-classifier");
    expect(output).toContain("pytorch/state-dict");
    expect(output).toContain("1.0 GB");
  });

  it("shows a version's mount locator and model path", async () => {
    harness = await startHarness(deploymentWithModel());

    const output = await harness.call("model_get", { mid: 5 });
    expect(output).toContain("/models/alice@example.org/iris-classifier/v1");
    expect(output).toContain("model-5:5226497070d1");
  });

  it("rejects a model name the backend would reject, naming the rule", async () => {
    harness = await startHarness(new FakeTexera());

    const error = await harness.callExpectingError("model_create", { name: "iris classifier.v2" });
    expect(error).toContain("letters, digits, underscore and hyphen");
  });

  it("creates a model and points at the next step", async () => {
    const deployment = new FakeTexera().post("/api/model/create", () => json(modelResponse()));
    harness = await startHarness(deployment);

    const output = await harness.call("model_create", {
      name: "iris-classifier",
      framework: "pytorch",
      format: "state-dict",
    });
    expect(output).toContain("Created model 5");
    expect(output).toContain("model_create_version");

    const sent = JSON.parse(deployment.recorded("POST", "/api/model/create")[0].body!);
    expect(sent).toMatchObject({ modelName: "iris-classifier", framework: "pytorch", format: "state-dict" });
  });

  it("explains a version-create rejection as nothing being staged", async () => {
    // The backend 400s when the working branch is clean, which reads as a
    // failure but means "you forgot to upload".
    const deployment = deploymentWithModel().post("/api/model/:mid/version/create", () =>
      text("No changes detected in model. Version creation aborted.", 400)
    );
    harness = await startHarness(deployment);

    const error = await harness.callExpectingError("model_create_version", { mid: 5 });
    expect(error).toContain("no staged changes");
    expect(error).toContain("model_upload_local_file");
  });

  it("commits a version and reports the locator to mount", async () => {
    const deployment = deploymentWithModel().post("/api/model/:mid/version/create", () =>
      json({ modelVersion: modelVersionResponse(), fileNodes: [] })
    );
    harness = await startHarness(deployment);

    const output = await harness.call("model_create_version", { mid: 5, version_name: "trained" });
    expect(output).toContain("Mount locator: model-5:5226497070d1");
    expect(output).toContain("computing_unit_mount_model");
    // The endpoint takes a bare string body, not JSON.
    expect(deployment.recorded("POST", "/api/model/5/version/create")[0].body).toEqual("trained");
  });

  it("lists a version's files with the path they have inside the mount", async () => {
    const deployment = deploymentWithModel().get("/api/model/:mid/version/:mvid/rootFileNodes", () =>
      json({
        size: 1024,
        fileNodes: [
          {
            name: "iris.pt",
            type: "file",
            parentDir: "/models/alice@example.org/iris-classifier/v1",
            ownerEmail: "alice@example.org",
            size: 1024,
          },
        ],
      })
    );
    harness = await startHarness(deployment);

    const output = await harness.call("model_list_files", { mid: 5 });
    expect(output).toContain("iris.pt");
    expect(output).toContain("<mount>/iris.pt");
  });

  describe("model_upload_local_file", () => {
    it("sends a small file in one request", async () => {
      const deployment = deploymentWithModel();
      harness = await startHarness(deployment);
      const path = await tempFile("labels.bin", new Uint8Array(64));

      const output = await harness.call("model_upload_local_file", { mid: 5, local_path: path });
      expect(output).toContain("in one request");
      expect(output).toContain("labels.bin");
      expect(deployment.recorded("POST", "/api/model/5/upload")).toHaveLength(1);
    });

    it("switches to multipart for a file over the part size, and finishes the session", async () => {
      const deployment = deploymentWithModel();
      // A 3-part-sized file with a 1 KiB part size keeps the test cheap while
      // still exercising the multipart path.
      harness = await startHarness(deployment, { TEXERA_MULTIPART_PART_BYTES: "1024" });
      const path = await tempFile("model.pt", new Uint8Array(2048));

      const output = await harness.call("model_upload_local_file", {
        mid: 5,
        local_path: path,
        file_path: "weights/model.pt",
      });
      expect(output).toContain("in 2 parts");

      const parts = deployment.recorded("POST", "/api/model/multipart-upload/part");
      expect(parts.map(request => request.query.get("partNumber"))).toEqual(["1", "2"]);
      expect(parts[0].query.get("modelName")).toEqual("iris-classifier");
      expect(parts[0].query.get("ownerEmail")).toEqual("alice@example.org");

      const types = deployment
        .recorded("POST", "/api/model/multipart-upload")
        .map(request => request.query.get("type"));
      expect(types).toEqual(["init", "finish"]);
    });

    it("resumes rather than restarting when parts are already uploaded", async () => {
      const deployment = deploymentWithModel().post("/api/model/multipart-upload", request => {
        if (request.query.get("type") === "init") return json({ missingParts: [2], completedPartsCount: 1 });
        return json({ message: "ok" });
      });
      harness = await startHarness(deployment, { TEXERA_MULTIPART_PART_BYTES: "1024" });
      const path = await tempFile("model.pt", new Uint8Array(2048));

      const output = await harness.call("model_upload_local_file", { mid: 5, local_path: path });
      expect(output).toContain("1 of 2 parts");
      expect(deployment.recorded("POST", "/api/model/multipart-upload/part")).toHaveLength(1);
    });

    it("aborts the session when a part fails, so a retry does not resume into it", async () => {
      const deployment = deploymentWithModel().post("/api/model/multipart-upload/part", () => text("disk full", 500));
      harness = await startHarness(deployment, { TEXERA_MULTIPART_PART_BYTES: "1024" });
      const path = await tempFile("model.pt", new Uint8Array(2048));

      await harness.callExpectingError("model_upload_local_file", { mid: 5, local_path: path });
      const types = deployment
        .recorded("POST", "/api/model/multipart-upload")
        .map(request => request.query.get("type"));
      expect(types).toEqual(["init", "abort"]);
    });

    it("refuses a relative path, which would resolve somewhere the user did not mean", async () => {
      harness = await startHarness(deploymentWithModel());
      const error = await harness.callExpectingError("model_upload_local_file", {
        mid: 5,
        local_path: "artifacts/model.pt",
      });
      expect(error).toContain("must be absolute");
    });

    it("refuses a path outside TEXERA_LOCAL_FILE_ROOT when one is configured", async () => {
      harness = await startHarness(deploymentWithModel(), { TEXERA_LOCAL_FILE_ROOT: "/opt/texera-models" });
      const path = await tempFile("model.pt", new Uint8Array(16));

      const error = await harness.callExpectingError("model_upload_local_file", { mid: 5, local_path: path });
      expect(error).toContain("/opt/texera-models");
    });

    it("reports a missing file plainly", async () => {
      harness = await startHarness(deploymentWithModel());
      const error = await harness.callExpectingError("model_upload_local_file", {
        mid: 5,
        local_path: "/nonexistent/model.pt",
      });
      expect(error).toContain("No such file");
    });

    it("refuses to upload to a model the account can only read", async () => {
      const deployment = deploymentWithModel().get("/api/model/:mid", () =>
        json(modelResponse({ isOwner: false, accessPrivilege: "READ" }))
      );
      harness = await startHarness(deployment);
      const path = await tempFile("model.pt", new Uint8Array(16));

      const error = await harness.callExpectingError("model_upload_local_file", { mid: 5, local_path: path });
      expect(error).toContain("READ access");
    });
  });

  it("requires the exact name before deleting a model", async () => {
    const deployment = deploymentWithModel().delete("/api/model/:mid", () => text("", 200));
    harness = await startHarness(deployment);

    const error = await harness.callExpectingError("model_delete", { mid: 5, confirm_name: "iris" });
    expect(error).toContain("must exactly match");
    expect(deployment.recorded("DELETE", "/api/model/5")).toHaveLength(0);

    const output = await harness.call("model_delete", { mid: 5, confirm_name: "iris-classifier" });
    expect(output).toContain("Deleted model 5");
  });
});

describe("mount tools", () => {
  function deploymentWithUnit(): FakeTexera {
    return deploymentWithModel()
      .get("/api/computing-unit", () => json([computingUnit()]))
      .get("/api/computing-unit/:cuid/mounts", () => json([]))
      .post("/api/computing-unit/:cuid/mounts", () => json(mountedModelResponse()))
      .delete("/api/computing-unit/:cuid/mounts", () => text("", 200));
  }

  function computingUnit(overrides: Partial<{ type: string; status: string }> = {}) {
    return {
      computingUnit: {
        cuid: 1,
        uid: 7,
        name: "model-demo",
        creationTime: 1_700_000_000_000,
        terminateTime: null,
        type: overrides.type ?? "kubernetes",
      },
      status: overrides.status ?? "Running",
      metrics: { cpuUsage: "0.1", memoryUsage: "512Mi" },
      isOwner: true,
      accessPrivilege: "WRITE",
    };
  }

  it("mounts the newest version when given only a model id", async () => {
    const deployment = deploymentWithUnit();
    harness = await startHarness(deployment);

    const output = await harness.call("computing_unit_mount_model", { cuid: 1, mid: 5 });
    expect(output).toContain("Mounted /models/alice@example.org/iris-classifier/v1");
    expect(output).toContain("modelVariables");

    const sent = JSON.parse(deployment.recorded("POST", "/api/computing-unit/1/mounts")[0].body!);
    expect(sent).toEqual({ modelPath: "/models/alice@example.org/iris-classifier/v1" });
  });

  it("refuses a local computing unit, explaining why mounting needs a node", async () => {
    const deployment = deploymentWithUnit().get("/api/computing-unit", () => json([computingUnit({ type: "local" })]));
    harness = await startHarness(deployment);

    const error = await harness.callExpectingError("computing_unit_mount_model", { cuid: 1, mid: 5 });
    expect(error).toContain("Kubernetes unit");
  });

  it("refuses a unit that is not Running yet", async () => {
    const deployment = deploymentWithUnit().get("/api/computing-unit", () =>
      json([computingUnit({ status: "Pending" })])
    );
    harness = await startHarness(deployment);

    const error = await harness.callExpectingError("computing_unit_mount_model", { cuid: 1, mid: 5 });
    expect(error).toContain("Pending");
  });

  it("refuses to mount a model with no committed version", async () => {
    const deployment = deploymentWithUnit().get("/api/model/:mid/version/list", () => json([]));
    harness = await startHarness(deployment);

    const error = await harness.callExpectingError("computing_unit_mount_model", { cuid: 1, mid: 5 });
    expect(error).toContain("no committed versions");
  });

  it("says what to do next when nothing is mounted", async () => {
    harness = await startHarness(deploymentWithUnit());
    const output = await harness.call("computing_unit_list_mounts", { cuid: 1 });
    expect(output).toContain("computing_unit_mount_model");
  });

  it("lists mounts with the path they appear at inside the pod", async () => {
    const deployment = deploymentWithUnit().get("/api/computing-unit/:cuid/mounts", () =>
      json([mountedModelResponse()])
    );
    harness = await startHarness(deployment);

    const output = await harness.call("computing_unit_list_mounts", { cuid: 1 });
    expect(output).toContain("/mnt/texera-mounts/model-5/");
    expect(output).toContain("/models/alice@example.org/iris-classifier/v1");
  });

  it("unmounts by explicit model path", async () => {
    const deployment = deploymentWithUnit();
    harness = await startHarness(deployment);

    const output = await harness.call("computing_unit_unmount_model", {
      cuid: 1,
      model_path: "/models/alice@example.org/iris-classifier/v1",
    });
    expect(output).toContain("Unmounted");
    const sent = JSON.parse(deployment.recorded("DELETE", "/api/computing-unit/1/mounts")[0].body!);
    expect(sent).toEqual({ modelPath: "/models/alice@example.org/iris-classifier/v1" });
  });
});

describe("workflow_run mount precondition", () => {
  it("refuses to run a UDF whose model is not mounted, and names the fix", async () => {
    const deployment = new FakeTexera()
      .get("/api/resources/operator-metadata", () => json(OPERATOR_METADATA))
      .get("/api/workflow/:wid", () =>
        json(
          workflowResponse({
            wid: 4,
            content: {
              operators: [
                {
                  operatorID: "PythonUDFV2-operator-1",
                  operatorType: "PythonUDFV2",
                  operatorVersion: "1",
                  operatorProperties: {
                    code: "pass",
                    workers: 1,
                    modelVariables: [{ variableName: "IRIS_MODEL", modelPath: "/models/alice@example.org/iris/v1" }],
                  },
                  inputPorts: [],
                  outputPorts: [{ portID: "output-0", displayName: "" }],
                  showAdvanced: false,
                  isDisabled: false,
                },
              ],
              links: [],
              operatorPositions: { "PythonUDFV2-operator-1": { x: 0, y: 0 } },
              commentBoxes: [],
              settings: { dataTransferBatchSize: 400 },
            } as never,
          })
        )
      )
      .get("/api/computing-unit", () => json([computingUnitResponse()]))
      .get("/api/computing-unit/:cuid/mounts", () => json([]));
    harness = await startHarness(deployment);

    await harness.call("workflow_open", { wid: 4 });
    const error = await harness.callExpectingError("workflow_run", {});
    expect(error).toContain("IRIS_MODEL");
    expect(error).toContain('computing_unit_mount_model(cuid: 1, model_path: "/models/alice@example.org/iris/v1")');
  });

  it("runs when the model is mounted", async () => {
    const deployment = new FakeTexera()
      .get("/api/resources/operator-metadata", () => json(OPERATOR_METADATA))
      .get("/api/workflow/:wid", () => json(workflowResponse({ wid: 4, content: twoOperatorContent() })))
      .get("/api/computing-unit", () => json([computingUnitResponse()]))
      .get("/api/computing-unit/:cuid/mounts", () => json([mountedModelResponse()]))
      .post("/api/execution/:wid/:cuid/run", () =>
        json({ status: "COMPLETED", operatorResults: {}, operatorStats: {}, compilationErrors: {}, runtimeErrors: [] })
      );
    harness = await startHarness(deployment);

    await harness.call("workflow_open", { wid: 4 });
    const output = await harness.call("workflow_run", {});
    expect(output).toContain("Ran workflow 4");
  });
});

describe("upload ceiling", () => {
  it("names the site setting when the deployment's per-file ceiling rejects a checkpoint", async () => {
    const deployment = deploymentWithModel().post("/api/model/multipart-upload", request =>
      request.query.get("type") === "init"
        ? text("fileSizeBytes=1024013755 exceeds singleFileUploadMaxBytes=20971520", 400)
        : json({ message: "ok" })
    );
    harness = await startHarness(deployment, { TEXERA_MULTIPART_PART_BYTES: "1024" });
    const path = await tempFile("model.pt", new Uint8Array(2048));

    const error = await harness.callExpectingError("model_upload_local_file", { mid: 5, local_path: path });
    expect(error).toContain("single_file_upload_max_size_mib");
    expect(error).toContain("administrator");
  });
});
