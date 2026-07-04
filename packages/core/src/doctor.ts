import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { canonicalMemoryFileInventory, discoverCanonicalMemoryFiles, resolveConfiguredPath } from "./files";
import { openSqliteDatabase } from "./sqlite";
import { PACKAGE_VERSION } from "./version";
import { parseYaml } from "./yaml";

export type DoctorStatus = "ok" | "warning";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  remediation?: string;
}

export interface DoctorResult {
  healthy: boolean;
  databasePath: string;
  repoRoot: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  cwd?: string;
}

const COMPLETED_PLAN_RUN_WARNING_COUNT = 10;
const COMPLETED_PLAN_RUN_WARNING_AGE_DAYS = 30;

export async function doctorMemory(options: DoctorOptions = {}): Promise<DoctorResult> {
  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memoryRoot = resolveConfiguredPath(repoRoot, loaded.config.memory_root);
  const databasePath = path.isAbsolute(loaded.config.database_path) ? loaded.config.database_path : path.join(repoRoot, loaded.config.database_path);
  const checks: DoctorCheck[] = [];

  if (!fs.existsSync(databasePath)) {
    checks.push(warn("database_exists", `Database does not exist at ${databasePath}.`, "Run `agent-memory compile`."));
    return result(false, databasePath, repoRoot, checks);
  }

  checks.push(ok("database_exists", `Database exists at ${databasePath}.`));

  const database = await openSqliteDatabase(databasePath, { readonly: true });

  try {
    const metadataTableExists = tableExists(database, "compile_metadata");
    const metadata = metadataTableExists ? readMetadata(database) : new Map<string, string>();

    if (metadataTableExists) {
      checks.push(ok("metadata", "Compile metadata table exists."));
    } else {
      checks.push(warn("metadata", "Compile metadata table is missing.", "Run `agent-memory compile`."));
    }

    const schemaVersion = metadata.get("schema_version");
    const packageVersion = metadata.get("package_version");
    const gitCommit = metadata.get("git_commit");
    const configHash = metadata.get("config_hash");
    const canonicalFilesHash = metadata.get("canonical_files_hash");

    if (schemaVersion === "1") {
      checks.push(ok("schema_version", "Database schema version is current."));
    } else {
      checks.push(warn("schema_version", `Expected schema version 1, found ${schemaVersion ?? "missing"}.`, "Run `agent-memory compile`."));
    }

    if (packageVersion === PACKAGE_VERSION) {
      checks.push(ok("package_version", "Database package version matches the CLI."));
    } else {
      checks.push(warn("package_version", `Database package version is ${packageVersion ?? "missing"}, CLI is ${PACKAGE_VERSION}.`, "Run `agent-memory compile`."));
    }

    const currentCommit = currentGitCommit(repoRoot);

    if (currentCommit === "unknown" || gitCommit === currentCommit) {
      checks.push(ok("git_commit", "Database git commit matches current checkout."));
    } else {
      checks.push(warn("git_commit", `Database was compiled from ${gitCommit ?? "missing"}, current commit is ${currentCommit}.`, "Run `agent-memory compile`."));
    }

    const currentConfigHash = sha256(fs.readFileSync(loaded.path, "utf8"));

    if (configHash === currentConfigHash) {
      checks.push(ok("config_hash", "Database config hash matches current config."));
    } else {
      checks.push(warn("config_hash", "Database config hash does not match current config.", "Run `agent-memory compile`."));
    }

    const currentCanonicalFilesHash = sha256(JSON.stringify(canonicalMemoryFileInventory(memoryRoot, loaded.config)));

    if (canonicalFilesHash === currentCanonicalFilesHash) {
      checks.push(ok("file_inventory", "Canonical memory file inventory matches compiled database."));
    } else {
      checks.push(warn("file_inventory", "Canonical memory file inventory changed since compile.", "Run `agent-memory compile`."));
    }

    if (isDatabaseFresh(databasePath, memoryRoot, loaded.config)) {
      checks.push(ok("freshness", "Database is newer than canonical memory files."));
    } else {
      checks.push(warn("freshness", "Database is older than one or more canonical memory files.", "Run `agent-memory compile`."));
    }

    if (tableExists(database, "claims_fts")) {
      checks.push(ok("fts", "FTS table exists."));
    } else {
      checks.push(warn("fts", "FTS table is missing.", "Run `agent-memory compile`."));
    }

    checks.push(...localPlanRunChecks(repoRoot));
  } finally {
    database.close();
  }

  return result(checks.every((check) => check.status === "ok"), databasePath, repoRoot, checks);
}

