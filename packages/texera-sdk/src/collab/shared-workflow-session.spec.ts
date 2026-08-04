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

import { describe, expect, it, afterEach, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { SharedWorkflowSession, sharedEditingUrl } from "./shared-workflow-session";
import type { OperatorPredicate, WorkflowContent } from "../types/workflow";

/**
 * Runs against the real y-websocket server the deployment uses, because the
 * point of this module is protocol compatibility with it and with the
 * workspace's `SharedModel`. A mocked provider would prove nothing.
 */

const PORT = 24567;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server: Subprocess | undefined;

function operator(id: string, code: string): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: "PythonUDFV2",
    operatorVersion: "1",
    operatorProperties: { code, workers: 1 },
    inputPorts: [{ portID: "input-0", displayName: "", allowMultiInputs: false, isDynamicPort: false }],
    outputPorts: [{ portID: "output-0", displayName: "", allowMultiInputs: false, isDynamicPort: false }],
    showAdvanced: false,
    isDisabled: false,
    viewResult: false,
    customDisplayName: id,
    dynamicInputPorts: false,
    dynamicOutputPorts: false,
  } as unknown as OperatorPredicate;
}

function content(operators: OperatorPredicate[]): WorkflowContent {
  const operatorPositions: WorkflowContent["operatorPositions"] = {};
  operators.forEach((op, index) => {
    operatorPositions[op.operatorID] = { x: 100 * index, y: 50 };
  });
  return { operators, links: [], operatorPositions, commentBoxes: [], settings: { dataTransferBatchSize: 400 } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(25);
  }
}

const sessions: SharedWorkflowSession[] = [];

function join(wid: number, name: string): SharedWorkflowSession {
  const session = new SharedWorkflowSession({
    baseUrl: BASE_URL,
    wid,
    presence: { name, color: "#D97757", avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+", isAgent: name === "Claude" },
  });
  sessions.push(session);
  return session;
}

beforeAll(async () => {
  // `bin/server.cjs` is not in y-websocket's exports map, so resolve it via the
  // one entry that is (`./package.json`) rather than reaching into node_modules
  // by a hardcoded path.
  const serverEntry = new URL("./bin/server.cjs", import.meta.resolve("y-websocket/package.json")).pathname;
  server = spawn({
    cmd: ["bun", "run", serverEntry],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  // The server binds before it logs anything, so poll the port rather than
  // sleeping for a guessed interval.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(BASE_URL);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("y-websocket server did not start");
      await Bun.sleep(50);
    }
  }
});

afterEach(() => {
  while (sessions.length > 0) sessions.pop()!.destroy();
});

afterAll(() => {
  server?.kill();
});

describe("sharedEditingUrl", () => {
  it("points at /rtc on the deployment origin, as ws(s)", () => {
    expect(sharedEditingUrl("http://localhost:8080")).toEqual("ws://localhost:8080/rtc");
    expect(sharedEditingUrl("https://texera.example.org")).toEqual("wss://texera.example.org/rtc");
    // A base URL with a trailing path still resolves /rtc at the origin, which
    // is where the gateway routes it.
    expect(sharedEditingUrl("https://texera.example.org/")).toEqual("wss://texera.example.org/rtc");
  });
});

describe("SharedWorkflowSession", () => {
  it("reports an empty room and seeds it", async () => {
    const claude = join(1, "Claude");
    await claude.connect();

    expect(claude.isEmpty()).toBe(true);
    expect(claude.peerCount).toBe(0);

    claude.replaceContent(content([operator("udf-1", "print('hi')")]));
    expect(claude.isEmpty()).toBe(false);
    expect(claude.readContent().operators.map(op => op.operatorID)).toEqual(["udf-1"]);
  });

  it("propagates edits to another participant in the same room", async () => {
    const browser = join(2, "Ali");
    const claude = join(2, "Claude");
    await Promise.all([browser.connect(), claude.connect()]);
    await waitFor(() => claude.peerCount > 0);

    claude.replaceContent(content([operator("udf-1", "a = 1")]));
    await waitFor(() => browser.readContent().operators.length === 1);

    expect(browser.readContent().operators[0].operatorProperties.code).toEqual("a = 1");

    // Editing a property must not replace the operator wholesale, so a human
    // typing in another field of the same operator is not interrupted.
    claude.replaceContent(content([operator("udf-1", "a = 2")]));
    await waitFor(() => browser.readContent().operators[0].operatorProperties.code === "a = 2");

    claude.replaceContent(content([]));
    await waitFor(() => browser.readContent().operators.length === 0);
  });

  it("publishes an identity other participants can render", async () => {
    const browser = join(3, "Ali");
    const claude = join(3, "Claude");
    await Promise.all([browser.connect(), claude.connect()]);

    claude.publishPresence({ editing: "udf-1", highlighted: ["udf-1"] });

    // The browser sees awareness entries keyed by client id; find the one that
    // is not its own.
    await waitFor(() => {
      const states = [
        ...(browser as unknown as { provider: { awareness: { getStates(): Map<number, any> } } }).provider.awareness
          .getStates()
          .values(),
      ];
      return states.some(state => state?.user?.name === "Claude");
    });

    const claudeState = [
      ...(browser as unknown as { provider: { awareness: { getStates(): Map<number, any> } } }).provider.awareness
        .getStates()
        .values(),
    ].find(state => state?.user?.name === "Claude");

    expect(claudeState.user.isAgent).toBe(true);
    expect(claudeState.user.color).toEqual("#D97757");
    expect(claudeState.user.avatarUrl).toStartWith("data:image/svg+xml;");
    expect(claudeState.user.clientId).toBeString();
    expect(claudeState.isActive).toBe(true);
    expect(claudeState.currentlyEditing).toEqual("udf-1");
    expect(claudeState.highlighted).toEqual(["udf-1"]);
  });

  it("clears its presence when it leaves, so no ghost participant remains", async () => {
    const browser = join(4, "Ali");
    const claude = join(4, "Claude");
    await Promise.all([browser.connect(), claude.connect()]);
    await waitFor(() => browser.peerCount > 0);

    claude.destroy();
    await waitFor(() => browser.peerCount === 0);
    expect(claude.connected).toBe(false);
  });

  it("fails with an actionable message when there is no room server", async () => {
    const orphan = new SharedWorkflowSession({
      baseUrl: "http://127.0.0.1:1",
      wid: 5,
      presence: { name: "Claude", color: "#D97757" },
    });
    sessions.push(orphan);
    await expect(orphan.connect(300)).rejects.toThrow(/Timed out.*\/rtc endpoint/s);
  });
});
