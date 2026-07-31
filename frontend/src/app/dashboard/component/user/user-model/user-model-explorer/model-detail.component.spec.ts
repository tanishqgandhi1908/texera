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
import { ActivatedRoute } from "@angular/router";
import { MarkdownService } from "ngx-markdown";
import { NzModalService } from "ng-zorro-antd/modal";
import { NEVER, of, Subject, throwError } from "rxjs";

import { ModelDetailComponent } from "./model-detail.component";
import { ModelService } from "../../../../service/user/model/model.service";
import { DownloadService } from "../../../../service/user/download/download.service";
import { NotificationService } from "../../../../../common/service/notification/notification.service";
import { AdminSettingsService } from "../../../../service/admin/settings/admin-settings.service";
import { UserService } from "../../../../../common/service/user/user.service";
import { StubUserService } from "../../../../../common/service/user/stub-user.service";
import { DashboardModel } from "../../../../type/dashboard-model.interface";
import { ModelVersion } from "../../../../../common/type/model";
import { DatasetFileNode } from "../../../../../common/type/datasetVersionFileTree";
import { FileUploadItem } from "../../../../type/dashboard-file.interface";
import { commonTestImports, commonTestProviders } from "../../../../../common/testing/test-utils";

function makeDashboardModel(overrides: Partial<DashboardModel["model"]> = {}, top: Partial<DashboardModel> = {}) {
  return {
    isOwner: true,
    ownerEmail: "owner@example.com",
    accessPrivilege: "WRITE",
    size: 100,
    model: {
      mid: 5,
      ownerUid: 1,
      name: "resnet",
      repositoryName: "model-5",
      isPublic: false,
      isDownloadable: true,
      description: "a model",
      creationTime: 1000,
      coverImage: undefined,
      framework: "pytorch",
      format: "safetensors",
      ...overrides,
    },
    ...top,
  } as DashboardModel;
}

function makeVersion(overrides: Partial<ModelVersion> = {}): ModelVersion {
  return {
    mvid: 10,
    mid: 5,
    creatorUid: 1,
    name: "v1",
    versionHash: "commit-abc",
    creationTime: 2000,
    fileNodes: undefined,
    ...overrides,
  };
}

// The backend roots model trees at the models prefix, so node paths resolve against models.
const VERSION_ROOT = "/models/owner@example.com/resnet/v1";

function fileNode(name: string, parentDir = VERSION_ROOT): DatasetFileNode {
  return { name, type: "file", parentDir, size: 8 };
}

function dirNode(name: string, children: DatasetFileNode[]): DatasetFileNode {
  return { name, type: "directory", parentDir: VERSION_ROOT, children };
}

