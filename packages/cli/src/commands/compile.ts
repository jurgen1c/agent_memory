import { AgentMemoryError } from "../../../core/src/errors";
import { compileMemory, type CompileResult } from "../../../core/src/compiler";
import type { ExitCode } from "../../../core/src/types";

export interface CompileCommandContext {
  cwd?: string;
}

export interface CompileCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface CompileCommandOptions {
  db?: string;
  json: boolean;
  verbose: boolean;
}

export async function runCompileCommand(args: string[], context: CompileCommandContext = {}): Promise<CompileCommandResult> {
  const options = parseCompileArgs(args);
  const result = await compileMemory({
    cwd: context.cwd,
    dbPath: options.db,
    verbose: options.verbose
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderCompileResult(result, options.verbose)
  };
}

function parseCompileArgs(args: string[]): CompileCommandOptions {
  const options: CompileCommandOptions = {
    json: false,
    verbose: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }

    if (arg === "--db") {
      const value = args[index + 1];

      if (!value) {
        throw new AgentMemoryError("--db requires a path.");
      }

      options.db = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--db=")) {
      options.db = arg.slice("--db=".length);
      continue;
    }

    throw new AgentMemoryError(`Unknown compile option: ${arg}`, {
      details: ["Run `agent-memory help compile` for usage."]
    });
  }

  return options;
}

function renderCompileResult(result: CompileResult, verbose: boolean): string {
  const lines = [
    "Agent Memory compiled.",
    "",
    `Database: ${result.databasePath}`,
    `Claims: ${result.counts.claims}`,
    `Explicit relations: ${result.counts.explicitRelations}`,
    `Inferred relations: ${result.counts.inferredRelations}`,
    `Indexes: ${result.counts.indexes}`,
    `Recipes: ${result.counts.recipes}`,
    `Recipe claims: ${result.counts.recipeClaims}`,
    `Plans: ${result.counts.plans}`,
    `Plan stages: ${result.counts.planStages}`,
    `Profiles: ${result.counts.profiles}`,
    `FTS rows: ${result.counts.ftsRows}`,
    `Recipe FTS rows: ${result.counts.recipeFtsRows}`,
    `Plan FTS rows: ${result.counts.planFtsRows}`,
    `Profile FTS rows: ${result.counts.profileFtsRows}`
  ];

  if (verbose) {
    lines.push("", `Repo root: ${result.repoRoot}`, `Memory root: ${result.memoryRoot}`);
  }

  return lines.join("\n");
}
