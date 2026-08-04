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

import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { deepEqual, setYMapEntry, toYValue, updateYValue } from "./y-object";

/** Y types must be attached to a document before they can be mutated. */
function rootMap(): Y.Map<unknown> {
  return new Y.Doc().getMap("root");
}

describe("deepEqual", () => {
  it("compares JSON-shaped values structurally", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe("toYValue", () => {
  it("builds the shapes the workspace stores: Y.Map, Y.Array and Y.Text", () => {
    const map = rootMap();
    map.set("operator", toYValue({ code: "print(1)", ports: ["a", "b"], workers: 2 }));

    const operator = map.get("operator") as Y.Map<unknown>;
    expect(operator).toBeInstanceOf(Y.Map);
    // Strings are Y.Text rather than plain strings, which is what lets two
    // editors type into the same field without one overwriting the other.
    expect(operator.get("code")).toBeInstanceOf(Y.Text);
    expect(operator.get("ports")).toBeInstanceOf(Y.Array);
    expect(operator.get("workers")).toBe(2);
    expect(operator.toJSON()).toEqual({ code: "print(1)", ports: ["a", "b"], workers: 2 });
  });

  it("drops undefined object entries rather than storing them", () => {
    const map = rootMap();
    map.set("op", toYValue({ kept: 1, dropped: undefined }));
    expect((map.get("op") as Y.Map<unknown>).toJSON()).toEqual({ kept: 1 });
  });
});

describe("updateYValue", () => {
  it("edits text in place instead of replacing it", () => {
    const map = rootMap();
    map.set("op", toYValue({ code: "a = 1" }));
    const operator = map.get("op") as Y.Map<unknown>;
    const codeBefore = operator.get("code") as Y.Text;

    expect(updateYValue(operator, { code: "a = 2" })).toBe(true);

    // Same Y.Text object: a peer with a cursor in this field keeps it, and the
    // update arrives as a splice rather than as a whole-value overwrite.
    expect(operator.get("code")).toBe(codeBefore);
    expect(codeBefore.toString()).toEqual("a = 2");
  });

  it("adds, changes and removes object keys", () => {
    const map = rootMap();
    map.set("op", toYValue({ a: 1, b: 2 }));
    const operator = map.get("op") as Y.Map<unknown>;

    updateYValue(operator, { a: 1, b: 3, c: 4 });
    expect(operator.toJSON()).toEqual({ a: 1, b: 3, c: 4 });

    updateYValue(operator, { a: 1 });
    expect(operator.toJSON()).toEqual({ a: 1 });
  });

  it("replaces array contents", () => {
    const map = rootMap();
    map.set("list", toYValue([1, 2, 3]));
    const list = map.get("list") as Y.Array<unknown>;

    expect(updateYValue(list, [1, 9])).toBe(true);
    expect(list.toJSON()).toEqual([1, 9]);
  });

  it("reports a shape change so the caller replaces the value", () => {
    const map = rootMap();
    map.set("value", toYValue({ a: 1 }));
    // An object cannot become an array in place.
    expect(updateYValue(map.get("value"), [1, 2])).toBe(false);
    // Nor can a Y type be updated from a primitive.
    expect(updateYValue(map.get("value"), 7)).toBe(false);
  });
});

describe("setYMapEntry", () => {
  it("keeps the existing Y value when it can be updated", () => {
    const map = rootMap();
    setYMapEntry(map, "op", { code: "a = 1" });
    const first = map.get("op");

    setYMapEntry(map, "op", { code: "a = 2" });
    expect(map.get("op")).toBe(first);
    expect((map.get("op") as Y.Map<unknown>).toJSON()).toEqual({ code: "a = 2" });
  });

  it("replaces it when the shape is incompatible", () => {
    const map = rootMap();
    setYMapEntry(map, "value", { a: 1 });
    const first = map.get("value");

    setYMapEntry(map, "value", [1, 2]);
    expect(map.get("value")).not.toBe(first);
    expect((map.get("value") as Y.Array<unknown>).toJSON()).toEqual([1, 2]);
  });
});
