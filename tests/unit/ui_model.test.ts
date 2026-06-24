import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUiMemoryModel, reviewClaim } from "../../packages/core/src/ui_model";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("UI memory model", () => {
  test("projects claims, relations, review queue, and file tree from canonical memory", async () => {
    const cwd = copyFixture(mockApp);
    const model = await buildUiMemoryModel(cwd);

    expect(model.claims.map((claim) => claim.id)).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(model.relations.some((relation) => relation.origin === "explicit" && relation.relation === "requires")).toBe(true);
    expect(model.files.children?.some((node) => node.name === "claims")).toBe(true);
    expect(model.reviewQueue.length).toBe(0);
    expect(model.validation.valid).toBe(true);
    expect(model.doctor.healthy).toBe(false);
    expect(model.doctor.checks.some((check) => check.name === "database_exists" && check.status === "warning")).toBe(true);
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
