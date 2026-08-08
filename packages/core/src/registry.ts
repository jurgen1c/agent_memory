import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInside, nearestExistingAncestor, resolveContainedPath } from "@jurgen1c/agent-core/repository";
import { AgentMemoryError } from "./errors";
import { isFullGitObjectId, repositoryObjectIdLength } from "./git";
import { isValidMemoryKey } from "./memory_key";

export const REGISTRY_VERSION = 1;
export const DEFAULT_REGISTRY_LOCK_TIMEOUT_MS = 1_000;
export const DEFAULT_REGISTRY_LOCK_RETRY_MS = 25;

const CHECKOUT_FINGERPRINT_PATTERN = /^[0-9a-f]{24}$/;

export interface RegistryCheckoutRecord extends Record<string, unknown> {
  repo_root: string;
  config_path: string;
  database_path: string;
  package_version: string;
  config_hash: string;
  git_head: string | null;
  last_seen_at: string;
}

export interface RegistryMemoryRecord extends Record<string, unknown> {
  repository_identity: string | null;
  checkouts: Record<string, RegistryCheckoutRecord>;
}

export interface AgentMemoryRegistry extends Record<string, unknown> {
  version: 1;
  memories: Record<string, RegistryMemoryRecord>;
}

export interface ResolveGlobalHomeOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

export interface RegistryPaths {
  home: string;
  registry: string;
  lock: string;
  databases: string;
}

export interface RegistryWriteOptions {
  globalHome?: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

export interface UpdateRegistryCheckoutOptions extends RegistryWriteOptions {
  memoryKey: string;
  repositoryIdentity: string;
  repoRoot: string;
  configPath: string;
  packageVersion: string;
  configHash: string;
  gitHead?: string | null;
  now?: Date;
}

export interface RegistryCheckoutDiagnostic {
  memoryKey: string;
  checkoutFingerprint: string;
  record: RegistryCheckoutRecord;
  stale: boolean;
  reason?: "repo_root_missing";
}

export class RegistryError extends AgentMemoryError {
  constructor(message: string, options: { details?: string[]; cause?: unknown } = {}) {
    super(message, {
      ...options,
      code: "REGISTRY_ERROR"
    });
    this.name = "RegistryError";
  }
}

export function resolveGlobalHome(options: ResolveGlobalHomeOptions = {}): string {
  const override = (options.env ?? process.env).AGENT_MEMORY_HOME;

  if (override !== undefined && override.trim().length > 0) {
    if (!path.isAbsolute(override)) {
      throw new RegistryError(`AGENT_MEMORY_HOME must be an absolute path: ${override}`, {
        details: ["Set AGENT_MEMORY_HOME to a dedicated private directory, such as /home/user/.agent-memory."]
      });
    }

    return path.normalize(override);
  }

  const home = options.homedir?.() ?? os.homedir();
  if (!path.isAbsolute(home)) {
    throw new RegistryError(`Could not resolve an absolute user home directory: ${home}`);
  }

  return path.join(path.normalize(home), ".agent-memory");
}

export function registryPaths(globalHome = resolveGlobalHome()): RegistryPaths {
  const home = canonicalizeExistingPath(globalHome);
  return {
    home,
    registry: path.join(home, "registry.json"),
    lock: path.join(home, "registry.lock"),
    databases: path.join(home, "databases")
  };
}

export function ensureGlobalHome(globalHome = resolveGlobalHome()): string {
  const home = path.resolve(globalHome);
  const existed = fs.existsSync(home);

  if (!existed) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  }

  assertPrivateGlobalHome(home);
  return normalizeCanonicalPath(fs.realpathSync(home));
}

function assertPrivateGlobalHome(home: string): void {
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RegistryError(`Global Agent Memory home must be a real directory: ${home}`, {
      details: ["Choose a dedicated private directory that is not a symbolic link."]
    });
  }

  if (typeof process.getuid === "function") {
    const currentUid = process.getuid();
    if (stat.uid !== currentUid) {
      throw new RegistryError(`Global Agent Memory home is not owned by the current user: ${home}`, {
        details: ["Choose a directory owned by the current user."]
      });
    }

    if ((stat.mode & 0o077) !== 0) {
      throw new RegistryError(`Global Agent Memory home permissions are too broad: ${home}`, {
        details: ["Use a dedicated directory accessible only to the current user (mode 0700)."]
      });
    }
  }
}

