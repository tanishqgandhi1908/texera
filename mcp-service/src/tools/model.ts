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
  MODEL_FORMATS,
  MODEL_FRAMEWORKS,
  MODEL_NAME_MAX_LENGTH,
  MODEL_NAME_PATTERN,
  TexeraApiError,
  createModel,
  createModelVersion,
  deleteModel,
  deleteModelFile,
  flattenFileNodes,
  getModel,
  getModelUncommittedChanges,
  getModelVersionFileNodes,
  listModelVersions,
  listModels,
  modelLocator,
  modelVersionRootPath,
  setModelDownloadable,
  setModelPublic,
  updateModelDescription,
  updateModelName,
  uploadModelFile,
  uploadModelFileMultipart,
  type ModelVersion,
} from "@texera/sdk";
import type { McpContext } from "../context";
import { ToolError } from "../errors";
import { formatBytes, formatTable, formatTimestamp, joinSections } from "../format";
import { registerTool } from "../register";
import { openLocalFile } from "../local-file";

/**
 * Models are versioned like datasets and mounted like nothing else: a
 * computing unit exposes a model *version* as a read-only filesystem, so a
 * Python UDF opens a multi-gigabyte checkpoint without the pod ever
 * downloading it.
 *
 * Three orderings are easy to get wrong and are repeated into the tool
 * descriptions, because each produces something that looks finished and does
 * not work:
 *
 *   upload -> model_create_version   an uncommitted file cannot be mounted
 *   version -> computing_unit_mount  a mount is pinned to one commit
 *   mount -> modelVariables          the UDF needs the variable bound to it
 */
const COMMIT_NOTE = "Uploads are staged, and cannot be mounted or read, until model_create_version commits them.";

/** Resolves a version by id, by name, or (default) the newest one. */
async function resolveModelVersion(
  context: McpContext,
  mid: number,
  version: number | string | undefined
): Promise<ModelVersion> {
  const versions = await listModelVersions(context.client, mid);
  if (versions.length === 0) {
    throw new ToolError(
      `Model ${mid} has no versions yet. Upload the weights with model_upload_local_file, then commit them ` +
        `with model_create_version.`
    );
  }
  if (version === undefined) {
    // listModelVersions returns newest-first.
    return versions[0];
  }
  const match =
    typeof version === "number"
      ? versions.find(candidate => candidate.mvid === version)
      : versions.find(candidate => candidate.name === version || String(candidate.mvid) === version);
  if (!match) {
    throw new ToolError(
      `Model ${mid} has no version "${version}". Available: ${versions.map(v => `${v.name} (mvid ${v.mvid})`).join(", ")}`
    );
  }
  return match;
}

function requireExactName(actual: string, confirmName: string | undefined, mid: number): void {
  if (confirmName !== actual) {
    throw new ToolError(
      `Refusing to delete model ${mid}: confirm_name must exactly match its current name. ` +
        `Expected "${actual}", got ${confirmName === undefined ? "nothing" : `"${confirmName}"`}. ` +
        `Show the user what is about to be deleted and pass the name back to confirm.`
    );
  }
}

function assertRelativePath(filePath: string): void {
  if (filePath.startsWith("/") || filePath.includes("..")) {
    throw new ToolError(
      `Invalid file_path "${filePath}": use a relative path inside the model, without ".." segments.`
    );
  }
}

