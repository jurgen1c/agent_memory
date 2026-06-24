import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

describe("migrate-docs command", () => {
  test("plans memory drafts from existing docs without writing files", async () => {
    const repoRoot = await initializedRepoWithLegacyDocs();

    const result = await dispatch(["migrate-docs", "--from", "docs/legacy", "--system", "auth"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory docs migration plan");
    expect(result.stdout).toContain("docs/legacy/student-oauth.md");
    expect(result.stdout).toContain("docs/agent-memory/claims/auth/migrated_student_oauth_legacy_behavior.md");
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_student_oauth_legacy_behavior.md"))).toBe(false);
  });

  test("automatically creates current claim drafts from existing docs", async () => {
    const repoRoot = await initializedRepoWithLegacyDocs();

    const result = await dispatch(["migrate-docs", "--from", "docs/legacy", "--system", "auth", "--automatic"], { cwd: repoRoot });
    const claimPath = path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_student_oauth_legacy_behavior.md");
    const content = fs.readFileSync(claimPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Drafts created: 1");
    expect(content).toContain("status: current");
    expect(content).toContain("confidence: low");
    expect(content).toContain("docs/legacy/student-oauth.md");

    const validate = await dispatch(["validate"], { cwd: repoRoot });
    expect(validate.exitCode).toBe(0);
  });

  test("deduplicates migrated docs with the same heading", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    fs.mkdirSync(path.join(repoRoot, "docs/legacy"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/legacy/a.md"), "# Same\n\nFirst source.\n");
    fs.writeFileSync(path.join(repoRoot, "docs/legacy/b.md"), "# Same\n\nSecond source.\n");

    const result = await dispatch(["migrate-docs", "--from", "docs/legacy", "--system", "auth", "--automatic"], { cwd: repoRoot });
    const firstPath = path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_same.md");
    const secondPath = path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_same_2.md");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Drafts created: 2");
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(fs.existsSync(secondPath)).toBe(true);
    expect(fs.readFileSync(firstPath, "utf8")).toContain("id: auth.migrated_same");
    expect(fs.readFileSync(firstPath, "utf8")).toContain("docs/legacy/a.md");
    expect(fs.readFileSync(secondPath, "utf8")).toContain("id: auth.migrated_same_2");
    expect(fs.readFileSync(secondPath, "utf8")).toContain("docs/legacy/b.md");

    const validate = await dispatch(["validate"], { cwd: repoRoot });
    expect(validate.exitCode).toBe(0);
  });

  test("supports JSON output", async () => {
    const repoRoot = await initializedRepoWithLegacyDocs();

    const result = await dispatch(["migrate-docs", "--from", "docs/legacy", "--system", "auth", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.mode).toBe("plan");
    expect(parsed.docs[0].suggestedId).toBe("auth.migrated_student_oauth_legacy_behavior");
  });

  test("warns when no migratable docs are found", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    fs.mkdirSync(path.join(repoRoot, "docs/empty"), { recursive: true });

    const result = await dispatch(["migrate-docs", "--from", "docs/empty", "--system", "auth"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Docs: 0");
    expect(result.stdout).toContain("No migratable docs found");
  });

  test("migrates a single source file and falls back to filename titles", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    fs.mkdirSync(path.join(repoRoot, "docs/legacy"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/legacy/oauth-notes.txt"), "Tenant context matters.\n");

    const result = await dispatch(["migrate-docs", "--from", "docs/legacy/oauth-notes.txt", "--system", "auth", "--automatic"], {
      cwd: repoRoot
    });
    const claimPath = path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_oauth_notes.md");

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(fs.readFileSync(claimPath, "utf8")).toContain("title: Oauth Notes");
  });

  test("skips existing automatic drafts unless forced", async () => {
    const repoRoot = await initializedRepoWithLegacyDocs();
    const first = await dispatch(["migrate-docs", "--from", "docs/legacy", "--system", "auth", "--automatic"], { cwd: repoRoot });
    expect(first.exitCode).toBe(0);
    const claimPath = path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_student_oauth_legacy_behavior.md");
    fs.appendFileSync(claimPath, "\n# Local edit\n");

    const skipped = await dispatch(["migrate-docs", "--from", "docs/legacy", "--system", "auth", "--automatic"], { cwd: repoRoot });
    expect(skipped.stdout).toContain("skipped");
    expect(fs.readFileSync(claimPath, "utf8")).toContain("# Local edit");

    const overwritten = await dispatch(["migrate-docs", "--from", "docs/legacy", "--system", "auth", "--automatic", "--force"], {
      cwd: repoRoot
    });
    expect(overwritten.stdout).toContain("overwritten");
    expect(fs.readFileSync(claimPath, "utf8")).not.toContain("# Local edit");
  });

  test("reports invalid migrate-docs options", async () => {
    let stderr = "";
    const missingFrom = await runCli(
      ["migrate-docs", "--system", "auth"],
      quietStreams((chunk) => {
        stderr += chunk;
      })
    );

    expect(missingFrom).toBe(1);
    expect(stderr).toContain("migrate-docs requires --from");

    stderr = "";
    const missingSystem = await runCli(
      ["migrate-docs", "--from", "docs"],
      quietStreams((chunk) => {
        stderr += chunk;
      })
    );

    expect(missingSystem).toBe(1);
    expect(stderr).toContain("migrate-docs requires --system");

    stderr = "";
    const unknownOption = await runCli(
      ["migrate-docs", "--wat"],
      quietStreams((chunk) => {
        stderr += chunk;
      })
    );

    expect(unknownOption).toBe(1);
    expect(stderr).toContain("Unknown migrate-docs option");
  });

  test("reports invalid migration sources", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    let stderr = "";

    const missingSource = await runCli(
      ["migrate-docs", "--from", "docs/missing", "--system", "auth"],
      quietStreams((chunk) => {
        stderr += chunk;
      }),
      { cwd: repoRoot }
    );

    expect(missingSource).toBe(1);
    expect(stderr).toContain("Migration source does not exist");

    fs.mkdirSync(path.join(repoRoot, "docs/legacy"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/legacy/escape.md"), "# Escape\n");
    stderr = "";
    const invalidSystem = await runCli(
      ["migrate-docs", "--from", "docs/legacy", "--system", "../../outside", "--automatic"],
      quietStreams((chunk) => {
        stderr += chunk;
      }),
      { cwd: repoRoot }
    );

    expect(invalidSystem).toBe(1);
    expect(stderr).toContain("Invalid migration system");
    expect(fs.existsSync(path.resolve(repoRoot, "../../outside"))).toBe(false);

    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-external-docs-"));
    fs.writeFileSync(path.join(externalRoot, "external.md"), "# External Doc\n");
    stderr = "";
    const externalAutomatic = await runCli(
      ["migrate-docs", "--from", externalRoot, "--system", "auth", "--automatic"],
      quietStreams((chunk) => {
        stderr += chunk;
      }),
      { cwd: repoRoot }
    );

    expect(externalAutomatic).toBe(1);
    expect(stderr).toContain("Automatic migration requires --from to point inside the repository");
  });
});

async function initializedRepoWithLegacyDocs(): Promise<string> {
  const repoRoot = makeGitRepo();
  const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
  expect(init.exitCode).toBe(0);
  fs.mkdirSync(path.join(repoRoot, "docs/legacy"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "docs/legacy/student-oauth.md"),
    `# Student OAuth Legacy Behavior

Student OAuth identity resolution historically depended on tenant context and provider user ID.
`
  );
  return repoRoot;
}

function makeGitRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-migrate-docs-"));
  const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
  expect(init.status).toBe(0);
  return repoRoot;
}

function quietStreams(onStderr: (chunk: string) => void) {
  return {
    stdout: { write: () => true },
    stderr: {
      write: (chunk: string) => {
        onStderr(chunk);
        return true;
      }
    }
  };
}
