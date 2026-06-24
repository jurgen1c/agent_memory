import { ConfigError } from "./errors";

type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

interface ParsedLine {
  indent: number;
  text: string;
  lineNumber: number;
}

interface StackFrame {
  indent: number;
  value: YamlValue[] | { [key: string]: YamlValue };
}

export function parseYaml(input: string): YamlValue {
  const lines = normalizeLines(input);
  const root: { [key: string]: YamlValue } = {};
  const stack: StackFrame[] = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    while (stack.length > 1 && line.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;

    if (line.text.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw yamlError(line, "List item found where a mapping entry was expected.");
      }

      parseArrayItem(parent, line, lines, index, stack);
      continue;
    }

    if (Array.isArray(parent)) {
      throw yamlError(line, "Mapping entry found where a list item was expected.");
    }

    const entry = splitKeyValue(line);

    if (entry.value === "") {
      const child = createContainerForNextLine(lines, index);
      parent[entry.key] = child;
      stack.push({ indent: line.indent, value: child });
    } else {
      parent[entry.key] = parseScalar(entry.value, line);
    }
  }

  return root;
}

function normalizeLines(input: string): ParsedLine[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw, index) => ({ raw, lineNumber: index + 1 }))
    .filter(({ raw }) => raw.trim().length > 0 && !raw.trimStart().startsWith("#"))
    .map(({ raw, lineNumber }) => {
      const indent = raw.match(/^ */)?.[0].length ?? 0;

      if (raw.slice(0, indent).includes("\t")) {
        throw new ConfigError(`YAML line ${lineNumber} uses tabs for indentation.`);
      }

      return {
        indent,
        text: raw.trim(),
        lineNumber
      };
    });
}

function parseArrayItem(
  parent: YamlValue[],
  line: ParsedLine,
  lines: ParsedLine[],
  index: number,
  stack: StackFrame[]
): void {
  const item = line.text.slice(2).trim();

  if (item.length === 0) {
    const child = createContainerForNextLine(lines, index);
    parent.push(child);
    stack.push({ indent: line.indent, value: child });
    return;
  }

  if (looksLikeMapping(item)) {
    const object: { [key: string]: YamlValue } = {};
    const entry = splitKeyValue({ ...line, text: item });

    if (entry.value === "") {
      const child = createContainerForNextLine(lines, index);
      object[entry.key] = child;
      parent.push(object);
      stack.push({ indent: line.indent, value: object });
      stack.push({ indent: line.indent + 2, value: child });
      return;
    }

    object[entry.key] = parseScalar(entry.value, line);
    parent.push(object);
    stack.push({ indent: line.indent, value: object });
    return;
  }

  parent.push(parseScalar(item, line));
}

function createContainerForNextLine(lines: ParsedLine[], index: number): YamlValue[] | { [key: string]: YamlValue } {
  const current = lines[index];
  const next = lines.slice(index + 1).find((candidate) => candidate.indent > current.indent);

  if (next?.text.startsWith("- ")) {
    return [];
  }

  return {};
}

function looksLikeMapping(text: string): boolean {
  const colonIndex = text.indexOf(":");
  return colonIndex > 0;
}

function splitKeyValue(line: ParsedLine): { key: string; value: string } {
  const colonIndex = line.text.indexOf(":");

  if (colonIndex <= 0) {
    throw yamlError(line, "Expected a key/value entry.");
  }

  const key = line.text.slice(0, colonIndex).trim();
  const value = line.text.slice(colonIndex + 1).trim();

  if (key.length === 0) {
    throw yamlError(line, "YAML key cannot be empty.");
  }

  return { key, value };
}

function parseScalar(value: string, line: ParsedLine): YamlValue {
  if (value === "null" || value === "~") {
    return null;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "[]") {
    return [];
  }

  if (value === "{}") {
    return {};
  }

  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  if (value === ">" || value === "|") {
    throw yamlError(line, "Block scalar YAML values are not supported by the Phase 1 parser.");
  }

  return value;
}

function yamlError(line: ParsedLine, message: string): ConfigError {
  return new ConfigError(`Invalid YAML at line ${line.lineNumber}: ${message}`);
}
