import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { showRegistryMemory } from "../../packages/core/src/registry_maintenance";

const projectRoot = path.resolve(".");
const cliPath = path.join(projectRoot, "packages/cli/src/index.ts");
const mockApp = path.join(projectRoot, "examples/mock-app");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("global storage clone and move hardening", () => {
  test("isolates two active clones with the same memory key and never falls back to the other database", () => {
    const globalHome = makeTempPath("agent-memory-clone-home-");
    const firstRoot = makeGlobalRepo("agent-memory-first-clone-", "shared-clones");
    const secondRoot = makeGlobalRepo("agent-memory-second-clone-", "shared-clones");

    const firstCompile = runCli(firstRoot, globalHome, ["compile", "--json"]);
    const secondCompile = runCli(secondRoot, globalHome, ["compile", "--json"]);
    expect(firstCompile.status).toBe(0);
    expect(secondCompile.status).toBe(0);

    const firstDatabase = JSON.parse(firstCompile.stdout).databasePath as string;
    const secondDatabase = JSON.parse(secondCompile.stdout).databasePath as string;
    expect(firstDatabase).not.toBe(secondDatabase);
    expect(showRegistryMemory("shared-clones", { globalHome })).toMatchObject({
      active_checkout_count: 2,
      stale_checkout_count: 0,
      checkout_classification: "multiple_active"
    });

    fs.rmSync(secondDatabase);
    const missingRead = runCli(secondRoot, globalHome, ["query", "oauth"]);
    const firstRead = runCli(firstRoot, globalHome, ["query", "oauth"]);

    expect(missingRead.status).toBe(7);
    expect(missingRead.stderr).toContain("Compiled memory database not found");
    expect(missingRead.stderr).toContain("agent-memory compile");
    expect(missingRead.stderr).toContain("agent-memory sync");
    expect(firstRead.status).toBe(0);
    expect(fs.existsSync(firstDatabase)).toBe(true);
  });

  test("detects a moved checkout as one stale mapping plus a new checkout-specific cache", () => {
    const globalHome = makeTempPath("agent-memory-move-home-");
    const originalRoot = makeGlobalRepo("agent-memory-before-move-", "moved-memory");
    expect(runCli(originalRoot, globalHome, ["compile"]).status).toBe(0);

    const movedRoot = `${originalRoot}-moved`;
    temporaryRoots.push(movedRoot);
    fs.renameSync(originalRoot, movedRoot);

    const doctor = runCli(movedRoot, globalHome, ["doctor"]);
    expect(doctor.status).toBe(5);
    expect(doctor.stdout).toContain("Database does not exist");
    expect(doctor.stdout).toContain("agent-memory compile");
    expect(doctor.stdout).toContain("agent-memory sync");
    expect(showRegistryMemory("moved-memory", { globalHome })).toMatchObject({
      active_checkout_count: 1,
      stale_checkout_count: 1,
      checkout_classification: "mixed"
    });

    expect(runCli(movedRoot, globalHome, ["sync"]).status).toBe(0);
    expect(runCli(movedRoot, globalHome, ["doctor"]).status).toBe(0);
  });

  test("reports global config hash, git commit, and file freshness without treating them as identity failures", () => {
    const globalHome = makeTempPath("agent-memory-freshness-home-");
    const repoRoot = makeGlobalRepo("agent-memory-global-freshness-", "freshness-memory");
    expect(runCli(repoRoot, globalHome, ["compile"]).status).toBe(0);

    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    fs.appendFileSync(configPath, "\n# changed after compile\n");
    const changedConfig = runCli(repoRoot, globalHome, ["doctor"]);
    expect(changedConfig.status).toBe(5);
    expect(changedConfig.stdout).toContain("config_hash");
    expect(changedConfig.stdout).toContain("does not match current config");
    expect(changedConfig.stderr).not.toContain("provenance does not match");

    const rejectedRead = runCli(repoRoot, globalHome, ["query", "oauth"]);
    expect(rejectedRead.status).not.toBe(0);
    expect(rejectedRead.stderr).toContain("Global database provenance does not match the current checkout");

    expect(runCli(repoRoot, globalHome, ["sync"]).status).toBe(0);
    const claimPath = path.join(repoRoot, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(claimPath, future, future);
    const staleFiles = runCli(repoRoot, globalHome, ["doctor"]);
    expect(staleFiles.status).toBe(5);
    expect(staleFiles.stdout).toContain("freshness");
    expect(staleFiles.stdout).toContain("older than one or more canonical memory files");

    git(repoRoot, ["add", "."]);
    git(repoRoot, ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", "Change memory"]);
    const changedCommit = runCli(repoRoot, globalHome, ["doctor"]);
    expect(changedCommit.status).toBe(5);
    expect(changedCommit.stdout).toContain("git_commit");
    expect(changedCommit.stdout).toContain("current commit");
  });
});

function makeGlobalRepo(prefix: string, memoryKey: string): string {
  const repoRoot = makeTempPath(prefix);
  fs.cpSync(mockApp, repoRoot, { recursive: true });
  const configPath = path.join(repoRoot, "agent-memory.config.yaml");
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, "utf8").replace(
      "version: 1",
      `version: 2\nmemory_key: ${memoryKey}\ndatabase_scope: global`
    )
  );
  git(repoRoot, ["init"]);
  git(repoRoot, ["remote", "add", "origin", "https://github.com/example/shared-memory.git"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", "Initial"]);
  return repoRoot;
}

function runCli(cwd: string, globalHome: string, args: string[]) {
  return spawnSync("bun", [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, AGENT_MEMORY_HOME: globalHome }
  });
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
}

function makeTempPath(prefix: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(target);
  return target;
}
