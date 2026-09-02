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
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { FormsModule } from "@angular/forms";
import { NgIf, NgFor } from "@angular/common";
import { NzCardComponent } from "ng-zorro-antd/card";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzInputDirective } from "ng-zorro-antd/input";
import { NzTableModule } from "ng-zorro-antd/table";
import { NzTagComponent } from "ng-zorro-antd/tag";
import { NzModalModule } from "ng-zorro-antd/modal";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { NzPopconfirmDirective } from "ng-zorro-antd/popconfirm";
import { NzEmptyComponent } from "ng-zorro-antd/empty";
import { timer } from "rxjs";
import { switchMap } from "rxjs/operators";
import { CuImage, CuImageService, isInProgress } from "../../../service/admin/cu-image/cu-image.service";
import { NotificationService } from "../../../../common/service/notification/notification.service";
import { extractErrorMessage } from "../../../../common/util/error";

/** Fast enough to feel live while a mirror runs, slow enough not to hammer the API. */
const MIRROR_POLL_INTERVAL_MS = 3000;

@UntilDestroy()
@Component({
  selector: "texera-admin-cu-image",
  templateUrl: "./admin-cu-image.component.html",
  styleUrls: ["./admin-cu-image.component.scss"],
  imports: [
    FormsModule,
    NgIf,
    NgFor,
    NzCardComponent,
    NzButtonComponent,
    NzWaveDirective,
    ɵNzTransitionPatchDirective,
    NzIconDirective,
    NzInputDirective,
    NzTableModule,
    NzTagComponent,
    NzModalModule,
    NzTooltipDirective,
    NzPopconfirmDirective,
    NzEmptyComponent,
  ],
})
export class AdminCuImageComponent implements OnInit {
  images: CuImage[] = [];
  loading = false;

  // The two fields an administrator fills in: what users will see, and where to get it.
  newName = "";
  newSourceRef = "";
  submitting = false;

  logVisible = false;
  logIid?: number;
  logName = "";
  logText = "";

  constructor(
    private cuImageService: CuImageService,
    private notificationService: NotificationService
  ) {}

  ngOnInit(): void {
    this.load();

    // A mirror runs on the cluster and finishes without telling anyone, so the list is
    // polled while one is in flight. It stops once nothing is mirroring, rather than
    // polling forever on a page that is usually idle.
    timer(MIRROR_POLL_INTERVAL_MS, MIRROR_POLL_INTERVAL_MS)
      .pipe(
        switchMap(() => this.cuImageService.list()),
        untilDestroyed(this)
      )
      .subscribe({
        next: images => {
          if (this.anyInProgress(this.images) || this.anyInProgress(images)) {
            this.images = images;
            if (this.logVisible && this.logIid !== undefined) {
              this.loadLog(this.logIid, false);
            }
          }
        },
        error: () => {
          // A failed poll is not worth a toast; the next tick will try again.
        },
      });
  }

  private anyInProgress(images: CuImage[]): boolean {
    return images.some(isInProgress);
  }

  load(): void {
    this.loading = true;
    this.cuImageService
      .list()
      .pipe(untilDestroyed(this))
      .subscribe({
        next: images => {
          this.images = images;
          this.loading = false;
        },
        error: (err: unknown) => {
          this.loading = false;
          this.notificationService.error(`Could not load images: ${extractErrorMessage(err)}`);
        },
      });
  }

  add(): void {
    const name = this.newName.trim();
    const sourceRef = this.newSourceRef.trim();
    if (name === "" || sourceRef === "") {
      this.notificationService.error("Both a name and a Docker Hub link are required");
      return;
    }

    this.submitting = true;
    this.cuImageService
      .create(name, sourceRef)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: image => {
          this.submitting = false;
          this.newName = "";
          this.newSourceRef = "";
          // Prepended rather than reloaded so the new row, which is already mirroring,
          // is visible immediately and the poll takes over from here.
          this.images = [image, ...this.images];
          this.notificationService.success(`Mirroring ${image.name}`);
        },
        error: (err: unknown) => {
          this.submitting = false;
          this.notificationService.error(`Could not add the image: ${extractErrorMessage(err)}`);
        },
      });
  }

  refresh(image: CuImage): void {
    this.cuImageService
      .refresh(image.iid)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: updated => {
          this.images = this.images.map(i => (i.iid === updated.iid ? updated : i));
          this.notificationService.success(`Re-mirroring ${updated.name}`);
        },
        error: (err: unknown) => this.notificationService.error(`Could not refresh: ${extractErrorMessage(err)}`),
      });
  }

  delete(image: CuImage): void {
    this.cuImageService
      .delete(image.iid)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.images = this.images.filter(i => i.iid !== image.iid);
          this.notificationService.success(`Removed ${image.name}`);
        },
        error: (err: unknown) => this.notificationService.error(`Could not remove: ${extractErrorMessage(err)}`),
      });
  }

  showLog(image: CuImage): void {
    this.logIid = image.iid;
    this.logName = image.name;
    this.logVisible = true;
    this.logText = "";
    this.loadLog(image.iid, true);
  }

  closeLog(): void {
    this.logVisible = false;
    this.logIid = undefined;
  }

  /**
   * `report` is false when the poll refreshes an open log: a transient failure there
   * should not raise a toast over a dialog the administrator is already reading.
   */
  private loadLog(iid: number, report: boolean): void {
    this.cuImageService
      .log(iid)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: response => (this.logText = response.log),
        error: (err: unknown) => {
          if (report) {
            this.notificationService.error(`Could not load the log: ${extractErrorMessage(err)}`);
          }
        },
      });
  }

  statusColor(status: string): string {
    switch (status) {
      case "READY":
        return "green";
      case "FAILED":
        return "red";
      case "MIRRORING":
        return "blue";
      default:
        return "default";
    }
  }
}
