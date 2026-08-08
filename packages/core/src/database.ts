import path from "node:path";
import { ConfigError } from "./errors";

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
    ...common
  };
}

function resolveFromRepo(repoRoot: string, databasePath: string): string {
  return path.isAbsolute(databasePath) ? databasePath : path.resolve(repoRoot, databasePath);
}
