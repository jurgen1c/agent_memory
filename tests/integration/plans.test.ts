import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("plans command", () => {
  test("lists, shows, and suggests plan templates", async () => {
    const cwd = await compiledMockAppWithPlan();

    const list = await dispatch(["plans", "templates", "list"], { cwd });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("plan_template.auth.oauth_change");

    const show = await dispatch(["plans", "templates", "show", "plan_template.auth.oauth_change"], { cwd });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("# OAuth provider behavior change");
    expect(show.stdout).toContain("inspect");

    const suggest = await dispatch(["plans", "suggest", "--task", "change student oauth provider", "--json"], { cwd });
    const parsed = JSON.parse(suggest.stdout);
    expect(suggest.exitCode).toBe(0);
    expect(parsed.matches[0].template.id).toBe("plan_template.auth.oauth_change");
    expect(parsed.matches[0].reasons[0].code).toBe("template_fts");
    expect(fs.existsSync(path.join(cwd, ".agent-memory/plans"))).toBe(false);
  });

  test("creates a plan run and builds context for the current stage", async () => {
    const cwd = await compiledMockAppWithPlan();
    const created = await dispatch(
      ["plans", "new", "--template", "plan_template.auth.oauth_change", "--task", "change student oauth provider", "--json"],
      { cwd }
    );
    const parsed = JSON.parse(created.stdout);

    expect(created.exitCode).toBe(0);
    expect(parsed.run.id).toMatch(/^plan_run\.\d{8}\.oauth_provider_behavior_change\.[a-f0-9]{8}$/);
    expect(parsed.run.currentStage).toBe("inspect");
    expect(fs.existsSync(parsed.path)).toBe(true);

    const next = await dispatch(["plans", "next", parsed.run.id], { cwd });
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain(`Context: bin/memory context --plan ${parsed.run.id} --stage inspect`);

    const context = await dispatch(["context", "--plan", parsed.run.id, "--stage", "inspect", "--json"], { cwd });
    const contextJson = JSON.parse(context.stdout);
    expect(context.exitCode).toBe(0);
    expect(contextJson.planStage.id).toBe("inspect");
    expect(contextJson.changedFiles).toContain("src/auth.js");
    expect(contextJson.matchedClaims.map((claim: { id: string }) => claim.id)).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(contextJson.matchedRecipes[0].id).toBe("recipe.auth.modify_student_oauth");
    expect(contextJson.verificationSteps).toContain("bun test");
  });

  test("requires stage evidence, advances stages, and deletes finished runs by default", async () => {
    const cwd = await compiledMockAppWithPlan();
    const created = await dispatch(
      ["plans", "new", "--template", "plan_template.auth.oauth_change", "--task", "change student oauth provider", "--json"],
      { cwd }
    );
    const run = JSON.parse(created.stdout).run;

    let stderr = "";
    const rejected = await runCli(
      ["plans", "complete-stage", run.id, "--stage", "inspect", "--evidence", ""],
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
    expect(rejected).toBe(1);
    expect(stderr).toContain("complete-stage requires non-empty --evidence");

    const completedInspect = await dispatch(["plans", "complete-stage", run.id, "--stage", "inspect", "--evidence", "Reviewed callback contract", "--json"], {
      cwd
    });
    const afterInspect = JSON.parse(completedInspect.stdout);
    expect(afterInspect.run.currentStage).toBe("implement");
    expect(afterInspect.run.stages.find((stage: { id: string }) => stage.id === "inspect").status).toBe("complete");
    expect(afterInspect.run.stages.find((stage: { id: string }) => stage.id === "implement").status).toBe("active");

    await dispatch(["plans", "complete-stage", run.id, "--stage", "implement", "--evidence", "Implemented and tested"], { cwd });
    const finished = await dispatch(["plans", "finish", run.id, "--confirm-unresolved", "--json"], { cwd });
    const finishJson = JSON.parse(finished.stdout);
    expect(finished.exitCode).toBe(0);
    expect(finishJson.status).toBe("deleted");
    expect(fs.existsSync(finishJson.path)).toBe(false);
  });

  test("archives, prunes, and promotes completed runs intentionally", async () => {
    const cwd = await compiledMockAppWithPlan();
    const created = await dispatch(
      ["plans", "new", "--template", "plan_template.auth.oauth_change", "--task", "change student oauth provider", "--json"],
      { cwd }
    );
    const run = JSON.parse(created.stdout).run;
    await dispatch(["plans", "complete-stage", run.id, "--stage", "inspect", "--evidence", "Reviewed"], { cwd });
    await dispatch(["plans", "complete-stage", run.id, "--stage", "implement", "--evidence", "Verified"], { cwd });

    const promoted = await dispatch(["plans", "promote", run.id, "--to-template", "--title", "Reusable OAuth plan", "--system", "auth", "--json"], { cwd });
    const promotedJson = JSON.parse(promoted.stdout);
    expect(promoted.exitCode).toBe(0);
    expect(promotedJson.templateId).toBe("plan_template.auth.reusable_oauth_plan");
    expect(fs.readFileSync(promotedJson.path, "utf8")).toContain("status: proposed");

    const archived = await dispatch(["plans", "finish", run.id, "--archive", "--confirm-unresolved", "--json"], { cwd });
    const archivedJson = JSON.parse(archived.stdout);
    expect(archivedJson.status).toBe("archived");
    expect(fs.existsSync(archivedJson.archivePath)).toBe(true);

    const prune = await dispatch(["plans", "prune", "--completed", "--dry-run", "--json"], { cwd });
    const pruneJson = JSON.parse(prune.stdout);
    expect(prune.exitCode).toBe(0);
    expect(pruneJson.paths).toEqual([archivedJson.archivePath]);
  });

  test("context reports missing plan stages", async () => {
    const cwd = await compiledMockAppWithPlan();
    const created = await dispatch(["plans", "new", "--template", "plan_template.auth.oauth_change", "--task", "change student oauth provider", "--json"], {
      cwd
    });
    const run = JSON.parse(created.stdout).run;
    let stderr = "";
    const exitCode = await runCli(
      ["context", "--plan", run.id, "--stage", "missing"],
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
    expect(stderr).toContain("Plan stage not found: missing");
  });
});

async function compiledMockAppWithPlan(): Promise<string> {
  const cwd = copyFixture(mockApp);
  writePlan(cwd);
  const compile = await dispatch(["compile"], { cwd });
  expect(compile.exitCode).toBe(0);
  return cwd;
}

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-plans-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function writePlan(cwd: string): void {
  const planPath = path.join(cwd, "docs/agent-memory/plans/auth/oauth_change.yaml");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    `id: plan_template.auth.oauth_change
title: OAuth provider behavior change
system: auth
status: current
intent_triggers:
  - change student oauth provider
recipes:
  - recipe.auth.modify_student_oauth
stages:
  - id: inspect
    title: Inspect current contract
    goal: Identify provider callback behavior and tenant boundaries.
    claim_refs:
      - auth.student_oauth.uid_is_tenant_scoped
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits: []
    source_files:
      - src/auth.js
    verification:
      - bun test
    done_when:
      - Current auth contract is understood.
    memory_updates:
      - Update claims if OAuth tenant behavior changes.
  - id: implement
    title: Implement provider change
    goal: Change OAuth provider behavior while preserving tenant boundaries.
    claim_refs:
      - tenancy.current_tenant.required_for_student_auth
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits: []
    source_files:
      - src/auth.js
      - src/tenant.js
    verification:
      - bun test
    done_when:
      - Tests pass.
    memory_updates: []
`
  );
}
