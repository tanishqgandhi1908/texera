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

import type { TexeraClient } from "../client";
import type { DatasetFileNode, DatasetDiff, PresignedUrlResponse } from "./dataset";

/**
 * Models are a first-class resource alongside datasets: a LakeFS repository
 * (`model-<mid>`) holding trained weights, versioned by commit exactly the way
 * datasets are. The same two-phase write applies —
 *
 *   upload / delete file   ->  uncommitted change on branch `main`
 *   createModelVersion     ->  commit  ->  an immutable, mountable version
 *
 * and it matters more here, because a computing unit mounts a model *at a
 * commit*: an uploaded but uncommitted checkpoint cannot be mounted at all.
 *
 * `framework` and `format` are fixed at creation — there is no endpoint to
 * change them afterwards — so a wrong value means recreating the model.
 */

/** Accepted by `POST /api/model/create`; anything else is a 400. */
export const MODEL_FRAMEWORKS = ["pytorch", "tensorflow", "onnx", "sklearn"] as const;

/** Accepted by `POST /api/model/create`; anything else is a 400. */
export const MODEL_FORMATS = [
  "torchscript",
  "state-dict",
  "safetensors",
  "onnx",
  "savedmodel",
  "joblib",
  "pickle",
] as const;

export type ModelFramework = (typeof MODEL_FRAMEWORKS)[number];
export type ModelFormat = (typeof MODEL_FORMATS)[number];

export const MODEL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MODEL_NAME_MAX_LENGTH = 128;

export interface Model {
  mid: number;
  name: string;
  description?: string;
  ownerUid: number;
  isPublic: boolean;
  isDownloadable: boolean;
  creationTime?: number;
  /** Always `model-<mid>`; this is what a mount request names. */
  repositoryName?: string;
  framework?: string;
  format?: string;
  coverImage?: string;
}

export interface DashboardModel {
  model: Model;
  ownerEmail: string;
  /** `READ` | `WRITE` | `NONE` */
  accessPrivilege: string;
  isOwner: boolean;
  /** Total repository size in bytes. */
  size: number;
}

export interface ModelVersion {
  mvid: number;
  mid: number;
  creatorUid: number;
  name: string;
  /** LakeFS commit hash — the second half of a mount locator. */
  versionHash: string;
  creationTime?: number;
}

export interface DashboardModelVersion {
  modelVersion: ModelVersion;
  fileNodes: DatasetFileNode[];
}

export interface ModelVersionRootFileNodesResponse {
  fileNodes: DatasetFileNode[];
  size: number;
}

export async function listModels(client: TexeraClient): Promise<DashboardModel[]> {
  return client.request<DashboardModel[]>("file", "/api/model/list");
}

export async function getModel(client: TexeraClient, mid: number): Promise<DashboardModel> {
  return client.request<DashboardModel>("file", `/api/model/${mid}`);
}

export async function createModel(
  client: TexeraClient,
  request: {
    modelName: string;
    modelDescription?: string;
    isModelPublic?: boolean;
    isModelDownloadable?: boolean;
    framework?: string;
    format?: string;
  }
): Promise<DashboardModel> {
  return client.request<DashboardModel>("file", "/api/model/create", {
    method: "POST",
    json: {
      modelName: request.modelName,
      modelDescription: request.modelDescription ?? "",
      isModelPublic: request.isModelPublic ?? false,
      isModelDownloadable: request.isModelDownloadable ?? false,
      framework: request.framework ?? "pytorch",
      format: request.format ?? null,
    },
  });
}

/** Deletes the model, its LakeFS repository and its S3 objects. Irreversible. */
export async function deleteModel(client: TexeraClient, mid: number): Promise<void> {
  await client.request<void>("file", `/api/model/${mid}`, { method: "DELETE" });
}

export async function updateModelName(client: TexeraClient, mid: number, name: string): Promise<void> {
  await client.request<void>("file", "/api/model/update/name", { method: "POST", json: { mid, name } });
}

export async function updateModelDescription(client: TexeraClient, mid: number, description: string): Promise<void> {
  await client.request<void>("file", "/api/model/update/description", {
    method: "POST",
    json: { mid, description },
  });
}

/** **Toggles** publicity — the endpoint takes no desired value. See {@link setModelPublic}. */
export async function toggleModelPublicity(client: TexeraClient, mid: number): Promise<void> {
  await client.request<void>("file", `/api/model/${mid}/update/publicity`, { method: "POST" });
}

/** **Toggles** downloadability. Owner-only. */
export async function toggleModelDownloadable(client: TexeraClient, mid: number): Promise<void> {
  await client.request<void>("file", `/api/model/${mid}/update/downloadable`, { method: "POST" });
}

