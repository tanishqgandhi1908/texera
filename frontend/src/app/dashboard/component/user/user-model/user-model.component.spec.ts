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

import { ComponentFixture, TestBed } from "@angular/core/testing";
import { of, throwError } from "rxjs";
import { UserModelComponent } from "./user-model.component";
import { ModelService } from "../../../service/user/model/model.service";
import { UserService } from "../../../../common/service/user/user.service";
import { StubUserService } from "../../../../common/service/user/stub-user.service";
import { DashboardModel } from "../../../type/dashboard-model.interface";
import { SortMethod } from "../../../type/sort-method";
import { commonTestImports, commonTestProviders } from "../../../../common/testing/test-utils";
import { NzModalService } from "ng-zorro-antd/modal";
import { ActionType, EntityType, HubService } from "../../../../hub/service/hub.service";
import { SearchService } from "../../../service/user/search.service";
import { provideRouter, Router } from "@angular/router";
import { UserModelCreatorComponent } from "./user-model-creator/user-model-creator.component";
import { USER_MODEL } from "../../../../app-routing.constant";
import { WorkflowPersistService } from "../../../../common/service/workflow-persist/workflow-persist.service";
import { DatasetService } from "../../../service/user/dataset/dataset.service";
import { WorkflowCoverService } from "../../../service/user/workflow-cover/workflow-cover.service";

function makeModel(overrides: {
  mid: number;
  name?: string;
  description?: string;
  framework?: string;
  creationTime?: number;
  ownerEmail?: string;
}): DashboardModel {
  return {
    isOwner: true,
    ownerEmail: overrides.ownerEmail ?? "owner@example.com",
    model: {
      mid: overrides.mid,
      ownerUid: 1,
      name: overrides.name ?? `model-${overrides.mid}`,
      repositoryName: `model-${overrides.mid}`,
      isPublic: false,
      isDownloadable: true,
      description: overrides.description ?? "",
      creationTime: overrides.creationTime ?? overrides.mid * 1000,
      coverImage: undefined,
      framework: overrides.framework ?? "pytorch",
      format: "safetensors",
      frameworkVersion: undefined,
      veid: undefined,
    },
    accessPrivilege: "WRITE",
    size: 0,
  };
}

