import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.join(import.meta.dir, "..");
const architecturePath = path.join(repositoryRoot, "docs", "features", "global-storage-architecture.md");

describe("global storage architecture contract", () => {
  test("keeps canonical memory and plan runs repository-local", () => {
    const architecture = readArchitecture();

    expect(architecture).toContain("approved AM-65 architecture contract for the AM-66 through AM-76 implementation sequence");
    expect(architecture).toContain("<repo>/docs/agent-memory/");
    expect(architecture).toContain("<repo>/.agent-memory/plans/");
    expect(architecture).toContain("Global SQLite and registry data must never be treated as canonical memory");
    expect(architecture).toContain("Plan runs remain repo-local for this feature.");
  });

  test("defines the versioned config and deterministic storage contract", () => {
    const architecture = readArchitecture();

    expect(architecture).toContain("version: 2");
    expect(architecture).toContain("memory_key: jurgen1c-agent-memory");
    expect(architecture).toContain("database_scope: global");
    expect(architecture).toContain("Version 1 remains the legacy local-only contract.");
    expect(architecture).toContain("older CLI that supports only version 1 rejects version 2");
    expect(architecture).toContain("Version 1 without the new fields");
    expect(architecture).toContain(
      "<global-home>/databases/<memory-key>/<checkout-fingerprint>/memory.sqlite"
    );
    expect(architecture).toContain("AGENT_MEMORY_HOME");
    expect(architecture).toContain("`registry.json` is versioned independently from repository config.");
    expect(architecture).toContain("`<global-home>/registry.lock`");
    expect(architecture).toContain("Every registry read-modify-write update must acquire the exclusive");
    expect(architecture).toContain("Windows device basename");
    expect(architecture).toContain("requires an explicit valid `memory_key`");
    expect(architecture).toContain("supports user-only permissions");
    expect(architecture).toContain("directories and `0600` for files");
    expect(architecture).toContain("never changes permissions on a pre-existing");
  });

  test("resolves clone collisions and migration without implicit destructive behavior", () => {
    const architecture = readArchitecture();

    expect(architecture).toContain("Dangerous key collision");
    expect(architecture).toContain("Fail closed; require one repository to choose a new key");
    expect(architecture).toContain("exact non-null repository identity");
    expect(architecture).toContain("Root commits therefore never authorize cross-checkout cache reuse");
    expect(architecture).toContain('"repository_identity": "remote:https:github.com/jurgen1c/agent_memory"');
    expect(architecture).toContain("SSH account because SCP-style paths");
    expect(architecture).toContain("`repository_identity` must not also appear on checkout");
    expect(architecture).toContain("Stored `database_path` values are diagnostic metadata, not trusted path input.");
    expect(architecture).toContain("verifies symlink-aware containment beneath global home");
    expect(architecture).toContain("it is an orphaned, untrusted cache");
    expect(architecture).toContain("provenance exactly matches the current");
    expect(architecture).toContain("Existing repositories do not migrate automatically");
    expect(architecture).toContain("Migration never deletes `bin/memory` or the local SQLite database.");
    expect(architecture).toContain("AM-66 through AM-76");
  });
});

function readArchitecture(): string {
  return fs.readFileSync(architecturePath, "utf8");
}
