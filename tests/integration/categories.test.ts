import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { buildAgentManifest, buildContextV2, compileMemory, listCategories, loadConfig, queryClaimsV2, renderConfigTemplate, validateRepository } from "../../packages/core/src/index";
import { dispatch } from "../../packages/cli/src/router";
import { productionFixture, claimPath } from "../fixtures/category-retrieval/production";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const cwd = productionFixture(); roots.push(cwd); return cwd; }
function change(cwd: string, id: string, values: Record<string, unknown>) {
  const file = claimPath(cwd, id); const text = fs.readFileSync(file, "utf8"); const end = text.indexOf("\n---", 4);
  const metadata = parse(text.slice(4, end));
  fs.writeFileSync(file, `---\n${stringify({ ...metadata, ...values })}---${text.slice(end + 4)}`);
}
function config(cwd: string, text: string) { fs.appendFileSync(path.join(cwd, "agent-memory.config.yaml"), text); }
function result(stdout?: string) { return JSON.parse(stdout!); }

describe("repository concern vocabulary and facets", () => {
  test("built-ins and custom vocabulary include zeroes, unique multi-membership and virtual uncategorized", async () => {
    const cwd = fixture(); config(cwd, 'category_vocabulary: {privacy: "Personal-data collection, disclosure and retention"}\n');
    change(cwd, "accounts.receipt_retry", { tags: ["concern:security", "concern:reliability", "concern:privacy", "ordinary"] });
    change(cwd, "legacy.notes", { tags: ["security"] });
    await compileMemory({ cwd });
    const listing = await listCategories({ cwd, counts: true, filters: { systems: ["accounts", "accounts"], statuses: ["current"] } });
    expect(listing.exitCode).toBe(0);
    if (listing.exitCode !== 0) throw new Error(listing.stdout);
    expect(listing.model.categories.map(item => item.slug)).toEqual(["billing", "delivery", "localization", "privacy", "reliability", "security", "uncategorized"]);
    expect(listing.model.categories.find(item => item.slug === "privacy")).toEqual({ slug: "privacy", description: "Personal-data collection, disclosure and retention", count: 1 });
    expect(listing.model.categories.find(item => item.slug === "billing")!.count).toBe(0);
    expect(listing.model.categories.find(item => item.slug === "security")!.count).toBe(2);
    expect(Buffer.byteLength(listing.stdout)).toBe(listing.model.budget.usedBytes);
    expect((await listCategories({ cwd, filters: { systems: undefined, statuses: undefined } })).stdout).toBe((await listCategories({ cwd })).stdout);
    expect((await queryClaimsV2({ cwd, query: "retry", filters: { categories: undefined, tags: undefined, systems: undefined, statuses: undefined } })).exitCode).toBe(0);
    const without = result((await listCategories({ cwd })).stdout);
    expect(without.categories.every((item: object) => !Object.hasOwn(item, "count"))).toBe(true);
    const db = new Database(path.join(cwd, ".agent-memory/memory.sqlite"));
    expect(db.query("SELECT category FROM claim_categories WHERE claim_id = ? ORDER BY category").all("accounts.receipt_retry")).toEqual([{ category: "privacy" }, { category: "reliability" }, { category: "security" }]); db.close();
    expect(loadConfig({ cwd }).config.category_vocabulary).toEqual({ privacy: "Personal-data collection, disclosure and retention" });
    expect(renderConfigTemplate(loadConfig({ cwd }).config)).toContain('"privacy":"Personal-data collection, disclosure and retention"');
  });

  test("upgrade recognizes vocabulary and preserves it through repeated forced support refresh", async () => {
    const cwd = fixture(); config(cwd, 'category_vocabulary: {privacy: "Reviewed extension"}\n');
    const bytes = fs.readFileSync(claimPath(cwd, "accounts.receipt_retry"));
    for (let i = 0; i < 2; i++) {
      const upgraded = await dispatch(["upgrade", "--write", "--force"], { cwd });
      expect(upgraded.exitCode).toBe(0); expect(upgraded.stdout).not.toContain("Unknown config field category_vocabulary");
      expect(loadConfig({ cwd }).config.category_vocabulary).toEqual({ privacy: "Reviewed extension" });
      expect(fs.readFileSync(claimPath(cwd, "accounts.receipt_retry"))).toEqual(bytes);
    }
  });

  test("OR within facets, AND across facets, exact ordinary tags and stable category browse", async () => {
    const cwd = fixture(); change(cwd, "legacy.notes", { tags: ["security"] }); await compileMemory({ cwd });
    const filters = { categories: ["security", "reliability", "security"], systems: ["accounts"], tags: ["concern:security"], statuses: ["current", "current"] };
    const query = await queryClaimsV2({ cwd, filters }); const context = await buildContextV2({ cwd, filters });
    expect(query.exitCode).toBe(0); expect(query.stdout).toBe(context.stdout);
    const model = result(query.stdout); expect(model.mode).toBe("browse"); expect(model.taskMatches).toBe(0);
    expect(model.filters).toEqual({ categories: ["reliability", "security"], systems: ["accounts"], tags: ["concern:security"], statuses: ["current"] });
    expect(model.roots).toEqual(["accounts.diagnostics_retry", "accounts.receipt_retry"]);
    for (const category of ["security", "reliability"]) expect(result((await queryClaimsV2({ cwd, filters: { categories: [category] } })).stdout).roots).toContain("accounts.receipt_retry");
    expect(result((await queryClaimsV2({ cwd, filters: { categories: ["uncategorized"] } })).stdout).roots).toContain("legacy.notes");
    expect(result((await queryClaimsV2({ cwd, filters: { tags: ["security"] } })).stdout).roots).toEqual(["legacy.notes"]);
    expect(result((await queryClaimsV2({ cwd, filters: { tags: ["Security"] } })).stdout).roots).toEqual([]);
    expect(result((await queryClaimsV2({ cwd, filters: { tags: ["unknown"] } })).stdout).claims).toEqual([]);
    for (const filters of [{ categories: ["Security"] }, { tags: ["concern:missing"] }, { categories: ["missing"] }, { systems: ["missing"] }, { statuses: ["CURRENT"] }]) expect((await queryClaimsV2({ cwd, filters })).exitCode).toBe(2);
    expect(result((await queryClaimsV2({ cwd })).stdout).error.code).toBe("INPUT_REQUIRED");
  });

  test("all lifecycle states and default eligible counts", async () => {
    const cwd = fixture();
    for (const status of ["current", "proposed", "needs_review", "stale", "deprecated", "experimental", "needs_verification", "rejected"]) {
      change(cwd, "legacy.notes", { status }); await compileMemory({ cwd });
      const listing = result((await listCategories({ cwd, counts: true, filters: { systems: ["legacy"], statuses: [status] } })).stdout);
      expect(listing.categories.find((item: { slug: string }) => item.slug === "uncategorized").count).toBe(1);
      expect(result((await queryClaimsV2({ cwd, filters: { categories: ["uncategorized"], statuses: [status] } })).stdout).roots).toContain("legacy.notes");
      const defaults = result((await listCategories({ cwd, counts: true, filters: { systems: ["legacy"] } })).stdout);
      expect(defaults.categories.find((item: { slug: string }) => item.slug === "uncategorized").count).toBe(["current", "proposed", "needs_review"].includes(status) ? 1 : 0);
    }
  });

  test("invalid vocabulary, duplicate YAML keys and malformed/unknown/duplicate concern tags fail predictably", () => {
    for (const value of ['[]', '{security: "changed"}', '{uncategorized: "reserved"}', '{Bad: "bad"}', '{bad--slug: "bad"}', `{${"x".repeat(49)}: "long"}`, '{custom: " "}', '{custom: 4}', `{custom: "${"é".repeat(257)}"}`, '{custom: ok, custom: duplicate}']) {
      const cwd = fixture(); config(cwd, `category_vocabulary: ${value}\n`); expect(() => loadConfig({ cwd })).toThrow();
    }
    const cwd = fixture(); config(cwd, `category_vocabulary: {${"x".repeat(48)}: "${"é".repeat(256)}"}\n`); expect(() => loadConfig({ cwd })).not.toThrow();
    for (const tags of [["concern:missing"], ["concern:"], ["concern:Security"], ["concern:uncategorized"], ["concern:security", "concern:security"], [" "]]) {
      change(cwd, "legacy.notes", { tags }); expect(validateRepository({ cwd }).valid).toBe(false);
    }
    change(cwd, "legacy.notes", { tags: ["security"], categories: ["security"] }); expect(validateRepository({ cwd }).errors.some(error => error.code === "claim.categories.unsupported")).toBe(true);
  });

  test("required authorization crosses all facets; missing/inactive/omitted guidance stays incomplete", async () => {
    const cwd = fixture();
    change(cwd, "ingestion.recovery", { tags: ["concern:reliability", "root"] });
    change(cwd, "accounts.receipt_retry", { tags: ["concern:security"], status: "stale" });
    fs.writeFileSync(path.join(cwd, "docs/agent-memory/graph/required.yaml"), stringify({ id: "required", name: "Required", edges: [{ source: "ingestion.recovery", target: "accounts.receipt_retry", relation: "requires" }] }));
    await compileMemory({ cwd });
    const filters = { categories: ["reliability"], tags: ["root"], systems: ["ingestion"], statuses: ["current"] };
    const query = result((await buildContextV2({ cwd, filters })).stdout);
    expect(query.roots).toEqual(["ingestion.recovery"]);
    expect(query.claims.find((item: { id: string }) => item.id === "accounts.receipt_retry").reasons).toContainEqual({ code: "REQUIRED_DEPENDENCY", outsideFilters: ["category", "tag", "system", "status"] });
    expect(query.completeness).toBe("incomplete"); expect(query.warnings).toContain("REQUIRED_CONTEXT_INACTIVE");
    const db = new Database(path.join(cwd, ".agent-memory/memory.sqlite"));
    db.run("INSERT INTO claim_relations VALUES ('accounts.receipt_retry', 'missing', 'requires', NULL, 100, 'explicit', NULL, 0, '{}')"); db.close();
    const missing = result((await queryClaimsV2({ cwd, filters })).stdout); expect(missing.warnings).toContain("REQUIRED_CONTEXT_MISSING");
    const bounded = result((await queryClaimsV2({ cwd, filters, maxBytes: 1024 })).stdout);
    expect(bounded.completeness).toBe("incomplete"); expect(bounded.budget.omitted.requiredClaims).toBeGreaterThan(0);
    const baseline = result((await queryClaimsV2({ cwd, query: "zzznomatchxyz", baseline: true, filters })).stdout);
    expect(baseline.roots.every((id: string) => id === "ingestion.recovery")).toBe(true);
  });

  test("large vocabulary errors retain actionable bounded legal values at the minimum cap", async () => {
    const cwd = fixture(); const vocabulary = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a${i}-${"x".repeat(42)}`, "é".repeat(250)]));
    config(cwd, `category_vocabulary: ${JSON.stringify(vocabulary)}\n`); await compileMemory({ cwd });
    const error = await queryClaimsV2({ cwd, filters: { categories: ["missing"] }, maxBytes: 512 });
    expect(error.exitCode).toBe(2); expect(Buffer.byteLength(error.stdout)).toBeLessThanOrEqual(512);
    expect(result(error.stdout).error.message).toContain("agent-memory categories list");
    expect(result(error.stdout).error.message).toContain("Legal values");
    const list = await listCategories({ cwd, maxBytes: 1024 }); expect(list.exitCode).toBe(7);
    expect(Buffer.byteLength(list.stdout)).toBeLessThanOrEqual(1024);
  });

  test("CLI version/options, whole vocabulary/filter byte caps, help and manifest agree", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    for (const args of [["categories", "list", "--counts", "--json"], ["categories", "list", "--format-version", "2", "--json"], ["query", "--format-version", "2", "--category", "security", "--json"]]) expect((await dispatch(args, { cwd })).exitCode).toBe(0);
    expect(result((await dispatch(["query", "--category", "security", "--json"], { cwd })).stdout).error.code).toBe("FORMAT_VERSION_REQUIRED");
    for (const args of [["categories", "list", "--counts", "--counts"], ["categories", "list", "--format-version", "1"], ["categories", "list", "--category", "security"], ["categories", "list", "--json=true"], ["categories", "list", "--status"], ["query", "--format-version", "2", "--category", "security", "--baseline", "--no-baseline"], ["context", "--format-version", "2", "--category", "security", "--task", "a", "--task", "b"], ["query", "--format-version", "2", "--include-stale"], ["query", "--format-version", "2", "a", "b"]]) expect((await dispatch(args, { cwd })).exitCode).toBe(2);
    const full = await listCategories({ cwd, counts: true }); expect(full.exitCode).toBe(0);
    if (full.exitCode !== 0) throw new Error(full.stdout);
    // Fixed point includes the decimal width of both budget fields.
    let cap = full.model.budget.usedBytes;
    for (let i = 0; i < 3; i++) { const candidate = await listCategories({ cwd, counts: true, maxBytes: cap }); if (candidate.exitCode === 0) cap = candidate.model.budget.usedBytes; }
    expect((await listCategories({ cwd, counts: true, maxBytes: cap })).exitCode).toBe(0);
    expect((await listCategories({ cwd, counts: true, maxBytes: cap - 1 })).exitCode).toBe(7);
    for (const json of [[], ["--json"]]) {
      const response = await dispatch(["categories", "list", "--max-bytes", "1024", ...json], { cwd }); expect(Buffer.byteLength(response.stdout!)).toBeLessThanOrEqual(1024);
      const error = await dispatch(["categories", "list", `--${"x".repeat(4000)}`, "--max-bytes", "512", ...json], { cwd }); expect(Buffer.byteLength(error.stdout!)).toBeLessThanOrEqual(512);
    }
    const huge = await queryClaimsV2({ cwd, filters: { tags: Array.from({ length: 200 }, (_, i) => `ordinary-${i}-${"é".repeat(20)}`) }, maxBytes: 1024 }); expect(huge.exitCode).toBe(7); expect(Buffer.byteLength(huge.stdout)).toBeLessThanOrEqual(1024);
    expect((await dispatch(["help", "categories"])).stdout).toContain("--counts");
    expect((await dispatch(["help", "query"])).stdout).toContain("--category/--tag");
    expect(buildAgentManifest({ cwd }).commands.some(command => command.name === "categories")).toBe(true);
    expect(buildAgentManifest({ cwd }).capabilities.categories.format_version).toBe(2);
  });
});
