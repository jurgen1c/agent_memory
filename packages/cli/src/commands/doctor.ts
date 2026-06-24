import { doctorMemory, type DoctorCheck, type DoctorResult } from "../../../core/src/doctor";
import type { ExitCode } from "../../../core/src/types";
import { AgentMemoryError } from "../../../core/src/errors";

export interface DoctorCommandContext {
  cwd?: string;
}

export interface DoctorCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export async function runDoctorCommand(args: string[], context: DoctorCommandContext = {}): Promise<DoctorCommandResult> {
  const json = parseDoctorArgs(args);
  const result = await doctorMemory({ cwd: context.cwd });

  return {
    exitCode: result.healthy ? 0 : 5,
    stdout: json ? JSON.stringify(result, null, 2) : renderDoctorResult(result)
  };
}

function parseDoctorArgs(args: string[]): boolean {
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown doctor option: ${arg}`, {
      details: ["Run `agent-memory help doctor` for usage."]
    });
  }

  return json;
}

function renderDoctorResult(result: DoctorResult): string {
  const lines = [
    result.healthy ? "Agent Memory doctor passed." : "Agent Memory doctor found warnings.",
    "",
    `Database: ${result.databasePath}`,
    "",
    "Checks:"
  ];

  for (const check of result.checks) {
    lines.push(renderCheck(check));
  }

  return lines.join("\n");
}

function renderCheck(check: DoctorCheck): string {
  const prefix = check.status === "ok" ? "OK" : "WARN";
  const remediation = check.remediation ? ` Remediation: ${check.remediation}` : "";
  return `- [${prefix}] ${check.name}: ${check.message}${remediation}`;
}
