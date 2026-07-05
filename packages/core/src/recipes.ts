import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { NotFoundError } from "./errors";
import { pathMatchesPattern } from "./files";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

export interface Recipe {
  id: string;
  system: string;
  title: string;
  status: string;
  sourcePath: string;
  requiredClaims: string[];
  optionalClaims: string[];
  relevantFiles: string[];
  intentTriggers: string[];
  tags: string[];
  steps: string[];
  verification: string[];
  memoryUpdates: string[];
  profileTraits: string[];
  metadata: Record<string, unknown>;
}

export interface RecipeMatchReason {
  code:
    | "explicit_recipe"
    | "trigger_match"
    | "fts_match"
    | "step_fts"
    | "system_match"
    | "changed_file_match"
    | "required_claim_already_matched"
    | "tag_match";
  detail: string;
}

export interface RecipeMatch {
  recipe: Recipe;
  score: number;
  reasons: RecipeMatchReason[];
}

export interface RecipeSearchInput {
  cwd?: string;
  query?: string;
  changedFiles?: string[];
  claimIds?: string[];
  recipeIds?: string[];
  limit?: number;
  includeInactive?: boolean;
}

export interface RecipeSearchResult {
  databasePath: string;
  matches: RecipeMatch[];
}

export interface RecipeShowResult {
  databasePath: string;
  recipe: Recipe;
}

export interface RecipeListResult {
  databasePath: string;
  recipes: Recipe[];
}

const ACTIVE_RECIPE_STATUSES = ["current", "proposed", "needs_review", "experimental", "needs_verification"];

export async function searchRecipes(input: RecipeSearchInput): Promise<RecipeSearchResult> {
  const { database, databasePath } = await openConfiguredDatabase(input.cwd);

  try {
    return {
      databasePath,
      matches: searchRecipeMatches(database, input)
    };
  } finally {
    database.close();
  }
}

export async function showRecipe(options: { cwd?: string; id: string }): Promise<RecipeShowResult> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    const recipe = hydrateRecipe(database, options.id);

    if (!recipe) {
      throw new NotFoundError(`Recipe not found: ${options.id}`);
    }

    return {
      databasePath,
      recipe
    };
  } finally {
    database.close();
  }
}

export async function listRecipes(options: { cwd?: string; includeInactive?: boolean } = {}): Promise<RecipeListResult> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    return {
      databasePath,
      recipes: recipeRows(database, options.includeInactive ?? false)
        .map((row) => hydrateRecipe(database, row.id))
        .filter((recipe): recipe is Recipe => recipe !== null)
    };
  } finally {
    database.close();
  }
}

