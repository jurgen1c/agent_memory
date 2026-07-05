import fs from "node:fs";
import path from "node:path";
import { normalizeChangedFiles, readGitDiffFiles } from "./changes";
import { loadConfig } from "./config";
import { configuredPathRelativeToRepo, discoverFiles, pathMatchesPattern, resolveConfiguredPath, toPosix } from "./files";
import { parseYaml } from "./yaml";
import { NotFoundError } from "./errors";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

export type CoverageChangeStatus = "covered" | "waived" | "uncovered" | "ignored";

export interface CoverageOptions {
  cwd?: string;
  changedFiles?: string[];
  gitDiff?: boolean;
  baseRef?: string;
}

export interface CoverageChange {
  path: string;
  status: CoverageChangeStatus;
  watchedBy: string[];
  relatedMemoryFiles: string[];
  changedMemoryFiles: string[];
  waiverIds: string[];
  remediation?: string;
}

export interface CoverageWaiver {
  id: string;
  sourcePath: string;
  reason?: string;
  files: string[];
  expiresAt?: string;
  valid: boolean;
  problems: string[];
}

export interface CoverageResult {
  ok: boolean;
  databasePath: string;
  repoRoot: string;
  changedFiles: string[];
  changes: CoverageChange[];
  waivers: CoverageWaiver[];
  warnings: string[];
}

interface CoverageIndex {
  id: string;
  sourcePath: string;
  watchedFiles: string[];
  claimGlobs: string[];
  recipeGlobs: string[];
}

interface MemoryFile {
  id: string;
  sourcePath: string;
}

interface RecipeCoverageFile extends MemoryFile {
  relevantFiles: string[];
}

interface PlanTemplateCoverageRow {
  id: string;
  sourcePath: string;
  stageId: string;
  metadataJson: string;
}

interface ProfileCoverageRow {
  id: string;
  sourcePath: string;
  appliesWhenJson: string;
}

export async function checkCoverage(options: CoverageOptions = {}): Promise<CoverageResult> {
  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memoryRoot = resolveConfiguredPath(repoRoot, loaded.config.memory_root);
  const memoryRootRelative = configuredPathRelativeToRepo(repoRoot, loaded.config.memory_root);
  const databasePath = path.isAbsolute(loaded.config.database_path) ? loaded.config.database_path : path.join(repoRoot, loaded.config.database_path);

  if (!fs.existsSync(databasePath)) {
    throw new NotFoundError(`Compiled memory database not found at ${databasePath}`, {
      details: ["Run `agent-memory compile` first."]
    });
  }

  const changedFiles = normalizeCoverageFiles(
    [
      ...(options.changedFiles ?? []),
      ...(options.gitDiff ? readGitDiffFiles(repoRoot, { baseRef: options.baseRef, includeCommittedFallback: true }) : [])
    ],
    repoRoot
  );
  const waivers = loadCoverageWaivers(memoryRoot, loaded.config.waivers);
  const warnings = waivers.flatMap((waiver) => waiver.problems.map((problem) => `${waiver.sourcePath}: ${problem}`));
  const database = await openSqliteDatabase(databasePath, { readonly: true });

  try {
    const indexes = loadCoverageIndexes(database);
    const claims = database.all<MemoryFile>("SELECT id, source_path AS sourcePath FROM claims");
    const recipes = loadRecipeCoverageFiles(database);
    const changedFileSet = new Set(changedFiles);
    const changes = changedFiles.map((file) =>
      coverageForFile(file, changedFileSet, indexes, claims, recipes, waivers, database, memoryRootRelative)
    );
    warnings.push(...workflowCoverageWarnings(repoRoot, changedFiles, changedFileSet, database, memoryRootRelative));

    return {
      ok: changes.every((change) => change.status !== "uncovered"),
      databasePath,
      repoRoot,
      changedFiles,
      changes,
      waivers,
      warnings
    };
  } finally {
    database.close();
  }
}

function coverageForFile(
  file: string,
  changedFileSet: Set<string>,
  indexes: CoverageIndex[],
  claims: MemoryFile[],
  recipes: RecipeCoverageFile[],
  waivers: CoverageWaiver[],
  database: SqliteDatabase,
  memoryRootRelative: string
): CoverageChange {
  const matchingIndexes = indexes.filter((index) => index.watchedFiles.some((pattern) => pathMatchesPattern(pattern, file)));

  if (matchingIndexes.length === 0) {
    return {
      path: file,
      status: "ignored",
      watchedBy: [],
      relatedMemoryFiles: [],
      changedMemoryFiles: [],
      waiverIds: []
    };
  }

  const relatedMemoryFiles = relatedMemoryFilesFor(file, matchingIndexes, claims, recipes, database, memoryRootRelative);
  const changedMemoryFiles = relatedMemoryFiles.filter((memoryFile) => changedFileSet.has(memoryFile));

  if (changedMemoryFiles.length > 0) {
    return {
      path: file,
      status: "covered",
      watchedBy: matchingIndexes.map((index) => index.id),
      relatedMemoryFiles,
      changedMemoryFiles,
      waiverIds: []
    };
  }

  const matchingWaivers = waivers.filter(
    (waiver) => waiver.valid && waiver.files.some((pattern) => pathMatchesPattern(pattern, file))
  );

  if (matchingWaivers.length > 0) {
    return {
      path: file,
      status: "waived",
      watchedBy: matchingIndexes.map((index) => index.id),
      relatedMemoryFiles,
      changedMemoryFiles: [],
      waiverIds: matchingWaivers.map((waiver) => waiver.id)
    };
  }

  return {
    path: file,
    status: "uncovered",
    watchedBy: matchingIndexes.map((index) => index.id),
    relatedMemoryFiles,
    changedMemoryFiles: [],
    waiverIds: [],
    remediation: "Update a related claim, index, or recipe in the same change set, or add a valid coverage waiver."
  };
}

