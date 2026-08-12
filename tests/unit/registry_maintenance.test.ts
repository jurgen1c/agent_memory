import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveRepositoryIdentity } from "../../packages/core/src/memory_key";
import {
  doctorRegistry,
  listRegistry,
  pruneRegistry,
  showRegistryMemory
} from "../../packages/core/src/registry_maintenance";
import {
  ensureGlobalDatabaseDirectory,
  readRegistry,
  registryPaths,
  updateRegistryCheckout,
  writeRegistry
} from "../../packages/core/src/registry";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("registry maintenance", () => {
  test("lists and shows deterministic global checkout metadata and database status", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "example-memory");
    ensureGlobalDatabaseDirectory(globalHome, "example-memory", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });

    const listed = listRegistry({ globalHome });
    expect(listed.memory_count).toBe(1);
    expect(listed.checkout_count).toBe(1);
    expect(listed.memories[0]).toMatchObject({
      memory_key: "example-memory",
      checkout_count: 1,
      active_checkout_count: 1,
      stale_checkout_count: 0,
      inconclusive_checkout_count: 0,
      checkout_classification: "single_active",
      effective_database_paths: [registered.databasePath]
    });
    expect(listed.memories[0].checkouts[0]).toMatchObject({
      scope: "global",
      repo_root: fs.realpathSync(repoRoot),
      database_path: registered.databasePath,
      database_status: "present",
      checkout_status: "active",
      stale: false
    });

    expect(showRegistryMemory("example-memory", { globalHome })).toEqual(listed.memories[0]);
    expect(() => showRegistryMemory("missing-key", { globalHome })).toThrow("Registry memory key not found");
  });

  test("classifies active clones separately from stale moved checkout mappings", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const firstRoot = makeTempDirectory("agent-memory-first-clone-");
    const secondRoot = makeTempDirectory("agent-memory-second-clone-");
    const identity = "remote:github.com/org/shared";
    registerCheckout(globalHome, firstRoot, "shared-memory", "agent-memory.config.yaml", identity);
    registerCheckout(globalHome, secondRoot, "shared-memory", "agent-memory.config.yaml", identity);

    expect(showRegistryMemory("shared-memory", { globalHome })).toMatchObject({
      checkout_count: 2,
      active_checkout_count: 2,
      stale_checkout_count: 0,
      checkout_classification: "multiple_active"
    });

    fs.rmSync(firstRoot, { recursive: true });

    expect(showRegistryMemory("shared-memory", { globalHome })).toMatchObject({
      checkout_count: 2,
      active_checkout_count: 1,
      stale_checkout_count: 1,
      checkout_classification: "mixed"
    });
  });

  test("doctor reports stale paths, missing databases, and duplicate active keys with guidance", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const activeRoot = makeTempDirectory("agent-memory-registry-active-");
    const staleRoot = makeTempDirectory("agent-memory-registry-stale-");
    registerCheckout(globalHome, activeRoot, "first-key", "first.config.yaml");
    registerCheckout(globalHome, activeRoot, "second-key", "second.config.yaml");
    registerCheckout(globalHome, staleRoot, "stale-key");
    const registry = readRegistry({ globalHome });
    const secondCheckout = Object.values(registry.memories["second-key"].checkouts)[0];
    secondCheckout.repo_root = `${activeRoot}${path.sep}.`;
    writeRegistry(registry, { globalHome });
    fs.rmSync(staleRoot, { recursive: true });

    const result = doctorRegistry({ globalHome });

    expect(result.healthy).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "stale_path", memory_key: "stale-key" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "missing_database", memory_key: "first-key" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "duplicate_key" }));
    expect(result.findings.every((finding) => finding.guidance.length > 0)).toBe(true);
  });

  test("doctor returns a structured corrupt-metadata finding without evaluating registry content", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    fs.writeFileSync(registryPaths(globalHome).registry, "{ definitely: not-json }\n", { mode: 0o600 });

    const result = doctorRegistry({ globalHome });

    expect(result.healthy).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "corrupt_metadata", severity: "error" })
    ]);
  });

  test("doctor reports an unverified legacy identity as corrupt metadata rather than a mismatch", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "legacy-memory");
    ensureGlobalDatabaseDirectory(globalHome, "legacy-memory", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    const registry = readRegistry({ globalHome });
    registry.memories["legacy-memory"].repository_identity = null;
    writeRegistry(registry, { globalHome });

    const result = doctorRegistry({ globalHome });

    expect(result.healthy).toBe(false);
    expect(result.findings.some((finding) => finding.code === "duplicate_key")).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "corrupt_metadata",
      severity: "error",
      memory_key: "legacy-memory"
    }));
  });

  test("rejects a symlinked global home before canonicalizing maintenance paths", () => {
    const parent = makeTempDirectory("agent-memory-registry-home-parent-");
    const target = makeTempDirectory("agent-memory-registry-home-target-");
    const alias = path.join(parent, "home-alias");
    fs.symlinkSync(target, alias, "dir");

    expect(() => listRegistry({ globalHome: alias })).toThrow("must be a real directory");
    expect(() => pruneRegistry({ globalHome: alias, force: true })).toThrow("must be a real directory");
    expect(doctorRegistry({ globalHome: alias })).toMatchObject({
      healthy: false,
      global_home: path.resolve(alias),
      registry_path: path.join(path.resolve(alias), "registry.json"),
      findings: [expect.objectContaining({ code: "corrupt_metadata" })]
    });
    expect(fs.existsSync(path.join(target, "registry.json"))).toBe(false);
  });

  test("prune previews by default and force removes only stale generated state", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repositoryParent = makeTempDirectory("agent-memory-registry-parent-");
    const repoRoot = path.join(repositoryParent, "checkout");
    const movedRoot = path.join(repositoryParent, "moved-checkout");
    fs.mkdirSync(path.join(repoRoot, "docs", "agent-memory"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs", "agent-memory", "canonical.md"), "canonical memory\n");
    const registered = registerCheckout(globalHome, repoRoot, "stale-memory");
    ensureGlobalDatabaseDirectory(globalHome, "stale-memory", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    fs.writeFileSync(`${registered.databasePath}-wal`, "wal", { mode: 0o600 });
    fs.renameSync(repoRoot, movedRoot);

    const preview = pruneRegistry({ globalHome });
    expect(preview).toMatchObject({ dry_run: true, stale_count: 1, pruned_count: 0 });
    expect(readRegistry({ globalHome }).memories["stale-memory"]).toBeDefined();
    expect(fs.existsSync(registered.databasePath)).toBe(true);

    const pruned = pruneRegistry({ globalHome, force: true });
    expect(pruned).toMatchObject({ dry_run: false, stale_count: 1, pruned_count: 1 });
    expect(readRegistry({ globalHome }).memories).toEqual({});
    expect(fs.existsSync(registered.databasePath)).toBe(false);
    expect(fs.readFileSync(path.join(movedRoot, "docs", "agent-memory", "canonical.md"), "utf8")).toBe("canonical memory\n");
  });

  test("force prune leaves active entries untouched", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    registerCheckout(globalHome, repoRoot, "active-memory");

    const result = pruneRegistry({ globalHome, force: true });

    expect(result).toMatchObject({ dry_run: false, stale_count: 0, pruned_count: 0 });
    expect(readRegistry({ globalHome }).memories["active-memory"]).toBeDefined();
  });

  test("treats checkouts that no longer select their global mapping as stale", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const localRoot = makeTempDirectory("agent-memory-registry-local-");
    const changedKeyRoot = makeTempDirectory("agent-memory-registry-changed-key-");
    const missingConfigRoot = makeTempDirectory("agent-memory-registry-missing-config-");
    registerCheckout(globalHome, localRoot, "local-memory");
    registerCheckout(globalHome, changedKeyRoot, "old-memory");
    registerCheckout(globalHome, missingConfigRoot, "missing-config-memory");
    fs.writeFileSync(path.join(localRoot, "agent-memory.config.yaml"), "version: 2\ndatabase_scope: local\n");
    fs.writeFileSync(path.join(changedKeyRoot, "agent-memory.config.yaml"), "version: 2\nmemory_key: new-memory\ndatabase_scope: global\n");
    fs.unlinkSync(path.join(missingConfigRoot, "agent-memory.config.yaml"));

    const listed = listRegistry({ globalHome });
    expect(listed.memories.flatMap((memory) => memory.checkouts).every((checkout) => checkout.stale)).toBe(true);
    expect(doctorRegistry({ globalHome }).findings.filter((finding) => finding.code === "stale_path")).toHaveLength(3);

    const pruned = pruneRegistry({ globalHome, force: true });
    expect(pruned).toMatchObject({ dry_run: false, stale_count: 3, pruned_count: 3 });
    expect(readRegistry({ globalHome }).memories).toEqual({});
  });

  test("reports malformed active config as inconclusive and excludes it from pruning", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "inconclusive-memory");
    ensureGlobalDatabaseDirectory(globalHome, "inconclusive-memory", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    fs.writeFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "version: [\n");

    expect(listRegistry({ globalHome }).memories[0].checkouts[0]).toMatchObject({
      checkout_status: "inconclusive",
      stale: false
    });
    expect(doctorRegistry({ globalHome }).findings).toContainEqual(expect.objectContaining({
      code: "corrupt_metadata",
      memory_key: "inconclusive-memory"
    }));
    expect(pruneRegistry({ globalHome, force: true })).toMatchObject({ stale_count: 0, pruned_count: 0 });
    expect(fs.existsSync(registered.databasePath)).toBe(true);
    expect(readRegistry({ globalHome }).memories["inconclusive-memory"]).toBeDefined();
  });

  test("treats config paths outside the checkout as inconclusive and excludes them from pruning", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const outsideRoot = makeTempDirectory("agent-memory-registry-outside-");
    const registered = registerCheckout(globalHome, repoRoot, "contained-memory");
    ensureGlobalDatabaseDirectory(globalHome, "contained-memory", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    const outsideConfigPath = path.join(outsideRoot, "agent-memory.config.yaml");
    fs.writeFileSync(outsideConfigPath, "version: 2\nmemory_key: contained-memory\ndatabase_scope: global\n");
    const registry = readRegistry({ globalHome });
    Object.values(registry.memories["contained-memory"].checkouts)[0].config_path = outsideConfigPath;
    writeRegistry(registry, { globalHome });

    expect(listRegistry({ globalHome }).memories[0].checkouts[0]).toMatchObject({
      checkout_status: "inconclusive",
      stale: false
    });
    expect(doctorRegistry({ globalHome }).findings).toContainEqual(expect.objectContaining({
      code: "corrupt_metadata",
      memory_key: "contained-memory"
    }));
    expect(pruneRegistry({ globalHome, force: true })).toMatchObject({ stale_count: 0, pruned_count: 0 });
    expect(fs.existsSync(registered.databasePath)).toBe(true);
  });

  test("keeps a config symlink active when its target remains inside the checkout", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    registerCheckout(globalHome, repoRoot, "symlinked-config-memory");
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const targetPath = path.join(repoRoot, "actual.config.yaml");
    fs.renameSync(configPath, targetPath);
    fs.symlinkSync(path.basename(targetPath), configPath);

    expect(listRegistry({ globalHome }).memories[0].checkouts[0]).toMatchObject({
      checkout_status: "active",
      stale: false
    });
    expect(doctorRegistry({ globalHome }).findings.some((finding) => finding.code === "corrupt_metadata")).toBe(false);
  });

  test("treats inaccessible config paths as inconclusive and excludes them from pruning", () => {
    if (typeof process.getuid !== "function") return;
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "inaccessible-memory");
    ensureGlobalDatabaseDirectory(globalHome, "inaccessible-memory", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    fs.chmodSync(repoRoot, 0o000);

    try {
      expect(listRegistry({ globalHome }).memories[0].checkouts[0]).toMatchObject({
        checkout_status: "inconclusive",
        stale: false
      });
      expect(pruneRegistry({ globalHome, force: true })).toMatchObject({ stale_count: 0, pruned_count: 0 });
      expect(fs.existsSync(registered.databasePath)).toBe(true);
      expect(readRegistry({ globalHome }).memories["inaccessible-memory"]).toBeDefined();
    } finally {
      fs.chmodSync(repoRoot, 0o700);
    }
  });

  test("previews and removes empty memory records", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    writeRegistry({
      version: 1,
      memories: {
        empty: { repository_identity: null, checkouts: {} }
      }
    }, { globalHome });

    expect(pruneRegistry({ globalHome })).toMatchObject({
      dry_run: true,
      stale_count: 1,
      pruned_count: 0,
      empty_memory_keys: ["empty"]
    });
    expect(pruneRegistry({ globalHome, force: true })).toMatchObject({
      dry_run: false,
      stale_count: 1,
      pruned_count: 1,
      empty_memory_keys: ["empty"]
    });
    expect(readRegistry({ globalHome }).memories).toEqual({});
  });

  test("acquires the registry lock before deleting generated databases", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "locked-prune");
    ensureGlobalDatabaseDirectory(globalHome, "locked-prune", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    fs.rmSync(repoRoot, { recursive: true });
    fs.writeFileSync(registryPaths(globalHome).lock, "held", { mode: 0o600 });

    expect(() => pruneRegistry({
      globalHome,
      force: true,
      lockTimeoutMs: 10,
      lockRetryMs: 1
    })).toThrow("Timed out waiting for registry lock");
    expect(fs.existsSync(registered.databasePath)).toBe(true);
    expect(readRegistry({ globalHome }).memories["locked-prune"]).toBeDefined();
  });

  test("retains stale registry mappings when generated checkout staging fails", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "cleanup-failure");
    ensureGlobalDatabaseDirectory(globalHome, "cleanup-failure", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    fs.rmSync(repoRoot, { recursive: true });
    const rename = spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    try {
      expect(() => pruneRegistry({ globalHome, force: true })).toThrow("permission denied");
    } finally {
      rename.mockRestore();
    }

    expect(readRegistry({ globalHome }).memories["cleanup-failure"]).toBeDefined();
    expect(fs.existsSync(registered.databasePath)).toBe(true);
  });

  test("restores staged generated state when the registry commit fails", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "commit-failure");
    ensureGlobalDatabaseDirectory(globalHome, "commit-failure", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    fs.writeFileSync(`${registered.databasePath}-wal`, "wal", { mode: 0o600 });
    fs.rmSync(repoRoot, { recursive: true });
    const originalRename = fs.renameSync.bind(fs);
    const rename = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (path.normalize(String(destination)) === path.normalize(registryPaths(globalHome).registry)) {
        throw Object.assign(new Error("registry commit failed"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    try {
      expect(() => pruneRegistry({ globalHome, force: true })).toThrow("Could not atomically write registry");
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(registered.databasePath, "utf8")).toBe("sqlite");
    expect(fs.readFileSync(`${registered.databasePath}-wal`, "utf8")).toBe("wal");
    expect(readRegistry({ globalHome }).memories["commit-failure"]).toBeDefined();
  });

  test("retains retryable pending metadata when staged cleanup fails", () => {
    const globalHome = makeTempDirectory("agent-memory-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-registry-repo-");
    const registered = registerCheckout(globalHome, repoRoot, "cleanup-retry");
    ensureGlobalDatabaseDirectory(globalHome, "cleanup-retry", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "sqlite", { mode: 0o600 });
    fs.rmSync(repoRoot, { recursive: true });
    const stagingRoot = path.join(globalHome, ".registry-prune");
    const stagedDatabase = path.join(stagingRoot, `cleanup-retry-${registered.checkoutFingerprint}`, "memory.sqlite");
    const originalRemove = fs.rmSync.bind(fs);
    const remove = spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (path.normalize(String(target)) === path.normalize(path.dirname(stagedDatabase))) {
        throw Object.assign(new Error("cleanup failed"), { code: "EACCES" });
      }
      return originalRemove(target, options);
    });

    try {
      expect(() => pruneRegistry({ globalHome, force: true })).toThrow("cleanup failed");
    } finally {
      remove.mockRestore();
    }

    const pending = Object.values(readRegistry({ globalHome }).memories["cleanup-retry"].checkouts)[0];
    expect(pending.prune_pending).toBe(true);
    expect(fs.existsSync(stagedDatabase)).toBe(true);
    expect(fs.existsSync(registered.databasePath)).toBe(false);

    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "agent-memory.config.yaml"),
      "version: 2\nmemory_key: cleanup-retry\ndatabase_scope: global\n"
    );
    registerCheckout(globalHome, repoRoot, "cleanup-retry");
    ensureGlobalDatabaseDirectory(globalHome, "cleanup-retry", registered.checkoutFingerprint);
    fs.writeFileSync(registered.databasePath, "rebuilt", { mode: 0o600 });
    expect(pruneRegistry({ globalHome, force: true })).toMatchObject({ stale_count: 0, pruned_count: 0 });
    const restored = Object.values(readRegistry({ globalHome }).memories["cleanup-retry"].checkouts)[0];
    expect(restored.prune_pending).toBeUndefined();
    expect(fs.readFileSync(registered.databasePath, "utf8")).toBe("rebuilt");
    expect(fs.existsSync(stagedDatabase)).toBe(false);

    fs.rmSync(repoRoot, { recursive: true });
    expect(pruneRegistry({ globalHome, force: true })).toMatchObject({ stale_count: 1, pruned_count: 1 });
    expect(readRegistry({ globalHome }).memories).toEqual({});
    expect(fs.existsSync(stagingRoot)).toBe(false);
  });
});

function registerCheckout(
  globalHome: string,
  repoRoot: string,
  memoryKey: string,
  configName = "agent-memory.config.yaml",
  repositoryIdentity = deriveRepositoryIdentity(repoRoot)
) {
  fs.mkdirSync(repoRoot, { recursive: true });
  const configPath = path.join(repoRoot, configName);
  fs.writeFileSync(configPath, `version: 2\nmemory_key: ${memoryKey}\ndatabase_scope: global\n`);
  return updateRegistryCheckout({
    globalHome,
    memoryKey,
    repositoryIdentity,
    repoRoot,
    configPath,
    packageVersion: "0.4.0",
    configHash: `sha256:${memoryKey}`,
    gitHead: null,
    now: new Date("2026-08-08T12:00:00.000Z")
  });
}

function makeTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}
