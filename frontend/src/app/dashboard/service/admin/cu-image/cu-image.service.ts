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

import { Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable } from "rxjs";
import { AppSettings } from "../../../../common/app-setting";

const CU_IMAGE_BASE_URL = `${AppSettings.getApiEndpoint()}/cu-image`;

export type CuImageStatus = "PENDING" | "MIRRORING" | "READY" | "FAILED";

export interface CuImage {
  iid: number;
  /** What users see in the computing-unit dropdown. */
  name: string;
  /** Where the image was mirrored from, as the administrator supplied it. */
  sourceRef: string;
  /** The digest sourceRef resolved to when last mirrored. Null until one succeeds. */
  sourceDigest: string | null;
  status: CuImageStatus;
  /** Where a computing unit pulls from. Null until a mirror succeeds. */
  imageTag: string | null;
  mirrorNumber: number;
  creationTime: number;
  updateTime: number;
}

export interface CuImageMirrorLog {
  iid: number;
  status: CuImageStatus;
  mirrorNumber: number;
  log: string;
}

/** Only a READY image can back a computing unit: the others have nothing to pull. */
export function isStartable(image: CuImage): boolean {
  return image.status === "READY";
}

/** Whether the mirror is still going, and so whether the list is worth polling. */
export function isInProgress(image: CuImage): boolean {
  return image.status === "PENDING" || image.status === "MIRRORING";
}

@Injectable({ providedIn: "root" })
export class CuImageService {
  constructor(private http: HttpClient) {}

  /**
   * Readable by any signed-in user, because the computing-unit dropdown is built from it.
   * Everything below is administrator-only.
   */
  list(): Observable<CuImage[]> {
    return this.http.get<CuImage[]>(CU_IMAGE_BASE_URL);
  }

  /** Registering an image starts its first mirror; the response is already MIRRORING. */
  create(name: string, sourceRef: string): Observable<CuImage> {
    return this.http.post<CuImage>(CU_IMAGE_BASE_URL, { name, sourceRef });
  }

  /**
   * Copies the source again. The reference is usually a tag, and a tag upstream can be
   * moved, so this is both how a change is picked up and how a failed mirror is retried.
   */
  refresh(iid: number): Observable<CuImage> {
    return this.http.post<CuImage>(`${CU_IMAGE_BASE_URL}/${iid}/refresh`, {});
  }

  /** The mirror's output, including why validation rejected an image. */
  log(iid: number): Observable<CuImageMirrorLog> {
    return this.http.get<CuImageMirrorLog>(`${CU_IMAGE_BASE_URL}/${iid}/log`);
  }

  delete(iid: number): Observable<void> {
    return this.http.delete<void>(`${CU_IMAGE_BASE_URL}/${iid}`);
  }
}