/** Idempotent publicity setter: toggles only when the current state differs. */
export async function setModelPublic(client: TexeraClient, mid: number, isPublic: boolean): Promise<boolean> {
  const current = await getModel(client, mid);
  if (current.model.isPublic === isPublic) return false;
  await toggleModelPublicity(client, mid);
  return true;
}

/** Idempotent downloadability setter. See {@link setModelPublic}. */
export async function setModelDownloadable(
  client: TexeraClient,
  mid: number,
  isDownloadable: boolean
): Promise<boolean> {
  const current = await getModel(client, mid);
  if (current.model.isDownloadable === isDownloadable) return false;
  await toggleModelDownloadable(client, mid);
  return true;
}

export async function listModelVersions(client: TexeraClient, mid: number): Promise<ModelVersion[]> {
  return client.request<ModelVersion[]>("file", `/api/model/${mid}/version/list`);
}

export async function getLatestModelVersion(client: TexeraClient, mid: number): Promise<DashboardModelVersion> {
  return client.request<DashboardModelVersion>("file", `/api/model/${mid}/version/latest`);
}

/**
 * Commits the staged files as a new version. The backend names it `v<n>` (or
 * `v<n> - <label>`) itself, and **rejects the call with 400 when nothing is
 * staged** — which callers should report as "nothing to commit", not a failure.
 */
export async function createModelVersion(
  client: TexeraClient,
  mid: number,
  versionName = ""
): Promise<DashboardModelVersion> {
  return client.request<DashboardModelVersion>("file", `/api/model/${mid}/version/create`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: versionName,
  });
}

export async function getModelVersionFileNodes(
  client: TexeraClient,
  mid: number,
  mvid: number
): Promise<ModelVersionRootFileNodesResponse> {
  return client.request<ModelVersionRootFileNodesResponse>("file", `/api/model/${mid}/version/${mvid}/rootFileNodes`);
}

export async function getModelUncommittedChanges(client: TexeraClient, mid: number): Promise<DatasetDiff[]> {
  return client.request<DatasetDiff[]>("file", `/api/model/${mid}/diff`);
}

/** Removes a file from the model's working branch (uncommitted until a version is created). */
export async function deleteModelFile(client: TexeraClient, mid: number, filePath: string): Promise<void> {
  await client.request<void>("file", `/api/model/${mid}/file`, {
    method: "DELETE",
    query: { filePath },
  });
}

/**
 * Uploads one file in a single request. Only suitable for small files: the
 * deployment caps a single-shot upload at the `single_file_upload_max_size_mib`
 * site setting, and a failure restarts the whole transfer. Weights should go
 * through {@link uploadModelFileMultipart}.
 */
