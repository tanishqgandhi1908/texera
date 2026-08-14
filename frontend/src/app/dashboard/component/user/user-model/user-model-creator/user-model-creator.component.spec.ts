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

import { Component } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";
import { FieldType, FieldTypeConfig, FormlyModule } from "@ngx-formly/core";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { NzModalRef } from "ng-zorro-antd/modal";
import { Observable, of, throwError } from "rxjs";

import { sanitizeModelName, UserModelCreatorComponent } from "./user-model-creator.component";
import { MODEL_FORMATS, MODEL_FRAMEWORKS, ModelService } from "../../../../service/user/model/model.service";
import { NotificationService } from "../../../../../common/service/notification/notification.service";
import { WorkflowPveService } from "../../../../../workspace/service/virtual-environment/virtual-environment.service";
import { commonTestProviders } from "../../../../../common/testing/test-utils";

@Component({ template: "", standalone: true })
class StubFormlyFieldComponent extends FieldType<FieldTypeConfig> {}

describe("sanitizeModelName", () => {
  it("keeps underscores and hyphens, unlike the dataset sanitizer", () => {
    // MODEL_NAME_PATTERN allows _ and -, so collapsing them would reject valid names.
    expect(sanitizeModelName("churn_predictor-v2")).toBe("churn_predictor-v2");
  });

  it("lower-cases and replaces disallowed runs with a single hyphen", () => {
    expect(sanitizeModelName("My Model!!Name")).toBe("my-model-name");
  });

  it("trims leading whitespace", () => {
    expect(sanitizeModelName("   spaced")).toBe("spaced");
  });
});

