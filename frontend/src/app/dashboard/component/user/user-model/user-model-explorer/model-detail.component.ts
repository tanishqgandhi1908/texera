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

import { Component, EventEmitter, OnInit, Output, ViewChild } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { switchMap } from "rxjs/operators";
import { Subscription } from "rxjs";
import { HttpErrorResponse, HttpStatusCode } from "@angular/common/http";
import { format } from "date-fns";
import { NgIf, NgClass, NgFor } from "@angular/common";
import { NzResizeEvent, NzResizableDirective, NzResizeHandleComponent } from "ng-zorro-antd/resizable";
import { NzCardComponent, NzCardMetaComponent } from "ng-zorro-antd/card";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { NzTagComponent } from "ng-zorro-antd/tag";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzPopoverDirective } from "ng-zorro-antd/popover";
import { NzSwitchComponent } from "ng-zorro-antd/switch";
import { FormsModule } from "@angular/forms";
import { NzLayoutComponent, NzContentComponent, NzSiderComponent } from "ng-zorro-antd/layout";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { NzEmptyComponent } from "ng-zorro-antd/empty";
import { NzCollapseComponent, NzCollapsePanelComponent } from "ng-zorro-antd/collapse";
import { NzSelectComponent, NzOptionComponent } from "ng-zorro-antd/select";
import { NzProgressComponent } from "ng-zorro-antd/progress";
import { NzInputDirective } from "ng-zorro-antd/input";
import { NzDividerComponent } from "ng-zorro-antd/divider";
import { CdkFixedSizeVirtualScroll, CdkVirtualForOf, CdkVirtualScrollViewport } from "@angular/cdk/scrolling";

import { ModelService } from "../../../../service/user/model/model.service";
import { DownloadService } from "../../../../service/user/download/download.service";
import { NotificationService } from "../../../../../common/service/notification/notification.service";
import { UserService } from "../../../../../common/service/user/user.service";
import { ModelVersion } from "../../../../../common/type/model";
import {
  DatasetFileNode,
  getFullPathFromDatasetFileNode,
  getRelativePathFromDatasetFileNode,
} from "../../../../../common/type/datasetVersionFileTree";
import { DatasetStagedObject } from "../../../../../common/type/dataset-staged-object";
import { FileUploadItem } from "../../../../type/dashboard-file.interface";
import { MultipartUploadProgress } from "../../../../service/user/file-resource/multipart-upload.service";
import { MODEL_FILE_RESOURCE_ENDPOINT } from "../../../../service/user/file-resource/file-resource-endpoint";
import { AdminSettingsService } from "../../../../service/admin/settings/admin-settings.service";
import { formatSpeed, formatTime, parseIntOrDefault } from "src/app/common/util/format.util";
import { formatSize } from "src/app/common/util/size-formatter.util";
import { MarkdownDescriptionComponent } from "../../markdown-description/markdown-description.component";
import { UserDatasetFileRendererComponent } from "../../user-dataset/user-dataset-explorer/user-dataset-file-renderer/user-dataset-file-renderer.component";
import { UserDatasetVersionFiletreeComponent } from "../../user-dataset/user-dataset-explorer/user-dataset-version-filetree/user-dataset-version-filetree.component";
import { FilesUploaderComponent } from "../../files-uploader/files-uploader.component";
import { UserModelStagedObjectsListComponent } from "./user-model-staged-objects-list/user-model-staged-objects-list.component";

export const ABORT_RETRY_MAX_ATTEMPTS = 10;
export const ABORT_RETRY_BACKOFF_BASE_MS = 100;

