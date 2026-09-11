import { planRetrievalAdoption, applyRetrievalAdoption } from "../../../core/src/retrieval_adoption";
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
  adopt?: boolean;
  defaultFormatVersion?: 1 | 2;
  formatVersion?: string;
}

export function runUpgradeCommand(args: string[], context: UpgradeCommandContext = {}): UpgradeCommandResult {
  const versioned = args.some(arg => arg === "--adopt-retrieval" || arg.startsWith("--format-version") || arg.startsWith("--default-format-version"));
  try {
  const options = parseUpgradeArgs(args);
  if (options.adopt) {
    const plan = planRetrievalAdoption({ cwd: context.cwd, force: options.force, defaultFormatVersion: options.defaultFormatVersion });
    const result = options.write ? applyRetrievalAdoption(plan) : plan;
    const defaultFlag = options.defaultFormatVersion === undefined ? "" : ` --default-format-version ${options.defaultFormatVersion}`;
    const next = options.write ? "agent-memory validate; then agent-memory compile, followed by representative retrieval probes"
      : `agent-memory upgrade --adopt-retrieval --format-version 2${defaultFlag}${options.force ? " --force" : ""} --write`;
    const defaults = result.adoption.defaultFormatVersion;
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result) : `${renderUpgradeResult(result, false)}\n\nAdoption: ${result.adoption.claims.length} claims; ${result.adoption.mode}; verification not_run.\nCLI default: ${defaults.before} -> ${defaults.after}. Canonical claims unchanged.\nReview ${result.adoption.guidance.join(", ") || "packaged docs/features/category-retrieval/adoption.md"}.\nNext: ${next}` };
  }
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
  } catch (error) {
    if (!versioned) throw error;
    const typed = error instanceof AgentMemoryError ? error : new AgentMemoryError(String(error), { code: "VALIDATION_FAILED", exitCode: 4 });
    return { exitCode: typed.code === "AGENT_MEMORY_ERROR" ? 2 : typed.exitCode, stdout: JSON.stringify({ schemaVersion: 2, error: { code: typed.code === "AGENT_MEMORY_ERROR" ? "INVALID_INPUT" : typed.code, message: typed.message, ...(typed.details.length ? { details: typed.details } : {}) } }) };
  }
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
    if (arg === "--default-format-version" || arg.startsWith("--default-format-version=")) {
      if (options.defaultFormatVersion !== undefined) throw usage("--default-format-version may appear only once.");
      const value = arg.includes("=") ? arg.slice("--default-format-version=".length) : args[++index];
      if (value !== "1" && value !== "2") throw usage("--default-format-version must be 1 or 2.");
      options.defaultFormatVersion = Number(value) as 1 | 2;
      continue;
    }
    if (arg === "--adopt-retrieval") { if (options.adopt) throw usage("--adopt-retrieval may appear only once."); options.adopt = true; continue; }
    if (arg === "--format-version" || arg.startsWith("--format-version=")) {
      if (options.formatVersion !== undefined) throw usage("--format-version may appear only once.");
      options.formatVersion = arg.includes("=") ? arg.slice(17) : args[++index];
      if (!["1", "2"].includes(options.formatVersion ?? "")) throw usage("Supported format versions are 1 and 2.");
      continue;
    }
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

  if (options.defaultFormatVersion !== undefined && !options.adopt) throw usage("--default-format-version requires --adopt-retrieval --format-version 2.");
  if (options.adopt && options.global) throw usage("Run --global migration separately from --adopt-retrieval.", "INCOMPATIBLE_OPTIONS");
  if (options.adopt && options.formatVersion !== "2") throw usage("Adoption requires --format-version 2.", "FORMAT_VERSION_REQUIRED");
  if (options.formatVersion === "2" && !options.adopt) throw usage("upgrade --format-version 2 requires --adopt-retrieval.");
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

function renderUpgradeResult(result: UpgradeResult, includeNext = true): string {
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

  if (!result.write && includeNext) {
    lines.push("", "Next:");
    lines.push("  agent-memory upgrade --write");
  }

  return lines.join("\n");
}

function usage(message: string, code = "INVALID_INPUT"): AgentMemoryError { return new AgentMemoryError(message, { code, exitCode: 2 }); }
