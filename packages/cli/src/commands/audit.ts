import { auditMemoryV2, type AuditResultV2 } from "../../../core/src/audit_v2";
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
  strict: boolean;
  formatVersion?: 1 | 2;
}

export async function runVersionedAuditCommand(args: string[], context: AuditCommandContext = {}): Promise<AuditCommandResult> {
  const options = parseAuditArgs(args);
  const result = await (options.formatVersion === 2 ? auditMemoryV2 : auditMemory)({
    cwd: context.cwd,
    changedFiles: options.changedFiles,
    gitDiff: options.gitDiff,
    baseRef: options.baseRef,
    strict: options.strict
  });

  return {
    exitCode: result.ok ? 0 : 6,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderAuditResult(result)
  };
}

export function runAuditCommand(args: string[], context: AuditCommandContext = {}): AuditCommandResult {
  const options = parseAuditArgs(args);
  if (options.formatVersion === 2) throw new AgentMemoryError("Use runVersionedAuditCommand for asynchronous v2 audits.");
  const result = auditMemory({ cwd: context.cwd, changedFiles: options.changedFiles, gitDiff: options.gitDiff,
    baseRef: options.baseRef, strict: options.strict });
  return { exitCode: result.ok ? 0 : 6, stdout: options.json ? JSON.stringify(result, null, 2) : renderAuditResult(result) };
}

function parseAuditArgs(args: string[]): AuditCommandOptions {
  const options: AuditCommandOptions = {
    changedFiles: [],
    gitDiff: false,
    json: false,
    strict: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--format-version" || arg.startsWith("--format-version=")) {
      const value = arg === "--format-version" ? readValue(args, index++, arg) : arg.slice("--format-version=".length);
      if (value !== "1" && value !== "2") throw new AgentMemoryError("audit --format-version must be 1 or 2.");
      options.formatVersion = Number(value) as 1 | 2;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--git-diff") {
      options.gitDiff = true;
      continue;
    }

    if (arg === "--strict") {
      options.strict = true;
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

  if (options.formatVersion !== 2 && options.changedFiles.length === 0 && !options.gitDiff) {
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

function renderAuditResult(result: AuditResult | AuditResultV2): string {
  const counts = {
    error: result.findings.filter((finding) => finding.severity === "error").length,
    warning: result.findings.filter((finding) => finding.severity === "warning").length,
    info: result.findings.filter((finding) => finding.severity === "info").length
  };
  const lines = [
    result.ok ? "Agent Memory audit passed." : "Agent Memory audit failed.",
    "",
    `Changed files: ${result.changedFiles.length}`,
    `Findings: ${result.findings.length} (${counts.error} errors, ${counts.warning} warnings, ${counts.info} info)`
  ];

  if ("schemaVersion" in result) {
    lines.push(`Structure: ${result.structure.state}`, `Cache: ${result.cache.state}`);
    for (const dimension of [result.structure, result.cache]) {
      for (const diagnostic of dimension.diagnostics) {
        lines.push(`${diagnostic.code}: ${diagnostic.message}`);
        if (diagnostic.path) lines.push(`  Source: ${JSON.stringify(diagnostic.path)}`);
        if (diagnostic.id) lines.push(`  Claim: ${JSON.stringify(diagnostic.id)}`);
        lines.push(`  Remediation: ${diagnostic.remediation}`);
      }
    }
    for (const claim of result.claims) {
      lines.push(`${claim.id}: verificationMetadata=${claim.verificationMetadata}; verificationCheck=${claim.verificationCheck}`);
      if (claim.diagnostic) lines.push(`  ${claim.diagnostic.code}: ${claim.diagnostic.message}`, `  Remediation: ${claim.diagnostic.remediation}`);
      for (const signal of claim.qualitySignals) lines.push(`  [advisory] ${signal.code} ${signal.field}=${JSON.stringify(signal.text)}`);
    }
  }

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
  const lines = [
    `- [${finding.severity}] ${finding.code}: ${finding.message}`,
    `  Claims: ${finding.claimIds.length > 0 ? finding.claimIds.join(", ") : "none"}`,
    `  Paths: ${finding.paths.length > 0 ? finding.paths.join(", ") : "none"}`
  ];

  const sharedValues = Object.entries(finding.shared_values);

  if (sharedValues.length > 0) {
    lines.push(`  Shared values: ${sharedValues.map(([field, values]) => `${field}=${values.join(",")}`).join("; ")}`);
  }

  lines.push(`  Remediation: ${finding.remediation}`);
  return lines;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
