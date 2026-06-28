import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("audit command", () => {
  test("passes with JSON output for unrelated changed files", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(["audit", "--changed-files", "README.md", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.changedFiles).toEqual(["README.md"]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  test("reports missing changed-file input", async () => {
    const cwd = copyFixture(mockApp);
    let stderr = "";
    const exitCode = await runCli(
      ["audit"],
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

    expect(exitCode).toBe(1);
    expect(stderr).toContain("audit requires --changed-files or --git-diff");
  });

  test("fails when changed active claims overlap without a review decision", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_new_current.md", {
      id: "auth.student_oauth.new_current",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.overlap_without_review");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
  });

  test("passes when changed overlapping claims have an explicit replaces edge", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_replacement.md", {
      id: "auth.student_oauth.replacement",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });
    const graphPath = appendGraphEdge(cwd, {
      source: "auth.student_oauth.replacement",
      target: "auth.student_oauth.uid_is_tenant_scoped",
      relation: "replaces"
    });

    const result = await dispatch(["audit", "--changed-files", claimPath, graphPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("passes when deprecated_by points to an active replacement from an inactive claim", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/auth/student_oauth_replacement.md", {
      id: "auth.student_oauth.replacement",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["replacementResolver"],
      tags: ["replacement"]
    });
    const deprecatedPath = writeClaim(cwd, "claims/auth/student_oauth_old.md", {
      id: "auth.student_oauth.old",
      status: "deprecated",
      sourceFiles: ["src/old-auth.js"],
      relatedFiles: [],
      symbols: ["oldResolver"],
      tags: ["old-auth"],
      deprecatedBy: "auth.student_oauth.replacement"
    });

    const result = await dispatch(["audit", "--changed-files", deprecatedPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("fails when deprecated_by is missing or attached to an active stable claim", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_bad_deprecated_by.md", {
      id: "auth.student_oauth.bad_deprecated_by",
      status: "current",
      sourceFiles: ["src/bad-auth.js"],
      relatedFiles: [],
      symbols: ["badResolver"],
      tags: ["bad-auth"],
      deprecatedBy: "auth.student_oauth.missing"
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.deprecated_by_missing");
    expect(result.stdout).toContain("claim.deprecated_by_active_status");
  });

  test("ignores pre-existing unrelated deprecated_by problems", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/auth/student_oauth_bad_deprecated_by.md", {
      id: "auth.student_oauth.bad_deprecated_by",
      status: "current",
      sourceFiles: ["src/bad-auth.js"],
      relatedFiles: [],
      symbols: ["badResolver"],
      tags: ["bad-auth"],
      deprecatedBy: "auth.student_oauth.missing"
    });

    const result = await dispatch(["audit", "--changed-files", "README.md"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("fails when active conflicts have no review status", async () => {
    const cwd = copyFixture(mockApp);
    const graphPath = appendGraphEdge(cwd, {
      source: "auth.student_oauth.uid_is_tenant_scoped",
      target: "tenancy.current_tenant.required_for_student_auth",
      relation: "conflicts_with"
    });

    const result = await dispatch(["audit", "--changed-files", graphPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("graph.active_conflict_unreviewed");
  });

  test("ignores pre-existing unrelated active conflicts", async () => {
    const cwd = copyFixture(mockApp);
    appendGraphEdge(cwd, {
      source: "auth.student_oauth.uid_is_tenant_scoped",
      target: "tenancy.current_tenant.required_for_student_auth",
      relation: "conflicts_with"
    });
    const claimPath = writeClaim(cwd, "claims/billing/payment_provider.md", {
      id: "billing.payment.provider",
      system: "billing",
      status: "current",
      sourceFiles: ["src/payment.js"],
      relatedFiles: [],
      symbols: ["resolvePaymentProvider"],
      routes: ["/payments"],
      tags: ["billing", "payments"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("passes for unrelated changed claims", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/billing/payment_provider.md", {
      id: "billing.payment.provider",
      system: "billing",
      status: "current",
      sourceFiles: ["src/payment.js"],
      relatedFiles: [],
      symbols: ["resolvePaymentProvider"],
      routes: ["/payments"],
      tags: ["billing", "payments"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(0);
  });

  test("fails when source and memory changed but related active claims were not all reviewed", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(
      ["audit", "--changed-files", "src/auth.js", "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md"],
      { cwd }
    );

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("source.related_claims_not_reviewed");
    expect(result.stdout).toContain("tenancy.current_tenant.required_for_student_auth");
  });

  test("checks git diff files", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    writeClaim(cwd, "claims/billing/payment_provider.md", {
      id: "billing.payment.provider",
      system: "billing",
      status: "current",
      sourceFiles: ["src/payment.js"],
      relatedFiles: [],
      symbols: ["resolvePaymentProvider"],
      routes: ["/payments"],
      tags: ["billing", "payments"]
    });

    const result = await dispatch(["audit", "--git-diff", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.changedFiles).toContain("docs/agent-memory/claims/billing/payment_provider.md");
  });

  test("checks committed git diff files against an explicit base ref", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    writeClaim(cwd, "claims/auth/student_oauth_base_overlap.md", {
      id: "auth.student_oauth.base_overlap",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });
    commitAll(cwd, "Add overlapping memory");

    const result = await dispatch(["audit", "--git-diff", "--base", base], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.overlap_without_review");
  });
});

interface ClaimOptions {
  id: string;
  system?: string;
  status: string;
  sourceFiles: string[];
  relatedFiles: string[];
  symbols: string[];
  routes?: string[];
  tags: string[];
  deprecatedBy?: string;
}

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-audit-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function writeClaim(cwd: string, relativeMemoryPath: string, options: ClaimOptions): string {
  const relativePath = path.join("docs/agent-memory", relativeMemoryPath);
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, renderClaim(options));
  return relativePath.replaceAll(path.sep, "/");
}

function renderClaim(options: ClaimOptions): string {
  const system = options.system ?? options.id.split(".")[0];
  const routes = options.routes ?? [];
  const deprecatedBy = options.deprecatedBy ? `deprecated_by: ${options.deprecatedBy}\n` : "";

  return `---
id: ${options.id}
type: fact
system: ${system}
status: ${options.status}
confidence: high
severity: important
title: ${options.id}
claim: ${options.id} claim.
${renderYamlField("source_files", options.sourceFiles)}
${renderYamlField("related_files", options.relatedFiles)}
${renderYamlField("symbols", options.symbols)}
${renderYamlField("routes", routes)}
${renderYamlField("tags", options.tags)}
verification:
  - bun test
${deprecatedBy}---

# ${options.id}

## Claim

${options.id} claim.
`;
}

function renderYamlField(name: string, values: string[]): string {
  return values.length > 0 ? `${name}:\n${values.map((value) => `  - ${value}`).join("\n")}` : `${name}: []`;
}

function appendGraphEdge(cwd: string, edge: { source: string; target: string; relation: string }): string {
  const relativePath = "docs/agent-memory/graph/auth-tenancy.yaml";
  const absolutePath = path.join(cwd, relativePath);
  fs.appendFileSync(
    absolutePath,
    `
  - source: ${edge.source}
    target: ${edge.target}
    relation: ${edge.relation}
    reason: Audit test relation.
    strength: 100
    bidirectional: false
`
  );
  return relativePath;
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
