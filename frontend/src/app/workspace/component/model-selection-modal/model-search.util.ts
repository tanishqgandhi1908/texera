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

import { NzSelectItemInterface } from "ng-zorro-antd/select";
import { DashboardModel } from "../../../dashboard/type/dashboard-model.interface";

/**
 * Whether a model matches a type-to-search query in the model picker.
 *
 * Matches against both the model name and its id as displayed in the dropdown (`#<id>`),
 * case-insensitively, so typing `resnet`, `17`, or `#17` finds `#17 resnet`. An
 * empty/whitespace query matches everything.
 */
export function modelMatchesQuery(
  name: string | null | undefined,
  mid: number | null | undefined,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return true;
  }
  const nameMatches = (name ?? "").toLowerCase().includes(q);
  const idMatches = mid !== null && mid !== undefined && `#${mid}`.includes(q);
  return nameMatches || idMatches;
}

/**
 * ng-zorro `nzFilterOption` adapter for the model dropdown: pulls the model off the
 * option's value and matches the typed query against its name and #id via
 * {@link modelMatchesQuery}. Safe when the option has no value.
 */
export function filterModelOption(input: string, option: NzSelectItemInterface): boolean {
  const model = option.nzValue as DashboardModel | undefined;
  return modelMatchesQuery(model?.model?.name, model?.model?.mid, input ?? "");
}