@UntilDestroy()
@Component({
  templateUrl: "./model-detail.component.html",
  styleUrls: ["./model-detail.component.scss"],
  imports: [
    NgIf,
    NgFor,
    NgClass,
    NzCardComponent,
    NzCardMetaComponent,
    NzTooltipDirective,
    NzTagComponent,
    ɵNzTransitionPatchDirective,
    NzIconDirective,
    NzButtonComponent,
    NzPopoverDirective,
    NzSwitchComponent,
    FormsModule,
    MarkdownDescriptionComponent,
    NzLayoutComponent,
    NzContentComponent,
    NzWaveDirective,
    NzEmptyComponent,
    UserDatasetFileRendererComponent,
    NzSiderComponent,
    NzResizableDirective,
    NzResizeHandleComponent,
    NzCollapseComponent,
    NzCollapsePanelComponent,
    NzSelectComponent,
    NzOptionComponent,
    UserDatasetVersionFiletreeComponent,
    FilesUploaderComponent,
    UserModelStagedObjectsListComponent,
    NzProgressComponent,
    NzInputDirective,
    NzDividerComponent,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
  ],
})
export class ModelDetailComponent implements OnInit {
  public mid: number | undefined;
  public modelName: string = "";
  public modelDescription: string = "";
  public modelCreationTime: string = "";
  public modelCreationTimeTooltip: string = "";
  public modelIsPublic: boolean = false;
  public modelIsDownloadable: boolean = true;
  public modelFramework: string | undefined;
  public modelFormat: string | undefined;
  public userModelAccessLevel: "READ" | "WRITE" | "NONE" = "NONE";
  public ownerEmail: string = "";
  public isOwner: boolean = false;

  // Relative to the version root, e.g. "weights/model.pt" — see loadFileContent.
  public currentDisplayedFileName: string = "";
  public currentFileSize: number | undefined;
  public currentModelVersionSize: number | undefined;

  public isRightBarCollapsed = false;
  public isMaximized = false;

  public versions: ReadonlyArray<ModelVersion> = [];
  public selectedVersion: ModelVersion | undefined;
  public fileTreeNodeList: DatasetFileNode[] = [];
  public selectedVersionCreationTime: string = "";

  public isLogin: boolean = this.userService.isLogin();

  // ─── upload state ─────────────────────────────────────────────────────────

  userHasPendingChanges: boolean = false;
  pendingChangesCount: number = 0;
  // Staged paths from the last diff response plus locally staged ones not yet in a diff, so the
  // Finished header keeps pace with the Pending header between throttled refetches.
  private confirmedStagedPaths = new Set<string>();
  private unconfirmedStagedPaths = new Set<string>();

  chunkSizeMiB: number = 50;
  maxConcurrentChunks: number = 10;
  maxConcurrentFiles: number = 3;
  private uploadSubscriptions = new Map<string, Subscription>();
  uploadTimeMap = new Map<string, number>();

  private activeUploads: number = 0;
  // FIFO queue of uploads waiting for a concurrency slot, keyed by file name.
  private pendingQueue = new Map<string, () => void>();
  private pendingQueueDirty = false;
  private queuedFileNamesSnapshot: string[] = [];

  // Row height must match .pending-file-row in the SCSS.
  readonly PENDING_ROW_HEIGHT_PX = 32;
  readonly PENDING_LIST_MAX_HEIGHT_PX = 160;

  @ViewChild(CdkVirtualScrollViewport) private pendingViewport?: CdkVirtualScrollViewport;

  versionName: string = "";
  isCreatingVersion: boolean = false;

  public uploadTasks: Array<MultipartUploadProgress & { filePath: string }> = [];

  @Output() userMakeChanges = new EventEmitter<void>();

  readonly uploadEndpoint = MODEL_FILE_RESOURCE_ENDPOINT;

