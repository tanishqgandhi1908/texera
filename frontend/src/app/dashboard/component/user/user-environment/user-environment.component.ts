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
import { FormsModule } from "@angular/forms";
import { DatePipe, NgFor, NgIf } from "@angular/common";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { timer } from "rxjs";
import { switchMap } from "rxjs/operators";

import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzCardComponent } from "ng-zorro-antd/card";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzInputDirective } from "ng-zorro-antd/input";
import { NzModalComponent, NzModalContentDirective, NzModalService } from "ng-zorro-antd/modal";
import { NzTagComponent } from "ng-zorro-antd/tag";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";

import { NotificationService } from "../../../../common/service/notification/notification.service";
import { Environment, EnvironmentService, EnvironmentStatus } from "../../../service/user/environment/environment.service";

/** Name rule, kept in step with EnvironmentResource's server-side check. */
export function validateEnvironmentName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.length > 128) {
    return "Name must start with a letter or digit and contain only letters, digits, dots, hyphens and underscores.";
  }
  return null;
}

const BUILD_POLL_INTERVAL_MS = 3000;

@UntilDestroy()
@Component({
  selector: "texera-user-environment",
  templateUrl: "./user-environment.component.html",
  styleUrls: ["./user-environment.component.scss"],
  imports: [
    NgIf,
    NgFor,
    DatePipe,
    FormsModule,
    NzButtonComponent,
    NzCardComponent,
    NzIconDirective,
    NzInputDirective,
    NzModalComponent,
    NzModalContentDirective,
    NzTagComponent,
    NzTooltipDirective,
  ],
  standalone: true,
})
export class UserEnvironmentComponent implements OnInit {
  environments: Environment[] = [];
  isLoading = false;

  editorVisible = false;
  editorTitle = "";
  /** Set when editing an existing environment; undefined when creating one. */
  editingEid?: number;
  draftName = "";
  draftDockerfile = "";
  isSaving = false;

  logsVisible = false;
  logsTitle = "";
  logsEid?: number;
  logsText = "";
  logsStatus?: EnvironmentStatus;
  isLoadingLogs = false;

  private defaultDockerfile = "";

  constructor(
    private environmentService: EnvironmentService,
    private notificationService: NotificationService,
    private modalService: NzModalService
  ) {}

  ngOnInit(): void {
    this.refresh();
    this.loadDefaultDockerfile();

    // A build runs on the cluster and finishes without telling anyone, so the list is
    // polled while one is in flight. It stops once nothing is building, rather than
    // polling forever on a page that is usually idle.
    timer(BUILD_POLL_INTERVAL_MS, BUILD_POLL_INTERVAL_MS)
      .pipe(
        switchMap(() => this.environmentService.list()),
        untilDestroyed(this)
      )
      .subscribe({
        next: environments => {
          if (this.anyBuilding(this.environments) || this.anyBuilding(environments)) {
            this.environments = environments;
            if (this.logsVisible && this.logsEid !== undefined) {
              this.loadLogs(this.logsEid, false);
            }
          }
        },
        error: () => {
          // A failed poll is not worth a toast; the next tick will try again.
        },
      });
  }

  private anyBuilding(environments: Environment[]): boolean {
    return environments.some(environment => environment.status === "BUILDING");
  }

  private loadDefaultDockerfile(): void {
    this.environmentService
      .getDefaultDockerfile()
      .pipe(untilDestroyed(this))
      .subscribe({
        next: response => (this.defaultDockerfile = response.dockerfile),
        error: () => {
          // Only affects what a new environment is pre-filled with, so an empty editor
          // is a survivable outcome and not worth interrupting the user for.
        },
      });
  }

  refresh(): void {
    this.isLoading = true;
    this.environmentService
      .list()
      .pipe(untilDestroyed(this))
      .subscribe({
        next: environments => {
          this.environments = environments;
          this.isLoading = false;
        },
        error: (error: unknown) => {
          this.isLoading = false;
          this.notificationService.error(`Could not load environments: ${this.messageOf(error)}`);
        },
      });
  }

