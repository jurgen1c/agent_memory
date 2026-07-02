import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentMemoryError } from "./errors";
import { canonicalMemoryFileInventory, resolveConfiguredPath } from "./files";
import { loadMemory, type LoadedMemory, type MemoryClaim, type MemoryGraphEdge } from "./memory";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";
import { validateRepository, type ValidationResult } from "./validator";
import { PACKAGE_VERSION } from "./version";

export interface CompileOptions {
  cwd?: string;
  dbPath?: string;
  verbose?: boolean;
}

export interface CompileResult {
  databasePath: string;
  repoRoot: string;
  memoryRoot: string;
  counts: {
    claims: number;
    explicitRelations: number;
    inferredRelations: number;
    indexes: number;
    recipes: number;
    recipeClaims: number;
    ftsRows: number;
  };
}

interface RelationRow {
  source: string;
  target: string;
  relation: string;
  reason?: string;
  strength: number;
  origin: "explicit" | "inferred" | "recipe" | "replacement";
  sourcePath?: string;
  bidirectional: boolean;
  metadata: Record<string, unknown>;
}

export async function compileMemory(options: CompileOptions = {}): Promise<CompileResult> {
  const validation = validateRepository({ cwd: options.cwd });

  if (!validation.valid) {
    throw new CompileValidationError(validation);
  }

  const memory = loadMemory(options.cwd);
  const repoRoot = memory.loadedConfig.repo.root;
  const configuredDbPath = options.dbPath ?? memory.loadedConfig.config.database_path;
  const databasePath = path.isAbsolute(configuredDbPath) ? configuredDbPath : path.join(repoRoot, configuredDbPath);
  const memoryRoot = resolveConfiguredPath(repoRoot, memory.loadedConfig.config.memory_root);
  const tempDatabasePath = temporaryDatabasePath(databasePath);

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  let replaced = false;

  try {
    const database = await openSqliteDatabase(tempDatabasePath);

    let result: CompileResult;

    try {
      createSchema(database);
      insertMemory(database, memory);
      insertMetadata(database, memory, databasePath);

      const explicitRelations = database.get<{ count: number }>("SELECT COUNT(*) AS count FROM claim_relations WHERE origin = 'explicit'")?.count ?? 0;
      const inferredRelations = database.get<{ count: number }>("SELECT COUNT(*) AS count FROM claim_relations WHERE origin = 'inferred'")?.count ?? 0;
      const recipeClaims = database.get<{ count: number }>("SELECT COUNT(*) AS count FROM recipe_claims")?.count ?? 0;
      const ftsRows = database.get<{ count: number }>("SELECT COUNT(*) AS count FROM claims_fts")?.count ?? 0;

      result = {
        databasePath,
        repoRoot,
        memoryRoot,
        counts: {
          claims: memory.claims.length,
          explicitRelations,
          inferredRelations,
          indexes: memory.indexes.length,
          recipes: memory.recipes.length,
          recipeClaims,
          ftsRows
        }
      };
    } finally {
      database.close();
    }

    replaceDatabase(tempDatabasePath, databasePath);
    replaced = true;
    return result;
  } finally {
    if (!replaced) {
      cleanupDatabaseArtifacts(tempDatabasePath);
    }
  }
}

export class CompileValidationError extends AgentMemoryError {
  readonly validation: ValidationResult;