function relatedMemoryFilesFor(
  changedFile: string,
  indexes: CoverageIndex[],
  claims: MemoryFile[],
  recipes: RecipeCoverageFile[],
  database: SqliteDatabase,
  memoryRootRelative: string
): string[] {
  const files = new Set<string>();

  for (const index of indexes) {
    files.add(memoryPath(memoryRootRelative, index.sourcePath));

    for (const claim of claims) {
      if (index.claimGlobs.some((glob) => pathMatchesPattern(glob, claim.sourcePath))) {
        files.add(memoryPath(memoryRootRelative, claim.sourcePath));
      }
    }

    for (const recipe of recipes) {
      if (index.recipeGlobs.some((glob) => pathMatchesPattern(glob, recipe.sourcePath))) {
        files.add(memoryPath(memoryRootRelative, recipe.sourcePath));
      }
    }
  }

  for (const row of database.all<{ sourcePath: string }>(
    `SELECT DISTINCT c.source_path AS sourcePath
     FROM claims c
     JOIN claim_files f ON f.claim_id = c.id
     WHERE f.path = ?`,
    [changedFile]
  )) {
    files.add(memoryPath(memoryRootRelative, row.sourcePath));
  }

  for (const recipe of recipes) {
    if (recipe.relevantFiles.some((pattern) => pathMatchesPattern(pattern, changedFile))) {
      files.add(memoryPath(memoryRootRelative, recipe.sourcePath));
    }
  }

  return Array.from(files).sort();
}

function workflowCoverageWarnings(
  repoRoot: string,
  changedFiles: string[],
  changedFileSet: Set<string>,
  database: SqliteDatabase,
  memoryRootRelative: string
): string[] {
  const warnings: string[] = [];
  warnings.push(...activePlanRunWarnings(repoRoot, changedFiles));
  warnings.push(...planTemplateCoverageWarnings(changedFiles, changedFileSet, database, memoryRootRelative));
  warnings.push(...profileCoverageWarnings(changedFiles, changedFileSet, database, memoryRootRelative));
  return Array.from(new Set(warnings)).sort();
}