export function searchRecipeMatches(database: SqliteDatabase, input: Omit<RecipeSearchInput, "cwd">): RecipeMatch[] {
  const scores = new Map<string, number>();
  const reasons = new Map<string, RecipeMatchReason[]>();
  const includeInactive = input.includeInactive ?? false;
  const recipes = recipeRows(database, includeInactive);
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const changedFiles = input.changedFiles ?? [];
  const claimIds = new Set(input.claimIds ?? []);

  for (const recipeId of input.recipeIds ?? []) {
    if (!recipesById.has(recipeId)) {
      continue;
    }

    addScore(scores, reasons, recipeId, 100, { code: "explicit_recipe", detail: recipeId });
  }

  if (input.query?.trim()) {
    applyTextMatches(database, input.query, recipesById, scores, reasons);
  }

  if (changedFiles.length > 0 || claimIds.size > 0) {
    for (const row of recipes) {
      const metadata = parseJson(row.metadata_json);
      const relevantFiles = readStringArray(metadata, "relevant_files");
      const requiredClaims = readStringArray(metadata, "required_claims");

      for (const file of changedFiles) {
        if (relevantFiles.some((pattern) => pathMatchesPattern(pattern, file))) {
          addScore(scores, reasons, row.id, 35, { code: "changed_file_match", detail: file });
          break;
        }
      }

      for (const claimId of requiredClaims) {
        if (claimIds.has(claimId)) {
          addScore(scores, reasons, row.id, 25, { code: "required_claim_already_matched", detail: claimId });
          break;
        }
      }
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => {
      const recipe = hydrateRecipe(database, id);
      return recipe ? { recipe, score, reasons: reasons.get(id) ?? [] } : null;
    })
    .filter((match): match is RecipeMatch => match !== null)
    .sort((left, right) => right.score - left.score || left.recipe.id.localeCompare(right.recipe.id))
    .slice(0, input.limit ?? 10);
}

export function getRecipe(database: SqliteDatabase, id: string): Recipe | null {
  return hydrateRecipe(database, id);
}

async function openConfiguredDatabase(cwd?: string): Promise<{ database: SqliteDatabase; databasePath: string }> {
  const loaded = loadConfig({ cwd });
  const databasePath = path.isAbsolute(loaded.config.database_path)
    ? loaded.config.database_path
    : path.join(loaded.repo.root, loaded.config.database_path);

  if (!fs.existsSync(databasePath)) {
    throw new NotFoundError(`Compiled memory database not found at ${databasePath}`, {
      details: ["Run `agent-memory compile` first."]
    });
  }

  return {
    database: await openSqliteDatabase(databasePath, { readonly: true }),
    databasePath
  };
}

function applyTextMatches(
  database: SqliteDatabase,
  query: string,
  recipesById: Map<string, RecipeRow>,
  scores: Map<string, number>,
  reasons: Map<string, RecipeMatchReason[]>
): void {
  const ftsQuery = toFtsQuery(query);

  if (ftsQuery === '""') {
    return;
  }

  for (const row of database.all<{ id: string; rank_score: number }>(
    `SELECT id, bm25(recipes_fts) AS rank_score
     FROM recipes_fts
     WHERE recipes_fts MATCH ?
     ORDER BY rank_score ASC
     LIMIT 20`,
    [ftsQuery]
  )) {
    const recipeRow = recipesById.get(row.id);

    if (!recipeRow) {
      continue;
    }

    const metadata = parseJson(recipeRow.metadata_json);
    const detail = query.trim();
    const score = 10 + scoreFromRank(row.rank_score);

    addScore(scores, reasons, row.id, score, { code: "fts_match", detail });

    if (matchesAny(query, readStringArray(metadata, "intent_triggers"))) {
      addScore(scores, reasons, row.id, 50, { code: "trigger_match", detail: matchedValue(query, readStringArray(metadata, "intent_triggers")) ?? detail });
    }

    if (matchesAny(query, readStringArray(metadata, "steps"))) {
      addScore(scores, reasons, row.id, 15, { code: "step_fts", detail });
    }

    if (matchesTerm(query, recipeRow.system)) {
      addScore(scores, reasons, row.id, 12, { code: "system_match", detail: recipeRow.system });
    }

    const tags = readStringArray(metadata, "tags");

    if (matchesAny(query, tags)) {
      addScore(scores, reasons, row.id, 10, { code: "tag_match", detail: matchedValue(query, tags) ?? detail });
    }
  }
}

function recipeRows(database: SqliteDatabase, includeInactive: boolean): RecipeRow[] {
  if (includeInactive) {
    return database.all<RecipeRow>("SELECT * FROM recipes ORDER BY id");
  }

  return database.all<RecipeRow>(
    `SELECT * FROM recipes WHERE status IN (${ACTIVE_RECIPE_STATUSES.map(() => "?").join(",")}) ORDER BY id`,
    ACTIVE_RECIPE_STATUSES
  );
}

function hydrateRecipe(database: SqliteDatabase, id: string): Recipe | null {
  const row = database.get<RecipeRow>("SELECT * FROM recipes WHERE id = ?", [id]);

  if (!row) {
    return null;
  }

  const metadata = parseJson(row.metadata_json);

  return {
    id: row.id,
    system: row.system,
    title: row.title,
    status: row.status,
    sourcePath: row.source_path,
    requiredClaims: readStringArray(metadata, "required_claims"),
    optionalClaims: readStringArray(metadata, "optional_claims"),
    relevantFiles: readStringArray(metadata, "relevant_files"),
    intentTriggers: readStringArray(metadata, "intent_triggers"),
    tags: readStringArray(metadata, "tags"),
    steps: readStringArray(metadata, "steps"),
    verification: readStringArray(metadata, "verification"),
    memoryUpdates: readStringArray(metadata, "memory_updates"),
    profileTraits: readStringArray(metadata, "profile_traits"),
    metadata
  };
}

function addScore(
  scores: Map<string, number>,
  reasons: Map<string, RecipeMatchReason[]>,
  recipeId: string,
  score: number,
  reason: RecipeMatchReason
): void {
  scores.set(recipeId, (scores.get(recipeId) ?? 0) + score);
  const existingReasons = reasons.get(recipeId) ?? [];

  if (!existingReasons.some((item) => item.code === reason.code && item.detail === reason.detail)) {
    reasons.set(recipeId, [...existingReasons, reason]);
  }
}

function matchesAny(query: string, values: string[]): boolean {
  return values.some((value) => matchesTerm(query, value) || normalized(query).includes(normalized(value)) || normalized(value).includes(normalized(query)));
}

function matchedValue(query: string, values: string[]): string | undefined {
  return values.find((value) => matchesTerm(query, value) || normalized(query).includes(normalized(value)) || normalized(value).includes(normalized(query)));
}

function matchesTerm(query: string, value: string): boolean {
  const queryTerms = normalized(query).split(/\s+/).filter(Boolean);
  const valueTerms = normalized(value).split(/\s+/).filter(Boolean);
  return queryTerms.some((term) => valueTerms.includes(term));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
}

function toFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.map((term) => `${term.replace(/"/g, "")}*`);

  if (!terms || terms.length === 0) {
    return '""';
  }

  return terms.join(" OR ");
}

function scoreFromRank(rank: number): number {
  if (rank < 0) {
    return Number((-rank * 1_000_000).toFixed(6));
  }

  return Number((1 / (1 + rank)).toFixed(6));
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readStringArray(data: Record<string, unknown>, field: string): string[] {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface RecipeRow {
  id: string;
  system: string;
  title: string;
  status: string;
  source_path: string;
  metadata_json: string;
}