export function canonicalRepositoryRoot(repoRoot: string): string {
  const absoluteRoot = path.resolve(repoRoot);

  try {
    const canonical = fs.realpathSync(absoluteRoot);
    return normalizeCanonicalPath(canonical);
  } catch (error) {
    throw new RegistryError(`Could not resolve repository root for global storage: ${absoluteRoot}`, {
      details: ["Verify that the repository root exists and is accessible."],
      cause: error
    });
  }
}

export function deriveCheckoutFingerprint(repoRoot: string): string {
  return crypto.createHash("sha256").update(canonicalRepositoryRoot(repoRoot), "utf8").digest("hex").slice(0, 24);
}

export function deriveGlobalDatabasePath(
  globalHome: string,
  memoryKey: string,
  checkoutFingerprint: string
): string {
  assertMemoryKey(memoryKey);
  assertCheckoutFingerprint(checkoutFingerprint);
  const paths = registryPaths(globalHome);
  return path.join(paths.databases, memoryKey, checkoutFingerprint, "memory.sqlite");
}

export function ensureGlobalDatabaseDirectory(
  globalHome: string,
  memoryKey: string,
  checkoutFingerprint: string
): string {
  const home = ensureGlobalHome(globalHome);
  const databasePath = deriveGlobalDatabasePath(home, memoryKey, checkoutFingerprint);
  assertDatabasePathContained(home, databasePath);
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  repairGeneratedDirectoryPermissions(home, directory);
  return directory;
}

export function emptyRegistry(): AgentMemoryRegistry {
  return {
    version: REGISTRY_VERSION,
    memories: {}
  };
}

export function readRegistry(options: Pick<RegistryWriteOptions, "globalHome"> = {}): AgentMemoryRegistry {
  const globalHome = ensureGlobalHome(options.globalHome ?? resolveGlobalHome());
  const paths = registryPaths(globalHome);

  if (!pathExistsIncludingSymlink(paths.registry)) {
    return emptyRegistry();
  }

  assertPrivateGeneratedFile(paths.registry);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.registry, "utf8"));
  } catch (error) {
    throw corruptRegistryError(paths.registry, "Registry JSON could not be parsed.", error);
  }

  try {
    return validateRegistry(parsed, paths.home);
  } catch (error) {
    if (error instanceof RegistryError && error.message.startsWith("Registry at ")) throw error;
    const reason = error instanceof Error ? error.message : "Registry data is invalid.";
    throw corruptRegistryError(paths.registry, reason, error);
  }
}

export function writeRegistry(registry: AgentMemoryRegistry, options: RegistryWriteOptions = {}): AgentMemoryRegistry {
  return updateRegistry(() => structuredClone(registry), options);
}

export function updateRegistry(
  updater: (registry: AgentMemoryRegistry) => AgentMemoryRegistry | void,
  options: RegistryWriteOptions = {}
): AgentMemoryRegistry {
  const home = ensureGlobalHome(options.globalHome ?? resolveGlobalHome());
  const paths = registryPaths(home);
  const lock = acquireRegistryLock(paths.lock, options);

  try {
    const current = readRegistry({ globalHome: home });
    const working = structuredClone(current);
    const result = updater(working) ?? working;
    const validated = validateRegistry(result, home);
    atomicWriteRegistry(paths.registry, validated);
    return validated;
  } finally {
    releaseRegistryLock(paths.lock, lock);
  }
}