  constructor(
    private route: ActivatedRoute,
    private modelService: ModelService,
    private notificationService: NotificationService,
    private downloadService: DownloadService,
    private userService: UserService,
    private adminSettingsService: AdminSettingsService
  ) {
    this.userService
      .userChanged()
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        this.isLogin = this.userService.isLogin();
      });
  }

  // item for control the resizeable sider
  MAX_SIDER_WIDTH = 600;
  MIN_SIDER_WIDTH = 150;
  siderWidth = 400;
  id = -1;
  onSideResize({ width }: NzResizeEvent): void {
    cancelAnimationFrame(this.id);
    this.id = requestAnimationFrame(() => {
      this.siderWidth = width!;
    });
  }

  ngOnInit(): void {
    this.route.params
      .pipe(
        switchMap(params => {
          // Route params are strings; mid is interpolated into URLs and compared numerically.
          this.mid = Number(params["mid"]);
          this.retrieveModelInfo();
          this.retrieveModelVersionList();
          this.loadUploadSettings();
          return this.route.data;
        }),
        untilDestroyed(this)
      )
      .subscribe();
  }

  retrieveModelInfo(): void {
    if (this.mid) {
      this.modelService
        .getModel(this.mid, this.isLogin)
        .pipe(untilDestroyed(this))
        .subscribe(dashboardModel => {
          const model = dashboardModel.model;
          this.modelName = model.name;
          this.modelDescription = model.description;
          this.userModelAccessLevel = dashboardModel.accessPrivilege;
          this.modelIsPublic = model.isPublic;
          this.modelIsDownloadable = model.isDownloadable;
          this.modelFramework = model.framework;
          this.modelFormat = model.format;
          this.ownerEmail = dashboardModel.ownerEmail;
          this.isOwner = dashboardModel.isOwner;
          if (typeof model.creationTime === "number") {
            const date = new Date(model.creationTime);
            this.modelCreationTime = format(date, "MM/dd/yyyy HH:mm:ss");
            const timeZoneName =
              new Intl.DateTimeFormat("en-US", {
                timeZoneName: "long",
              })
                .format(date)
                .split(", ")
                .pop() || "";
            this.modelCreationTimeTooltip = `${format(date, "zzzz")} (${timeZoneName})`;
          }
        });
    }
  }

  retrieveModelVersionList(): void {
    if (this.mid) {
      this.modelService
        .retrieveModelVersionList(this.mid)
        .pipe(untilDestroyed(this))
        .subscribe(versions => {
          this.versions = versions;
          // The backend orders newest first, so the head is the latest version.
          if (this.versions.length > 0) {
            this.selectedVersion = this.versions[0];
            this.onVersionSelected(this.selectedVersion);
          }
        });
    }
  }

  onVersionSelected(version: ModelVersion): void {
    this.selectedVersion = version;
    if (this.mid && this.selectedVersion.mvid) {
      this.modelService
        .retrieveModelVersionFileTree(this.mid, this.selectedVersion.mvid)
        .pipe(untilDestroyed(this))
        .subscribe(data => {
          this.fileTreeNodeList = data.fileNodes;
          this.currentModelVersionSize = data.size;
          if (typeof version.creationTime === "number") {
            this.selectedVersionCreationTime = format(new Date(version.creationTime), "MM/dd/yyyy HH:mm:ss");
          }
          if (this.fileTreeNodeList.length === 0) {
            this.currentDisplayedFileName = "";
            this.currentFileSize = undefined;
            return;
          }
          let currentNode = this.fileTreeNodeList[0];
          while (currentNode.type === "directory" && currentNode.children && currentNode.children.length > 0) {
            currentNode = currentNode.children[0];
          }
          this.loadFileContent(currentNode);
        });
    }
  }

  onVersionFileTreeNodeSelected(node: DatasetFileNode): void {
    this.loadFileContent(node);
  }

  loadFileContent(node: DatasetFileNode): void {
    this.currentDisplayedFileName = getFullPathFromDatasetFileNode(node);
    this.currentFileSize = node.size;
  }

  onClickDownloadCurrentFile = (): void => {
    if (!this.mid || !this.selectedVersion?.mvid) {
      return;
    }
    const shouldUsePublicEndpoint = this.modelIsPublic && !this.isOwner;
    this.downloadService
      .downloadModelSingleFile(this.currentDisplayedFileName, !shouldUsePublicEndpoint)
      .pipe(untilDestroyed(this))
      .subscribe();
  };

  onClickDownloadVersionAsZip(): void {
    if (this.mid && this.selectedVersion && this.selectedVersion.mvid) {
      this.downloadService
        .downloadModelVersion(this.mid, this.selectedVersion.mvid, this.modelName, this.selectedVersion.name)
        .pipe(untilDestroyed(this))
        .subscribe();
    }
  }

  onPublicStatusChange(checked: boolean): void {
    if (this.mid) {
      this.modelService
        .updateModelPublicity(this.mid)
        .pipe(untilDestroyed(this))
        .subscribe({
          next: () => {
            this.modelIsPublic = checked;
            const state = this.modelIsPublic ? "public" : "private";
            this.notificationService.success(`Model ${this.modelName} is now ${state}`);
          },
          error: () => {
            this.notificationService.error("Fail to change the model publicity");
          },
        });
    }
  }

  onDownloadableStatusChange(checked: boolean): void {
    if (this.mid) {
      this.modelService
        .updateModelDownloadable(this.mid)
        .pipe(untilDestroyed(this))
        .subscribe({
          next: () => {
            this.modelIsDownloadable = checked;
            const state = this.modelIsDownloadable ? "allowed" : "not allowed";
            this.notificationService.success(`Model downloads are now ${state}`);
          },
          error: () => {
            this.notificationService.error("Failed to change the model download permission");
          },
        });
    }
  }

  onModelDescriptionChange(description: string): void {
    const updatedDescription = description ?? "";
    const previousDescription = this.modelDescription;

    if (!this.mid || this.modelDescription === updatedDescription) {
      return;
    }

    this.modelDescription = updatedDescription;

    this.modelService
      .updateModelDescription(this.mid, updatedDescription)
      .pipe(untilDestroyed(this))
      .subscribe({
        error: () => {
          this.modelDescription = previousDescription;
          this.notificationService.error("Failed to update model description");
        },
      });
  }

  async copyCurrentFilePath(): Promise<void> {
    if (!this.currentDisplayedFileName) {
      return;
    }

    try {
      await navigator.clipboard.writeText(this.currentDisplayedFileName);
      this.notificationService.success("File path copied to clipboard");
    } catch (error) {
      this.notificationService.error("Failed to copy file path");
    }
  }

  onClickScaleTheView(): void {
    this.isMaximized = !this.isMaximized;
  }

  onClickHideRightBar(): void {
    this.isRightBarCollapsed = !this.isRightBarCollapsed;
  }

  userHasWriteAccess(): boolean {
    return this.userModelAccessLevel == "WRITE";
  }

  isDownloadAllowed(): boolean {
    if (this.isOwner) {
      return true;
    }
    return this.modelIsDownloadable && (this.modelIsPublic || this.userModelAccessLevel !== "NONE");
  }

  // A missing key or failed fetch keeps the field defaults; NaN here would silently stall the
  // queue (`activeUploads < NaN` is always false).
  private loadUploadSettings(): void {
    const settings: Array<[string, (value: number) => void]> = [
      ["multipart_upload_chunk_size_mib", value => (this.chunkSizeMiB = value)],
      ["max_number_of_concurrent_uploading_file_chunks", value => (this.maxConcurrentChunks = value)],
      ["max_number_of_concurrent_uploading_file", value => (this.maxConcurrentFiles = value)],
    ];
    const current: Record<string, number> = {
      multipart_upload_chunk_size_mib: this.chunkSizeMiB,
      max_number_of_concurrent_uploading_file_chunks: this.maxConcurrentChunks,
      max_number_of_concurrent_uploading_file: this.maxConcurrentFiles,
    };
    settings.forEach(([key, assign]) => {
      this.adminSettingsService
        .getPublicSetting(key)
        .pipe(untilDestroyed(this))
        .subscribe({
          next: value => assign(parseIntOrDefault(value, current[key])),
          error: () => {},
        });
    });
  }

  onNewUploadFilesChanged(files: FileUploadItem[]) {
    if (!this.mid) {
      return;
    }
    files.forEach(file => {
      const continueWithUpload = () => {
        const startUpload = () => {
          this.removeFromPendingQueue(file.name);

          this.uploadTasks.unshift({ filePath: file.name, percentage: 0, status: "initializing" });

          const subscription = this.modelService
            .multipartUpload(
              this.ownerEmail,
              this.modelName,
              file.name,
              file.file,
              this.chunkSizeMiB * 1024 * 1024,
              this.maxConcurrentChunks,
              file.restart
            )
            .pipe(untilDestroyed(this))
            .subscribe({
              next: progress => {
                const taskIndex = this.uploadTasks.findIndex(t => t.filePath === file.name);
                if (taskIndex === -1) {
                  return;
                }
                this.uploadTasks[taskIndex] = {
                  ...this.uploadTasks[taskIndex],
                  ...progress,
                  percentage: progress.percentage ?? this.uploadTasks[taskIndex].percentage ?? 0,
                };

                // totalTime may be exactly 0 (resumed upload with no missing parts); a
                // truthiness check would leak the concurrency slot.
                if (progress.status === "finished" && progress.totalTime !== undefined) {
                  const filename = file.name.split("/").pop() || file.name;
                  this.uploadTimeMap.set(filename, progress.totalTime);
                  this.markPathStaged(file.name);
                  this.userMakeChanges.emit();
                  this.scheduleHide(taskIndex);
                  this.onUploadComplete();
                }
              },
              error: (res: unknown) => {
                const err = res as HttpErrorResponse;
                if (err?.status === HttpStatusCode.Conflict) {
                  this.notificationService.error(
                    "Upload blocked (409). Another upload is likely in progress for this file (another tab/browser), or the server is finalizing a previous upload. Please retry in a moment."
                  );
                } else {
                  this.notificationService.error("Upload failed. Please retry.");
                }
                const taskIndex = this.uploadTasks.findIndex(t => t.filePath === file.name);
                if (taskIndex !== -1) {
                  this.uploadTasks[taskIndex] = {
                    ...this.uploadTasks[taskIndex],
                    percentage: this.uploadTasks[taskIndex].percentage ?? 0,
                    status: "failed",
                  };
                  this.scheduleHide(taskIndex);
                }
                this.onUploadComplete();
              },
              complete: () => {
                const taskIndex = this.uploadTasks.findIndex(t => t.filePath === file.name);
                if (taskIndex !== -1 && this.uploadTasks[taskIndex].status !== "finished") {
                  this.uploadTasks[taskIndex].status = "finished";
                  this.markPathStaged(file.name);
                  this.userMakeChanges.emit();
                  this.scheduleHide(taskIndex);
                  this.onUploadComplete();
                }
              },
            });
          this.uploadSubscriptions.set(file.name, subscription);
        };

        if (this.activeUploads < this.maxConcurrentFiles) {
          this.activeUploads++;
          startUpload();
        } else {
          this.pendingQueue.set(file.name, startUpload);
          this.pendingQueueDirty = true;
        }
      };

      this.cancelExistingUpload(file.name, continueWithUpload);
    });
  }

  cancelExistingUpload(fileName: string, onCanceled?: () => void): void {
    const task = this.uploadTasks.find(t => t.filePath === fileName);
    if (task && (task.status === "uploading" || task.status === "initializing")) {
      this.onClickAbortUploadProgress(task, onCanceled);
      return;
    }
    this.removeFromPendingQueue(fileName);
    onCanceled?.();
  }

  private processNextQueuedUpload(): void {
    if (this.activeUploads < this.maxConcurrentFiles) {
      const next = this.pendingQueue.entries().next();
      if (!next.done) {
        const [fileName, startUpload] = next.value;
        this.pendingQueue.delete(fileName);
        this.pendingQueueDirty = true;
        this.activeUploads++;
        startUpload();
      }
    }
  }

  private onUploadComplete(): void {
    this.activeUploads--;
    this.processNextQueuedUpload();
  }

  private removeFromPendingQueue(fileName: string): void {
    if (this.pendingQueue.delete(fileName)) {
      this.pendingQueueDirty = true;
    }
  }

  get queuedFileNames(): string[] {
    if (this.pendingQueueDirty) {
      this.queuedFileNamesSnapshot = Array.from(this.pendingQueue.keys());
      this.pendingQueueDirty = false;
    }
    return this.queuedFileNamesSnapshot;
  }

  get queuedCount(): number {
    return this.pendingQueue.size;
  }

  get pendingListHeightPx(): number {
    return Math.min(this.queuedCount * this.PENDING_ROW_HEIGHT_PX, this.PENDING_LIST_MAX_HEIGHT_PX);
  }

  // The viewport initializes inside the collapsed (display: none) panel and measures height 0;
  // the CDK only re-measures on window resize.
  onPendingPanelActiveChange(active: boolean): void {
    if (active) {
      setTimeout(() => this.pendingViewport?.checkViewportSize());
    }
  }

  get activeCount(): number {
    return this.activeUploads;
  }

  get hasAnyActivity(): boolean {
    return this.pendingChangesCount > 0 || this.activeCount > 0 || this.queuedCount > 0;
  }

  // Hide a task row after 5s
  private scheduleHide(idx: number) {
    if (idx === -1) {
      return;
    }
    const task = this.uploadTasks[idx];
    this.uploadSubscriptions.delete(task.filePath);
    // Remove by identity, not filePath: a same-named re-upload within the window has its own
    // row, which must survive this timer.
    setTimeout(() => {
      this.uploadTasks = this.uploadTasks.filter(t => t !== task);
    }, 5000);
  }

  onClickAbortUploadProgress(task: MultipartUploadProgress & { filePath: string }, onAborted?: () => void) {
    const subscription = this.uploadSubscriptions.get(task.filePath);
    if (subscription) {
      subscription.unsubscribe();
      this.uploadSubscriptions.delete(task.filePath);
    }

    if (task.status === "uploading" || task.status === "initializing") {
      this.onUploadComplete();
    }

    let doneCalled = false;
    const done = () => {
      if (doneCalled) {
        return;
      }
      doneCalled = true;
      onAborted?.();
    };

    const abortWithRetry = (attempt: number) => {
      this.modelService
        .finalizeMultipartUpload(this.ownerEmail, this.modelName, task.filePath, true)
        .pipe(untilDestroyed(this))
        .subscribe({
          next: () => {
            this.notificationService.info(`${task.filePath} uploading has been terminated`);
            done();
          },
          error: (res: unknown) => {
            const err = res as HttpErrorResponse;
            // Already gone, treat as done
            if (err.status === 404) {
              done();
              return;
            }
            // Backend is still finalizing/aborting; retry with a tiny backoff
            if (err.status === HttpStatusCode.Conflict && attempt < ABORT_RETRY_MAX_ATTEMPTS) {
              setTimeout(() => abortWithRetry(attempt + 1), ABORT_RETRY_BACKOFF_BASE_MS * (attempt + 1));
              return;
            }
            done();
          },
        });
    };

    abortWithRetry(0);

    const idx = this.uploadTasks.findIndex(t => t.filePath === task.filePath);
    if (idx !== -1) {
      this.uploadTasks[idx] = { ...this.uploadTasks[idx], status: "aborted" };
      this.scheduleHide(idx);
    }
  }

  getUploadStatus(status: MultipartUploadProgress["status"]): "active" | "exception" | "success" {
    return status === "uploading" || status === "initializing"
      ? "active"
      : status === "aborted" || status === "failed"
        ? "exception"
        : "success";
  }

  onPreviouslyUploadedFileDeleted(node: DatasetFileNode) {
    if (!this.mid) {
      return;
    }
    const relativePath = getRelativePathFromDatasetFileNode(node);
    this.modelService
      .deleteModelFile(this.mid, relativePath)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success(
            `File ${node.name} is successfully deleted. You may finalize it or revert it at the "Create Version" panel`
          );
          this.markPathStaged(relativePath);
          this.userMakeChanges.emit();
        },
        error: () => {
          this.notificationService.error("Failed to delete the file");
        },
      });
  }

  onStagedObjectsUpdated(stagedObjects: DatasetStagedObject[]) {
    this.confirmedStagedPaths = new Set(stagedObjects.map(obj => obj.path));
    for (const path of this.confirmedStagedPaths) {
      this.unconfirmedStagedPaths.delete(path);
    }
    this.refreshPendingChanges();
  }

  // Reflects a locally staged change (finished upload or deletion) in the Finished header
  // immediately, ahead of the next diff response.
  private markPathStaged(path: string): void {
    if (!this.confirmedStagedPaths.has(path)) {
      this.unconfirmedStagedPaths.add(path);
    }
    this.refreshPendingChanges();
  }

  private refreshPendingChanges(): void {
    this.pendingChangesCount = this.confirmedStagedPaths.size + this.unconfirmedStagedPaths.size;
    this.userHasPendingChanges = this.pendingChangesCount > 0;
  }

  public onClickCreateVersion() {
    if (!this.mid || this.isCreatingVersion) {
      return;
    }
    this.isCreatingVersion = true;
    this.modelService
      .createModelVersion(this.mid, this.versionName?.trim() || "")
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success("Version Created");
          this.isCreatingVersion = false;
          this.versionName = "";
          // A new version consumes all staged changes.
          this.confirmedStagedPaths.clear();
          this.unconfirmedStagedPaths.clear();
          this.refreshPendingChanges();
          this.retrieveModelVersionList();
          this.userMakeChanges.emit();
        },
        error: (res: unknown) => {
          const err = res as HttpErrorResponse;
          this.notificationService.error(`Version creation failed: ${err.error?.message}`);
          this.isCreatingVersion = false;
        },
      });
  }

  trackByTask(_: number, task: MultipartUploadProgress & { filePath: string }): string {
    return task.filePath;
  }

  trackByPendingFile(_: number, fileName: string): string {
    return fileName;
  }

  formatSpeed = formatSpeed;
  formatTime = formatTime;

  formatSize = formatSize;
}
