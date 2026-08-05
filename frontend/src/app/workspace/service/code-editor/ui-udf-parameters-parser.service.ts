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
import { parser } from "@lezer/python";
import { AttributeType, SchemaAttribute } from "../../types/workflow-compiling.interface";

// Keep in sync with Python UDF template class names in PythonUDFOpDescV2, DualInputPortsPythonUDFOpDescV2, and PythonUDFSourceOpDescV2.
const SUPPORTED_CLASS_NAMES = new Set([
  "ProcessTupleOperator",
  "ProcessBatchOperator",
  "ProcessTableOperator",
  "GenerateOperator",
]);

const PYTHON_NODE = {
  ARG_LIST: "ArgList",
  ASSIGN_OP: "AssignOp",
  CALL_EXPRESSION: "CallExpression",
  CLASS_DEFINITION: "ClassDefinition",
  MEMBER_EXPRESSION: "MemberExpression",
  PROPERTY_NAME: "PropertyName",
  STRING: "String",
  VARIABLE_NAME: "VariableName",
} as const;
const ARGUMENT_DELIMITER_NODES = new Set(["(", ")", ","]);

const UI_PARAMETER_CALLEE = ["self", "UiParameter"];
const ATTRIBUTE_TYPE_RECEIVER = "AttributeType";
// A Texera resource the value names, declared as `value=Resource.X`. The parameter stays an
// ordinary string; only its editor differs. Keep in sync with pytexera's Resource and with
// PythonUdfUiParameterSupport on the backend.
const RESOURCE_RECEIVER = "Resource";
export const MODEL_INPUT_TYPE = "model";
export const DATASET_INPUT_TYPE = "dataset";
const RESOURCE_INPUT_TYPES_BY_TOKEN: Readonly<Record<string, string>> = {
  MODEL: MODEL_INPUT_TYPE,
  DATASET: DATASET_INPUT_TYPE,
};
const ARGUMENT_NAME = "name";
const ARGUMENT_TYPE = "type";
const ARGUMENT_ATTR_TYPE = "attr_type";
const ARGUMENT_VALUE = "value";
// `value` is keyword-only: positionally, the third argument would be ambiguous with the
// value itself, and pytexera accepts it only as a keyword too.
const POSITIONAL_ARGUMENT_KEYS = [ARGUMENT_NAME, ARGUMENT_TYPE] as const;

type ParserSyntaxNode = ReturnType<typeof parser.parse>["topNode"];
type ParsedArgument = Readonly<{ key?: string; value: ParserSyntaxNode }>;
type UiParameterArgument =
  | Readonly<{ kind: typeof ARGUMENT_NAME; value: string }>
  | Readonly<{ kind: typeof ARGUMENT_TYPE; value: AttributeType }>
  | Readonly<{ kind: typeof ARGUMENT_VALUE; value: string }>;

/**
 * UI parameter row inferred from Python code, with backend-compatible attribute metadata and an
 * editable value. `inputType` names the resource the value comes from — "model" or "dataset" —
 * whose value is picked from that resource's browser rather than typed.
 */
export type UiUdfParameter = Readonly<{ attribute: SchemaAttribute; value: string; inputType?: string }>;

/** Raised when supported Python UDF code declares UI parameters that cannot be represented safely in the UI. */
export class UiUdfParametersParseError extends Error {}

// Accept Java enum names (INTEGER, BOOLEAN) and Python enum aliases (INT, BOOL).
const ATTRIBUTE_TYPES_BY_TOKEN: Readonly<Record<string, AttributeType>> = {
  STRING: "string",
  INTEGER: "integer",
  INT: "integer",
  LONG: "long",
  DOUBLE: "double",
  BOOLEAN: "boolean",
  BOOL: "boolean",
  TIMESTAMP: "timestamp",
};

/** Parses Python UDF source code and infers supported self.UiParameter(...) declarations for the property panel. */
@Injectable({ providedIn: "root" })
export class UiUdfParametersParserService {
  /**
   * Returns UI parameters from the single supported Python UDF class in the source.
   * Throws UiUdfParametersParseError for duplicate parameter names or multiple supported UDF classes.
   */
  parse(code: string): UiUdfParameter[] {
    if (!code) return [];

    const result: UiUdfParameter[] = [];
    const seen = new Set<string>();
    let supportedClassCount = 0;
    let duplicateName: string | undefined;
    const addParameter = (parameter?: UiUdfParameter): void => {
      const name = parameter?.attribute.attributeName;
      if (parameter && name) {
        if (seen.has(name)) {
          duplicateName = name;
          return;
        }
        seen.add(name);
        result.push(parameter);
      }
    };

    parser.parse(code).iterate({
      enter: ({ name, node }) => {
        const className = node.getChild(PYTHON_NODE.VARIABLE_NAME);
        if (
          name !== PYTHON_NODE.CLASS_DEFINITION ||
          !className ||
          !SUPPORTED_CLASS_NAMES.has(code.slice(className.from, className.to))
        )
          return;
        supportedClassCount++;
        node.cursor().iterate(cursorReference => {
          if (cursorReference.name !== PYTHON_NODE.CALL_EXPRESSION) return;
          addParameter(readCall(cursorReference.node, code));
          return false;
        });
        return false;
      },
    });

    if (supportedClassCount > 1)
      throw new UiUdfParametersParseError("Only one Python UDF class can declare UiParameter values.");

    if (duplicateName)
      throw new UiUdfParametersParseError(`UiParameter name '${duplicateName}' is declared more than once.`);

    return result;
  }
}

