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
  let skillLocation: string | undefined;
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
      packageManager = parseInitPackageManager(readValue(args, index, "--package-manager"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--package-manager=")) {
      packageManager = parseInitPackageManager(arg.slice("--package-manager=".length));
      continue;
    }

    if (arg === "--agent") {
      agents.push(parseInitAgent(readValue(args, index, "--agent")));
      index += 1;
      continue;
    }

    if (arg.startsWith("--agent=")) {
      agents.push(parseInitAgent(arg.slice("--agent=".length)));
      continue;
    }

    if (arg === "--skill-location" || arg === "--location") {
      skillLocation = readValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--skill-location=")) {
      skillLocation = readInlineValue(arg, "--skill-location");
      continue;
    }

    if (arg.startsWith("--location=")) {
      skillLocation = readInlineValue(arg, "--location");
      continue;
    }

    throw new AgentMemoryError(`Unknown init option: ${arg}`, {
      details: ["Run `agent-memory help init` for usage."]
    });
  }

  const uniqueAgents = Array.from(new Set(agents));

  if (skillLocation !== undefined && uniqueAgents.length !== 1) {
    throw new AgentMemoryError("--skill-location requires exactly one --agent target.", {
      details: ["Example: agent-memory init --yes --agent codex --skill-location .agents"]
    });
  }

  return {
    cwd,
    yes,
    force,
    packageManager,
    agents: uniqueAgents,
    installHooks,
    skillLocation
  };
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}

function readInlineValue(arg: string, option: string): string {
  const value = arg.slice(`${option}=`.length);

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
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
