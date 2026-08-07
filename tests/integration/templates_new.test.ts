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
    expect(content).toContain("status: needs_review");
    expect(content).toContain("confidence: low");
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

  test("rejects explicit source files excluded by claim source policy", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const config = fs.readFileSync(configPath, "utf8").replace(
      "claim_sources:\n  allow: []\n  deny: []",
      "claim_sources:\n  allow:\n    - src/**\n  deny:\n    - src/generated/**\n    - vendor/**"
    );
    fs.writeFileSync(configPath, config);

    await expect(
      dispatch(
        [
          "new",
          "claim",
          "--type=fact",
          "--system=generated",
          "--title=Generated client behavior",
          "--source-file=src/generated/client.ts"
        ],
        { cwd: repoRoot }
      )
    ).rejects.toThrow("denied by claim_sources.deny pattern src/generated/**");

    await expect(
      dispatch(
        [
          "new",
          "claim",
          "--type=fact",
          "--system=vendor",
          "--title=Vendor secret behavior",
          "--source-file=src/../vendor/secret.ts"
        ],
        { cwd: repoRoot }
      )
    ).rejects.toThrow("denied by claim_sources.deny pattern vendor/**");

    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/claims/generated/generated-client-behavior.md"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/claims/vendor/vendor-secret-behavior.md"))).toBe(false);
  });

  test("normalizes source paths and rejects paths outside the repository", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });

    await dispatch(
      [
        "new",
        "claim",
        "--type=fact",
        "--system=auth",
        "--title=Normalized source",
        "--source-file=src/../lib/auth.ts"
      ],
      { cwd: repoRoot }
    );

    const claimPath = path.join(repoRoot, "docs/agent-memory/claims/auth/normalized-source.md");
    expect(fs.readFileSync(claimPath, "utf8")).toContain("  - lib/auth.ts");

    for (const sourceFile of [path.join(os.tmpdir(), "outside.ts"), "../outside.ts", "C:\\outside\\source.ts"]) {
      await expect(
        dispatch(
          [
            "new",
            "claim",
            "--type=fact",
            "--system=invalid",
            `--title=Outside ${sourceFile}`,
            `--source-file=${sourceFile}`
          ],
          { cwd: repoRoot }
        )
      ).rejects.toThrow(/Path (?:must be repository-relative|escapes repository root)/);
    }

    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/claims/invalid"))).toBe(false);
  });

  test("accepts contained source-file symlinks and rejects escaping symlinks", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src/auth.ts"), "export const auth = true;\n");
    fs.symlinkSync("auth.ts", path.join(repoRoot, "src/auth-link.ts"), "file");

    await dispatch(
      [
        "new",
        "claim",
        "--type=fact",
        "--system=auth",
        "--title=Symlink source",
        "--source-file=src/auth-link.ts"
      ],
      { cwd: repoRoot }
    );

    const claimPath = path.join(repoRoot, "docs/agent-memory/claims/auth/symlink-source.md");
    expect(fs.readFileSync(claimPath, "utf8")).toContain("  - src/auth-link.ts");
    expect((await dispatch(["validate"], { cwd: repoRoot })).exitCode).toBe(0);

    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-outside-source-"));
    fs.writeFileSync(path.join(outsideRoot, "outside.ts"), "export const outside = true;\n");
    fs.symlinkSync(path.join(outsideRoot, "outside.ts"), path.join(repoRoot, "src/outside-link.ts"), "file");

    await expect(
      dispatch(
        [
          "new",
          "claim",
          "--type=fact",
          "--system=auth",
          "--title=Escaping symlink source",
          "--source-file=src/outside-link.ts"
        ],
        { cwd: repoRoot }
      )
    ).rejects.toThrow("escapes repository root through a symlink");
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

describe("new recipe command", () => {
  test("creates a first-class recipe draft with repeatable options", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });

    const result = await dispatch(
      [
        "new",
        "recipe",
        "--system=auth",
        "--title=Modify OAuth safely",
        "--trigger=change oauth",
        "--source-file=src/auth.js",
        "--step=Inspect current identity resolution.",
        "--step=Preserve tenant scoping.",
        "--verification-step=bun test"
      ],
      { cwd: repoRoot }
    );

    expect(result.stdout).toContain("Recipe draft created.");
    expect(result.stdout).toContain("Status: needs_review");
    expect(result.stdout).toContain("ID: recipe.auth.modify_oauth_safely");
    const recipePath = path.join(repoRoot, "docs/agent-memory/recipes/auth/modify-oauth-safely.yaml");
    const content = fs.readFileSync(recipePath, "utf8");
    expect(content).toContain("status: needs_review");
    expect(content).toContain('  - "change oauth"');
    expect(content).toContain("  - src/auth.js");
    expect(content).toContain('  - "Preserve tenant scoping."');

    const validation = await dispatch(["validate"], { cwd: repoRoot });
    expect(validation.exitCode).toBe(0);
  });

  test("avoids recipe ID and path collisions and validates options", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });
    await dispatch(["new", "recipe", "--system", "auth", "--title", "OAuth Review"], { cwd: repoRoot });
    const second = await dispatch(["new", "recipe", "--system", "auth", "--title", "OAuth Review"], { cwd: repoRoot });

    expect(second.stdout).toContain("ID: recipe.auth.oauth_review_2");
    expect(second.stdout).toContain("recipes/auth/oauth-review-2.yaml");
    expect(dispatch(["new", "recipe"], { cwd: repoRoot })).rejects.toThrow("Missing required new recipe options");
    expect(dispatch(["new", "recipe", "--system=auth", "--title=Bad", "--wat"], { cwd: repoRoot })).rejects.toThrow(
      "Unknown new recipe option: --wat"
    );
  });

  test("keeps the recipe ID stable when force overwrites the same generated recipe", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });
    await dispatch(
      ["new", "recipe", "--system=auth", "--title=OAuth Review", "--step=Inspect the existing OAuth flow."],
      { cwd: repoRoot }
    );

    const forced = await dispatch(
      ["new", "recipe", "--system=auth", "--title=OAuth Review", "--step=Inspect tenant-scoped OAuth.", "--force"],
      { cwd: repoRoot }
    );
    const recipeDirectory = path.join(repoRoot, "docs/agent-memory/recipes/auth");
    const recipeFiles = fs.readdirSync(recipeDirectory).filter((file) => file.endsWith(".yaml"));
    const content = fs.readFileSync(path.join(recipeDirectory, "oauth-review.yaml"), "utf8");

    expect(forced.stdout).toContain("ID: recipe.auth.oauth_review");
    expect(forced.stdout).not.toContain("recipe.auth.oauth_review_2");
    expect(recipeFiles).toEqual(["oauth-review.yaml"]);
    expect(content).toContain('  - "Inspect tenant-scoped OAuth."');
    expect(content).not.toContain("Inspect the existing OAuth flow.");
  });

  test("creates recipe drafts under an absolute external memory root", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-external-recipes-"));
    updateMemoryRoot(repoRoot, externalRoot);

    const result = await dispatch(["new", "recipe", "--system=auth", "--title=External OAuth Review"], {
      cwd: repoRoot
    });
    const expectedPath = path.join(externalRoot, "recipes/auth/external-oauth-review.yaml");
    const incorrectPath = path.join(repoRoot, expectedPath);

    expect(result.stdout).toContain(`Path: ${expectedPath}`);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(incorrectPath)).toBe(false);
  });

  test("creates the first recipe under missing local and external memory roots", async () => {
    const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-missing-recipe-root-"));

    for (const configuredRoot of ["custom/memory", path.join(externalParent, "external-memory")]) {
      const repoRoot = makeGitRepo();
      await dispatch(["init", "--yes"], { cwd: repoRoot });
      updateMemoryRoot(repoRoot, configuredRoot);
      const memoryRoot = path.isAbsolute(configuredRoot) ? configuredRoot : path.join(repoRoot, configuredRoot);

      const result = await dispatch(["new", "recipe", "--system=auth", "--title=Bootstrap Recipe"], {
        cwd: repoRoot
      });

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(memoryRoot, "recipes/auth/bootstrap-recipe.yaml"))).toBe(true);
    }
  });

  test("rejects recipe output paths that escape the memory root through symlinks", async () => {
    for (const symlinkLocation of ["recipes", "system", "file"] as const) {
      const repoRoot = makeGitRepo();
      await dispatch(["init", "--yes"], { cwd: repoRoot });
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-outside-recipes-"));
      const recipesRoot = path.join(repoRoot, "docs/agent-memory/recipes");
      const systemRoot = path.join(recipesRoot, "auth");
      const outsideFile = path.join(outsideRoot, "symlink-escape.yaml");

      if (symlinkLocation === "recipes") {
        fs.rmSync(recipesRoot, { recursive: true });
        fs.symlinkSync(outsideRoot, recipesRoot, "dir");
      } else if (symlinkLocation === "system") {
        fs.symlinkSync(outsideRoot, systemRoot, "dir");
      } else {
        fs.mkdirSync(systemRoot, { recursive: true });
        fs.symlinkSync(outsideFile, path.join(systemRoot, "symlink-escape.yaml"), "file");
      }

      await expect(
        dispatch(["new", "recipe", "--system=auth", "--title=Symlink Escape"], { cwd: repoRoot })
      ).rejects.toThrow("Recipe output path must stay inside the configured memory root");

      expect(fs.existsSync(outsideFile)).toBe(false);
    }
  });

  test("normalizes recipe source paths and rejects paths outside the repository", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });

    await dispatch(
      ["new", "recipe", "--system=auth", "--title=Normalized Recipe Source", "--source-file=src/../lib/auth.ts"],
      { cwd: repoRoot }
    );
    const recipePath = path.join(repoRoot, "docs/agent-memory/recipes/auth/normalized-recipe-source.yaml");

    expect(fs.readFileSync(recipePath, "utf8")).toContain("  - lib/auth.ts");

    for (const sourceFile of [path.join(os.tmpdir(), "outside.ts"), "../outside.ts", "C:\\outside\\source.ts"]) {
      await expect(
        dispatch(
          ["new", "recipe", "--system=invalid", `--title=Outside ${sourceFile}`, `--source-file=${sourceFile}`],
          { cwd: repoRoot }
        )
      ).rejects.toThrow(/Path (?:must be repository-relative|escapes repository root)/);
    }

    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/recipes/invalid"))).toBe(false);
  });

  test("accepts contained symlinks as recipe source files", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes"], { cwd: repoRoot });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src/auth.ts"), "export const auth = true;\n");
    fs.symlinkSync("auth.ts", path.join(repoRoot, "src/auth-link.ts"), "file");

    await dispatch(
      ["new", "recipe", "--system=auth", "--title=Symlink Recipe Source", "--source-file=src/auth-link.ts"],
      { cwd: repoRoot }
    );

    const recipePath = path.join(repoRoot, "docs/agent-memory/recipes/auth/symlink-recipe-source.yaml");
    expect(fs.readFileSync(recipePath, "utf8")).toContain("  - src/auth-link.ts");
    expect((await dispatch(["validate"], { cwd: repoRoot })).exitCode).toBe(0);
  });
});

function updateMemoryRoot(repoRoot: string, memoryRoot: string): void {
  const configPath = path.join(repoRoot, "agent-memory.config.yaml");
  const config = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, config.replace(/^memory_root:.*$/m, `memory_root: ${JSON.stringify(memoryRoot)}`));
}

function makeGitRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-phase3-"));
  const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
  expect(init.status).toBe(0);
  return repoRoot;
}
