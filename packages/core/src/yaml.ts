import {
  formatYamlParseIssues,
  parseYamlDocument,
  type JsonValue
} from "@jurgen1c/agent-core/yaml";
import { isMap, parseDocument } from "yaml";
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

  document.set(key, value);
  return document.toString({ lineWidth: 0 });
}

function stripDocumentScalarEnding(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.endsWith("\n") ? value.slice(0, -1) : value;
  if (Array.isArray(value)) return value.map(stripDocumentScalarEnding);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, stripDocumentScalarEnding(entry)])
  );
}