export function registerModelTools(server: McpServer, context: McpContext): void {
  registerTool(server, context, {
    name: "model_list",
    title: "List models",
    description:
      "List every model the account can read, with id, framework, format, size and access level. " +
      "Models hold trained weights and are mounted into computing units rather than copied into them.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_args, ctx) => {
      const models = await listModels(ctx.client);
      if (models.length === 0) {
        return "No models. Create one with model_create.";
      }
      return joinSections(
        `${models.length} model(s):`,
        formatTable(
          ["mid", "name", "owner", "framework/format", "size", "access"],
          models.map(entry => [
            entry.model.mid,
            entry.model.name,
            entry.ownerEmail,
            `${entry.model.framework ?? "?"}/${entry.model.format ?? "?"}`,
            formatBytes(entry.size),
            entry.isOwner ? "owner" : entry.accessPrivilege,
          ])
        )
      );
    },
  });

  registerTool(server, context, {
    name: "model_get",
    title: "Show a model and its versions",
    description:
      "Show one model's metadata and every version, including each version's commit hash and the " +
      "locator that mounts it. Use this to find the version to mount or to reference from a Python UDF.",
    inputSchema: { mid: z.number().int().describe("Model id, from model_list") },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: { mid: number }, ctx) => {
      const [entry, versions] = await Promise.all([
        getModel(ctx.client, args.mid),
        listModelVersions(ctx.client, args.mid).catch(() => [] as ModelVersion[]),
      ]);
      const model = entry.model;

      const header = formatTable(
        ["field", "value"],
        [
          ["mid", model.mid],
          ["name", model.name],
          ["owner", entry.ownerEmail],
          ["description", model.description || "(none)"],
          ["framework", model.framework ?? "(unset)"],
          ["format", model.format ?? "(unset)"],
          ["size", formatBytes(entry.size)],
          ["public", String(model.isPublic)],
          ["downloadable", String(model.isDownloadable)],
          ["repository", model.repositoryName ?? `model-${model.mid}`],
          ["access", entry.isOwner ? "owner" : entry.accessPrivilege],
        ]
      );

      const versionSection =
        versions.length === 0
          ? "No versions yet — upload files and call model_create_version."
          : formatTable(
              ["mvid", "version", "created", "model path", "mount locator"],
              versions.map(version => [
                version.mvid,
                version.name,
                formatTimestamp(version.creationTime),
                modelVersionRootPath(entry.ownerEmail, model.name, version.name),
                modelLocator(model, version),
              ])
            );

      return joinSections(header, `Versions (${versions.length}):`, versionSection);
    },
  });

  registerTool(server, context, {
    name: "model_create",
    title: "Create a model",
    description:
      "Create an empty model owned by this account. Follow it with model_upload_local_file and then " +
      "model_create_version to make the weights mountable. " +
      "Framework and format are fixed at creation — there is no way to change them afterwards, so a " +
      "wrong value means deleting the model and starting again.",
    inputSchema: {
      name: z
        .string()
        .min(1)
        .describe("Model name. Letters, digits, underscore and hyphen only; unique among this account's models."),
      description: z.string().optional().describe("Human-readable description"),
      framework: z
        .enum(MODEL_FRAMEWORKS)
        .optional()
        .describe(`Training framework. Defaults to pytorch. One of: ${MODEL_FRAMEWORKS.join(", ")}.`),
      format: z
        .enum(MODEL_FORMATS)
        .optional()
        .describe(
          `Serialization format. One of: ${MODEL_FORMATS.join(", ")}. ` +
            `A torch.save of a state dict is "state-dict"; a torch.jit.save is "torchscript".`
        ),
      is_public: z.boolean().optional().describe("Readable by anyone on the deployment. Defaults to false."),
      is_downloadable: z.boolean().optional().describe("Allow others to download the files. Defaults to false."),
    },
    handler: async (
      args: {
        name: string;
        description?: string;
        framework?: string;
        format?: string;
        is_public?: boolean;
        is_downloadable?: boolean;
      },
      ctx
    ) => {
      // Checked here as well as server-side so the message names the rule
      // rather than surfacing as a bare 400.
      if (!MODEL_NAME_PATTERN.test(args.name) || args.name.length > MODEL_NAME_MAX_LENGTH) {
        throw new ToolError(
          `Invalid model name "${args.name}": use only letters, digits, underscore and hyphen, ` +
            `at most ${MODEL_NAME_MAX_LENGTH} characters. Spaces and dots are not allowed.`
        );
      }
      const created = await createModel(ctx.client, {
        modelName: args.name,
        modelDescription: args.description,
        framework: args.framework,
        format: args.format,
        isModelPublic: args.is_public,
        isModelDownloadable: args.is_downloadable,
      });
      return (
        `Created model ${created.model.mid} "${created.model.name}" ` +
        `(${created.model.framework ?? "pytorch"}/${created.model.format ?? "unset"}), ` +
        `repository ${created.model.repositoryName ?? `model-${created.model.mid}`}.\n` +
        `Next: model_upload_local_file to add the weights, then model_create_version.`
      );
    },
  });

  registerTool(server, context, {
    name: "model_update",
    title: "Change a model's name, description or visibility",
    description: "Rename a model, change its description, or set whether it is public and downloadable.",
    inputSchema: {
      mid: z.number().int().describe("Model id"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      is_public: z.boolean().optional().describe("Readable by anyone on the deployment"),
      is_downloadable: z.boolean().optional().describe("Allow others to download the files. Owner only."),
    },
    handler: async (
      args: { mid: number; name?: string; description?: string; is_public?: boolean; is_downloadable?: boolean },
      ctx
    ) => {
      const changes: string[] = [];
      if (args.name !== undefined) {
        if (!MODEL_NAME_PATTERN.test(args.name) || args.name.length > MODEL_NAME_MAX_LENGTH) {
          throw new ToolError(
            `Invalid model name "${args.name}": letters, digits, underscore and hyphen only, ` +
              `at most ${MODEL_NAME_MAX_LENGTH} characters.`
          );
        }
        await updateModelName(ctx.client, args.mid, args.name);
        changes.push(`name -> "${args.name}"`);
      }
      if (args.description !== undefined) {
        await updateModelDescription(ctx.client, args.mid, args.description);
        changes.push("description updated");
      }
      if (args.is_public !== undefined) {
        const changed = await setModelPublic(ctx.client, args.mid, args.is_public);
        changes.push(changed ? `public -> ${args.is_public}` : `public already ${args.is_public}`);
      }
      if (args.is_downloadable !== undefined) {
        const changed = await setModelDownloadable(ctx.client, args.mid, args.is_downloadable);
        changes.push(
          changed ? `downloadable -> ${args.is_downloadable}` : `downloadable already ${args.is_downloadable}`
        );
      }
      if (changes.length === 0) {
        throw new ToolError("Nothing to change — pass at least one of name, description, is_public, is_downloadable.");
      }
      return `Model ${args.mid}: ${changes.join("; ")}.`;
    },
  });

  registerTool(server, context, {
    name: "model_delete",
    title: "Delete a model",
    description:
      "Permanently delete a model, every version and all its files. This cannot be undone, and any " +
      "workflow referencing it will stop working. Requires the model's exact current name as confirmation.",
    inputSchema: {
      mid: z.number().int().describe("Model id"),
      confirm_name: z.string().describe("The model's exact current name, to confirm the right one is being deleted"),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (args: { mid: number; confirm_name: string }, ctx) => {
      const entry = await getModel(ctx.client, args.mid);
      requireExactName(entry.model.name, args.confirm_name, args.mid);
      await deleteModel(ctx.client, args.mid);
      return `Deleted model ${args.mid} "${entry.model.name}" and all of its versions.`;
    },
  });

  registerTool(server, context, {
    name: "model_list_versions",
    title: "List a model's versions",
    description:
      "List every committed version with its commit hash, the `/models/...` path a Python UDF references, " +
      "and the locator that mounts it.",
    inputSchema: { mid: z.number().int().describe("Model id") },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: { mid: number }, ctx) => {
      const [entry, versions] = await Promise.all([
        getModel(ctx.client, args.mid),
        listModelVersions(ctx.client, args.mid),
      ]);
      if (versions.length === 0) {
        return `Model ${args.mid} has no versions. Upload files, then call model_create_version.`;
      }
      return joinSections(
        `${versions.length} version(s) of "${entry.model.name}", newest first:`,
        formatTable(
          ["mvid", "version", "created", "model path", "mount locator"],
          versions.map(version => [
            version.mvid,
            version.name,
            formatTimestamp(version.creationTime),
            modelVersionRootPath(entry.ownerEmail, entry.model.name, version.name),
            modelLocator(entry.model, version),
          ])
        )
      );
    },
  });

  registerTool(server, context, {
    name: "model_create_version",
    title: "Commit staged model files as a version",
    description:
      "Commit everything currently staged into a new, immutable version. This is the step that makes " +
      "uploaded weights mountable — until it runs, a computing unit has nothing to pin a mount to. " +
      "Fails when nothing is staged.",
    inputSchema: {
      mid: z.number().int().describe("Model id"),
      version_name: z
        .string()
        .optional()
        .describe(
          'Label appended to the generated name, e.g. "trained on 2026 data". The v-number is added by Texera.'
        ),
    },
    handler: async (args: { mid: number; version_name?: string }, ctx) => {
      let created;
      try {
        created = await createModelVersion(ctx.client, args.mid, args.version_name ?? "");
      } catch (error) {
        if (error instanceof TexeraApiError && error.status === 400) {
          throw new ToolError(
            `Model ${args.mid} has no staged changes, so there is nothing to commit. ` +
              `Upload a file first (model_upload_local_file), or check model_uncommitted_changes.`
          );
        }
        throw error;
      }
      const entry = await getModel(ctx.client, args.mid);
      return (
        `Created version "${created.modelVersion.name}" (mvid ${created.modelVersion.mvid}) of model ${args.mid}.\n` +
        `Model path: ${modelVersionRootPath(entry.ownerEmail, entry.model.name, created.modelVersion.name)}\n` +
        `Mount locator: ${modelLocator(entry.model, created.modelVersion)}\n` +
        `Next: computing_unit_mount_model to make it readable inside a computing unit.`
      );
    },
  });

  registerTool(server, context, {
    name: "model_list_files",
    title: "List the files in a model version",
    description:
      "List a version's files with their sizes and the path each one has inside a computing unit's mount. " +
      "Use this to tell a Python UDF which filename to open.",
    inputSchema: {
      mid: z.number().int().describe("Model id"),
      version: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Version id or name. Defaults to the newest version."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: { mid: number; version?: number | string }, ctx) => {
      const [entry, version] = await Promise.all([
        getModel(ctx.client, args.mid),
        resolveModelVersion(ctx, args.mid, args.version),
      ]);
      const response = await getModelVersionFileNodes(ctx.client, args.mid, version.mvid);
      const rootPath = modelVersionRootPath(entry.ownerEmail, entry.model.name, version.name);
      const files = flattenFileNodes(response.fileNodes, rootPath);

      if (files.length === 0) {
        return `Version "${version.name}" of model ${args.mid} contains no files.`;
      }

      return joinSections(
        `Version "${version.name}" (mvid ${version.mvid}) of model "${entry.model.name}" — ` +
          `${files.length} file(s), ${formatBytes(response.size)}:`,
        formatTable(
          ["file", "size", "path inside the mount"],
          files.map(file => [file.relativePath, formatBytes(file.sizeBytes), `<mount>/${file.relativePath}`])
        ),
        `A Python UDF reads these as os.path.join(<variable>, "<file>"), where <variable> is the ` +
          `modelVariables name bound to this model.`
      );
    },
  });

  registerTool(server, context, {
    name: "model_upload_local_file",
    title: "Upload a file from disk into a model",
    description:
      `Upload a file from the local filesystem into a model. ${COMMIT_NOTE} ` +
      "Large files are sent in parts and an interrupted upload resumes rather than restarting, so this " +
      "is the right tool for real checkpoints. This server runs on the user's machine, so the path is " +
      "theirs — e.g. the artifacts directory of a training run.",
    inputSchema: {
      mid: z.number().int().describe("Model id"),
      local_path: z.string().min(1).describe("Absolute path to the file on this machine"),
      file_path: z
        .string()
        .optional()
        .describe('Path within the model, e.g. "weights/model.pt". Defaults to the local file\'s name.'),
    },
    handler: async (args: { mid: number; local_path: string; file_path?: string }, ctx) => {
      const file = await openLocalFile(ctx.config, args.local_path);
      const filePath = args.file_path ?? file.name;
      assertRelativePath(filePath);

      const entry = await getModel(ctx.client, args.mid);
      if (!entry.isOwner && entry.accessPrivilege !== "WRITE") {
        throw new ToolError(
          `You have ${entry.accessPrivilege} access to model ${args.mid} ("${entry.model.name}"), so you cannot upload to it.`
        );
      }

      const started = Date.now();
      let summary: string;

      try {
        if (file.size <= ctx.config.multipartPartBytes) {
          await uploadModelFile(ctx.client, args.mid, filePath, await file.read(0, file.size));
          summary = "in one request";
        } else {
          const { totalParts, uploadedParts } = await uploadModelFileMultipart(
            ctx.client,
            { ownerEmail: entry.ownerEmail, modelName: entry.model.name, filePath },
            {
              fileSizeBytes: file.size,
              partSizeBytes: ctx.config.multipartPartBytes,
              readPart: (offset, length) => file.read(offset, length),
            }
          );
          summary =
            uploadedParts === totalParts
              ? `in ${totalParts} parts`
              : `in ${uploadedParts} of ${totalParts} parts (the rest were already uploaded)`;
        }
      } catch (error) {
        await file.close();
        // The deployment's own ceiling, not this server's — a size the admin
        // sets and can raise, so say so rather than leaving it looking like a
        // limitation of the upload.
        if (error instanceof TexeraApiError && /singleFileUploadMaxBytes/.test(error.body)) {
          throw new ToolError(
            `${file.name} is ${formatBytes(file.size)}, over this deployment's per-file ceiling. ` +
              `Server said: ${error.body.trim()}. That ceiling is the "single_file_upload_max_size_mib" ` +
              `site setting; an administrator can raise it in the admin settings page. Model checkpoints ` +
              `routinely exceed the 20 MiB default.`
          );
        }
        throw error;
      }

      await file.close();
      const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
      return (
        `Uploaded ${filePath} (${formatBytes(file.size)}) to model ${args.mid} ${summary}, in about ${seconds}s.\n` +
        `${COMMIT_NOTE}`
      );
    },
  });

  registerTool(server, context, {
    name: "model_upload_text_file",
    title: "Upload text content into a model",
    description:
      `Upload UTF-8 text as a file in a model — a label map, a config, a README next to the weights. ` +
      `${COMMIT_NOTE} Use model_upload_local_file for binary weights.`,
    inputSchema: {
      mid: z.number().int().describe("Model id"),
      file_path: z.string().min(1).describe('Path within the model, e.g. "labels.json"'),
      content: z.string().describe("UTF-8 file content"),
    },
    handler: async (args: { mid: number; file_path: string; content: string }, ctx) => {
      assertRelativePath(args.file_path);
      const bytes = new TextEncoder().encode(args.content);
      if (bytes.byteLength > ctx.config.maxUploadBytes) {
        throw new ToolError(
          `That content is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(ctx.config.maxUploadBytes)} ` +
            `inline-upload limit. Write it to a file and use model_upload_local_file instead.`
        );
      }
      await uploadModelFile(ctx.client, args.mid, args.file_path, bytes);
      return `Uploaded ${args.file_path} (${formatBytes(bytes.byteLength)}) to model ${args.mid}.\n${COMMIT_NOTE}`;
    },
  });

  registerTool(server, context, {
    name: "model_delete_file",
    title: "Delete a file from a model",
    description:
      `Stage the deletion of one file from a model's working branch. ${COMMIT_NOTE} ` +
      "Existing versions keep the file — this only affects versions created afterwards.",
    inputSchema: {
      mid: z.number().int().describe("Model id"),
      file_path: z.string().min(1).describe('Path within the model, e.g. "weights/model.pt"'),
    },
    annotations: { destructiveHint: true },
    handler: async (args: { mid: number; file_path: string }, ctx) => {
      await deleteModelFile(ctx.client, args.mid, args.file_path);
      return `Staged deletion of ${args.file_path} from model ${args.mid}. ${COMMIT_NOTE}`;
    },
  });

  registerTool(server, context, {
    name: "model_uncommitted_changes",
    title: "Show a model's staged changes",
    description:
      "Show what has been uploaded or deleted but not yet committed into a version. " +
      "Use this to check what model_create_version is about to commit.",
    inputSchema: { mid: z.number().int().describe("Model id") },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args: { mid: number }, ctx) => {
      const changes = await getModelUncommittedChanges(ctx.client, args.mid);
      if (changes.length === 0) {
        return `Model ${args.mid} has no staged changes — everything is committed.`;
      }
      return joinSections(
        `${changes.length} staged change(s) on model ${args.mid}:`,
        formatTable(
          ["change", "path", "size"],
          changes.map(change => [change.diffType, change.path, formatBytes(change.sizeBytes)])
        ),
        "Call model_create_version to commit them."
      );
    },
  });
}
