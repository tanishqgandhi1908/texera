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

import { Injectable } from "@angular/core";
import { HttpClient, HttpParams } from "@angular/common/http";
import { Observable } from "rxjs";
import { map, switchMap } from "rxjs/operators";
import { AppSettings } from "../../../../common/app-setting";
import { Model, ModelVersion } from "../../../../common/type/model";
import { DatasetFileNode } from "../../../../common/type/datasetVersionFileTree";
import { DatasetStagedObject } from "../../../../common/type/dataset-staged-object";
import { DashboardModel } from "../../../type/dashboard-model.interface";
import { MultipartUploadProgress, MultipartUploadService } from "../file-resource/multipart-upload.service";
import { MODEL_FILE_RESOURCE_ENDPOINT } from "../file-resource/file-resource-endpoint";

export const MODEL_BASE_URL = "model";
export const MODEL_CREATE_URL = MODEL_BASE_URL + "/create";
export const MODEL_UPDATE_BASE_URL = MODEL_BASE_URL + "/update";
export const MODEL_UPDATE_NAME_URL = MODEL_UPDATE_BASE_URL + "/name";
export const MODEL_UPDATE_DESCRIPTION_URL = MODEL_UPDATE_BASE_URL + "/description";
export const MODEL_UPDATE_PUBLICITY_URL = "update/publicity";
export const MODEL_UPDATE_DOWNLOADABLE_URL = "update/downloadable";
export const MODEL_LIST_URL = MODEL_BASE_URL + "/list";
export const MODEL_GET_OWNERS_URL = MODEL_BASE_URL + "/user-model-owners";

export const MODEL_VERSION_BASE_URL = "version";
export const MODEL_VERSION_RETRIEVE_LIST_URL = MODEL_VERSION_BASE_URL + "/list";
export const MODEL_PUBLIC_VERSION_BASE_URL = "publicVersion";
export const MODEL_PUBLIC_VERSION_RETRIEVE_LIST_URL = MODEL_PUBLIC_VERSION_BASE_URL + "/list";
export const MODEL_VERSION_LATEST_URL = MODEL_VERSION_BASE_URL + "/latest";

export const DEFAULT_MODEL_NAME = "Untitled-model";

export const MODEL_NAME_MAX_LENGTH = 128;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export const MODEL_FRAMEWORKS = ["pytorch", "tensorflow", "onnx", "sklearn"] as const;
export const MODEL_FORMATS = [
  "torchscript",
  "state-dict",
  "safetensors",
  "onnx",
  "savedmodel",
  "joblib",
  "pickle",
] as const;

export function validateModelName(name: string): string | null {
  if (!MODEL_NAME_PATTERN.test(name) || name.length > MODEL_NAME_MAX_LENGTH) {
    return "Invalid model name: only letters, numbers, underscores, and hyphens are allowed (max 128 characters)";
  }
  return null;
}

@Injectable({
  providedIn: "root",
})
export class ModelService {
  constructor(
    private http: HttpClient,
    private multipartUploadService: MultipartUploadService
  ) {}

  public createModel(model: Model): Observable<DashboardModel> {
    return this.http.post<DashboardModel>(`${AppSettings.getApiEndpoint()}/${MODEL_CREATE_URL}`, {
      modelName: model.name,
      modelDescription: model.description,
      isModelPublic: model.isPublic,
      isModelDownloadable: model.isDownloadable,
      framework: model.framework,
      format: model.format,
    });
  }

  public getModel(mid: number, isLogin: boolean = true): Observable<DashboardModel> {
    const apiUrl = isLogin
      ? `${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}`
      : `${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/public/${mid}`;
    return this.http.get<DashboardModel>(apiUrl);
  }

  public retrieveAccessibleModels(): Observable<DashboardModel[]> {
    return this.http.get<DashboardModel[]>(`${AppSettings.getApiEndpoint()}/${MODEL_LIST_URL}`);
  }

  public deleteModel(mid: number): Observable<Response> {
    return this.http.delete<Response>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}`);
  }

  public updateModelName(mid: number, name: string): Observable<Response> {
    return this.http.post<Response>(`${AppSettings.getApiEndpoint()}/${MODEL_UPDATE_NAME_URL}`, {
      mid: mid,
      name: name,
    });
  }

  public updateModelDescription(mid: number, description: string): Observable<Response> {
    return this.http.post<Response>(`${AppSettings.getApiEndpoint()}/${MODEL_UPDATE_DESCRIPTION_URL}`, {
      mid: mid,
      description: description,
    });
  }

  public updateModelPublicity(mid: number): Observable<Response> {
    return this.http.post<Response>(
      `${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/${MODEL_UPDATE_PUBLICITY_URL}`,
      {}
    );
  }

  public updateModelDownloadable(mid: number): Observable<Response> {
    return this.http.post<Response>(
      `${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/${MODEL_UPDATE_DOWNLOADABLE_URL}`,
      {}
    );
  }

  public retrieveOwners(): Observable<string[]> {
    return this.http.get<string[]>(`${AppSettings.getApiEndpoint()}/${MODEL_GET_OWNERS_URL}`);
  }

  public updateModelCoverImage(mid: number, coverImage: string): Observable<Response> {
    return this.http.post<Response>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/update/cover`, {
      coverImage: coverImage,
    });
  }

