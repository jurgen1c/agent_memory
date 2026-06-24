import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("doctor command", () => {
  test("warns when the database is missing", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(["doctor"], { cwd });

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("doctor found warnings");
    expect(result.stdout).toContain("database_exists");
    expect(result.stdout).toContain("agent-memory compile");
  });

  test("passes after compile", async () => {
    const cwd = copyFixture(mockApp);
    await dispatch(["compile"], { cwd });

    const result = await dispatch(["doctor", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.healthy).toBe(true);
    expect(parsed.checks.every((check: { status: string }) => check.status === "ok")).toBe(true);
  });

  test("warns when canonical memory is newer than the database", async () => {
    const cwd = copyFixture(mockApp);
    await dispatch(["compile"], { cwd });
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(claimPath, future, future);

    const result = await dispatch(["doctor"], { cwd });

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("freshness");
    expect(result.stdout).toContain("older than one or more canonical memory files");
  });

  test("warns when a canonical memory file was deleted after compile", async () => {
    const cwd = copyFixture(mockApp);
    await dispatch(["compile"], { cwd });
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    fs.unlinkSync(claimPath);

    const result = await dispatch(["doctor"], { cwd });

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("file_inventory");
    expect(result.stdout).toContain("inventory changed");
  });

  test("warns when git commit changed after compile", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    await dispatch(["compile"], { cwd });

    fs.writeFileSync(path.join(cwd, "README.local.md"), "# Local change\n");
    git(cwd, ["add", "README.local.md"]);
    git(cwd, ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", "Second"]);

    const result = await dispatch(["doctor"], { cwd });

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("git_commit");
    expect(result.stdout).toContain("current commit");
  });

  test("warns when config hash changed after compile", async () => {
    const cwd = copyFixture(mockApp);
    await dispatch(["compile"], { cwd });
    fs.appendFileSync(path.join(cwd, "agent-memory.config.yaml"), "\n# local config comment\n");

    const result = await dispatch(["doctor"], { cwd });

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("config_hash");
  });

  test("warns for an existing non-agent-memory sqlite file", async () => {
    const cwd = copyFixture(mockApp);
    fs.mkdirSync(path.join(cwd, ".agent-memory"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".agent-memory/memory.sqlite"), "");

    const result = await dispatch(["doctor"], { cwd });

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("metadata");
    expect(result.stdout).toContain("FTS table is missing");
  });
});

describe("sync command", () => {
  test("compiles, validates, and doctors memory", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(["sync"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory synced.");
    expect(result.stdout).toContain("Validation: passed");
    expect(result.stdout).toContain("Doctor: passed");
    expect(fs.existsSync(path.join(cwd, ".agent-memory/memory.sqlite"))).toBe(true);
  });

  test("returns compile failure when memory is invalid", async () => {
    const cwd = copyFixture(path.join(repoRoot, "tests/fixtures/invalid_repo"));
    let stderr = "";
    const exitCode = await runCli(
      ["sync"],
      {
        stdout: { write: () => true },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          }
        }
      },
      { cwd }
    );

    expect(exitCode).toBe(4);
    expect(stderr).toContain("Memory validation failed");
  });
});

describe("install-hooks command", () => {
  test("installs non-blocking sync hooks", async () => {
    const cwd = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd });
    expect(init.exitCode).toBe(0);

    const result = await dispatch(["install-hooks"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("post-merge");

    for (const hookName of ["post-merge", "post-checkout", "post-rewrite"]) {
      const hookPath = path.join(cwd, ".git/hooks", hookName);
      expect(fs.existsSync(hookPath)).toBe(true);
      expect(fs.readFileSync(hookPath, "utf8")).toContain("bin/memory sync");
      expect(fs.statSync(hookPath).mode & 0o111).toBeGreaterThan(0);
    }
  });

  test("installs hooks from a linked worktree", async () => {
    const main = makeGitRepo();
    fs.writeFileSync(path.join(main, "README.md"), "# Main\n");
    commitAll(main, "Initial");

    const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-worktree-parent-"));
    const worktree = path.join(worktreeParent, "linked");
    git(main, ["worktree", "add", "-b", "linked-memory-test", worktree]);

    const result = await dispatch(["install-hooks"], { cwd: worktree });

    expect(result.exitCode).toBe(0);

    for (const hookName of ["post-merge", "post-checkout", "post-rewrite"]) {
      const hookPath = gitPath(worktree, `hooks/${hookName}`);
      expect(fs.existsSync(hookPath)).toBe(true);
      expect(fs.readFileSync(hookPath, "utf8")).toContain("bin/memory sync");
      expect(fs.statSync(hookPath).mode & 0o111).toBeGreaterThan(0);
    }
  });
});

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-phase8-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function makeGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
  git(cwd, ["init"]);
  return cwd;
}

function initGitHistory(cwd: string): void {
  git(cwd, ["init"]);
  commitAll(cwd, "Initial");
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", message]);
}

function gitPath(cwd: string, gitRelativePath: string): string {
  const result = spawnSync("git", ["rev-parse", "--git-path", gitRelativePath], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  const output = result.stdout.trim();
  return path.isAbsolute(output) ? output : path.resolve(cwd, output);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
}
