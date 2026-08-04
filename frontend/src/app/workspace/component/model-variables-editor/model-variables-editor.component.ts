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

import { Component, OnInit } from "@angular/core";
import { FieldType, FieldTypeConfig } from "@ngx-formly/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { NgFor, NgIf } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { NzModalService } from "ng-zorro-antd/modal";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzInputDirective } from "ng-zorro-antd/input";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { ModelSelectionModalComponent } from "../model-selection-modal/model-selection-modal.component";

interface ModelVariableRow {
  variableName: string;
  modelPath: string;
}

/**
 * Property-editor widget for the Python UDF "Model variables" property. Each row
 * binds a Python variable to a model version, chosen from everything this account can
 * read; at run time the variable holds that model's local path inside the computing unit.
 *
 * Choosing a model is all the user does. The engine mounts whatever a UDF names when the
 * worker starts (`ModelMountManager.ensureMounted`), so there is no separate step to
 * perform and nothing to keep in sync — an earlier version of this widget listed only
 * models already mounted on the active computing unit, which made a run's success depend
 * on remembering to mount first.
 */
@UntilDestroy()
@Component({
  templateUrl: "model-variables-editor.component.html",
  styleUrls: ["model-variables-editor.component.scss"],
  imports: [
    NgFor,
    NgIf,
    FormsModule,
    NzButtonComponent,
    NzWaveDirective,
    ɵNzTransitionPatchDirective,
    NzInputDirective,
    NzIconDirective,
    NzTooltipDirective,
  ],
})
export class ModelVariablesEditorComponent extends FieldType<FieldTypeConfig> implements OnInit {
  rows: ModelVariableRow[] = [];

  constructor(private modalService: NzModalService) {
    super();
  }

  ngOnInit(): void {
    const value = this.formControl.value;
    this.rows = Array.isArray(value)
      ? value.map((row: Partial<ModelVariableRow>) => ({
          variableName: row?.variableName ?? "",
          modelPath: row?.modelPath ?? "",
        }))
      : [];
  }

  /** Opens the model/version picker and stores the chosen version's logical path. */
  openModelPicker(index: number): void {
    const modal = this.modalService.create({
      nzContent: ModelSelectionModalComponent,
      nzFooter: null,
      nzData: { selectedPath: this.rows[index]?.modelPath || null },
      nzBodyStyle: {
        resize: "both",
        overflow: "auto",
        minHeight: "200px",
        minWidth: "550px",
        maxWidth: "90vw",
        maxHeight: "80vh",
      },
      nzWidth: "fit-content",
    });
    modal.afterClose.pipe(untilDestroyed(this)).subscribe((selectedPath?: string) => {
      if (!selectedPath) return;
      this.rows = this.rows.map((row, rowIndex) => (rowIndex === index ? { ...row, modelPath: selectedPath } : row));
      this.sync();
    });
  }

  /** The model and version, for a label that fits — the full path is the tooltip. */
  describePath(modelPath: string): string {
    const parts = modelPath.split("/").filter(part => part.length > 0);
    // /models/ownerEmail/modelName/versionName
    return parts.length >= 4 ? `${parts[2]} · ${parts[3]}` : modelPath;
  }

  addRow(): void {
    this.rows = [...this.rows, { variableName: "", modelPath: "" }];
    this.sync();
  }

  removeRow(index: number): void {
    this.rows = this.rows.filter((_, rowIndex) => rowIndex !== index);
    this.sync();
  }

  onRowChange(): void {
    this.sync();
  }

  trackByIndex(index: number): number {
    return index;
  }

  private sync(): void {
    this.formControl.setValue(this.rows.map(row => ({ ...row })));
    this.formControl.markAsDirty();
    this.formControl.markAsTouched();
  }
}
