import { AgentMemoryError } from "../../../core/src/errors";
import { queryClaims, type QueryResult } from "../../../core/src/retrieval";
import type { ExitCode } from "../../../core/src/types";

export interface QueryCommandContext {
  cwd?: string;
}

export interface QueryCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface QueryCommandOptions {
  query: string;
  json: boolean;
  limit: number;
  system?: string;
  status?: string;
  includeStale: boolean;
}

export async function runQueryCommand(args: string[], context: QueryCommandContext = {}): Promise<QueryCommandResult> {
  const options = parseQueryArgs(args);
  const result = await queryClaims({
    cwd: context.cwd,
    query: options.query,
    limit: options.limit,
    system: options.system,
    status: options.status,
    includeStale: options.includeStale
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderQueryResult(options.query, result)
  };
}

function parseQueryArgs(args: string[]): QueryCommandOptions {
  let query: string | undefined;
  let json = false;
  let limit = 10;
  let system: string | undefined;
  let status: string | undefined;
  let includeStale = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--include-stale") {
      includeStale = true;
      continue;
    }

    if (arg === "--limit") {
      limit = parsePositiveInteger(readValue(args, index, "--limit"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInteger(arg.slice("--limit=".length));
      continue;
    }

    if (arg === "--system") {
      system = readValue(args, index, "--system");
      index += 1;
      continue;
    }

    if (arg.startsWith("--system=")) {
      system = arg.slice("--system=".length);
      continue;
    }

    if (arg === "--status") {
      status = readValue(args, index, "--status");
      index += 1;
      continue;
    }

    if (arg.startsWith("--status=")) {
      status = arg.slice("--status=".length);
      continue;
    }

    if (arg.startsWith("--")) {
      throw new AgentMemoryError(`Unknown query option: ${arg}`, {
        details: ["Run `agent-memory help query` for usage."]
      });
    }

    query = query ? `${query} ${arg}` : arg;
  }

  if (!query || query.trim().length === 0) {
    throw new AgentMemoryError("query requires search text.", {
      details: ['Example: agent-memory query "student oauth tenant"']
    });
  }

  return { query, json, limit, system, status, includeStale };
}

function renderQueryResult(query: string, result: QueryResult): string {
  const lines = [`# Query Results`, "", `Query: ${query}`, `Matches: ${result.matches.length}`];

  if (result.matches.length === 0) {
    lines.push("", "No matching claims found.");
    return lines.join("\n");
  }

  for (const match of result.matches) {
    lines.push(
      "",
      `## ${match.id}`,
      "",
      `Title: ${match.title}`,
      `System: ${match.system}`,
      `Status: ${match.status}`,
      `Severity: ${match.severity}`,
      `Score: ${match.score}`,
      `Source: ${match.sourcePath}`,
      "",
      match.claim
    );
  }

  return lines.join("\n");
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AgentMemoryError(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }

  return value;
}
