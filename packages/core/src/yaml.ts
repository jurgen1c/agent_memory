import {
  formatYamlParseIssues,
  parseYamlDocument,
  type JsonValue
} from "@jurgen1c/agent-core/yaml";
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

function stripDocumentScalarEnding(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.endsWith("\n") ? value.slice(0, -1) : value;
  if (Array.isArray(value)) return value.map(stripDocumentScalarEnding);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, stripDocumentScalarEnding(entry)])
  );
}
