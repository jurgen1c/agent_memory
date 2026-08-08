import { describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveDatabaseLocation } from "../../packages/core/src/database";
import { ConfigError } from "../../packages/core/src/errors";

const repoRoot = path.resolve("fixtures/database-repo");

describe("resolveDatabaseLocation", () => {
  test("resolves a configured repo-relative local database path", () => {
    expect(
      resolveDatabaseLocation({
        config: { database_path: ".agent-memory/memory.sqlite" },
        repoRoot
      })
    ).toEqual({
      path: path.join(repoRoot, ".agent-memory/memory.sqlite"),
      scope: "local",
      source: "local_config"
    });
  });

  test("preserves a configured absolute local database path", () => {
    const databasePath = `${path.parse(repoRoot).root}${["shared", "link", "..", "memory.sqlite"].join(path.sep)}`;

    expect(
      resolveDatabaseLocation({
        config: { database_path: databasePath },
        repoRoot
      })
    ).toEqual({
      path: databasePath,
      scope: "local",
      source: "local_config"
    });
  });

  test("gives a relative CLI override precedence over configured and global locations", () => {
    expect(
      resolveDatabaseLocation({
        config: {
          database_path: ".agent-memory/memory.sqlite",
          database_scope: "global",
          memory_key: "jurgen1c-agent-memory"
        },
        repoRoot,
        dbPath: "tmp/override.sqlite",
        globalLocation: {
          databasePath: path.resolve("fixtures/global/memory.sqlite"),
          checkoutFingerprint: "0123456789abcdef01234567",
          repositoryIdentity: "remote:github.com/jurgen1c/agent_memory"
        }
      })
    ).toEqual({
      path: path.join(repoRoot, "tmp/override.sqlite"),
      scope: "global",
      source: "cli_override",
      memoryKey: "jurgen1c-agent-memory"
    });
  });

  test("preserves an absolute CLI override path", () => {
    const databasePath = `${path.parse(repoRoot).root}${["override", "link", "..", "memory.sqlite"].join(path.sep)}`;

    expect(
      resolveDatabaseLocation({
        config: { database_path: ".agent-memory/memory.sqlite" },
        repoRoot,
        dbPath: databasePath
      })
    ).toEqual({
      path: databasePath,
      scope: "local",
      source: "cli_override"
    });
  });

  test("returns future global-registry metadata", () => {
    const databasePath = path.resolve("fixtures/global/memory.sqlite");

    expect(
      resolveDatabaseLocation({
        config: {
          database_path: ".agent-memory/memory.sqlite",
          database_scope: "global",
          memory_key: "jurgen1c-agent-memory"
        },
        repoRoot,
        globalLocation: {
          databasePath,
          checkoutFingerprint: "0123456789abcdef01234567",
          repositoryIdentity: "remote:github.com/jurgen1c/agent_memory"
        }
      })
    ).toEqual({
      path: databasePath,
      scope: "global",
      source: "global_registry",
      memoryKey: "jurgen1c-agent-memory",
      checkoutFingerprint: "0123456789abcdef01234567",
      repositoryIdentity: "remote:github.com/jurgen1c/agent_memory"
    });
  });

  test("fails actionably when global scope has no memory key", () => {
    expect(() =>
      resolveDatabaseLocation({
        config: {
          database_path: ".agent-memory/memory.sqlite",
          database_scope: "global"
        },
        repoRoot,
        globalLocation: {
          databasePath: path.resolve("fixtures/global/memory.sqlite"),
          checkoutFingerprint: "0123456789abcdef01234567",
          repositoryIdentity: "remote:github.com/jurgen1c/agent_memory"
        }
      })
    ).toThrow("Global database scope requires config field memory_key.");
  });

  test("fails actionably when a global registry location is unavailable", () => {
    expect(() =>
      resolveDatabaseLocation({
        config: {
          database_path: ".agent-memory/memory.sqlite",
          database_scope: "global",
          memory_key: "jurgen1c-agent-memory"
        },
        repoRoot
      })
    ).toThrow(ConfigError);
  });
});
