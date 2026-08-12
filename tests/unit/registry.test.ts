import { afterEach, describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveCheckoutFingerprint,
  deriveGlobalDatabasePath,
  emptyRegistry,
  ensureGlobalDatabaseDirectory,
  ensureGlobalHome,
  readRegistry,
  registryCheckoutDiagnostics,
  registryPaths,
  resolveGlobalHome,
  updateRegistry,
  updateRegistryCheckout,
  writeRegistry,
  RegistryError
} from "../../packages/core/src/registry";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("global registry storage", () => {
  test("resolves the default home and honors an absolute environment override", () => {
    const userHome = makeTempDirectory("agent-memory-user-home-");
    const override = path.join(userHome, "private-registry");

    expect(resolveGlobalHome({ env: {}, homedir: () => userHome })).toBe(path.join(userHome, ".agent-memory"));
    expect(resolveGlobalHome({ env: { AGENT_MEMORY_HOME: override }, homedir: () => "/unused" })).toBe(override);
    expect(() => resolveGlobalHome({ env: { AGENT_MEMORY_HOME: "relative/home" } })).toThrow(
      "AGENT_MEMORY_HOME must be an absolute path"
    );
  });

  test("derives stable checkout fingerprints and deterministic database paths", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const canonicalRoot = fs.realpathSync(repoRoot);
    const expectedFingerprint = crypto.createHash("sha256").update(canonicalRoot, "utf8").digest("hex").slice(0, 24);

    expect(deriveCheckoutFingerprint(repoRoot)).toBe(expectedFingerprint);
    expect(deriveGlobalDatabasePath(globalHome, "jurgen1c-agent-memory", expectedFingerprint)).toBe(
      path.join(globalHome, "databases", "jurgen1c-agent-memory", expectedFingerprint, "memory.sqlite")
    );

    const databaseDirectory = ensureGlobalDatabaseDirectory(globalHome, "jurgen1c-agent-memory", expectedFingerprint);
    expect(databaseDirectory).toBe(path.dirname(deriveGlobalDatabasePath(globalHome, "jurgen1c-agent-memory", expectedFingerprint)));
    expect(fs.statSync(databaseDirectory).mode & 0o777).toBe(0o700);
  });

  test("treats a missing registry as an empty initial registry", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    expect(readRegistry({ globalHome })).toEqual(emptyRegistry());
  });

  test("atomically updates registry metadata and preserves additive diagnostics", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const first = updateRegistry((registry) => {
      registry.diagnostic = { created_by: "test" };
    }, { globalHome });

    expect(first.diagnostic).toEqual({ created_by: "test" });
    expect(readRegistry({ globalHome })).toEqual(first);
    expect(fs.existsSync(registryPaths(globalHome).lock)).toBe(false);
    expect(fs.readdirSync(globalHome).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(fs.statSync(registryPaths(globalHome).registry).mode & 0o777).toBe(0o600);

    const second = updateRegistry((registry) => {
      registry.second_update = true;
    }, { globalHome });
    expect(second.diagnostic).toEqual({ created_by: "test" });
    expect(second.second_update).toBe(true);
  });

  test("does not overwrite registry state while another writer owns the lock", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const original = writeRegistry(emptyRegistry(), { globalHome });
    fs.writeFileSync(registryPaths(globalHome).lock, "owned\n", { mode: 0o600 });

    expect(() => updateRegistry((registry) => {
      registry.unexpected = true;
    }, { globalHome, lockTimeoutMs: 0 })).toThrow("Timed out waiting for registry lock");
    expect(readRegistry({ globalHome })).toEqual(original);
  });

  test("removes its lock when lock metadata initialization fails", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const writeFile = spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });

    try {
      expect(() => updateRegistry(() => undefined, { globalHome })).toThrow("Could not initialize registry lock");
      expect(fs.existsSync(registryPaths(globalHome).lock)).toBe(false);
    } finally {
      writeFile.mockRestore();
    }
  });

  test("registers and refreshes the current checkout without exposing canonical memory", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    fs.writeFileSync(configPath, "version: 2\n");
    const firstSeen = new Date("2026-08-07T12:00:00.000Z");

    const first = updateRegistryCheckout({
      globalHome,
      memoryKey: "jurgen1c-agent-memory",
      repositoryIdentity: "remote:github.com/jurgen1c/agent_memory",
      repoRoot,
      configPath,
      packageVersion: "0.4.0",
      configHash: "sha256:first",
      gitHead: "a".repeat(40),
      now: firstSeen
    });
    const checkout = first.registry.memories["jurgen1c-agent-memory"].checkouts[first.checkoutFingerprint];

    expect(checkout).toEqual({
      repo_root: fs.realpathSync(repoRoot),
      config_path: configPath,
      database_path: first.databasePath,
      package_version: "0.4.0",
      config_hash: "sha256:first",
      git_head: "a".repeat(40),
      last_seen_at: firstSeen.toISOString()
    });
    expect(JSON.stringify(first.registry)).not.toContain("version: 2");

    const refreshed = updateRegistryCheckout({
      globalHome,
      memoryKey: "jurgen1c-agent-memory",
      repositoryIdentity: "remote:github.com/jurgen1c/agent_memory",
      repoRoot,
      configPath,
      packageVersion: "0.4.1",
      configHash: "sha256:second",
      now: new Date("2026-08-08T12:00:00.000Z")
    });
    expect(Object.keys(refreshed.registry.memories["jurgen1c-agent-memory"].checkouts)).toEqual([
      first.checkoutFingerprint
    ]);
    expect(refreshed.registry.memories["jurgen1c-agent-memory"].checkouts[first.checkoutFingerprint].config_hash).toBe(
      "sha256:second"
    );
  });

  test("distinguishes active memory-key identity collisions from stale mappings", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const unrelatedRoot = makeTempDirectory("agent-memory-unrelated-");
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    fs.writeFileSync(configPath, "version: 2\nmemory_key: shared-key\ndatabase_scope: global\n");
    const common = {
      globalHome,
      memoryKey: "shared-key",
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    };

    updateRegistryCheckout({
      ...common,
      repositoryIdentity: "remote:github.com/org/one",
      repoRoot,
      configPath
    });
    const conflictingRegistration = {
      ...common,
      repositoryIdentity: "remote:github.com/org/two",
      repoRoot: unrelatedRoot,
      configPath: path.join(unrelatedRoot, "agent-memory.config.yaml")
    };

    expect(() => updateRegistryCheckout(conflictingRegistration)).toThrow("Active memory key collision");

    fs.writeFileSync(configPath, "version: 2\nmemory_key: replacement-key\ndatabase_scope: global\n");
    try {
      updateRegistryCheckout(conflictingRegistration);
      throw new Error("Expected stale memory key collision.");
    } catch (error) {
      expect((error as Error).message).toContain("Stale memory key collision");
      expect((error as RegistryError).details).toContainEqual(expect.stringContaining("no longer selects this key"));
      expect((error as RegistryError).details.join(" ")).not.toContain("roots are missing");
    }
  });

  test("requires registry repair when the current root has a different repository identity", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    fs.writeFileSync(configPath, "version: 2\nmemory_key: shared-key\ndatabase_scope: global\n");
    const common = {
      globalHome,
      memoryKey: "shared-key",
      repoRoot,
      configPath,
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    };

    updateRegistryCheckout({ ...common, repositoryIdentity: "remote:github.com/org/original" });

    try {
      updateRegistryCheckout({ ...common, repositoryIdentity: "remote:github.com/org/changed" });
      throw new Error("Expected a same-root repository identity mismatch.");
    } catch (error) {
      expect((error as Error).message).toContain("Repository identity mismatch");
      expect((error as RegistryError).details).toContainEqual(expect.stringContaining("Repair the registry"));
      expect((error as RegistryError).details.join(" ")).not.toContain("distinct memory_key");
    }
  });

  test("reports an empty mismatched memory record as repairable registry state", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    writeRegistry({
      version: 1,
      memories: {
        "shared-key": {
          repository_identity: "remote:github.com/org/original",
          checkouts: {}
        }
      }
    }, { globalHome });

    try {
      updateRegistryCheckout({
        globalHome,
        memoryKey: "shared-key",
        repositoryIdentity: "remote:github.com/org/changed",
        repoRoot,
        configPath: path.join(repoRoot, "agent-memory.config.yaml"),
        packageVersion: "0.4.0",
        configHash: "sha256:config"
      });
      throw new Error("Expected an empty memory record error.");
    } catch (error) {
      expect((error as Error).message).toContain("Empty memory key record");
      expect((error as RegistryError).details).toContainEqual(expect.stringContaining("registry prune"));
      expect((error as RegistryError).details.join(" ")).not.toContain("distinct memory_key");
    }
  });

  test("registers separate checkout fingerprints and databases for active clones with one identity and key", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const firstRoot = makeTempDirectory("agent-memory-first-clone-");
    const secondRoot = makeTempDirectory("agent-memory-second-clone-");
    const common = {
      globalHome,
      memoryKey: "shared-clones",
      repositoryIdentity: "remote:github.com/org/repo",
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    };

    const first = updateRegistryCheckout({
      ...common,
      repoRoot: firstRoot,
      configPath: path.join(firstRoot, "agent-memory.config.yaml")
    });
    const second = updateRegistryCheckout({
      ...common,
      repoRoot: secondRoot,
      configPath: path.join(secondRoot, "agent-memory.config.yaml")
    });

    expect(second.checkoutFingerprint).not.toBe(first.checkoutFingerprint);
    expect(second.databasePath).not.toBe(first.databasePath);
    expect(Object.keys(second.registry.memories["shared-clones"].checkouts).sort()).toEqual(
      [first.checkoutFingerprint, second.checkoutFingerprint].sort()
    );
  });

  test("rejects invalid memory keys without echoing their contents", () => {
    const invalidMemoryKey = "token-containing secret";

    try {
      updateRegistryCheckout({
        globalHome: path.join(os.tmpdir(), "unused-agent-memory-home"),
        memoryKey: invalidMemoryKey,
        repositoryIdentity: "remote:github.com/org/repo",
        repoRoot: path.resolve("."),
        configPath: path.resolve("agent-memory.config.yaml"),
        packageVersion: "0.4.0",
        configHash: "sha256:config"
      });
      throw new Error("Expected invalid memory key to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as Error).message).toBe("Invalid memory key for global storage.");
      expect((error as Error).message).not.toContain(invalidMemoryKey);
    }
  });

  test("handles memory keys that match inherited object property names", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const result = updateRegistryCheckout({
      globalHome,
      memoryKey: "constructor",
      repositoryIdentity: "remote:github.com/org/repo",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    });

    expect(Object.hasOwn(result.registry.memories, "constructor")).toBe(true);
    expect(result.registry.memories.constructor.repository_identity).toBe("remote:github.com/org/repo");
  });

  test("rejects repository identities that could persist credential-bearing URLs", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");

    const credentialBearingIdentity = "https://user:secret@github.com/org/repo.git";
    try {
      updateRegistryCheckout({
        globalHome,
        memoryKey: "unsafe-identity",
        repositoryIdentity: credentialBearingIdentity,
        repoRoot,
        configPath: path.join(repoRoot, "agent-memory.config.yaml"),
        packageVersion: "0.4.0",
        configHash: "sha256:config"
      });
      throw new Error("Expected unsafe repository identity to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as Error).message).toContain("Invalid or unsafe repository identity");
      expect((error as Error).message).not.toContain(credentialBearingIdentity);
      expect((error as Error).message).not.toContain("secret");
    }
  });

  test("rejects noncanonical repository identities before storing them", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const common = {
      globalHome,
      memoryKey: "canonical-identity",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    };

    for (const repositoryIdentity of [
      "remote:GitHub.com/org/repo",
      "remote:github.com/org/repo.git",
      "remote:github.com/org//repo"
    ]) {
      expect(() => updateRegistryCheckout({ ...common, repositoryIdentity })).toThrow(
        "Invalid or unsafe repository identity"
      );
    }
  });

  test("rejects abbreviated, sentinel, and wrong-format Git heads", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    fs.writeFileSync(path.join(repoRoot, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    const common = {
      globalHome,
      memoryKey: "git-head",
      repositoryIdentity: "remote:github.com/org/repo",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    };

    for (const gitHead of ["abc123", "unknown", "a".repeat(64)]) {
      expect(() => updateRegistryCheckout({ ...common, gitHead })).toThrow("Invalid Git head");
    }
    expect(updateRegistryCheckout({ ...common, gitHead: "A".repeat(40) }).registry.memories["git-head"])
      .toBeDefined();
  });

  test("refuses to register an orphaned deterministic database", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const fingerprint = deriveCheckoutFingerprint(repoRoot);
    const databasePath = deriveGlobalDatabasePath(globalHome, "orphaned-cache", fingerprint);
    ensureGlobalDatabaseDirectory(globalHome, "orphaned-cache", fingerprint);
    fs.writeFileSync(databasePath, "untrusted", { mode: 0o600 });

    expect(() => updateRegistryCheckout({
      globalHome,
      memoryKey: "orphaned-cache",
      repositoryIdentity: "remote:github.com/org/repo",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    })).toThrow("Refusing to register orphaned database");
    expect(readRegistry({ globalHome })).toEqual(emptyRegistry());
  });

  test("refuses to register orphaned SQLite sidecars without a main database", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const fingerprint = deriveCheckoutFingerprint(repoRoot);
    const databasePath = deriveGlobalDatabasePath(globalHome, "orphaned-sidecar", fingerprint);
    ensureGlobalDatabaseDirectory(globalHome, "orphaned-sidecar", fingerprint);
    fs.writeFileSync(`${databasePath}-wal`, "untrusted", { mode: 0o600 });

    expect(() => updateRegistryCheckout({
      globalHome,
      memoryKey: "orphaned-sidecar",
      repositoryIdentity: "remote:github.com/org/repo",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    })).toThrow("Refusing to register orphaned database artifacts");
    expect(readRegistry({ globalHome })).toEqual(emptyRegistry());
  });

  test("rejects a dangling database symlink before it can escape global home", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const fingerprint = deriveCheckoutFingerprint(repoRoot);
    const databasePath = deriveGlobalDatabasePath(globalHome, "symlink-cache", fingerprint);
    const databaseDirectory = ensureGlobalDatabaseDirectory(globalHome, "symlink-cache", fingerprint);
    const outside = path.join(makeTempDirectory("agent-memory-outside-"), "escaped.sqlite");
    fs.symlinkSync(outside, databasePath);

    expect(() => ensureGlobalDatabaseDirectory(globalHome, "symlink-cache", fingerprint)).toThrow(
      "symbolic-link component"
    );
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.lstatSync(databasePath).isSymbolicLink()).toBe(true);
    expect(databaseDirectory).toBe(path.dirname(databasePath));
  });

  test("rejects intermediate symlinks that alias generated database directories", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const fingerprint = deriveCheckoutFingerprint(repoRoot);
    const databasesDirectory = path.join(globalHome, "databases");
    const aliasedTarget = path.join(globalHome, "aliased-target");
    fs.mkdirSync(databasesDirectory, { mode: 0o700 });
    fs.mkdirSync(aliasedTarget, { mode: 0o700 });
    fs.symlinkSync(aliasedTarget, path.join(databasesDirectory, "symlink-cache"), "dir");

    expect(() => ensureGlobalDatabaseDirectory(globalHome, "symlink-cache", fingerprint)).toThrow(
      "symbolic-link component"
    );
    expect(fs.existsSync(path.join(aliasedTarget, fingerprint))).toBe(false);
  });

  test("reports stale checkout records without deleting them", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const result = updateRegistryCheckout({
      globalHome,
      memoryKey: "stale-checkout",
      repositoryIdentity: "remote:github.com/org/repo",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    });
    fs.rmSync(repoRoot, { recursive: true });

    expect(registryCheckoutDiagnostics(result.registry)).toEqual([
      expect.objectContaining({
        memoryKey: "stale-checkout",
        checkoutFingerprint: result.checkoutFingerprint,
        stale: true,
        reason: "repo_root_missing"
      })
    ]);
    expect(readRegistry({ globalHome }).memories["stale-checkout"]).toBeDefined();
  });

  test("rejects corrupt JSON and deterministic-path tampering with repair guidance", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const registryPath = registryPaths(globalHome).registry;
    fs.writeFileSync(registryPath, "{not-json", { mode: 0o600 });

    expectRegistryRepairError(() => readRegistry({ globalHome }));

    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const fingerprint = deriveCheckoutFingerprint(repoRoot);
    const tampered = {
      version: 1 as const,
      memories: {
        repo: {
          repository_identity: "remote:github.com/org/repo",
          checkouts: {
            [fingerprint]: {
              repo_root: repoRoot,
              config_path: path.join(repoRoot, "agent-memory.config.yaml"),
              database_path: path.join(globalHome, "outside.sqlite"),
              package_version: "0.4.0",
              config_hash: "sha256:config",
              git_head: null,
              last_seen_at: "2026-08-07T12:00:00.000Z"
            }
          }
        }
      }
    };
    fs.writeFileSync(registryPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    expectRegistryErrorDetail(() => readRegistry({ globalHome }), "unexpected database_path");
  });

  test("rejects an active checkout whose fingerprint does not match its canonical root", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const incorrectFingerprint = "000000000000000000000000";
    const registry = {
      version: 1,
      memories: {
        repo: {
          repository_identity: "remote:github.com/org/repo",
          checkouts: {
            [incorrectFingerprint]: {
              repo_root: repoRoot,
              config_path: path.join(repoRoot, "agent-memory.config.yaml"),
              database_path: deriveGlobalDatabasePath(globalHome, "repo", incorrectFingerprint),
              package_version: "0.4.0",
              config_hash: "sha256:config",
              git_head: null,
              last_seen_at: "2026-08-07T12:00:00.000Z"
            }
          }
        }
      }
    };
    fs.writeFileSync(registryPaths(globalHome).registry, `${JSON.stringify(registry)}\n`, { mode: 0o600 });

    expectRegistryErrorDetail(() => readRegistry({ globalHome }), "does not match its active repository root fingerprint");
  });

  test("rejects an existing global home with broad permissions", () => {
    if (typeof process.getuid !== "function") return;
    const globalHome = makeTempDirectory("agent-memory-broad-home-");
    fs.chmodSync(globalHome, 0o755);

    expect(() => readRegistry({ globalHome })).toThrow("permissions are too broad");
    expect(() => updateRegistry(() => undefined, { globalHome })).toThrow("permissions are too broad");
  });

  test("revalidates a newly created global home before using it", () => {
    const parent = makeTempDirectory("agent-memory-home-parent-");
    const globalHome = path.join(parent, "global-home");
    const outside = makeTempDirectory("agent-memory-home-target-");
    const mkdir = spyOn(fs, "mkdirSync").mockImplementationOnce((directory) => {
      fs.symlinkSync(outside, directory as fs.PathLike, "dir");
      return undefined;
    });

    try {
      expect(() => ensureGlobalHome(globalHome)).toThrow("must be a real directory");
    } finally {
      mkdir.mockRestore();
    }
  });

  test("uses one canonical registry path for equivalent global-home aliases", () => {
    const parent = makeTempDirectory("agent-memory-home-alias-");
    const realParent = path.join(parent, "real");
    const aliasParent = path.join(parent, "alias");
    const globalHome = path.join(realParent, "global-home");
    fs.mkdirSync(realParent, { recursive: true, mode: 0o700 });
    fs.symlinkSync(realParent, aliasParent, "dir");
    const aliasedHome = path.join(aliasParent, "global-home");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");

    const result = updateRegistryCheckout({
      globalHome: aliasedHome,
      memoryKey: "aliased-home",
      repositoryIdentity: "remote:github.com/org/repo",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    });

    expect(result.databasePath.startsWith(fs.realpathSync(globalHome))).toBe(true);
    expect(readRegistry({ globalHome }).memories["aliased-home"]).toBeDefined();
  });

  test("rejects broad permissions on registered SQLite artifacts", () => {
    if (typeof process.getuid !== "function") return;
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const repoRoot = makeTempDirectory("agent-memory-checkout-");
    const result = updateRegistryCheckout({
      globalHome,
      memoryKey: "private-database",
      repositoryIdentity: "remote:github.com/org/repo",
      repoRoot,
      configPath: path.join(repoRoot, "agent-memory.config.yaml"),
      packageVersion: "0.4.0",
      configHash: "sha256:config"
    });
    ensureGlobalDatabaseDirectory(globalHome, "private-database", result.checkoutFingerprint);
    fs.writeFileSync(result.databasePath, "sqlite", { mode: 0o644 });

    expectRegistryErrorDetail(() => readRegistry({ globalHome }), "database artifact permissions are too broad");

    fs.chmodSync(result.databasePath, 0o600);
    fs.writeFileSync(`${result.databasePath}-wal`, "sidecar", { mode: 0o644 });
    expectRegistryErrorDetail(() => readRegistry({ globalHome }), "database artifact permissions are too broad");
  });

  test("rejects broad or symlinked pre-existing registry files", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const registryPath = registryPaths(globalHome).registry;
    fs.writeFileSync(registryPath, `${JSON.stringify(emptyRegistry())}\n`, { mode: 0o644 });

    if (typeof process.getuid === "function") {
      expect(() => readRegistry({ globalHome })).toThrow("permissions are too broad");
    }

    fs.rmSync(registryPath);
    const outside = path.join(makeTempDirectory("agent-memory-outside-"), "registry.json");
    fs.writeFileSync(outside, `${JSON.stringify(emptyRegistry())}\n`, { mode: 0o600 });
    fs.symlinkSync(outside, registryPath);
    expect(() => readRegistry({ globalHome })).toThrow("not a symbolic link");

    fs.rmSync(registryPath);
    fs.symlinkSync(path.join(globalHome, "missing-registry-target.json"), registryPath);
    expect(() => readRegistry({ globalHome })).toThrow("not a symbolic link");
  });

  test("does not replace the registry when final permission enforcement fails", () => {
    const globalHome = makeTempDirectory("agent-memory-global-home-");
    const original = updateRegistry((registry) => {
      registry.marker = "original";
    }, { globalHome });
    const chmod = spyOn(fs, "fchmodSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });

    try {
      expect(() => updateRegistry((registry) => {
        registry.marker = "replacement";
      }, { globalHome })).toThrow("Could not atomically write registry");
    } finally {
      chmod.mockRestore();
    }

    expect(readRegistry({ globalHome })).toEqual(original);
  });
});

function expectRegistryRepairError(callback: () => unknown): void {
  try {
    callback();
    throw new Error("Expected registry read to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).details.join("\n")).toContain("repair");
  }
}

function expectRegistryErrorDetail(callback: () => unknown, detail: string): void {
  try {
    callback();
    throw new Error("Expected registry operation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).details.join("\n")).toContain(detail);
  }
}

function makeTempDirectory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
