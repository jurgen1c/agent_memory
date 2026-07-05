import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("context command", () => {
  test("builds task context with matched claims, related claims, recipes, files, and verification", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["context", "--task", "fix student oauth in ios webview", "--depth", "1"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Agent Memory Context");
    expect(result.stdout).toContain("Task: fix student oauth in ios webview");
    expect(result.stdout).toContain("## Matched Claims");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(result.stdout).toContain("## Related Claims");
    expect(result.stdout).toContain("tenancy.current_tenant.required_for_student_auth");
    expect(result.stdout).toContain("## Matched Recipes");
    expect(result.stdout).toContain("recipe.auth.modify_student_oauth");
    expect(result.stdout).toContain("Matched because:");
    expect(result.stdout).toContain("## Verification");
    expect(result.stdout).toContain("bun test");
  });

  test("handles punctuation in task text without FTS syntax errors", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["context", "--task", "fix ios-webview oauth", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matchedClaims.some((claim: { id: string }) => claim.id === "auth.student_oauth.uid_is_tenant_scoped")).toBe(true);
  });

  test("builds changed-file context using claim files and watched indexes", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["context", "--changed-files", "src/auth.js", "--budget", "small"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("## Changed Files");
    expect(result.stdout).toContain("src/auth.js");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(result.stdout).toContain("recipe.auth.modify_student_oauth");
    expect(result.stdout).toContain("## Relevant Files");
  });

  test("normalizes changed-file paths to repo-relative form", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["context", "--changed-files", "./src/auth.js", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.changedFiles).toEqual(["src/auth.js"]);
    expect(parsed.relevantFiles).toContain("src/auth.js");
    expect(parsed.relevantFiles).not.toContain("./src/auth.js");
  });

  test("normalizes absolute changed-file paths to repo-relative form", async () => {
    const cwd = await compiledMockApp();
    const absolutePath = path.join(cwd, "src/auth.js");
    const result = await dispatch(["context", "--changed-files", absolutePath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.changedFiles).toEqual(["src/auth.js"]);
    expect(parsed.matchedClaims.some((claim: { id: string }) => claim.id === "auth.student_oauth.uid_is_tenant_scoped")).toBe(true);
  });

  test("builds git-diff context", async () => {
    const cwd = await compiledMockApp();
    initGitHistory(cwd);
    fs.appendFileSync(path.join(cwd, "src/auth.js"), "\n// changed by context test\n");

    const result = await dispatch(["context", "--git-diff"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src/auth.js");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
  });

  test("supports JSON output", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["context", "--task", "student oauth tenant", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matchedClaims.some((claim: { id: string }) => claim.id === "auth.student_oauth.uid_is_tenant_scoped")).toBe(true);
    expect(parsed.relatedClaims.some((related: { claim: { id: string } }) => related.claim.id === "tenancy.current_tenant.required_for_student_auth")).toBe(true);
    expect(parsed.matchedRecipes[0].id).toBe("recipe.auth.modify_student_oauth");
    expect(parsed.matchedRecipes[0].reasons.length).toBeGreaterThan(0);
    expect(parsed.verificationSteps).toContain("bun test");
  });

  test("expands explicit recipe context with required claims", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["context", "--recipe", "recipe.auth.modify_student_oauth", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matchedRecipes[0].id).toBe("recipe.auth.modify_student_oauth");
    expect(parsed.matchedRecipes[0].reasons).toContainEqual({
      code: "explicit_recipe",
      detail: "recipe.auth.modify_student_oauth"
    });
    expect(parsed.matchedClaims.map((claim: { id: string }) => claim.id)).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(parsed.matchedClaims.map((claim: { id: string }) => claim.id)).toContain("tenancy.current_tenant.required_for_student_auth");
    expect(parsed.verificationSteps).toContain("bun test");
  });

  test("caps required claims expanded from explicit recipes", async () => {
    const cwd = copyFixture(mockApp);
    const requiredClaimIds = [
      "auth.student_oauth.uid_is_tenant_scoped",
      "tenancy.current_tenant.required_for_student_auth",
      "auth.recipe_limit.extra_one",
      "auth.recipe_limit.extra_two",
      "auth.recipe_limit.extra_three"
    ];

    writeClaim(cwd, {
      id: "auth.recipe_limit.extra_one",
      title: "Extra recipe limit claim one",
      sourceFile: "src/auth.js"
    });
    writeClaim(cwd, {
      id: "auth.recipe_limit.extra_two",
      title: "Extra recipe limit claim two",
      sourceFile: "src/tenant.js"
    });
    writeClaim(cwd, {
      id: "auth.recipe_limit.extra_three",
      title: "Extra recipe limit claim three",
      sourceFile: "src/auth.js"
    });
    writeRecipe(cwd, requiredClaimIds);

    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const result = await dispatch(["context", "--recipe", "recipe.auth.recipe_limit", "--budget", "small", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matchedRecipes[0].id).toBe("recipe.auth.recipe_limit");
    expect(parsed.matchedClaims.map((claim: { id: string }) => claim.id)).toEqual(requiredClaimIds.slice(0, 3));
  });

  test("uses configured recipe match limit", async () => {
    const cwd = copyFixture(mockApp);
    const configPath = path.join(cwd, "agent-memory.config.yaml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace("include_inferred_edges_by_default: false", "include_inferred_edges_by_default: false\n  recipe_match_limit: 1")
    );
    writeSimpleRecipe(cwd, "recipe.auth.recipe_limit_extra", "recipe_limit_extra.yaml");

    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const result = await dispatch(["context", "--task", "student oauth tenant", "--budget", "full", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matchedRecipes).toHaveLength(1);
  });

  test("honors configured recipe diagnostics setting", async () => {
    const cwd = await compiledMockAppWithConfig((config) =>
      config.replace("include_inferred_edges_by_default: false", "include_inferred_edges_by_default: false\n  include_recipe_diagnostics: false")
    );

    const result = await dispatch(["context", "--task", "student oauth tenant", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matchedRecipes[0].id).toBe("recipe.auth.modify_student_oauth");
    expect(parsed.matchedRecipes[0].reasons).toEqual([]);
  });

  test("uses configured context defaults when command flags are omitted", async () => {
    const cwd = await compiledMockAppWithConfig((config) =>
      config.replace("default_budget: medium", "default_budget: small").replace("default_depth: 1", "default_depth: 0")
    );

    const result = await dispatch(["context", "--task", "student oauth", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.budget).toBe("small");
    expect(parsed.depth).toBe(0);
    expect(parsed.relatedClaims).toEqual([]);
  });

  test("uses configured inferred-edge default when command flag is omitted", async () => {
    const cwd = await compiledMockAppWithConfig((config) =>
      config.replace("include_inferred_edges_by_default: false", "include_inferred_edges_by_default: true")
    );

    const result = await dispatch(["context", "--task", "student oauth tenant", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.relatedClaims.some((related: { relation: { origin: string } }) => related.relation.origin === "inferred")).toBe(true);
  });

  test("lets context command flags override configured defaults", async () => {
    const cwd = await compiledMockAppWithConfig((config) =>
      config
        .replace("default_budget: medium", "default_budget: small")
        .replace("default_depth: 1", "default_depth: 0")
        .replace("include_inferred_edges_by_default: false", "include_inferred_edges_by_default: true")
    );

    const result = await dispatch(
      ["context", "--task", "student oauth tenant", "--budget", "full", "--depth", "1", "--no-include-inferred", "--json"],
      { cwd }
    );
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.budget).toBe("full");
    expect(parsed.depth).toBe(1);
    expect(parsed.relatedClaims.length).toBeGreaterThan(0);
    expect(parsed.relatedClaims.some((related: { relation: { origin: string } }) => related.relation.origin === "inferred")).toBe(false);
  });

  test("surfaces directly matched stale claims with warnings", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    fs.writeFileSync(claimPath, fs.readFileSync(claimPath, "utf8").replace("status: current", "status: stale"));

    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const result = await dispatch(["context", "--task", "student oauth", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(
      parsed.matchedClaims.some(
        (claim: { id: string; status: string }) => claim.id === "auth.student_oauth.uid_is_tenant_scoped" && claim.status === "stale"
      )
    ).toBe(true);
    expect(parsed.warnings).toContain("auth.student_oauth.uid_is_tenant_scoped has status stale.");
  });

  test("reports missing compiled database", async () => {
    const cwd = copyFixture(mockApp);
    let stderr = "";
    const exitCode = await runCli(
      ["context", "--task", "student oauth"],
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
    expect(stderr).toContain("agent-memory compile");
  });
});

async function compiledMockApp(): Promise<string> {
  const cwd = copyFixture(mockApp);
  const compile = await dispatch(["compile"], { cwd });
  expect(compile.exitCode).toBe(0);
  return cwd;
}

async function compiledMockAppWithConfig(updateConfig: (config: string) => string): Promise<string> {
  const cwd = copyFixture(mockApp);
  const configPath = path.join(cwd, "agent-memory.config.yaml");
  fs.writeFileSync(configPath, updateConfig(fs.readFileSync(configPath, "utf8")));
  const compile = await dispatch(["compile"], { cwd });
  expect(compile.exitCode).toBe(0);
  return cwd;
}

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-context-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function initGitHistory(cwd: string): void {
  expect(spawnSync("git", ["init"], { cwd, encoding: "utf8" }).status).toBe(0);
  expect(spawnSync("git", ["add", "."], { cwd, encoding: "utf8" }).status).toBe(0);
  expect(
    spawnSync("git", ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", "Initial"], {
      cwd,
      encoding: "utf8"
    }).status
  ).toBe(0);
}

function writeClaim(cwd: string, claim: { id: string; title: string; sourceFile: string }): void {
  const idParts = claim.id.split(".");
  const fileName = `${idParts[idParts.length - 1]}.md`;
  const targetPath = path.join(cwd, "docs/agent-memory/claims/auth", fileName);
  fs.writeFileSync(
    targetPath,
    `---
id: ${claim.id}
type: fact
system: auth
status: current
confidence: high
severity: important

title: ${claim.title}

claim: ${claim.title} is required for recipe limit regression coverage.

source_files:
  - ${claim.sourceFile}

related_files: []
symbols: []
routes: []
tags:
  - auth
verification:
  - bun test

last_verified_commit: null
---

# ${claim.title}
`
  );
}

function writeRecipe(cwd: string, requiredClaimIds: string[]): void {
  const targetPath = path.join(cwd, "docs/agent-memory/recipes/auth/recipe_limit.yaml");
  fs.writeFileSync(
    targetPath,
    `id: recipe.auth.recipe_limit
title: Recipe limit regression
system: auth
status: current

required_claims:
${requiredClaimIds.map((id) => `  - ${id}`).join("\n")}

intent_triggers:
  - recipe limit regression

relevant_files:
  - src/auth.js

steps:
  - Keep required claims within the selected context budget.

verification:
  - bun test
`
  );
}

function writeSimpleRecipe(cwd: string, id: string, fileName: string): void {
  const targetPath = path.join(cwd, "docs/agent-memory/recipes/auth", fileName);
  fs.writeFileSync(
    targetPath,
    `id: ${id}
title: Student OAuth tenant recipe
system: auth
status: current

required_claims:
  - auth.student_oauth.uid_is_tenant_scoped

intent_triggers:
  - student oauth tenant

relevant_files:
  - src/auth.js

steps:
  - Review tenant-scoped OAuth behavior.

verification:
  - bun test
`
  );
}