function readCall(call: ParserSyntaxNode, code: string): UiUdfParameter | undefined {
  const argumentList = call.getChild(PYTHON_NODE.ARG_LIST);
  const callee = call.getChild(PYTHON_NODE.MEMBER_EXPRESSION);
  if (!argumentList || !isMemberPath(callee, code, UI_PARAMETER_CALLEE)) return undefined;

  let attributeName: string | undefined;
  let attributeType: AttributeType | undefined;
  let inputType: string | undefined;
  const uiParameterArguments = readUiParameterArguments(argumentList, code);
  if (!uiParameterArguments) return undefined;

  for (const argument of uiParameterArguments) {
    if (argument.kind === ARGUMENT_NAME && !attributeName) attributeName = argument.value;
    else if (argument.kind === ARGUMENT_TYPE && !attributeType) attributeType = argument.value;
    else if (argument.kind === ARGUMENT_VALUE && !inputType) inputType = argument.value;
    else return undefined;
  }

  if (!attributeName || !attributeType) return undefined;
  return { attribute: { attributeName, attributeType }, value: "", ...(inputType ? { inputType } : {}) };
}

function readUiParameterArguments(argumentList: ParserSyntaxNode, code: string): UiParameterArgument[] | undefined {
  const result: UiParameterArgument[] = [];
  let positionalIndex = 0;
  let sawNamedArgument = false;

  for (const argument of readArguments(argumentList, code)) {
    if (argument.key) sawNamedArgument = true;
    else if (sawNamedArgument) return undefined;

    const key = argument.key ?? POSITIONAL_ARGUMENT_KEYS[positionalIndex++];
    const parsedArgument = readUiParameterArgument(key, argument.value, code);
    if (!parsedArgument) return undefined;
    result.push(parsedArgument);
  }

  return result;
}

function readUiParameterArgument(
  key: string | undefined,
  value: ParserSyntaxNode,
  code: string
): UiParameterArgument | undefined {
  if (key === ARGUMENT_NAME) {
    const attributeName = readName(value, code);
    return attributeName ? { kind: ARGUMENT_NAME, value: attributeName } : undefined;
  }
  if (key === ARGUMENT_TYPE || key === ARGUMENT_ATTR_TYPE) {
    const attributeType = readType(value, code);
    return attributeType ? { kind: ARGUMENT_TYPE, value: attributeType } : undefined;
  }
  if (key === ARGUMENT_VALUE) {
    const inputType = readResource(value, code);
    return inputType ? { kind: ARGUMENT_VALUE, value: inputType } : undefined;
  }
  return undefined;
}

function readArguments(argumentList: ParserSyntaxNode, code: string): ParsedArgument[] {
  const result: ParsedArgument[] = [];
  const children = getChildren(argumentList).filter(node => !ARGUMENT_DELIMITER_NODES.has(node.name));

  for (let index = 0; index < children.length; index++) {
    const node = children[index];

    if (node.name === PYTHON_NODE.VARIABLE_NAME && children[index + 1]?.name === PYTHON_NODE.ASSIGN_OP) {
      const value = children[index + 2];
      if (!value) return [];
      result.push({ key: code.slice(node.from, node.to), value });
      index += 2;
    } else if (node.name !== PYTHON_NODE.ASSIGN_OP) {
      result.push({ value: node });
    } else {
      return [];
    }
  }

  return result;
}

function getChildren(node: ParserSyntaxNode): ParserSyntaxNode[] {
  const children: ParserSyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  return children;
}

function readName(value: ParserSyntaxNode, code: string): string | undefined {
  const name = value.name === PYTHON_NODE.STRING ? readString(code.slice(value.from, value.to))?.trim() : undefined;
  return name || undefined;
}

function readType(value: ParserSyntaxNode, code: string): AttributeType | undefined {
  return readEnumMember(value, code, ATTRIBUTE_TYPE_RECEIVER, ATTRIBUTE_TYPES_BY_TOKEN);
}

function readResource(value: ParserSyntaxNode, code: string): string | undefined {
  return readEnumMember(value, code, RESOURCE_RECEIVER, RESOURCE_INPUT_TYPES_BY_TOKEN);
}

/** Reads `Receiver.MEMBER` and maps MEMBER through `membersByToken`. */
function readEnumMember<T extends string>(
  value: ParserSyntaxNode,
  code: string,
  receiver: string,
  membersByToken: Readonly<Record<string, T>>
): T | undefined {
  const parts = readMemberPath(value, code);
  if (parts?.length !== 2 || parts[0] !== receiver) return undefined;
  const token = parts[1]?.toUpperCase();
  return token ? membersByToken[token] : undefined;
}

function isMemberPath(node: ParserSyntaxNode | null, code: string, expectedParts: string[]): boolean {
  const parts = node ? readMemberPath(node, code) : undefined;
  return parts?.length === expectedParts.length && parts.every((part, index) => part === expectedParts[index]);
}

function readMemberPath(node: ParserSyntaxNode, code: string): string[] | undefined {
  if (node.name !== PYTHON_NODE.MEMBER_EXPRESSION) return undefined;
  const parts = getChildren(node)
    .filter(child => child.name === PYTHON_NODE.VARIABLE_NAME || child.name === PYTHON_NODE.PROPERTY_NAME)
    .map(child => code.slice(child.from, child.to));
  return parts.length ? parts : undefined;
}

function readString(input: string): string | undefined {
  return input
    .trim()
    .match(/^[rRuU]*(?:"""([\s\S]*)"""|'''([\s\S]*)'''|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/)
    ?.slice(1)
    .find(value => value !== undefined);
}