describe("UserModelCreatorComponent", () => {
  let modalClose: ReturnType<typeof vi.fn>;
  let createModel: ReturnType<typeof vi.fn>;
  let notifySuccess: ReturnType<typeof vi.fn>;
  let notifyError: ReturnType<typeof vi.fn>;
  let userPves: Observable<unknown[]>;

  async function createFixture(): Promise<ComponentFixture<UserModelCreatorComponent>> {
    modalClose = vi.fn();
    createModel = vi.fn();
    notifySuccess = vi.fn();
    notifyError = vi.fn();
    userPves = of([]);

    await TestBed.configureTestingModule({
      imports: [
        UserModelCreatorComponent,
        BrowserAnimationsModule,
        FormsModule,
        ReactiveFormsModule,
        FormlyModule.forRoot({
          types: [
            { name: "input", component: StubFormlyFieldComponent },
            { name: "select", component: StubFormlyFieldComponent },
          ],
        }),
        HttpClientTestingModule,
      ],
      providers: [
        { provide: NzModalRef, useValue: { close: modalClose } },
        { provide: ModelService, useValue: { createModel } },
        { provide: NotificationService, useValue: { success: notifySuccess, error: notifyError } },
        { provide: WorkflowPveService, useValue: { listUserPves: () => userPves } },
        ...commonTestProviders,
      ],
    }).compileComponents();

    return TestBed.createComponent(UserModelCreatorComponent);
  }

  const environmentOptions = (fixture: ComponentFixture<UserModelCreatorComponent>) =>
    fixture.componentInstance.fields.find(f => f.key === "veid")?.templateOptions?.options as Array<{
      label: string;
      value: number | null;
    }>;

  it("renders the six create fields, with no version-description field", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();

    // Create-only: the dataset creator's dual-purpose version branch is deliberately not forked.
    expect(fixture.componentInstance.fields.map(f => f.key)).toEqual([
      "name",
      "description",
      "framework",
      "frameworkVersion",
      "format",
      "veid",
    ]);
    expect(fixture.componentInstance.form.contains("name")).toBe(true);
  });

  it("offers exactly the framework and format values the backend accepts", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const optionsFor = (key: string) =>
      (
        fixture.componentInstance.fields.find(f => f.key === key)?.templateOptions?.options as Array<{ value: string }>
      ).map(o => o.value);

    // A drift here becomes a 400 from ModelResource's whitelist at create time.
    expect(optionsFor("framework")).toEqual([...MODEL_FRAMEWORKS]);
    expect(optionsFor("format")).toEqual([...MODEL_FORMATS]);
  });

  it("does nothing when the required name is empty", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();

    fixture.componentInstance.onClickCreate();

    expect(createModel).not.toHaveBeenCalled();
    expect(modalClose).not.toHaveBeenCalled();
  });

  it("creates the model with the sanitized name and the toggle values", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    createModel.mockReturnValue(of({ model: { mid: 9 } }));

    component.form.get("name")?.setValue("churn_predictor");
    component.form.get("description")?.setValue("tabular");
    component.form.get("framework")?.setValue("sklearn");
    component.form.get("format")?.setValue("joblib");
    component.onPublicStatusChange(true);
    component.onDownloadableStatusChange(true);

    component.onClickCreate();

    expect(createModel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "churn_predictor",
        description: "tabular",
        framework: "sklearn",
        format: "joblib",
        isPublic: true,
        isDownloadable: true,
      })
    );
    expect(notifySuccess).toHaveBeenCalledWith("Model 'churn_predictor' created successfully.");
    expect(modalClose).toHaveBeenCalledWith({ model: { mid: 9 } });
  });

  it("offers the user's saved environments alongside the skip choice", async () => {
    const fixture = await createFixture();
    userPves = of([{ veid: 4, name: "sklearn-15", packages: {} }]);
    fixture.detectChanges();

    // Skip is first, so the default is always the least surprising one.
    expect(environmentOptions(fixture)).toEqual([
      { label: "Skip — use the default libraries", value: null },
      { label: "sklearn-15", value: 4 },
    ]);
    expect(fixture.componentInstance.form.get("veid")?.value).toBeNull();
  });

  // Saved environments are served by a computing unit; with none running they cannot be
  // listed, and that must not stand in the way of creating a model.
  it("falls back to the skip choice alone when the environments cannot be listed", async () => {
    const fixture = await createFixture();
    userPves = throwError(() => new Error("no computing unit"));
    fixture.detectChanges();

    expect(environmentOptions(fixture)).toEqual([{ label: "Skip — use the default libraries", value: null }]);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("sends the chosen environment", async () => {
    const fixture = await createFixture();
    userPves = of([{ veid: 4, name: "sklearn-15", packages: {} }]);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    createModel.mockReturnValue(of({ model: { mid: 13 } }));

    component.form.get("name")?.setValue("churn-clf");
    component.form.get("veid")?.setValue(4);

    component.onClickCreate();

    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ veid: 4 }));
  });

  it("sends no environment when the choice is skipped", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    createModel.mockReturnValue(of({ model: { mid: 14 } }));

    component.form.get("name")?.setValue("churn-clf");

    component.onClickCreate();

    // undefined rather than null: the field is simply absent from the request body.
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ veid: undefined }));
  });

  it("sends the framework version, which is recorded as metadata", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    createModel.mockReturnValue(of({ model: { mid: 11 } }));

    component.form.get("name")?.setValue("churn-clf");
    component.form.get("framework")?.setValue("sklearn");
    component.form.get("frameworkVersion")?.setValue(" 1.5.0 ");
    component.form.get("format")?.setValue("joblib");

    component.onClickCreate();

    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ frameworkVersion: "1.5.0" }));
  });

  it("sends no framework version when the field is left blank", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    createModel.mockReturnValue(of({ model: { mid: 12 } }));

    component.form.get("name")?.setValue("churn-clf");
    component.form.get("framework")?.setValue("sklearn");
    component.form.get("format")?.setValue("joblib");

    component.onClickCreate();

    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ frameworkVersion: undefined }));
  });

  it("hides the version field for a framework that names no library", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const component = fixture.componentInstance;

    const versionField = component.fields.find(f => f.key === "frameworkVersion");
    const hide = versionField?.expressions?.hide as (field: { model: { framework: string } }) => boolean;

    // "other" names no library, so there would be nothing for a version to be a version of.
    expect(hide({ model: { framework: "other" } })).toBe(true);
    expect(hide({ model: { framework: "sklearn" } })).toBe(false);
    expect(hide({ model: { framework: "pytorch" } })).toBe(false);
  });

  it("reports the rename when the entered name had to be sanitized", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    createModel.mockReturnValue(of({ model: { mid: 3 } }));

    component.form.get("name")?.setValue("My Model");
    component.onClickCreate();

    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ name: "my-model" }));
    expect(notifySuccess).toHaveBeenCalledWith(
      "Model 'My Model' was sanitized to 'my-model' and created successfully."
    );
  });

  it("surfaces the server message and closes with null when creation fails", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    createModel.mockReturnValue(throwError(() => ({ error: { message: "name already taken" } })));

    component.form.get("name")?.setValue("dupe");
    component.onClickCreate();

    expect(notifyError).toHaveBeenCalledWith("Model dupe creation failed: name already taken");
    expect(modalClose).toHaveBeenCalledWith(null);
    expect(component.isCreating).toBe(false);
  });

  it("closes with null on cancel without calling the backend", async () => {
    const fixture = await createFixture();
    fixture.detectChanges();

    fixture.componentInstance.onClickCancel();

    expect(modalClose).toHaveBeenCalledWith(null);
    expect(createModel).not.toHaveBeenCalled();
  });
});
