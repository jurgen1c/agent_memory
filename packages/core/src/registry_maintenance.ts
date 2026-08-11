import fs from "node:fs";
import path from "node:path";
import { inspectFileSystemPathSync } from "@jurgen1c/agent-core/filesystem";
import { resolveContainedPath } from "@jurgen1c/agent-core/repository";
import { sqliteArtifactPaths } from "@jurgen1c/agent-core/sqlite";
import { loadConfig } from "./config";
import { NotFoundError } from "./errors";
import { deriveRepositoryIdentity } from "./memory_key";
import {
  canonicalRepositoryRoot,
  deriveGlobalDatabasePath,
  readRegistry,
  registryPaths,
  resolveGlobalHome,
  updateRegistry,
  type AgentMemoryRegistry,
  type RegistryCheckoutRecord,
  type RegistryMemoryRecord,
  type RegistryWriteOptions
} from "./registry";

export type RegistryDatabaseStatus = "present" | "missing";
export type RegistryCheckoutStatus = "active" | "stale" | "inconclusive";

export interface RegistryCheckoutSummary {
  memory_key: string;
  checkout_fingerprint: string;
  scope: "global";
  repo_root: string;
  config_path: string;
  database_path: string;
  database_status: RegistryDatabaseStatus;
  checkout_status: RegistryCheckoutStatus;
  stale: boolean;
  package_version: string;
  config_hash: string;
  git_head: string | null;
  last_seen_at: string;
}

export interface RegistryMemorySummary {
  memory_key: string;
  repository_identity: string | null;
  checkout_count: number;
  effective_database_paths: string[];
  checkouts: RegistryCheckoutSummary[];
}

export interface RegistryListResult {
  global_home: string;
  registry_path: string;
  memory_count: number;
  checkout_count: number;
  memories: RegistryMemorySummary[];
}

export interface RegistryDoctorFinding {
  code: "stale_path" | "missing_database" | "duplicate_key" | "corrupt_metadata";
  severity: "warning" | "error";
  message: string;
  guidance: string;
  memory_key?: string;
  checkout_fingerprint?: string;
}

export interface RegistryDoctorResult {
  healthy: boolean;
  global_home: string;
  registry_path: string;
  memory_count: number;
  checkout_count: number;
  findings: RegistryDoctorFinding[];
}

export interface RegistryPruneResult {
  dry_run: boolean;
  stale_count: number;
  pruned_count: number;
  entries: RegistryCheckoutSummary[];
  empty_memory_keys: string[];
}

export interface RegistryMaintenanceOptions {
  globalHome?: string;
}

export interface PruneRegistryOptions extends RegistryMaintenanceOptions, Pick<RegistryWriteOptions, "lockTimeoutMs" | "lockRetryMs"> {
  force?: boolean;
}

type CheckoutMappingInspection =
  | { status: "active" }
  | { status: "stale" }
  | { status: "inconclusive"; message: string };

interface StagedCheckoutDirectory {
  original: string;
  staged: string;
}

interface PrunableRegistryCheckoutRecord extends RegistryCheckoutRecord {
  prune_pending?: boolean;
}

type PathInspection =
  | { status: "present" }
  | { status: "missing" }
  | { status: "inconclusive"; message: string };

export function listRegistry(options: RegistryMaintenanceOptions = {}): RegistryListResult {
  const registry = readRegistry({ globalHome: options.globalHome });
  const paths = registryPaths(options.globalHome);
  const memories = Object.entries(registry.memories)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([memoryKey, memory]) => summarizeMemory(memoryKey, memory));

  return {
    global_home: paths.home,
    registry_path: paths.registry,
    memory_count: memories.length,
    checkout_count: memories.reduce((count, memory) => count + memory.checkout_count, 0),
    memories
  };
}

export function showRegistryMemory(memoryKey: string, options: RegistryMaintenanceOptions = {}): RegistryMemorySummary {
  const result = listRegistry(options);
  const memory = result.memories.find((candidate) => candidate.memory_key === memoryKey);

  if (!memory) {
    throw new NotFoundError(`Registry memory key not found: ${memoryKey}`, {
      details: ["Run `agent-memory registry list` to inspect known memory keys."]
    });
  }

  return memory;
}

