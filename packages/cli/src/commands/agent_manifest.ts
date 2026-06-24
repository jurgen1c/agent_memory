import { buildAgentManifest, type AgentManifest } from "../../../core/src/manifest";
import { AgentMemoryError } from "../../../core/src/errors";
import type { ExitCode } from "../../../core/src/types";

export interface AgentManifestCommandContext {
  cwd?: string;
}

export interface AgentManifestCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export function runAgentManifestCommand(args: string[], context: AgentManifestCommandContext = {}): AgentManifestCommandResult {
  const json = parseAgentManifestArgs(args);
  const result = buildAgentManifest({ cwd: context.cwd });

  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(result, null, 2) : renderAgentManifest(result)
  };
}

function parseAgentManifestArgs(args: string[]): boolean {
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown agent-manifest option: ${arg}`, {
      details: ["Run `agent-memory help agent-manifest` for usage."]
    });
  }

  return json;
}

function renderAgentManifest(result: AgentManifest): string {
  return JSON.stringify(result, null, 2);
}
