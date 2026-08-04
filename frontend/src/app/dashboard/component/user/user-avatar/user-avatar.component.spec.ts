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
import { UserAvatarComponent, sanitizeAvatarUrl } from "./user-avatar.component";
import { firstValueFrom } from "rxjs";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { NzAvatarModule } from "ng-zorro-antd/avatar";
import { UserService } from "../../../../common/service/user/user.service";
import { StubUserService } from "../../../../common/service/user/stub-user.service";
import { commonTestProviders } from "../../../../common/testing/test-utils";

describe("UserAvatarComponent", () => {
  let component: UserAvatarComponent;
  let fixture: ComponentFixture<UserAvatarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserAvatarComponent, HttpClientTestingModule, NzAvatarModule],
      providers: [{ provide: UserService, useClass: StubUserService }, ...commonTestProviders],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(UserAvatarComponent);
    component = fixture.componentInstance;
    component.userName = "fake Texera user";
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("renders an explicit avatarUrl in preference to a google avatar", async () => {
    component.googleAvatar = "some-google-id";
    component.avatarUrl = "https://example.com/claude.svg";
    component.ngOnChanges();
    expect(await firstValueFrom(component.avatarUrl$)).toEqual("https://example.com/claude.svg");
  });

  it("falls back to initials when the avatarUrl is not an image URL", async () => {
    // Awareness state comes from whatever joined the shared-editing room, so
    // the URL is untrusted input rather than something the app produced.
    component.avatarUrl = "javascript:alert(1)";
    component.ngOnChanges();
    expect(await firstValueFrom(component.avatarUrl$)).toBeUndefined();
  });

  describe("sanitizeAvatarUrl", () => {
    it("accepts inline images and https URLs", () => {
      expect(sanitizeAvatarUrl("data:image/svg+xml;base64,PHN2Zy8+")).toEqual("data:image/svg+xml;base64,PHN2Zy8+");
      expect(sanitizeAvatarUrl("https://example.com/a.png")).toEqual("https://example.com/a.png");
    });

    it("rejects anything else", () => {
      expect(sanitizeAvatarUrl("data:text/html,<script>")).toBeUndefined();
      expect(sanitizeAvatarUrl("file:///etc/passwd")).toBeUndefined();
      expect(sanitizeAvatarUrl("")).toBeUndefined();
    });
  });
});
