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

import { describe, expect, it } from "vitest";
import { buildModelUsageSnippet, hasKnownLoader, modelLogicalPath, ModelSnippetContext } from "./model-usage-snippet";

function ctx(overrides: Partial<ModelSnippetContext> = {}): ModelSnippetContext {
  return {
    ownerEmail: "bob@texera.com",
    modelName: "churn-predict",
    versionName: "v2",
    fileRelativePath: "model.pt",
    framework: "pytorch",
    format: "torchscript",
    ...overrides,
  };
}

describe("modelLogicalPath", () => {
  it("builds the models-prefixed path from owner, name, version and file", () => {
    expect(modelLogicalPath(ctx())).toBe("/models/bob@texera.com/churn-predict/v2/model.pt");
  });

  it("keeps nested relative paths intact", () => {
    expect(modelLogicalPath(ctx({ fileRelativePath: "tokenizer/vocab.txt" }))).toBe(
      "/models/bob@texera.com/churn-predict/v2/tokenizer/vocab.txt"
    );
  });

  it("does not double the separator when the relative path is already rooted", () => {
    expect(modelLogicalPath(ctx({ fileRelativePath: "/model.pt" }))).toBe(
      "/models/bob@texera.com/churn-predict/v2/model.pt"
    );
  });
});

describe("hasKnownLoader", () => {
  it("recognises every pair that has a tailored loader", () => {
    expect(hasKnownLoader("pytorch", "torchscript")).toBe(true);
    expect(hasKnownLoader("pytorch", "state-dict")).toBe(true);
    expect(hasKnownLoader("pytorch", "safetensors")).toBe(true);
    expect(hasKnownLoader("tensorflow", "savedmodel")).toBe(true);
    expect(hasKnownLoader("onnx", "onnx")).toBe(true);
    expect(hasKnownLoader("sklearn", "joblib")).toBe(true);
    expect(hasKnownLoader("sklearn", "pickle")).toBe(true);
  });

  it("rejects mismatched, unknown and missing pairs", () => {
    // a real framework with a format that framework never produces
    expect(hasKnownLoader("sklearn", "torchscript")).toBe(false);
    expect(hasKnownLoader("other", "other")).toBe(false);
    expect(hasKnownLoader("pytorch", undefined)).toBe(false);
    expect(hasKnownLoader(undefined, "onnx")).toBe(false);
    expect(hasKnownLoader(undefined, undefined)).toBe(false);
  });
});

describe("buildModelUsageSnippet", () => {
  it("embeds the resolved model path", () => {
    expect(buildModelUsageSnippet(ctx())).toContain('MODEL_PATH = "/models/bob@texera.com/churn-predict/v2/model.pt"');
  });

  it("uses torch.jit.load for pytorch torchscript", () => {
    const snippet = buildModelUsageSnippet(ctx());
    expect(snippet).toContain("import torch");
    expect(snippet).toContain("torch.jit.load(model_file)");
  });

  it("uses safetensors load_file for pytorch safetensors", () => {
    const snippet = buildModelUsageSnippet(ctx({ format: "safetensors" }));
    expect(snippet).toContain("from safetensors.torch import load_file");
    expect(snippet).toContain("load_file(model_file)");
    expect(snippet).not.toContain("torch.jit.load");
  });

  it("uses onnxruntime for onnx", () => {
    const snippet = buildModelUsageSnippet(ctx({ framework: "onnx", format: "onnx" }));
    expect(snippet).toContain("import onnxruntime as ort");
    expect(snippet).toContain("ort.InferenceSession(model_file)");
  });

  it("uses joblib for sklearn joblib", () => {
    const snippet = buildModelUsageSnippet(ctx({ framework: "sklearn", format: "joblib" }));
    expect(snippet).toContain("import joblib");
    expect(snippet).toContain("joblib.load(model_file)");
  });

  it("uses tf.saved_model.load for tensorflow savedmodel", () => {
    const snippet = buildModelUsageSnippet(ctx({ framework: "tensorflow", format: "savedmodel" }));
    expect(snippet).toContain("import tensorflow as tf");
    expect(snippet).toContain("tf.saved_model.load(model_file)");
  });

  it("falls back to reading raw bytes when the pair has no loader", () => {
    const snippet = buildModelUsageSnippet(ctx({ framework: "other", format: "other" }));
    expect(snippet).toContain("payload = model_file.read()");
    expect(snippet).toContain("load `payload` with whatever your framework expects");
    // no framework import is guessed
    expect(snippet).not.toContain("import torch");
    expect(snippet).not.toContain("import joblib");
  });

  it("still resolves the path in the fallback form", () => {
    const snippet = buildModelUsageSnippet(ctx({ framework: "other", format: undefined }));
    expect(snippet).toContain('MODEL_PATH = "/models/bob@texera.com/churn-predict/v2/model.pt"');
  });

  it("always produces a runnable operator skeleton", () => {
    for (const framework of ["pytorch", "sklearn", "other"]) {
      const snippet = buildModelUsageSnippet(ctx({ framework }));
      expect(snippet).toContain("class ProcessTupleOperator(UDFOperatorV2):");
      expect(snippet).toContain("def process_tuple(self, tuple_: Tuple, port: int)");
      expect(snippet).toContain("yield tuple_");
    }
  });

  it("indents a multi-line load body to stay inside the with block", () => {
    const snippet = buildModelUsageSnippet(ctx({ format: "state-dict" }));
    const lines = snippet.split("\n").filter(l => l.includes("load_state_dict"));
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach(line => expect(line.startsWith("            ")).toBe(true));
  });
});
