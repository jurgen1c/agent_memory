import type { ExitCode } from "../../../core/src/types";
import { validateRepository, type ValidationIssue, type ValidationResult } from "../../../core/src/validator";
import { AgentMemoryError } from "../../../core/src/errors";

export interface ValidateCommandContext {
  cwd?: string;
}

export interface ValidateCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface ValidateCommandOptions {
  json: boolean;
  strict: boolean;
  changedFiles: string[];
}

export function runValidateCommand(args: string[], context: ValidateCommandContext = {}): ValidateCommandResult {
  const options = parseValidateArgs(args);
  const result = validateRepository({
    cwd: context.cwd,
    strict: options.strict,
    changedFiles: options.changedFiles
  });

  return {
    exitCode: result.valid ? 0 : 2,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderValidationResult(result)
  };
}

function parseValidateArgs(args: string[]): ValidateCommandOptions {
  const options: ValidateCommandOptions = {
    json: false,
    strict: false,
    changedFiles: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--strict") {
      options.strict = true;
      continue;
    }

    if (arg === "--changed-files") {
      index += 1;

      while (index < args.length && !args[index].startsWith("--")) {
        options.changedFiles.push(args[index]);
        index += 1;
      }

      index -= 1;
      continue;
    }

    throw new AgentMemoryError(`Unknown validate option: ${arg}`, {
      details: ["Run `agent-memory help validate` for usage."]
    });
  }

  return options;
}

function renderValidationResult(result: ValidationResult): string {
  const lines = [
    result.valid ? "Agent Memory validation passed." : "Agent Memory validation failed.",
    "",
    `Claims: ${result.counts.claims}`,
    `Graphs: ${result.counts.graphs}`,
    `Indexes: ${result.counts.indexes}`,
    `Recipes: ${result.counts.recipes}`
  ];

  if (result.errors.length > 0) {
    lines.push("", "Errors:", ...result.errors.map(renderIssue));
  }

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map(renderIssue));
  }

  return lines.join("\n");
}

function renderIssue(issue: ValidationIssue): string {
  const location = issue.path ? `${issue.path}: ` : "";
  const id = issue.id ? ` (${issue.id})` : "";
  return `- [${issue.code}] ${location}${issue.message}${id}`;
}
