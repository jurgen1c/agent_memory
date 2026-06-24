import { AgentMemoryError, formatError, NotFoundError, toAgentMemoryError } from "../../core/src/errors";
import type { ExitCode } from "../../core/src/types";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../core/src/version";
import { renderHelp } from "./commands/help";

export interface CliStreams {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliResult {
  exitCode: ExitCode;
  stdout?: string;
  stderr?: string;
}

export async function runCli(args: string[], streams: CliStreams = process): Promise<ExitCode> {
  try {
    const result = await dispatch(args);

    if (result.stdout) {
      streams.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    }

    if (result.stderr) {
      streams.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    }

    return result.exitCode;
  } catch (error) {
    const agentMemoryError = toAgentMemoryError(error);
    streams.stderr.write(`${formatError(agentMemoryError)}\n`);
    return agentMemoryError.exitCode;
  }
}

export async function dispatch(args: string[]): Promise<CliResult> {
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return {
      exitCode: 0,
      stdout: renderHelp(command === "help" ? rest[0] : undefined)
    };
  }

  if (command === "--version" || command === "-v" || command === "version") {
    return {
      exitCode: 0,
      stdout: `${PACKAGE_NAME} ${PACKAGE_VERSION}`
    };
  }

  throw new NotFoundError(`Unknown command: ${command}`, {
    details: ["Run `agent-memory help` to see available commands."]
  });
}

export function assertNoArgs(command: string, args: string[]): void {
  if (args.length > 0) {
    throw new AgentMemoryError(`Unexpected arguments for ${command}: ${args.join(" ")}`);
  }
}
