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

import * as Y from "yjs";

/**
 * Conversion between plain objects and the Yjs shapes the workspace UI stores
 * them in.
 *
 * The frontend keeps every operator as a `Y.Map` whose string fields are
 * `Y.Text` (`frontend/src/app/workspace/types/shared-editing.interface.ts`), so
 * a client that wants its edits to show up on someone else's canvas has to
 * write that same shape. In particular strings must be `Y.Text` and must be
 * edited in place: replacing a Python UDF's code with a fresh `Y.Text` would
 * fight with a human typing in the same field, whereas an in-place splice
 * merges with it.
 */

/** Structural equality, enough for the JSON-shaped values a workflow holds. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    key =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

/**
 * Builds the Yjs representation of a plain value: objects become `Y.Map`,
 * arrays `Y.Array`, strings `Y.Text`, and everything else stays as-is.
 */
export function toYValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return new Y.Text(value);
  if (Array.isArray(value)) {
    const yArray = new Y.Array<unknown>();
    yArray.push(value.filter(item => item !== undefined).map(toYValue));
    return yArray;
  }
  if (typeof value === "object") {
    const yMap = new Y.Map<unknown>();
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) yMap.set(key, toYValue(entry));
    }
    return yMap;
  }
  return value;
}

function isYText(value: unknown): value is Y.Text {
  return value instanceof Y.Text;
}

/**
 * Updates an existing Yjs value in place to match `next`, and reports whether
 * it could — `false` means the shape changed (object became array, say) and the
 * caller should replace the value outright.
 */
export function updateYValue(current: unknown, next: unknown): boolean {
  if (current === null || current === undefined) return false;

  if (typeof next === "string") {
    if (!isYText(current)) return false;
    if (current.toString() !== next) {
      current.delete(0, current.length);
      current.insert(0, next);
    }
    return true;
  }

  if (Array.isArray(next)) {
    if (!(current instanceof Y.Array)) return false;
    if (deepEqual(current.toJSON(), next)) return true;
    // Coarse replacement: an MCP client rewrites a property list wholesale
    // rather than editing one element, so per-element diffing would buy
    // nothing but a chance to get the indices wrong.
    current.delete(0, current.length);
    current.push(next.filter(item => item !== undefined).map(toYValue));
    return true;
  }

  if (next !== null && typeof next === "object") {
    if (!(current instanceof Y.Map)) return false;
    const currentJson = current.toJSON() as Record<string, unknown>;
    const nextObject = next as Record<string, unknown>;
    for (const key of new Set([...Object.keys(currentJson), ...Object.keys(nextObject)])) {
      const nextEntry = nextObject[key];
      if (deepEqual(currentJson[key], nextEntry)) continue;
      if (nextEntry === undefined) {
        current.delete(key);
      } else if (!updateYValue(current.get(key), nextEntry)) {
        current.set(key, toYValue(nextEntry));
      }
    }
    return true;
  }

  // Primitives are not Yjs types, so they are never updatable in place.
  return false;
}

/** Sets `key` on `map`, updating in place when the existing value allows it. */
export function setYMapEntry(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (map.has(key) && updateYValue(map.get(key), value)) return;
  map.set(key, toYValue(value));
}
