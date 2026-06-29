import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");
const invalidFixture = path.join(repoRoot, "tests/fixtures/invalid_repo");

describe("compile command", () => {
  test("compiles canonical memory into repo-local SQLite", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(["compile"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory compiled.");
    expect(result.stdout).toContain("Claims: 2");
    expect(result.stdout).toContain("Explicit relations: 1");
    expect(result.stdout).toContain("FTS rows: 2");

    const databasePath = path.join(cwd, ".agent-memory/memory.sqlite");
    expect(fs.existsSync(databasePath)).toBe(true);

    const database = new Database(databasePath, { readonly: true });

    try {
      expect(count(database, "claims")).toBe(2);
      expect(count(database, "claim_relations")).toBeGreaterThanOrEqual(1);
      expect(count(database, "indexes")).toBe(1);
      expect(count(database, "recipes")).toBe(1);
      expect(count(database, "recipe_claims")).toBe(2);
      expect(count(database, "claims_fts")).toBe(2);

      const explicitRelation = database
        .query("SELECT source_claim_id, target_claim_id, relation, origin FROM claim_relations WHERE origin = 'explicit'")
        .get() as { source_claim_id: string; target_claim_id: string; relation: string; origin: string };

      expect(explicitRelation).toEqual({
        source_claim_id: "auth.student_oauth.uid_is_tenant_scoped",
        target_claim_id: "tenancy.current_tenant.required_for_student_auth",
        relation: "requires",
        origin: "explicit"
      });

      const ftsMatch = database.query("SELECT id FROM claims_fts WHERE claims_fts MATCH 'oauth' ORDER BY id").all() as Array<{ id: string }>;
      expect(ftsMatch.map((row) => row.id)).toContain("auth.student_oauth.uid_is_tenant_scoped");

      const metadata = database.query("SELECT value FROM compile_metadata WHERE key = 'schema_version'").get() as { value: string };
      expect(metadata.value).toBe("1");
    } finally {
      database.close();
    }
  });

  test("supports JSON output and custom database path", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(["compile", "--json", "--db", "tmp/custom-memory.sqlite"], { cwd });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts.claims).toBe(2);
    expect(parsed.databasePath).toBe(path.join(cwd, "tmp/custom-memory.sqlite"));
    expect(fs.existsSync(path.join(cwd, "tmp/custom-memory.sqlite"))).toBe(true);
  });

  test("rebuilds deterministically without duplicating rows", async () => {
    const cwd = copyFixture(mockApp);
    const databaseDir = path.join(cwd, ".agent-memory");
    await dispatch(["compile"], { cwd });
    const firstCounts = readCounts(path.join(cwd, ".agent-memory/memory.sqlite"));

    await dispatch(["compile"], { cwd });
    const secondCounts = readCounts(path.join(cwd, ".agent-memory/memory.sqlite"));

    expect(secondCounts).toEqual(firstCounts);
    expect(fs.readdirSync(databaseDir).filter((entry) => entry.includes(".memory.sqlite.") && (entry.endsWith(".tmp") || entry.endsWith(".bak")))).toEqual([]);
  });

  test("keeps the previous database when a rebuild is rejected", async () => {
    const cwd = copyFixture(mockApp);
    const databasePath = path.join(cwd, ".agent-memory/memory.sqlite");
    await dispatch(["compile"], { cwd });
    const firstCounts = readCounts(databasePath);
    fs.unlinkSync(path.join(cwd, "src/auth.js"));

    const exitCode = await runCli(
      ["compile"],
      {
        stdout: { write: () => true },
        stderr: { write: () => true }
      },
      { cwd }
    );

    expect(exitCode).toBe(4);
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(readCounts(databasePath)).toEqual(firstCounts);
  });

  test("cleans temporary databases when replacement fails", async () => {
    const cwd = copyFixture(mockApp);
    const blockedPath = path.join(cwd, "tmp/blocked.sqlite");
    fs.mkdirSync(blockedPath, { recursive: true });

    const exitCode = await runCli(
      ["compile", "--db", "tmp/blocked.sqlite"],
      {
        stdout: { write: () => true },
        stderr: { write: () => true }
      },
      { cwd }
    );

    expect(exitCode).toBe(1);
    expect(fs.readdirSync(path.join(cwd, "tmp")).filter((entry) => entry.includes(".blocked.sqlite.") && entry.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses to compile invalid memory", async () => {
    const cwd = copyFixture(invalidFixture);
    let stderr = "";
    const exitCode = await runCli(
      ["compile"],
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

    expect(exitCode).toBe(4);
    expect(stderr).toContain("Memory validation failed");
    expect(fs.existsSync(path.join(cwd, ".agent-memory/memory.sqlite"))).toBe(false);
  });
});

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-compile-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function count(database: Database, table: string): number {
  return (database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function readCounts(databasePath: string): Record<string, number> {
  const database = new Database(databasePath, { readonly: true });

  try {
    return {
      claims: count(database, "claims"),
      claim_relations: count(database, "claim_relations"),
      indexes: count(database, "indexes"),
      recipes: count(database, "recipes"),
      recipe_claims: count(database, "recipe_claims"),
      claims_fts: count(database, "claims_fts")
    };
  } finally {
    database.close();
  }
}
