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

import { Component } from "@angular/core";
import { FieldType, FieldTypeConfig } from "@ngx-formly/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { NzModalService } from "ng-zorro-antd/modal";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { ModelSelectionModalComponent } from "../model-selection-modal/model-selection-modal.component";

/**
 * Value editor for a Python UDF UI parameter declared as
 * `self.UiParameter("NAME", UiParameterType.MODELS)`.
 *
 * The stored value is the model version's `/models/owner/name/version` path, picked from the
 * model browser rather than typed. What the UDF receives is the directory that version is
 * mounted at — the backend substitutes it, and mounts the version, when the workflow runs.
 */
@UntilDestroy()
@Component({
  selector: "texera-model-value-selector",
  templateUrl: "./model-value-selector.component.html",
  styleUrls: ["./model-value-selector.component.scss"],
  imports: [NzButtonComponent, NzWaveDirective, ɵNzTransitionPatchDirective, NzIconDirective, NzTooltipDirective],
})
export class ModelValueSelectorComponent extends FieldType<FieldTypeConfig> {
  constructor(private modalService: NzModalService) {
    super();
  }

  get selectedPath(): string {
    return (this.formControl?.value as string) ?? "";
  }

  /** Model and version only — the row is narrow, and the full path is the tooltip. */
  get label(): string {
    const parts = this.selectedPath.split("/").filter(part => part.length > 0);
    // /models/ownerEmail/modelName/versionName
    return parts.length >= 4 ? `${parts[2]} · ${parts[3]}` : this.selectedPath || "Select model";
  }

  openModelPicker(): void {
    if (this.formControl?.disabled) return;

    const modal = this.modalService.create({
      nzTitle: "Select a model version",
      nzContent: ModelSelectionModalComponent,
      nzFooter: null,
      nzData: { selectedPath: this.selectedPath || null },
      // An explicit width: the picker's contents are flex-sized selects and an initially
      // empty file tree, so "fit-content" collapses the dialog to a few dozen pixels.
      nzWidth: 720,
      nzBodyStyle: { overflow: "auto", minHeight: "200px", maxHeight: "70vh" },
    });

    modal.afterClose.pipe(untilDestroyed(this)).subscribe((selectedPath?: string) => {
      if (!selectedPath) return;
      this.formControl.setValue(selectedPath);
      this.formControl.markAsDirty();
      this.formControl.markAsTouched();
    });
  }
}
