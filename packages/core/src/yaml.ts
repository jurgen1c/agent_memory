import {
  formatYamlParseIssues,
  parseYamlDocument,
  type JsonValue
} from "@jurgen1c/agent-core/yaml";
import { isMap, parseDocument, type Document, type YAMLMap } from "yaml";
import { ConfigError } from "./errors";

export type YamlValue = JsonValue;

export function parseYaml(input: string): YamlValue {
  const result = parseYamlDocument(input);
  if (result.ok) {
    if (result.value === null || typeof result.value !== "object" || Array.isArray(result.value)) {
      throw new ConfigError("Invalid YAML: expected a top-level mapping.");
    }

    return stripDocumentScalarEnding(result.value);
  }

  throw new ConfigError(`Invalid YAML:\n${formatYamlParseIssues(result.issues)}`);
}

export function setYamlTopLevelValue(input: string, key: string, value: JsonValue): string {
  return setYamlPathValue(input, [key], value);
}

export function setYamlPathValue(input: string, path: string[], value: JsonValue): string {
  const document = parseDocument(input, {
    logLevel: "error",
    prettyErrors: true,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true
  });
  const issues = [...document.errors, ...document.warnings];

  if (issues.length > 0) {
    throw new ConfigError(`Invalid YAML:\n${issues.map((issue) => issue.message).join("\n")}`);
  }

  if (!isMap(document.contents)) {
    throw new ConfigError("Invalid YAML: expected a top-level mapping.");
  }

  document.setIn(path, value);
  return document.toString({ lineWidth: 0 });
}

export function mergeYamlMissingValues(input: string, defaults: string, skipPaths: string[] = []): string {
  const document = parseYamlMappingDocument(input);
  const defaultDocument = parseYamlMappingDocument(defaults);
  mergeMissingMapValues(document.contents, defaultDocument.contents, new Set(skipPaths));
  return document.toString({ lineWidth: 0 });
}

type ParsedYamlMap = YAMLMap.Parsed;
type ParsedYamlMapDocument = Document.Parsed<ParsedYamlMap> & { contents: ParsedYamlMap };

function parseYamlMappingDocument(input: string): ParsedYamlMapDocument {
  const document = parseDocument(input, {
    logLevel: "error",
    prettyErrors: true,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true
  });
  const issues = [...document.errors, ...document.warnings];

  if (issues.length > 0) {
    throw new ConfigError(`Invalid YAML:\n${issues.map((issue) => issue.message).join("\n")}`);
  }

  if (!isMap(document.contents)) {
    throw new ConfigError("Invalid YAML: expected a top-level mapping.");
  }

  return document as ParsedYamlMapDocument;
}

function mergeMissingMapValues(
  target: ParsedYamlMap,
  defaults: ParsedYamlMap,
  skipPaths: Set<string>,
  prefix = ""
): void {
  for (const defaultPair of defaults.items) {
    const key = String(defaultPair.key);
    const currentPath = prefix ? `${prefix}.${key}` : key;
    const targetPair = target.items.find((pair) => String(pair.key) === key);

    if (targetPair === undefined) {
      if (!skipPaths.has(currentPath)) {
        target.add(defaultPair.clone(defaults.schema));
      }
      continue;
    }

    if (isMap(targetPair.value) && isMap(defaultPair.value)) {
      mergeMissingMapValues(targetPair.value, defaultPair.value, skipPaths, currentPath);
    }
  }
}

function stripDocumentScalarEnding(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.endsWith("\n") ? value.slice(0, -1) : value;
  if (Array.isArray(value)) return value.map(stripDocumentScalarEnding);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, stripDocumentScalarEnding(entry)])
  );
}
