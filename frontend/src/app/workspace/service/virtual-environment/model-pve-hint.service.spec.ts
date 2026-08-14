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
import { ModelPveHintService, modelNameFromPath } from "./model-pve-hint.service";
import { PvePackageResponse, UserPveRecord, WorkflowPveService } from "./virtual-environment.service";

const MODEL_PATH = "/models/owner@test.com/churn-clf/v3";

describe("modelNameFromPath", () => {
  it("takes the model name out of a full version path", () => {
    expect(modelNameFromPath(MODEL_PATH)).toBe("churn-clf");
  });

  it("returns undefined for a path that names no version", () => {
    expect(modelNameFromPath("/models/owner@test.com/churn-clf")).toBeUndefined();
    expect(modelNameFromPath("")).toBeUndefined();
  });
});

describe("ModelPveHintService", () => {
  let service: ModelPveHintService;
  let savedPves: Observable<UserPveRecord[]>;
  let loadedPves: Observable<PvePackageResponse[]>;
  let selectedUnit: Observable<unknown>;

  const saved = (name: string): UserPveRecord[] => [{ veid: 1, name, packages: { "scikit-learn": "==1.5.0" } }];
  const loaded = (name: string): PvePackageResponse[] => [{ pveName: name, userPackages: [] }];
  const unit = (cuid: number | undefined) =>
    of(cuid === undefined ? undefined : { computingUnit: { cuid, name: "CU 12" } });

  beforeEach(() => {
    savedPves = of(saved("pve-for-model-churn-clf"));
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
        ...commonTestProviders,
      ],
    });
    service = TestBed.inject(ModelPveHintService);
  });

  it("hints when the model's environment is saved but the computing unit lacks it", async () => {
    const hint = await new Promise(resolve => service.hintFor(MODEL_PATH).subscribe(resolve));

    expect(hint).toEqual({
      modelName: "churn-clf",
      pveName: "pve-for-model-churn-clf",
      computingUnitName: "CU 12",
    });
  });

  it("stays quiet when the computing unit already has the environment", async () => {
    loadedPves = of(loaded("pve-for-model-churn-clf"));

    const hint = await new Promise(resolve => service.hintFor(MODEL_PATH).subscribe(resolve));

    expect(hint).toBeUndefined();
  });

  it("stays quiet when the model provisioned no environment", async () => {
    savedPves = of([]);

    const hint = await new Promise(resolve => service.hintFor(MODEL_PATH).subscribe(resolve));

    expect(hint).toBeUndefined();
  });

  it("stays quiet when a different model's environment is the one saved", async () => {
    savedPves = of(saved("pve-for-model-some-other-model"));

    const hint = await new Promise(resolve => service.hintFor(MODEL_PATH).subscribe(resolve));

    expect(hint).toBeUndefined();
  });

  it("stays quiet when no computing unit is selected", async () => {
    selectedUnit = unit(undefined);

    const hint = await new Promise(resolve => service.hintFor(MODEL_PATH).subscribe(resolve));

    expect(hint).toBeUndefined();
  });

  it("stays quiet for a path that is not a model version", async () => {
    const hint = await new Promise(resolve => service.hintFor("/models/owner@test.com").subscribe(resolve));

    expect(hint).toBeUndefined();
  });

  // An optional hint must never get in the way of picking a model.
  it("stays quiet when the environment lookups fail", async () => {
    savedPves = throwError(() => new Error("boom"));

    const hint = await new Promise(resolve => service.hintFor(MODEL_PATH).subscribe(resolve));

    expect(hint).toBeUndefined();
  });
});
