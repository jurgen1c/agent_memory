import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptionPlan, caps, categories, categoryCounts, gitDiagnostic, retrieve } from "../fixtures/category-retrieval/prototype";
import { corpus, requiredIds, tasks } from "../fixtures/category-retrieval/corpus";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) + "\n");

describe("AM-88 bounded design contract (not production retrieval)", () => {
  for (const [name, task] of Object.entries({ full: tasks.full, short: tasks.short, withFiles: tasks.full })) {
    test(`${name} retains the complete four-claim retry closure within medium`, () => {
      const result = retrieve(corpus(), { task, files: name === "withFiles" ? ["src/receipts-controller.ts", "src/recovery.ts"] : [] });
      expect(requiredIds.every(id => result.claims.some(claim => claim.id === id))).toBe(true);
      expect(result.claims[0].id).toMatch(/^(accounts|ingestion)\./);
      expect(result.completeness).toBe("complete");
      expect(bytes(result)).toBe(result.budget.usedBytes);
      expect(bytes(result)).toBeLessThanOrEqual(caps.medium);
    });
  }
  test("exact controllers beat alphabetically early broad watched-index claims", () => {
    const result = retrieve(corpus(), { files: ["src/receipts-controller.ts", "src/diagnostics-controller.ts"] }, ["src/"]);
    expect(result.claims[0].reason.code).toBe("EXACT_SOURCE");
    expect(requiredIds.every(id => result.claims.some(claim => claim.id === id))).toBe(true);
    expect(result.claims.findIndex(claim => claim.id === "accounts.diagnostics_retry")).toBeLessThan(result.claims.findIndex(claim => claim.id === "aaa.storage"));
  });
  test("body indexing helps on unchanged defective metadata, curation separately repairs source ownership", () => {
    const original = corpus("original");
    const corrected = corpus();
    const before = retrieve(original, { task: "actor_user_id", bodySearch: false });
    const algorithmOnly = retrieve(original, { task: "actor_user_id" });
    expect(before.taskMatches).toBe(0);
    expect(algorithmOnly.claims.find(claim => claim.id === "accounts.receipt_retry")?.sections).toContainEqual(expect.objectContaining({ heading: "Authorization", text: expect.stringContaining("owner|admin"), claimId: "accounts.receipt_retry" }));
    expect(algorithmOnly.claims.find(claim => claim.id === "accounts.receipt_retry")?.sections).toContainEqual(expect.objectContaining({ heading: "Failure modes", text: expect.stringContaining("attempts_exhausted") }));
    expect(retrieve(original, { files: ["src/receipts-controller.ts"] }).claims).toHaveLength(0);
    expect(retrieve(corrected, { files: ["src/receipts-controller.ts"] }).claims[0].id).toBe("accounts.receipt_retry");
    expect(original[1].body).toBe(corrected[1].body);
  });
  test("multi-category browse, exact facets, repeated OR and uncategorized", () => {
    expect(categories(corpus().find(claim => claim.id === "accounts.receipt_retry")!)).toEqual(["reliability", "security"]);
    expect(categoryCounts(corpus()).find(category => category.id === "uncategorized")?.count).toBe(1);
    const result = retrieve(corpus(), { categories: ["reliability", "reliability"], systems: ["ingestion"], statuses: ["current"] });
    expect(result.mode).toBe("browse");
    expect(result.appliedFilters.categories).toEqual(["reliability"]);
    expect(result.claims.find(claim => claim.id === "accounts.receipt_retry")?.reason).toEqual({ code: "REQUIRED_DEPENDENCY", outsideFilters: ["system"] });
    expect(retrieve(corpus(), { categories: ["uncategorized"] }).claims.map(claim => claim.id)).toEqual(["legacy.notes"]);
    expect(retrieve(corpus(), { categories: ["billing", "delivery"] }).claims.map(claim => claim.id).sort()).toEqual(["aaa.storage", "ingestion.outbox"]);
    expect(() => retrieve(corpus(), { categories: ["SECURITY"] })).toThrow("UNKNOWN_CATEGORY");
    expect(() => retrieve(corpus(), { categories: ["toString"] })).toThrow("UNKNOWN_CATEGORY");
    expect(() => retrieve(corpus(), {})).toThrow("INPUT_REQUIRED");
    expect(() => retrieve(corpus(), { systems: ["acounts"] })).toThrow("UNKNOWN_SYSTEM");
    expect(() => retrieve(corpus(), { statuses: ["currnet"] })).toThrow("UNKNOWN_STATUS");
    for (const status of ["rejected", "experimental", "needs_verification"]) {
      expect(retrieve(corpus(), { statuses: [status] }).claims).toHaveLength(0);
    }
    expect(() => retrieve(corpus(), { task: "retry", maxBytes: 16777217 })).toThrow("from 512 through 16777216");
  });
  test("dangling and inactive required guidance cannot report complete", () => {
    const claims = corpus();
    claims.find(claim => claim.id === "ingestion.outbox")!.status = "stale";
    let result = retrieve(claims, { files: ["src/receipts-controller.ts"] });
    expect(result.completeness).toBe("incomplete");
    expect(result.warnings).toContain("REQUIRED_CONTEXT_INACTIVE");
    expect(result.claims.find(claim => claim.id === "ingestion.outbox")?.reason.outsideFilters).toContain("status");
    result = retrieve(claims.filter(claim => claim.id !== "ingestion.outbox"), { files: ["src/receipts-controller.ts"] });
    expect(result.completeness).toBe("incomplete");
    expect(result.warnings).toContain("REQUIRED_CONTEXT_MISSING");
    expect(result.budget.omitted.requiredClaims).toBe(0);
    expect(result.budget.omitted.claims).toBe(0);
  });
  test("browse lifecycle and required edge omissions stay explicit", () => {
    const claims = corpus();
    claims.find(claim => claim.id === "identity.overlap")!.status = "proposed";
    expect(retrieve(claims, { systems: ["identity"] }).claims[0].id).toBe("identity.rotation");
    const result = retrieve(corpus(), { systems: ["identity"], maxBytes: 1600 });
    expect(result.budget.omitted.edges).toBeGreaterThan(0);
    expect(result.completeness).toBe("incomplete");
    expect(result.warnings).toContain("REQUIRED_CONTEXT_OMITTED");
  });
  test("held-out signing-key task has relevant top hit and required coverage", () => {
    const result = retrieve(corpus(), { task: tasks.heldOut });
    expect(result.claims[0].id).toBe("identity.rotation");
    expect(result.claims.some(claim => claim.id === "identity.overlap")).toBe(true);
    expect(result.completeness).toBe("complete");
  });
  test("negative control distinguishes optional baseline and bounds it", () => {
    const claims = corpus();
    claims[0].baseline = true;
    const result = retrieve(claims, { task: "zzzauditnohitxyz", maxBytes: caps.small });
    expect(result.taskMatches).toBe(0);
    expect(result.claims).toHaveLength(0);
    expect(result.warnings).toContain("NO_TASK_MATCH");
    const baseline = retrieve(claims, { task: "zzzauditnohitxyz", baseline: true, maxBytes: caps.small });
    expect(baseline.taskMatches).toBe(0);
    expect(baseline.claims[0].reason.code).toBe("BASELINE_FALLBACK");
    expect(bytes(baseline)).toBeLessThanOrEqual(caps.small);
    const filtered = retrieve(claims, { task: "zzzauditnohitxyz", categories: ["security"], baseline: true });
    expect(filtered.claims).toHaveLength(0);
  });
  test("UTF-8, escaped JSON, long body and large lists never escape the byte cap", () => {
    const claims = corpus();
    const root = claims.find(claim => claim.id === "accounts.receipt_retry")!;
    root.requires.push(...Array(30).fill("ingestion.outbox"));
    root.source_files.push(...Array.from({ length: 200 }, (_, index) => `src/${index}.ts`));
    root.verification.push(...Array.from({ length: 200 }, (_, index) => `echo 'ñ😀\\\"${index}'`));
    claims.find(claim => claim.id === "ingestion.outbox")!.body += 'ñ😀\\"\n'.repeat(4000);
    for (const maxBytes of [1024, caps.small, caps.medium, caps.full]) {
      const result = retrieve(claims, { files: ["src/receipts-controller.ts"], maxBytes });
      expect(bytes(result)).toBeLessThanOrEqual(maxBytes);
      expect(bytes(result)).toBe(result.budget.usedBytes);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(new Set(result.claims.map(claim => claim.id)).size).toBe(result.claims.length);
      expect(new Set(result.edges.map(edge => `${edge.from}:${edge.to}`)).size).toBe(result.edges.length);
      if (result.budget.omitted.requiredClaims) expect(result.completeness).toBe("incomplete");
    }
    const truncated = retrieve(claims, { files: ["src/receipts-controller.ts"], maxBytes: caps.small });
    expect(truncated.budget.omitted.requiredClaims).toBeGreaterThan(0);
    expect(truncated.warnings).toContain("REQUIRED_CONTEXT_OMITTED");
    expect(() => retrieve(claims, { task: "retry", maxBytes: 100 })).toThrow("BUDGET_TOO_SMALL");
    expect(() => retrieve(claims, { task: "retry", tags: ["x".repeat(5000)], maxBytes: 1024 })).toThrow("BUDGET_TOO_SMALL");
  });
  test("permission errors override successful stdout and exit status", () => {
    for (const error of ["EPERM", "EACCES", "ENOENT", "ETIMEDOUT", "EIO"]) {
      const result = gitDiagnostic({ error, status: 0, stdout: "a".repeat(40) });
      expect(result.state).toBe("unavailable");
      expect(result.repairReference).toBe(false);
    }
    expect(gitDiagnostic({ status: 0, stdout: "a".repeat(40) + " missing", unknownObject: true })).toMatchObject({ code: "GIT_UNKNOWN_OBJECT", repairReference: true });
    expect(gitDiagnostic({ status: 0, stdout: "partial" })).toMatchObject({ code: "GIT_INVALID_OUTPUT", repairReference: false });
    expect(gitDiagnostic({ status: 0, stdout: "a".repeat(40), objectType: "blob" })).toMatchObject({ code: "GIT_NOT_COMMIT", repairReference: false });
    expect(gitDiagnostic({ status: 128, stdout: "" })).toMatchObject({ code: "GIT_CHECK_FAILED", repairReference: false });
    expect(gitDiagnostic({ status: 0, stdout: "a".repeat(40) })).toMatchObject({ code: "GIT_VERIFIED", state: "verified", repairReference: false });
  });
  test("real Git batch missing output exits zero and still means unknown object", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "am88-git-"));
    try {
      const init = spawnSync("git", ["init", "-q", cwd], { encoding: "utf8" });
      expect(init.error).toBeUndefined();
      expect(init.status).toBe(0);
      const oid = "1".repeat(40);
      const result = spawnSync("git", ["cat-file", "--batch-check"], { cwd, input: oid + "\n", encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(oid + " missing\n");
      expect(gitDiagnostic({ status: result.status, stdout: result.stdout, unknownObject: result.stdout === oid + " missing\n" }, oid)).toMatchObject({ code: "GIT_UNKNOWN_OBJECT", repairReference: true });
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
  test("adoption inventories remain review-only, deterministic, scoped and invalidated by edits", () => {
    const original = corpus("original");
    const saved = JSON.stringify(original);
    for (const mode of ["local", "global"] as const) {
      const plan = adoptionPlan(original, mode);
      expect(plan).toEqual(adoptionPlan(original, mode));
      expect(plan.writesCanonical).toBe(false);
      expect(plan.entries.find(entry => entry.id === "accounts.receipt_retry")?.signals).toContain("GENERIC_SUMMARY");
      expect(plan.entries.every(entry => entry.inferredCategories.length === 0 && entry.verification === "not_run")).toBe(true);
    }
    expect(JSON.stringify(original)).toBe(saved);
    const before = adoptionPlan(original, "local");
    original[0].body += "manual edit";
    expect(adoptionPlan(original, "local").entries[0].fingerprint).not.toBe(before.entries[0].fingerprint);
  });
});