function readMetadata(database: { all<T>(sql: string, params?: unknown[]): T[] }): Map<string, string> {
  const rows = database.all<{ key: string; value: string }>("SELECT key, value FROM compile_metadata");
  return new Map(rows.map((row) => [row.key, row.value]));
}

function tableExists(database: { get<T>(sql: string, params?: unknown[]): T | null }, tableName: string): boolean {
  const row = database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  return Boolean(row);
}

function isDatabaseFresh(
  databasePath: string,
  memoryRoot: string,
  config: {
    claims: string[];
    graphs: string[];
    indexes: string[];
    recipes: string[];
    plans?: string[];
    profiles?: string[];
    waivers: string[];
  }
): boolean {
  const databaseMtime = fs.statSync(databasePath).mtimeMs;
  const files = discoverCanonicalMemoryFiles(memoryRoot, config);
  const newestMemoryMtime = files.reduce((newest, filePath) => Math.max(newest, fs.statSync(filePath).mtimeMs), 0);

  return databaseMtime >= newestMemoryMtime;
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

function localPlanRunChecks(repoRoot: string): DoctorCheck[] {
  const root = path.join(repoRoot, ".agent-memory/plans");

  if (!fs.existsSync(root)) {
    return [ok("plan_runs", "No local plan runs found.")];
  }

  const warnings: DoctorCheck[] = [];
  const runs = walkYamlFiles(root)
    .map((filePath) => readPlanRunSummary(filePath))
    .filter((run): run is { status: string; updatedAt: string; path: string } => run !== null);
  const completedOrAbandoned = runs.filter((run) => run.status === "complete" || run.status === "abandoned");

  if (completedOrAbandoned.length > COMPLETED_PLAN_RUN_WARNING_COUNT) {
    warnings.push(
      warn(
        "plan_runs_accumulated",
        `${completedOrAbandoned.length} completed or abandoned local plan runs remain under .agent-memory/plans.`,
        `Run \`agent-memory plans prune --completed --abandoned --older-than ${COMPLETED_PLAN_RUN_WARNING_AGE_DAYS}d\` or delete one-off runs after preserving durable memory.`
      )
    );
  }

  const cutoff = Date.now() - COMPLETED_PLAN_RUN_WARNING_AGE_DAYS * 24 * 60 * 60 * 1000;
  const oldRuns = completedOrAbandoned.filter((run) => {
    const time = Date.parse(run.updatedAt);
    return Number.isFinite(time) && time < cutoff;
  });

  if (oldRuns.length > 0) {
    warnings.push(
      warn(
        "plan_runs_old_completed",
        `${oldRuns.length} completed or abandoned local plan runs are older than ${COMPLETED_PLAN_RUN_WARNING_AGE_DAYS} days.`,
        "Prune old local plan runs after promoting reusable knowledge into claims, recipes, graph edges, indexes, or profile traits."
      )
    );
  }

  return warnings.length > 0 ? warnings : [ok("plan_runs", "Local plan run accumulation is within expected bounds.")];
}

function walkYamlFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkYamlFiles(entryPath));
    } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function readPlanRunSummary(filePath: string): { status: string; updatedAt: string; path: string } | null {
  try {
    const data = parseYaml(fs.readFileSync(filePath, "utf8"));
    const raw = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    const status = typeof raw.status === "string" ? raw.status : "";
    const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : typeof raw.created_at === "string" ? raw.created_at : "";
    return { status, updatedAt, path: filePath };
  } catch {
    return null;
  }
}

function ok(name: string, message: string): DoctorCheck {
  return { name, status: "ok", message };
}

function warn(name: string, message: string, remediation?: string): DoctorCheck {
  return { name, status: "warning", message, remediation };
}

function result(healthy: boolean, databasePath: string, repoRoot: string, checks: DoctorCheck[]): DoctorResult {
  return { healthy, databasePath, repoRoot, checks };
}
