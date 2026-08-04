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
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import type { CommentBox, OperatorLink, OperatorPredicate, Point, WorkflowContent } from "../types/workflow";
import { deepEqual, setYMapEntry } from "./y-object";
import { createSdkLogger } from "../logger";

const log = createSdkLogger("SharedWorkflowSession");

/**
 * The parts of a workflow the shared-editing room holds. `settings` is absent
 * on purpose: the workspace keeps it outside the Yjs document, so a room can
 * neither supply nor receive it.
 */
export type SharedWorkflowGraph = Pick<WorkflowContent, "operators" | "links" | "operatorPositions" | "commentBoxes">;

/**
 * Presence entry, matching `CoeditorState` in
 * `frontend/src/app/workspace/service/workflow-graph/model/shared-model.ts`.
 * The workspace renders one avatar per awareness entry, so filling this in is
 * the whole of "show up as a collaborator".
 */
export interface SharedPresence {
  /** Display name on the avatar and the canvas pointer. */
  name: string;
  /** Hex colour for the pointer, the highlight ring and the avatar fallback. */
  color: string;
  /** Image shown instead of the initials — how a bot gets its logo. */
  avatarUrl?: string;
  /** Marks this participant as software rather than a person. */
  isAgent?: boolean;
  email?: string;
  uid?: number;
}

export interface SharedWorkflowSessionOptions {
  /** Deployment origin, e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** Workflow id — the shared-editing room number. */
  wid: number;
  presence: SharedPresence;
  /** How long to wait for the initial document sync before giving up. */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Joins a workflow's shared-editing room as a co-editor.
 *
 * The workspace UI is not the source of truth for an open workflow — the Yjs
 * document is. A client that only PUTs to `/api/workflow/persist` is invisible
 * while it works and races the browser tab on save. Joining the room instead
 * means edits land on the user's canvas as they happen, and the tab's own
 * auto-persist carries them to the database.
 *
 * Two things follow from the frontend's design and are handled here:
 *
 * - The room has no persistence of its own. When the last participant leaves,
 *   the document is gone, so a client arriving at an empty room has to seed it
 *   from the REST copy — see {@link isEmpty} and {@link replaceContent}.
 * - Every browser client re-seeds the room from REST on open. Seeding with the
 *   same content is therefore harmless, but seeding with *stale* content would
 *   clobber live edits, which is why the caller checks {@link isEmpty} first.
 */
export class SharedWorkflowSession {
  readonly doc = new Y.Doc();
  readonly wid: number;

  private readonly provider: WebsocketProvider;
  private readonly operatorMap: Y.Map<unknown>;
  private readonly linkMap: Y.Map<unknown>;
  private readonly positionMap: Y.Map<unknown>;
  private readonly commentBoxMap: Y.Map<unknown>;
  private readonly presence: SharedPresence;
  private destroyed = false;

  constructor(options: SharedWorkflowSessionOptions) {
    this.wid = options.wid;
    this.presence = options.presence;

    // Mirrors SharedModel's constructor: same map names, same room number.
    this.operatorMap = this.doc.getMap("operatorIDMap");
    this.commentBoxMap = this.doc.getMap("commentBoxMap");
    this.linkMap = this.doc.getMap("operatorLinkMap");
    this.positionMap = this.doc.getMap("elementPositionMap");
    this.doc.getMap("debugActions");

    this.provider = new WebsocketProvider(sharedEditingUrl(options.baseUrl), String(options.wid), this.doc, {
      // y-websocket reaches for a global WebSocket, which Node only has on
      // recent versions and never had under the bundled CJS build.
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
  }

  /** Resolves once the server has sent the room's current state. */
  async connect(timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.provider.synced) {
      this.publishPresence();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms joining the shared-editing room for workflow ${this.wid}. ` +
              `Check that the deployment's /rtc endpoint is reachable.`
          )
        );
      }, timeoutMs);

      const onSync = (isSynced: boolean) => {
        if (!isSynced) return;
        cleanup();
        resolve();
      };
      const onStatus = ({ status }: { status: string }) => {
        log.debug({ status, wid: this.wid }, "shared-editing connection status");
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.provider.off("sync", onSync);
        this.provider.off("status", onStatus);
      };

