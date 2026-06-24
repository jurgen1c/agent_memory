import { AgentMemoryError } from "../../../core/src/errors";
import { systemSummary, type SystemResult } from "../../../core/src/retrieval";
import type { ExitCode } from "../../../core/src/types";

export interface SystemCommandContext {
  cwd?: string;
}

export interface SystemCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface SystemCommandOptions {
  system: string;
  json: boolean;
}

export async function runSystemCommand(args: string[], context: SystemCommandContext = {}): Promise<SystemCommandResult> {
  const options = parseSystemArgs(args);
  const result = await systemSummary({
    cwd: context.cwd,
    system: options.system
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderSystemResult(result)
  };
}

function parseSystemArgs(args: string[]): SystemCommandOptions {
  const [system, ...rest] = args;

  if (!system || system.startsWith("--")) {
    throw new AgentMemoryError("system requires a system ID.", {
      details: ["Example: agent-memory system auth"]
    });
  }

  let json = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown system option: ${arg}`, {
      details: ["Run `agent-memory help system` for usage."]
    });
  }

  return { system, json };
}

function renderSystemResult(result: SystemResult): string {
  const lines = [`# System: ${result.system}`];

  if (result.index) {
    lines.push("", `Name: ${result.index.name}`);

    if (result.index.summary) {
      lines.push(`Summary: ${result.index.summary}`);
    }
  } else {
    lines.push("", "No index file is compiled for this system.");
  }

  lines.push("", "## Claim Counts");

  if (result.claimCounts.length === 0) {
    lines.push("", "No claims found.");
  } else {
    lines.push("", ...result.claimCounts.map((row) => `- ${row.type}/${row.status}: ${row.count}`));
  }

  if (result.criticalClaims.length > 0) {
    lines.push("", "## Critical Claims", "", ...result.criticalClaims.map((claim) => `- ${claim.id}: ${claim.title} (${claim.status})`));
  }

  if (result.index?.watchedFiles.length) {
    lines.push("", "## Watched Files", "", ...result.index.watchedFiles.map((file) => `- ${file}`));
  }

  if (result.recipes.length > 0) {
    lines.push("", "## Recipes", "", ...result.recipes.map((recipe) => `- ${recipe.id}: ${recipe.title} (${recipe.status})`));
  }

  if (result.topRelations.length > 0) {
    lines.push("", "## Top Relationships", "", ...result.topRelations.map((row) => `- ${row.relation}/${row.origin}: ${row.count}`));
  }

  return lines.join("\n");
}
