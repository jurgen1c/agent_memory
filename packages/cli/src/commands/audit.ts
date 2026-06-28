import { auditMemory, type AuditFinding, type AuditResult } from "../../../core/src/audit";
import { AgentMemoryError } from "../../../core/src/errors";
import type { ExitCode } from "../../../core/src/types";

export interface AuditCommandContext {
  cwd?: string;
}

export interface AuditCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface AuditCommandOptions {
  changedFiles: string[];
  gitDiff: boolean;
  baseRef?: string;
  json: boolean;
}

export function runAuditCommand(args: string[], context: AuditCommandContext = {}): AuditCommandResult {
  const options = parseAuditArgs(args);
  const result = auditMemory({
    cwd: context.cwd,
    changedFiles: options.changedFiles,
    gitDiff: options.gitDiff,
    baseRef: options.baseRef
  });

  return {
    exitCode: result.ok ? 0 : 6,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderAuditResult(result)
  };
}

function parseAuditArgs(args: string[]): AuditCommandOptions {
  const options: AuditCommandOptions = {
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

    throw new AgentMemoryError(`Unknown audit option: ${arg}`, {
      details: ["Run `agent-memory help audit` for usage."]
    });
  }

  if (options.changedFiles.length === 0 && !options.gitDiff) {
    throw new AgentMemoryError("audit requires --changed-files or --git-diff.", {
      details: ["Example: agent-memory audit --changed-files docs/agent-memory/claims/auth/example.md"]
    });
  }

  if (options.baseRef && !options.gitDiff) {
    throw new AgentMemoryError("audit --base requires --git-diff.", {
      details: ["Example: agent-memory audit --git-diff --base origin/main"]
    });
  }

  return options;
}

function renderAuditResult(result: AuditResult): string {
  const lines = [
    result.ok ? "Agent Memory audit passed." : "Agent Memory audit failed.",
    "",
    `Changed files: ${result.changedFiles.length}`,
    `Findings: ${result.findings.length}`
  ];

  if (result.findings.length > 0) {
    lines.push("", "Findings:");

    for (const finding of result.findings) {
      lines.push(...renderFinding(finding));
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function renderFinding(finding: AuditFinding): string[] {
  return [
    `- ${finding.code}: ${finding.message}`,
    `  Claims: ${finding.claimIds.length > 0 ? finding.claimIds.join(", ") : "none"}`,
    `  Paths: ${finding.paths.length > 0 ? finding.paths.join(", ") : "none"}`,
    `  Remediation: ${finding.remediation}`
  ];
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
