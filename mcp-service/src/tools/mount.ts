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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TexeraApiError,
  getModel,
  listComputingUnits,
  listModelVersions,
  listMountedModels,
  modelVersionRootPath,
  mountModel,
  unmountModel,
} from "@texera/sdk";
import type { McpContext } from "../context";
import { ToolError } from "../errors";
import { formatTable, joinSections } from "../format";
import { registerTool } from "../register";

/**
 * Mounting is what makes a large model usable from a Python UDF.
 *
 * The computing unit's pod gets the model version as a read-only FUSE
 * filesystem: nothing is copied at mount time and only the bytes a UDF actually
 * reads ever cross the network, so a 1 GB checkpoint costs a few hundred
 * milliseconds to attach. The pod stays unprivileged — a per-node mounter does
 * the work and the mount is propagated in — and reads are authorised as the
 * requesting user, so mounting cannot reach a model the user cannot read.
 *
 * Two properties follow that a caller has to plan around:
 *
 * - A mount is pinned to a **commit**, so only committed versions can be
 *   mounted, and a new version needs a new mount.
 * - Mounts live in the node's kernel mount table, not in a database, so they
 *   belong to the running pod and are gone when it is.
 */

const modelPathArg = z
  .string()
  .min(1)
  .describe('Model version path, "/models/ownerEmail/modelName/versionName". model_list_versions prints it.');

/** Turns a mid/version pair into the logical path the mount API takes. */
async function resolveModelPath(
  ctx: McpContext,
  args: { model_path?: string; mid?: number; version?: number | string }
): Promise<string> {
  if (args.model_path) return args.model_path;
  if (args.mid === undefined) {
    throw new ToolError("Pass either model_path, or mid (with an optional version).");
  }
  const [entry, versions] = await Promise.all([
    getModel(ctx.client, args.mid),
    listModelVersions(ctx.client, args.mid),
  ]);
  if (versions.length === 0) {
    throw new ToolError(
      `Model ${args.mid} ("${entry.model.name}") has no committed versions, so there is nothing to mount. ` +
        `Upload the weights and call model_create_version.`
    );
  }
  const version =
    args.version === undefined
      ? versions[0]
      : versions.find(candidate =>
          typeof args.version === "number"
            ? candidate.mvid === args.version
            : candidate.name === args.version || String(candidate.mvid) === args.version
        );
  if (!version) {
    throw new ToolError(
      `Model ${args.mid} has no version "${args.version}". ` +
        `Available: ${versions.map(v => `${v.name} (mvid ${v.mvid})`).join(", ")}`
    );
  }
  return modelVersionRootPath(entry.ownerEmail, entry.model.name, version.name);
}

async function requireKubernetesUnit(ctx: McpContext, cuid: number): Promise<string> {
  const units = await listComputingUnits(ctx.client);
  const unit = units.find(candidate => candidate.computingUnit.cuid === cuid);
  if (!unit) {
    throw new ToolError(
      `No computing unit ${cuid} is available to this account. computing_unit_list shows the ones you can use.`
    );
  }
  if (unit.computingUnit.type && unit.computingUnit.type !== "kubernetes") {
    throw new ToolError(
      `Computing unit ${cuid} ("${unit.computingUnit.name}") is a ${unit.computingUnit.type} unit. ` +
        `Model mounting needs a Kubernetes unit, because the mount is performed by that unit's node. ` +
        `Create one with computing_unit_create(unit_type: "kubernetes").`
    );
  }
  if (unit.status !== "Running") {
    throw new ToolError(
      `Computing unit ${cuid} ("${unit.computingUnit.name}") is ${unit.status}, not Running, so it has no pod ` +
        `to mount into yet. Wait for it to start and try again.`
    );
  }
  return unit.computingUnit.name;
}

export function registerMountTools(server: McpServer, context: McpContext): void {
  registerTool(server, context, {
    name: "computing_unit_list_mounts",
    title: "List the models mounted on a computing unit",
    description:
      "Show which model versions are currently readable inside a computing unit, and where each one " +
      "appears in its filesystem. A Python UDF can only load a model that appears here.",
    inputSchema: { cuid: z.number().int().describe("Computing unit id") },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: { cuid: number }, ctx) => {
      const mounts = await listMountedModels(ctx.client, args.cuid);
      if (mounts.length === 0) {
        return (
          `No models are mounted on computing unit ${args.cuid}. ` +
          `Mount one with computing_unit_mount_model before a Python UDF tries to load it.`
        );
      }
      return joinSections(
        `${mounts.length} model version(s) mounted on computing unit ${args.cuid}:`,
        formatTable(
          ["model path", "repository", "commit", "mount path"],
          mounts.map(mount => [
            mount.modelPath || "(unresolved)",
            mount.repositoryName,
            mount.commitHash.slice(0, 12),
            mount.mountPath,
          ])
        )
      );
    },
  });

  registerTool(server, context, {
    name: "computing_unit_mount_model",
    title: "Mount a model version into a computing unit",
    description:
      "Make a committed model version readable inside a computing unit, as a read-only filesystem. " +
      "Nothing is transferred until a UDF reads it, so mounting a multi-gigabyte checkpoint is fast. " +
      "Do this before running a workflow whose Python UDF binds a modelVariables entry to the model — " +
      "without a mount, the UDF has no file to open. Mounting the same version twice is harmless.",
    inputSchema: {
      cuid: z.number().int().describe("Computing unit id, from computing_unit_list"),
      model_path: modelPathArg.optional(),
      mid: z.number().int().optional().describe("Model id, as an alternative to model_path"),
      version: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Version id or name to mount when using mid. Defaults to the newest version."),
    },
    handler: async (args: { cuid: number; model_path?: string; mid?: number; version?: number | string }, ctx) => {
      const unitName = await requireKubernetesUnit(ctx, args.cuid);
      const modelPath = await resolveModelPath(ctx, args);

      let mount;
      try {
        mount = await mountModel(ctx.client, args.cuid, modelPath);
      } catch (error) {
        if (error instanceof TexeraApiError && error.status === 400) {
          throw new ToolError(
            `Could not mount "${modelPath}" on computing unit ${args.cuid}: ${error.body || error.statusText}. ` +
              `Check the path with model_list_versions — it must name a committed version.`
          );
        }
        throw error;
      }

      return joinSections(
        `Mounted ${mount.modelPath || modelPath} on computing unit ${args.cuid} ("${unitName}") ` +
          `at ${mount.mountPath} (commit ${mount.commitHash.slice(0, 12)}).`,
        `To use it from a Python UDF, add a modelVariables entry on the operator binding a variable name ` +
          `to this model path; the variable is then set to the mount path inside the UDF.`
      );
    },
  });

  registerTool(server, context, {
    name: "computing_unit_unmount_model",
    title: "Unmount a model from a computing unit",
    description:
      "Remove a model version's mount from a computing unit. Any workflow whose UDF loads it will stop " +
      "working until it is mounted again. The model itself is untouched.",
    inputSchema: {
      cuid: z.number().int().describe("Computing unit id"),
      model_path: modelPathArg.optional(),
      mid: z.number().int().optional().describe("Model id, as an alternative to model_path"),
      version: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Version id or name when using mid. Defaults to the newest version."),
    },
    annotations: { destructiveHint: true },
    handler: async (args: { cuid: number; model_path?: string; mid?: number; version?: number | string }, ctx) => {
      const modelPath = await resolveModelPath(ctx, args);
      await unmountModel(ctx.client, args.cuid, modelPath);
      return `Unmounted ${modelPath} from computing unit ${args.cuid}.`;
    },
  });
}