function activePlanRunWarnings(repoRoot: string, changedFiles: string[]): string[] {
  const warnings: string[] = [];

  for (const file of changedFiles) {
    const absolutePath = path.join(repoRoot, file);
    if (!file.startsWith(".agent-memory/plans/") || !(file.endsWith(".yaml") || file.endsWith(".yml")) || !fs.existsSync(absolutePath)) {
      continue;
    }

    try {
      const data = parseYaml(fs.readFileSync(absolutePath, "utf8"));
      const raw = isRecord(data) ? data : {};
      if (readString(raw, "status") === "active") {
        warnings.push(`${file}: active plan runs are local task state and should not be staged by default.`);
      }
    } catch (error) {
      warnings.push(`${file}: could not inspect plan run status (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  return warnings;
}

function planTemplateCoverageWarnings(
  changedFiles: string[],
  changedFileSet: Set<string>,
  database: SqliteDatabase,
  memoryRootRelative: string
): string[] {
  const warnings: string[] = [];
  const stages = database.all<PlanTemplateCoverageRow>(
    `SELECT p.id, p.source_path AS sourcePath, s.stage_id AS stageId, s.metadata_json AS metadataJson
     FROM plan_templates p
     JOIN plan_stages s ON s.plan_id = p.id
     WHERE p.status IN ('current', 'proposed', 'needs_review')`
  );

  for (const changedFile of changedFiles) {
    for (const stage of stages) {
      const metadata = parseJson(stage.metadataJson);
      const sourceFiles = readStringArray(metadata, "source_files");
      const planPath = memoryPath(memoryRootRelative, stage.sourcePath);

      if (sourceFiles.some((pattern) => pathMatchesPattern(pattern, changedFile)) && !changedFileSet.has(planPath)) {
        warnings.push(`${changedFile}: plan template ${stage.id} stage ${stage.stageId} references this file; review only if workflow guidance changed.`);
      }
    }
  }

  return warnings;
}

function profileCoverageWarnings(
  changedFiles: string[],
  changedFileSet: Set<string>,
  database: SqliteDatabase,
  memoryRootRelative: string
): string[] {
  const warnings: string[] = [];
  const profiles = database.all<ProfileCoverageRow>(
    "SELECT id, source_path AS sourcePath, applies_when_json AS appliesWhenJson FROM profile_traits WHERE status IN ('current', 'proposed', 'needs_review')"
  );

  for (const changedFile of changedFiles) {
    for (const profile of profiles) {
      const appliesWhen = parseJson(profile.appliesWhenJson);
      const profilePath = memoryPath(memoryRootRelative, profile.sourcePath);
      const patterns = [...readStringArray(appliesWhen, "changed_files"), ...readStringArray(appliesWhen, "file_globs"), ...readStringArray(appliesWhen, "files")];

      if (patterns.some((pattern) => pathMatchesPattern(pattern, changedFile)) && !changedFileSet.has(profilePath)) {
        warnings.push(`${changedFile}: profile trait ${profile.id} may apply; update the trait only if guidance changed.`);
      }
    }
  }

  return warnings;
}

function loadCoverageIndexes(database: SqliteDatabase): CoverageIndex[] {
  return database.all<{ id: string; source_path: string; metadata_json: string }>("SELECT id, source_path, metadata_json FROM indexes").map((row) => {
    const metadata = parseJson(row.metadata_json);

    return {
      id: row.id,
      sourcePath: row.source_path,
      watchedFiles: readStringArray(metadata, "watched_files"),
      claimGlobs: readStringArray(metadata, "claim_globs"),
      recipeGlobs: readStringArray(metadata, "recipe_globs")
    };
  });
}

function loadRecipeCoverageFiles(database: SqliteDatabase): RecipeCoverageFile[] {
  return database.all<{ id: string; sourcePath: string; metadataJson: string }>("SELECT id, source_path AS sourcePath, metadata_json AS metadataJson FROM recipes").map((row) => ({
    id: row.id,
    sourcePath: row.sourcePath,
    relevantFiles: readStringArray(parseJson(row.metadataJson), "relevant_files")
  }));
}

function loadCoverageWaivers(memoryRoot: string, patterns: string[]): CoverageWaiver[] {
  return discoverFiles(memoryRoot, patterns).map((filePath) => {
    const sourcePath = toPosix(path.relative(memoryRoot, filePath));

    try {
      const data = parseYaml(fs.readFileSync(filePath, "utf8"));
      const waiver = normalizeWaiver(data, sourcePath);
      return waiver;
    } catch (error) {
      return {
        id: sourcePath,
        sourcePath,
        files: [],
        valid: false,
        problems: [error instanceof Error ? error.message : String(error)]
      };
    }
  });
}

function normalizeWaiver(data: unknown, sourcePath: string): CoverageWaiver {
  const raw = isRecord(data) ? data : {};
  const id = readString(raw, "id") || sourcePath;
  const reason = readString(raw, "reason") || undefined;
  const files = readFirstStringArray(raw, ["files", "watched_files", "paths"]);
  const expiresAt = readString(raw, "expires_at") || readString(raw, "expires") || undefined;
  const status = readString(raw, "status") || "active";
  const problems: string[] = [];

  if (!isRecord(data)) {
    problems.push("Waiver file must be a YAML mapping.");
  }

  if (!readString(raw, "id")) {
    problems.push("Waiver must include an id.");
  }

  if (!reason) {
    problems.push("Waiver must include a reason.");
  }

  if (files.length === 0) {
    problems.push("Waiver must include at least one file pattern in files, watched_files, or paths.");
  }

  if (!["active", "current"].includes(status)) {
    problems.push(`Waiver status must be active or current, got ${status}.`);
  }

  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);

    if (Number.isNaN(expiresAtMs)) {
      problems.push(`Waiver expires_at is not a valid date: ${expiresAt}.`);
    } else if (expiresAtMs < Date.now()) {
      problems.push(`Waiver expired at ${expiresAt}.`);
    }
  }

  return {
    id,
    sourcePath,
    reason,
    files,
    expiresAt,
    valid: problems.length === 0,
    problems
  };
}

function normalizeCoverageFiles(files: string[], repoRoot: string): string[] {
  return Array.from(new Set(normalizeChangedFiles(files, repoRoot))).sort();
}

function memoryPath(memoryRootRelative: string, sourcePath: string): string {
  return toPosix(path.join(memoryRootRelative, sourcePath));
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readString(data: Record<string, unknown>, field: string): string {
  return typeof data[field] === "string" ? data[field] : "";
}

function readStringArray(data: Record<string, unknown>, field: string): string[] {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readFirstStringArray(data: Record<string, unknown>, fields: string[]): string[] {
  for (const field of fields) {
    const values = readStringArray(data, field);

    if (values.length > 0) {
      return values;
    }
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
