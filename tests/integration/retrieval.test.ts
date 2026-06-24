import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("retrieval commands", () => {
  test("query searches FTS and supports filters", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["query", "student oauth tenant", "--limit", "5"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Query Results");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(result.stdout).toContain("Score:");

    const filtered = await dispatch(["query", "tenant", "--system", "tenancy", "--json"], { cwd });
    const parsed = JSON.parse(filtered.stdout);

    expect(filtered.exitCode).toBe(0);
    expect(parsed.matches.some((match: { system: string }) => match.system === "tenancy")).toBe(true);
    expect(parsed.matches.every((match: { system: string }) => match.system === "tenancy")).toBe(true);
  });

  test("show returns one claim and related graph claims", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["show", "auth.student_oauth.uid_is_tenant_scoped", "--include-related"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Student OAuth UID is tenant scoped");
    expect(result.stdout).toContain("## Files");
    expect(result.stdout).toContain("## Related Claims");
    expect(result.stdout).toContain("tenancy.current_tenant.required_for_student_auth");
    expect(result.stdout).toContain("Relation: requires");

    const json = await dispatch(["show", "auth.student_oauth.uid_is_tenant_scoped", "--include-related", "--json"], { cwd });
    const parsed = JSON.parse(json.stdout);

    expect(parsed.claim.id).toBe("auth.student_oauth.uid_is_tenant_scoped");
    expect(parsed.related[0].claim.id).toBe("tenancy.current_tenant.required_for_student_auth");
  });

  test("system summarizes compiled claims, recipes, watched files, and relationships", async () => {
    const cwd = await compiledMockApp();
    const result = await dispatch(["system", "auth"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# System: auth");
    expect(result.stdout).toContain("Student OAuth identity resolution and tenant-aware auth behavior.");
    expect(result.stdout).toContain("fact/current: 1");
    expect(result.stdout).toContain("src/auth.js");
    expect(result.stdout).toContain("recipe.auth.modify_student_oauth");
    expect(result.stdout).toContain("requires/explicit");

    const json = await dispatch(["system", "auth", "--json"], { cwd });
    const parsed = JSON.parse(json.stdout);

    expect(parsed.index.watchedFiles).toContain("src/auth.js");
    expect(parsed.recipes[0].id).toBe("recipe.auth.modify_student_oauth");
  });

  test("retrieval commands report missing compiled database", async () => {
    const cwd = copyFixture(mockApp);
    let stderr = "";
    const exitCode = await runCli(
      ["query", "oauth"],
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

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-retrieval-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}
