import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("recipes command", () => {
  test("search finds recipes by trigger and returns diagnostics", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["recipes", "search", "fix student login", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matches[0].recipe.id).toBe("recipe.auth.modify_student_oauth");
    expect(parsed.matches[0].reasons.some((reason: { code: string }) => reason.code === "trigger_match")).toBe(true);

    const text = await dispatch(["recipes", "search", "fix student login"], { cwd });
    expect(text.stdout).toContain("# Recipe Search");
    expect(text.stdout).toContain("Matched because:");
    expect(text.stdout).toContain("Required claims:");
  });

  test("search finds recipes by changed file", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["recipes", "search", "unrelated", "--changed-files", "src/auth.js", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.matches[0].recipe.id).toBe("recipe.auth.modify_student_oauth");
    expect(parsed.matches[0].reasons).toContainEqual({
      code: "changed_file_match",
      detail: "src/auth.js"
    });
  });

  test("search hides stale recipes unless inactive recipes are included", async () => {
    const cwd = copyFixture(mockApp);
    const recipePath = path.join(cwd, "docs/agent-memory/recipes/auth/modify_student_oauth.yaml");
    fs.writeFileSync(recipePath, fs.readFileSync(recipePath, "utf8").replace("status: current", "status: stale"));
    const compile = await dispatch(["compile"], { cwd });
    expect(compile.exitCode).toBe(0);

    const hidden = await dispatch(["recipes", "search", "student oauth", "--json"], { cwd });
    const hiddenParsed = JSON.parse(hidden.stdout);
    const included = await dispatch(["recipes", "search", "student oauth", "--include-inactive", "--json"], { cwd });
    const includedParsed = JSON.parse(included.stdout);

    expect(hidden.exitCode).toBe(0);
    expect(hiddenParsed.matches).toEqual([]);
    expect(includedParsed.matches[0].recipe.id).toBe("recipe.auth.modify_student_oauth");
  });

  test("show prints recipe metadata, claims, steps, and verification", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["recipes", "show", "recipe.auth.modify_student_oauth"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Modify student OAuth safely");
    expect(result.stdout).toContain("## Required Claims");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(result.stdout).toContain("## Steps");
    expect(result.stdout).toContain("## Verification");

    const json = await dispatch(["recipes", "show", "recipe.auth.modify_student_oauth", "--json"], { cwd });
    const parsed = JSON.parse(json.stdout);
    expect(parsed.recipe.id).toBe("recipe.auth.modify_student_oauth");
    expect(parsed.recipe.verification).toContain("bun test");
  });

  test("list shows active recipes", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["recipes", "list"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Recipes");
    expect(result.stdout).toContain("recipe.auth.modify_student_oauth");
  });

  test("reports missing compiled database", async () => {
    const cwd = copyFixture(mockApp);
    let stderr = "";
    const exitCode = await runCli(
      ["recipes", "search", "oauth"],
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

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-recipes-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}
