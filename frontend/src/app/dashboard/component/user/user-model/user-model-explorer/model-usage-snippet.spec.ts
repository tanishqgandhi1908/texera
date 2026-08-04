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
import {
  buildModelUsageSnippet,
  hasKnownLoader,
  modelVariableName,
  ModelSnippetContext,
  tokenizePythonLine,
  tokenizeSnippet,
} from "./model-usage-snippet";

function ctx(overrides: Partial<ModelSnippetContext> = {}): ModelSnippetContext {
  return {
    modelName: "churn-predict",
    fileRelativePath: "model.pt",
    framework: "pytorch",
    format: "torchscript",
    ...overrides,
  };
}

describe("modelVariableName", () => {
  it("turns a model name into a python identifier", () => {
    expect(modelVariableName("churn-predict")).toBe("churn_predict");
    expect(modelVariableName("ResNet 50")).toBe("resnet_50");
    expect(modelVariableName("already_ok")).toBe("already_ok");
  });

  it("prefixes names that would start with a digit", () => {
    expect(modelVariableName("50-resnet")).toBe("model_50_resnet");
  });

  it("falls back when the name has no usable characters", () => {
    expect(modelVariableName("---")).toBe("model_dir");
    expect(modelVariableName("")).toBe("model_dir");
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
    expect(hasKnownLoader("sklearn", "torchscript")).toBe(false);
    expect(hasKnownLoader("other", "other")).toBe(false);
    expect(hasKnownLoader("pytorch", undefined)).toBe(false);
    expect(hasKnownLoader(undefined, undefined)).toBe(false);
  });
});

describe("buildModelUsageSnippet", () => {
  it("reads the model through the property-panel variable, not a logical path", () => {
    const snippet = buildModelUsageSnippet(ctx());
    expect(snippet).toContain('model_file = os.path.join(churn_predict, "model.pt")');
    // the mount replaces logical-path resolution entirely
    expect(snippet).not.toContain("/models/");
    expect(snippet).not.toContain("DatasetFileDocument");
    expect(snippet).not.toContain("MODEL_PATH");
  });

  it("explains that the variable comes from the property panel", () => {
    const snippet = buildModelUsageSnippet(ctx());
    expect(snippet).toContain("`churn_predict` is the model variable declared in this operator's property");
    expect(snippet).toContain("mounted read-only");
  });

  it("loads in open() and predicts in process_tuple()", () => {
    const snippet = buildModelUsageSnippet(ctx());
    const openAt = snippet.indexOf("def open(self):");
    const processAt = snippet.indexOf("def process_tuple(");
    expect(openAt).toBeGreaterThan(-1);
    expect(processAt).toBeGreaterThan(openAt);
    expect(snippet.indexOf("torch.jit.load")).toBeLessThan(processAt);
  });

  it("uses the model directory itself for a tensorflow SavedModel", () => {
    const snippet = buildModelUsageSnippet(ctx({ framework: "tensorflow", format: "savedmodel" }));
    expect(snippet).toContain("tf.saved_model.load(churn_predict)");
    // a SavedModel is a directory, so no file join is emitted
    expect(snippet).not.toContain("os.path.join");
  });

  it("joins the relative path for every file-based format", () => {
    const snippet = buildModelUsageSnippet(
      ctx({ format: "safetensors", fileRelativePath: "weights/model.safetensors" })
    );
    expect(snippet).toContain('os.path.join(churn_predict, "weights/model.safetensors")');
    expect(snippet).toContain("load_file(model_file)");
  });

  it("comments each loader so the steps are explained", () => {
    expect(buildModelUsageSnippet(ctx())).toContain("# TorchScript carries its own architecture");
    expect(buildModelUsageSnippet(ctx({ format: "state-dict" }))).toContain("# A state dict holds weights only");
    expect(buildModelUsageSnippet(ctx({ framework: "sklearn", format: "pickle" }))).toContain(
      "# Only unpickle models you trust"
    );
  });

  it("suggests a framework-appropriate prediction call", () => {
    expect(buildModelUsageSnippet(ctx())).toContain("torch.no_grad()");
    expect(buildModelUsageSnippet(ctx({ framework: "sklearn", format: "joblib" }))).toContain("self.model.predict");
    expect(buildModelUsageSnippet(ctx({ framework: "onnx", format: "onnx" }))).toContain("self.session.run");
  });

  it("falls back to raw bytes when the pair has no loader", () => {
    const snippet = buildModelUsageSnippet(ctx({ framework: "other", format: "other" }));
    expect(snippet).toContain("payload = f.read()");
    expect(snippet).toContain("# No loader is known for this framework/format pair");
    expect(snippet).not.toContain("import torch");
  });

  it("always produces a runnable operator skeleton", () => {
    for (const framework of ["pytorch", "sklearn", "onnx", "other"]) {
      const snippet = buildModelUsageSnippet(ctx({ framework }));
      expect(snippet).toContain("class ProcessTupleOperator(UDFOperatorV2):");
      expect(snippet).toContain("def process_tuple(self, tuple_: Tuple, port: int)");
      expect(snippet).toContain("yield tuple_");
    }
  });

  it("indents every loader line inside open()", () => {
    const snippet = buildModelUsageSnippet(ctx({ format: "state-dict" }));
    snippet
      .split("\n")
      .filter(l => l.includes("load_state_dict") || l.includes("torch.load"))
      .forEach(line => expect(line.startsWith("        ")).toBe(true));
  });
});