export function updateRegistryCheckout(options: UpdateRegistryCheckoutOptions): {
  registry: AgentMemoryRegistry;
  checkoutFingerprint: string;
  databasePath: string;
} {
  assertMemoryKey(options.memoryKey);
  const repositoryIdentity = options.repositoryIdentity.trim();
  assertRepositoryIdentity(repositoryIdentity);

  const home = ensureGlobalHome(options.globalHome ?? resolveGlobalHome());
  const repoRoot = canonicalRepositoryRoot(options.repoRoot);
  const configPath = path.resolve(options.configPath);
  const checkoutFingerprint = deriveCheckoutFingerprint(repoRoot);
  const databasePath = deriveGlobalDatabasePath(home, options.memoryKey, checkoutFingerprint);
  const gitHead = normalizeGitHead(options.gitHead, repoRoot);
  const lastSeenAt = (options.now ?? new Date()).toISOString();

  const registry = updateRegistry((current) => {
    const existingMemory = Object.hasOwn(current.memories, options.memoryKey)
      ? current.memories[options.memoryKey]
      : undefined;

    if (existingMemory && existingMemory.repository_identity !== repositoryIdentity) {
      throw new RegistryError(`Memory key collision for ${options.memoryKey}.`, {
        details: ["The key is already registered to a different or unverified repository identity. Choose a new memory_key or repair the registry."]
      });
    }

    const memory = existingMemory ?? {
      repository_identity: repositoryIdentity,
      checkouts: {}
    };
    const existingCheckout = memory.checkouts[checkoutFingerprint];

    if (!existingCheckout && databaseArtifactPaths(databasePath).some(pathExistsIncludingSymlink)) {
      throw new RegistryError(`Refusing to register orphaned database artifacts at ${databasePath}.`, {
        details: ["The deterministic cache exists without a matching checkout mapping. Use an explicit repair or rebuild flow that verifies or replaces its provenance."]
      });
    }

    if (existingCheckout && path.normalize(existingCheckout.repo_root) !== repoRoot) {
      throw new RegistryError(`Checkout fingerprint collision for ${checkoutFingerprint}.`, {
        details: ["The fingerprint is already mapped to another repository root. Repair the registry before continuing."]
      });
    }

    memory.checkouts[checkoutFingerprint] = {
      ...(existingCheckout ?? {}),
      repo_root: repoRoot,
      config_path: configPath,
      database_path: databasePath,
      package_version: requireNonEmpty(options.packageVersion, "package version"),
      config_hash: requireNonEmpty(options.configHash, "config hash"),
      git_head: gitHead,
      last_seen_at: lastSeenAt
    };
    current.memories[options.memoryKey] = memory;
  }, options);

  return { registry, checkoutFingerprint, databasePath };
}

export function registryCheckoutDiagnostics(
  registry: AgentMemoryRegistry,
  exists: (filePath: string) => boolean = fs.existsSync
): RegistryCheckoutDiagnostic[] {
  const diagnostics: RegistryCheckoutDiagnostic[] = [];

  for (const [memoryKey, memory] of Object.entries(registry.memories)) {
    for (const [checkoutFingerprint, record] of Object.entries(memory.checkouts)) {
      const stale = !exists(record.repo_root);
      diagnostics.push({
        memoryKey,
        checkoutFingerprint,
        record,
        stale,
        ...(stale ? { reason: "repo_root_missing" as const } : {})
      });
    }
  }

  return diagnostics.sort((left, right) =>
    `${left.memoryKey}/${left.checkoutFingerprint}`.localeCompare(`${right.memoryKey}/${right.checkoutFingerprint}`)
  );
}

function validateRegistry(value: unknown, globalHome: string): AgentMemoryRegistry {
  if (!isRecord(value)) {
    throw corruptRegistryError(path.join(globalHome, "registry.json"), "Registry root must be a JSON object.");
  }

  if (value.version !== REGISTRY_VERSION) {
    throw corruptRegistryError(
      path.join(globalHome, "registry.json"),
      `Unsupported registry version ${JSON.stringify(value.version)}.`
    );
  }

  if (!isRecord(value.memories)) {
    throw corruptRegistryError(path.join(globalHome, "registry.json"), "Registry memories must be a JSON object.");
  }

  for (const [memoryKey, rawMemory] of Object.entries(value.memories)) {
    assertMemoryKey(memoryKey);
    if (!isRecord(rawMemory) || !isRecord(rawMemory.checkouts)) {
      throw corruptRegistryError(path.join(globalHome, "registry.json"), `Invalid memory record for ${memoryKey}.`);
    }

    if (rawMemory.repository_identity !== null && !isNonEmptyString(rawMemory.repository_identity)) {
      throw corruptRegistryError(
        path.join(globalHome, "registry.json"),
        `Memory record ${memoryKey} must have a string or null repository_identity.`
      );
    }

    if (typeof rawMemory.repository_identity === "string") {
      assertRepositoryIdentity(rawMemory.repository_identity);
    }

    for (const [fingerprint, rawCheckout] of Object.entries(rawMemory.checkouts)) {
      assertCheckoutFingerprint(fingerprint);
      validateCheckoutRecord(rawCheckout, globalHome, memoryKey, fingerprint);
    }
  }

  return value as AgentMemoryRegistry;
}

