import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("audit command", () => {
  test("passes with JSON output for unrelated changed files", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(["audit", "--changed-files", "README.md", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.changedFiles).toEqual(["README.md"]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.warnings).toContain("Not inside a git repository; using current working directory as repo root.");
  });

  test("reports missing changed-file input", async () => {
    const cwd = copyFixture(mockApp);
    let stderr = "";
    const exitCode = await runCli(
      ["audit"],
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

    expect(exitCode).toBe(1);
    expect(stderr).toContain("audit requires --changed-files or --git-diff");
  });

  test("fails when changed active claims overlap without a review decision", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_new_current.md", {
      id: "auth.student_oauth.new_current",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.overlap_without_review");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
  });

  test("reports tag-only overlap as informational and non-blocking", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/learning/school_calendar.md", {
      id: "learning.school.calendar",
      status: "current",
      sourceFiles: ["src/calendar.js"],
      relatedFiles: [],
      symbols: ["SchoolCalendar"],
      tags: ["auth"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { ok: boolean; findings: Array<{ severity: string; shared_values: Record<string, string[]> }> };

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.findings.some((finding) => finding.severity === "info" && finding.shared_values.tags?.includes("auth"))).toBe(true);
  });

  test("reports one shared source file as a warning with exact shared values", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/school/license.md", {
      id: "school.license",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb"],
      relatedFiles: [],
      symbols: ["SchoolLicense"],
      tags: ["license"]
    });
    const calendarPath = writeClaim(cwd, "claims/school/calendar.md", {
      id: "school.calendar",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb"],
      relatedFiles: [],
      symbols: ["SchoolCalendar"],
      tags: ["calendar"]
    });

    const result = await dispatch(["audit", "--changed-files", calendarPath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as {
      findings: Array<{ code: string; severity: string; shared_values: Record<string, string[]> }>;
    };
    const finding = parsed.findings.find((candidate) => candidate.code === "claim.overlap_without_review");

    expect(result.exitCode).toBe(0);
    expect(finding?.severity).toBe("warning");
    expect(finding?.shared_values).toEqual({ source_files: ["app/models/school.rb"] });
  });

  test("blocks same-system claims with at least two shared source files", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/school/license.md", {
      id: "school.license",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb", "app/services/school_service.rb"],
      relatedFiles: [],
      symbols: ["SchoolLicense"],
      tags: ["license"]
    });
    const calendarPath = writeClaim(cwd, "claims/school/calendar.md", {
      id: "school.calendar",
      system: "school",
      status: "current",
      sourceFiles: ["app/services/school_service.rb", "app/models/school.rb"],
      relatedFiles: [],
      symbols: ["SchoolCalendar"],
      tags: ["calendar"]
    });

    const result = await dispatch(["audit", "--changed-files", calendarPath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ severity: string; shared_values: Record<string, string[]> }> };

    expect(result.exitCode).toBe(6);
    expect(parsed.findings[0]?.severity).toBe("error");
    expect(parsed.findings[0]?.shared_values.source_files).toEqual(["app/models/school.rb", "app/services/school_service.rb"]);
  });

  test("blocks a shared route across systems", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/school/route_owner.md", {
      id: "school.route.owner",
      system: "school",
      status: "current",
      sourceFiles: ["app/controllers/schools_controller.rb"],
      relatedFiles: [],
      symbols: ["SchoolsController"],
      routes: ["/schools/show"],
      tags: ["school"]
    });
    const calendarPath = writeClaim(cwd, "claims/calendar/route_owner.md", {
      id: "calendar.route.owner",
      system: "calendar",
      status: "current",
      sourceFiles: ["app/controllers/calendars_controller.rb"],
      relatedFiles: [],
      symbols: ["CalendarsController"],
      routes: ["/schools/show"],
      tags: ["calendar"]
    });

    const result = await dispatch(["audit", "--changed-files", calendarPath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ severity: string; shared_values: Record<string, string[]> }> };

    expect(result.exitCode).toBe(6);
    expect(parsed.findings[0]?.severity).toBe("error");
    expect(parsed.findings[0]?.shared_values).toEqual({ routes: ["/schools/show"] });
  });

  test("normalizes leading dot segments in configured memory root", async () => {
    const cwd = copyFixture(mockApp);
    updateMemoryRoot(cwd, "./docs/agent-memory");
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_new_current.md", {
      id: "auth.student_oauth.new_current",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.overlap_without_review");
  });

  test("normalizes absolute configured memory root", async () => {
    const cwd = copyFixture(mockApp);
    updateMemoryRoot(cwd, path.join(cwd, "docs/agent-memory"));
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_new_current.md", {
      id: "auth.student_oauth.new_current",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.overlap_without_review");
  });

  test("does not treat canonical memory files as source changes when memory root is the repo root", async () => {
    const cwd = copyFixture(mockApp);
    updateMemoryRootToRepoRoot(cwd);
    const changedClaimPath = writeClaim(cwd, "claims/auth/root_memory_changed.md", {
      id: "auth.root_memory.changed",
      status: "current",
      sourceFiles: ["docs/agent-memory/claims/auth/root_memory_changed.md"],
      relatedFiles: [],
      symbols: ["rootMemoryChanged"],
      tags: ["root-memory-changed"]
    });
    writeClaim(cwd, "claims/auth/root_memory_unchanged.md", {
      id: "auth.root_memory.unchanged",
      status: "current",
      sourceFiles: ["docs/agent-memory/claims/auth/root_memory_changed.md"],
      relatedFiles: [],
      symbols: ["rootMemoryUnchanged"],
      tags: ["root-memory-unchanged"]
    });
    appendGraphEdge(cwd, {
      source: "auth.root_memory.changed",
      target: "auth.root_memory.unchanged",
      relation: "replaces"
    });

    const result = await dispatch(["audit", "--changed-files", changedClaimPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("sorts overlap finding IDs and paths in JSON output", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/aaa_overlap.md", {
      id: "auth.aaa_overlap",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ code: string; claimIds: string[]; paths: string[] }> };
    const finding = parsed.findings.find((candidate) => candidate.code === "claim.overlap_without_review");

    expect(result.exitCode).toBe(6);
    expect(finding?.claimIds).toEqual([...(finding?.claimIds ?? [])].sort());
    expect(finding?.paths).toEqual([...(finding?.paths ?? [])].sort());
  });

  test("normalizes backslash separators in advisory overlap values", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_windows_path_overlap.md", {
      id: "auth.student_oauth.windows_path_overlap",
      status: "current",
      sourceFiles: ["src\\auth.js"],
      relatedFiles: [],
      symbols: [],
      tags: ["windows-path"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claim.overlap_without_review");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
    expect(result.stdout).toContain("[warning]");
  });

  test("passes when changed overlapping claims have an explicit replaces edge", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_replacement.md", {
      id: "auth.student_oauth.replacement",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });
    const graphPath = appendGraphEdge(cwd, {
      source: "auth.student_oauth.replacement",
      target: "auth.student_oauth.uid_is_tenant_scoped",
      relation: "replaces"
    });

    const result = await dispatch(["audit", "--changed-files", claimPath, graphPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  for (const relation of ["same_area", "requires", "constrains", "explains", "verifies"]) {
    test(`accepts ${relation} as evidence that a strong overlap was reviewed`, async () => {
      const cwd = copyFixture(mockApp);
      const claimPath = writeClaim(cwd, `claims/auth/student_oauth_${relation}.md`, {
        id: `auth.student_oauth.${relation}`,
        status: "current",
        sourceFiles: ["src/new-auth.js"],
        relatedFiles: [],
        symbols: ["resolveStudentOAuthIdentity"],
        tags: [relation]
      });
      const graphPath = appendGraphEdge(cwd, {
        source: `auth.student_oauth.${relation}`,
        target: "auth.student_oauth.uid_is_tenant_scoped",
        relation
      });

      const result = await dispatch(["audit", "--changed-files", claimPath, graphPath], { cwd });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Agent Memory audit passed");
      expect(result.stdout).not.toContain("claim.overlap_without_review");
    });
  }

  test("strict mode retains legacy overlap and review-relation behavior", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_same_area_strict.md", {
      id: "auth.student_oauth.same_area_strict",
      status: "current",
      sourceFiles: ["src/unique-strict.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["strict-review"]
    });
    const graphPath = appendGraphEdge(cwd, {
      source: "auth.student_oauth.same_area_strict",
      target: "auth.student_oauth.uid_is_tenant_scoped",
      relation: "same_area"
    });

    const defaultResult = await dispatch(["audit", "--changed-files", claimPath, graphPath], { cwd });
    const strictResult = await dispatch(["audit", "--changed-files", claimPath, graphPath, "--strict", "--json"], { cwd });
    const parsed = JSON.parse(strictResult.stdout) as { findings: Array<{ severity: string; shared_values: Record<string, string[]> }> };

    expect(defaultResult.exitCode).toBe(0);
    expect(defaultResult.stdout).not.toContain("claim.overlap_without_review");
    expect(strictResult.exitCode).toBe(6);
    expect(parsed.findings.some((finding) => finding.severity === "error" && finding.shared_values.symbols?.includes("resolveStudentOAuthIdentity"))).toBe(true);
  });

  test("passes when deprecated_by points to an active replacement from an inactive claim", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/auth/student_oauth_replacement.md", {
      id: "auth.student_oauth.replacement",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["replacementResolver"],
      tags: ["replacement"]
    });
    const deprecatedPath = writeClaim(cwd, "claims/auth/student_oauth_old.md", {
      id: "auth.student_oauth.old",
      status: "deprecated",
      sourceFiles: ["src/old-auth.js"],
      relatedFiles: [],
      symbols: ["oldResolver"],
      tags: ["old-auth"],
      deprecatedBy: "auth.student_oauth.replacement"
    });

    const result = await dispatch(["audit", "--changed-files", deprecatedPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("treats reviewed deprecated_by replacements as overlap review decisions", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/auth/student_oauth_replacement.md", {
      id: "auth.student_oauth.replacement",
      status: "current",
      sourceFiles: ["src/replacement-auth.js"],
      relatedFiles: [],
      symbols: ["replacementResolver"],
      tags: ["replacement"]
    });
    const supersededPath = writeClaim(cwd, "claims/auth/student_oauth_superseded.md", {
      id: "auth.student_oauth.superseded",
      status: "needs_review",
      sourceFiles: ["src/replacement-auth.js"],
      relatedFiles: [],
      symbols: ["replacementResolver"],
      tags: ["replacement"],
      deprecatedBy: "auth.student_oauth.replacement"
    });

    const result = await dispatch(["audit", "--changed-files", supersededPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("fails when deprecated_by is missing or attached to an active stable claim", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_bad_deprecated_by.md", {
      id: "auth.student_oauth.bad_deprecated_by",
      status: "current",
      sourceFiles: ["src/bad-auth.js"],
      relatedFiles: [],
      symbols: ["badResolver"],
      tags: ["bad-auth"],
      deprecatedBy: "auth.student_oauth.missing"
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.deprecated_by_missing");
    expect(result.stdout).toContain("claim.deprecated_by_active_status");
  });

  test("sorts deprecated_by finding IDs and paths in JSON output", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/auth/zzz_inactive_replacement.md", {
      id: "auth.aaa_inactive_replacement",
      status: "deprecated",
      sourceFiles: ["src/inactive-replacement.js"],
      relatedFiles: [],
      symbols: ["inactiveReplacement"],
      tags: ["inactive-replacement"]
    });
    const claimPath = writeClaim(cwd, "claims/auth/aaa_superseded.md", {
      id: "auth.zzz_superseded",
      status: "deprecated",
      sourceFiles: ["src/superseded.js"],
      relatedFiles: [],
      symbols: ["superseded"],
      tags: ["superseded"],
      deprecatedBy: "auth.aaa_inactive_replacement"
    });

    const result = await dispatch(["audit", "--changed-files", claimPath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ code: string; claimIds: string[]; paths: string[] }> };
    const finding = parsed.findings.find((candidate) => candidate.code === "claim.deprecated_by_inactive");

    expect(result.exitCode).toBe(6);
    expect(finding?.claimIds).toEqual([...(finding?.claimIds ?? [])].sort());
    expect(finding?.paths).toEqual([...(finding?.paths ?? [])].sort());
  });

  test("ignores pre-existing unrelated deprecated_by problems", async () => {
    const cwd = copyFixture(mockApp);
    writeClaim(cwd, "claims/auth/student_oauth_bad_deprecated_by.md", {
      id: "auth.student_oauth.bad_deprecated_by",
      status: "current",
      sourceFiles: ["src/bad-auth.js"],
      relatedFiles: [],
      symbols: ["badResolver"],
      tags: ["bad-auth"],
      deprecatedBy: "auth.student_oauth.missing"
    });

    const result = await dispatch(["audit", "--changed-files", "README.md"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("fails when active conflicts have no review status", async () => {
    const cwd = copyFixture(mockApp);
    const graphPath = appendGraphEdge(cwd, {
      source: "auth.student_oauth.uid_is_tenant_scoped",
      target: "tenancy.current_tenant.required_for_student_auth",
      relation: "conflicts_with"
    });

    const result = await dispatch(["audit", "--changed-files", graphPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("graph.active_conflict_unreviewed");
  });

  test("fails when a current recipe requires a deprecated claim", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    fs.writeFileSync(claimPath, fs.readFileSync(claimPath, "utf8").replace("status: current", "status: deprecated"));

    const result = await dispatch(["audit", "--changed-files", "docs/agent-memory/recipes/auth/modify_student_oauth.yaml"], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("recipe.required_claim.inactive");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
  });

  test("fails when a current plan stage references a deprecated recipe", async () => {
    const cwd = copyFixture(mockApp);
    const planPath = writePlan(cwd, "plans/auth/oauth_change.yaml", {
      id: "plan_template.auth.oauth_change",
      recipe: "recipe.auth.modify_student_oauth"
    });
    const recipePath = path.join(cwd, "docs/agent-memory/recipes/auth/modify_student_oauth.yaml");
    fs.writeFileSync(recipePath, fs.readFileSync(recipePath, "utf8").replace("status: current", "status: deprecated"));

    const result = await dispatch(["audit", "--changed-files", planPath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("plan.recipe_ref.inactive");
    expect(result.stdout).toContain("recipe.auth.modify_student_oauth");
  });

  test("fails when a critical current profile trait applies too broadly", async () => {
    const cwd = copyFixture(mockApp);
    const profilePath = writeProfile(cwd, "profiles/review/critical_broad.yaml", {
      id: "profile_trait.review.critical_broad",
      priority: "critical",
      appliesWhen: "always: true"
    });

    const result = await dispatch(["audit", "--changed-files", profilePath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("profile.critical_broad");
    expect(result.stdout).toContain("profile_trait.review.critical_broad");
  });

  test("fails when overlapping current profile traits omit conflicts_with", async () => {
    const cwd = copyFixture(mockApp);
    const profilePath = writeProfile(cwd, "profiles/review/findings_first.yaml", {
      id: "profile_trait.review.findings_first",
      priority: "normal",
      appliesWhen: "systems:\n    - auth"
    });
    writeProfile(cwd, "profiles/review/tutorial_style.yaml", {
      id: "profile_trait.review.tutorial_style",
      priority: "normal",
      appliesWhen: "systems:\n    - auth"
    });

    const result = await dispatch(["audit", "--changed-files", profilePath], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("profile.conflict_missing");
    expect(result.stdout).toContain("profile_trait.review.tutorial_style");
  });

  test("ignores pre-existing unrelated active conflicts", async () => {
    const cwd = copyFixture(mockApp);
    appendGraphEdge(cwd, {
      source: "auth.student_oauth.uid_is_tenant_scoped",
      target: "tenancy.current_tenant.required_for_student_auth",
      relation: "conflicts_with"
    });
    const claimPath = writeClaim(cwd, "claims/billing/payment_provider.md", {
      id: "billing.payment.provider",
      system: "billing",
      status: "current",
      sourceFiles: ["src/payment.js"],
      relatedFiles: [],
      symbols: ["resolvePaymentProvider"],
      routes: ["/payments"],
      tags: ["billing", "payments"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory audit passed");
  });

  test("passes for unrelated changed claims", async () => {
    const cwd = copyFixture(mockApp);
    const claimPath = writeClaim(cwd, "claims/billing/payment_provider.md", {
      id: "billing.payment.provider",
      system: "billing",
      status: "current",
      sourceFiles: ["src/payment.js"],
      relatedFiles: [],
      symbols: ["resolvePaymentProvider"],
      routes: ["/payments"],
      tags: ["billing", "payments"]
    });

    const result = await dispatch(["audit", "--changed-files", claimPath], { cwd });

    expect(result.exitCode).toBe(0);
  });

  test("warns when source and memory changed but related active claims were not all reviewed", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(
      ["audit", "--changed-files", "src/auth.js", "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md"],
      { cwd }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[warning]");
    expect(result.stdout).toContain("source.related_claims_not_reviewed");
    expect(result.stdout).toContain("tenancy.current_tenant.required_for_student_auth");
  });

  test("strict mode blocks when related active claims were not all changed", async () => {
    const cwd = copyFixture(mockApp);
    const result = await dispatch(
      ["audit", "--changed-files", "src/auth.js", "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md", "--strict"],
      { cwd }
    );

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("[error] source.related_claims_not_reviewed");
  });

  test("matches changed source files against claim file references with backslash separators", async () => {
    const cwd = copyFixture(mockApp);
    const changedClaimPath = writeClaim(cwd, "claims/auth/student_oauth_reviewed_windows_path.md", {
      id: "auth.student_oauth.reviewed_windows_path",
      status: "current",
      sourceFiles: ["src\\auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentityReviewed"],
      tags: ["reviewed-windows-path"]
    });

    const result = await dispatch(["audit", "--changed-files", "src/auth.js", changedClaimPath], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("source.related_claims_not_reviewed");
    expect(result.stdout).toContain("auth.student_oauth.uid_is_tenant_scoped");
  });

  test("benchmarks overlap audit against many unrelated active claims", async () => {
    const cwd = copyFixture(mockApp);

    for (let index = 0; index < 1_000; index += 1) {
      writeClaim(cwd, `claims/perf/unrelated_${index}.md`, {
        id: `perf.unrelated_${index}`,
        system: "perf",
        status: "current",
        sourceFiles: [`src/perf-${index}.js`],
        relatedFiles: [],
        symbols: [`perfSymbol${index}`],
        routes: [`/perf/${index}`],
        tags: [`perf-${index}`]
      });
    }

    const claimPath = writeClaim(cwd, "claims/auth/student_oauth_perf_overlap.md", {
      id: "auth.student_oauth.perf_overlap",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["perf-overlap"]
    });
    const startedAt = performance.now();
    const result = await dispatch(["audit", "--changed-files", claimPath, "--json"], { cwd });
    const elapsedMs = performance.now() - startedAt;
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ code: string }> };

    expect(result.exitCode).toBe(6);
    expect(parsed.findings.some((finding) => finding.code === "claim.overlap_without_review")).toBe(true);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test("keeps broad shared tags non-blocking", async () => {
    const cwd = copyFixture(mockApp);
    let changedClaimPath = "";

    for (let index = 0; index < 60; index += 1) {
      changedClaimPath = writeClaim(cwd, `claims/learning/topic_${index}.md`, {
        id: `learning.topic_${index}`,
        system: "learning",
        status: "current",
        sourceFiles: [`src/learning-${index}.js`],
        relatedFiles: [],
        symbols: [`LearningTopic${index}`],
        tags: ["learning"]
      });
    }

    const result = await dispatch(["audit", "--changed-files", changedClaimPath, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ severity: string }> };

    expect(result.exitCode).toBe(0);
    expect(parsed.findings.length).toBe(59);
    expect(parsed.findings.every((finding) => finding.severity === "info")).toBe(true);
  });

  test("checks git diff files", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    writeClaim(cwd, "claims/billing/payment_provider.md", {
      id: "billing.payment.provider",
      system: "billing",
      status: "current",
      sourceFiles: ["src/payment.js"],
      relatedFiles: [],
      symbols: ["resolvePaymentProvider"],
      routes: ["/payments"],
      tags: ["billing", "payments"]
    });

    const result = await dispatch(["audit", "--git-diff", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.changedFiles).toContain("docs/agent-memory/claims/billing/payment_provider.md");
  });

  test("checks committed git diff files against an explicit base ref", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    writeClaim(cwd, "claims/auth/student_oauth_base_overlap.md", {
      id: "auth.student_oauth.base_overlap",
      status: "current",
      sourceFiles: ["src/new-auth.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["new-auth"]
    });
    commitAll(cwd, "Add overlapping memory");

    const result = await dispatch(["audit", "--git-diff", "--base", base], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.overlap_without_review");
  });

  test("uses HEAD~1 for committed fallback even when untracked files exist", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    writeClaim(cwd, "claims/school/fallback_first.md", {
      id: "school.fallback.first",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb", "app/services/school_service.rb"],
      relatedFiles: [],
      symbols: ["FallbackFirst"],
      tags: ["fallback-first"]
    });
    writeClaim(cwd, "claims/school/fallback_second.md", {
      id: "school.fallback.second",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb", "app/services/school_service.rb"],
      relatedFiles: [],
      symbols: ["FallbackSecond"],
      tags: ["fallback-second"]
    });
    commitAll(cwd, "Add committed overlap");
    fs.writeFileSync(path.join(cwd, "untracked-note.txt"), "Keep this untracked.\n");

    const result = await dispatch(["audit", "--git-diff", "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { changedFiles: string[]; findings: Array<{ code: string; severity: string }> };

    expect(result.exitCode).toBe(6);
    expect(parsed.changedFiles).toContain("untracked-note.txt");
    expect(parsed.findings.some((finding) => finding.code === "claim.overlap_without_review" && finding.severity === "error")).toBe(true);
  });

  test("does not report an unchanged strong overlap finding from the base revision", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const firstPath = writeClaim(cwd, "claims/school/base_first.md", {
      id: "school.base.first",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb", "app/services/school_service.rb"],
      relatedFiles: [],
      symbols: ["BaseFirst"],
      tags: ["base-first"]
    });
    writeClaim(cwd, "claims/school/base_second.md", {
      id: "school.base.second",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb", "app/services/school_service.rb"],
      relatedFiles: [],
      symbols: ["BaseSecond"],
      tags: ["base-second"]
    });
    commitAll(cwd, "Add existing strong overlap");
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(cwd, firstPath), "\nReviewed without changing the claim.\n");

    const result = await dispatch(["audit", "--git-diff", "--base", base, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ code: string }> };

    expect(result.exitCode).toBe(0);
    expect(parsed.findings.some((finding) => finding.code === "claim.overlap_without_review")).toBe(false);
  });

  test("reports overlap severity that increases from the base revision", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const firstPath = writeClaim(cwd, "claims/school/escalation_first.md", {
      id: "school.escalation.first",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/first.rb"],
      relatedFiles: [],
      symbols: ["FirstSymbol"],
      tags: ["learning"]
    });
    writeClaim(cwd, "claims/school/escalation_second.md", {
      id: "school.escalation.second",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/second.rb"],
      relatedFiles: [],
      symbols: ["SharedSymbol"],
      tags: ["learning"]
    });
    commitAll(cwd, "Add informational overlap");
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    const absoluteFirstPath = path.join(cwd, firstPath);
    fs.writeFileSync(absoluteFirstPath, fs.readFileSync(absoluteFirstPath, "utf8").replace("FirstSymbol", "SharedSymbol"));

    const result = await dispatch(["audit", "--git-diff", "--base", base, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ code: string; severity: string }> };

    expect(result.exitCode).toBe(6);
    expect(parsed.findings.some((finding) => finding.code === "claim.overlap_without_review" && finding.severity === "error")).toBe(true);
  });

  test("compares only current overlap pairs against a broad-tag baseline", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    let changedClaimPath = "";

    for (let index = 0; index < 500; index += 1) {
      const claimPath = writeClaim(cwd, `claims/baseline_perf/topic_${index}.md`, {
        id: `baseline_perf.topic_${index}`,
        system: "baseline_perf",
        status: "current",
        sourceFiles: [`src/baseline-perf-${index}.js`],
        relatedFiles: [],
        symbols: [`BaselinePerf${index}`],
        tags: ["learning"]
      });

      if (index === 0) {
        changedClaimPath = claimPath;
      }
    }

    commitAll(cwd, "Add broad-tag baseline");
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(cwd, changedClaimPath), "\nReviewed without changing overlap metadata.\n");
    const startedAt = performance.now();
    const result = await dispatch(["audit", "--git-diff", "--base", base, "--json"], { cwd });
    const elapsedMs = performance.now() - startedAt;
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ code: string }> };

    expect(result.exitCode).toBe(0);
    expect(parsed.findings.some((finding) => finding.code === "claim.overlap_without_review")).toBe(false);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("warns and retains current findings when baseline memory cannot be parsed", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const relativePath = "docs/agent-memory/claims/repairs/malformed_base.md";
    const absolutePath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, "---\nid: repairs.malformed_base\n");
    commitAll(cwd, "Add malformed base memory");
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    writeClaim(cwd, "claims/repairs/malformed_base.md", {
      id: "repairs.malformed_base",
      system: "repairs",
      status: "current",
      sourceFiles: ["src/repairs.js"],
      relatedFiles: [],
      symbols: ["resolveStudentOAuthIdentity"],
      tags: ["repairs"]
    });

    const result = await dispatch(["audit", "--git-diff", "--base", base, "--json"], { cwd });
    const parsed = JSON.parse(result.stdout) as { ok: boolean; findings: Array<{ code: string }>; warnings: string[] };

    expect(result.exitCode).toBe(6);
    expect(parsed.ok).toBe(false);
    expect(parsed.findings.some((finding) => finding.code === "claim.overlap_without_review")).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes("Could not load Git baseline memory"))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes("current-tree overlap findings were retained"))).toBe(true);
  });

  test("reports a strong pair when its base review relationship is removed", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    writeClaim(cwd, "claims/school/relation_first.md", {
      id: "school.relation.first",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb", "app/services/school_service.rb"],
      relatedFiles: [],
      symbols: ["RelationFirst"],
      tags: ["relation-first"]
    });
    writeClaim(cwd, "claims/school/relation_second.md", {
      id: "school.relation.second",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb", "app/services/school_service.rb"],
      relatedFiles: [],
      symbols: ["RelationSecond"],
      tags: ["relation-second"]
    });
    const graphRelativePath = "docs/agent-memory/graph/auth-tenancy.yaml";
    const graphAbsolutePath = path.join(cwd, graphRelativePath);
    const graphWithoutReviewEdge = fs.readFileSync(graphAbsolutePath, "utf8");
    appendGraphEdge(cwd, {
      source: "school.relation.first",
      target: "school.relation.second",
      relation: "same_area"
    });
    commitAll(cwd, "Add reviewed overlap");
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    fs.writeFileSync(graphAbsolutePath, graphWithoutReviewEdge);

    const result = await dispatch(["audit", "--git-diff", "--base", base], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("school.relation.first");
    expect(result.stdout).toContain("school.relation.second");
  });

  test("strict mode does not suppress overlap findings present at the base revision", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    const firstPath = writeClaim(cwd, "claims/school/strict_base_first.md", {
      id: "school.strict_base.first",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/school.rb"],
      relatedFiles: [],
      symbols: ["StrictBaseFirst"],
      tags: ["learning"]
    });
    writeClaim(cwd, "claims/school/strict_base_second.md", {
      id: "school.strict_base.second",
      system: "school",
      status: "current",
      sourceFiles: ["app/models/other.rb"],
      relatedFiles: [],
      symbols: ["StrictBaseSecond"],
      tags: ["learning"]
    });
    commitAll(cwd, "Add legacy overlap");
    const base = gitOutput(cwd, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(cwd, firstPath), "\nReviewed under strict mode.\n");

    const result = await dispatch(["audit", "--git-diff", "--base", base, "--strict"], { cwd });

    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("claim.overlap_without_review");
  });

  test("rejects an explicit base ref that cannot be resolved", async () => {
    const cwd = copyFixture(mockApp);
    initGitHistory(cwd);
    for (const extraArgs of [[], ["--strict"]]) {
      let stderr = "";
      const exitCode = await runCli(
        ["audit", "--git-diff", "--base", "missing-audit-base", ...extraArgs],
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

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Could not resolve audit base ref: missing-audit-base");
    }
  });
});

interface ClaimOptions {
  id: string;
  system?: string;
  status: string;
  sourceFiles: string[];
  relatedFiles: string[];
  symbols: string[];
  routes?: string[];
  tags: string[];
  deprecatedBy?: string;
}

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-audit-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function updateMemoryRoot(cwd: string, memoryRoot: string): void {
  const configPath = path.join(cwd, "agent-memory.config.yaml");
  fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace("memory_root: docs/agent-memory", `memory_root: ${memoryRoot}`));
}

function updateMemoryRootToRepoRoot(cwd: string): void {
  const configPath = path.join(cwd, "agent-memory.config.yaml");
  const config = fs
    .readFileSync(configPath, "utf8")
    .replace("memory_root: docs/agent-memory", "memory_root: .")
    .replace("  - claims/**/*.md", "  - docs/agent-memory/claims/**/*.md")
    .replace("  - graph/**/*.yaml", "  - docs/agent-memory/graph/**/*.yaml")
    .replace("  - indexes/**/*.yaml", "  - docs/agent-memory/indexes/**/*.yaml")
    .replace("  - recipes/**/*.yaml", "  - docs/agent-memory/recipes/**/*.yaml")
    .replace("  - waivers/**/*.yaml", "  - docs/agent-memory/waivers/**/*.yaml");
  fs.writeFileSync(configPath, config);
}

function writeClaim(cwd: string, relativeMemoryPath: string, options: ClaimOptions): string {
  const relativePath = path.join("docs/agent-memory", relativeMemoryPath);
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, renderClaim(options));
  return relativePath.replaceAll(path.sep, "/");
}

function renderClaim(options: ClaimOptions): string {
  const system = options.system ?? options.id.split(".")[0];
  const routes = options.routes ?? [];
  const deprecatedBy = options.deprecatedBy ? `deprecated_by: ${options.deprecatedBy}\n` : "";

  return `---
id: ${options.id}
type: fact
system: ${system}
status: ${options.status}
confidence: high
severity: important
title: ${options.id}
claim: ${options.id} claim.
${renderYamlField("source_files", options.sourceFiles)}
${renderYamlField("related_files", options.relatedFiles)}
${renderYamlField("symbols", options.symbols)}
${renderYamlField("routes", routes)}
${renderYamlField("tags", options.tags)}
verification:
  - bun test
${deprecatedBy}---

# ${options.id}

## Claim

${options.id} claim.
`;
}

function renderYamlField(name: string, values: string[]): string {
  return values.length > 0 ? `${name}:\n${values.map((value) => `  - ${value}`).join("\n")}` : `${name}: []`;
}

function appendGraphEdge(cwd: string, edge: { source: string; target: string; relation: string }): string {
  const relativePath = "docs/agent-memory/graph/auth-tenancy.yaml";
  const absolutePath = path.join(cwd, relativePath);
  fs.appendFileSync(
    absolutePath,
    `
  - source: ${edge.source}
    target: ${edge.target}
    relation: ${edge.relation}
    reason: Audit test relation.
    strength: 100
    bidirectional: false
`
  );
  return relativePath;
}

function writePlan(cwd: string, relativeMemoryPath: string, options: { id: string; recipe: string }): string {
  const relativePath = path.join("docs/agent-memory", relativeMemoryPath);
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    `id: ${options.id}
title: OAuth change
system: auth
status: current
stages:
  - id: inspect
    title: Inspect
    goal: Inspect OAuth behavior.
    recipe_refs:
      - ${options.recipe}
`
  );
  return relativePath.replaceAll(path.sep, "/");
}

function writeProfile(cwd: string, relativeMemoryPath: string, options: { id: string; priority: string; appliesWhen: string }): string {
  const relativePath = path.join("docs/agent-memory", relativeMemoryPath);
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    `id: ${options.id}
title: ${options.id}
status: current
category: review
priority: ${options.priority}
applies_when:
  ${options.appliesWhen}
snippet: Test profile trait.
`
  );
  return relativePath.replaceAll(path.sep, "/");
}

function initGitHistory(cwd: string): void {
  git(cwd, ["init"]);
  commitAll(cwd, "Initial");
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", message]);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