  public getModelCoverUrl(mid: number): Observable<{ url: string | null }> {
    return this.http.get<{ url: string | null }>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/cover-url`);
  }

  public createModelVersion(mid: number, newVersion: string): Observable<ModelVersion> {
    return this.http
      .post<{
        modelVersion: ModelVersion;
        fileNodes: DatasetFileNode[];
      }>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/version/create`, newVersion, {
        headers: { "Content-Type": "text/plain" },
      })
      .pipe(
        map(response => {
          response.modelVersion.fileNodes = response.fileNodes;
          return response.modelVersion;
        })
      );
  }

  /** Staged (uncommitted) changes for a model. */
  public getModelDiff(mid: number): Observable<DatasetStagedObject[]> {
    return this.http.get<DatasetStagedObject[]>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/diff`);
  }

  /** Discards one staged change. */
  public resetModelFileDiff(mid: number, filePath: string): Observable<Response> {
    const params = new HttpParams().set("filePath", encodeURIComponent(filePath));

    return this.http.put<Response>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/diff`, {}, { params });
  }

  /** Stages the removal of a committed file; applied when the next version is created. */
  public deleteModelFile(mid: number, filePath: string): Observable<Response> {
    const params = new HttpParams().set("filePath", encodeURIComponent(filePath));

    return this.http.delete<Response>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/file`, { params });
  }

  // ─── multipart upload, over the shared engine ───────────────────────────────

  public multipartUpload(
    ownerEmail: string,
    modelName: string,
    filePath: string,
    file: File,
    partSize: number,
    concurrencyLimit: number,
    restart: boolean
  ): Observable<MultipartUploadProgress> {
    return this.multipartUploadService.multipartUpload(
      MODEL_FILE_RESOURCE_ENDPOINT,
      ownerEmail,
      modelName,
      filePath,
      file,
      partSize,
      concurrencyLimit,
      restart
    );
  }

  public finalizeMultipartUpload(
    ownerEmail: string,
    modelName: string,
    filePath: string,
    isAbort: boolean
  ): Observable<Response> {
    return this.multipartUploadService.finalizeMultipartUpload(
      MODEL_FILE_RESOURCE_ENDPOINT,
      ownerEmail,
      modelName,
      filePath,
      isAbort
    );
  }

  /** Retrieve a model's versions, newest first; anonymous callers get the public-only endpoint. */
  public retrieveModelVersionList(mid: number, isLogin: boolean = true): Observable<ModelVersion[]> {
    const listUrl = isLogin ? MODEL_VERSION_RETRIEVE_LIST_URL : MODEL_PUBLIC_VERSION_RETRIEVE_LIST_URL;
    return this.http.get<ModelVersion[]>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/${listUrl}`);
  }

  public retrieveModelLatestVersion(mid: number): Observable<ModelVersion> {
    return this.http
      .get<{
        modelVersion: ModelVersion;
        fileNodes: DatasetFileNode[];
      }>(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/${MODEL_VERSION_LATEST_URL}`)
      .pipe(
        map(response => {
          response.modelVersion.fileNodes = response.fileNodes;
          return response.modelVersion;
        })
      );
  }

  public retrieveModelVersionFileTree(
    mid: number,
    mvid: number,
    isLogin: boolean = true
  ): Observable<{ fileNodes: DatasetFileNode[]; size: number }> {
    const versionSegment = isLogin ? MODEL_VERSION_BASE_URL : MODEL_PUBLIC_VERSION_BASE_URL;
    return this.http.get<{ fileNodes: DatasetFileNode[]; size: number }>(
      `${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/${versionSegment}/${mvid}/rootFileNodes`
    );
  }

  /**
   * Retrieve a model version as a zip. The backend requires exactly one of mvid or latest.
   */
  public retrieveModelVersionZip(mid: number, mvid?: number): Observable<Blob> {
    let params = new HttpParams();

    if (mvid !== undefined && mvid !== null) {
      params = params.set("mvid", mvid.toString());
    } else {
      params = params.set("latest", "true");
    }

    return this.http.get(`${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${mid}/versionZip`, {
      params,
      responseType: "blob",
    });
  }

  /**
   * Retrieve a single file from a model version through a presigned URL.
   *
   * @param filePath Logical path of the file, e.g. "/models/bob@texera.com/resnet/v1/model.pt".
   */
  public retrieveModelVersionSingleFile(filePath: string, isLogin: boolean = true): Observable<Blob> {
    const endpointSegment = isLogin ? "presign-download" : "public-presign-download";
    const endpoint = `${AppSettings.getApiEndpoint()}/${MODEL_BASE_URL}/${endpointSegment}?filePath=${encodeURIComponent(filePath)}`;

    return this.http
      .get<{ presignedUrl: string }>(endpoint)
      .pipe(switchMap(({ presignedUrl }) => this.http.get(presignedUrl, { responseType: "blob" })));
  }
}
