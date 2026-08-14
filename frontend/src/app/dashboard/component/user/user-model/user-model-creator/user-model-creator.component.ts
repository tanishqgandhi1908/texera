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

import { Component, OnInit } from "@angular/core";
import { AbstractControl, FormGroup, FormsModule } from "@angular/forms";
import { FormlyFieldConfig, FormlyModule } from "@ngx-formly/core";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { HttpErrorResponse } from "@angular/common/http";
import { NzModalRef } from "ng-zorro-antd/modal";
import { NzSpinComponent } from "ng-zorro-antd/spin";
import { NgClass } from "@angular/common";
import { NzSwitchComponent } from "ng-zorro-antd/switch";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";

import {
  MODEL_FORMATS,
  MODEL_FRAMEWORKS,
  MODEL_FRAMEWORKS_WITH_VERSION,
  ModelService,
  validateFrameworkVersion,
} from "../../../../service/user/model/model.service";
import { Model } from "../../../../../common/type/model";
import { NotificationService } from "../../../../../common/service/notification/notification.service";
import { WorkflowPveService } from "../../../../../workspace/service/virtual-environment/virtual-environment.service";

/** The "skip" choice: no environment, so the engine's default libraries. */
const SKIP_ENVIRONMENT = null;

export function sanitizeModelName(name: string): string {
  return name
    .trimStart()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .toLowerCase();
}

@UntilDestroy()
@Component({
  selector: "texera-user-model-creator",
  templateUrl: "./user-model-creator.component.html",
  styleUrls: ["./user-model-creator.component.scss"],
  imports: [
    NzSpinComponent,
    NgClass,
    FormlyModule,
    NzSwitchComponent,
    FormsModule,
    NzButtonComponent,
    NzWaveDirective,
    ɵNzTransitionPatchDirective,
  ],
})
export class UserModelCreatorComponent implements OnInit {
  public form: FormGroup = new FormGroup({});
  formModel: any = {};
  fields: FormlyFieldConfig[] = [];

  isModelPublic: boolean = false;
  isModelDownloadable: boolean = false;
  isModelNameSanitized: boolean = false;
  isCreating: boolean = false;

  constructor(
    private modalRef: NzModalRef,
    private modelService: ModelService,
    private notificationService: NotificationService,
    private workflowPveService: WorkflowPveService
  ) {}

  ngOnInit() {
    this.setFormFields();
    this.isModelNameSanitized = false;
    this.loadEnvironments();
  }

  /**
   * Fills the environment picker with the environments the user has saved.
   *
   * Saved environments are served by a computing unit, so with none running the list
   * cannot be fetched. That is not an error worth interrupting model creation over — the
   * picker keeps only its "skip" choice and says why, and the model can be pointed at an
   * environment later from its detail page.
   */
  private loadEnvironments(): void {
    this.workflowPveService
      .listUserPves()
      .pipe(untilDestroyed(this))
      .subscribe({
        next: records => this.setEnvironmentOptions(records.map(r => ({ label: r.name, value: r.veid }))),
        error: () =>
          this.setEnvironmentOptions(
            [],
            "Your saved environments could not be listed — a computing unit has to be running to read them. You can set this later from the model's page."
          ),
      });
  }

  private setEnvironmentOptions(options: { label: string; value: number }[], unavailableReason?: string): void {
    const field = this.fields.find(f => f.key === "veid");
    if (!field?.templateOptions) return;
    field.templateOptions.options = [
      { label: "Skip — use the default libraries", value: SKIP_ENVIRONMENT },
      ...options,
    ];
    field.templateOptions.description =
      unavailableReason ??
      (options.length === 0
        ? "You have no saved Python environments yet. The model will load under the engine's default libraries."
        : "The environment a Python UDF should load this model in. Skip to use the engine's default libraries.");
    // Formly renders from a copy of the array, so replace it to make the change visible.
    this.fields = [...this.fields];
  }

