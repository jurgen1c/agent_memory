import { checkCoverage, type CoverageChange, type CoverageResult } from "../../../core/src/coverage";
import { AgentMemoryError } from "../../../core/src/errors";
import type { ExitCode } from "../../../core/src/types";

export interface CoverageCommandContext {
  cwd?: string;
}

export interface CoverageCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface CoverageCommandOptions {
  changedFiles: string[];
  gitDiff: boolean;
  baseRef?: string;
  json: boolean;
}

export async function runCoverageCommand(args: string[], context: CoverageCommandContext = {}): Promise<CoverageCommandResult> {
  const options = parseCoverageArgs(args);
  const result = await checkCoverage({
    cwd: context.cwd,
    changedFiles: options.changedFiles,
    gitDiff: options.gitDiff,
    baseRef: options.baseRef
  });

  return {
    exitCode: result.ok ? 0 : 6,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderCoverageResult(result)
  };
}

function parseCoverageArgs(args: string[]): CoverageCommandOptions {
  const options: CoverageCommandOptions = {
    changedFiles: [],
    gitDiff: false,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--git-diff") {
      options.gitDiff = true;
      continue;
    }

    if (arg === "--base") {
      options.baseRef = readValue(args, index, "--base");
      index += 1;
      continue;
    }

    if (arg.startsWith("--base=")) {
      options.baseRef = arg.slice("--base=".length);
      continue;
    }

    if (arg === "--changed-files") {
      index += 1;

      while (index < args.length && !args[index].startsWith("--")) {
        options.changedFiles.push(args[index]);
        index += 1;
      }

      index -= 1;
      continue;
    }

    throw new AgentMemoryError(`Unknown coverage option: ${arg}`, {
      details: ["Run `agent-memory help coverage` for usage."]
    });
  }

  if (options.changedFiles.length === 0 && !options.gitDiff) {
    throw new AgentMemoryError("coverage requires --changed-files or --git-diff.", {
      details: ["Example: agent-memory coverage --changed-files src/auth.js"]
    });
  }

  if (options.baseRef && !options.gitDiff) {
    throw new AgentMemoryError("coverage --base requires --git-diff.", {
      details: ["Example: agent-memory coverage --git-diff --base origin/main"]
    });
  }

  return options;
}

function renderCoverageResult(result: CoverageResult): string {
  const watched = result.changes.filter((change) => change.status !== "ignored");
  const covered = result.changes.filter((change) => change.status === "covered");
  const waived = result.changes.filter((change) => change.status === "waived");
  const uncovered = result.changes.filter((change) => change.status === "uncovered");
  const lines = [
    result.ok ? "Agent Memory coverage passed." : "Agent Memory coverage failed.",
    "",
    `Database: ${result.databasePath}`,
    `Changed files: ${result.changedFiles.length}`,
    `Watched changes: ${watched.length}`,
    `Covered: ${covered.length}`,
    `Waived: ${waived.length}`,
    `Uncovered: ${uncovered.length}`
  ];

  if (uncovered.length > 0) {
    lines.push("", "Uncovered watched files:");

    for (const change of uncovered) {
      lines.push(...renderChange(change));
    }
  }

  if (waived.length > 0) {
    lines.push("", "Waived watched files:");

    for (const change of waived) {
      lines.push(`- ${change.path} (waivers: ${change.waiverIds.join(", ")})`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function renderChange(change: CoverageChange): string[] {
  return [
    `- ${change.path}`,
    `  Watched by: ${change.watchedBy.join(", ")}`,
    `  Related memory files: ${change.relatedMemoryFiles.length > 0 ? change.relatedMemoryFiles.join(", ") : "none"}`,
    `  Remediation: ${change.remediation ?? "Update related memory."}`
  ];
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
