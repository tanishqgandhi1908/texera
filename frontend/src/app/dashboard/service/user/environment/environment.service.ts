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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable } from "rxjs";
import { AppSettings } from "../../../../common/app-setting";

export const ENVIRONMENT_BASE_URL = `${AppSettings.getApiEndpoint()}/environment`;

/** Mirrors EnvironmentResource.Status. */
export type EnvironmentStatus = "PENDING" | "BUILDING" | "READY" | "FAILED";

export interface Environment {
  eid: number;
  name: string;
  dockerfile: string;
  status: EnvironmentStatus;
  /** Where the built image is pulled from. Null until a build first succeeds. */
  imageTag: string | null;
  buildNumber: number;
  creationTime: number;
  updateTime: number;
}

export interface EnvironmentBuildLog {
  eid: number;
  status: EnvironmentStatus;
  buildNumber: number;
  log: string;
}

export interface DefaultDockerfile {
  baseImage: string;
  dockerfile: string;
}

/** A computing unit can only be started from an environment in this state. */
export function isStartable(environment: Environment): boolean {
  return environment.status === "READY";
}

@Injectable({ providedIn: "root" })
export class EnvironmentService {
  constructor(private http: HttpClient) {}

  list(): Observable<Environment[]> {
    return this.http.get<Environment[]>(ENVIRONMENT_BASE_URL);
  }

  get(eid: number): Observable<Environment> {
    return this.http.get<Environment>(`${ENVIRONMENT_BASE_URL}/${eid}`);
  }

  /** What a new environment's editor starts from — the computing-unit image itself. */
  getDefaultDockerfile(): Observable<DefaultDockerfile> {
    return this.http.get<DefaultDockerfile>(`${ENVIRONMENT_BASE_URL}/default-dockerfile`);
  }

  /** Creating an environment starts its first build; the response is already BUILDING. */
  create(name: string, dockerfile: string): Observable<Environment> {
    return this.http.post<Environment>(ENVIRONMENT_BASE_URL, { name, dockerfile });
  }

  /** Editing rebuilds: the image is whatever the Dockerfile says it is. */
  update(eid: number, name: string, dockerfile: string): Observable<Environment> {
    return this.http.put<Environment>(`${ENVIRONMENT_BASE_URL}/${eid}`, { name, dockerfile });
  }

  rebuild(eid: number): Observable<Environment> {
    return this.http.post<Environment>(`${ENVIRONMENT_BASE_URL}/${eid}/rebuild`, {});
  }

  /**
   * The build's output. Readable at any point, including long after the build finished —
   * which is the whole reason it is persisted rather than streamed.
   */
  logs(eid: number): Observable<EnvironmentBuildLog> {
    return this.http.get<EnvironmentBuildLog>(`${ENVIRONMENT_BASE_URL}/${eid}/logs`);
  }

  delete(eid: number): Observable<void> {
    return this.http.delete<void>(`${ENVIRONMENT_BASE_URL}/${eid}`);
  }
}
