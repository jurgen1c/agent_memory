import fs from "node:fs";
import { ConfigError } from "./errors";
import { parseYaml } from "./yaml";

export interface ParsedMarkdown {
  frontmatter: unknown;
  frontmatterRaw: string;
  body: string;
}

export function parseMarkdownFile(filePath: string): ParsedMarkdown {
  return parseMarkdown(fs.readFileSync(filePath, "utf8"));
}

export function parseMarkdown(raw: string): ParsedMarkdown {
  const normalized = raw.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    throw new ConfigError("Markdown file must start with YAML frontmatter.");
  }

  const closing = normalized.indexOf("\n---", 4);

  if (closing === -1) {
    throw new ConfigError("Markdown file is missing closing frontmatter marker.");
  }

  const afterClosing = closing + "\n---".length;
  const nextCharacter = normalized[afterClosing];

  if (nextCharacter !== undefined && nextCharacter !== "\n") {
    throw new ConfigError("Closing frontmatter marker must appear on its own line.");
  }

  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(nextCharacter === "\n" ? afterClosing + 1 : afterClosing);

  return {
    frontmatter: parseYaml(frontmatterRaw),
    frontmatterRaw,
    body
  };
}

export function extractMarkdownSection(body: string, heading: string): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^##\\s+${escapedHeading}\\s*$`, "im"));

  if (!match || match.index === undefined) {
    return null;
  }

  const sectionStart = match.index + match[0].length;
  const rest = body.slice(sectionStart);
  const nextHeading = rest.search(/^##\s+/m);

  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}