function validateCheckoutRecord(
  value: unknown,
  globalHome: string,
  memoryKey: string,
  fingerprint: string
): asserts value is RegistryCheckoutRecord {
  if (!isRecord(value)) {
    throw corruptRegistryError(path.join(globalHome, "registry.json"), `Invalid checkout record ${memoryKey}/${fingerprint}.`);
  }

  for (const field of ["repo_root", "config_path", "database_path", "package_version", "config_hash", "last_seen_at"] as const) {
    if (!isNonEmptyString(value[field])) {
      throw corruptRegistryError(
        path.join(globalHome, "registry.json"),
        `Checkout ${memoryKey}/${fingerprint} has invalid ${field}.`
      );
    }
  }

  const checkout = value as RegistryCheckoutRecord;

  if ("repository_identity" in value) {
    throw corruptRegistryError(
      path.join(globalHome, "registry.json"),
      `Checkout ${memoryKey}/${fingerprint} must not duplicate repository_identity.`
    );
  }

  if (!path.isAbsolute(checkout.repo_root) || !path.isAbsolute(checkout.config_path) || !path.isAbsolute(checkout.database_path)) {
    throw corruptRegistryError(
      path.join(globalHome, "registry.json"),
      `Checkout ${memoryKey}/${fingerprint} paths must be absolute.`
    );
  }

  const activeRepositoryRoot = isActiveRepositoryRoot(checkout.repo_root);
  if (activeRepositoryRoot) {
    const expectedFingerprint = deriveCheckoutFingerprint(checkout.repo_root);
    if (expectedFingerprint !== fingerprint) {
      throw corruptRegistryError(
        path.join(globalHome, "registry.json"),
        `Checkout ${memoryKey}/${fingerprint} does not match its active repository root fingerprint ${expectedFingerprint}.`
      );
    }
  }

  if (checkout.git_head !== null) {
    const expectedLength = activeRepositoryRoot ? repositoryObjectIdLength(checkout.repo_root) : undefined;
    if (!isNonEmptyString(checkout.git_head) || !isFullGitObjectId(checkout.git_head, expectedLength)) {
      throw corruptRegistryError(
        path.join(globalHome, "registry.json"),
        `Checkout ${memoryKey}/${fingerprint} has invalid git_head.`
      );
    }
  }

  const expectedDatabasePath = deriveGlobalDatabasePath(globalHome, memoryKey, fingerprint);
  if (path.normalize(checkout.database_path) !== path.normalize(expectedDatabasePath)) {
    throw corruptRegistryError(
      path.join(globalHome, "registry.json"),
      `Checkout ${memoryKey}/${fingerprint} has an unexpected database_path.`
    );
  }
  assertDatabasePathContained(globalHome, checkout.database_path);
  assertPrivateDatabaseArtifacts(checkout.database_path);

  const parsedTimestamp = new Date(checkout.last_seen_at);
  if (Number.isNaN(parsedTimestamp.getTime()) || parsedTimestamp.toISOString() !== checkout.last_seen_at) {
    throw corruptRegistryError(
      path.join(globalHome, "registry.json"),
      `Checkout ${memoryKey}/${fingerprint} has an invalid UTC last_seen_at timestamp.`
    );
  }
}

function assertDatabasePathContained(globalHome: string, databasePath: string): void {
  try {
    const resolved = resolveContainedPath(globalHome, databasePath, { rejectFinalSymlink: true });
    if (!isPathInside(resolved.realRootPath, resolved.realExistingAncestorPath)) {
      throw new Error("Database path escapes global home.");
    }
    assertNoSymlinkedPathComponents(globalHome, databasePath);
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(`Global database path is not safely contained beneath ${path.resolve(globalHome)}.`, {
      details: ["Do not use the stored registry path. Repair the registry before continuing."],
      cause: error
    });
  }
}

