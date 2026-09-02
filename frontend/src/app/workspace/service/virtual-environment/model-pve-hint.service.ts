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
import { ModelService } from "../../../dashboard/service/user/model/model.service";
import { WorkflowPveService } from "./virtual-environment.service";

/**
 * A model may name the saved Python environment it should be loaded in, chosen by its owner
 * when the model was created. Naming one is a statement about library versions: many machine
 * learning libraries only load what they wrote themselves, and a UDF running under the wrong
 * versions fails at load time or, worse, quietly loads something different.
 *
 * The environment is only a saved specification until someone installs it into a computing
 * unit. This service answers the one question the property panel needs: for the model just
 * picked, does it name an environment that the current computing unit does not have?
 *
 * A model that names no environment was deliberately left on the engine's default libraries,
 * and produces no hint.
 */

/** Owner email and model name out of a `/models/ownerEmail/modelName/versionName` path. */
export function modelIdentityFromPath(path: string): { ownerEmail: string; modelName: string } | undefined {
  const parts = path.split("/").filter(part => part.length > 0);
  // [resourceType, ownerEmail, modelName, versionName]
  return parts.length >= 4 ? { ownerEmail: parts[1], modelName: parts[2] } : undefined;
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
    private computingUnitStatusService: ComputingUnitStatusService,
    private modelService: ModelService
  ) {}

  /**
   * Emits a hint when the picked model names an environment that is missing from the
   * selected computing unit, and `undefined` in every other case — no model, no computing
   * unit selected, no environment chosen for the model, an environment the viewer does not
   * have saved, or one that is already installed.
   *
   * Errors are swallowed into `undefined`: failing to look up an optional hint must never
   * disturb picking a model.
   */
  hintFor(selectedPath: string): Observable<ModelPveHint | undefined> {
    const identity = modelIdentityFromPath(selectedPath);
    if (!identity) {
      return of(undefined);
    }

    return this.computingUnitStatusService.getSelectedComputingUnit().pipe(
      take(1),
      switchMap(unit => {
        const cuid = unit?.computingUnit?.cuid;
        if (cuid === undefined) {
          return of(undefined);
        }
        return combineLatest([
          this.modelService.retrieveAccessibleModels().pipe(catchError(() => of([]))),
          // The viewer's saved environments are not scoped to a computing unit; only
          // which of them are installed is.
          this.workflowPveService.listUserPves().pipe(catchError(() => of([]))),
          this.workflowPveService.fetchPVEs(cuid).pipe(catchError(() => of([]))),
        ]).pipe(
          map(([models, savedPves, loadedPves]) => {
            const veid = models.find(m => m.model.name === identity.modelName && m.ownerEmail === identity.ownerEmail)
              ?.model.veid;
            if (veid === undefined || veid === null) {
              // No environment chosen: the default libraries are what the owner wanted.
              return undefined;
            }
            // Resolved against the viewer's own environments. Someone else's environment is
            // one they could neither see nor install, so there is nothing to suggest.
            const pveName = savedPves.find(pve => pve.veid === veid)?.name?.trim();
            if (!pveName) {
              return undefined;
            }
            const isLoaded = loadedPves.some(pve => pve.pveName.trim() === pveName);
            return isLoaded
              ? undefined
              : {
                  modelName: identity.modelName,
                  pveName,
                  computingUnitName: unit?.computingUnit?.name ?? "the selected computing unit",
                };
          })
        );
      }),
      catchError(() => of(undefined))
    );
  }
}
