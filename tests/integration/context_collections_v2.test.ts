import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { buildContextV2, queryClaimsV2, compileMemory, createPlanRun, type ContextOutputResult } from "../../packages/core/src/index";
import { dispatch } from "../../packages/cli/src/router";
import { productionFixture, claimPath } from "../fixtures/category-retrieval/production";
const roots: string[] = [];
afterEach(() => { for (const cwd of roots.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });
function fixture() { const cwd = productionFixture(); roots.push(cwd); return cwd; }
function yaml(cwd: string, relative: string, value: unknown) { const file = path.join(cwd, "docs/agent-memory", relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, stringify(value)); }
function workflows(cwd: string) {
  yaml(cwd, "recipes/retry.yaml", { id: "recipe.accounts.retry", title: "Review receipt safely", system: "accounts", status: "current", intent_triggers: ["recipeonly"], required_claims: ["accounts.receipt_retry"], relevant_files: ["src/receipts-controller.ts"], steps: ["Inspect receipt"], verification: ["do-not-execute-this-command"] });
  yaml(cwd, "plans/retry.yaml", { id: "plan_template.accounts.retry", title: "Receipt review", system: "accounts", status: "current", stages: [{ id: "inspect", title: "Inspect", goal: "Inspect receipt", claim_refs: ["identity.rotation"], recipe_refs: ["recipe.accounts.retry"], profile_traits: ["profile_trait.review.concise"], source_files: [], verification: ["do-not-execute-this-command"] }] });
  yaml(cwd, "profiles/review.yaml", { id: "profile_trait.review.concise", title: "Concise findings", status: "current", category: "output_contract", priority: "high", applies_when: { aliases: ["review"] }, snippet: "Report concrete findings." });
}
function success(result: ContextOutputResult) { if (result.exitCode !== 0) throw new Error(result.stdout); expect(Buffer.byteLength(result.stdout)).toBe(result.model.budget.usedBytes); return result.model; }

test("context distinguishes empty/nonmatching while query collections remain not requested", async () => {
  const cwd = fixture(); await compileMemory({ cwd });
  expect(success(await buildContextV2({ cwd, task: "zzznomatchxyz" })).recipes.state).toBe("empty");
  workflows(cwd); await compileMemory({ cwd });
  const output = success(await buildContextV2({ cwd, task: "zzznomatchxyz" }));
  for (const kind of ["recipes", "plans", "profiles"] as const) expect(output[kind]).toMatchObject({ totalEligible: 1, matched: 0, state: "no_match" });
  const query = success(await queryClaimsV2({ cwd, query: "recipeonly" }));
  for (const kind of ["recipes", "plans", "profiles"] as const) expect(query[kind].state).toBe("not_requested");
});
test("recipe and plan obligations cross filters, limits and cycles with provenance-linked inert suggestions", async () => {
  const cwd = fixture(); workflows(cwd); await compileMemory({ cwd });
  const output = success(await buildContextV2({ cwd, task: "recipeonly", planId: "plan_template.accounts.retry", stageId: "inspect", filters: { categories: ["billing"] }, limit: 1, depth: 0, budget: "full" }));
  expect(output.recipes).toMatchObject({ totalEligible: 1, matched: 1, state: "matched" });
  expect(output.plans.state).toBe("matched"); expect(output.profiles.state).toBe("matched");
  expect(output.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(["accounts.receipt_retry", "ingestion.outbox", "identity.rotation", "identity.overlap"]));
  expect(output.claims.find(claim => claim.id === "accounts.receipt_retry")?.reasons).toContainEqual({ code: "REQUIRED_DEPENDENCY", outsideFilters: ["category"] });
  const command = output.commands.find(command => command.value === "do-not-execute-this-command")!;
  expect(command.state).toBe("suggested_not_run"); expect(command.origins.map(origin => origin.kind).sort()).toEqual(["plan", "recipe"]);
  expect(command.origins.every(origin => origin.sourcePath.startsWith("docs/agent-memory/"))).toBe(true);
  const cli = await dispatch(["context", "--format-version", "2", "--plan", "plan_template.accounts.retry", "--stage", "inspect", "--recipe", "recipe.accounts.retry", "--profile", "review", "--profile-trait", "profile_trait.review.concise", "--json", "--budget", "full"], { cwd });
  expect(cli.exitCode).toBe(0); expect(JSON.parse(cli.stdout!).profiles.items[0].data.snippet).toBe("Report concrete findings.");
  expect((await dispatch(["query", "--format-version", "2", "--recipe", "recipe.accounts.retry"], { cwd })).exitCode).toBe(2);
});
test("ineligible collections retain selector semantics and explicitly selected inactive recipes still oblige", async () => {
  const cwd = fixture(); workflows(cwd);
  const recipe = path.join(cwd, "docs/agent-memory/recipes/retry.yaml"); fs.writeFileSync(recipe, fs.readFileSync(recipe, "utf8").replace("status: current", "status: stale"));
  await compileMemory({ cwd });
  expect(success(await buildContextV2({ cwd, task: "recipeonly" })).recipes.state).toBe("empty");
  expect(success(await buildContextV2({ cwd, recipeIds: ["recipe.accounts.retry"], task: "zzznomatchxyz", budget: "full" })).recipes.items[0].data.status).toBe("stale");
});
test("missing and inactive collection obligations remain incomplete even when their collection is omitted", async () => {
  const cwd = fixture(); workflows(cwd);
  const file = claimPath(cwd, "ingestion.outbox"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("status: current", "status: stale"));
  await compileMemory({ cwd });
  const db = new Database(path.join(cwd, ".agent-memory/memory.sqlite"));
  db.run("INSERT INTO claim_relations VALUES (?, ?, 'requires', NULL, 100, 'explicit', NULL, 0, '{}')", ["accounts.receipt_retry", "missing.required"]); db.close();
  const full = success(await buildContextV2({ cwd, recipeIds: ["recipe.accounts.retry"], task: "zzznomatchxyz", budget: "full" }));
  expect(full.completeness).toBe("incomplete"); expect(full.warnings).toContain("REQUIRED_CONTEXT_MISSING"); expect(full.warnings).toContain("REQUIRED_CONTEXT_INACTIVE");
  const tiny = success(await buildContextV2({ cwd, recipeIds: ["recipe.accounts.retry"], task: "zzznomatchxyz", maxBytes: 1500 }));
  expect(tiny.budget.usedBytes).toBeLessThanOrEqual(1500); expect(tiny.completeness).toBe("incomplete"); expect(tiny.budget.omitted.requiredClaims).toBeGreaterThan(0); expect(tiny.budget.omitted.recipes).toBeGreaterThan(0);
});

test("explicit recipe-only selectors never seed an unrelated unfiltered browse", async () => {
  const cwd = fixture(); workflows(cwd);
  yaml(cwd, "recipes/identity.yaml", { id: "recipe.identity.other", title: "Other", system: "identity", status: "current", required_claims: ["identity.rotation"], steps: ["Inspect"], verification: [] });
  await compileMemory({ cwd });
  const output = success(await buildContextV2({ cwd, recipeIds: ["recipe.accounts.retry"], budget: "full" }));
  expect(output.roots).toEqual([]); expect(output.recipes.items.map(item => item.id)).toEqual(["recipe.accounts.retry"]);
  expect(output.claims.some(claim => claim.system === "identity")).toBe(false);
});

test("profiles see optional related context and inactive selected plans retain exact source provenance", async () => {
  const cwd = fixture(); workflows(cwd);
  yaml(cwd, "graph/optional.yaml", { id: "optional", name: "Optional", edges: [{ source: "accounts.receipt_retry", target: "identity.rotation", relation: "same_area", reason: "Related identity" }] });
  yaml(cwd, "profiles/identity.yaml", { id: "profile_trait.identity.review", title: "Identity constraints", status: "current", category: "risk_lens", priority: "high", applies_when: { systems: ["identity"] }, snippet: "Inspect key lifetime." });
  const planPath = path.join(cwd, "docs/agent-memory/plans/retry.yaml"); fs.writeFileSync(planPath, fs.readFileSync(planPath, "utf8").replace("status: current", "status: stale"));
  await compileMemory({ cwd });
  const optional = success(await buildContextV2({ cwd, task: "receipt", depth: 1, budget: "full" }));
  expect(optional.claims.some(claim => claim.id === "identity.rotation")).toBe(true);
  expect(optional.profiles.items.some(item => item.id === "profile_trait.identity.review")).toBe(true);
  const selected = success(await buildContextV2({ cwd, planId: "plan_template.accounts.retry", budget: "full" }));
  expect(selected.plans.items[0].sourcePath).toBe("docs/agent-memory/plans/retry.yaml");
  expect(selected.commands.flatMap(command => command.origins).find(origin => origin.kind === "plan")?.sourcePath).toBe("docs/agent-memory/plans/retry.yaml");
});

test("selector obligations seed optional expansion and plan claims discover related recipes", async () => {
  const cwd = fixture(); workflows(cwd);
  yaml(cwd, "graph/optional.yaml", { id: "optional", name: "Optional", edges: [{ source: "accounts.receipt_retry", target: "identity.rotation", relation: "same_area", reason: "Related identity" }] });
  yaml(cwd, "profiles/identity.yaml", { id: "profile_trait.identity.review", title: "Identity constraints", status: "current", category: "risk_lens", priority: "high", applies_when: { systems: ["identity"] }, snippet: "Inspect key lifetime." });
  yaml(cwd, "plans/claims.yaml", { id: "plan_template.accounts.claims", title: "Plan claims", system: "accounts", status: "current", stages: [{ id: "inspect", title: "Inspect", goal: "Inspect", claim_refs: ["accounts.receipt_retry"], recipe_refs: [], source_files: [] }] });
  await compileMemory({ cwd });
  for (const selectors of [{ recipeIds: ["recipe.accounts.retry"] }, { planId: "plan_template.accounts.claims" }]) {
    const output = success(await buildContextV2({ cwd, ...selectors, depth: 1, budget: "full" }));
    expect(output.claims.some(claim => claim.id === "identity.rotation")).toBe(true);
    expect(output.profiles.items.some(item => item.id === "profile_trait.identity.review")).toBe(true);
    expect(output.recipes.items.some(item => item.id === "recipe.accounts.retry")).toBe(true);
  }
  const filtered = success(await buildContextV2({ cwd, recipeIds: ["recipe.accounts.retry"], filters: { systems: ["accounts"] }, depth: 1, budget: "full" }));
  expect(filtered.claims.some(claim => claim.id === "identity.rotation")).toBe(false);
});

test("text matches beyond the legacy recipe candidate cap retain every required closure", async () => {
  const cwd = fixture();
  for (let i = 0; i < 25; i++) yaml(cwd, `recipes/row${i}.yaml`, { id: `recipe.accounts.row${i.toString().padStart(2, "0")}`, title: "Workflowtoken", system: "accounts", status: "current", required_claims: [i === 24 ? "identity.rotation" : "accounts.receipt_retry"], steps: ["Inspect"], verification: [] });
  await compileMemory({ cwd });
  const output = success(await buildContextV2({ cwd, task: "Workflowtoken", budget: "full" }));
  expect(output.recipes.matched).toBe(25); expect(output.recipes.totalEligible).toBe(25);
  expect(output.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(["identity.rotation", "identity.overlap"]));
  expect(output.completeness).toBe("complete");
  const capped = success(await buildContextV2({ cwd, task: "Workflowtoken", maxBytes: 1500 }));
  expect(capped.recipes.matched).toBe(25); expect(capped.budget.omitted.recipes).toBeGreaterThan(0); expect(capped.completeness).toBe("incomplete");
});

test("workflow suggestions cannot escape lexical or symlink checkout boundaries", async () => {
  const cwd = fixture(); const outside = fixture();
  fs.symlinkSync(path.join(outside, "src"), path.join(cwd, "src/escape"), "dir");
  yaml(cwd, "recipes/unsafe.yaml", { id: "recipe.accounts.unsafe", title: "Inspect paths", system: "accounts", status: "current", required_claims: [], relevant_files: ["../../outside-checkout.txt", path.join(outside, "src/receipts-controller.ts"), "src/escape/receipts-controller.ts", "src/receipts-controller.ts"], steps: ["Inspect"], verification: [] });
  await compileMemory({ cwd });
  const output = success(await buildContextV2({ cwd, recipeIds: ["recipe.accounts.unsafe"], budget: "full" }));
  expect(output.files.map(file => file.value)).toEqual(["src/receipts-controller.ts"]);
});

test("saved plans referencing deleted recipes cannot report complete context", async () => {
  const cwd = fixture(); workflows(cwd); await compileMemory({ cwd });
  const saved = await createPlanRun({ cwd, task: "Inspect", templateId: "plan_template.accounts.retry" });
  fs.unlinkSync(path.join(cwd, "docs/agent-memory/recipes/retry.yaml"));
  fs.unlinkSync(path.join(cwd, "docs/agent-memory/plans/retry.yaml"));
  await compileMemory({ cwd });
  const result = await buildContextV2({ cwd, planId: saved.run.id, budget: "full" });
  expect(result.exitCode).toBe(2); expect(result.model).toMatchObject({ error: { code: "INVALID_INPUT", message: expect.stringContaining("missing recipes") } });
});
test("disabled diagnostics do not evict selected profile guidance under a byte cap", async () => {
  const cwd = fixture();
  fs.appendFileSync(path.join(cwd, "agent-memory.config.yaml"), "context:\n  include_profile_diagnostics: false\n  include_recipe_diagnostics: false\n");
  for (let i = 0; i < 25; i++) yaml(cwd, `profiles/p${i}.yaml`, { id: `profile_trait.review.p${i.toString().padStart(2, "0")}`, title: `Profile ${i}`, status: "current", category: "output_contract", priority: i === 0 ? "critical" : "normal", applies_when: { aliases: ["review"] }, snippet: "Report concrete findings.", conflicts_with: i === 0 ? [] : ["profile_trait.review.p00"] });
  await compileMemory({ cwd });
  const output = success(await buildContextV2({ cwd, profileAlias: "review", maxBytes: 2000 }));
  expect(output.profiles.items).toHaveLength(1); expect(output.profiles.items[0].id).toBe("profile_trait.review.p00");
  expect(output.profiles.items[0].data.diagnostics).toBeUndefined(); expect(output.profiles.items[0].data.droppedTraits).toBeUndefined();
  expect(output.budget.omitted.profiles).toBe(0);
  workflows(cwd); await compileMemory({ cwd });
  expect(success(await buildContextV2({ cwd, recipeIds: ["recipe.accounts.retry"], budget: "full" })).recipes.items[0].data.reasons).toEqual([]);
});

test("missing collection selectors are input errors rather than invalid canonical memory", async () => {
  const cwd = fixture(); workflows(cwd); await compileMemory({ cwd });
  for (const selectors of [{ planId: "plan_template.missing" }, { planId: "plan_template.accounts.retry", stageId: "missing" }, { profileTraitIds: ["profile_trait.missing"] }, { recipeIds: ["recipe.missing"] }]) {
    const result = await buildContextV2({ cwd, ...selectors, maxBytes: 512 });
    expect(result.exitCode).toBe(2); expect(result.model).toMatchObject({ error: { code: "INVALID_INPUT" } }); expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(512);
  }
  expect((await dispatch(["context", "--format-version", "2", "--plan", "plan_template.missing", "--json"], { cwd })).exitCode).toBe(2);
});

test("plan selectors preserve missing and stale cache recovery errors", async () => {
  const cwd = fixture(); workflows(cwd);
  const missing = await buildContextV2({ cwd, planId: "plan_template.accounts.retry" });
  expect(missing.exitCode).toBe(3); expect(missing.model).toMatchObject({ error: { code: "CACHE_MISSING" } });
  await compileMemory({ cwd });
  fs.appendFileSync(path.join(cwd, "docs/agent-memory/plans/retry.yaml"), "\n# Changed canonical template\n");
  const stale = await buildContextV2({ cwd, planId: "plan_template.accounts.retry" });
  expect(stale.exitCode).toBe(5); expect(stale.model).toMatchObject({ error: { code: "CACHE_STALE" } });
});