describe("UserModelComponent", () => {
  let component: UserModelComponent;
  let fixture: ComponentFixture<UserModelComponent>;
  let hubService: {
    getCounts: ReturnType<typeof vi.fn>;
    isLiked: ReturnType<typeof vi.fn>;
    getUserAccess: ReturnType<typeof vi.fn>;
  };
  let searchService: { getUserInfo: ReturnType<typeof vi.fn> };
  let modelService: {
    retrieveAccessibleModels: ReturnType<typeof vi.fn>;
    deleteModel: ReturnType<typeof vi.fn>;
    retrieveOwners: ReturnType<typeof vi.fn>;
  };

  const models = [
    makeModel({ mid: 1, name: "alpha", framework: "pytorch", creationTime: 1000 }),
    makeModel({ mid: 2, name: "beta", description: "an onnx graph", framework: "onnx", creationTime: 3000 }),
    makeModel({ mid: 3, name: "gamma", framework: "sklearn", creationTime: 2000 }),
  ];

  beforeEach(async () => {
    hubService = {
      getCounts: vi.fn().mockReturnValue(of([])),
      isLiked: vi.fn().mockReturnValue(of([])),
      getUserAccess: vi.fn().mockReturnValue(of([])),
    };
    searchService = { getUserInfo: vi.fn().mockReturnValue(of({})) };
    modelService = {
      retrieveAccessibleModels: vi.fn().mockReturnValue(of(models)),
      deleteModel: vi.fn().mockReturnValue(of({})),
      retrieveOwners: vi.fn().mockReturnValue(of(["owner@example.com"])),
    };

    TestBed.configureTestingModule({
      imports: [UserModelComponent, ...commonTestImports],
      providers: [
        { provide: ModelService, useValue: modelService },
        { provide: UserService, useClass: StubUserService },
        // The rendered card items pull these in; the Models page itself uses none of them.
        { provide: WorkflowPersistService, useValue: {} },
        { provide: WorkflowCoverService, useValue: {} },
        { provide: DatasetService, useValue: {} },
        { provide: HubService, useValue: hubService },
        { provide: SearchService, useValue: searchService },
        NzModalService,
        // card items render routerLinks, which need a router context
        provideRouter([]),
        ...commonTestProviders,
      ],
    });

    fixture = TestBed.createComponent(UserModelComponent);
    component = fixture.componentInstance;
    // detectChanges renders the template and wires the SearchResultsComponent ViewChild;
    // the search is then awaited explicitly rather than via whenStable(), which does not
    // settle here because the component holds a live userChanged() subscription.
    fixture.detectChanges();
    await component.search(true);
    fixture.detectChanges();
  });

  it("lists every accessible model", async () => {
    expect(modelService.retrieveAccessibleModels).toHaveBeenCalled();
    expect(component.searchResultsComponent.entries.length).toBe(3);
  });

  it("filters by name", async () => {
    component.searchKeywords = ["alpha"];
    await component.search();

    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["alpha"]);
  });

  it("filters by description and by framework, not just name", async () => {
    component.searchKeywords = ["onnx"];
    await component.search();

    // "onnx" appears in beta's description and framework, in neither case its name
    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["beta"]);
  });

  it("matches case-insensitively", async () => {
    component.searchKeywords = ["ALPHA"];
    await component.search();

    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["alpha"]);
  });

  it("returns nothing when the keyword matches no model", async () => {
    component.searchKeywords = ["no-such-model"];
    await component.search();

    expect(component.searchResultsComponent.entries).toEqual([]);
  });

  it("treats a whitespace-only keyword as no filter", async () => {
    component.searchKeywords = ["   "];
    await component.search();

    expect(component.searchResultsComponent.entries.length).toBe(3);
  });

  it("requires every chip to match, narrowing the results", async () => {
    // "onnx" alone matches beta; adding "graph" still matches beta (its description)...
    component.searchKeywords = ["onnx", "graph"];
    await component.search();
    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["beta"]);

    // ...but a chip that matches nothing on beta rules it out entirely.
    component.searchKeywords = ["onnx", "alpha"];
    await component.search();
    expect(component.searchResultsComponent.entries).toEqual([]);
  });

  it("sorts newest-created first by default", async () => {
    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("sorts by name when asked", async () => {
    component.sortMethod = SortMethod.NameAsc;
    await component.search();
    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["alpha", "beta", "gamma"]);

    component.sortMethod = SortMethod.NameDesc;
    await component.search();
    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("falls back to newest-created for a sort key models do not carry", async () => {
    // Models have no edit time, so sorting by it would order on a null key.
    component.sortMethod = SortMethod.EditTimeDesc;
    await component.search();

    expect(component.searchResultsComponent.entries.map(e => e.name)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("does not refetch the list when only the filter changes", async () => {
    const callsAfterInit = modelService.retrieveAccessibleModels.mock.calls.length;

    component.searchKeywords = ["alpha"];
    await component.search();

    expect(modelService.retrieveAccessibleModels.mock.calls.length).toBe(callsAfterInit);
  });

  it("refetches the list when the search is forced", async () => {
    const callsAfterInit = modelService.retrieveAccessibleModels.mock.calls.length;

    await component.search(true);

    expect(modelService.retrieveAccessibleModels.mock.calls.length).toBeGreaterThan(callsAfterInit);
  });

  it("removes a deleted model from the list without refetching", async () => {
    const entry = component.searchResultsComponent.entries.find(e => e.id === 2)!;

    component.deleteModel(entry);

    expect(modelService.deleteModel).toHaveBeenCalledWith(2);
    expect(component.searchResultsComponent.entries.map(e => e.id)).not.toContain(2);
  });

  it("ignores a delete for an entry with no id", () => {
    const entry = component.searchResultsComponent.entries[0];
    entry.model.model.mid = undefined;

    component.deleteModel(entry);

    expect(modelService.deleteModel).not.toHaveBeenCalled();
  });

  it("persists the view mode across instances", () => {
    component.setViewType("list");
    expect(localStorage.getItem("texera.userModel.viewMode")).toBe("list");

    const second = TestBed.createComponent(UserModelComponent);
    expect(second.componentInstance.viewType).toBe("list");
  });

  describe("onClickOpenModelAddComponent", () => {
    it("opens the model creator with no footer", () => {
      const create = vi
        .spyOn(TestBed.inject(NzModalService), "create")
        .mockReturnValue({ afterClose: of(null) } as never);

      component.onClickOpenModelAddComponent();

      expect(create).toHaveBeenCalledTimes(1);
      const config = create.mock.calls[0][0];
      expect(config.nzContent).toBe(UserModelCreatorComponent);
      expect(config.nzFooter).toBeNull();
      // Create-only, so unlike the dataset creator there is no nzData to pass.
      expect(config.nzData).toBeUndefined();
    });

    it("navigates to the new model on a non-null close", () => {
      vi.spyOn(TestBed.inject(NzModalService), "create").mockReturnValue({
        afterClose: of(makeModel({ mid: 77 })),
      } as never);
      const navigate = vi.spyOn(TestBed.inject(Router), "navigate").mockResolvedValue(true);

      component.onClickOpenModelAddComponent();

      expect(navigate).toHaveBeenCalledWith([`${USER_MODEL}/77`]);
    });

    it("does not navigate when the modal is dismissed", () => {
      vi.spyOn(TestBed.inject(NzModalService), "create").mockReturnValue({ afterClose: of(null) } as never);
      const navigate = vi.spyOn(TestBed.inject(Router), "navigate").mockResolvedValue(true);

      component.onClickOpenModelAddComponent();

      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe("hub stats", () => {
    it("fills view and like counts on the rendered entries", async () => {
      // sorted CreateTimeDesc, so mid 2 (t=2000) precedes mid 1 (t=1000)
      modelService.retrieveAccessibleModels.mockReturnValue(
        of([makeModel({ mid: 1, creationTime: 1000 }), makeModel({ mid: 2, creationTime: 2000 })])
      );
      hubService.getCounts.mockClear();
      hubService.isLiked.mockClear();
      hubService.getCounts.mockReturnValue(of([{ counts: { view: 11, like: 2 } }, { counts: { view: 5, like: 0 } }]));
      hubService.isLiked.mockReturnValue(of([{ isLiked: true }, { isLiked: false }]));

      await component.search(true);

      expect(hubService.getCounts).toHaveBeenCalledWith(
        [EntityType.Model, EntityType.Model],
        [2, 1],
        [ActionType.View, ActionType.Like]
      );
      const entries = component.searchResultsComponent.entries;
      expect(entries[0].viewCount).toBe(11);
      expect(entries[0].likeCount).toBe(2);
      expect(entries[0].isLiked).toBe(true);
      expect(entries[1].viewCount).toBe(5);
      expect(entries[1].isLiked).toBe(false);
    });

    it("leaves counts at zero when the hub call fails", async () => {
      modelService.retrieveAccessibleModels.mockReturnValue(of([makeModel({ mid: 1 })]));
      hubService.getCounts.mockReturnValue(throwError(() => new Error("hub down")));

      await component.search(true);

      const entries = component.searchResultsComponent.entries;
      expect(entries.length).toBe(1);
      expect(entries[0].viewCount).toBe(0);
      expect(entries[0].likeCount).toBe(0);
    });

    it("resolves owner names so cards show the real username", async () => {
      modelService.retrieveAccessibleModels.mockReturnValue(of([makeModel({ mid: 1 })]));
      searchService.getUserInfo.mockReturnValue(of({ 1: { userName: "tanishq", googleAvatar: "g" } }));

      await component.search(true);

      expect(searchService.getUserInfo).toHaveBeenCalledWith([1]);
      const entry = component.searchResultsComponent.entries[0];
      expect(entry.ownerName).toBe("tanishq");
      expect(entry.ownerGoogleAvatar).toBe("g");
    });

    it("leaves the owner name blank when the lookup fails", async () => {
      modelService.retrieveAccessibleModels.mockReturnValue(of([makeModel({ mid: 1 })]));
      searchService.getUserInfo.mockReturnValue(throwError(() => new Error("down")));

      await component.search(true);

      expect(component.searchResultsComponent.entries.length).toBe(1);
      expect(component.searchResultsComponent.entries[0].ownerName).toBe("");
    });

    it("populates accessibleUserIds so an owner's card links to the user model page", async () => {
      modelService.retrieveAccessibleModels.mockReturnValue(of([makeModel({ mid: 1 })]));
      hubService.getUserAccess.mockReturnValue(of([{ entityType: EntityType.Model, entityId: 1, userIds: [1] }]));

      await component.search(true);

      expect(hubService.getUserAccess).toHaveBeenCalledWith([EntityType.Model], [1]);
      expect(component.searchResultsComponent.entries[0].accessibleUserIds).toEqual([1]);
    });

    it("leaves accessibleUserIds empty when the access lookup fails", async () => {
      modelService.retrieveAccessibleModels.mockReturnValue(of([makeModel({ mid: 1 })]));
      hubService.getUserAccess.mockReturnValue(throwError(() => new Error("down")));

      await component.search(true);

      expect(component.searchResultsComponent.entries[0].accessibleUserIds).toEqual([]);
    });

    it("does not call the hub for an empty result set", async () => {
      modelService.retrieveAccessibleModels.mockReturnValue(of([]));
      hubService.getCounts.mockClear();
      hubService.isLiked.mockClear();
      searchService.getUserInfo.mockClear();
      hubService.getUserAccess.mockClear();

      await component.search(true);

      expect(hubService.getUserAccess).not.toHaveBeenCalled();
      expect(hubService.getCounts).not.toHaveBeenCalled();
      expect(hubService.isLiked).not.toHaveBeenCalled();
      expect(searchService.getUserInfo).not.toHaveBeenCalled();
    });
  });
});