export async function uploadModelFile(
  client: TexeraClient,
  mid: number,
  filePath: string,
  content: Uint8Array | ArrayBuffer | string,
  options: { message?: string; timeoutMs?: number } = {}
): Promise<void> {
  const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
  await client.requestRaw("file", `/api/model/${mid}/upload`, {
    method: "POST",
    query: { filePath, message: options.message ?? `Uploaded ${filePath}` },
    headers: { "Content-Type": "application/octet-stream" },
    body: body as BodyInit,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
}

/** Short-lived direct-download URL for one file in a committed model version. */
export async function getModelPresignedDownloadUrl(
  client: TexeraClient,
  args: { filePath: string; repositoryName: string; commitHash: string }
): Promise<string> {
  const response = await client.request<PresignedUrlResponse>("file", "/api/model/presign-download", { query: args });
  return response.presignedUrl;
}

/**
 * The mount locator for a model version: `<repositoryName>:<commitHash>`, the
 * form the computing-unit mount API and a Python UDF's `modelVariables` take.
 */
export function modelLocator(model: Model, version: ModelVersion): string {
  return `${model.repositoryName ?? `model-${model.mid}`}:${version.versionHash}`;
}

/** The `/models/ownerEmail/modelName/versionName` prefix a version's files live under. */
export function modelVersionRootPath(ownerEmail: string, modelName: string, versionName: string): string {
  return `/models/${ownerEmail}/${modelName}/${versionName}`;
}

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------

/**
 * Multipart is the only way to get a real checkpoint in: single-shot uploads
 * are size-capped, and a 1 GB PUT that dies at 90% is a 1 GB PUT you do again.
 *
 * The endpoints address the model by owner email and *name* rather than mid,
 * and `init` is resumable — it reports which parts are still missing, so an
 * interrupted upload continues instead of restarting.
 */
export interface MultipartUploadTarget {
  ownerEmail: string;
  /** Model name, not mid — this is what the endpoint keys the session on. */
  modelName: string;
  /** Path within the model, e.g. `weights/model.pt`. */
  filePath: string;
}

export interface MultipartInitResponse {
  /** 1-based part numbers still lacking an ETag. */
  missingParts: number[];
  completedPartsCount: number;
}

/** S3's floor for every part but the last. */
export const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

export async function initModelMultipartUpload(
  client: TexeraClient,
  target: MultipartUploadTarget,
  args: { fileSizeBytes: number; partSizeBytes: number; restart?: boolean }
): Promise<MultipartInitResponse> {
  return client.request<MultipartInitResponse>("file", "/api/model/multipart-upload", {
    method: "POST",
    json: {},
    query: {
      type: "init",
      ownerEmail: target.ownerEmail,
      modelName: target.modelName,
      filePath: target.filePath,
      fileSizeBytes: args.fileSizeBytes,
      partSizeBytes: args.partSizeBytes,
      restart: args.restart ?? false,
    },
  });
}

/**
 * Uploads one part. `partNumber` is 1-based, and every part except the last
 * must be exactly `partSizeBytes` — the server checks Content-Length against
 * what `init` recorded and rejects a mismatch.
 */
export async function uploadModelPart(
  client: TexeraClient,
  target: MultipartUploadTarget,
  partNumber: number,
  content: Uint8Array,
  options: { timeoutMs?: number } = {}
): Promise<void> {
  await client.requestRaw("file", "/api/model/multipart-upload/part", {
    method: "POST",
    query: {
      ownerEmail: target.ownerEmail,
      modelName: target.modelName,
      filePath: target.filePath,
      partNumber,
    },
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(content.byteLength),
    },
    body: content as unknown as BodyInit,
    timeoutMs: options.timeoutMs ?? 600_000,
  });
}

export async function finishModelMultipartUpload(
  client: TexeraClient,
  target: MultipartUploadTarget
): Promise<{ message?: string; filePath?: string }> {
  return client.request<{ message?: string; filePath?: string }>("file", "/api/model/multipart-upload", {
    method: "POST",
    json: {},
    query: {
      type: "finish",
      ownerEmail: target.ownerEmail,
      modelName: target.modelName,
      filePath: target.filePath,
    },
    timeoutMs: 600_000,
  });
}

export async function abortModelMultipartUpload(client: TexeraClient, target: MultipartUploadTarget): Promise<void> {
  await client.request<void>("file", "/api/model/multipart-upload", {
    method: "POST",
    json: {},
    query: {
      type: "abort",
      ownerEmail: target.ownerEmail,
      modelName: target.modelName,
      filePath: target.filePath,
    },
  });
}

export interface MultipartUploadProgress {
  uploadedParts: number;
  totalParts: number;
  uploadedBytes: number;
  totalBytes: number;
}

/**
 * Drives a whole multipart upload, reading each part through `readPart` so the
 * caller decides where the bytes come from and the SDK never has to hold the
 * file in memory.
 *
 * Parts already uploaded by an earlier attempt are skipped, so calling this
 * again after a failure resumes rather than restarts.
 */
export async function uploadModelFileMultipart(
  client: TexeraClient,
  target: MultipartUploadTarget,
  args: {
    fileSizeBytes: number;
    partSizeBytes: number;
    readPart: (offset: number, length: number) => Promise<Uint8Array>;
    restart?: boolean;
    onProgress?: (progress: MultipartUploadProgress) => void;
  }
): Promise<{ totalParts: number; uploadedParts: number }> {
  const totalParts = Math.max(1, Math.ceil(args.fileSizeBytes / args.partSizeBytes));
  const init = await initModelMultipartUpload(client, target, {
    fileSizeBytes: args.fileSizeBytes,
    partSizeBytes: args.partSizeBytes,
    restart: args.restart,
  });

  const missing = init.missingParts.length > 0 ? init.missingParts : [];
  let uploadedBytes = 0;

  try {
    for (const partNumber of missing) {
      const offset = (partNumber - 1) * args.partSizeBytes;
      const length = Math.min(args.partSizeBytes, args.fileSizeBytes - offset);
      const chunk = await args.readPart(offset, length);
      await uploadModelPart(client, target, partNumber, chunk);
      uploadedBytes += chunk.byteLength;
      args.onProgress?.({
        uploadedParts: missing.indexOf(partNumber) + 1,
        totalParts,
        uploadedBytes,
        totalBytes: args.fileSizeBytes,
      });
    }
    await finishModelMultipartUpload(client, target);
  } catch (error) {
    // Leaving a half-finished session behind would make the next attempt
    // resume into a state the caller no longer intends.
    await abortModelMultipartUpload(client, target).catch(() => undefined);
    throw error;
  }

  return { totalParts, uploadedParts: missing.length };
}