  constructor(validation: ValidationResult) {
    super("Memory validation failed; refusing to compile SQLite database.", {
      code: "COMPILE_VALIDATION_ERROR",
      exitCode: 4,
      details: validation.errors.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`)
    });
    this.validation = validation;
  }
}

function createSchema(database: SqliteDatabase): void {
  database.exec(`
PRAGMA journal_mode = DELETE;

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  system TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE claim_files (
  claim_id TEXT NOT NULL,
  path TEXT NOT NULL,
  relation TEXT NOT NULL
);

CREATE TABLE claim_symbols (
  claim_id TEXT NOT NULL,
  symbol TEXT NOT NULL
);

CREATE TABLE claim_tags (
  claim_id TEXT NOT NULL,
  tag TEXT NOT NULL
);

CREATE TABLE claim_routes (
  claim_id TEXT NOT NULL,
  route TEXT NOT NULL
);

CREATE TABLE claim_relations (
  source_claim_id TEXT NOT NULL,
  target_claim_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  reason TEXT,
  strength INTEGER DEFAULT 50,
  origin TEXT NOT NULL,
  source_path TEXT,
  bidirectional BOOLEAN DEFAULT FALSE,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (source_claim_id, target_claim_id, relation, origin)
);

CREATE TABLE indexes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT,
  source_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  system TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  source_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE recipe_claims (
  recipe_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  relation TEXT NOT NULL
);

CREATE TABLE compile_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE claims_fts USING fts5(
  id,
  title,
  claim,
  system,
  tags,
  files,
  symbols,
  routes
);
`);
}

function insertMemory(database: SqliteDatabase, memory: LoadedMemory): void {
  database.exec("BEGIN");

  try {
    for (const claim of memory.claims) {
      insertClaim(database, claim);
    }

    for (const index of memory.indexes) {
      database.run(
        "INSERT INTO indexes (id, name, summary, source_path, metadata_json) VALUES (?, ?, ?, ?, ?)",
        [index.id, index.name, index.summary ?? null, index.sourcePath, JSON.stringify(index.raw)]
      );
    }

    for (const recipe of memory.recipes) {
      database.run(
        "INSERT INTO recipes (id, system, title, status, source_path, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
        [recipe.id, recipe.system, recipe.title, recipe.status, recipe.sourcePath, JSON.stringify(recipe.raw)]
      );

      for (const claimId of recipe.requiredClaims) {
        database.run("INSERT INTO recipe_claims (recipe_id, claim_id, relation) VALUES (?, ?, ?)", [recipe.id, claimId, "required"]);
      }
    }

    for (const relation of buildRelations(memory)) {
      database.run(
        `INSERT OR IGNORE INTO claim_relations
          (source_claim_id, target_claim_id, relation, reason, strength, origin, source_path, bidirectional, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          relation.source,
          relation.target,
          relation.relation,
          relation.reason ?? null,
          relation.strength,
          relation.origin,
          relation.sourcePath ?? null,
          relation.bidirectional ? 1 : 0,
          JSON.stringify(relation.metadata)
        ]
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertClaim(database: SqliteDatabase, claim: MemoryClaim): void {
  database.run(
    `INSERT INTO claims
      (id, type, system, status, confidence, severity, title, claim, source_path, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      claim.id,
      claim.type,
      claim.system,
      claim.status,
      claim.confidence,
      claim.severity,
      claim.title,
      claim.claim,
      claim.sourcePath,
      JSON.stringify(claim.raw),
      null,
      null
    ]
  );

  for (const sourceFile of claim.sourceFiles) {
    database.run("INSERT INTO claim_files (claim_id, path, relation) VALUES (?, ?, ?)", [claim.id, sourceFile, "source"]);
  }

  for (const relatedFile of claim.relatedFiles) {
    database.run("INSERT INTO claim_files (claim_id, path, relation) VALUES (?, ?, ?)", [claim.id, relatedFile, "related"]);
  }

  for (const symbol of claim.symbols) {
    database.run("INSERT INTO claim_symbols (claim_id, symbol) VALUES (?, ?)", [claim.id, symbol]);
  }

  for (const tag of claim.tags) {
    database.run("INSERT INTO claim_tags (claim_id, tag) VALUES (?, ?)", [claim.id, tag]);
  }

  for (const route of claim.routes) {
    database.run("INSERT INTO claim_routes (claim_id, route) VALUES (?, ?)", [claim.id, route]);
  }

  database.run(
    "INSERT INTO claims_fts (id, title, claim, system, tags, files, symbols, routes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      claim.id,
      claim.title,
      claim.claim,
      claim.system,
      claim.tags.join(" "),
      [...claim.sourceFiles, ...claim.relatedFiles].join(" "),
      claim.symbols.join(" "),
      claim.routes.join(" ")
    ]
  );
}

function buildRelations(memory: LoadedMemory): RelationRow[] {
  const relations = [...buildExplicitRelations(memory), ...buildInferredRelations(memory.claims), ...buildReplacementRelations(memory.claims)];
  const explicitKeys = new Set(relations.filter((relation) => relation.origin === "explicit").map(relationKey));

  return relations.filter((relation) => relation.origin === "explicit" || !explicitKeys.has(relationKey(relation)));
}

function buildExplicitRelations(memory: LoadedMemory): RelationRow[] {
  const relations: RelationRow[] = [];

  for (const graph of memory.graphs) {
    for (const edge of graph.edges) {
      const pairs = edge.claims && edge.claims.length > 1 ? pairwise(edge.claims, edge.bidirectional) : sourceTargetPairs(edge);

      for (const [source, target, bidirectional] of pairs) {
        relations.push({
          source,
          target,
          relation: edge.relation,
          reason: edge.reason,
          strength: edge.strength,
          origin: "explicit",
          sourcePath: graph.sourcePath,
          bidirectional,
          metadata: edge.raw
        });
      }
    }
  }

  return relations;
}

function sourceTargetPairs(edge: MemoryGraphEdge): Array<[string, string, boolean]> {
  if (!edge.source || !edge.target) {
    return [];
  }

  const pairs: Array<[string, string, boolean]> = [[edge.source, edge.target, edge.bidirectional]];

  if (edge.bidirectional) {
    pairs.push([edge.target, edge.source, true]);
  }

  return pairs;
}

function pairwise(claimIds: string[], bidirectional: boolean): Array<[string, string, boolean]> {
  const pairs: Array<[string, string, boolean]> = [];

  for (let left = 0; left < claimIds.length; left += 1) {
    for (let right = left + 1; right < claimIds.length; right += 1) {
      pairs.push([claimIds[left], claimIds[right], bidirectional]);

      if (bidirectional) {
        pairs.push([claimIds[right], claimIds[left], true]);
      }
    }
  }

  return pairs;
}

function buildInferredRelations(claims: MemoryClaim[]): RelationRow[] {
  const relations: RelationRow[] = [];

  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const shared = sharedAttributes(claims[left], claims[right]);

      if (shared.length === 0) {
        continue;
      }

      relations.push({
        source: claims[left].id,
        target: claims[right].id,
        relation: "same_area",
        reason: `Claims share ${shared.join(", ")}.`,
        strength: Math.min(60, 20 + shared.length * 10),
        origin: "inferred",
        bidirectional: false,
        metadata: { shared }
      });
    }
  }

  return relations;
}

function buildReplacementRelations(claims: MemoryClaim[]): RelationRow[] {
  const claimIds = new Set(claims.map((claim) => claim.id));
  const relations: RelationRow[] = [];

  for (const claim of claims) {
    const replacement = typeof claim.raw.deprecated_by === "string" ? claim.raw.deprecated_by : null;

    if (replacement && claimIds.has(replacement)) {
      relations.push({
        source: replacement,
        target: claim.id,
        relation: "replaces",
        reason: `${replacement} replaces deprecated claim ${claim.id}.`,
        strength: 100,
        origin: "replacement",
        sourcePath: claim.sourcePath,
        bidirectional: false,
        metadata: { deprecated_by: replacement }
      });
    }
  }

  return relations;
}

function sharedAttributes(left: MemoryClaim, right: MemoryClaim): string[] {
  const shared: string[] = [];

  if (intersects([...left.sourceFiles, ...left.relatedFiles], [...right.sourceFiles, ...right.relatedFiles])) {
    shared.push("files");
  }

  if (intersects(left.symbols, right.symbols)) {
    shared.push("symbols");
  }

  if (intersects(left.routes, right.routes)) {
    shared.push("routes");
  }

  if (intersects(left.tags, right.tags)) {
    shared.push("tags");
  }

  return shared;
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function relationKey(relation: RelationRow): string {
  return `${relation.source}\0${relation.target}\0${relation.relation}`;
}

function insertMetadata(database: SqliteDatabase, memory: LoadedMemory, databasePath: string): void {
  const configPath = memory.loadedConfig.path;
  const memoryRoot = resolveConfiguredPath(memory.loadedConfig.repo.root, memory.loadedConfig.config.memory_root);
  const canonicalFileInventory = canonicalMemoryFileInventory(memoryRoot, memory.loadedConfig.config);
  const metadata: Record<string, string> = {
    schema_version: "1",
    package_version: PACKAGE_VERSION,
    git_commit: currentGitCommit(memory.loadedConfig.repo.root),
    repo_root: memory.loadedConfig.repo.root,
    compiled_at: new Date().toISOString(),
    memory_root: memory.loadedConfig.config.memory_root,
    config_hash: sha256(fs.readFileSync(configPath, "utf8")),
    canonical_files_hash: sha256(JSON.stringify(canonicalFileInventory)),
    canonical_files_count: String(canonicalFileInventory.length),
    database_path: databasePath
  };

  for (const [key, value] of Object.entries(metadata)) {
    database.run("INSERT INTO compile_metadata (key, value) VALUES (?, ?)", [key, value]);
  }
}

function currentGitCommit(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "unknown";
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function temporaryDatabasePath(databasePath: string): string {
  const random = crypto.randomBytes(8).toString("hex");
  return path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.${process.pid}.${Date.now()}.${random}.tmp`);
}

function backupDatabasePath(databasePath: string): string {
  const random = crypto.randomBytes(8).toString("hex");
  return path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.${process.pid}.${Date.now()}.${random}.bak`);
}

function replaceDatabase(tempDatabasePath: string, databasePath: string): void {
  const backupPath = backupDatabasePath(databasePath);
  let backedUp = false;
  let installed = false;

  try {
    if (fs.existsSync(databasePath)) {
      if (!fs.statSync(databasePath).isFile()) {
        throw new AgentMemoryError(`Database path is not a file: ${databasePath}`);
      }

      fs.renameSync(databasePath, backupPath);
      backedUp = true;
      cleanupDatabaseArtifacts(databasePath);
    }

    fs.renameSync(tempDatabasePath, databasePath);
    installed = true;
  } catch (error) {
    if (backedUp && !installed && !fs.existsSync(databasePath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, databasePath);
      backedUp = false;
    }

    throw error;
  } finally {
    if (installed && backedUp) {
      cleanupDatabaseArtifacts(backupPath);
    }
    if (installed) {
      cleanupDatabaseArtifacts(tempDatabasePath);
    }
  }
}

function cleanupDatabaseArtifacts(databasePath: string): void {
  for (const artifactPath of [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      fs.rmSync(artifactPath, { force: true });
    } catch {
      // Cleanup is best effort; failures should not hide the compile result.
    }
  }
}
