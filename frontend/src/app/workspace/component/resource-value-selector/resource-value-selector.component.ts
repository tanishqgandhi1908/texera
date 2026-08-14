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

import { Component, Type } from "@angular/core";
import { FieldType, FieldTypeConfig } from "@ngx-formly/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { NzModalService } from "ng-zorro-antd/modal";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { ModelSelectionModalComponent } from "../model-selection-modal/model-selection-modal.component";
import { DatasetSelectionModalComponent } from "../dataset-selection-modal/dataset-selection-modal.component";
import { DATASET_INPUT_TYPE, MODEL_INPUT_TYPE } from "../../service/code-editor/ui-udf-parameters-parser.service";
import { ModelPveHintService } from "../../service/virtual-environment/model-pve-hint.service";

type ResourceBrowser = Readonly<{
  title: string;
  icon: string;
  emptyLabel: string;
  component: Type<unknown>;
  /** Extra nzData the browser needs beyond the currently selected path. */
  data?: Readonly<Record<string, unknown>>;
}>;

const BROWSERS: Readonly<Record<string, ResourceBrowser>> = {
  [MODEL_INPUT_TYPE]: {
    title: "Select a model version",
    icon: "experiment",
    emptyLabel: "Select model",
    component: ModelSelectionModalComponent,
  },
  [DATASET_INPUT_TYPE]: {
    title: "Select a dataset version",
    icon: "database",
    emptyLabel: "Select dataset",
    component: DatasetSelectionModalComponent,
    // fileMode false: a mount exposes the whole version, so the value is the version's
    // path rather than one file inside it.
    data: { fileMode: false },
  },
};

/**
 * Value editor for a Python UDF UI parameter declared as
 * `self.UiParameter("NAME", AttributeType.STRING, value=Resource.MODEL)`.
 *
 * The parameter is an ordinary string; what makes it special is where the string comes from.
 * The stored value is the chosen version's `/models/...` or `/datasets/...` path, picked from
 * that resource's browser rather than typed. What the UDF receives is the directory the version
 * is mounted at — the backend substitutes it, and mounts the version, when the workflow runs.
 */
@UntilDestroy()
@Component({
  selector: "texera-resource-value-selector",
  templateUrl: "./resource-value-selector.component.html",
  styleUrls: ["./resource-value-selector.component.scss"],
  imports: [NzButtonComponent, NzWaveDirective, ɵNzTransitionPatchDirective, NzIconDirective, NzTooltipDirective],
})
export class ResourceValueSelectorComponent extends FieldType<FieldTypeConfig> {
  constructor(
    private modalService: NzModalService,
    private modelPveHintService: ModelPveHintService
  ) {
    super();
  }

  /** Falls back to the model browser so a row is never left without an editor. */
  private get browser(): ResourceBrowser {
    const resource = (this.props as { resource?: string } | undefined)?.resource;
    return (resource && BROWSERS[resource]) || BROWSERS[MODEL_INPUT_TYPE];
  }

  get icon(): string {
    return this.browser.icon;
  }

  get tooltip(): string {
    return this.selectedPath || this.browser.title;
  }

  get selectedPath(): string {
    return (this.formControl?.value as string) ?? "";
  }

  /** Resource and version only — the row is narrow, and the full path is the tooltip. */
  get label(): string {
    const parts = this.selectedPath.split("/").filter(part => part.length > 0);
    // /<resource>/ownerEmail/name/versionName
    return parts.length >= 4 ? `${parts[2]} · ${parts[3]}` : this.selectedPath || this.browser.emptyLabel;
  }

  openPicker(): void {
    if (this.formControl?.disabled) return;
    const browser = this.browser;

    const modal = this.modalService.create({
      nzTitle: browser.title,
      nzContent: browser.component,
      nzFooter: null,
      nzData: { ...(browser.data ?? {}), selectedPath: this.selectedPath || null },
      // An explicit width: the pickers' contents are flex-sized selects and an initially
      // empty file tree, so "fit-content" collapses the dialog to a few dozen pixels.
      nzWidth: 720,
      nzBodyStyle: { overflow: "auto", minHeight: "200px", maxHeight: "70vh" },
    });

    modal.afterClose.pipe(untilDestroyed(this)).subscribe((selectedPath?: string) => {
      if (!selectedPath) return;
      this.formControl.setValue(selectedPath);
      this.formControl.markAsDirty();
      this.formControl.markAsTouched();

      const resource = (this.props as { resource?: string } | undefined)?.resource;
      if (resource === MODEL_INPUT_TYPE) {
        this.warnIfModelPveNotLoaded(selectedPath);
      }
    });
  }

  /**
   * A model carries a saved Python environment pinned to the framework version it was
   * trained against. Point that out when the selected computing unit does not have it —
   * loading it, and selecting it on this operator, is left to the user.
   */
  private warnIfModelPveNotLoaded(selectedPath: string): void {
    this.modelPveHintService
      .hintFor(selectedPath)
      .pipe(untilDestroyed(this))
      .subscribe(hint => {
        if (!hint) return;
        this.modalService.warning({
          nzTitle: `"${hint.modelName}" has a Python environment you have not loaded`,
          nzContent:
            `An environment named "${hint.pveName}" is saved with the package versions this model ` +
            `was trained against, but "${hint.computingUnitName}" does not have it installed. ` +
            `Without it the operator runs on the default Python environment, whose library versions ` +
            `may not match the model.\n\n` +
            `To use it: open the computing unit's Python Environments panel, load "${hint.pveName}", ` +
            `then set this operator's "Virtual Environment" to it.`,
          nzOkText: "Got it",
        });
      });
  }
}
