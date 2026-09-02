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

import { ComponentFixture, TestBed } from "@angular/core/testing";
import { HttpClientTestingModule, HttpTestingController } from "@angular/common/http/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { provideNzIconsTesting } from "ng-zorro-antd/icon/testing";
import { AdminCuImageComponent } from "./admin-cu-image.component";
import { CuImage } from "../../../service/admin/cu-image/cu-image.service";
import { NotificationService } from "../../../../common/service/notification/notification.service";
import { AppSettings } from "../../../../common/app-setting";

describe("AdminCuImageComponent", () => {
  let component: AdminCuImageComponent;
  let fixture: ComponentFixture<AdminCuImageComponent>;
  let httpTestingController: HttpTestingController;

  // Built the same way the service builds it: the configured base has no leading slash,
  // so hard-coding "/api/..." here would match nothing.
  const CU_IMAGE_URL = `${AppSettings.getApiEndpoint()}/cu-image`;

  const image = (over: Partial<CuImage> = {}): CuImage => ({
    iid: 1,
    name: "AlphaFold 3",
    sourceRef: "texera/cu-alphafold3:1.0",
    sourceDigest: null,
    status: "READY",
    imageTag: "10.96.0.99:5000/texera-cu/1:1",
    mirrorNumber: 1,
    creationTime: 0,
    updateTime: 0,
    ...over,
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminCuImageComponent, HttpClientTestingModule, NoopAnimationsModule],
      // Without this the nz-icons fetch their SVGs over HTTP, which the testing
      // controller then reports as unexpected open requests.
      providers: [NotificationService, provideNzIconsTesting()],
    }).compileComponents();
  });

  beforeEach(() => {
    httpTestingController = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminCuImageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("loads the image list on init", () => {
    const req = httpTestingController.expectOne(CU_IMAGE_URL);
    expect(req.request.method).toBe("GET");
    req.flush([image()]);

    expect(component.images.length).toBe(1);
    expect(component.loading).toBe(false);
  });

  it("posts both fields when adding, and prepends the row it gets back", () => {
    httpTestingController.expectOne(CU_IMAGE_URL).flush([image({ iid: 1, name: "Existing" })]);

    component.newName = "  AlphaFold 3  ";
    component.newSourceRef = "  texera/cu-alphafold3:1.0  ";
    component.add();

    const req = httpTestingController.expectOne(CU_IMAGE_URL);
    expect(req.request.method).toBe("POST");
    // Trimmed here rather than relying on the backend, since a stray space pasted with a
    // link would otherwise reach the mirror job.
    expect(req.request.body).toEqual({ name: "AlphaFold 3", sourceRef: "texera/cu-alphafold3:1.0" });
    req.flush(image({ iid: 2, name: "AlphaFold 3", status: "MIRRORING" }));

    expect(component.images[0].iid).toBe(2);
    expect(component.images.length).toBe(2);
    // Cleared so the form is ready for the next one rather than re-submitting this one.
    expect(component.newName).toBe("");
    expect(component.newSourceRef).toBe("");
  });

  it("refuses to submit when either field is empty", () => {
    httpTestingController.expectOne(CU_IMAGE_URL).flush([]);

    component.newName = "AlphaFold 3";
    component.newSourceRef = "   ";
    component.add();

    // No request at all: an empty field is caught before the round trip.
    httpTestingController.expectNone(CU_IMAGE_URL);
  });

  it("drops the row it removed without reloading the whole list", () => {
    httpTestingController.expectOne(CU_IMAGE_URL).flush([image({ iid: 1 }), image({ iid: 2 })]);

    component.delete(image({ iid: 1 }));
    const req = httpTestingController.expectOne(`${CU_IMAGE_URL}/1`);
    expect(req.request.method).toBe("DELETE");
    req.flush(null);

    expect(component.images.map(i => i.iid)).toEqual([2]);
  });

  it("replaces the refreshed row in place, so its new status shows", () => {
    httpTestingController.expectOne(CU_IMAGE_URL).flush([image({ iid: 1, status: "FAILED" })]);

    component.refresh(image({ iid: 1 }));
    const req = httpTestingController.expectOne(`${CU_IMAGE_URL}/1/refresh`);
    expect(req.request.method).toBe("POST");
    req.flush(image({ iid: 1, status: "MIRRORING", mirrorNumber: 2 }));

    expect(component.images[0].status).toBe("MIRRORING");
    expect(component.images[0].mirrorNumber).toBe(2);
  });

  it("fetches the log when the dialog opens", () => {
    httpTestingController.expectOne(CU_IMAGE_URL).flush([image()]);

    component.showLog(image({ iid: 1, name: "AlphaFold 3" }));
    expect(component.logVisible).toBe(true);

    const req = httpTestingController.expectOne(`${CU_IMAGE_URL}/1/log`);
    req.flush({ iid: 1, status: "READY", mirrorNumber: 1, log: "Mirrored" });

    expect(component.logText).toBe("Mirrored");
    expect(component.logName).toBe("AlphaFold 3");
  });

  // The status colour is the only signal in the table that a mirror went wrong, so a
  // failed image must not read as an ordinary one.
  it("colours each status distinctly", () => {
    httpTestingController.expectOne(CU_IMAGE_URL).flush([]);

    expect(component.statusColor("READY")).toBe("green");
    expect(component.statusColor("FAILED")).toBe("red");
    expect(component.statusColor("MIRRORING")).toBe("blue");
    expect(component.statusColor("PENDING")).toBe("default");
  });

  afterEach(() => {
    httpTestingController.verify();
  });
});
