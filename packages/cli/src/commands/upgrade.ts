import { AgentMemoryError } from "../../../core/src/errors";
import {
  migrateRepositoryToGlobal,
  type GlobalMigrationResult
} from "../../../core/src/global_migration";
import { upgradeRepository, type UpgradeResult } from "../../../core/src/upgrade";
import type { ExitCode } from "../../../core/src/types";

export interface UpgradeCommandContext {
  cwd?: string;
}

export interface UpgradeCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface UpgradeCommandOptions {
  write: boolean;
  force: boolean;
  json: boolean;
  global: boolean;
  memoryKey?: string;
}

export function runUpgradeCommand(args: string[], context: UpgradeCommandContext = {}): UpgradeCommandResult {
  const options = parseUpgradeArgs(args);
  if (options.global) {
    const result = migrateRepositoryToGlobal({
      cwd: context.cwd,
      write: options.write,
      force: options.force,
      memoryKey: options.memoryKey
    });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result, null, 2) : renderGlobalMigrationResult(result)
    };
  }

  const result = upgradeRepository({
    cwd: context.cwd,
    write: options.write,
    force: options.force
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderUpgradeResult(result)
  };
}

function parseUpgradeArgs(args: string[]): UpgradeCommandOptions {
  const options: UpgradeCommandOptions = {
    write: false,
    force: false,
    json: false,
    global: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") {
      options.write = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.write = false;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--global") {
      options.global = true;
      continue;
    }

    if (arg === "--memory-key") {
      const value = args[index + 1];
      if (!value) throw new AgentMemoryError("--memory-key requires a value.");
      options.memoryKey = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--memory-key=")) {
      const value = arg.slice("--memory-key=".length);
      if (!value) throw new AgentMemoryError("--memory-key requires a value.");
      options.memoryKey = value;
      continue;
    }

    throw new AgentMemoryError(`Unknown upgrade option: ${arg}`, {
      details: ["Run `agent-memory help upgrade` for usage."]
    });
  }

  if (options.memoryKey !== undefined && !options.global) {
    throw new AgentMemoryError("--memory-key requires --global.", {
      details: ["Use `agent-memory upgrade --global --memory-key <key>`."]
    });
  }

  return options;
}

function renderGlobalMigrationResult(result: GlobalMigrationResult): string {
  const lines = [
    result.write ? "Agent Memory global migration applied." : "Agent Memory global migration dry run.",
    "",
    `Repo root: ${result.repo.root}`,
    `Mode: ${result.write ? "write" : "dry-run"}`,
    `Memory key: ${result.memoryKey}`,
    `Already global: ${result.alreadyGlobal ? "yes" : "no"}`,
    `Wrapper: ${result.wrapper.classification} (preserved)`
  ];

  if (result.force) lines.push("Force: true");
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);

  lines.push("", "Files:");
  for (const action of result.actions) {
    lines.push(`  ${action.status.padEnd(13)} ${action.path} (${action.detail})`);
  }

  lines.push("", "Next:");
  for (const command of result.nextCommands) lines.push(`  ${command}`);
  if (result.cleanupGuidance) lines.push("", `Optional cleanup: ${result.cleanupGuidance}`);
  return lines.join("\n");
}

function renderUpgradeResult(result: UpgradeResult): string {
  const lines = [
    result.write ? "Agent Memory upgrade applied." : "Agent Memory upgrade dry run.",
    "",
    `Repo root: ${result.repo.root}`,
    `Mode: ${result.write ? "write" : "dry-run"}`
  ];

  if (result.force) {
    lines.push("Force: true");
  }

  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  lines.push("", "Files:");

  for (const action of result.actions) {
    const detail = action.detail ? ` (${action.detail})` : "";
    lines.push(`  ${action.status.padEnd(13)} ${action.path}${detail}`);
  }

  if (!result.write) {
    lines.push("", "Next:");
    lines.push("  agent-memory upgrade --write");
  }

  return lines.join("\n");
}
