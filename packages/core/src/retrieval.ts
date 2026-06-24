import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { NotFoundError } from "./errors";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

export interface ClaimRecord {
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

export interface QueryOptions {
  cwd?: string;
  query: string;
  limit: number;
  system?: string;
  status?: string;
  includeStale: boolean;
}

export interface QueryMatch {
  id: string;
  title: string;
  claim: string;
  system: string;
  status: string;
  severity: string;
  sourcePath: string;
  score: number;
}

export interface QueryResult {
  databasePath: string;
  matches: QueryMatch[];
}

export interface ShowOptions {
  cwd?: string;
  id: string;
  includeRelated: boolean;
  depth: number;
}

export interface ShowResult {
  databasePath: string;
  claim: HydratedClaim;
  related: RelatedClaim[];
}

export interface HydratedClaim extends ClaimRecord {
  metadata: Record<string, unknown>;
  files: Array<{ path: string; relation: string }>;
  symbols: string[];
  tags: string[];
  routes: string[];
}

export interface RelatedClaim {
  relation: {
    sourceClaimId: string;
    targetClaimId: string;
    relation: string;
    reason?: string;
    strength: number;
    origin: string;
  };
  claim: HydratedClaim;
}

export interface SystemOptions {
  cwd?: string;
  system: string;
}

export interface SystemResult {
  databasePath: string;
  system: string;
  index?: {
    id: string;
    name: string;
    summary?: string;
    watchedFiles: string[];
    tags: string[];
  };
  claimCounts: Array<{ type: string; status: string; count: number }>;
  criticalClaims: Array<{ id: string; title: string; severity: string; status: string }>;
  recipes: Array<{ id: string; title: string; status: string }>;
  topRelations: Array<{ relation: string; origin: string; count: number }>;
}

export async function queryClaims(options: QueryOptions): Promise<QueryResult> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    const matchQuery = toFtsQuery(options.query);
    const filters = buildClaimFilters(options);
    const params: unknown[] = [matchQuery, ...filters.params, options.limit];
    const rows = database.all<QueryRow>(
      `SELECT c.id, c.title, c.claim, c.system, c.status, c.severity, c.source_path, bm25(claims_fts) AS rank_score
       FROM claims_fts
       JOIN claims c ON c.id = claims_fts.id
       WHERE claims_fts MATCH ?${filters.where}
       ORDER BY rank_score ASC
       LIMIT ?`,
      params
    );

    return {
      databasePath,
      matches: rows.map((row) => ({
        id: row.id,
        title: row.title,
        claim: row.claim,
        system: row.system,
        status: row.status,
        severity: row.severity,
        sourcePath: row.source_path,
        score: scoreFromRank(row.rank_score)
      }))
    };
  } finally {
    database.close();
  }
}

export async function showClaim(options: ShowOptions): Promise<ShowResult> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    const claim = hydrateClaim(database, options.id);

    if (!claim) {
      throw new NotFoundError(`Claim not found: ${options.id}`);
    }

    return {
      databasePath,
      claim,
      related: options.includeRelated ? relatedClaims(database, options.id, options.depth) : []
    };
  } finally {
    database.close();
  }
}

