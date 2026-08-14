/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Injectable } from "@angular/core";
import { Observable, of } from "rxjs";
import { catchError, map, switchMap, take } from "rxjs/operators";
import { HttpClient, HttpParams } from "@angular/common/http";
import { AuthService } from "../../../common/service/user/auth.service";
import { AppSettings } from "../../../common/app-setting";
import { ComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { WorkflowComputingUnitManagingService } from "../../../common/service/computing-unit/workflow-computing-unit/workflow-computing-unit-managing.service";

export interface PackageResponse {
  system: string[];
}

export interface PvePackageResponse {
  pveName: string;
  userPackages: string[];
}

export interface UserPveRecord {
  veid: number;
  name: string;
  packages: Record<string, string>;
}

/**
 * Mirrors PveManager.isValidPveName on the server. Dots, hyphens and underscores are
 * allowed: a model provisions an environment named "pve-for-model-<model name>", and
 * letters and digits alone could not express that.
 */
const PVE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const PVE_NAME_MAX_LENGTH = 160;

export function validatePveName(name: string): string | null {
  if (!PVE_NAME_PATTERN.test(name) || name.length > PVE_NAME_MAX_LENGTH) {
    return "Environment name may contain only letters, numbers, dots, hyphens and underscores.";
  }
  return null;
}

@Injectable({ providedIn: "root" })
export class WorkflowPveService {
  constructor(
    private http: HttpClient,
    private computingUnitStatusService: ComputingUnitStatusService,
    private computingUnitManagingService: WorkflowComputingUnitManagingService
  ) {}

  /**
   * The saved-environment endpoints under /pve/db are served by a computing unit, and on
   * Kubernetes the gateway authorizes them through an ext-auth filter that decides from
   * `cuid` which unit the caller is reaching. A request without it is rejected with a 403
   * before it ever arrives — while still working locally, where no such filter exists.
   *
   * The rows themselves belong to the user rather than to any one unit, so any running unit
   * will do. Resolving it here rather than at each call site is deliberate: a caller that
   * forgets the parameter fails only on Kubernetes, and only as an empty list or a silent
   * error, which is a difficult thing to notice.
   */
  private resolveCuid(explicit?: number): Observable<number | undefined> {
    if (explicit !== undefined) {
      return of(explicit);
    }
    return this.computingUnitStatusService.getSelectedComputingUnit().pipe(
      take(1),
      switchMap(selected => {
        const selectedCuid = selected?.computingUnit?.cuid;
        if (selectedCuid !== undefined) {
          return of(selectedCuid);
        }
        // Outside a workspace nothing is selected, so fall back to any running unit.
        return this.computingUnitManagingService.listComputingUnits().pipe(
          map(units => units.find(unit => unit.status === "Running")?.computingUnit?.cuid),
          catchError(() => of(undefined))
        );
      })
    );
  }

  private cuidOptions(cuid: number | undefined): { params?: HttpParams } {
    return cuid === undefined ? {} : { params: new HttpParams().set("cuid", cuid.toString()) };
  }

  savePve(name: string, packages: Record<string, string>): Observable<{ veid: number }> {
    return this.resolveCuid().pipe(
      switchMap(cuid =>
        this.http.post<{ veid: number }>(
          `${AppSettings.getApiEndpoint()}/pve/db`,
          { name, packages },
          this.cuidOptions(cuid)
        )
      )
    );
  }

  updateUserPve(veid: number, name: string, packages: Record<string, string>): Observable<{ veid: number }> {
    return this.resolveCuid().pipe(
      switchMap(cuid =>
        this.http.put<{ veid: number }>(
          `${AppSettings.getApiEndpoint()}/pve/db/${veid}`,
          { name, packages },
          this.cuidOptions(cuid)
        )
      )
    );
  }

  listUserPves(cuid?: number): Observable<UserPveRecord[]> {
    return this.resolveCuid(cuid).pipe(
      switchMap(resolved =>
        this.http.get<UserPveRecord[]>(`${AppSettings.getApiEndpoint()}/pve/db`, this.cuidOptions(resolved))
      )
    );
  }

  deleteUserPve(veid: number): Observable<void> {
    return this.resolveCuid().pipe(
      switchMap(cuid =>
        this.http.delete<void>(`${AppSettings.getApiEndpoint()}/pve/db/${veid}`, this.cuidOptions(cuid))
      )
    );
  }

  getAccessToken(): string | null {
    const token = AuthService.getAccessToken();
    return token && token.trim().length > 0 ? token : null;
  }

  private buildBaseParams(): HttpParams {
    let params = new HttpParams();
    const token = this.getAccessToken();
    if (token) {
      params = params.set("access-token", token);
    }
    return params;
  }

  getSystemPackages(cuid: number): Observable<PackageResponse> {
    const params = this.buildBaseParams().set("cuid", cuid.toString());
    return this.http.get<PackageResponse>(`${AppSettings.getApiEndpoint()}/pve/system`, { params });
  }

  fetchPVEs(cuid: number): Observable<PvePackageResponse[]> {
    const params = this.buildBaseParams().set("cuid", cuid.toString());
    return this.http.get<PvePackageResponse[]>(`${AppSettings.getApiEndpoint()}/pve/pves`, { params });
  }

  getUserPackages(cuid: number, pveName: string): Observable<string[]> {
    return this.fetchPVEs(cuid).pipe(map(pves => pves.find(pve => pve.pveName === pveName)?.userPackages ?? []));
  }

  deleteEnvironments(cuid: number) {
    return this.http.delete(`${AppSettings.getApiEndpoint()}/pve/pves/${cuid}`);
  }

  deletePackage(cuid: number, pveName: string, packageName: string) {
    const params = this.buildBaseParams();

    return this.http.delete<string[]>(
      `${AppSettings.getApiEndpoint()}/pve/${cuid}/${encodeURIComponent(pveName)}/packages/${encodeURIComponent(packageName)}`,
      { params }
    );
  }

  getPveWebSocketUrl(cuid: number, pveName: string, action: string, packages: string[] = []): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = encodeURIComponent(JSON.stringify(packages));

    const token = this.getAccessToken();
    const tokenParam = token ? `&access-token=${encodeURIComponent(token)}` : "";

    return (
      `${protocol}//${window.location.host}/wsapi/pve` +
      `?packages=${query}` +
      `&cuid=${cuid}` +
      `&pveName=${encodeURIComponent(pveName)}` +
      `&action=${action}` +
      tokenParam
    );
  }
}