export function doctorRegistry(options: RegistryMaintenanceOptions = {}): RegistryDoctorResult {
  const requestedHome = path.resolve(options.globalHome ?? resolveGlobalHome());
  let paths = {
    home: requestedHome,
    registry: path.join(requestedHome, "registry.json")
  };
  let registry: AgentMemoryRegistry;

  try {
    registry = readRegistry({ globalHome: options.globalHome });
    paths = registryPaths(options.globalHome);
  } catch (error) {
    return {
      healthy: false,
      global_home: paths.home,
      registry_path: paths.registry,
      memory_count: 0,
      checkout_count: 0,
      findings: [{
        code: "corrupt_metadata",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        guidance: "Move the unsafe registry aside and rebuild it from active repositories; do not copy canonical memory into global home."
      }]
    };
  }

  const findings: RegistryDoctorFinding[] = [];
  const activeRoots = new Map<string, Set<string>>();

  for (const [memoryKey, memory] of Object.entries(registry.memories).sort(([left], [right]) => left.localeCompare(right))) {
    if (Object.keys(memory.checkouts).length === 0) {
      findings.push({
        code: "corrupt_metadata",
        severity: "warning",
        memory_key: memoryKey,
        message: `Memory key ${memoryKey} has no checkout records.`,
        guidance: "Prune the empty generated registry record or rebuild it by syncing an active checkout."
      });
    }

    for (const [fingerprint, checkout] of Object.entries(memory.checkouts).sort(([left], [right]) => left.localeCompare(right))) {
      const common = { memory_key: memoryKey, checkout_fingerprint: fingerprint };
      const inspection = inspectCheckoutMapping(memoryKey, checkout);

      if (inspection.status === "stale") {
        findings.push({
          code: "stale_path",
          severity: "warning",
          ...common,
          message: `Registered global checkout mapping is stale: ${checkout.repo_root}`,
          guidance: "Run `agent-memory registry prune` to preview removal, then repeat with --force after confirming the checkout moved, was deleted, or no longer selects this global memory key."
        });
      } else if (inspection.status === "inconclusive") {
        findings.push({
          code: "corrupt_metadata",
          severity: "error",
          ...common,
          message: `Could not verify registered checkout configuration: ${inspection.message}`,
          guidance: "Repair or make the registered config readable before pruning; inconclusive mappings are never deleted."
        });
      } else {
        const canonicalRoot = canonicalRepositoryRoot(checkout.repo_root);
        const keys = activeRoots.get(canonicalRoot) ?? new Set<string>();
        keys.add(memoryKey);
        activeRoots.set(canonicalRoot, keys);

        try {
          const actualIdentity = deriveRepositoryIdentity(checkout.repo_root);
          if (memory.repository_identity === null) {
            findings.push({
              code: "corrupt_metadata",
              severity: "error",
              ...common,
              message: `Memory key ${memoryKey} has no verified repository identity.`,
              guidance: "Repair the generated registry mapping from this active checkout before trusting or reusing its database."
            });
          } else if (actualIdentity !== memory.repository_identity) {
            findings.push({
              code: "duplicate_key",
              severity: "error",
              ...common,
              message: `Memory key ${memoryKey} does not match the active checkout repository identity.`,
              guidance: "Choose a distinct memory_key for unrelated repositories or repair the generated registry mapping before reuse."
            });
          }
        } catch {
          findings.push({
            code: "corrupt_metadata",
            severity: "error",
            ...common,
            message: `Repository identity could not be verified for active checkout ${checkout.repo_root}.`,
            guidance: "Repair the checkout origin or switch it to local storage before trusting this registry mapping."
          });
        }
      }

      if (!fs.existsSync(checkout.database_path)) {
        findings.push({
          code: "missing_database",
          severity: "warning",
          ...common,
          message: `Generated database is missing: ${checkout.database_path}`,
          guidance: inspection.status === "active"
            ? `Run \`agent-memory sync\` from ${checkout.repo_root}.`
            : "Prune the stale checkout mapping, or restore the checkout and run `agent-memory sync`."
        });
      }
    }
  }

  for (const [repoRoot, keys] of Array.from(activeRoots.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    if (keys.size < 2) continue;
    findings.push({
      code: "duplicate_key",
      severity: "error",
      message: `Active checkout ${repoRoot} is registered under multiple memory keys: ${Array.from(keys).sort().join(", ")}.`,
      guidance: "Keep one authoritative memory_key for the checkout and repair the duplicate generated registry entries."
    });
  }

  const memoryCount = Object.keys(registry.memories).length;
  const checkoutCount = Object.values(registry.memories)
    .reduce((count, memory) => count + Object.keys(memory.checkouts).length, 0);

  return {
    healthy: findings.length === 0,
    global_home: paths.home,
    registry_path: paths.registry,
    memory_count: memoryCount,
    checkout_count: checkoutCount,
    findings
  };
}

export function pruneRegistry(options: PruneRegistryOptions = {}): RegistryPruneResult {
  const before = listRegistry({ globalHome: options.globalHome });
  const paths = registryPaths(before.global_home);
  const staleEntries = before.memories.flatMap((memory) => memory.checkouts.filter((checkout) => checkout.stale));
  const emptyMemoryKeys = before.memories
    .filter((memory) => memory.checkout_count === 0)
    .map((memory) => memory.memory_key);
  const staleCount = staleEntries.length + emptyMemoryKeys.length;

  if (!options.force) {
    return {
      dry_run: true,
      stale_count: staleCount,
      pruned_count: 0,
      entries: staleEntries,
      empty_memory_keys: emptyMemoryKeys
    };
  }

  const prunedEntries: RegistryCheckoutSummary[] = [];
  const prunedEmptyMemoryKeys: string[] = [];
  const stagedDirectories: StagedCheckoutDirectory[] = [];
  const stagingRoot = path.join(paths.home, ".registry-prune");
  updateRegistry((registry) => {
    const currentMemories = Object.entries(registry.memories)
      .sort(([left], [right]) => left.localeCompare(right));
    const currentStaleEntries = currentMemories.flatMap(([memoryKey, memory]) =>
      Object.entries(memory.checkouts)
        .sort(([left], [right]) => left.localeCompare(right))
        .filter(([, checkout]) => inspectCheckoutMapping(memoryKey, checkout).status === "stale")
        .map(([fingerprint, checkout]) => summarizeCheckout(memoryKey, fingerprint, checkout))
    );

    for (const entry of currentStaleEntries) assertPrunableGeneratedDirectory(paths.home, entry);

    for (const entry of currentStaleEntries) {
      const memory = registry.memories[entry.memory_key];
      const checkout = memory?.checkouts[entry.checkout_fingerprint] as PrunableRegistryCheckoutRecord | undefined;
      if (!checkout || inspectCheckoutMapping(entry.memory_key, checkout).status !== "stale") continue;

      const staged = stageGeneratedCheckout(paths.home, stagingRoot, entry);
      if (staged) stagedDirectories.push(staged);
      checkout.prune_pending = true;
    }
  }, {
    globalHome: paths.home,
    lockTimeoutMs: options.lockTimeoutMs,
    lockRetryMs: options.lockRetryMs
  }, {
    onFailure: () => rollbackStagedCheckouts(stagedDirectories, stagingRoot),
    finalize: (registry) => {
      for (const entry of currentPendingEntries(registry)) {
        const staged = stagedCheckoutPath(stagingRoot, entry);
        const memory = registry.memories[entry.memory_key];
        const checkout = memory?.checkouts[entry.checkout_fingerprint] as PrunableRegistryCheckoutRecord | undefined;
        if (!checkout?.prune_pending) continue;

        const checkoutStatus = inspectCheckoutMapping(entry.memory_key, checkout).status;
        if (checkoutStatus !== "stale") {
          reconcileRetainedCheckout(path.dirname(entry.database_path), staged, checkoutStatus);
          delete checkout.prune_pending;
          continue;
        }

        fs.rmSync(staged, { recursive: true, force: true });
        delete memory.checkouts[entry.checkout_fingerprint];
        if (Object.keys(memory.checkouts).length === 0) delete registry.memories[entry.memory_key];
        prunedEntries.push(entry);
      }

      for (const [memoryKey, memory] of Object.entries(registry.memories)) {
        if (Object.keys(memory.checkouts).length > 0) continue;
        delete registry.memories[memoryKey];
        prunedEmptyMemoryKeys.push(memoryKey);
      }
      removeEmptyDirectory(stagingRoot);
    }
  });

  return {
    dry_run: false,
    stale_count: prunedEntries.length + prunedEmptyMemoryKeys.length,
    pruned_count: prunedEntries.length + prunedEmptyMemoryKeys.length,
    entries: prunedEntries,
    empty_memory_keys: prunedEmptyMemoryKeys
  };
}

function summarizeMemory(memoryKey: string, memory: RegistryMemoryRecord): RegistryMemorySummary {
  const checkouts = Object.entries(memory.checkouts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fingerprint, checkout]) => summarizeCheckout(memoryKey, fingerprint, checkout));

  return {
    memory_key: memoryKey,
    repository_identity: memory.repository_identity,
    checkout_count: checkouts.length,
    effective_database_paths: checkouts.map((checkout) => checkout.database_path),
    checkouts
  };
}