      this.provider.on("sync", onSync);
      this.provider.on("status", onStatus);
    });
    this.publishPresence();
  }

  get connected(): boolean {
    return !this.destroyed && this.provider.wsconnected;
  }

  /** Number of other participants in the room — i.e. open browser tabs. */
  get peerCount(): number {
    return Math.max(0, this.provider.awareness.getStates().size - 1);
  }

  /** True when nobody has populated the room yet, so it is safe to seed. */
  isEmpty(): boolean {
    return this.operatorMap.size === 0 && this.linkMap.size === 0 && this.commentBoxMap.size === 0;
  }

  /** The room's current graph, in the same shape the REST API stores. */
  readContent(): SharedWorkflowGraph {
    const operatorPositions: Record<string, Point> = {};
    for (const [id, position] of this.positionMap.entries()) {
      operatorPositions[id] = position as Point;
    }
    return {
      operators: [...this.operatorMap.values()].map(value => (value as Y.Map<unknown>).toJSON() as OperatorPredicate),
      links: [...this.linkMap.values()].map(value =>
        value instanceof Y.Map ? (value.toJSON() as OperatorLink) : (value as OperatorLink)
      ),
      operatorPositions,
      commentBoxes: [...this.commentBoxMap.values()].map(value => (value as Y.Map<unknown>).toJSON() as CommentBox),
    };
  }

  /**
   * Makes the room match `content`, as one transaction so the canvas applies it
   * in a single render and the undo stack treats it as one step.
   *
   * This is a reconcile rather than a rewrite: untouched operators keep their
   * Yjs identity, so a human editing a property of an operator this client did
   * not change never sees their edit blink away.
   */
  replaceContent(content: SharedWorkflowGraph): void {
    if (this.destroyed) return;
    this.doc.transact(() => {
      reconcileMap(this.operatorMap, content.operators, operator => operator.operatorID);
      reconcileMap(this.linkMap, content.links, link => link.linkID);
      reconcileMap(this.commentBoxMap, content.commentBoxes ?? [], box => box.commentBoxID);

      const positions = content.operatorPositions ?? {};
      for (const [id, position] of Object.entries(positions)) {
        const existing = this.positionMap.get(id) as Point | undefined;
        if (!deepEqual(existing, position)) this.positionMap.set(id, position);
      }
      for (const id of [...this.positionMap.keys()]) {
        if (!(id in positions)) this.positionMap.delete(id);
      }
    });
  }

  /**
   * Publishes what this client is doing right now. `editing` drives the
   * "someone is editing this operator" halo and `highlighted` the selection
   * ring, both keyed by the operator ids the workspace already knows.
   */
  publishPresence(activity: { editing?: string; highlighted?: string[] } = {}): void {
    if (this.destroyed) return;
    this.provider.awareness.setLocalState({
      user: {
        uid: this.presence.uid ?? -1,
        name: this.presence.name,
        email: this.presence.email ?? "",
        role: "REGULAR",
        color: this.presence.color,
        avatarUrl: this.presence.avatarUrl,
        isAgent: this.presence.isAgent ?? false,
        comment: "",
        joiningReason: "",
        clientId: String(this.provider.awareness.clientID),
      },
      isActive: true,
      // The pointer is drawn at this position; parking it off the origin keeps
      // it from sitting on top of the first operator.
      userCursor: { x: 0, y: 0 },
      currentlyEditing: activity.editing,
      highlighted: activity.highlighted,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.provider.awareness.setLocalState(null);
      this.provider.destroy();
    } catch (error) {
      log.debug({ err: error }, "ignoring error while leaving the shared-editing room");
    }
    this.doc.destroy();
  }
}

/** Adds, updates and removes entries so `map` holds exactly `items`. */
function reconcileMap<T extends object>(map: Y.Map<unknown>, items: readonly T[], keyOf: (item: T) => string): void {
  const wanted = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    wanted.add(key);
    setYMapEntry(map, key, item);
  }
  for (const key of [...map.keys()]) {
    if (!wanted.has(key)) map.delete(key);
  }
}

/**
 * The shared-editing room lives at `/rtc` on the deployment origin, the same
 * path the gateway routes to y-websocket-server and the frontend derives with
 * `getWebsocketUrl("rtc", "")`.
 */
export function sharedEditingUrl(baseUrl: string): string {
  const url = new URL("/rtc", baseUrl);
  url.protocol = url.protocol.replace(/^http/, "ws");
  return url.toString().replace(/\/$/, "");
}
