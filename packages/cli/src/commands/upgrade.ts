import path from "node:path";
import { AgentMemoryError } from "../../../core/src/errors";
import { commandPrefixForRepo } from "../../../core/src/skills";
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
}

export function runUpgradeCommand(args: string[], context: UpgradeCommandContext = {}): UpgradeCommandResult {
  const options = parseUpgradeArgs(args);
  const result = upgradeRepository({
    cwd: context.cwd,
    write: options.write,
    force: options.force
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderUpgradeResult(result, context.cwd)
  };
}

function parseUpgradeArgs(args: string[]): UpgradeCommandOptions {
  const options: UpgradeCommandOptions = {
    write: false,
    force: false,
    json: false
  };

  for (const arg of args) {
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

    throw new AgentMemoryError(`Unknown upgrade option: ${arg}`, {
      details: ["Run `agent-memory help upgrade` for usage."]
    });
  }

  return options;
}

function renderUpgradeResult(result: UpgradeResult, cwd = process.cwd()): string {
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
    lines.push(`  ${upgradeWriteCommand(result.repo.root, cwd)} upgrade --write`);
  }

  return lines.join("\n");
}

function upgradeWriteCommand(repoRoot: string, cwd: string): string {
  const commandPrefix = commandPrefixForRepo(repoRoot);

  if (commandPrefix !== "bin/memory") {
    return commandPrefix;
  }

  const relativeWrapperPath = path.relative(path.resolve(cwd), path.join(repoRoot, "bin/memory"));
  return relativeWrapperPath.length > 0 ? relativeWrapperPath : commandPrefix;
}
