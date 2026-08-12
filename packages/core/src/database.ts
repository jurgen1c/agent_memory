import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentMemoryError, ConfigError } from "./errors";
import { runGit } from "./git";
import { deriveRepositoryIdentity } from "./memory_key";
import { canonicalRepositoryRoot, ensureGlobalDatabaseDirectory, resolveGlobalHome, updateRegistryCheckout } from "./registry";
import type { SqliteDatabase } from "./sqlite";
import type { LoadedConfig } from "./types";
import { PACKAGE_VERSION } from "./version";

export type DatabaseScope = "local" | "global";

export type DatabaseLocationSource = "cli_override" | "local_config" | "global_registry";

export interface DatabaseLocationConfig {
  database_path: string;
  database_scope?: DatabaseScope;
  memory_key?: string;
}

export interface GlobalDatabaseLocation {
  databasePath: string;
  checkoutFingerprint: string;
  repositoryIdentity: string;
}

export interface ResolveDatabaseLocationOptions {
  config: DatabaseLocationConfig;
  repoRoot: string;
  dbPath?: string;
  globalLocation?: GlobalDatabaseLocation;
}

export interface ResolvedDatabaseLocation {
  path: string;
  scope: DatabaseScope;
  source: DatabaseLocationSource;
  memoryKey?: string;
  checkoutFingerprint?: string;
  repositoryIdentity?: string;
}

export interface AssertGlobalDatabaseProvenanceOptions {
  includeConfigHash?: boolean;
}

export function missingDatabaseGuidance(location: ResolvedDatabaseLocation): string {
  return location.source === "global_registry"
    ? "Run `agent-memory compile` or `agent-memory sync` first."
    : "Run `agent-memory compile` first.";
}

export interface ResolveConfiguredDatabaseLocationOptions {
  loaded: LoadedConfig;
  dbPath?: string;
  globalHome?: string;
  now?: Date;
}

export function resolveConfiguredDatabaseLocation(
  options: ResolveConfiguredDatabaseLocationOptions
): ResolvedDatabaseLocation {
  const { config, repo } = options.loaded;
  if (options.dbPath !== undefined || (config.database_scope ?? "local") === "local") {
    return resolveDatabaseLocation({ config, repoRoot: repo.root, dbPath: options.dbPath });
  }

  const memoryKey = config.memory_key?.trim();
  if (!memoryKey) {
    return resolveDatabaseLocation({ config, repoRoot: repo.root });
  }

  const globalHome = options.globalHome ?? resolveGlobalHome();
  const repositoryIdentity = deriveRepositoryIdentity(repo.root);
  const registered = updateRegistryCheckout({
    globalHome,
    memoryKey,
    repositoryIdentity,
    repoRoot: repo.root,
    configPath: options.loaded.path,
    packageVersion: PACKAGE_VERSION,
    configHash: sha256(fs.readFileSync(options.loaded.path, "utf8")),
    gitHead: currentGitHead(repo.root),
    now: options.now
  });
  ensureGlobalDatabaseDirectory(globalHome, memoryKey, registered.checkoutFingerprint);

  return resolveDatabaseLocation({
    config,
    repoRoot: repo.root,
    globalLocation: {
      databasePath: registered.databasePath,
      checkoutFingerprint: registered.checkoutFingerprint,
      repositoryIdentity
    }
  });
}

export function resolveDatabaseLocation(options: ResolveDatabaseLocationOptions): ResolvedDatabaseLocation {
  const scope = options.config.database_scope ?? "local";
  if (scope === "global" && !options.config.memory_key?.trim()) {
    throw new ConfigError("Global database scope requires config field memory_key.", {
      details: ["Set memory_key to the repository's stable global-memory identity before resolving its database."]
    });
  }

  const common = {
    scope,
    ...(options.config.memory_key === undefined ? {} : { memoryKey: options.config.memory_key })
  };

  if (options.dbPath !== undefined) {
    return {
      path: resolveFromRepo(options.repoRoot, options.dbPath),
      source: "cli_override",
      ...common
    };
  }

  if (scope === "local") {
    return {
      path: resolveFromRepo(options.repoRoot, options.config.database_path),
      source: "local_config",
      ...common
    };
  }

  if (!options.globalLocation) {
    throw new ConfigError("Global database location is unavailable for this repository.", {
      details: ["Resolve the repository's global registry entry before accessing its generated database."]
    });
  }

  if (!path.isAbsolute(options.globalLocation.databasePath)) {
    throw new ConfigError(`Global database path must be absolute: ${options.globalLocation.databasePath}`);
  }

  return {
    path: path.normalize(options.globalLocation.databasePath),
    source: "global_registry",
    checkoutFingerprint: options.globalLocation.checkoutFingerprint,
    repositoryIdentity: options.globalLocation.repositoryIdentity,
    ...common
  };
}

export function assertGlobalDatabaseProvenance(
  database: Pick<SqliteDatabase, "all">,
  location: ResolvedDatabaseLocation,
  loaded: LoadedConfig,
  options: AssertGlobalDatabaseProvenanceOptions = {}
): void {
  if (location.source !== "global_registry") {
    return;
  }

  let metadata: Map<string, string>;

  try {
    metadata = new Map(
      database
        .all<{ key: string; value: string }>("SELECT key, value FROM compile_metadata")
        .map((row) => [row.key, row.value] as const)
    );
  } catch (error) {
    throw globalDatabaseProvenanceError(error);
  }

  const expectedMetadata = new Map<string, string | undefined>([
    ["memory_key", location.memoryKey],
    ["checkout_fingerprint", location.checkoutFingerprint],
    ["repository_identity", location.repositoryIdentity],
    ["repo_root", canonicalRepositoryRoot(loaded.repo.root)],
    ...(options.includeConfigHash === false
      ? []
      : [["config_hash", sha256(fs.readFileSync(loaded.path, "utf8"))] as const])
  ]);

  if (Array.from(expectedMetadata).some(([key, expected]) => !expected || metadata.get(key) !== expected)) {
    throw globalDatabaseProvenanceError();
  }
}

function resolveFromRepo(repoRoot: string, databasePath: string): string {
  return path.isAbsolute(databasePath) ? databasePath : path.resolve(repoRoot, databasePath);
}

function currentGitHead(repoRoot: string): string | null {
  try {
    return runGit(repoRoot, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function globalDatabaseProvenanceError(cause?: unknown): AgentMemoryError {
  return new AgentMemoryError("Global database provenance does not match the current checkout.", {
    details: ["Run `agent-memory compile` to rebuild the generated cache from canonical memory."],
    ...(cause === undefined ? {} : { cause })
  });
}