function acquireRegistryLock(lockPath: string, options: RegistryWriteOptions): number {
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_REGISTRY_LOCK_TIMEOUT_MS;
  const retryMs = options.lockRetryMs ?? DEFAULT_REGISTRY_LOCK_RETRY_MS;
  const startedAt = Date.now();

  while (true) {
    let handle: number;
    try {
      handle = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new RegistryError(`Could not acquire registry lock at ${lockPath}.`, { cause: error });
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new RegistryError(`Timed out waiting for registry lock at ${lockPath}.`, {
          details: ["Another Agent Memory process may be updating the registry. Retry shortly; do not delete the lock unless its owner is proven inactive."]
        });
      }

      sleepSynchronously(Math.min(retryMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      continue;
    }

    try {
      fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
      fs.fsyncSync(handle);
      return handle;
    } catch (error) {
      cleanupFailedLockInitialization(lockPath, handle);
      throw new RegistryError(`Could not initialize registry lock at ${lockPath}.`, {
        details: ["The incomplete lock was removed. Check available storage and directory permissions before retrying."],
        cause: error
      });
    }
  }
}

function cleanupFailedLockInitialization(lockPath: string, handle: number): void {
  try {
    fs.closeSync(handle);
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function releaseRegistryLock(lockPath: string, handle: number): void {
  try {
    fs.closeSync(handle);
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function atomicWriteRegistry(registryPath: string, registry: AgentMemoryRegistry): void {
  const tempPath = `${registryPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle: number | null = null;

  try {
    handle = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, registryPath);
  } catch (error) {
    throw new RegistryError(`Could not atomically write registry at ${registryPath}.`, {
      details: ["The previous complete registry remains authoritative. Check directory permissions and retry."],
      cause: error
    });
  } finally {
    if (handle !== null) fs.closeSync(handle);
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function repairGeneratedDirectoryPermissions(globalHome: string, directory: string): void {
  let current = directory;
  const home = path.resolve(globalHome);

  while (current !== home) {
    fs.chmodSync(current, 0o700);
    const parent = path.dirname(current);
    if (parent === current || !isPathInside(home, parent)) break;
    current = parent;
  }
}

function assertPrivateGeneratedFile(filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new RegistryError(`Could not inspect generated registry file at ${filePath}.`, { cause: error });
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RegistryError(`Generated registry path must be a regular file, not a symbolic link: ${filePath}`, {
      details: ["Move the unsafe path aside and rebuild registry metadata from canonical memory."]
    });
  }

  if (typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) {
      throw new RegistryError(`Generated registry file is not owned by the current user: ${filePath}`, {
        details: ["Move the unsafe file aside and rebuild registry metadata as the current user."]
      });
    }

    if ((stat.mode & 0o077) !== 0) {
      throw new RegistryError(`Generated registry file permissions are too broad: ${filePath}`, {
        details: ["Restrict the file to the current user (mode 0600) before continuing."]
      });
    }
  }
}

function assertPrivateDatabaseArtifacts(databasePath: string): void {
  for (const artifactPath of databaseArtifactPaths(databasePath)) {
    if (!pathExistsIncludingSymlink(artifactPath)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(artifactPath);
    } catch (error) {
      throw new RegistryError(`Could not inspect generated database artifact at ${artifactPath}.`, { cause: error });
    }

    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RegistryError(`Generated database artifact must be a regular file, not a symbolic link: ${artifactPath}`, {
        details: ["Move the unsafe artifact aside and rebuild the generated database from canonical memory."]
      });
    }

    if (typeof process.getuid === "function") {
      if (stat.uid !== process.getuid()) {
        throw new RegistryError(`Generated database artifact is not owned by the current user: ${artifactPath}`, {
          details: ["Move the unsafe artifact aside and rebuild the generated database as the current user."]
        });
      }

      if ((stat.mode & 0o077) !== 0) {
        throw new RegistryError(`Generated database artifact permissions are too broad: ${artifactPath}`, {
          details: ["Restrict the artifact to the current user (mode 0600) before continuing."]
        });
      }
    }
  }
}

function databaseArtifactPaths(databasePath: string): string[] {
  return [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`];
}

function assertNoSymlinkedPathComponents(globalHome: string, databasePath: string): void {
  const home = path.resolve(globalHome);
  const relativePath = path.relative(home, path.resolve(databasePath));
  let current = home;

  for (const component of relativePath.split(path.sep)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new RegistryError(`Global database path contains a symbolic-link component: ${current}`, {
        details: ["Use dedicated generated directories beneath global home and repair the unsafe alias before continuing."]
      });
    }
  }
}

function pathExistsIncludingSymlink(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RegistryError(`Could not inspect generated database path at ${filePath}.`, { cause: error });
  }
}

function isActiveRepositoryRoot(repoRoot: string): boolean {
  try {
    const stat = fs.lstatSync(repoRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RegistryError(`Active registry repo_root must be a canonical directory: ${repoRoot}`, {
        details: ["Repair the checkout mapping before using its generated database."]
      });
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(`Could not inspect registry repo_root at ${repoRoot}.`, { cause: error });
  }
}

function assertMemoryKey(memoryKey: string): void {
  if (!isValidMemoryKey(memoryKey)) {
    throw new RegistryError("Invalid memory key for global storage.", {
      details: ["Use 1-128 lowercase letters, digits, dots, underscores, or hyphens without secrets or path separators."]
    });
  }
}

function assertRepositoryIdentity(repositoryIdentity: string): void {
  const isCheckout = /^checkout:[0-9a-f]{64}$/.test(repositoryIdentity);
  const remote = repositoryIdentity.match(
    /^remote:(?:(ssh-account:[A-Za-z0-9._-]+@))?([A-Za-z0-9.-]+)\/([A-Za-z0-9._~/-]+)$/
  );
  let isRemote = false;

  if (remote) {
    const [, account = "", host, repositoryPath] = remote;
    const segments = repositoryPath.split("/");
    const hasCanonicalSegments = segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
    const finalSegment = segments.at(-1) ?? "";
    const canonicalHost = host.toLowerCase();
    const canonicalIdentity = `remote:${account}${canonicalHost}/${segments.join("/")}`;
    isRemote =
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(canonicalHost)
      && !canonicalHost.includes("..")
      && hasCanonicalSegments
      && !finalSegment.toLowerCase().endsWith(".git")
      && repositoryIdentity === canonicalIdentity;
  }

  if (!isRemote && !isCheckout) {
    throw new RegistryError("Invalid or unsafe repository identity.", {
      details: ["Use a normalized credential-free remote:<host>/<repository> or checkout:<sha256> identity."]
    });
  }
}

function normalizeGitHead(gitHead: string | null | undefined, repoRoot: string): string | null {
  if (gitHead === null || gitHead === undefined) return null;
  const normalized = gitHead.trim().toLowerCase();
  const expectedLength = repositoryObjectIdLength(repoRoot);
  if (!isFullGitObjectId(normalized, expectedLength)) {
    throw new RegistryError("Invalid Git head for global registry diagnostics.", {
      details: ["Use the repository's full immutable Git commit object ID, or null when unavailable."]
    });
  }
  return normalized;
}

function assertCheckoutFingerprint(fingerprint: string): void {
  if (!CHECKOUT_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new RegistryError(`Invalid checkout fingerprint: ${JSON.stringify(fingerprint)}.`);
  }
}

function normalizeCanonicalPath(value: string): string {
  const normalized = path.normalize(value);
  const root = path.parse(normalized).root;
  let withoutTrailingSeparators = normalized;
  while (withoutTrailingSeparators.length > root.length && withoutTrailingSeparators.endsWith(path.sep)) {
    withoutTrailingSeparators = withoutTrailingSeparators.slice(0, -1);
  }

  if (process.platform === "win32" && /^[A-Z]:/.test(withoutTrailingSeparators)) {
    return `${withoutTrailingSeparators[0].toLowerCase()}${withoutTrailingSeparators.slice(1)}`;
  }

  return withoutTrailingSeparators;
}

function canonicalizeExistingPath(value: string): string {
  const absolute = path.resolve(value);
  const ancestor = nearestExistingAncestor(absolute);
  if (ancestor === null) return absolute;

  try {
    const canonicalAncestor = fs.realpathSync(ancestor);
    return normalizeCanonicalPath(path.join(canonicalAncestor, path.relative(ancestor, absolute)));
  } catch (error) {
    throw new RegistryError(`Could not resolve global Agent Memory path: ${absolute}`, { cause: error });
  }
}

function sleepSynchronously(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function corruptRegistryError(registryPath: string, reason: string, cause?: unknown): RegistryError {
  return new RegistryError(`Registry at ${registryPath} is corrupt or unsupported.`, {
    details: [reason, "Run a registry repair command when available, or move the generated registry aside and rebuild caches from canonical memory."],
    cause
  });
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new RegistryError(`Registry ${label} must not be empty.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
