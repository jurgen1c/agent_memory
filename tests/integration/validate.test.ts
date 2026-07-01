import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const validFixture = path.join(repoRoot, "tests/fixtures/valid_repo");
const invalidFixture = path.join(repoRoot, "tests/fixtures/invalid_repo");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("validate command", () => {
  test("passes a valid fixture repository", async () => {
    const result = await dispatch(["validate"], { cwd: copyFixture(validFixture) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("validation passed");
    expect(result.stdout).toContain("Claims: 1");
  });

  test("passes the mock app repository", async () => {
    const result = await dispatch(["validate"], { cwd: copyFixture(mockApp) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claims: 2");
    expect(result.stdout).toContain("Graphs: 1");
    expect(result.stdout).toContain("Recipes: 1");
  });

  test("fails invalid fixtures with actionable messages", async () => {
    const result = await dispatch(["validate"], { cwd: copyFixture(invalidFixture) });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("validation failed");
    expect(result.stdout).toContain("claim.source_files.missing");
    expect(result.stdout).toContain("graph.edge.missing_claim");
    expect(result.stdout).toContain("recipe.required_claim.missing");
    expect(result.stdout).toContain("claim.id.duplicate");
    expect(result.stdout).toContain("claim.atomic.numbered_headings");
  });

  test("supports JSON output", async () => {
    const result = await dispatch(["validate", "--json"], { cwd: copyFixture(invalidFixture) });

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.some((issue: { code: string }) => issue.code === "graph.edge.missing_claim")).toBe(true);
  });

  test("scopes changed-file validation to changed canonical memory files", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "docs/agent-memory/claims/auth/broken_unrelated.md", {
      id: "auth.broken_unrelated",
      title: "Broken unrelated claim",
      sourceFiles: ["src/missing.js"]
    });

    const unrelated = await dispatch(["validate", "--changed-files", "README.md", "--json"], { cwd });
    expect(unrelated.exitCode).toBe(0);

    const unrelatedParsed = JSON.parse(unrelated.stdout);
    expect(unrelatedParsed.valid).toBe(true);
    expect(unrelatedParsed.counts.claims).toBe(0);

    const changed = await dispatch(["validate", "--changed-files", "docs/agent-memory/claims/auth/broken_unrelated.md"], { cwd });
    expect(changed.exitCode).toBe(2);
    expect(changed.stdout).toContain("claim.source_files.missing");
  });

  test("checks changed graphs against unchanged claim references", async () => {
    const cwd = copyFixture(mockApp);
    const graphPath = path.join(cwd, "docs/agent-memory/graph/auth-tenancy.yaml");
    fs.appendFileSync(
      graphPath,
      [
        "",
        "  - source: auth.student_oauth.uid_is_tenant_scoped",
        "    target: auth.missing_claim",
        "    relation: requires",
        "    reason: Missing target proves scoped graph validation.",
        "    strength: 95",
        "    bidirectional: false",
        ""
      ].join("\n")
    );

    const result = await dispatch(["validate", "--changed-files", "docs/agent-memory/graph/auth-tenancy.yaml"], { cwd });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("graph.edge.missing_claim");
    expect(result.stdout).toContain("auth.missing_claim");
  });

  test("does not check unchanged claim source paths when loading scoped references", async () => {
    const cwd = copyFixture(mockApp);
    const missingReference = path.join(cwd, "src/reference-missing.js");
    writeClaim(cwd, "docs/agent-memory/claims/auth/unchanged_reference_only.md", {
      id: "auth.unchanged_reference_only",
      title: "Unchanged reference only",
      sourceFiles: ["src/reference-missing.js"]
    });

    const originalExistsSync = fs.existsSync;
    let sourcePathChecks = 0;

    fs.existsSync = ((target: fs.PathLike) => {
      if (typeof target === "string" && target === missingReference) {
        sourcePathChecks += 1;
      }

      return originalExistsSync(target);
    }) as typeof fs.existsSync;

    try {
      const result = await dispatch(["validate", "--changed-files", "docs/agent-memory/graph/auth-tenancy.yaml"], { cwd });

      expect(result.exitCode).toBe(0);
      expect(sourcePathChecks).toBe(0);
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });

  test("detects duplicate titles for changed claims against unchanged claims", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "docs/agent-memory/claims/auth/student_oauth_title_duplicate.md", {
      id: "auth.student_oauth.title_duplicate",
      title: "Student OAuth UID is tenant scoped"
    });

    const result = await dispatch(["validate", "--changed-files", "docs/agent-memory/claims/auth/student_oauth_title_duplicate.md"], { cwd });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("claim.title.duplicate");
  });

  test("strict mode enforces claim file paths", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "docs/agent-memory/claims/auth/wrong_path.md", {
      id: "auth.strict_path.required",
      title: "Strict path claim"
    });

    const defaultResult = await dispatch(["validate", "--changed-files", "docs/agent-memory/claims/auth/wrong_path.md"], { cwd });
    expect(defaultResult.exitCode).toBe(0);

    const strictResult = await dispatch(["validate", "--strict", "--changed-files", "docs/agent-memory/claims/auth/wrong_path.md"], { cwd });
    expect(strictResult.exitCode).toBe(2);
    expect(strictResult.stdout).toContain("claim.file_path");
  });

  test("rejects claim file references that escape the repository", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "docs/agent-memory/claims/auth/outside_reference.md", {
      id: "auth.outside_reference",
      title: "Outside reference claim",
      sourceFiles: ["../outside.js"],
      relatedFiles: ["../../outside-related.js"]
    });

    const result = await dispatch(["validate", "--changed-files", "docs/agent-memory/claims/auth/outside_reference.md"], { cwd });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("claim.source_files.outside_repo");
    expect(result.stdout).toContain("claim.related_files.outside_repo");
  });

  test("rejects claim file references when realpath checks fail", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = "docs/agent-memory/claims/auth/realpath_failure.md";
    const referencedPath = path.join(cwd, "src/auth.js");
    writeClaim(cwd, claimPath, {
      id: "auth.realpath_failure",
      title: "Realpath failure claim",
      sourceFiles: ["src/auth.js"]
    });

    const originalRealpathSync = fs.realpathSync;

    fs.realpathSync = ((target: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding | null } | null) => {
      if (target === referencedPath) {
        throw new Error("realpath unavailable");
      }

      return originalRealpathSync(target, options as never);
    }) as typeof fs.realpathSync;

    try {
      const result = await dispatch(["validate", "--changed-files", claimPath], { cwd });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("claim.source_files.outside_repo");
      expect(result.stdout).toContain("Referenced path escapes repository root or cannot be validated safely: src/auth.js");
    } finally {
      fs.realpathSync = originalRealpathSync;
    }
  });

  test("reports missing related files with field-specific wording", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "docs/agent-memory/claims/auth/missing_related_reference.md", {
      id: "auth.missing_related_reference",
      title: "Missing related reference claim",
      relatedFiles: ["src/missing-related.js"]
    });

    const result = await dispatch(["validate", "--changed-files", "docs/agent-memory/claims/auth/missing_related_reference.md", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { errors: Array<{ code: string; message: string }> };
    const error = parsed.errors.find((candidate) => candidate.code === "claim.related_files.missing");

    expect(result.exitCode).toBe(2);
    expect(error?.message).toBe("Referenced related file does not exist: src/missing-related.js");
  });

  test("rejects index watched files that escape the repository", async () => {
    const cwd = copyFixture(mockApp);
    const indexPath = path.join(cwd, "docs/agent-memory/indexes/auth.yaml");
    fs.writeFileSync(indexPath, fs.readFileSync(indexPath, "utf8").replace("  - src/tenant.js\n", "  - src/tenant.js\n  - ../outside/**/*.js\n"));

    const result = await dispatch(["validate", "--changed-files", "docs/agent-memory/indexes/auth.yaml"], { cwd });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("index.watched_files.outside_repo");
  });
});

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-validate-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function writeClaim(
  cwd: string,
  relativePath: string,
  overrides: {
    id: string;
    title: string;
    sourceFiles?: string[];
    relatedFiles?: string[];
  }
): void {
  const claimPath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  fs.writeFileSync(
    claimPath,
    `---
id: ${overrides.id}
type: fact
system: auth
status: current
confidence: high
severity: important

title: ${overrides.title}

claim: Test claim for validation behavior.

source_files:
${(overrides.sourceFiles ?? ["src/auth.js"]).map((sourceFile) => `  - ${sourceFile}`).join("\n")}

related_files:
${(overrides.relatedFiles ?? ["src/tenant.js"]).map((relatedFile) => `  - ${relatedFile}`).join("\n")}

symbols:
  - resolveStudentOAuthIdentity

routes: []

tags:
  - auth

verification:
  - bun test

last_verified_commit: null
---

# ${overrides.title}

## Claim

Test claim for validation behavior.
`
  );
}
