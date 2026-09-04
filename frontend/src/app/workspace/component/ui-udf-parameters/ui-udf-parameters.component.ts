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
import { NgFor, NgIf } from "@angular/common";
import { FieldArrayType, FormlyFieldConfig, FormlyModule } from "@ngx-formly/core";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NotificationService } from "../../../common/service/notification/notification.service";
import { WorkflowActionService } from "../../service/workflow-graph/model/workflow-action.service";
import {
  DATASET_INPUT_TYPE,
  MODEL_INPUT_TYPE,
  UiUdfParametersEditError,
  UiUdfParametersParseError,
} from "../../service/code-editor/ui-udf-parameters-parser.service";
import { UiUdfParametersSyncService } from "../../service/code-editor/ui-udf-parameters-sync.service";
import type { AttributeType } from "../../types/workflow-compiling.interface";

type UiUdfParameterColumn = Readonly<{ label: string; key: string; parentKey?: string; disabled: boolean }>;

const VALUE_COLUMN: UiUdfParameterColumn = { label: "Value", key: "value", disabled: false };
const TYPE_COLUMN: UiUdfParameterColumn = {
  label: "Type",
  key: "attributeType",
  parentKey: "attribute",
  disabled: true,
};

// A row that names a resource is edited by that resource's browser rather than a text box.
// A row without one keeps the default text editor, which is what an ordinary typed
// parameter wants.
const RESOURCE_VALUE_EDITOR = "resourcevalue";
const RESOURCE_INPUT_TYPES: ReadonlySet<string> = new Set([MODEL_INPUT_TYPE, DATASET_INPUT_TYPE]);

/** Renders inferred Python UDF UI parameters with editable values and locked name/type columns. */
@Component({
  selector: "texera-ui-udf-parameters",
  templateUrl: "./ui-udf-parameters.component.html",
  styleUrls: ["./ui-udf-parameters.component.scss"],
  imports: [
    NgIf,
    NgFor,
    FormlyModule,
    NzButtonComponent,
    NzWaveDirective,
    ɵNzTransitionPatchDirective,
    NzIconDirective,
  ],
})
export class UiUdfParametersComponent extends FieldArrayType<FormlyFieldConfig> {
  private readonly disabledStateConfigured = new WeakMap<FormlyFieldConfig, boolean>();

  readonly fieldColumns: UiUdfParameterColumn[] = [
    VALUE_COLUMN,
    { label: "Name", key: "attributeName", parentKey: "attribute", disabled: true },
    TYPE_COLUMN,
  ];

  readonly addParameterTypeOptions: AttributeType[] = ["string", "integer", "long", "double", "boolean", "timestamp"];
  draftVisible = false;

  constructor(
    private workflowActionService: WorkflowActionService,
    private uiUdfParametersSyncService: UiUdfParametersSyncService,
    private notificationService: NotificationService
  ) {
    super();
  }

  get workflowModificationEnabled(): boolean {
    return this.workflowActionService.checkWorkflowModificationEnabled();
  }

  /** Inserts the declaration into the operator's Python code; the row then appears through the normal code sync. */
  addParameter(nameInput: HTMLInputElement, attributeType: string): void {
    const operatorId = this.workflowActionService.getJointGraphWrapper().getCurrentHighlightedOperatorIDs()[0];
    try {
      this.uiUdfParametersSyncService.addParameter(operatorId, nameInput.value, attributeType as AttributeType);
      this.draftVisible = false;
    } catch (error) {
      if (!(error instanceof UiUdfParametersEditError) && !(error instanceof UiUdfParametersParseError)) throw error;
      this.notificationService.error(`Could not add UDF parameter: ${error.message}`);
    }
  }

  override onPopulate(field: FormlyFieldConfig): void {
    this.configureRowTemplate(this.getFieldArrayTemplate(field));
    super.onPopulate(field);
    // Row data comes from the array being populated rather than from rowField.model:
    // Formly has not bound the row models yet at this point.
    const rows = (this.model ?? []) as { inputType?: string }[];
    field.fieldGroup?.forEach((rowField, index) => {
      this.configureRowFields(rowField);
      this.configureResourceEditor(rowField, rows[index]);
    });
  }

