/**
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
import { Observable, of, combineLatest } from "rxjs";
import { catchError, map, switchMap, take } from "rxjs/operators";
import { ComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { modelPveName } from "../../../dashboard/service/user/model/model.service";
import { WorkflowPveService } from "./virtual-environment.service";

/**
 * Creating a model also saves a Python environment pinned to the framework version it was
 * trained against (see ModelEnvironment on the server). That environment is only a saved
 * specification until someone installs it into a computing unit, and a UDF that loads the
 * model will otherwise run against whatever versions the default environment happens to
 * have.
 *
 * This service answers the one question the property panel needs: for the model just
 * picked, is there a saved environment that the current computing unit does not have?
 */

/** Model name out of a `/models/ownerEmail/modelName/versionName` path. */
export function modelNameFromPath(path: string): string | undefined {
  const parts = path.split("/").filter(part => part.length > 0);
  // [resourceType, ownerEmail, modelName, versionName]
  return parts.length >= 4 ? parts[2] : undefined;
}

export interface ModelPveHint {
  readonly modelName: string;
  readonly pveName: string;
  readonly computingUnitName: string;
}

@Injectable({ providedIn: "root" })
export class ModelPveHintService {
  constructor(
    private workflowPveService: WorkflowPveService,
    private computingUnitStatusService: ComputingUnitStatusService
  ) {}

  /**
   * Emits a hint when the picked model has a saved environment that is missing from the
   * selected computing unit, and `undefined` in every other case — no model, no saved
   * environment, no computing unit selected, or the environment is already installed.
   *
   * Errors are swallowed into `undefined`: failing to look up an optional hint must never
   * disturb picking a model.
   */
  hintFor(selectedPath: string): Observable<ModelPveHint | undefined> {
    const modelName = modelNameFromPath(selectedPath);
    if (!modelName) {
      return of(undefined);
    }
    const pveName = modelPveName(modelName);

    return this.computingUnitStatusService.getSelectedComputingUnit().pipe(
      take(1),
      switchMap(unit => {
        const cuid = unit?.computingUnit?.cuid;
        if (cuid === undefined) {
          return of(undefined);
        }
        return combineLatest([
          this.workflowPveService.listUserPves(cuid).pipe(catchError(() => of([]))),
          this.workflowPveService.fetchPVEs(cuid).pipe(catchError(() => of([]))),
        ]).pipe(
          map(([savedPves, loadedPves]) => {
            const isSaved = savedPves.some(pve => pve.name.trim() === pveName);
            const isLoaded = loadedPves.some(pve => pve.pveName.trim() === pveName);
            return isSaved && !isLoaded
              ? {
                  modelName,
                  pveName,
                  computingUnitName: unit?.computingUnit?.name ?? "the selected computing unit",
                }
              : undefined;
          })
        );
      }),
      catchError(() => of(undefined))
    );
  }
}
