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

import { TestBed } from "@angular/core/testing";
import { Observable, of, throwError } from "rxjs";
import { ComputingUnitStatusService } from "../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { commonTestProviders } from "../../../common/testing/test-utils";
import { ModelService } from "../../../dashboard/service/user/model/model.service";
import { DashboardModel } from "../../../dashboard/type/dashboard-model.interface";
import { ModelPveHintService, modelIdentityFromPath } from "./model-pve-hint.service";
import { PvePackageResponse, UserPveRecord, WorkflowPveService } from "./virtual-environment.service";

const MODEL_PATH = "/models/owner@test.com/churn-clf/v3";
const CHOSEN_VEID = 7;

describe("modelIdentityFromPath", () => {
  it("takes the owner and model name out of a full version path", () => {
    expect(modelIdentityFromPath(MODEL_PATH)).toEqual({
      ownerEmail: "owner@test.com",
      modelName: "churn-clf",
    });
  });

  it("returns undefined for a path that names no version", () => {
    expect(modelIdentityFromPath("/models/owner@test.com/churn-clf")).toBeUndefined();
    expect(modelIdentityFromPath("")).toBeUndefined();
  });
});

describe("ModelPveHintService", () => {
  let service: ModelPveHintService;
  let models: Observable<unknown[]>;
  let savedPves: Observable<UserPveRecord[]>;
  let loadedPves: Observable<PvePackageResponse[]>;
  let selectedUnit: Observable<unknown>;

  /** A models listing entry, cut down to what the service reads off it. */
  const model = (name: string, ownerEmail: string, veid: number | undefined) =>
    [{ model: { name, veid }, ownerEmail }] as unknown as DashboardModel[];
  const saved = (veid: number, name: string): UserPveRecord[] => [
    { veid, name, packages: { "scikit-learn": "==1.5.0" } },
  ];
  const loaded = (name: string): PvePackageResponse[] => [{ pveName: name, userPackages: [] }];
  const unit = (cuid: number | undefined) =>
    of(cuid === undefined ? undefined : { computingUnit: { cuid, name: "CU 12" } });

  beforeEach(() => {
    models = of(model("churn-clf", "owner@test.com", CHOSEN_VEID));
    savedPves = of(saved(CHOSEN_VEID, "sklearn-15"));
    loadedPves = of([]);
    selectedUnit = unit(12);

    TestBed.configureTestingModule({
      providers: [
        ModelPveHintService,
        {
          provide: WorkflowPveService,
          useValue: {
            listUserPves: () => savedPves,
            fetchPVEs: () => loadedPves,
          },
        },
        {
          provide: ComputingUnitStatusService,
          useValue: { getSelectedComputingUnit: () => selectedUnit },
        },
        {
          provide: ModelService,
          useValue: { retrieveAccessibleModels: () => models },
        },
        ...commonTestProviders,
      ],
    });
    service = TestBed.inject(ModelPveHintService);
  });

  const hintFor = (path: string = MODEL_PATH) => new Promise(resolve => service.hintFor(path).subscribe(resolve));

  it("hints when the model names an environment the computing unit lacks", async () => {
    expect(await hintFor()).toEqual({
      modelName: "churn-clf",
      pveName: "sklearn-15",
      computingUnitName: "CU 12",
    });
  });

  it("stays quiet when the computing unit already has the environment", async () => {
    loadedPves = of(loaded("sklearn-15"));

    expect(await hintFor()).toBeUndefined();
  });

  // Skipping the environment is a choice, not an omission: the model was meant to run on
  // the engine's default libraries, so there is nothing to point out.
  it("stays quiet when the model names no environment", async () => {
    models = of(model("churn-clf", "owner@test.com", undefined));

    expect(await hintFor()).toBeUndefined();
  });

  it("stays quiet when the named environment is not one of the viewer's own", async () => {
    savedPves = of(saved(CHOSEN_VEID + 1, "somebody-elses"));

    expect(await hintFor()).toBeUndefined();
  });

  // Two users can each own a model of the same name, and only one of them is being picked.
  it("stays quiet when only a different owner's model matches the name", async () => {
    models = of(model("churn-clf", "someone-else@test.com", CHOSEN_VEID));

    expect(await hintFor()).toBeUndefined();
  });

  it("stays quiet when the picked model is not in the listing", async () => {
    models = of([]);

    expect(await hintFor()).toBeUndefined();
  });

  it("stays quiet when no computing unit is selected", async () => {
    selectedUnit = unit(undefined);

    expect(await hintFor()).toBeUndefined();
  });

  it("stays quiet for a path that is not a model version", async () => {
    expect(await hintFor("/models/owner@test.com")).toBeUndefined();
  });

  // An optional hint must never get in the way of picking a model.
  it("stays quiet when the environment lookups fail", async () => {
    savedPves = throwError(() => new Error("boom"));

    expect(await hintFor()).toBeUndefined();
  });

  it("stays quiet when the model listing fails", async () => {
    models = throwError(() => new Error("boom"));

    expect(await hintFor()).toBeUndefined();
  });
});
