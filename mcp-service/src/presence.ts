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

/**
 * How this client identifies itself to the people it is co-editing with.
 *
 * The workspace renders one avatar per shared-editing participant and draws a
 * coloured pointer and highlight ring in that participant's colour. A chatbot
 * joining the room is indistinguishable from a person unless it says otherwise,
 * so it ships a mark and a name and sets `isAgent`.
 *
 * The avatar travels inline as a data URI rather than as a URL into the
 * deployment's assets: the identity belongs to the MCP client, not to the
 * Texera install, and a deployment should not have to ship an icon for every
 * chatbot that might connect to it. Both are overridable — a different client
 * (or a differently branded one) sets TEXERA_MCP_CLIENT_NAME and
 * TEXERA_MCP_AVATAR_URL.
 */

/** Anthropic's mark, drawn as the burst that identifies Claude. */
export const CLAUDE_AVATAR_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMC" +
  "A2NCA2NCI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMzIiIGZpbGw9IiNEOTc3NTciLz48ZyBmaWxsPSIjRkZGRkZGIj" +
  "48cG9seWdvbiBwb2ludHM9IjI5LjcwLDI5LjAwIDM0LjMwLDI5LjAwIDMyLjc0LDExLjAwIDMxLjI2LDExLjAwIi8+PHBvbH" +
  "lnb24gcG9pbnRzPSIzMi4xMSwyOC42MCAzNC44OSwzMC4yMCAzOS45NCwxOS4yNyAzOS4wNiwxOC43NSIvPjxwb2x5Z29uIH" +
  "BvaW50cz0iMzMuNDUsMjguNTEgMzUuNzUsMzIuNDkgNTAuNTUsMjIuMTQgNDkuODIsMjAuODYiLz48cG9seWdvbiBwb2ludH" +
  "M9IjM1LjAwLDMwLjQwIDM1LjAwLDMzLjYwIDQ3LjAwLDMyLjUxIDQ3LjAwLDMxLjQ5Ii8+PHBvbHlnb24gcG9pbnRzPSIzNS" +
  "43NSwzMS41MSAzMy40NSwzNS40OSA0OS44Miw0My4xNCA1MC41NSw0MS44NiIvPjxwb2x5Z29uIHBvaW50cz0iMzQuODksMz" +
  "MuODAgMzIuMTEsMzUuNDAgMzkuMDYsNDUuMjUgMzkuOTQsNDQuNzMiLz48cG9seWdvbiBwb2ludHM9IjM0LjMwLDM1LjAwID" +
  "I5LjcwLDM1LjAwIDMxLjI2LDUzLjAwIDMyLjc0LDUzLjAwIi8+PHBvbHlnb24gcG9pbnRzPSIzMS44OSwzNS40MCAyOS4xMS" +
  "wzMy44MCAyNC4wNiw0NC43MyAyNC45NCw0NS4yNSIvPjxwb2x5Z29uIHBvaW50cz0iMzAuNTUsMzUuNDkgMjguMjUsMzEuNT" +
  "EgMTMuNDUsNDEuODYgMTQuMTgsNDMuMTQiLz48cG9seWdvbiBwb2ludHM9IjI5LjAwLDMzLjYwIDI5LjAwLDMwLjQwIDE3Lj" +
  "AwLDMxLjQ5IDE3LjAwLDMyLjUxIi8+PHBvbHlnb24gcG9pbnRzPSIyOC4yNSwzMi40OSAzMC41NSwyOC41MSAxNC4xOCwyMC" +
  "44NiAxMy40NSwyMi4xNCIvPjxwb2x5Z29uIHBvaW50cz0iMjkuMTEsMzAuMjAgMzEuODksMjguNjAgMjQuOTQsMTguNzUgMj" +
  "QuMDYsMTkuMjciLz48L2c+PC9zdmc+";

/** Claude's terracotta, used for the pointer, highlight ring and avatar fill. */
export const CLAUDE_PRESENCE_COLOR = "#D97757";

export const DEFAULT_PRESENCE_NAME = "Claude";