  private setFormFields() {
    this.fields = [
      {
        key: "name",
        type: "input",
        templateOptions: {
          label: "Name",
          required: true,
        },
      },
      {
        key: "description",
        type: "input",
        defaultValue: "",
        templateOptions: {
          label: "Description",
        },
      },
      // Options mirror ModelResource's whitelists, which reject anything else with a 400.
      {
        key: "framework",
        type: "select",
        defaultValue: MODEL_FRAMEWORKS[0],
        templateOptions: {
          label: "Framework",
          required: true,
          options: MODEL_FRAMEWORKS.map(value => ({ label: value, value })),
        },
      },
      // Free text rather than a list: library releases move faster than this code does.
      // Hidden for a framework that names no library, since there would be nothing for a
      // version to be a version of.
      {
        key: "frameworkVersion",
        type: "input",
        defaultValue: "",
        templateOptions: {
          label: "Framework version",
          placeholder: "e.g. 1.5.0",
          description: "The version the model was trained against, so whoever runs it knows what it needs.",
        },
        expressions: {
          hide: (field: FormlyFieldConfig) => !MODEL_FRAMEWORKS_WITH_VERSION.has(field.model?.framework),
        },
        validators: {
          version: {
            // Trim first, so that what is validated is what onClickCreate would send.
            expression: (control: AbstractControl) => {
              const value = ((control.value as string) ?? "").trim();
              return !value || validateFrameworkVersion(value) === null;
            },
            message: () => "Invalid version: expected something like 1.5.0 or 2.13.0+cpu",
          },
        },
      },
      {
        key: "format",
        type: "select",
        defaultValue: MODEL_FORMATS[0],
        templateOptions: {
          label: "Format",
          required: true,
          options: MODEL_FORMATS.map(value => ({ label: value, value })),
        },
      },
      // Populated by loadEnvironments once the user's saved environments arrive. Starts as
      // "skip" alone so the form is complete and submittable even if they never do.
      {
        key: "veid",
        type: "select",
        defaultValue: SKIP_ENVIRONMENT,
        templateOptions: {
          label: "Python environment",
          options: [{ label: "Skip — use the default libraries", value: SKIP_ENVIRONMENT }],
          description: "The environment a Python UDF should load this model in.",
        },
      },
    ];
  }

  private triggerValidation() {
    Object.keys(this.form.controls).forEach(field => {
      this.form.get(field)?.markAsTouched({ onlySelf: true });
    });
  }

  onClickCancel() {
    this.modalRef.close(null);
  }

  onClickCreate() {
    this.triggerValidation();

    if (!this.form.valid) {
      return;
    }

    const originalName = this.form.get("name")?.value as string;
    const sanitizedName = sanitizeModelName(originalName);
    this.isModelNameSanitized = sanitizedName !== originalName;

    const model: Model = {
      name: sanitizedName,
      description: this.form.get("description")?.value ?? "",
      framework: this.form.get("framework")?.value,
      format: this.form.get("format")?.value,
      // Blank means "unspecified"; the server stores null.
      frameworkVersion: (this.form.get("frameworkVersion")?.value as string)?.trim() || undefined,
      // Null is the "skip" choice, which the server stores as no environment at all.
      veid: (this.form.get("veid")?.value as number | null) ?? undefined,
      isPublic: this.isModelPublic,
      isDownloadable: this.isModelDownloadable,
      mid: undefined,
      ownerUid: undefined,
      repositoryName: undefined,
      creationTime: undefined,
      coverImage: undefined,
    };

    this.isCreating = true;
    this.modelService
      .createModel(model)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: res => {
          const msg = this.isModelNameSanitized
            ? `Model '${originalName}' was sanitized to '${sanitizedName}' and created successfully.`
            : `Model '${sanitizedName}' created successfully.`;
          this.notificationService.success(msg);
          this.isCreating = false;
          this.modalRef.close(res);
        },
        error: (res: unknown) => {
          const err = res as HttpErrorResponse;
          this.notificationService.error(`Model ${sanitizedName} creation failed: ${err.error?.message}`);
          this.isCreating = false;
          this.modalRef.close(null);
        },
      });
  }

  onPublicStatusChange(newValue: boolean): void {
    this.isModelPublic = newValue;
  }

  onDownloadableStatusChange(newValue: boolean): void {
    this.isModelDownloadable = newValue;
  }
}
