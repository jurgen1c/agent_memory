import { AgentMemoryError } from "../../../core/src/errors";
import {
  migrateDocs,
  missingMigrationSystemError,
  type MigratedDocPlan,
  type MigrateDocsResult,
  type MigrationMode
} from "../../../core/src/migration";
import type { ExitCode } from "../../../core/src/types";

export interface MigrateDocsCommandContext {
  cwd?: string;
}

export interface MigrateDocsCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface MigrateDocsCommandOptions {
  fromPath?: string;
  system?: string;
  mode: MigrationMode;
  force: boolean;
  json: boolean;
}

export function runMigrateDocsCommand(args: string[], context: MigrateDocsCommandContext = {}): MigrateDocsCommandResult {
  const options = parseMigrateDocsArgs(args);

  if (!options.fromPath) {
    throw new AgentMemoryError("migrate-docs requires --from.");
  }

  if (!options.system) {
    throw missingMigrationSystemError(options.fromPath);
  }

  const result = migrateDocs({
    cwd: context.cwd,
    fromPath: options.fromPath,
    system: options.system,
    mode: options.mode,
    force: options.force
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderMigrateDocsResult(result)
  };
}

function parseMigrateDocsArgs(args: string[]): MigrateDocsCommandOptions {
  const options: MigrateDocsCommandOptions = {
    mode: "plan",
    force: false,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--automatic" || arg === "--auto") {
      options.mode = "automatic";
      continue;
    }

    if (arg === "--from") {
      options.fromPath = readValue(args, index, "--from");
      index += 1;
      continue;
    }

    if (arg.startsWith("--from=")) {
      options.fromPath = arg.slice("--from=".length);
      continue;
    }

    if (arg === "--system") {
      options.system = readValue(args, index, "--system");
      index += 1;
      continue;
    }

    if (arg.startsWith("--system=")) {
      options.system = arg.slice("--system=".length);
      continue;
    }

    throw new AgentMemoryError(`Unknown migrate-docs option: ${arg}`, {
      details: ["Run `agent-memory help migrate-docs` for usage."]
    });
  }

  return options;
}

function renderMigrateDocsResult(result: MigrateDocsResult): string {
  const created = result.docs.filter((doc) => doc.status === "created" || doc.status === "overwritten").length;
  const lines = [
    result.mode === "automatic" ? "Agent Memory docs migration drafts created." : "Agent Memory docs migration plan.",
    "",
    `Source: ${result.sourceRoot}`,
    `System: ${result.system}`,
    `Docs: ${result.docs.length}`,
    `Drafts created: ${created}`
  ];

  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  if (result.docs.length > 0) {
    lines.push("", result.mode === "automatic" ? "Drafts:" : "Planned drafts:");

    for (const doc of result.docs) {
      lines.push(...renderDoc(doc));
    }
  }

  if (result.mode === "plan") {
    lines.push("", "Next:", `  agent-memory migrate-docs --from ${result.sourceRoot} --system ${result.system} --automatic`);
  }

  return lines.join("\n");
}

function renderDoc(doc: MigratedDocPlan): string[] {
  const detail = doc.detail ? ` (${doc.detail})` : "";
  return [`- ${doc.sourcePath}`, `  ${doc.status}${detail}: ${doc.targetPath}`, `  id: ${doc.suggestedId}`];
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
