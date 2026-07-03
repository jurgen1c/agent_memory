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
      expect(count(database, "recipes_fts")).toBe(1);

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
    expect(parsed.counts.plans).toBe(0);
    expect(parsed.counts.profiles).toBe(0);
    expect(parsed.databasePath).toBe(path.join(cwd, "tmp/custom-memory.sqlite"));
    expect(fs.existsSync(path.join(cwd, "tmp/custom-memory.sqlite"))).toBe(true);
  });

  test("compiles plan templates, profile traits, and workflow FTS rows", async () => {
    const cwd = copyFixture(mockApp);
    writeProfile(cwd, "docs/agent-memory/profiles/review/security_sensitive.yaml", {
      id: "profile_trait.review.security_sensitive",
      snippet: "Treat OAuth implementation as security sensitive and verify tenant boundaries."
    });
    writePlan(cwd, "docs/agent-memory/plans/auth/oauth_change.yaml", {
      id: "plan_template.auth.oauth_change",
      stageId: "inspect_current_contract",
      profileTrait: "profile_trait.review.security_sensitive"
    });

    const result = await dispatch(["compile", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);
    const database = new Database(path.join(cwd, ".agent-memory/memory.sqlite"), { readonly: true });

    try {
      expect(result.exitCode).toBe(0);
      expect(parsed.counts.plans).toBe(1);
      expect(parsed.counts.planStages).toBe(1);
      expect(parsed.counts.profiles).toBe(1);
      expect(parsed.counts.recipeFtsRows).toBe(1);
      expect(parsed.counts.planFtsRows).toBe(1);
      expect(parsed.counts.profileFtsRows).toBe(1);
      expect(count(database, "plan_templates")).toBe(1);
      expect(count(database, "plan_stages")).toBe(1);
      expect(count(database, "profile_traits")).toBe(1);

      const stage = database.query("SELECT plan_id, stage_id, title, sequence FROM plan_stages").get() as {
        plan_id: string;
        stage_id: string;
        title: string;
        sequence: number;
      };
      expect(stage).toEqual({
        plan_id: "plan_template.auth.oauth_change",
        stage_id: "inspect_current_contract",
        title: "Inspect current contract",
        sequence: 0
      });

      const planMatch = database.query("SELECT id FROM plan_templates_fts WHERE plan_templates_fts MATCH 'callback'").get() as { id: string };
      const profileMatch = database.query("SELECT id FROM profile_traits_fts WHERE profile_traits_fts MATCH 'security'").get() as { id: string };
      const recipeMatch = database.query("SELECT id FROM recipes_fts WHERE recipes_fts MATCH 'overlapping'").get() as { id: string };

      expect(planMatch.id).toBe("plan_template.auth.oauth_change");
      expect(profileMatch.id).toBe("profile_trait.review.security_sensitive");
      expect(recipeMatch.id).toBe("recipe.auth.modify_student_oauth");
    } finally {
      database.close();
    }
  });

  test("does not compile generated plan runs under .agent-memory", async () => {
    const cwd = copyFixture(mockApp);
    fs.mkdirSync(path.join(cwd, ".agent-memory/plans"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".agent-memory/plans/plan_run.20260702.local.yaml"),
      `id: plan_run.20260702.local
task: Local generated state
status: active
current_stage: inspect
stages:
  - id: inspect
    status: active
`
    );

    const result = await dispatch(["compile", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.counts.plans).toBe(0);
    expect(parsed.counts.planStages).toBe(0);
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

  test("cleans temporary sidecar files after successful replacement", async () => {
    const cwd = copyFixture(mockApp);
    const databaseDir = path.join(cwd, ".agent-memory");
    const originalRenameSync = fs.renameSync;

    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (typeof oldPath === "string" && oldPath.includes(".memory.sqlite.") && oldPath.endsWith(".tmp")) {
        for (const suffix of ["-journal", "-wal", "-shm"]) {
          fs.writeFileSync(`${oldPath}${suffix}`, "temporary sidecar");
        }
      }

      originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;

    try {
      await dispatch(["compile"], { cwd });
    } finally {
      fs.renameSync = originalRenameSync;
    }

    expect(fs.readdirSync(databaseDir).filter((entry) => entry.includes(".memory.sqlite.") && entry.includes(".tmp"))).toEqual([]);
  });

  test("cleans stale sidecar files from the original database path before replacement", async () => {
    const cwd = copyFixture(mockApp);
    const databasePath = path.join(cwd, ".agent-memory/memory.sqlite");
    await dispatch(["compile"], { cwd });

    for (const suffix of ["-journal", "-wal", "-shm"]) {
      fs.writeFileSync(`${databasePath}${suffix}`, "stale sidecar");
    }

    await dispatch(["compile"], { cwd });

    for (const suffix of ["-journal", "-wal", "-shm"]) {
      expect(fs.existsSync(`${databasePath}${suffix}`)).toBe(false);
    }
    expect(readCounts(databasePath).claims).toBe(2);
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
      claims_fts: count(database, "claims_fts"),
      recipes_fts: count(database, "recipes_fts"),
      plan_templates: count(database, "plan_templates"),
      plan_stages: count(database, "plan_stages"),
      plan_templates_fts: count(database, "plan_templates_fts"),
      profile_traits: count(database, "profile_traits"),
      profile_traits_fts: count(database, "profile_traits_fts")
    };
  } finally {
    database.close();
  }
}

function writePlan(
  cwd: string,
  relativePath: string,
  options: {
    id: string;
    stageId: string;
    profileTrait: string;
  }
): void {
  const planPath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    `id: ${options.id}
title: OAuth provider behavior change
system: auth
status: current
intent_triggers:
  - change student oauth provider
recipes:
  - recipe.auth.modify_student_oauth
stages:
  - id: ${options.stageId}
    title: Inspect current contract
    goal: Identify provider callback behavior and tenant boundaries.
    claim_refs:
      - auth.student_oauth.uid_is_tenant_scoped
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits:
      - ${options.profileTrait}
    source_files:
      - src/auth.js
    verification:
      - bun test
`
  );
}

function writeProfile(
  cwd: string,
  relativePath: string,
  options: {
    id: string;
    snippet: string;
  }
): void {
  const profilePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(
    profilePath,
    `id: ${options.id}
title: Security sensitive review
status: current
category: risk_lens
priority: high
applies_when:
  systems:
    - auth
snippet: ${JSON.stringify(options.snippet)}
`
  );
}
