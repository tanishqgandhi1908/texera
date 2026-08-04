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

/** Where a model file lives, as the logical path a UDF resolves. */
export interface ModelSnippetContext {
  ownerEmail: string;
  modelName: string;
  versionName: string;
  /** Path of the chosen file relative to the version root, e.g. "weights/model.pt". */
  fileRelativePath: string;
  framework: string | undefined;
  format: string | undefined;
}

/** Logical path of a model file: /models/ownerEmail/modelName/versionName/relativePath */
export function modelLogicalPath(ctx: ModelSnippetContext): string {
  const relative = ctx.fileRelativePath.replace(/^\/+/, "");
  return `/models/${ctx.ownerEmail}/${ctx.modelName}/${ctx.versionName}/${relative}`;
}

// The load call for a framework/format pair. Only the pairs that actually occur are
// listed; anything else falls back to the generic byte-stream form below.
const LOADERS: ReadonlyArray<{
  framework: string;
  format: string;
  imports: string[];
  load: (local: string) => string;
}> = [
  {
    framework: "pytorch",
    format: "torchscript",
    imports: ["import torch"],
    load: local => `model = torch.jit.load(${local})\nmodel.eval()`,
  },
  {
    framework: "pytorch",
    format: "state-dict",
    imports: ["import torch"],
    load: local =>
      `state_dict = torch.load(${local}, map_location="cpu")\n` +
      `# build your architecture first, then load the weights into it\n` +
      `# model.load_state_dict(state_dict)`,
  },
  {
    framework: "pytorch",
    format: "safetensors",
    imports: ["from safetensors.torch import load_file"],
    load: local => `state_dict = load_file(${local})\n# model.load_state_dict(state_dict)`,
  },
  {
    framework: "tensorflow",
    format: "savedmodel",
    imports: ["import tensorflow as tf"],
    load: local => `model = tf.saved_model.load(${local})`,
  },
  {
    framework: "onnx",
    format: "onnx",
    imports: ["import onnxruntime as ort"],
    load: local => `session = ort.InferenceSession(${local})\n# outputs = session.run(None, {"input": batch})`,
  },
  {
    framework: "sklearn",
    format: "joblib",
    imports: ["import joblib"],
    load: local => `model = joblib.load(${local})`,
  },
  {
    framework: "sklearn",
    format: "pickle",
    imports: ["import pickle"],
    load: local => `with open(${local}, "rb") as f:\n    model = pickle.load(f)`,
  },
];

function loaderFor(framework: string | undefined, format: string | undefined) {
  return LOADERS.find(l => l.framework === framework && l.format === format);
}

/**
 * A Python snippet that loads this model inside a Texera UDF. Falls back to a
 * generic "you have the bytes, load them yourself" form when the framework and
 * format pair has no known loader — including when either is "other".
 */
export function buildModelUsageSnippet(ctx: ModelSnippetContext): string {
  const path = modelLogicalPath(ctx);
  const loader = loaderFor(ctx.framework, ctx.format);

  const header = [
    "from pytexera import *",
    "from pytexera.storage.dataset_file_document import DatasetFileDocument",
    ...(loader?.imports ?? []),
    "",
    `MODEL_PATH = "${path}"`,
    "",
  ];

  const body = loader
    ? [
        "class ProcessTupleOperator(UDFOperatorV2):",
        "    def open(self):",
        "        document = DatasetFileDocument(MODEL_PATH)",
        "        with document.open() as model_file:",
        `            ${loader.load("model_file").split("\n").join("\n            ")}`,
        "",
        "    @overrides",
        "    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:",
        "        # prediction = model(...)",
        "        yield tuple_",
      ]
    : [
        "class ProcessTupleOperator(UDFOperatorV2):",
        "    def open(self):",
        "        document = DatasetFileDocument(MODEL_PATH)",
        "        with document.open() as model_file:",
        "            payload = model_file.read()",
        "            # load `payload` with whatever your framework expects",
        "",
        "    @overrides",
        "    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:",
        "        yield tuple_",
      ];

  return [...header, ...body].join("\n");
}

/** True when the pair has a tailored loader rather than the generic fallback. */
export function hasKnownLoader(framework: string | undefined, format: string | undefined): boolean {
  return loaderFor(framework, format) !== undefined;
}
