import { AgentMemoryError } from "../../../core/src/errors";
import {
  installAgentSkill,
  parseAgentSkillKind,
  parseAgentTarget,
  type AgentSkillKind,
  type AgentTarget,
  type SkillInstallResult
} from "../../../core/src/skills";
import type { ExitCode } from "../../../core/src/types";

export interface InstallSkillCommandContext {
  cwd?: string;
}

export interface InstallSkillCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface InstallSkillCommandOptions {
  agent?: AgentTarget;
  kind: AgentSkillKind;
  force: boolean;
  installLocation?: string;
  installPath?: string;
  json: boolean;
}

export function runInstallSkillCommand(args: string[], context: InstallSkillCommandContext = {}): InstallSkillCommandResult {
  const options = parseInstallSkillArgs(args);

  if (!options.agent) {
    throw new AgentMemoryError("install-skill requires --agent.", {
      details: ["Expected one of: codex, generic"]
    });
  }

  const result = installAgentSkill({
    cwd: context.cwd,
    agent: options.agent,
    kind: options.kind,
    force: options.force,
    installLocation: options.installLocation,
    installPath: options.installPath
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderInstallSkillResult(result)
  };
}

function parseInstallSkillArgs(args: string[]): InstallSkillCommandOptions {
  const options: InstallSkillCommandOptions = {
    kind: "repo",
    force: false,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--kind") {
      options.kind = parseAgentSkillKind(readValue(args, index, "--kind"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--kind=")) {
      options.kind = parseAgentSkillKind(arg.slice("--kind=".length));
      continue;
    }

    if (arg === "--location") {
      options.installLocation = readValue(args, index, "--location");
      index += 1;
      continue;
    }

    if (arg.startsWith("--location=")) {
      options.installLocation = arg.slice("--location=".length);
      continue;
    }

    if (arg === "--path") {
      options.installPath = readValue(args, index, "--path");
      index += 1;
      continue;
    }

    if (arg.startsWith("--path=")) {
      options.installPath = arg.slice("--path=".length);
      continue;
    }

    if (arg === "--agent") {
      options.agent = parseAgentTarget(readValue(args, index, "--agent"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--agent=")) {
      options.agent = parseAgentTarget(arg.slice("--agent=".length));
      continue;
    }

    throw new AgentMemoryError(`Unknown install-skill option: ${arg}`, {
      details: ["Run `agent-memory help install-skill` for usage."]
    });
  }

  if (options.installLocation && options.installPath) {
    throw new AgentMemoryError("install-skill accepts either --location or --path, not both.");
  }

  return options;
}

function renderInstallSkillResult(result: SkillInstallResult): string {
  const lines = [
    "Agent Memory skill installed.",
    "",
    `Repo root: ${result.repo.root}`,
    `Agent: ${result.agent}`,
    `Kind: ${result.kind}`,
    `Command prefix: ${result.commandPrefix}`
  ];

  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  lines.push("", "Files:");

  for (const action of result.actions) {
    const detail = action.detail ? ` (${action.detail})` : "";
    lines.push(`  ${action.status.padEnd(11)} ${action.path}${detail}`);
  }

  return lines.join("\n");
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
