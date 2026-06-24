import { AgentMemoryError } from "../../../core/src/errors";
import { startUiServer, type UiServerHandle } from "../../../core/src/ui_server";
import type { ExitCode } from "../../../core/src/types";

export interface UiCommandContext {
  cwd?: string;
}

export interface UiCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface UiCommandOptions {
  host: string;
  port: number;
  json: boolean;
}

export async function runUiCommand(args: string[], context: UiCommandContext = {}): Promise<UiCommandResult> {
  const options = parseUiArgs(args);
  const server = await startUiServer({
    cwd: context.cwd,
    host: options.host,
    port: options.port
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(renderJson(server), null, 2) : renderUiResult(server)
  };
}

function parseUiArgs(args: string[]): UiCommandOptions {
  const options: UiCommandOptions = {
    host: "127.0.0.1",
    port: 4317,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--host") {
      options.host = readValue(args, index, "--host");
      index += 1;
      continue;
    }

    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--port") {
      options.port = parsePort(readValue(args, index, "--port"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
      continue;
    }

    throw new AgentMemoryError(`Unknown ui option: ${arg}`, {
      details: ["Run `agent-memory help ui` for usage."]
    });
  }

  return options;
}

function renderUiResult(server: UiServerHandle): string {
  return [
    "Agent Memory UI running.",
    "",
    `URL: ${server.url}`,
    `Host: ${server.host}`,
    `Port: ${server.port}`,
    `Session token: ${server.token}`,
    `Static assets: ${server.staticRoot}`,
    "",
    "Keep this process running while using the UI."
  ].join("\n");
}

function renderJson(server: UiServerHandle): Record<string, unknown> {
  return {
    url: server.url,
    host: server.host,
    port: server.port,
    token: server.token,
    staticRoot: server.staticRoot
  };
}

function parsePort(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AgentMemoryError(`Invalid ui port: ${value}`, {
      details: ["Expected an integer from 0 to 65535."]
    });
  }

  return port;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