  onClickNew(): void {
    this.editingEid = undefined;
    this.editorTitle = "New environment";
    this.draftName = "";
    // Pre-filled with the computing-unit image's own Dockerfile so the starting point is
    // what already exists, rather than a blank file the user has to guess the shape of.
    this.draftDockerfile = this.defaultDockerfile;
    this.editorVisible = true;
  }

  onClickEdit(environment: Environment): void {
    this.editingEid = environment.eid;
    this.editorTitle = `Edit ${environment.name}`;
    this.draftName = environment.name;
    this.draftDockerfile = environment.dockerfile;
    this.editorVisible = true;
  }

  onClickSave(): void {
    const name = this.draftName.trim();
    const nameError = validateEnvironmentName(name);
    if (nameError) {
      this.notificationService.error(nameError);
      return;
    }
    if (!this.draftDockerfile.trim()) {
      this.notificationService.error("Dockerfile cannot be empty.");
      return;
    }

    this.isSaving = true;
    const save =
      this.editingEid === undefined
        ? this.environmentService.create(name, this.draftDockerfile)
        : this.environmentService.update(this.editingEid, name, this.draftDockerfile);

    save.pipe(untilDestroyed(this)).subscribe({
      next: environment => {
        this.isSaving = false;
        this.editorVisible = false;
        this.notificationService.success(`Building '${environment.name}'. This takes a few minutes.`);
        this.refresh();
      },
      error: (error: unknown) => {
        this.isSaving = false;
        this.notificationService.error(`Could not save the environment: ${this.messageOf(error)}`);
      },
    });
  }

  onClickCancelEdit(): void {
    this.editorVisible = false;
  }

  onClickRebuild(environment: Environment): void {
    this.environmentService
      .rebuild(environment.eid)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success(`Rebuilding '${environment.name}'.`);
          this.refresh();
        },
        error: (error: unknown) =>
          this.notificationService.error(`Could not rebuild: ${this.messageOf(error)}`),
      });
  }

  onClickLogs(environment: Environment): void {
    this.logsEid = environment.eid;
    this.logsTitle = `Build log — ${environment.name}`;
    this.logsText = "";
    this.logsVisible = true;
    this.loadLogs(environment.eid, true);
  }

  private loadLogs(eid: number, showSpinner: boolean): void {
    if (showSpinner) {
      this.isLoadingLogs = true;
    }
    this.environmentService
      .logs(eid)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: response => {
          this.isLoadingLogs = false;
          this.logsText = response.log || "(no output yet)";
          this.logsStatus = response.status;
        },
        error: (error: unknown) => {
          this.isLoadingLogs = false;
          this.logsText = `Could not read the build log: ${this.messageOf(error)}`;
        },
      });
  }

  onClickCloseLogs(): void {
    this.logsVisible = false;
    this.logsEid = undefined;
  }

  onClickDelete(environment: Environment): void {
    this.modalService.confirm({
      nzTitle: `Delete '${environment.name}'?`,
      nzContent:
        "Computing units already started from this environment keep running; new ones cannot use it.",
      nzOkText: "Delete",
      nzOkDanger: true,
      nzOnOk: () =>
        this.environmentService
          .delete(environment.eid)
          .pipe(untilDestroyed(this))
          .subscribe({
            next: () => {
              this.notificationService.success(`Deleted '${environment.name}'.`);
              this.refresh();
            },
            error: (error: unknown) =>
              this.notificationService.error(`Could not delete: ${this.messageOf(error)}`),
          }),
    });
  }

  statusColor(status: EnvironmentStatus): string {
    switch (status) {
      case "READY":
        return "green";
      case "BUILDING":
        return "blue";
      case "FAILED":
        return "red";
      default:
        return "default";
    }
  }

  trackByEid(_index: number, environment: Environment): number {
    return environment.eid;
  }

  private messageOf(error: unknown): string {
    const body = (error as { error?: { message?: string } })?.error;
    return body?.message ?? (error as { message?: string })?.message ?? "unknown error";
  }
}