function summarizeCheckout(
  memoryKey: string,
  checkoutFingerprint: string,
  checkout: RegistryCheckoutRecord
): RegistryCheckoutSummary {
  const inspection = inspectCheckoutMapping(memoryKey, checkout);
  return {
    memory_key: memoryKey,
    checkout_fingerprint: checkoutFingerprint,
    scope: "global",
    repo_root: checkout.repo_root,
    config_path: checkout.config_path,
    database_path: checkout.database_path,
    database_status: fs.existsSync(checkout.database_path) ? "present" : "missing",
    checkout_status: inspection.status,
    stale: inspection.status === "stale",
    package_version: checkout.package_version,
    config_hash: checkout.config_hash,
    git_head: checkout.git_head,
    last_seen_at: checkout.last_seen_at
  };
}

function inspectCheckoutMapping(memoryKey: string, checkout: RegistryCheckoutRecord): CheckoutMappingInspection {
  const repoRoot = inspectPath(checkout.repo_root);
  if (repoRoot.status === "missing") return { status: "stale" };
  if (repoRoot.status === "inconclusive") return repoRoot;

  const configPathInspection = inspectPath(checkout.config_path);
  if (configPathInspection.status === "missing") return { status: "stale" };
  if (configPathInspection.status === "inconclusive") return configPathInspection;

  try {
    const containedConfigPath = resolveContainedPath(checkout.repo_root, checkout.config_path).absolutePath;
    const configPath = path.relative(checkout.repo_root, containedConfigPath);
    const loaded = loadConfig({ repoRoot: checkout.repo_root, configPath });
    return loaded.config.database_scope === "global" && loaded.config.memory_key === memoryKey
      ? { status: "active" }
      : { status: "stale" };
  } catch (error) {
    return {
      status: "inconclusive",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectPath(filePath: string): PathInspection {
  const inspection = inspectFileSystemPathSync(filePath);
  if (inspection.status !== "inconclusive") return inspection;
  return {
    status: "inconclusive",
    message: `Could not inspect ${filePath}: ${inspection.error instanceof Error ? inspection.error.message : String(inspection.error)}`
  };
}

function assertPrunableGeneratedDirectory(globalHome: string, entry: RegistryCheckoutSummary): void {
  const expectedDatabasePath = deriveGlobalDatabasePath(globalHome, entry.memory_key, entry.checkout_fingerprint);
  if (path.normalize(expectedDatabasePath) !== path.normalize(entry.database_path)) {
    throw new Error(`Refusing to prune a registry entry with an unexpected database path: ${entry.memory_key}/${entry.checkout_fingerprint}`);
  }

  const directory = path.dirname(expectedDatabasePath);
  if (!fs.existsSync(directory)) return;

  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to prune an unsafe generated checkout directory: ${directory}`);
  }

  const expectedNames = new Set(sqliteArtifactPaths("memory.sqlite"));
  const unexpected = fs.readdirSync(directory).filter((name) => !expectedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Refusing to prune unrecognized files in generated checkout directory: ${unexpected.join(", ")}`);
  }
}

function stageGeneratedCheckout(
  globalHome: string,
  stagingRoot: string,
  entry: RegistryCheckoutSummary
): StagedCheckoutDirectory | undefined {
  assertPrunableGeneratedDirectory(globalHome, entry);
  const databasePath = deriveGlobalDatabasePath(globalHome, entry.memory_key, entry.checkout_fingerprint);
  const original = path.dirname(databasePath);
  const staged = stagedCheckoutPath(stagingRoot, entry);
  const originalExists = fs.existsSync(original);
  const stagedExists = fs.existsSync(staged);
  if (!originalExists && !stagedExists) return undefined;
  if (originalExists && stagedExists) {
    throw new Error(`Refusing to prune with both active and staged generated checkout directories: ${entry.memory_key}/${entry.checkout_fingerprint}`);
  }

  ensurePruneStagingRoot(stagingRoot);
  if (stagedExists) {
    assertRecognizedGeneratedDirectory(staged);
    return undefined;
  }

  fs.renameSync(original, staged);
  return { original, staged };
}

function rollbackStagedCheckouts(
  stagedDirectories: StagedCheckoutDirectory[],
  stagingRoot: string
): void {
  for (const directory of [...stagedDirectories].reverse()) {
    if (!fs.existsSync(directory.staged)) continue;
    fs.mkdirSync(path.dirname(directory.original), { recursive: true, mode: 0o700 });
    fs.renameSync(directory.staged, directory.original);
  }

  removeEmptyDirectory(stagingRoot);
}

function reconcileRetainedCheckout(
  original: string,
  staged: string,
  checkoutStatus: Exclude<RegistryCheckoutStatus, "stale">
): void {
  if (!fs.existsSync(staged)) return;
  assertRecognizedGeneratedDirectory(staged);
  if (fs.existsSync(original)) {
    if (checkoutStatus === "active") {
      fs.rmSync(staged, { recursive: true });
      return;
    }
    throw new Error(`Refusing to restore staged generated state over an existing checkout directory: ${original}`);
  }
  fs.mkdirSync(path.dirname(original), { recursive: true, mode: 0o700 });
  fs.renameSync(staged, original);
}

function currentPendingEntries(registry: AgentMemoryRegistry): RegistryCheckoutSummary[] {
  return Object.entries(registry.memories).flatMap(([memoryKey, memory]) =>
    Object.entries(memory.checkouts)
      .filter(([, checkout]) => (checkout as PrunableRegistryCheckoutRecord).prune_pending === true)
      .map(([fingerprint, checkout]) => summarizeCheckout(memoryKey, fingerprint, checkout))
  );
}

function stagedCheckoutPath(stagingRoot: string, entry: RegistryCheckoutSummary): string {
  return path.join(stagingRoot, `${entry.memory_key}-${entry.checkout_fingerprint}`);
}

function ensurePruneStagingRoot(stagingRoot: string): void {
  try {
    const stat = fs.lstatSync(stagingRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to use unsafe registry prune staging path: ${stagingRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
  }
}

function assertRecognizedGeneratedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to prune an unsafe staged checkout directory: ${directory}`);
  }
  const expectedNames = new Set(sqliteArtifactPaths("memory.sqlite"));
  const unexpected = fs.readdirSync(directory).filter((name) => !expectedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Refusing to prune unrecognized staged files: ${unexpected.join(", ")}`);
  }
}

function removeEmptyDirectory(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
