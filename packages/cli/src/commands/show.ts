import { AgentMemoryError } from "../../../core/src/errors";
import { showClaim, type HydratedClaim, type ShowResult } from "../../../core/src/retrieval";
import type { ExitCode } from "../../../core/src/types";

export interface ShowCommandContext {
  cwd?: string;
}

export interface ShowCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface ShowCommandOptions {
  id: string;
  json: boolean;
  includeRelated: boolean;
  depth: number;
}

export async function runShowCommand(args: string[], context: ShowCommandContext = {}): Promise<ShowCommandResult> {
  const options = parseShowArgs(args);
  const result = await showClaim({
    cwd: context.cwd,
    id: options.id,
    includeRelated: options.includeRelated,
    depth: options.depth
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderShowResult(result)
  };
}

function parseShowArgs(args: string[]): ShowCommandOptions {
  const [id, ...rest] = args;

  if (!id || id.startsWith("--")) {
    throw new AgentMemoryError("show requires a claim ID.", {
      details: ["Example: agent-memory show auth.student_oauth.uid_is_tenant_scoped"]
    });
  }

  let json = false;
  let includeRelated = false;
  let depth = 1;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--include-related") {
      includeRelated = true;
      continue;
    }

    if (arg === "--depth") {
      depth = parseDepth(readValue(rest, index, "--depth"));
      includeRelated = true;
      index += 1;
      continue;
    }

    if (arg.startsWith("--depth=")) {
      depth = parseDepth(arg.slice("--depth=".length));
      includeRelated = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown show option: ${arg}`, {
      details: ["Run `agent-memory help show` for usage."]
    });
  }

  return { id, json, includeRelated, depth };
}

function renderShowResult(result: ShowResult): string {
  const lines = renderClaim(result.claim);

  if (result.related.length > 0) {
    lines.push("", "## Related Claims");

    for (const related of result.related) {
      lines.push(
        "",
        `### ${related.claim.id}`,
        "",
        `Relation: ${related.relation.relation}`,
        `Origin: ${related.relation.origin}`,
        `Strength: ${related.relation.strength}`,
        related.relation.reason ? `Reason: ${related.relation.reason}` : "",
        "",
        related.claim.claim
      );
    }
  }

  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

function renderClaim(claim: HydratedClaim): string[] {
  const lines = [
    `# ${claim.title}`,
    "",
    `ID: ${claim.id}`,
    `Type: ${claim.type}`,
    `System: ${claim.system}`,
    `Status: ${claim.status}`,
    `Confidence: ${claim.confidence}`,
    `Severity: ${claim.severity}`,
    `Source: ${claim.source_path}`,
    "",
    "## Claim",
    "",
    claim.claim
  ];

  if (claim.files.length > 0) {
    lines.push("", "## Files", "", ...claim.files.map((file) => `- ${file.relation}: ${file.path}`));
  }

  if (claim.tags.length > 0) {
    lines.push("", "## Tags", "", claim.tags.join(", "));
  }

  if (claim.symbols.length > 0) {
    lines.push("", "## Symbols", "", claim.symbols.join(", "));
  }

  if (claim.routes.length > 0) {
    lines.push("", "## Routes", "", claim.routes.join(", "));
  }

  return lines;
}

function parseDepth(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    throw new AgentMemoryError(`Depth must be an integer between 0 and 10, got: ${value}`);
  }

  return parsed;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