describe("ModelDetailComponent", () => {
  let component: ModelDetailComponent;
  let fixture: ComponentFixture<ModelDetailComponent>;
  let modelService: {
    getModel: ReturnType<typeof vi.fn>;
    retrieveModelVersionList: ReturnType<typeof vi.fn>;
    retrieveModelVersionFileTree: ReturnType<typeof vi.fn>;
    updateModelPublicity: ReturnType<typeof vi.fn>;
    updateModelDownloadable: ReturnType<typeof vi.fn>;
    updateModelDescription: ReturnType<typeof vi.fn>;
    getModelDiff: ReturnType<typeof vi.fn>;
    resetModelFileDiff: ReturnType<typeof vi.fn>;
    deleteModelFile: ReturnType<typeof vi.fn>;
    createModelVersion: ReturnType<typeof vi.fn>;
    multipartUpload: ReturnType<typeof vi.fn>;
    finalizeMultipartUpload: ReturnType<typeof vi.fn>;
  };
  let downloadService: {
    downloadModelVersion: ReturnType<typeof vi.fn>;
    downloadModelSingleFile: ReturnType<typeof vi.fn>;
  };
  let notificationService: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    modelService = {
      getModel: vi.fn().mockReturnValue(of(makeDashboardModel())),
      retrieveModelVersionList: vi.fn().mockReturnValue(of([makeVersion()])),
      retrieveModelVersionFileTree: vi.fn().mockReturnValue(of({ fileNodes: [fileNode("model.pt")], size: 2048 })),
      updateModelPublicity: vi.fn().mockReturnValue(of({})),
      updateModelDownloadable: vi.fn().mockReturnValue(of({})),
      updateModelDescription: vi.fn().mockReturnValue(of({})),
      getModelDiff: vi.fn().mockReturnValue(of([])),
      resetModelFileDiff: vi.fn().mockReturnValue(of({})),
      deleteModelFile: vi.fn().mockReturnValue(of({})),
      createModelVersion: vi.fn().mockReturnValue(of(makeVersion({ mvid: 11, name: "v2" }))),
      multipartUpload: vi.fn().mockReturnValue(NEVER),
      finalizeMultipartUpload: vi.fn().mockReturnValue(of({})),
    };
    downloadService = {
      downloadModelVersion: vi.fn().mockReturnValue(of(new Blob())),
      downloadModelSingleFile: vi.fn().mockReturnValue(of(new Blob())),
    };
    notificationService = { success: vi.fn(), error: vi.fn() };

    TestBed.configureTestingModule({
      imports: [ModelDetailComponent, ...commonTestImports],
      providers: [
        { provide: ModelService, useValue: modelService },
        { provide: DownloadService, useValue: downloadService },
        { provide: NotificationService, useValue: notificationService },
        { provide: UserService, useClass: StubUserService },
        { provide: ActivatedRoute, useValue: { params: of({ mid: "5" }), data: of({}) } },
        { provide: MarkdownService, useValue: { parse: vi.fn(() => "") } },
        { provide: NzModalService, useValue: { create: vi.fn() } },
        { provide: AdminSettingsService, useValue: { getPublicSetting: vi.fn().mockReturnValue(of("20")) } },
        ...commonTestProviders,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ModelDetailComponent);
    component = fixture.componentInstance;
  });

  describe("ngOnInit", () => {
    it("coerces the route param to a number and loads the model plus its versions", () => {
      fixture.detectChanges();

      // params["mid"] is a string; leaving it uncoerced would make mid === "5".
      expect(component.mid).toBe(5);
      expect(modelService.getModel).toHaveBeenCalledWith(5, true);
      expect(modelService.retrieveModelVersionList).toHaveBeenCalledWith(5);
    });

    it("populates the header fields, including the model-only framework and format", () => {
      fixture.detectChanges();

      expect(component.modelName).toBe("resnet");
      expect(component.modelDescription).toBe("a model");
      expect(component.modelFramework).toBe("pytorch");
      expect(component.modelFormat).toBe("safetensors");
      expect(component.userModelAccessLevel).toBe("WRITE");
      expect(component.ownerEmail).toBe("owner@example.com");
      expect(component.modelCreationTime).not.toBe("");
    });
  });

  describe("version selection", () => {
    it("selects the newest version and loads its file tree and size", () => {
      fixture.detectChanges();

      expect(component.selectedVersion?.name).toBe("v1");
      expect(modelService.retrieveModelVersionFileTree).toHaveBeenCalledWith(5, 10);
      expect(component.currentModelVersionSize).toBe(2048);
      expect(component.selectedVersionCreationTime).not.toBe("");
    });

    it("previews the first leaf, addressed by its full logical path", () => {
      modelService.retrieveModelVersionFileTree.mockReturnValue(
        of({ fileNodes: [dirNode("weights", [fileNode("model.pt", `${VERSION_ROOT}/weights`)])], size: 10 })
      );

      fixture.detectChanges();

      expect(component.currentDisplayedFileName).toBe(`${VERSION_ROOT}/weights/model.pt`);
      expect(component.currentFileSize).toBe(8);
    });

    it("clears the preview when the version has no files", () => {
      modelService.retrieveModelVersionFileTree.mockReturnValue(of({ fileNodes: [], size: 0 }));

      fixture.detectChanges();

      expect(component.currentDisplayedFileName).toBe("");
      expect(component.currentFileSize).toBeUndefined();
    });

    it("leaves no version selected when the model has none", () => {
      modelService.retrieveModelVersionList.mockReturnValue(of([]));

      fixture.detectChanges();

      expect(component.selectedVersion).toBeUndefined();
      expect(modelService.retrieveModelVersionFileTree).not.toHaveBeenCalled();
    });
  });

  describe("access and download gating", () => {
    it("userHasWriteAccess is true only for WRITE", () => {
      component.userModelAccessLevel = "WRITE";
      expect(component.userHasWriteAccess()).toBe(true);
      component.userModelAccessLevel = "READ";
      expect(component.userHasWriteAccess()).toBe(false);
    });

    it("allows an owner to download regardless of the downloadable flag", () => {
      component.isOwner = true;
      component.modelIsDownloadable = false;
      expect(component.isDownloadAllowed()).toBe(true);
    });

    it("allows a non-owner on a public downloadable model", () => {
      component.isOwner = false;
      component.modelIsDownloadable = true;
      component.modelIsPublic = true;
      component.userModelAccessLevel = "NONE";
      expect(component.isDownloadAllowed()).toBe(true);
    });

    it("blocks a non-owner without access on a private model", () => {
      component.isOwner = false;
      component.modelIsDownloadable = true;
      component.modelIsPublic = false;
      component.userModelAccessLevel = "NONE";
      expect(component.isDownloadAllowed()).toBe(false);
    });

    it("blocks a non-owner when downloads are restricted", () => {
      component.isOwner = false;
      component.modelIsDownloadable = false;
      component.modelIsPublic = true;
      expect(component.isDownloadAllowed()).toBe(false);
    });
  });

  describe("downloads", () => {
    it("downloads the selected version as a zip", () => {
      fixture.detectChanges();

      component.onClickDownloadVersionAsZip();

      expect(downloadService.downloadModelVersion).toHaveBeenCalledWith(5, 10, "resnet", "v1");
    });

    it("downloads the current file by its logical path", () => {
      fixture.detectChanges();

      component.onClickDownloadCurrentFile();

      expect(downloadService.downloadModelSingleFile).toHaveBeenCalledWith(`${VERSION_ROOT}/model.pt`, true);
    });

    it("uses the public endpoint for a non-owner on a public model", () => {
      fixture.detectChanges();
      component.isOwner = false;
      component.modelIsPublic = true;

      component.onClickDownloadCurrentFile();

      expect(downloadService.downloadModelSingleFile).toHaveBeenCalledWith(`${VERSION_ROOT}/model.pt`, false);
    });
  });

  describe("publicity and downloadable toggles", () => {
    it("updates publicity and reports the new state", () => {
      fixture.detectChanges();

      component.onPublicStatusChange(true);

      expect(modelService.updateModelPublicity).toHaveBeenCalledWith(5);
      expect(component.modelIsPublic).toBe(true);
      expect(notificationService.success).toHaveBeenCalledWith("Model resnet is now public");
    });

    it("leaves the flag untouched when the publicity update fails", () => {
      fixture.detectChanges();
      modelService.updateModelPublicity.mockReturnValue(throwError(() => new Error("nope")));

      component.onPublicStatusChange(true);

      expect(component.modelIsPublic).toBe(false);
      expect(notificationService.error).toHaveBeenCalledWith("Fail to change the model publicity");
    });

    it("updates the downloadable flag and reports the new state", () => {
      fixture.detectChanges();

      component.onDownloadableStatusChange(false);

      expect(modelService.updateModelDownloadable).toHaveBeenCalledWith(5);
      expect(component.modelIsDownloadable).toBe(false);
      expect(notificationService.success).toHaveBeenCalledWith("Model downloads are now not allowed");
    });
  });

  describe("description", () => {
    it("persists a changed description", () => {
      fixture.detectChanges();

      component.onModelDescriptionChange("updated");

      expect(modelService.updateModelDescription).toHaveBeenCalledWith(5, "updated");
      expect(component.modelDescription).toBe("updated");
    });

    it("does not call the backend when the description is unchanged", () => {
      fixture.detectChanges();

      component.onModelDescriptionChange("a model");

      expect(modelService.updateModelDescription).not.toHaveBeenCalled();
    });

    it("reverts to the previous description when the update fails", () => {
      fixture.detectChanges();
      modelService.updateModelDescription.mockReturnValue(throwError(() => new Error("nope")));

      component.onModelDescriptionChange("updated");

      expect(component.modelDescription).toBe("a model");
      expect(notificationService.error).toHaveBeenCalledWith("Failed to update model description");
    });
  });

  describe("view controls", () => {
    it("toggles the maximized and collapsed flags", () => {
      component.onClickScaleTheView();
      expect(component.isMaximized).toBe(true);
      component.onClickHideRightBar();
      expect(component.isRightBarCollapsed).toBe(true);
    });

    it("selecting a tree node loads its full logical path", () => {
      component.onVersionFileTreeNodeSelected(fileNode("config.json"));

      expect(component.currentDisplayedFileName).toBe(`${VERSION_ROOT}/config.json`);
    });
  });

  describe("copyCurrentFilePath", () => {
    it("copies the displayed path and reports success", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      component.currentDisplayedFileName = "weights/model.pt";

      await component.copyCurrentFilePath();

      expect(writeText).toHaveBeenCalledWith("weights/model.pt");
      expect(notificationService.success).toHaveBeenCalledWith("File path copied to clipboard");
    });

    it("does nothing when no file is displayed", async () => {
      const writeText = vi.fn();
      Object.assign(navigator, { clipboard: { writeText } });
      component.currentDisplayedFileName = "";

      await component.copyCurrentFilePath();

      expect(writeText).not.toHaveBeenCalled();
    });

    it("reports an error when the clipboard write is rejected", async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
      component.currentDisplayedFileName = "weights/model.pt";

      await component.copyCurrentFilePath();

      expect(notificationService.error).toHaveBeenCalledWith("Failed to copy file path");
    });
  });

  describe("upload", () => {
    const item = (name: string): FileUploadItem =>
      ({ file: new File(["x"], name), name, restart: false }) as unknown as FileUploadItem;

    it("starts at most maxConcurrentFiles uploads and queues the rest", () => {
      fixture.detectChanges();
      component.maxConcurrentFiles = 2;

      component.onNewUploadFilesChanged([item("a"), item("b"), item("c"), item("d")]);

      expect(modelService.multipartUpload).toHaveBeenCalledTimes(2);
      expect(component.activeCount).toBe(2);
      expect(component.queuedCount).toBe(2);
      expect(component.queuedFileNames).toEqual(["c", "d"]);
    });

    it("addresses the upload by owner email and model name", () => {
      fixture.detectChanges();

      component.onNewUploadFilesChanged([item("weights.pt")]);

      // ownerEmail + modelName is how the backend resolves the model; datasetName would 400.
      expect(modelService.multipartUpload).toHaveBeenCalledWith(
        "owner@example.com",
        "resnet",
        "weights.pt",
        expect.anything(),
        expect.any(Number),
        expect.any(Number),
        false
      );
    });

    it("starts the next queued upload once an active one finishes", () => {
      fixture.detectChanges();
      component.maxConcurrentFiles = 1;
      const progress = new Subject<any>();
      modelService.multipartUpload.mockReturnValueOnce(progress).mockReturnValue(NEVER);

      component.onNewUploadFilesChanged([item("first"), item("second")]);
      expect(component.queuedFileNames).toEqual(["second"]);

      progress.next({ filePath: "first", percentage: 100, status: "finished", totalTime: 0 });

      expect(component.queuedCount).toBe(0);
      expect(modelService.multipartUpload).toHaveBeenCalledTimes(2);
    });

    it("removes a queued file without ever starting it", () => {
      fixture.detectChanges();
      component.maxConcurrentFiles = 1;

      component.onNewUploadFilesChanged([item("active"), item("queued")]);
      component.cancelExistingUpload("queued");

      expect(component.queuedCount).toBe(0);
      expect(modelService.multipartUpload).toHaveBeenCalledTimes(1);
    });

    it("aborts an in-flight upload through the model endpoints", () => {
      fixture.detectChanges();
      component.onNewUploadFilesChanged([item("big.pt")]);
      const task = component.uploadTasks[0];

      component.onClickAbortUploadProgress(task);

      expect(modelService.finalizeMultipartUpload).toHaveBeenCalledWith("owner@example.com", "resnet", "big.pt", true);
      expect(component.uploadTasks[0].status).toBe("aborted");
    });

    it("maps upload status onto the progress-bar states", () => {
      expect(component.getUploadStatus("uploading")).toBe("active");
      expect(component.getUploadStatus("initializing")).toBe("active");
      expect(component.getUploadStatus("failed")).toBe("exception");
      expect(component.getUploadStatus("aborted")).toBe("exception");
      expect(component.getUploadStatus("finished")).toBe("success");
    });

    it("tracks staged changes reported by the diff and locally", () => {
      fixture.detectChanges();

      component.onStagedObjectsUpdated([
        { path: "a.pt", pathType: "file", diffType: "added" },
        { path: "b.pt", pathType: "file", diffType: "removed" },
      ]);

      expect(component.pendingChangesCount).toBe(2);
      expect(component.userHasPendingChanges).toBe(true);
      expect(component.hasAnyActivity).toBe(true);
    });

    it("stages a deletion by relative path and reports it", () => {
      fixture.detectChanges();

      component.onPreviouslyUploadedFileDeleted(fileNode("model.pt"));

      // Relative to the version root, which is what the backend's diff API expects.
      expect(modelService.deleteModelFile).toHaveBeenCalledWith(5, "model.pt");
      expect(component.pendingChangesCount).toBe(1);
    });

    it("creates a version, clears staged state and refetches the version list", () => {
      fixture.detectChanges();
      component.onStagedObjectsUpdated([{ path: "a.pt", pathType: "file", diffType: "added" }]);
      component.versionName = "  v2  ";
      modelService.retrieveModelVersionList.mockClear();

      component.onClickCreateVersion();

      expect(modelService.createModelVersion).toHaveBeenCalledWith(5, "v2");
      expect(component.versionName).toBe("");
      expect(component.pendingChangesCount).toBe(0);
      expect(modelService.retrieveModelVersionList).toHaveBeenCalledWith(5);
      expect(component.isCreatingVersion).toBe(false);
    });

    it("ignores a second submit while one is already in flight", () => {
      fixture.detectChanges();
      modelService.createModelVersion.mockReturnValue(NEVER);

      component.onClickCreateVersion();
      component.onClickCreateVersion();

      expect(modelService.createModelVersion).toHaveBeenCalledTimes(1);
    });

    it("surfaces a version-creation failure and clears the loading flag", () => {
      fixture.detectChanges();
      modelService.createModelVersion.mockReturnValue(throwError(() => ({ error: { message: "nothing staged" } })));

      component.onClickCreateVersion();

      expect(notificationService.error).toHaveBeenCalledWith("Version creation failed: nothing staged");
      expect(component.isCreatingVersion).toBe(false);
    });
  });
});
