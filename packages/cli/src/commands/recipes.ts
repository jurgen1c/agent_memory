import { AgentMemoryError } from "../../../core/src/errors";
import {
  listRecipes,
  searchRecipes,
  showRecipe,
  type Recipe,
  type RecipeMatch,
  type RecipeSearchResult,
  type RecipeShowResult
} from "../../../core/src/recipes";
import type { ExitCode } from "../../../core/src/types";

export interface RecipesCommandContext {
  cwd?: string;
}

export interface RecipesCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export async function runRecipesCommand(args: string[], context: RecipesCommandContext = {}): Promise<RecipesCommandResult> {
  const [subcommand, ...rest] = args;

  if (subcommand === "list") {
    const options = parseListArgs(rest);
    const result = await listRecipes({ cwd: context.cwd, includeInactive: options.includeInactive });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result, null, 2) : renderRecipeList(result.recipes)
    };
  }

  if (subcommand === "search") {
    const options = parseSearchArgs(rest);
    const result = await searchRecipes({
      cwd: context.cwd,
      query: options.query,
      changedFiles: options.changedFiles,
      limit: options.limit,
      includeInactive: options.includeInactive
    });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result, null, 2) : renderRecipeSearch(options.query, result)
    };
  }

  if (subcommand === "show") {
    const options = parseShowArgs(rest);
    const result = await showRecipe({ cwd: context.cwd, id: options.id });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result, null, 2) : renderRecipeShow(result)
    };
  }

  throw new AgentMemoryError("recipes requires a subcommand.", {
    details: ["Expected one of: list, search, show"]
  });
}

function parseListArgs(args: string[]): { json: boolean; includeInactive: boolean } {
  let json = false;
  let includeInactive = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--include-inactive" || arg === "--include-stale") {
      includeInactive = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown recipes list option: ${arg}`);
  }

  return { json, includeInactive };
}

function parseSearchArgs(args: string[]): { query: string; json: boolean; limit: number; includeInactive: boolean; changedFiles: string[] } {
  let query: string | undefined;
  let json = false;
  let includeInactive = false;
  let limit = 10;
  const changedFiles: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--include-inactive" || arg === "--include-stale") {
      includeInactive = true;
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

    if (arg === "--changed-files") {
      index += 1;

      while (index < args.length && !args[index].startsWith("--")) {
        changedFiles.push(args[index]);
        index += 1;
      }

      index -= 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new AgentMemoryError(`Unknown recipes search option: ${arg}`);
    }

    query = query ? `${query} ${arg}` : arg;
  }

  if (!query || query.trim().length === 0) {
    throw new AgentMemoryError("recipes search requires search text.", {
      details: ['Example: agent-memory recipes search "student oauth"']
    });
  }

  return { query, json, limit, includeInactive, changedFiles };
}

function parseShowArgs(args: string[]): { id: string; json: boolean } {
  const [id, ...rest] = args;

  if (!id || id.startsWith("--")) {
    throw new AgentMemoryError("recipes show requires a recipe ID.", {
      details: ["Example: agent-memory recipes show recipe.auth.modify_student_oauth"]
    });
  }

  let json = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown recipes show option: ${arg}`);
  }

  return { id, json };
}

function renderRecipeList(recipes: Recipe[]): string {
  const lines = ["# Recipes", "", `Count: ${recipes.length}`];

  for (const recipe of recipes) {
    lines.push("", `- ${recipe.id}: ${recipe.title} (${recipe.status})`);
  }

  return lines.join("\n");
}

function renderRecipeSearch(query: string, result: RecipeSearchResult): string {
  const lines = ["# Recipe Search", "", `Query: ${query}`, `Matches: ${result.matches.length}`];

  if (result.matches.length === 0) {
    lines.push("", "No matching recipes found.");
    return lines.join("\n");
  }

  for (const match of result.matches) {
    renderRecipeMatch(lines, match);
  }

  return lines.join("\n");
}

function renderRecipeMatch(lines: string[], match: RecipeMatch): void {
  lines.push("", `## ${match.recipe.id}`, "", `${match.recipe.title} (${match.recipe.status})`, `Score: ${match.score}`);

  if (match.reasons.length > 0) {
    lines.push("", "Matched because:", ...match.reasons.map((reason) => `- ${reason.code}: ${reason.detail}`));
  }

  if (match.recipe.requiredClaims.length > 0) {
    lines.push("", "Required claims:", ...match.recipe.requiredClaims.map((claimId) => `- ${claimId}`));
  }

  if (match.recipe.verification.length > 0) {
    lines.push("", "Verification:", ...match.recipe.verification.map((step) => `- ${step}`));
  }
}

function renderRecipeShow(result: RecipeShowResult): string {
  const recipe = result.recipe;
  const lines = [
    `# ${recipe.title}`,
    "",
    `ID: ${recipe.id}`,
    `System: ${recipe.system}`,
    `Status: ${recipe.status}`,
    `Source: ${recipe.sourcePath}`
  ];

  if (recipe.intentTriggers.length > 0) {
    lines.push("", "## Intent Triggers", "", ...recipe.intentTriggers.map((trigger) => `- ${trigger}`));
  }

  if (recipe.requiredClaims.length > 0) {
    lines.push("", "## Required Claims", "", ...recipe.requiredClaims.map((claimId) => `- ${claimId}`));
  }

  if (recipe.relevantFiles.length > 0) {
    lines.push("", "## Relevant Files", "", ...recipe.relevantFiles.map((file) => `- ${file}`));
  }

  if (recipe.steps.length > 0) {
    lines.push("", "## Steps", "", ...recipe.steps.map((step, index) => `${index + 1}. ${step}`));
  }

  if (recipe.verification.length > 0) {
    lines.push("", "## Verification", "", ...recipe.verification.map((step) => `- ${step}`));
  }

  if (recipe.memoryUpdates.length > 0) {
    lines.push("", "## Memory Updates", "", ...recipe.memoryUpdates.map((step) => `- ${step}`));
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
