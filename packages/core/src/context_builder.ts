import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { NotFoundError } from "./errors";
import { pathMatchesPattern, toPosix } from "./files";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

export type ContextBudget = "small" | "medium" | "full";

export interface BuildContextOptions {
  cwd?: string;
  task?: string;
  changedFiles?: string[];
  gitDiff?: boolean;
  budget: ContextBudget;
  depth: number;
  includeInferred: boolean;
}

export interface AgentContext {
  databasePath: string;
  task?: string;
  changedFiles: string[];
  budget: ContextBudget;
  depth: number;
  criticalRules: ContextClaim[];
  matchedClaims: ContextClaim[];
  relatedClaims: ContextRelatedClaim[];
  relevantFiles: string[];
  recipes: ContextRecipe[];
  verificationSteps: string[];
  warnings: string[];
}

export interface ContextClaim {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  sourcePath: string;
  files: Array<{ path: string; relation: string }>;
  tags: string[];
  verification: string[];
}

export interface ContextRelatedClaim {
  relation: {
    sourceClaimId: string;
    targetClaimId: string;
    relation: string;
    reason?: string;
    strength: number;
    origin: string;
  };
  claim: ContextClaim;
}

export interface ContextRecipe {
  id: string;
  system: string;
  title: string;
  status: string;
  requiredClaims: string[];
  relevantFiles: string[];
  steps: string[];
  verification: string[];
}

interface OpenDatabase {
  database: SqliteDatabase;
  databasePath: string;
  repoRoot: string;
}

const ACTIVE_STATUSES = ["current", "proposed", "needs_review", "experimental", "needs_verification"];
const DIRECT_MATCH_STATUSES = [...ACTIVE_STATUSES, "stale", "deprecated"];
const BUDGET_LIMITS: Record<ContextBudget, { matched: number; related: number; recipes: number }> = {
  small: { matched: 3, related: 2, recipes: 2 },
  medium: { matched: 8, related: 8, recipes: 5 },
  full: { matched: 25, related: 25, recipes: 20 }
};

export async function buildContext(options: BuildContextOptions): Promise<AgentContext> {
  const opened = await openConfiguredDatabase(options.cwd);
  const changedFiles = normalizeChangedFiles(options.changedFiles ?? [], opened.repoRoot);

  if (options.gitDiff) {
    changedFiles.push(...normalizeChangedFiles(readGitDiffFiles(opened.repoRoot), opened.repoRoot));
  }

  const uniqueChangedFiles = Array.from(new Set(changedFiles));

  try {
    const limits = BUDGET_LIMITS[options.budget];
    const matched = rankClaims(opened.database, {
      task: options.task,
      changedFiles: uniqueChangedFiles,
      limit: limits.matched
    });
    const criticalRules = criticalRulesForClaims(opened.database, matched).slice(0, limits.matched);
    const related = relatedClaims(opened.database, matched, options.depth, options.includeInferred).slice(0, limits.related);
    const recipes = relatedRecipes(opened.database, matched, uniqueChangedFiles).slice(0, limits.recipes);
    const claimsById = new Map([...criticalRules, ...matched, ...related.map((item) => item.claim)].map((claim) => [claim.id, claim]));
    const warnings = warningLines([...claimsById.values()]);

    return {
      databasePath: opened.databasePath,
      task: options.task,
      changedFiles: uniqueChangedFiles,
      budget: options.budget,
      depth: options.depth,
      criticalRules,
      matchedClaims: matched,
      relatedClaims: related,
      relevantFiles: collectRelevantFiles([...claimsById.values()], recipes, uniqueChangedFiles),
      recipes,
      verificationSteps: collectVerificationSteps([...claimsById.values()], recipes),
      warnings
    };
  } finally {
    opened.database.close();
  }
}

async function openConfiguredDatabase(cwd?: string): Promise<OpenDatabase> {
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
    database: await openSqliteDatabase(databasePath),
    databasePath,
    repoRoot: loaded.repo.root
  };
}

function rankClaims(database: SqliteDatabase, options: { task?: string; changedFiles: string[]; limit: number }): ContextClaim[] {
  const scores = new Map<string, number>();

  if (options.task?.trim()) {
    for (const row of searchClaims(database, options.task, options.limit)) {
      scores.set(row.id, Math.max(scores.get(row.id) ?? 0, row.score));
    }
  }

  if (options.changedFiles.length > 0) {
    for (const row of fileClaims(database, options.changedFiles)) {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 10);
    }
  }

  if (scores.size === 0) {
    for (const row of database.all<{ id: string }>(
      `SELECT id FROM claims WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) ORDER BY severity = 'critical' DESC, id LIMIT ?`,
      [...ACTIVE_STATUSES, options.limit]
    )) {
      scores.set(row.id, 1);
    }
  }

  return Array.from(scores.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, options.limit)
    .map(([id]) => hydrateClaim(database, id))
    .filter((claim): claim is ContextClaim => claim !== null);
}

