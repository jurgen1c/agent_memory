import {
  initRepository,
  parseInitAgent,
  parseInitPackageManager,
  type InitOptions,
  type InitResult,
  type PackageManager
} from "../../../core/src/init";
import { AgentMemoryError } from "../../../core/src/errors";
import type { AgentTarget } from "../../../core/src/skills";

export interface InitCommandContext {
  cwd?: string;
}

export function runInitCommand(args: string[], context: InitCommandContext = {}): string {
  const options = parseInitArgs(args, context.cwd);
  const result = initRepository(options);
  return renderInitResult(result);
}

function parseInitArgs(args: string[], cwd?: string): InitOptions {
  let yes = false;
  let force = false;
  let packageManager: PackageManager = "npm";
  let installHooks = false;
  const agents: AgentTarget[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--install-hooks") {
      installHooks = true;
      continue;
    }

    if (arg === "--package-manager") {
      const value = args[index + 1];

      if (!value) {
        throw new AgentMemoryError("--package-manager requires a value.");
      }

      packageManager = parseInitPackageManager(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--package-manager=")) {
      packageManager = parseInitPackageManager(arg.slice("--package-manager=".length));
      continue;
    }

    if (arg === "--agent") {
      const value = args[index + 1];

      if (!value) {
        throw new AgentMemoryError("--agent requires a value.");
      }

      agents.push(parseInitAgent(value));
      index += 1;
      continue;
    }

    if (arg.startsWith("--agent=")) {
      agents.push(parseInitAgent(arg.slice("--agent=".length)));
      continue;
    }

    throw new AgentMemoryError(`Unknown init option: ${arg}`, {
      details: ["Run `agent-memory help init` for usage."]
    });
  }

  return {
    cwd,
    yes,
    force,
    packageManager,
    agents: Array.from(new Set(agents)),
    installHooks
  };
}

function renderInitResult(result: InitResult): string {
  const lines = ["Agent Memory initialized.", "", `Repo root: ${result.repo.root}`];

  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  lines.push("", "Files:");

  for (const action of result.actions) {
    const detail = action.detail ? ` (${action.detail})` : "";
    lines.push(`  ${action.status.padEnd(11)} ${action.path}${detail}`);
  }

  lines.push("", "Next:");
  lines.push("  bin/memory help");
  lines.push("  bin/memory sync");

  return lines.join("\n");
}