  /**
   * Swaps a resource row's value editor for that resource's browser.
   *
   * Left alone for a row that names nothing, so an ordinary typed parameter keeps the
   * plain text box.
   */
  private configureResourceEditor(
    rowField: FormlyFieldConfig | undefined,
    row: { inputType?: string } | undefined
  ): void {
    if (!rowField) return;
    const valueField = this.getColumnField(rowField, VALUE_COLUMN);
    if (!valueField) return;

    const inputType = row?.inputType ?? (rowField.model as { inputType?: string } | undefined)?.inputType;
    if (!inputType || !RESOURCE_INPUT_TYPES.has(inputType)) return;

    valueField.type = RESOURCE_VALUE_EDITOR;
    // Which browser to open is the row's business, not the editor's.
    valueField.props = { ...(valueField.props ?? {}), resource: inputType };
  }

  /**
   * What the locked Type cell should read for a resource row, or undefined for an
   * ordinary one.
   *
   * A resource parameter's stored type is `string`, because a path is what the UDF
   * receives and `AttributeType` describes tuple data rather than where a value came
   * from. Showing `string` in the panel is accurate and useless: the row's value is
   * picked from a model or dataset browser, so the type the reader needs to see is the
   * resource kind. Both cells are derived from the code and locked, so this changes only
   * what is displayed -- the stored `attributeType` stays `string`.
   */
  resourceTypeLabel(parameter: { inputType?: string } | undefined): string | undefined {
    const inputType = parameter?.inputType;
    return inputType && RESOURCE_INPUT_TYPES.has(inputType) ? inputType : undefined;
  }

  isTypeColumn(column: UiUdfParameterColumn): boolean {
    return column === TYPE_COLUMN;
  }

  /** Finds the Formly field config that backs one visible column in a parameter row. */
  getColumnField(rowField: FormlyFieldConfig, column: UiUdfParameterColumn): FormlyFieldConfig | undefined {
    return this.getChildField(column.parentKey ? this.getChildField(rowField, column.parentKey) : rowField, column.key);
  }

  private getFieldArrayTemplate(field: FormlyFieldConfig): FormlyFieldConfig | undefined {
    return typeof field.fieldArray === "function" ? undefined : field.fieldArray;
  }

  private configureRowTemplate(rowField: FormlyFieldConfig | undefined): void {
    this.configureRowColumns(rowField, this.setDisabledMetadata.bind(this));
  }

  private configureRowFields(rowField: FormlyFieldConfig | undefined): void {
    this.configureRowColumns(rowField, this.configureDisabledState.bind(this));
  }

  private configureRowColumns(
    rowField: FormlyFieldConfig | undefined,
    configureColumn: (field: FormlyFieldConfig | undefined, disabled: boolean) => void
  ): void {
    if (!rowField) return;

    this.fieldColumns.forEach(column => configureColumn(this.getColumnField(rowField, column), column.disabled));
  }

  private getChildField(rowField: FormlyFieldConfig | undefined, key: string): FormlyFieldConfig | undefined {
    return rowField?.fieldGroup?.find(fieldConfig => fieldConfig.key === key);
  }

  /** Sets Formly disabled metadata and keeps controls created later in sync through an onInit hook. */
  private configureDisabledState(field: FormlyFieldConfig | undefined, disabled: boolean): void {
    if (!field) return;

    this.setDisabledMetadata(field, disabled);

    if (this.disabledStateConfigured.get(field) === disabled) {
      this.applyDisabledState(field, disabled);
      return;
    }

    const previousOnInit = field.hooks?.onInit;
    field.hooks = {
      ...(field.hooks ?? {}),
      onInit: initializedField => {
        previousOnInit?.(initializedField);
        this.applyDisabledState(initializedField, disabled);
      },
    };

    this.disabledStateConfigured.set(field, disabled);
    this.applyDisabledState(field, disabled);
  }

  private setDisabledMetadata(field: FormlyFieldConfig | undefined, disabled: boolean): void {
    if (!field) return;

    field.props = { ...(field.props ?? {}), disabled };

    // Keep deprecated templateOptions in sync for existing Formly wrappers that still read it.
    (field as any).templateOptions = { ...((field as any).templateOptions ?? {}), disabled };
  }

  private applyDisabledState(field: FormlyFieldConfig, disabled: boolean): void {
    if (disabled) field.formControl?.disable({ emitEvent: false });
    else field.formControl?.enable({ emitEvent: false });
  }

  trackByParameterName = (index: number, parameter: any): string | number => {
    return parameter?.attribute?.attributeName ?? index;
  };
}
