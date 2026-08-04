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
import { listMountedModels } from "@texera/sdk";
import type { McpContext } from "../context";
import { formatTable, joinSections } from "../format";
import { registerTool } from "../register";

/**
 * Reading what a computing unit has mounted.
 *
 * Mounting itself is not something a caller does. A Python UDF names the model
 * versions it needs in its `modelVariables` property, and the engine mounts
 * them when the worker starts — the pod gets the version as a read-only FUSE
 * filesystem, nothing is copied, and only the bytes the UDF reads cross the
 * network. So binding the variable is the whole of the work, and there is no
 * separate step to forget.
 *
 * This tool exists to answer "what did that unit actually end up with", which
 * is a question worth being able to ask when a UDF cannot find its model.
 */

export function registerMountTools(server: McpServer, context: McpContext): void {
  registerTool(server, context, {
    name: "computing_unit_list_mounts",
    title: "List the models mounted on a computing unit",
    description:
      "Show which model versions are currently readable inside a computing unit, and where each one " +
      "appears in its filesystem. Diagnostic only — the engine mounts what a UDF's modelVariables name " +
      "when the worker starts, so a model missing here before a run is not a problem.",
    inputSchema: { cuid: z.number().int().describe("Computing unit id") },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: { cuid: number }, ctx) => {
      const mounts = await listMountedModels(ctx.client, args.cuid);
      if (mounts.length === 0) {
        return (
          `No models are mounted on computing unit ${args.cuid} yet. That is expected before a run: ` +
          `a model is mounted when a Python UDF that names it starts.`
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
}
