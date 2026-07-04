import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildUiGraphSummary,
  buildUiMemoryModel,
  deterministicSystemColor,
  getUiPlanRuns,
  getUiPlans,
  getUiProfiles,
  getUiRecipes,
  reviewClaim,
  updateUiPlanRunStage,
  updateUiWorkflowArtifact,
  type UiClaimSummary,
  type UiRelation
} from "../../packages/core/src/ui_model";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("UI memory model", () => {
  test("projects claims, relations, review queue, and file tree from canonical memory", async () => {
    const cwd = copyFixture(mockApp);
    const model = await buildUiMemoryModel(cwd);
    const authSystem = model.graph.systems.find((item) => item.system === "auth");

    expect(authSystem).toEqual({
      id: "auth",
      system: "auth",
      color: deterministicSystemColor("auth"),
      claimCount: 1,
      statusCounts: { current: 1 },
      severityCounts: { important: 1 },
      reviewCount: 0,
      searchText: expect.stringContaining("student oauth uid is tenant scoped")
    });
    expect(authSystem?.searchText).toContain("claims/auth/student_oauth_uid_is_tenant_scoped.md");
    expect(authSystem?.searchText).toContain("oauth");
    expect(deterministicSystemColor("auth")).toBe(deterministicSystemColor("auth"));
    expect(model.graph.systemRelations).toContainEqual({
      id: "system:explicit:requires:auth:tenancy",
      source: "auth",
      target: "tenancy",
      relation: "requires",
      origin: "explicit",
      count: 1,
      strength: 95,
      bidirectional: false
    });
    expect(model.files.children?.some((node) => node.name === "claims")).toBe(true);
    expect(model.workflowSummary).toMatchObject({
      recipeCount: 1,
      planTemplateCount: 0,
      profileTraitCount: 0,
      activePlanRunCount: 0,
      completedPlanRunCount: 0,
      abandonedPlanRunCount: 0,
      blockedPlanRunCount: 0,
      warnings: []
    });
    expect(model.reviewQueue.length).toBe(0);
    expect(model.health.healthy).toBe(false);
    expect(model.validation.valid).toBe(true);
    expect(model.doctor.healthy).toBe(false);
    expect(model.doctor.checks.some((check) => check.name === "database_exists" && check.status === "warning")).toBe(true);
  });

  test("deduplicates bidirectional system relation counts", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("billing.first", "billing", "First billing claim")
    ];
    const graph = buildUiGraphSummary(claims, [
      relation("explicit:billing.first:same_area:auth.first", "billing.first", "auth.first", true),
      relation("explicit:auth.first:same_area:billing.first", "auth.first", "billing.first", true)
    ]);

    expect(graph.systemRelations).toEqual([
      {
        id: "system:explicit:same_area:auth:billing",
        source: "auth",
        target: "billing",
        relation: "same_area",
        origin: "explicit",
        count: 1,
        strength: 60,
        bidirectional: true
      }
    ]);
  });

  test("review updates status metadata while preserving body and unrelated frontmatter", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    const original = fs.readFileSync(claimPath, "utf8");
    fs.writeFileSync(claimPath, original.replace("severity: important\n", "severity: important\ncustom_field: keep_me\n"));

    const result = await reviewClaim({
      cwd,
      id: "auth.student_oauth.uid_is_tenant_scoped",
      status: "needs_review",
      confidence: "medium"
    });
    const updated = fs.readFileSync(claimPath, "utf8");

    expect(result.validation.valid).toBe(true);
    expect(result.compile?.counts.claims).toBe(2);
    expect(updated).toContain("status: needs_review");
    expect(updated).toContain("confidence: medium");
    expect(updated).toContain("custom_field: keep_me");
    expect(updated).toContain("## Claim");
  });

  test("review rejects invalid status before writing", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    const before = fs.readFileSync(claimPath, "utf8");

    await expect(
      reviewClaim({
        cwd,
        id: "auth.student_oauth.uid_is_tenant_scoped",
        status: "approved",
        confidence: "high"
      })
    ).rejects.toThrow("Invalid claim status");

    expect(fs.readFileSync(claimPath, "utf8")).toBe(before);
  });

  test("projects workflow artifacts and updates local plan stages", async () => {
    const cwd = copyFixture(mockApp);
    writeProfile(cwd);
    writePlan(cwd);
    writePlanRun(cwd);

    const model = await buildUiMemoryModel(cwd);
    const recipes = getUiRecipes(cwd);
    const plans = getUiPlans(cwd);
    const profiles = getUiProfiles(cwd);
    const planRuns = getUiPlanRuns(cwd);

    expect(model.workflowSummary).toMatchObject({
      recipeCount: 1,
      planTemplateCount: 1,
      profileTraitCount: 1,
      activePlanRunCount: 1
    });
    expect(model.files.children?.some((node) => node.name === "plans")).toBe(true);
    expect(model.files.children?.some((node) => node.name === "profiles")).toBe(true);
    expect(recipes[0]).toMatchObject({
      id: "recipe.auth.modify_student_oauth",
      title: "Modify student OAuth safely",
      requiredClaims: ["auth.student_oauth.uid_is_tenant_scoped", "tenancy.current_tenant.required_for_student_auth"]
    });
    expect(plans[0]).toMatchObject({
      id: "plan_template.auth.oauth_review",
      stages: [
        expect.objectContaining({
          id: "inspect_current_contract",
          claimRefs: ["auth.student_oauth.uid_is_tenant_scoped"],
          recipeRefs: ["recipe.auth.modify_student_oauth"],
          profileTraits: ["profile_trait.implementer.keep_scope_tight"]
        })
      ]
    });
    expect(profiles[0]).toMatchObject({
      id: "profile_trait.implementer.keep_scope_tight",
      conflictsWith: []
    });
    expect(planRuns.runs[0]).toMatchObject({
      id: "plan_run.20260703.oauth_review",
      status: "active",
      currentStage: "inspect_current_contract",
      path: ".agent-memory/plans/oauth-review.yaml"
    });

    expect(() =>
      updateUiPlanRunStage({
        cwd,
        id: "plan_run.20260703.oauth_review",
        stageId: "inspect_current_contract",
        status: "complete",
        evidence: ""
      })
    ).toThrow("complete-stage requires non-empty --evidence");

    const updated = updateUiPlanRunStage({
      cwd,
      id: "plan_run.20260703.oauth_review",
      stageId: "inspect_current_contract",
      status: "complete",
      evidence: "Reviewed tenant-scoped OAuth claims."
    });

    expect(updated).toMatchObject({
      id: "plan_run.20260703.oauth_review",
      status: "complete",
      stages: [
        expect.objectContaining({
          id: "inspect_current_contract",
          status: "complete",
          evidence: ["Reviewed tenant-scoped OAuth claims."]
        })
      ]
    });
  });

  test("reports empty workflow artifacts without warnings", async () => {
    const cwd = copyFixture(mockApp);
    fs.rmSync(path.join(cwd, "docs/agent-memory/recipes"), { recursive: true, force: true });

    const model = await buildUiMemoryModel(cwd);

    expect(getUiRecipes(cwd)).toEqual([]);
    expect(getUiPlans(cwd)).toEqual([]);
    expect(getUiProfiles(cwd)).toEqual([]);
    expect(getUiPlanRuns(cwd)).toEqual({ runs: [], warnings: [] });
    expect(model.workflowSummary).toMatchObject({
      recipeCount: 0,
      planTemplateCount: 0,
      profileTraitCount: 0,
      activePlanRunCount: 0,
      warnings: []
    });
  });

  test("updates workflow artifacts with structured patches", async () => {
    const cwd = copyFixture(mockApp);
    writeProfile(cwd);
    writePlan(cwd);

    const recipe = updateUiWorkflowArtifact({
      cwd,
      kind: "recipe",
      id: "recipe.auth.modify_student_oauth",
      patch: {
        title: "Modify student OAuth with tenant checks",
        status: "needs_review",
        intent_triggers: ["student oauth tenant checks"]
      }
    });
    const plan = updateUiWorkflowArtifact({
      cwd,
      kind: "plan",
      id: "plan_template.auth.oauth_review",
      patch: {
        title: "OAuth review plan",
        stages: [{ id: "inspect_current_contract", goal: "Review OAuth tenant behavior before editing." }]
      }
    });
    const profile = updateUiWorkflowArtifact({
      cwd,
      kind: "profile",
      id: "profile_trait.implementer.keep_scope_tight",
      patch: {
        priority: "high",
        snippet: "Keep scope tied to selected auth claims.",
        conflicts_with: []
      }
    });

    expect(recipe.validation.valid).toBe(true);
    expect(recipe.artifact).toMatchObject({
      title: "Modify student OAuth with tenant checks",
      status: "needs_review",
      intentTriggers: ["student oauth tenant checks"]
    });
    expect(plan.validation.valid).toBe(true);
    expect(plan.artifact).toMatchObject({
      title: "OAuth review plan",
      stages: [expect.objectContaining({ goal: "Review OAuth tenant behavior before editing." })]
    });
    expect(profile.validation.valid).toBe(true);
    expect(profile.artifact).toMatchObject({
      priority: "high",
      snippet: "Keep scope tied to selected auth claims."
    });
  });
});

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-ui-model-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function claim(id: string, system: string, title: string): UiClaimSummary {
  return {
    id,
    type: "fact",
    system,
    status: "current",
    confidence: "high",
    severity: "normal",
    title,
    claim: title,
    sourcePath: `docs/agent-memory/claims/${system}/${id.replaceAll(".", "_")}.md`,
    tags: [system],
    reviewPriority: 0
  };
}