function searchClaims(database: SqliteDatabase, task: string, limit: number): Array<{ id: string; score: number }> {
  const query = toFtsQuery(task);

  if (query === '""') {
    return [];
  }

  return database
    .all<{ id: string; rank_score: number }>(
      `SELECT c.id, bm25(claims_fts) AS rank_score
       FROM claims_fts
       JOIN claims c ON c.id = claims_fts.id
       WHERE claims_fts MATCH ?
         AND c.status IN (${DIRECT_MATCH_STATUSES.map(() => "?").join(",")})
       ORDER BY rank_score ASC
       LIMIT ?`,
      [query, ...DIRECT_MATCH_STATUSES, limit]
    )
    .map((row) => ({ id: row.id, score: scoreFromRank(row.rank_score) }));
}

function fileClaims(database: SqliteDatabase, changedFiles: string[]): Array<{ id: string }> {
  const claimIds = new Set<string>();

  for (const changedFile of changedFiles) {
    for (const row of database.all<{ claim_id: string }>("SELECT claim_id FROM claim_files WHERE path = ?", [changedFile])) {
      claimIds.add(row.claim_id);
    }
  }

  const indexes = database.all<{ metadata_json: string }>("SELECT metadata_json FROM indexes");

  for (const index of indexes) {
    const metadata = parseJson(index.metadata_json);
    const watchedFiles = readStringArray(metadata, "watched_files");
    const claimGlobs = readStringArray(metadata, "claim_globs");

    if (!changedFiles.some((file) => watchedFiles.some((pattern) => pathMatchesPattern(pattern, file)))) {
      continue;
    }

    for (const glob of claimGlobs) {
      for (const claim of database.all<{ id: string; source_path: string }>("SELECT id, source_path FROM claims")) {
        if (pathMatchesPattern(glob, claim.source_path)) {
          claimIds.add(claim.id);
        }
      }
    }
  }

  return Array.from(claimIds).map((id) => ({ id }));
}

function criticalRulesForClaims(database: SqliteDatabase, claims: ContextClaim[]): ContextClaim[] {
  const systems = Array.from(new Set(claims.map((claim) => claim.system)));
  const critical = new Map<string, ContextClaim>();

  for (const system of systems) {
    for (const row of database.all<{ id: string }>(
      "SELECT id FROM claims WHERE system = ? AND severity = 'critical' AND status IN ('current', 'proposed', 'needs_review') ORDER BY type = 'rule' DESC, type = 'constraint' DESC, id",
      [system]
    )) {
      const claim = hydrateClaim(database, row.id);

      if (claim) {
        critical.set(claim.id, claim);
      }
    }
  }

  return Array.from(critical.values());
}

function relatedClaims(database: SqliteDatabase, seeds: ContextClaim[], depth: number, includeInferred: boolean): ContextRelatedClaim[] {
  const maxDepth = Math.max(0, depth);
  const seen = new Set(seeds.map((claim) => claim.id));
  const seenRelations = new Set<string>();
  const queue = seeds.map((claim) => ({ id: claim.id, depth: 0 }));
  const related: ContextRelatedClaim[] = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || current.depth >= maxDepth) {
      continue;
    }

    const relationRows = database.all<RelationRow>(
      `SELECT source_claim_id, target_claim_id, relation, reason, strength, origin
       FROM claim_relations
       WHERE (source_claim_id = ? OR target_claim_id = ?)
         ${includeInferred ? "" : "AND origin != 'inferred'"}
       ORDER BY
         CASE relation WHEN 'requires' THEN 0 WHEN 'constrains' THEN 1 WHEN 'conflicts_with' THEN 2 ELSE 3 END,
         strength DESC`,
      [current.id, current.id]
    );

    for (const relation of relationRows) {
      const relatedId = relation.source_claim_id === current.id ? relation.target_claim_id : relation.source_claim_id;
      const relationKey = `${relation.source_claim_id}\0${relation.target_claim_id}\0${relation.relation}\0${relation.origin}`;

      if (seenRelations.has(relationKey)) {
        continue;
      }

      const claim = hydrateClaim(database, relatedId);

      if (!claim) {
        continue;
      }

      seenRelations.add(relationKey);
      related.push({
        relation: {
          sourceClaimId: relation.source_claim_id,
          targetClaimId: relation.target_claim_id,
          relation: relation.relation,
          reason: relation.reason ?? undefined,
          strength: relation.strength,
          origin: relation.origin
        },
        claim
      });

      if (!seen.has(relatedId)) {
        seen.add(relatedId);
        queue.push({ id: relatedId, depth: current.depth + 1 });
      }
    }
  }

  return related;
}

