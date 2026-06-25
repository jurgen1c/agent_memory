import { AgentMemoryError } from "../../../core/src/errors";
import { buildContext, type AgentContext, type ContextBudget } from "../../../core/src/context_builder";
import type { ExitCode } from "../../../core/src/types";

export interface ContextCommandContext {
  cwd?: string;
}

export interface ContextCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

interface ContextCommandOptions {
  task?: string;
  changedFiles: string[];
  gitDiff: boolean;
  budget?: ContextBudget;
  depth?: number;
  json: boolean;
  includeInferred?: boolean;
}

export async function runContextCommand(args: string[], context: ContextCommandContext = {}): Promise<ContextCommandResult> {
  const options = parseContextArgs(args);
  const result = await buildContext({
    cwd: context.cwd,
    task: options.task,
    changedFiles: options.changedFiles,
    gitDiff: options.gitDiff,
    budget: options.budget,
    depth: options.depth,
    includeInferred: options.includeInferred
  });

  return {
    exitCode: 0,
    stdout: options.json ? JSON.stringify(result, null, 2) : renderContext(result)
  };
}

function parseContextArgs(args: string[]): ContextCommandOptions {
  const options: ContextCommandOptions = {
    changedFiles: [],
    gitDiff: false,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--git-diff") {
      options.gitDiff = true;
      continue;
    }

    if (arg === "--include-inferred") {
      options.includeInferred = true;
      continue;
    }

    if (arg === "--no-include-inferred") {
      options.includeInferred = false;
      continue;
    }

    if (arg === "--task") {
      options.task = readValue(args, index, "--task");
      index += 1;
      continue;
    }

    if (arg.startsWith("--task=")) {
      options.task = arg.slice("--task=".length);
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

    if (arg === "--budget") {
      options.budget = parseBudget(readValue(args, index, "--budget"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--budget=")) {
      options.budget = parseBudget(arg.slice("--budget=".length));
      continue;
    }

    if (arg === "--depth") {
      options.depth = parseDepth(readValue(args, index, "--depth"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--depth=")) {
      options.depth = parseDepth(arg.slice("--depth=".length));
      continue;
    }

    throw new AgentMemoryError(`Unknown context option: ${arg}`, {
      details: ["Run `agent-memory help context` for usage."]
    });
  }

  if (!options.task && options.changedFiles.length === 0 && !options.gitDiff) {
    throw new AgentMemoryError("context requires --task, --changed-files, or --git-diff.", {
      details: ['Example: agent-memory context --task "fix student oauth"']
    });
  }

  return options;
}

function renderContext(context: AgentContext): string {
  const lines = ["# Agent Memory Context", "", `Budget: ${context.budget}`, `Depth: ${context.depth}`];

  if (context.task) {
    lines.push(`Task: ${context.task}`);
  }

  if (context.changedFiles.length > 0) {
    lines.push("", "## Changed Files", "", ...context.changedFiles.map((file) => `- ${file}`));
  }

  if (context.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...context.warnings.map((warning) => `- ${warning}`));
  }

  if (context.criticalRules.length > 0) {
    lines.push("", "## Critical Rules and Constraints");

    for (const claim of context.criticalRules) {
      lines.push("", `### ${claim.id}`, "", `Severity: ${claim.severity}`, `Status: ${claim.status}`, "", claim.claim);
    }
  }

  lines.push("", "## Matched Claims");

  if (context.matchedClaims.length === 0) {
    lines.push("", "No matching claims found.");
  } else {
    for (const claim of context.matchedClaims) {
      lines.push("", `### ${claim.id}`, "", `Type: ${claim.type}`, `System: ${claim.system}`, `Status: ${claim.status}`, `Severity: ${claim.severity}`, "", claim.claim);
    }
  }

  if (context.relatedClaims.length > 0) {
    lines.push("", "## Related Claims");

    for (const related of context.relatedClaims) {
      lines.push(
        "",
        `### ${related.claim.id}`,
        "",
        `Relation: ${related.relation.relation}`,
        `Origin: ${related.relation.origin}`,
        `Strength: ${related.relation.strength}`,
        related.relation.reason ? `Reason: ${related.relation.reason}` : "",
        "",
        related.claim.claim
      );
    }
  }

  if (context.relevantFiles.length > 0) {
    lines.push("", "## Relevant Files", "", ...context.relevantFiles.map((file) => `- ${file}`));
  }

  if (context.recipes.length > 0) {
    lines.push("", "## Related Recipes");

    for (const recipe of context.recipes) {
      lines.push("", `### ${recipe.id}`, "", `${recipe.title} (${recipe.status})`);

      if (recipe.steps.length > 0) {
        lines.push("", ...recipe.steps.map((step, index) => `${index + 1}. ${step}`));
      }
    }
  }

  if (context.verificationSteps.length > 0) {
    lines.push("", "## Verification", "", ...context.verificationSteps.map((step) => `- ${step}`));
  }

  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

function parseBudget(value: string): ContextBudget {
  if (value === "small" || value === "medium" || value === "full") {
    return value;
  }

  throw new AgentMemoryError(`Invalid context budget: ${value}`, {
    details: ["Expected one of: small, medium, full"]
  });
}

function parseDepth(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    throw new AgentMemoryError(`Depth must be an integer between 0 and 10, got: ${value}`);
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