function relation(id: string, source: string, target: string, bidirectional: boolean): UiRelation {
  return {
    id,
    source,
    target,
    relation: "same_area",
    strength: 60,
    origin: "explicit",
    bidirectional
  };
}

function writePlan(cwd: string): void {
  const planPath = path.join(cwd, "docs/agent-memory/plans/auth/oauth_review.yaml");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    `id: plan_template.auth.oauth_review
title: OAuth review
system: auth
status: current
intent_triggers:
  - review oauth change
recipes:
  - recipe.auth.modify_student_oauth
stages:
  - id: inspect_current_contract
    title: Inspect current contract
    goal: Review current OAuth and tenancy behavior.
    claim_refs:
      - auth.student_oauth.uid_is_tenant_scoped
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits:
      - profile_trait.implementer.keep_scope_tight
    source_files:
      - src/auth.js
    verification:
      - bun test
    done_when:
      - Current behavior is understood.
`
  );
}

function writeProfile(cwd: string): void {
  const profilePath = path.join(cwd, "docs/agent-memory/profiles/implementer/keep_scope_tight.yaml");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(
    profilePath,
    `id: profile_trait.implementer.keep_scope_tight
title: Keep scope tight
status: current
category: scope_control
priority: normal
applies_when:
  systems:
    - auth
snippet: Keep implementation scope tied to selected claims.
conflicts_with: []
`
  );
}

function writePlanRun(cwd: string): void {
  const runPath = path.join(cwd, ".agent-memory/plans/oauth-review.yaml");
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  fs.writeFileSync(
    runPath,
    `id: plan_run.20260703.oauth_review
template_id: plan_template.auth.oauth_review
task: Review OAuth change
created_at: 2026-07-03T00:00:00.000Z
updated_at: 2026-07-03T00:00:00.000Z
status: active
current_stage: inspect_current_contract
stages:
  - id: inspect_current_contract
    title: Inspect current contract
    goal: Review current OAuth and tenancy behavior.
    status: active
    claim_refs:
      - auth.student_oauth.uid_is_tenant_scoped
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits:
      - profile_trait.implementer.keep_scope_tight
    source_files:
      - src/auth.js
    verification:
      - bun test
    done_when:
      - Current behavior is understood.
    memory_updates: []
    evidence: []
`
  );
}
