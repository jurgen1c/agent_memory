import { AgentMemoryError, formatError, NotFoundError, toAgentMemoryError } from "../../core/src/errors";
import type { ExitCode } from "../../core/src/types";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../core/src/version";
import { runCompileCommand } from "./commands/compile";
import { runContextCommand } from "./commands/context";
import { runCoverageCommand } from "./commands/coverage";
import { runDoctorCommand } from "./commands/doctor";
import { renderHelp } from "./commands/help";
import { runInstallHooksCommand } from "./commands/install_hooks";
import { runInitCommand } from "./commands/init";
import { runNewCommand } from "./commands/new";
import { runQueryCommand } from "./commands/query";
import { runShowCommand } from "./commands/show";
import { runSystemCommand } from "./commands/system";
import { runSyncCommand } from "./commands/sync";
import { runTemplatesCommand } from "./commands/templates";
import { runValidateCommand } from "./commands/validate";

export interface CliStreams {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliResult {
  exitCode: ExitCode;
  stdout?: string;
  stderr?: string;
}

export interface CliContext {
  cwd?: string;
}

export async function runCli(args: string[], streams: CliStreams = process, context: CliContext = {}): Promise<ExitCode> {
  try {
    const result = await dispatch(args, context);

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

export async function dispatch(args: string[], context: CliContext = {}): Promise<CliResult> {
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

  if (command === "init") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("init")
      };
    }

    return {
      exitCode: 0,
      stdout: runInitCommand(rest, { cwd: context.cwd })
    };
  }

  if (command === "templates") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("templates")
      };
    }

    return {
      exitCode: 0,
      stdout: runTemplatesCommand(rest, context.cwd)
    };
  }

  if (command === "validate") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("validate")
      };
    }

    return runValidateCommand(rest, { cwd: context.cwd });
  }

  if (command === "compile") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("compile")
      };
    }

    return runCompileCommand(rest, { cwd: context.cwd });
  }

  if (command === "query") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("query")
      };
    }

    return runQueryCommand(rest, { cwd: context.cwd });
  }

  if (command === "show") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("show")
      };
    }

    return runShowCommand(rest, { cwd: context.cwd });
  }

  if (command === "system") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("system")
      };
    }

    return runSystemCommand(rest, { cwd: context.cwd });
  }

  if (command === "context") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("context")
      };
    }

    return runContextCommand(rest, { cwd: context.cwd });
  }

  if (command === "coverage") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("coverage")
      };
    }

    return runCoverageCommand(rest, { cwd: context.cwd });
  }

  if (command === "doctor") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("doctor")
      };
    }

    return runDoctorCommand(rest, { cwd: context.cwd });
  }

  if (command === "sync") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("sync")
      };
    }

    return runSyncCommand(rest, { cwd: context.cwd });
  }

  if (command === "install-hooks") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("install-hooks")
      };
    }

    return runInstallHooksCommand(rest, { cwd: context.cwd });
  }

  if (command === "new") {
    if (rest.includes("--help") || rest.includes("-h")) {
      return {
        exitCode: 0,
        stdout: renderHelp("new")
      };
    }

    return {
      exitCode: 0,
      stdout: await runNewCommand(rest, { cwd: context.cwd })
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
