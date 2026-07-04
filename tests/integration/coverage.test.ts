import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("coverage command", () => {
  test("fails when a changed watched file has no related memory update", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["coverage", "--changed-files", "src/auth.js"], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("Agent Memory coverage failed");
    expect(result.stdout).toContain("src/auth.js");
    expect(result.stdout).toContain("Update a related claim");
  });

  test("passes when a related claim changes in the same change set", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(
      ["coverage", "--changed-files", "src/auth.js", "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md", "--json"],
      { cwd }
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.changes.find((change: { path: string }) => change.path === "src/auth.js").status).toBe("covered");
  });

  test("passes when a related recipe changes in the same change set", async () => {
    const cwd = await compiledMockAppWithoutRecipeGlobs();
    const result = await dispatch(["coverage", "--changed-files", "src/auth.js", "docs/agent-memory/recipes/auth/modify_student_oauth.yaml", "--json"], {
      cwd
    });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.changes.find((change: { path: string }) => change.path === "src/auth.js").status).toBe("covered");
  });

  test("warns when an active local plan run is staged", async () => {
    const cwd = await compiledMockApp();
    writePlanRun(cwd, "active");

    const result = await dispatch(["coverage", "--changed-files", ".agent-memory/plans/active.yaml", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toContain(".agent-memory/plans/active.yaml: active plan runs are local task state and should not be staged by default.");
  });

  test("does not require profile trait updates for matching source changes", async () => {
    const cwd = copyFixture(mockApp);
    writeProfile(cwd);
    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const result = await dispatch(
      ["coverage", "--changed-files", "src/auth.js", "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md", "--json"],
      { cwd }
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.changes.find((change: { path: string }) => change.path === "src/auth.js").status).toBe("covered");
    expect(parsed.warnings).toContain("src/auth.js: profile trait profile_trait.review.auth_changes may apply; update the trait only if guidance changed.");
  });

  test("passes when a valid waiver covers the changed watched file", async () => {
    const cwd = await compiledMockApp();
    writeWaiver(cwd);

    const result = await dispatch(["coverage", "--changed-files", "src/auth.js"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory coverage passed");
    expect(result.stdout).toContain("Waived: 1");
    expect(result.stdout).toContain("waiver.auth.temporary_oauth_followup");
  });

  test("passes for a non-watched changed file", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["coverage", "--changed-files", "README.md"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Watched changes: 0");
  });

  test("checks git diff files", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);
    fs.appendFileSync(path.join(cwd, "src/auth.js"), "\n// coverage drift\n");

    const result = await dispatch(["coverage", "--git-diff"], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("src/auth.js");
  });

  test("checks clean committed git diff files", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    fs.appendFileSync(path.join(cwd, "src/auth.js"), "\n// committed coverage drift\n");
    commitAll(cwd, "Change watched auth file");
    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const result = await dispatch(["coverage", "--git-diff"], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("src/auth.js");
  });

  test("checks committed git diff files against an explicit base ref", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(cwd, "src/auth.js"), "\n// base coverage drift\n");
    commitAll(cwd, "Change watched auth file");
    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const result = await dispatch(["coverage", "--git-diff", "--base", base], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("src/auth.js");
  });

  test("reports missing compiled database", async () => {
    const cwd = copyFixture(mockApp);
    let stderr = "";
    const exitCode = await runCli(
      ["coverage", "--changed-files", "src/auth.js"],
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

    expect(exitCode).toBe(7);
    expect(stderr).toContain("Compiled memory database not found");
  });
});

async function compiledMockApp(): Promise<string> {
  const cwd = copyFixture(mockApp);
  const compile = await dispatch(["compile"], { cwd });
  expect(compile.exitCode).toBe(0);
  return cwd;
}

async function compiledMockAppWithoutRecipeGlobs(): Promise<string> {
  const cwd = copyFixture(mockApp);
  const indexPath = path.join(cwd, "docs/agent-memory/indexes/auth.yaml");
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, "utf8").replace("recipe_globs:\n  - recipes/auth/**/*.yaml\n\n", ""));
  const compile = await dispatch(["compile"], { cwd });
  expect(compile.exitCode).toBe(0);
  return cwd;
}

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-coverage-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function writeWaiver(cwd: string): void {
  const waiverPath = path.join(cwd, "docs/agent-memory/waivers/auth-temporary.yaml");
  fs.writeFileSync(
    waiverPath,
    `id: waiver.auth.temporary_oauth_followup
reason: Temporary follow-up tracked outside this change.
files:
  - src/auth.js
expires_at: 2999-01-01
`
  );
}

function writePlanRun(cwd: string, status: string): void {
  const planPath = path.join(cwd, ".agent-memory/plans/active.yaml");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    `id: plan_run.active
task: Active local task
created_at: 2026-07-03T00:00:00.000Z
updated_at: 2026-07-03T00:00:00.000Z
status: ${status}
current_stage: inspect
stages:
  - id: inspect
    title: Inspect
    goal: Inspect task.
    status: active
    evidence: []
`
  );
}

function writeProfile(cwd: string): void {
  const profilePath = path.join(cwd, "docs/agent-memory/profiles/review/auth_changes.yaml");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(
    profilePath,
    `id: profile_trait.review.auth_changes
title: Auth changes
status: current
category: risk_lens
priority: normal
applies_when:
  changed_files:
    - src/auth.js
snippet: Review auth changes carefully.
`
  );
}

function initGitHistory(cwd: string): void {
  git(cwd, ["init"]);
  commitAll(cwd, "Initial");
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", message]);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
