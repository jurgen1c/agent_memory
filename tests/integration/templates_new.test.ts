import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";

describe("templates command", () => {
  test("lists and shows built-in claim templates", async () => {
    const list = await dispatch(["templates", "list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("claim:fact");
    expect(list.stdout).toContain("claim:constraint");
    expect(list.stdout).toContain("claim:deprecation");

    const show = await dispatch(["templates", "show", "claim:constraint"]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("type: constraint");
    expect(show.stdout).toContain("## Constraint");
  });

  test("copies a template to a requested path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-template-copy-"));
    const target = path.join(dir, "fact.md");
    const result = await dispatch(["templates", "copy", "claim:fact", "--to", target]);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain("type: fact");
  });

  test("supports copy aliases and reports incomplete or invalid requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-template-options-"));
    const target = path.join(dir, "fact.md");

    const copied = await dispatch(["templates", "copy", "claim:fact", `--to=${target}`]);
    expect(copied.stdout).toContain("created");
    const overwritten = await dispatch(["templates", "copy", "claim:fact", `--to=${target}`, "--force"]);
    expect(overwritten.stdout).toContain("overwritten");

    expect(dispatch(["templates", "show"])).rejects.toThrow("templates show requires a template name");
    expect(dispatch(["templates", "show", "claim:fact", "extra"])).rejects.toThrow("Unexpected templates show arguments: extra");
    expect(dispatch(["templates", "copy"])).rejects.toThrow("templates copy requires a template name");
    expect(dispatch(["templates", "copy", "claim:fact", "--to"])).rejects.toThrow("--to requires a destination path");
    expect(dispatch(["templates", "copy", "claim:fact", "--wat"])).rejects.toThrow("Unknown templates copy option: --wat");
    expect(dispatch(["templates", "copy", "claim:fact"])).rejects.toThrow("templates copy requires --to <path>");
    expect(dispatch(["templates", "unknown"])).rejects.toThrow("Unknown templates subcommand: unknown");
  });
});

describe("new claim command", () => {
  test("creates a fact claim from a template", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });

    const result = await dispatch(
      [
        "new",
        "claim",
        "--type",
        "fact",
        "--system",
        "Auth",
        "--title",
        "Student OAuth UID is tenant scoped",
        "--source-file",
        "src/auth.js",
        "--claim",
        "Student OAuth identity resolution depends on tenant ID.",
        "--verification-step",
        "bun test"
      ],
      { cwd: repoRoot }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ID: auth.student_oauth_uid_is_tenant_scoped");
    expect(result.stdout).toContain("docs/agent-memory/claims/auth/student-oauth-uid-is-tenant-scoped.md");

    const claimPath = path.join(repoRoot, "docs/agent-memory/claims/auth/student-oauth-uid-is-tenant-scoped.md");
    const content = fs.readFileSync(claimPath, "utf8");
    expect(content).toContain("type: fact");
    expect(content).toContain("severity: normal");
    expect(content).toContain("Student OAuth identity resolution depends on tenant ID.");
    expect(content).toContain("- bun test");
  });

  test("avoids generated ID and path collisions", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });

    await dispatch(["new", "claim", "--type", "fact", "--system", "auth", "--title", "Duplicate Claim"], { cwd: repoRoot });
    const result = await dispatch(["new", "claim", "--type", "fact", "--system", "auth", "--title", "Duplicate Claim"], {
      cwd: repoRoot
    });

    expect(result.stdout).toContain("ID: auth.duplicate_claim_2");
    expect(result.stdout).toContain("docs/agent-memory/claims/auth/duplicate-claim-2.md");
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/claims/auth/duplicate-claim.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/claims/auth/duplicate-claim-2.md"))).toBe(true);
  });

  test("supports explicit ID and severity options", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });

    const result = await dispatch(
      [
        "new",
        "claim",
        "--type",
        "rule",
        "--system",
        "ci",
        "--title",
        "Tests must pass",
        "--id",
        "ci.tests.must_pass",
        "--severity",
        "critical"
      ],
      { cwd: repoRoot }
    );

    expect(result.stdout).toContain("ID: ci.tests.must_pass");
    const content = fs.readFileSync(path.join(repoRoot, "docs/agent-memory/claims/ci/tests-must-pass.md"), "utf8");
    expect(content).toContain("severity: critical");
  });

  test("supports equals-form claim options and validates bad input", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });

    const result = await dispatch(
      [
        "new",
        "claim",
        "--type=decision",
        "--system=auth",
        "--title=Use tenant OAuth",
        "--id=auth.oauth.tenant_decision",
        "--source-file=src/auth.ts",
        "--claim=OAuth decisions are tenant scoped.",
        "--verification-step=bun test",
        "--severity=important",
        "--force"
      ],
      { cwd: repoRoot }
    );
    expect(result.stdout).toContain("ID: auth.oauth.tenant_decision");

    expect(dispatch(["new", "unknown"], { cwd: repoRoot })).rejects.toThrow("Unknown new target: unknown");
    expect(dispatch(["new", "claim"], { cwd: repoRoot })).rejects.toThrow("Missing required new claim options");
    expect(dispatch(["new", "claim", "--type=invalid"], { cwd: repoRoot })).rejects.toThrow("Unsupported claim type: invalid");
    expect(
      dispatch(["new", "claim", "--type=fact", "--system=auth", "--title=Invalid severity", "--severity=urgent"], { cwd: repoRoot })
    ).rejects.toThrow("Unsupported claim severity: urgent");
    expect(dispatch(["new", "claim", "--type"], { cwd: repoRoot })).rejects.toThrow("--type requires a value");
    expect(dispatch(["new", "claim", "--wat"], { cwd: repoRoot })).rejects.toThrow("Unknown new claim option: --wat");
  });
});

function makeGitRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-phase3-"));
  const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
  expect(init.status).toBe(0);
  return repoRoot;
}