export async function systemSummary(options: SystemOptions): Promise<SystemResult> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    const index = database.get<IndexRow>("SELECT id, name, summary, metadata_json FROM indexes WHERE id = ?", [options.system]);
    const indexMetadata = index ? parseJson(index.metadata_json) : {};

    return {
      databasePath,
      system: options.system,
      index: index
        ? {
            id: index.id,
            name: index.name,
            summary: index.summary ?? undefined,
            watchedFiles: readStringArray(indexMetadata, "watched_files"),
            tags: readStringArray(indexMetadata, "tags")
          }
        : undefined,
      claimCounts: database.all("SELECT type, status, COUNT(*) AS count FROM claims WHERE system = ? GROUP BY type, status ORDER BY type, status", [
        options.system
      ]),
      criticalClaims: database.all(
        "SELECT id, title, severity, status FROM claims WHERE system = ? AND severity = 'critical' ORDER BY id",
        [options.system]
      ),
      recipes: database.all("SELECT id, title, status FROM recipes WHERE system = ? ORDER BY id", [options.system]),
      topRelations: database.all(
        `SELECT relation, origin, COUNT(*) AS count
         FROM claim_relations
         WHERE source_claim_id IN (SELECT id FROM claims WHERE system = ?)
            OR target_claim_id IN (SELECT id FROM claims WHERE system = ?)
         GROUP BY relation, origin
         ORDER BY count DESC, relation ASC
         LIMIT 10`,
        [options.system, options.system]
      )
    };
  } finally {
    database.close();
  }
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
    database: await openSqliteDatabase(databasePath),
    databasePath
  };
}

function hydrateClaim(database: SqliteDatabase, id: string): HydratedClaim | null {
  const claim = database.get<ClaimRecord>("SELECT * FROM claims WHERE id = ?", [id]);

  if (!claim) {
    return null;
  }

  return {
    ...claim,
    metadata: parseJson(claim.metadata_json),
    files: database.all("SELECT path, relation FROM claim_files WHERE claim_id = ? ORDER BY relation, path", [id]),
    symbols: database.all<{ symbol: string }>("SELECT symbol FROM claim_symbols WHERE claim_id = ? ORDER BY symbol", [id]).map((row) => row.symbol),
    tags: database.all<{ tag: string }>("SELECT tag FROM claim_tags WHERE claim_id = ? ORDER BY tag", [id]).map((row) => row.tag),
    routes: database.all<{ route: string }>("SELECT route FROM claim_routes WHERE claim_id = ? ORDER BY route", [id]).map((row) => row.route)
  };
}

function relatedClaims(database: SqliteDatabase, id: string, depth: number): RelatedClaim[] {
  const maxDepth = Math.max(1, depth);
  const seen = new Set([id]);
  const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
  const related: RelatedClaim[] = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || current.depth >= maxDepth) {
      continue;
    }

    const relations = database.all<RelationRow>(
      `SELECT source_claim_id, target_claim_id, relation, reason, strength, origin
       FROM claim_relations
       WHERE source_claim_id = ? OR target_claim_id = ?
       ORDER BY origin ASC, strength DESC, relation ASC`,
      [current.id, current.id]
    );

    for (const relation of relations) {
      const relatedId = relation.source_claim_id === current.id ? relation.target_claim_id : relation.source_claim_id;

      if (seen.has(relatedId)) {
        continue;
      }

      const claim = hydrateClaim(database, relatedId);

      if (!claim) {
        continue;
      }

      seen.add(relatedId);
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
      queue.push({ id: relatedId, depth: current.depth + 1 });
    }
  }

  return related;
}

function buildClaimFilters(options: Pick<QueryOptions, "system" | "status" | "includeStale">): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.system) {
    clauses.push("c.system = ?");
    params.push(options.system);
  }

  if (options.status) {
    clauses.push("c.status = ?");
    params.push(options.status);
  } else if (!options.includeStale) {
    clauses.push("c.status NOT IN ('stale', 'deprecated', 'rejected')");
  }

  return {
    where: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    params
  };
}

function toFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9_./:-]+/g)
    ?.map((term) => `${term.replace(/"/g, "")}*`);

  if (!terms || terms.length === 0) {
    return '""';
  }

  return terms.join(" ");
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

interface QueryRow {
  id: string;
  title: string;
  claim: string;
  system: string;
  status: string;
  severity: string;
  source_path: string;
  rank_score: number;
}

interface RelationRow {
  source_claim_id: string;
  target_claim_id: string;
  relation: string;
  reason: string | null;
  strength: number;
  origin: string;
}

interface IndexRow {
  id: string;
  name: string;
  summary: string | null;
  metadata_json: string;
}