describe("tokenizePythonLine", () => {
  it("marks a whole-line comment as a comment", () => {
    expect(tokenizePythonLine("# just a note")).toEqual([{ text: "# just a note", kind: "comment" }]);
  });

  it("marks keywords, strings and plain text separately", () => {
    const kinds = tokenizePythonLine("from pytexera import *");
    expect(kinds.find(t => t.text === "from")?.kind).toBe("keyword");
    expect(kinds.find(t => t.text === "import")?.kind).toBe("keyword");
    expect(kinds.find(t => t.text === "pytexera")?.kind).toBe("plain");
  });

  it("marks a double-quoted string", () => {
    const tokens = tokenizePythonLine('name = "model.pt"');
    expect(tokens.find(t => t.text === '"model.pt"')?.kind).toBe("string");
  });

  it("does not treat a # inside a string as a comment", () => {
    const tokens = tokenizePythonLine('tag = "a#b"');
    expect(tokens.some(t => t.kind === "comment")).toBe(false);
    expect(tokens.find(t => t.text === '"a#b"')?.kind).toBe("string");
  });

  it("splits a trailing comment from the code before it", () => {
    const tokens = tokenizePythonLine("x = 1  # set x");
    expect(tokens.filter(t => t.kind === "comment").map(t => t.text)).toEqual(["# set x"]);
    expect(tokens.find(t => t.text === "1")?.kind).toBe("number");
  });

  it("marks builtins distinctly from user names", () => {
    const tokens = tokenizePythonLine("open(path)");
    expect(tokens.find(t => t.text === "open")?.kind).toBe("builtin");
    expect(tokens.find(t => t.text === "path")?.kind).toBe("plain");
  });

  it("round-trips the original text", () => {
    const line = "self.model = torch.jit.load(model_file)  # load it";
    expect(
      tokenizePythonLine(line)
        .map(t => t.text)
        .join("")
    ).toBe(line);
  });

  it("handles an empty line", () => {
    expect(tokenizePythonLine("")).toEqual([]);
  });
});

describe("tokenizeSnippet", () => {
  it("produces one token array per line and loses no text", () => {
    const snippet = buildModelUsageSnippet(ctx());
    const lines = tokenizeSnippet(snippet);
    expect(lines.length).toBe(snippet.split("\n").length);
    expect(lines.map(l => l.map(t => t.text).join("")).join("\n")).toBe(snippet);
  });
});
