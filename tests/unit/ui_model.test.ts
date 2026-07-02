import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUiGraphSummary, buildUiMemoryModel, deterministicSystemColor, reviewClaim, type UiClaimSummary, type UiRelation } from "../../packages/core/src/ui_model";

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
      relation("explicit:auth.first:same_area:billing.first", "auth.first", "billing.first", true),
      relation("explicit:billing.first:same_area:auth.first", "billing.first", "auth.first", true)
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
