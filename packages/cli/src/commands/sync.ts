import { syncMemory, type SyncResult } from "../../../core/src/sync";
import type { ExitCode } from "../../../core/src/types";
import { AgentMemoryError } from "../../../core/src/errors";

export interface SyncCommandContext {
  cwd?: string;
}

export interface SyncCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export async function runSyncCommand(args: string[], context: SyncCommandContext = {}): Promise<SyncCommandResult> {
  const json = parseSyncArgs(args);
  const result = await syncMemory({ cwd: context.cwd });

  return {
    exitCode: result.doctor.healthy ? 0 : 5,
    stdout: json ? JSON.stringify(result, null, 2) : renderSyncResult(result)
  };
}

function parseSyncArgs(args: string[]): boolean {
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown sync option: ${arg}`, {
      details: ["Run `agent-memory help sync` for usage."]
    });
  }

  return json;
}

function renderSyncResult(result: SyncResult): string {
  return [
    "Agent Memory synced.",
    "",
    `Database: ${result.compile.databasePath}`,
    `Claims: ${result.compile.counts.claims}`,
    `Relations: ${result.compile.counts.explicitRelations + result.compile.counts.inferredRelations}`,
    `Validation: ${result.validation.valid ? "passed" : "failed"}`,
    `Doctor: ${result.doctor.healthy ? "passed" : "warnings"}`
  ].join("\n");
}
