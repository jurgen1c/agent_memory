import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";
import { classifyDocs } from "../../packages/core/src/migration";

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

  test("classifies broad docs into a deterministic system map", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    fs.mkdirSync(path.join(repoRoot, "docs/agent-memory/claims/search"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/agent-memory/claims/search/.gitkeep"), "");
    fs.mkdirSync(path.join(repoRoot, "docs/canonical/auth"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "docs/canonical/null"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "docs/canonical/reference"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/auth/oauth.md"), "# OAuth Behavior\n\nTenant auth notes.\n");
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/null/value.md"), "# 1.2\n\nNumeric-looking title.\n");
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/reference/search.md"), "# Search Ranking\n\nSearch notes.\n");
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/overview.md"), "# General Overview\n\nGeneral notes.\n");

    const result = await dispatch(["migrate-docs", "--from", "docs/canonical", "--classify"], { cwd: repoRoot });
    const mapPath = path.join(repoRoot, ".agent-memory/migrations/docs-canonical.yaml");
    const systemMap = fs.readFileSync(mapPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory docs migration system map created.");
    expect(result.stdout).toContain("Status: created");
    expect(result.stdout).toContain("System map: .agent-memory/migrations/docs-canonical.yaml");
    expect(systemMap).toContain("source_root: docs/canonical");
    expect(systemMap).toContain("source: docs/canonical/auth/oauth.md");
    expect(systemMap).toContain("system: auth");
    expect(systemMap).toContain("source: docs/canonical/null/value.md");
    expect(systemMap).toContain('system: "null"');
    expect(systemMap).toContain('title: "1.2"');
    expect(systemMap).toContain("source: docs/canonical/reference/search.md");
    expect(systemMap).toContain("system: search");
    expect(systemMap).toContain("source: docs/canonical/overview.md");
    expect(systemMap).toContain("confidence: low");
    expect(systemMap).toContain("No subsystem match; defaulted to docs");
  });

  test("does not overwrite reviewed system maps unless forced", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    fs.mkdirSync(path.join(repoRoot, "docs/canonical/auth"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/auth/oauth.md"), "# OAuth Behavior\n\nTenant auth notes.\n");

    const first = await dispatch(["migrate-docs", "--from", "docs/canonical", "--classify"], { cwd: repoRoot });
    expect(first.exitCode).toBe(0);

    const mapPath = path.join(repoRoot, ".agent-memory/migrations/docs-canonical.yaml");
    fs.writeFileSync(mapPath, `${fs.readFileSync(mapPath, "utf8")}\n# reviewed edit\n`);

    const skipped = await dispatch(["migrate-docs", "--from", "docs/canonical", "--classify"], { cwd: repoRoot });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain("Agent Memory docs migration system map skipped.");
    expect(skipped.stdout).toContain("Status: skipped");
    expect(skipped.stdout).toContain("leaving reviewed map unchanged");
    expect(fs.readFileSync(mapPath, "utf8")).toContain("# reviewed edit");

    const forced = await dispatch(["migrate-docs", "--from", "docs/canonical", "--classify", "--force"], { cwd: repoRoot });
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Agent Memory docs migration system map overwritten.");
    expect(forced.stdout).toContain("Status: overwritten");
    expect(fs.readFileSync(mapPath, "utf8")).not.toContain("# reviewed edit");
  });

  test("rejects classify output paths that escape the repository", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    fs.mkdirSync(path.join(repoRoot, "docs/canonical/auth"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/auth/oauth.md"), "# OAuth Behavior\n\nTenant auth notes.\n");
    const outsideRelativePath = `../${path.basename(repoRoot)}-outside-map.yaml`;
    const outsidePath = path.resolve(repoRoot, outsideRelativePath);

    expect(() => classifyDocs({ cwd: repoRoot, fromPath: "docs/canonical", outputPath: outsideRelativePath })).toThrow(
      "Relative output path escapes repository root"
    );
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  test("plans and automatically migrates docs from a reviewed system map", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    fs.mkdirSync(path.join(repoRoot, "docs/canonical/auth"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "docs/canonical/billing"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/auth/oauth.md"), "# OAuth Behavior\n\nTenant auth notes.\n");
    fs.writeFileSync(path.join(repoRoot, "docs/canonical/billing/invoices.md"), "# Invoice Behavior\n\nBilling notes.\n");
    const mapPath = path.join(repoRoot, ".agent-memory/migrations/docs-canonical.yaml");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(
      mapPath,
      `version: 1
source_root: docs/canonical
mappings:
  - source: docs/canonical/auth/oauth.md
    system: auth
    title: OAuth behavior
    confidence: high
    reason: Reviewed auth docs
  - source: docs/canonical/billing/invoices.md
    system: billing
    title: Invoice behavior
    confidence: high
    reason: Reviewed billing docs
`
    );

    const plan = await dispatch(["migrate-docs", "--system-map", ".agent-memory/migrations/docs-canonical.yaml"], { cwd: repoRoot });
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("System map: .agent-memory/migrations/docs-canonical.yaml");
    expect(plan.stdout).toContain("docs/agent-memory/claims/auth/migrated_oauth_behavior.md");
    expect(plan.stdout).toContain("docs/agent-memory/claims/billing/migrated_invoice_behavior.md");
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_oauth_behavior.md"))).toBe(false);

    const automatic = await dispatch(
      ["migrate-docs", "--system-map", ".agent-memory/migrations/docs-canonical.yaml", "--automatic"],
      { cwd: repoRoot }
    );
    expect(automatic.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(repoRoot, "docs/agent-memory/claims/auth/migrated_oauth_behavior.md"), "utf8")).toContain(
      "id: auth.migrated_oauth_behavior"
    );
    expect(fs.readFileSync(path.join(repoRoot, "docs/agent-memory/claims/billing/migrated_invoice_behavior.md"), "utf8")).toContain(
      "id: billing.migrated_invoice_behavior"
    );

    const validate = await dispatch(["validate"], { cwd: repoRoot });
    expect(validate.exitCode).toBe(0);
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
    expect(stderr).toContain("migrate-docs requires --system <system>");
    expect(stderr).toContain("A system is the lowercase memory namespace");
    expect(stderr).toContain("agent-memory migrate-docs --from docs --system docs --automatic");

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

    const mapPath = path.join(repoRoot, ".agent-memory/migrations/external.yaml");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(
      mapPath,
      `version: 1
source_root: ${JSON.stringify(externalRoot)}
mappings:
  - source: ${JSON.stringify(path.join(externalRoot, "external.md"))}
    system: auth
    title: External Doc
    confidence: high
    reason: External test fixture
`
    );
    stderr = "";
    const externalMapAutomatic = await runCli(
      ["migrate-docs", "--system-map", ".agent-memory/migrations/external.yaml", "--automatic"],
      quietStreams((chunk) => {
        stderr += chunk;
      }),
      { cwd: repoRoot }
    );

    expect(externalMapAutomatic).toBe(1);
    expect(stderr).toContain("Automatic migration requires system-map sources to point inside the repository");
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
