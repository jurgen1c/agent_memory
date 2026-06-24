import { AgentMemoryError } from "../../../core/src/errors";
import { installMemoryHooks, type HookInstallResult } from "../../../core/src/hooks";
import type { ExitCode } from "../../../core/src/types";

export interface InstallHooksCommandContext {
  cwd?: string;
}

export interface InstallHooksCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export function runInstallHooksCommand(args: string[], context: InstallHooksCommandContext = {}): InstallHooksCommandResult {
  const options = parseInstallHooksArgs(args);
  const result = installMemoryHooks({
    cwd: context.cwd,
    force: options.force
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderInstallHooksResult(result)
  };
}

function parseInstallHooksArgs(args: string[]): { force: boolean; json: boolean } {
  let force = false;
  let json = false;

  for (const arg of args) {
    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown install-hooks option: ${arg}`, {
      details: ["Run `agent-memory help install-hooks` for usage."]
    });
  }

  return { force, json };
}

function renderInstallHooksResult(result: HookInstallResult): string {
  const lines = ["Agent Memory hooks installed.", "", `Repo root: ${result.repo.root}`];

  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  lines.push("", "Hooks:");

  for (const action of result.actions) {
    const detail = action.detail ? ` (${action.detail})` : "";
    lines.push(`  ${action.status.padEnd(11)} ${action.path}${detail}`);
  }

  return lines.join("\n");
}
