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

import { Component, inject, OnInit } from "@angular/core";
import { NZ_MODAL_DATA, NzModalRef } from "ng-zorro-antd/modal";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { DatasetFileNode } from "../../../common/type/datasetVersionFileTree";
import { ModelVersion } from "../../../common/type/model";
import { ResourceType } from "../../../common/type/resource-type";
import { DashboardModel } from "../../../dashboard/type/dashboard-model.interface";
import { ModelService } from "../../../dashboard/service/user/model/model.service";
import { NzRowDirective, NzColDirective } from "ng-zorro-antd/grid";
import { NzSelectComponent, NzOptionComponent } from "ng-zorro-antd/select";
import { FormsModule } from "@angular/forms";
import { NgFor, NgIf } from "@angular/common";
import { UserDatasetVersionFiletreeComponent } from "../../../dashboard/component/user/user-dataset/user-dataset-explorer/user-dataset-version-filetree/user-dataset-version-filetree.component";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { filterModelOption } from "./model-search.util";

/**
 * Picks a single model *version* and returns its logical path
 * `/models/ownerEmail/modelName/versionName`. Unlike the dataset picker there is no file
 * mode: a mount always exposes a whole version, so the file tree here is read-only and
 * shown only to let the user confirm what the version contains before mounting it.
 */
@UntilDestroy()
@Component({
  templateUrl: "model-selection-modal.component.html",
  styleUrls: ["model-selection-modal.component.scss"],
  imports: [
    NzRowDirective,
    NzSelectComponent,
    NzColDirective,
    FormsModule,
    NgFor,
    NgIf,
    NzOptionComponent,
    UserDatasetVersionFiletreeComponent,
    NzButtonComponent,
    NzWaveDirective,
    ɵNzTransitionPatchDirective,
  ],
})
export class ModelSelectionModalComponent implements OnInit {
  private readonly data = inject(NZ_MODAL_DATA, { optional: true }) as { selectedPath?: string | null } | null;

  models: ReadonlyArray<DashboardModel> = [];
  modelVersions: ReadonlyArray<ModelVersion> = [];
  fileTree: DatasetFileNode[] = [];
  selectedModel?: DashboardModel;
  selectedVersion?: ModelVersion;
  selectedPath?: string;

  constructor(
    private modalRef: NzModalRef,
    private modelService: ModelService
  ) {}

  // Search filter for the model dropdown: matches the typed text against both the model
  // name and its numeric id (shown as `#<id>`). See filterModelOption.
  modelFilterOption = filterModelOption;

  ngOnInit() {
    this.modelService
      .retrieveAccessibleModels()
      .pipe(untilDestroyed(this))
      .subscribe(models => {
        this.models = models;
        const selectedPath = this.data?.selectedPath;
        if (selectedPath) {
          // Stored paths always carry the resource-type prefix; skip it so that owner/model/version line up.
          const [, ownerEmail, modelName, versionName] = selectedPath.split("/").filter(part => part.length > 0);
          this.selectedModel = this.models.find(
            model => model.ownerEmail === ownerEmail && model.model.name === modelName
          );
          this.onModelChange(versionName);
        }
      });
  }

  onModelChange(versionName?: string) {
    this.fileTree = [];
    this.selectedVersion = undefined;
    this.selectedPath = undefined;
    const mid = this.selectedModel?.model.mid;
    if (mid === undefined) {
      this.modelVersions = [];
      return;
    }
    this.modelService
      .retrieveModelVersionList(mid)
      .pipe(untilDestroyed(this))
      .subscribe(versions => {
        this.modelVersions = versions;
        const preselected = versions.find(version => version.name === versionName);
        if (preselected) {
          this.selectedVersion = preselected;
          this.onVersionChange();
        }
      });
  }

  onVersionChange() {
    const mid = this.selectedModel?.model.mid;
    const mvid = this.selectedVersion?.mvid;
    this.fileTree = [];
    this.selectedPath = undefined;
    if (mid === undefined || mvid === undefined) {
      return;
    }
    this.modelService
      .retrieveModelVersionFileTree(mid, mvid)
      .pipe(untilDestroyed(this))
      .subscribe(data => {
        this.fileTree = data.fileNodes;
      });
    this.selectedPath = `/${ResourceType.Models}/${this.selectedModel!.ownerEmail}/${this.selectedModel!.model.name}/${this.selectedVersion!.name}`;
  }

  onConfirmSelection() {
    this.modalRef.close(this.selectedPath);
  }
}
