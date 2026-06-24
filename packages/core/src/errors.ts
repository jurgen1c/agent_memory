import type { ExitCode } from "./types";

export interface AgentMemoryErrorOptions {
  code?: string;
  exitCode?: ExitCode;
  details?: string[];
  cause?: unknown;
}

export class AgentMemoryError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details: string[];
  override readonly cause?: unknown;

  constructor(message: string, options: AgentMemoryErrorOptions = {}) {
    super(message);
    this.name = "AgentMemoryError";
    this.code = options.code ?? "AGENT_MEMORY_ERROR";
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details ?? [];
    this.cause = options.cause;
  }
}

export class ConfigError extends AgentMemoryError {
  constructor(message: string, options: Omit<AgentMemoryErrorOptions, "code" | "exitCode"> = {}) {
    super(message, {
      ...options,
      code: "CONFIG_ERROR",
      exitCode: 3
    });
    this.name = "ConfigError";
  }
}

export class NotFoundError extends AgentMemoryError {
  constructor(message: string, options: Omit<AgentMemoryErrorOptions, "code" | "exitCode"> = {}) {
    super(message, {
      ...options,
      code: "NOT_FOUND",
      exitCode: 7
    });
    this.name = "NotFoundError";
  }
}

export function toAgentMemoryError(error: unknown): AgentMemoryError {
  if (error instanceof AgentMemoryError) {
    return error;
  }

  if (error instanceof Error) {
    return new AgentMemoryError(error.message, { cause: error });
  }

  return new AgentMemoryError(String(error));
}

export function formatError(error: AgentMemoryError): string {
  const lines = [`Error [${error.code}]: ${error.message}`];

  for (const detail of error.details) {
    lines.push(`- ${detail}`);
  }

  return lines.join("\n");
}
