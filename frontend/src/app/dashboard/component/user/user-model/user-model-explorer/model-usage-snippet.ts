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

/**
 * What the snippet needs to know about a model. The model is mounted into the
 * computing unit, and the UDF reads it through the variable declared in the
 * operator's property panel — so no logical path appears in the snippet.
 */
export interface ModelSnippetContext {
  modelName: string;
  /** Path of the weights file relative to the model root, e.g. "weights/model.pt". */
  fileRelativePath: string;
  framework: string | undefined;
  format: string | undefined;
}

/**
 * Variable name suggested for the operator's property panel, derived from the
 * model name so the snippet reads like the user's own code.
 */
export function modelVariableName(modelName: string): string {
  const identifier = modelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // Python identifiers cannot start with a digit, and an empty name is useless.
  if (identifier === "") {
    return "model_dir";
  }
  return /^[0-9]/.test(identifier) ? `model_${identifier}` : identifier;
}

interface Loader {
  framework: string;
  format: string;
  imports: string[];
  /** Lines that load the model, given the expression for the weights file path. */
  load: (fileExpr: string) => string[];
}

// The load call for a framework/format pair. Only the pairs that actually occur
// are listed; anything else falls back to the generic form below.
const LOADERS: ReadonlyArray<Loader> = [
  {
    framework: "pytorch",
    format: "torchscript",
    imports: ["import torch"],
    load: file => [
      "# TorchScript carries its own architecture, so it loads standalone.",
      `self.model = torch.jit.load(${file})`,
      "# Inference mode: disables dropout and batch-norm updates.",
      "self.model.eval()",
    ],
  },
  {
    framework: "pytorch",
    format: "state-dict",
    imports: ["import torch"],
    load: file => [
      "# A state dict holds weights only, so build the architecture first",
      "# and then copy the weights into it.",
      `state_dict = torch.load(${file}, map_location="cpu")`,
      "# self.model = MyNetwork()",
      "# self.model.load_state_dict(state_dict)",
      "# self.model.eval()",
    ],
  },
  {
    framework: "pytorch",
    format: "safetensors",
    imports: ["from safetensors.torch import load_file"],
    load: file => [
      "# safetensors stores tensors only -- no pickled Python code.",
      `state_dict = load_file(${file})`,
      "# self.model = MyNetwork()",
      "# self.model.load_state_dict(state_dict)",
      "# self.model.eval()",
    ],
  },
  {
    framework: "tensorflow",
    format: "savedmodel",
    imports: ["import tensorflow as tf"],
    load: file => [
      "# A SavedModel is a directory, so point at the model root, not a file.",
      `self.model = tf.saved_model.load(${file})`,
    ],
  },
  {
    framework: "onnx",
    format: "onnx",
    imports: ["import onnxruntime as ort"],
    load: file => [
      "# Create the session once in open(); it is the expensive step.",
      `self.session = ort.InferenceSession(${file})`,
      "self.input_name = self.session.get_inputs()[0].name",
    ],
  },
  {
    framework: "sklearn",
    format: "joblib",
    imports: ["import joblib"],
    load: file => [`self.model = joblib.load(${file})`],
  },
  {
    framework: "sklearn",
    format: "pickle",
    imports: ["import pickle"],
    load: file => [
      // Worth saying out loud: pickle executes code on load.
      "# Only unpickle models you trust -- loading runs arbitrary code.",
      `with open(${file}, "rb") as f:`,
      "    self.model = pickle.load(f)",
    ],
  },
];

function loaderFor(framework: string | undefined, format: string | undefined): Loader | undefined {
  return LOADERS.find(l => l.framework === framework && l.format === format);
}

/** True when the pair has a tailored loader rather than the generic fallback. */
export function hasKnownLoader(framework: string | undefined, format: string | undefined): boolean {
  return loaderFor(framework, format) !== undefined;
}

/** How predictions are produced, per framework — the part after loading. */
function predictLines(framework: string | undefined): string[] {
  switch (framework) {
    case "pytorch":
      return [
        "# with torch.no_grad():",
        '#     prediction = self.model(torch.tensor([tuple_["feature"]]))',
        '# tuple_["prediction"] = prediction.item()',
      ];
    case "onnx":
      return ["# outputs = self.session.run(None, {self.input_name: batch})", '# tuple_["prediction"] = outputs[0][0]'];
    case "tensorflow":
      return [
        '# prediction = self.model(tf.constant([tuple_["feature"]]))',
        '# tuple_["prediction"] = float(prediction)',
      ];
    case "sklearn":
      return ['# prediction = self.model.predict([[tuple_["feature"]]])', '# tuple_["prediction"] = prediction[0]'];
    default:
      return ["# prediction = ...", '# tuple_["prediction"] = prediction'];
  }
}