function relatedRecipes(database: SqliteDatabase, claims: ContextClaim[], changedFiles: string[]): ContextRecipe[] {
  const recipeIds = new Set<string>();

  for (const claim of claims) {
    for (const row of database.all<{ recipe_id: string }>("SELECT recipe_id FROM recipe_claims WHERE claim_id = ?", [claim.id])) {
      recipeIds.add(row.recipe_id);
    }
  }

  for (const recipe of database.all<{ id: string; metadata_json: string }>("SELECT id, metadata_json FROM recipes")) {
    const metadata = parseJson(recipe.metadata_json);
    const relevantFiles = readStringArray(metadata, "relevant_files");

    if (changedFiles.some((file) => relevantFiles.some((pattern) => pathMatchesPattern(pattern, file)))) {
      recipeIds.add(recipe.id);
    }
  }

  return Array.from(recipeIds)
    .map((id) => hydrateRecipe(database, id))
    .filter((recipe): recipe is ContextRecipe => recipe !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function hydrateClaim(database: SqliteDatabase, id: string): ContextClaim | null {
  const row = database.get<ClaimRow>("SELECT * FROM claims WHERE id = ?", [id]);

  if (!row) {
    return null;
  }

  const metadata = parseJson(row.metadata_json);

  return {
    id: row.id,
    type: row.type,
    system: row.system,
    status: row.status,
    confidence: row.confidence,
    severity: row.severity,
    title: row.title,
    claim: row.claim,
    sourcePath: row.source_path,
    files: database.all("SELECT path, relation FROM claim_files WHERE claim_id = ? ORDER BY relation, path", [id]),
    tags: database.all<{ tag: string }>("SELECT tag FROM claim_tags WHERE claim_id = ? ORDER BY tag", [id]).map((item) => item.tag),
    verification: readStringArray(metadata, "verification")
  };
}

function hydrateRecipe(database: SqliteDatabase, id: string): ContextRecipe | null {
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
    requiredClaims: readStringArray(metadata, "required_claims"),
    relevantFiles: readStringArray(metadata, "relevant_files"),
    steps: readStringArray(metadata, "steps"),
    verification: readStringArray(metadata, "verification")
  };
}

function collectRelevantFiles(claims: ContextClaim[], recipes: ContextRecipe[], changedFiles: string[]): string[] {
  const files = new Set(changedFiles);

  for (const claim of claims) {
    for (const file of claim.files) {
      files.add(file.path);
    }
  }

  for (const recipe of recipes) {
    for (const file of recipe.relevantFiles) {
      files.add(file);
    }
  }

  return Array.from(files).sort();
}

function collectVerificationSteps(claims: ContextClaim[], recipes: ContextRecipe[]): string[] {
  const steps = new Set<string>();

  for (const claim of claims) {
    for (const step of claim.verification) {
      steps.add(step);
    }
  }

  for (const recipe of recipes) {
    for (const step of recipe.verification) {
      steps.add(step);
    }
  }

  return Array.from(steps);
}

function warningLines(claims: ContextClaim[]): string[] {
  return claims
    .filter((claim) => ["stale", "deprecated", "needs_verification", "proposed", "needs_review"].includes(claim.status))
    .map((claim) => `${claim.id} has status ${claim.status}.`);
}

function readGitDiffFiles(repoRoot: string): string[] {
  const commands: string[][] = [
    ["diff", "--name-only", "HEAD"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"]
  ];
  const files = new Set<string>();

  for (const args of commands) {
    try {
      const output = execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });

      for (const line of output.split(/\r?\n/)) {
        const file = line.trim();

        if (file.length > 0) {
          files.add(toPosix(file));
        }
      }
    } catch {
      // Ignore git diff failures. Repos without commits can still use --changed-files.
    }
  }

  return Array.from(files);
}

function normalizeChangedFiles(files: string[], repoRoot: string): string[] {
  return files
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .map((file) => {
      const normalized = path.normalize(file);
      const relative = path.isAbsolute(normalized) ? path.relative(repoRoot, normalized) : normalized;
      return toPosix(relative).replace(/^(?:\.\/)+/, "");
    })
    .filter((file) => file.length > 0 && file !== ".");
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

interface ClaimRow {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  source_path: string;
  metadata_json: string;
}

interface RecipeRow {
  id: string;
  system: string;
  title: string;
  status: string;
  metadata_json: string;
}

interface RelationRow {
  source_claim_id: string;
  target_claim_id: string;
  relation: string;
  reason: string | null;
  strength: number;
  origin: string;
}
