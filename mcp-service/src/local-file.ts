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

import { open, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type { McpConfig } from "./config";
import { ToolError } from "./errors";

/**
 * Reading files from the machine the server runs on.
 *
 * A model checkpoint cannot travel through a tool argument, so uploading one
 * means the server reads it off disk. That is reasonable here — an MCP server
 * over stdio is a subprocess of the user's own client, with the user's own
 * permissions — but it is worth being deliberate about: `TEXERA_LOCAL_FILE_ROOT`
 * confines it to one directory, which is what a server running anywhere other
 * than the user's laptop should set.
 *
 * Files are read in slices rather than loaded whole, so a 1 GB upload costs one
 * part's worth of memory.
 */
export interface LocalFile {
  /** Resolved absolute path. */
  path: string;
  /** Base name, used as the default destination filename. */
  name: string;
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function openLocalFile(config: McpConfig, requestedPath: string): Promise<LocalFile> {
  if (!isAbsolute(requestedPath)) {
    throw new ToolError(
      `local_path must be absolute, got "${requestedPath}". ` +
        `A relative path would resolve against this server's working directory, which is not where the user is.`
    );
  }
  const path = resolve(requestedPath);

  if (config.localFileRoot) {
    const root = resolve(config.localFileRoot);
    // The separator check stops "/data-other" from passing as inside "/data".
    if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new ToolError(
        `This server is configured to read local files only under ${root} (TEXERA_LOCAL_FILE_ROOT), ` +
          `so it will not open ${path}.`
      );
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new ToolError(`No such file: ${path}`);
    if (code === "EACCES") throw new ToolError(`Not permitted to read ${path}`);
    if (code === "EISDIR") throw new ToolError(`${path} is a directory, not a file`);
    throw new ToolError(`Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    throw new ToolError(`${path} is not a regular file`);
  }

  return {
    path,
    name: basename(path),
    size: stats.size,
    async read(offset, length) {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      // A short read means the file changed under us; uploading the truncated
      // buffer would silently corrupt the object.
      if (bytesRead !== length) {
        throw new ToolError(
          `Read ${bytesRead} of ${length} bytes at offset ${offset} in ${path}. ` +
            `The file appears to have changed while it was being uploaded.`
        );
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    },
    async close() {
      await handle.close();
    },
  };
}