/**
 * A Python UDF that loads this model. The model is named by a UI parameter the code
 * declares for itself; the property panel offers a model picker for that row, and the
 * value handed back is the directory the version is mounted at. So the snippet joins
 * that directory with the file's relative path rather than resolving a logical path
 * itself.
 */
export function buildModelUsageSnippet(ctx: ModelSnippetContext): string {
  const variable = modelVariableName(ctx.modelName);
  const loader = loaderFor(ctx.framework, ctx.format);
  const relative = ctx.fileRelativePath.replace(/^\/+/, "");

  // A SavedModel is loaded from its directory; everything else from a file.
  const usesDirectory = ctx.format === "savedmodel";
  const fileExpr = usesDirectory ? variable : "model_file";

  const lines: string[] = [
    "from pytexera import *",
    "import os",
    ...(loader?.imports ?? []),
    "",
    "",
    "class ProcessTupleOperator(UDFOperatorV2):",
    "    def open(self):",
    "        # Declaring the parameter puts a row in this operator's property panel; pick",
    "        # the model version there. The value is the directory it is mounted at --",
    "        # read-only and already local, so no download is needed.",
    `        ${variable} = self.UiParameter("${variable}", AttributeType.STRING, value=Resource.MODEL).value`,
  ];

  if (!usesDirectory) {
    lines.push(`        model_file = os.path.join(${variable}, "${relative}")`);
  }

  // open() runs once per worker, so loading here keeps it off the per-tuple path.
  const body = loader
    ? loader.load(fileExpr)
    : [
        "# No loader is known for this framework/format pair, so read the bytes",
        "# and hand them to whatever your framework expects.",
        `with open(${fileExpr}, "rb") as f:`,
        "    payload = f.read()",
        "# self.model = my_framework.load(payload)",
      ];
  lines.push(...body.map(l => `        ${l}`));

  lines.push(
    "",
    "    @overrides",
    "    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:",
    "        # open() already loaded the model, so predict per tuple here.",
    ...predictLines(ctx.framework).map(l => `        ${l}`),
    "        yield tuple_"
  );

  return lines.join("\n");
}

/** A highlighting token: `kind` maps to a CSS class in the template. */
export interface SnippetToken {
  text: string;
  kind: "keyword" | "string" | "comment" | "number" | "builtin" | "plain";
}

const KEYWORDS = new Set([
  "from",
  "import",
  "as",
  "class",
  "def",
  "self",
  "with",
  "for",
  "in",
  "if",
  "else",
  "elif",
  "return",
  "yield",
  "None",
  "True",
  "False",
  "not",
  "and",
  "or",
  "pass",
  "raise",
  "try",
  "except",
]);

const BUILTINS = new Set(["open", "print", "len", "float", "int", "str", "range", "os"]);

/**
 * Splits one line of the generated Python into coloured tokens. Deliberately
 * small: it only has to cover the constructs this generator emits, not Python
 * as a whole, and the repo has no highlighter dependency to lean on.
 */
export function tokenizePythonLine(line: string): SnippetToken[] {
  const commentAt = findCommentStart(line);
  if (commentAt === 0) {
    return [{ text: line, kind: "comment" }];
  }
  const code = commentAt === -1 ? line : line.slice(0, commentAt);
  const comment = commentAt === -1 ? "" : line.slice(commentAt);

  const tokens: SnippetToken[] = [];
  // Words, quoted strings, numbers, or any single other character.
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|(\s+)|(.)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const [text, str, word, num, space] = match;
    if (str !== undefined) {
      tokens.push({ text, kind: "string" });
    } else if (word !== undefined) {
      tokens.push({ text, kind: KEYWORDS.has(word) ? "keyword" : BUILTINS.has(word) ? "builtin" : "plain" });
    } else if (num !== undefined) {
      tokens.push({ text, kind: "number" });
    } else if (space !== undefined) {
      tokens.push({ text, kind: "plain" });
    } else {
      tokens.push({ text, kind: "plain" });
    }
  }

  if (comment) {
    tokens.push({ text: comment, kind: "comment" });
  }
  return tokens;
}

/** Index of the `#` that starts a comment, ignoring `#` inside strings. */
function findCommentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return i;
    }
  }
  return -1;
}

/** The snippet as coloured tokens, one array per line. */
export function tokenizeSnippet(snippet: string): SnippetToken[][] {
  return snippet.split("\n").map(tokenizePythonLine);
}
