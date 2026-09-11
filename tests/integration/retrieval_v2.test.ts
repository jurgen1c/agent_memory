import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileMemory, queryClaimsV2, buildContextV2, showClaimV2, queryClaims, showClaim, parseClaimSections, claimBodyDigest, type ContextOutputResult } from "../../packages/core/src/index";
import { dispatch } from "../../packages/cli/src/router";
import { productionFixture, claimPath } from "../fixtures/category-retrieval/production";
import { requiredIds, tasks } from "../fixtures/category-retrieval/corpus";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(variant: "original" | "corrected" = "corrected") { const root = productionFixture(variant); roots.push(root); return root; }
function success(result: ContextOutputResult) { expect(result.exitCode).toBe(0); if (result.exitCode !== 0) throw new Error(result.stdout); expect(Buffer.byteLength(result.stdout)).toBe(result.model.budget.usedBytes); return result.model; }
function database(cwd: string) { return new Database(path.join(cwd, ".agent-memory/memory.sqlite")); }

describe("production v2 retrieval", () => {
  test("corrected full, short and file tasks retain complete authored retry guidance in medium", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    for (const request of [{ task: tasks.full }, { task: tasks.short }, { changedFiles: ["src/receipts-controller.ts", "src/diagnostics-controller.ts"] }, { task: tasks.full, changedFiles: ["src/receipts-controller.ts", "src/diagnostics-controller.ts"] }]) {
      const result = success(await buildContextV2({ cwd, ...request, budget: "medium" }));
      expect(result.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(requiredIds));
      expect(result.completeness).toBe("complete");
      expect(result.budget.usedBytes).toBeLessThanOrEqual(16384);
      if (request.changedFiles) {
        expect(result.roots.slice(0, 2).sort()).toEqual(["accounts.diagnostics_retry", "accounts.receipt_retry"]);
        for (const id of result.roots.slice(0, 2)) expect(result.claims.find(claim => claim.id === id)!.evidence!.tier).toBe(1);
      }
      const receipt = result.claims.find(claim => claim.id === "accounts.receipt_retry")!;
      expect(receipt.sourcePath).toBe("docs/agent-memory/claims/accounts.receipt_retry.md");
      expect(receipt.sections.some(section => section.text.includes("actor_user_id(owner|admin)"))).toBe(true);
      expect(receipt.sections.some(section => section.text.includes("attempts_exhausted"))).toBe(true);
      expect(receipt.bodySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.cacheFreshness).toBe("current");
      expect(receipt.claim).not.toContain("owner|admin");
    }
  });

  test("unchanged defective corpus body search and source curation are separate gains", async () => {
    const cwd = fixture("original"); await compileMemory({ cwd });
    expect((await queryClaims({ cwd, query: "actor_user_id", limit: 20, includeStale: false })).matches).toEqual([]);
    const body = success(await queryClaimsV2({ cwd, query: "actor_user_id" }));
    expect(body.taskMatches).toBeGreaterThan(0);
    expect(body.claims.find(claim => claim.id === "accounts.receipt_retry")!.evidence!.fields.some(field => field.field === "body")).toBe(true);
    const originalFiles = success(await queryClaimsV2({ cwd, changedFiles: ["src/receipts-controller.ts"] }));
    expect(originalFiles.taskMatches).toBe(0);
    expect(originalFiles.claims.every(claim => claim.evidence?.tier !== 1)).toBe(true);
    const unchangedBodies = body.claims.map(claim => [claim.id, claim.bodySha256]);
    const corrected = fixture(); await compileMemory({ cwd: corrected });
    const correctedFiles = success(await queryClaimsV2({ cwd: corrected, changedFiles: ["src/receipts-controller.ts"] }));
    expect(correctedFiles.roots[0]).toBe("accounts.receipt_retry");
    expect(correctedFiles.claims.find(claim => claim.id === "accounts.receipt_retry")!.evidence!.tier).toBe(1);
    for (const [id, digest] of unchangedBodies) expect(success(await showClaimV2({ cwd: corrected, id: id! })).claims[0].bodySha256).toBe(digest);
  });

  test("symbols/routes/related files and watched membership have independent tiers and multiple reasons", async () => {
    const cwd = fixture();
    const file = claimPath(cwd, "accounts.receipt_retry");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('source_files:', 'symbols: [RetryReceipt]\nroutes: ["POST /retry"]\nrelated_files: [src/helper.ts]\nsource_files:'));
    fs.writeFileSync(path.join(cwd, "src/helper.ts"), "// helper\n");
    // A second index watches the input but excludes every claim: it grants no exact rank.
    fs.writeFileSync(path.join(cwd, "docs/agent-memory/indexes/other.yaml"), 'id: other\nname: Other\nwatched_files: [src/**]\nclaim_globs: [nothing/**]\n');
    await compileMemory({ cwd });
    for (const request of [{ symbols: ["RetryReceipt"] }, { routes: ["POST /retry"] }]) {
      const result = success(await queryClaimsV2({ cwd, ...request }));
      expect(result.roots[0]).toBe("accounts.receipt_retry");
      expect(result.claims[0].evidence!.tier).toBe(1);
    }
    const related = success(await queryClaimsV2({ cwd, changedFiles: ["src/helper.ts"] }));
    expect(related.claims[0].evidence!.tier).toBe(3);
    expect(related.taskMatches).toBe(0);
    const many = success(await queryClaimsV2({ cwd, query: "receipt", symbols: ["RetryReceipt"], routes: ["POST /retry"], changedFiles: ["src/receipts-controller.ts"] }));
    expect(many.claims[0].reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(["EXACT_SOURCE", "EXACT_SYMBOL", "EXACT_ROUTE", "TEXT_MATCH", "WATCHED_INDEX"]));
    expect(many.claims.find(claim => claim.id === "aaa.storage")!.evidence!.tier).not.toBe(1);
  });

  test("Unicode prefix OR input, task limits, deterministic ties, no-match and held-out identity", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    const first = await queryClaimsV2({ cwd, query: "ＲＥＣＥＩＰＴ retry retry" });
    expect(first.stdout).toBe((await queryClaimsV2({ cwd, query: "retry receipt" })).stdout);
    const noMatch = success(await queryClaimsV2({ cwd, query: "zzznomatchxyz" }));
    expect(noMatch.taskMatches).toBe(0); expect(noMatch.claims).toEqual([]); expect(noMatch.warnings).toContain("NO_TASK_MATCH");
    const heldOut = success(await buildContextV2({ cwd, task: tasks.heldOut }));
    expect(heldOut.roots[0]).toBe("identity.rotation");
    expect(heldOut.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(["identity.rotation", "identity.overlap"]));
    expect(heldOut.completeness).toBe("complete");
    expect((await queryClaimsV2({ cwd, query: "x".repeat(65537) })).exitCode).toBe(2);
    expect((await queryClaimsV2({ cwd, query: "x".repeat(65536) })).exitCode).toBe(0);
    expect((await queryClaimsV2({ cwd, query: '" OR NEAR(*) - claim:*' })).exitCode).toBe(0);
  });

  test("required cycles, missing targets and inactive/outside-filter guidance survive depth zero and limit one", async () => {
    const cwd = fixture();
    const inactive = claimPath(cwd, "ingestion.outbox");
    fs.writeFileSync(inactive, fs.readFileSync(inactive, "utf8").replace('status: current', 'status: stale'));
    await compileMemory({ cwd });
    const db = database(cwd);
    db.run("INSERT INTO claim_relations VALUES (?, ?, 'requires', NULL, 100, 'explicit', NULL, 0, '{}')", ["ingestion.outbox", "accounts.receipt_retry"]);
    db.run("INSERT INTO claim_relations VALUES (?, ?, 'requires', NULL, 100, 'explicit', NULL, 0, '{}')", ["ingestion.outbox", "missing.guidance"]);
    db.close();
    const result = success(await queryClaimsV2({ cwd, symbols: [], changedFiles: ["src/receipts-controller.ts"], filters: { systems: ["accounts"], statuses: ["current"] }, depth: 0, limit: 1 }));
    expect(result.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(requiredIds));
    expect(new Set(result.claims.map(claim => claim.id)).size).toBe(result.claims.length);
    expect(result.completeness).toBe("incomplete");
    expect(result.warnings).toContain("REQUIRED_CONTEXT_MISSING");
    expect(result.warnings).toContain("REQUIRED_CONTEXT_INACTIVE");
    expect(result.claims.find(claim => claim.id === "ingestion.outbox")!.reasons).toContainEqual({ code: "REQUIRED_DEPENDENCY", outsideFilters: ["system", "status"] });
  });

  test("inferred output honors the flag and fallback roots honor the optional limit", async () => {
    const cwd = fixture();
    for (const id of ["aaa.storage", "accounts.receipt_retry", "identity.rotation"]) {
      const file = claimPath(cwd, id);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/severity: \w+/, "severity: critical"));
    }
    await compileMemory({ cwd });
    const without = success(await queryClaimsV2({ cwd, query: "receipt retry", includeInferred: false }));
    expect(without.edges.every(edge => edge.origin === "explicit")).toBe(true);
    const withInferred = success(await queryClaimsV2({ cwd, query: "receipt retry", includeInferred: true }));
    expect(withInferred.edges.some(edge => edge.origin === "inferred")).toBe(true);
    const baseline = success(await queryClaimsV2({ cwd, query: "zzznomatchxyz", baseline: true, limit: 1 }));
    expect(baseline.roots).toHaveLength(1);
    expect(baseline.taskMatches).toBe(0);
    expect(baseline.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(["ingestion.outbox", "identity.overlap"]));
  });

  test("a symlinked non-Git directory reads a freshly compiled local cache", async () => {
    const cwd = fixture(); fs.rmSync(path.join(cwd, ".git"), { recursive: true });
    const alias = `${cwd}-alias`; fs.symlinkSync(cwd, alias); roots.push(alias);
    await compileMemory({ cwd: alias });
    expect((await queryClaimsV2({ cwd: alias, query: "retry" })).exitCode).toBe(0);
    expect((await queryClaimsV2({ cwd, query: "retry" })).exitCode).toBe(0);
  });

  test("optional root limits preserve obligations of removed ranked roots and full match count", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    const unlimited = success(await queryClaimsV2({ cwd, query: tasks.heldOut }));
    const limited = success(await queryClaimsV2({ cwd, query: tasks.heldOut, limit: 1, depth: 0 }));
    expect(limited.roots.length).toBe(1);
    expect(limited.taskMatches).toBe(unlimited.taskMatches);
    expect(limited.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(unlimited.claims.filter(claim => claim.reasons.some(reason => reason.code === "REQUIRED_DEPENDENCY")).map(claim => claim.id)));
    expect(limited.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(["identity.overlap", "ingestion.outbox"]));
    const expanded = success(await queryClaimsV2({ cwd, query: "actor_user_id", limit: 1, depth: 1, includeInferred: true }));
    expect(expanded.roots).toEqual(["accounts.receipt_retry"]);
    expect(expanded.claims.map(claim => claim.id)).toEqual(expect.arrayContaining(requiredIds));
  });

  test("CommonMark sections and complete show retain exact text and metadata or reject undersized cap", async () => {
    const cwd = fixture();
    const file = claimPath(cwd, "accounts.receipt_retry");
    const original = fs.readFileSync(file, "utf8");
    const marker = path.join(cwd, "never-run");
    const extra = '\nPreamble\n\nTitle *emphasis*\n===\n\n~~~md\n# Not a heading\n~~~\n\n    # Indented code\n\n## Same\nfirst\n## Same\nsecond\n\n<script>\n# HTML block\n</script>\n';
    fs.writeFileSync(file, original + extra + `\n\`touch ${marker}\`\n`);
    await compileMemory({ cwd });
    const result = success(await showClaimV2({ cwd, id: "accounts.receipt_retry", budget: "full" }));
    const claim = result.claims[0];
    expect(claim.bodySha256).toBe(claimBodyDigest(claim.body!));
    expect(claim.sections.map(section => section.text).join("")).toBe(claim.body);
    expect(claim.sections.map(section => section.heading)).toContain("Title emphasis");
    expect(claim.sections.map(section => section.heading)).not.toContain("Not a heading");
    expect(claim.sections.map(section => section.heading)).not.toContain("Indented code");
    expect(claim.sections.map(section => section.heading)).not.toContain("HTML block");
    expect(claim.sections.filter(section => section.heading === "Same").map(section => section.occurrence)).toEqual([1, 2]);
    expect(claim.metadata!.source_files).toEqual(["src/receipts-controller.ts"]);
    expect((await showClaimV2({ cwd, id: claim.id, maxBytes: result.budget.usedBytes - 2 })).model).toEqual({ schemaVersion: 2, error: { code: "BUDGET_TOO_SMALL" } });
    const exact = success(await showClaimV2({ cwd, id: claim.id, maxBytes: result.budget.usedBytes - 1 }));
    expect(exact.budget.usedBytes).toBe(exact.budget.maxBytes);
    expect(fs.existsSync(marker)).toBe(false);
    const legacy = await showClaim({ cwd, id: claim.id, includeRelated: false, depth: 0 });
    expect(legacy.claim).not.toHaveProperty("body");
    expect(legacy.claim).not.toHaveProperty("body_sha256");
    expect(parseClaimSections("intro\r\n\r\n# Head\r\ntext\r\n")).toEqual([{ heading: "preamble", occurrence: 1, startLine: 1, text: "intro\n\n" }, { heading: "Head", occurrence: 1, startLine: 3, text: "# Head\ntext\n" }]);
  });

  test("missing/stale/schema caches refuse retrieval; atomic invalid rebuild preserves prior database", async () => {
    const cwd = fixture();
    expect((await queryClaimsV2({ cwd, query: "retry" })).exitCode).toBe(3);
    await compileMemory({ cwd });
    const file = claimPath(cwd, "accounts.receipt_retry");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original + "\nnew body\n");
    expect((await showClaimV2({ cwd, id: "accounts.receipt_retry" })).model).toMatchObject({ error: { code: "CACHE_STALE" } });
    const bytes = fs.readFileSync(path.join(cwd, ".agent-memory/memory.sqlite"));
    fs.writeFileSync(file, "invalid markdown");
    await expect(compileMemory({ cwd })).rejects.toThrow();
    expect(fs.readFileSync(path.join(cwd, ".agent-memory/memory.sqlite"))).toEqual(bytes);
    fs.writeFileSync(file, original);
    const db = database(cwd); db.run("UPDATE compile_metadata SET value = '1' WHERE key = 'schema_version'"); db.close();
    expect((await queryClaimsV2({ cwd, query: "retry" })).model).toMatchObject({ error: { code: "CACHE_SCHEMA_UNSUPPORTED" } });
    await compileMemory({ cwd }); expect((await queryClaimsV2({ cwd, query: "retry" })).exitCode).toBe(0);
    const corrupt = database(cwd); corrupt.run("UPDATE claim_bodies SET body = body || 'changed' WHERE claim_id = 'accounts.receipt_retry'"); corrupt.close();
    expect((await showClaimV2({ cwd, id: "accounts.receipt_retry" })).model).toMatchObject({ error: { code: "CACHE_STALE" } });
  });

  test("snapshot races and atomic rename failures retain a recoverable prior cache", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    const dbPath = path.join(cwd, ".agent-memory/memory.sqlite");
    const before = fs.readFileSync(dbPath);
    const file = claimPath(cwd, "accounts.receipt_retry");
    const original = fs.readFileSync(file, "utf8");
    const compiling = compileMemory({ cwd });
    fs.writeFileSync(file, original + "\nConcurrent edit\n");
    await expect(compiling).rejects.toThrow("changed during compilation");
    expect(fs.readFileSync(dbPath)).toEqual(before);
    fs.writeFileSync(file, original);
    const rename = fs.renameSync;
    const failInstall = spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source).endsWith(".tmp") && String(target) === dbPath) throw new Error("Injected atomic installation failure");
      return rename(source, target);
    });
    try { await expect(compileMemory({ cwd })).rejects.toThrow("Injected atomic installation failure"); }
    finally { failInstall.mockRestore(); }
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect((await queryClaimsV2({ cwd, query: "retry" })).exitCode).toBe(0);
    expect(fs.readdirSync(path.dirname(dbPath))).toEqual(["memory.sqlite"]);
  });

  test("selected local and independent global consumers cannot hydrate another checkout", async () => {
    const local = fixture(); const other = fixture();
    await compileMemory({ cwd: local }); await compileMemory({ cwd: other });
    fs.copyFileSync(path.join(local, ".agent-memory/memory.sqlite"), path.join(other, ".agent-memory/memory.sqlite"));
    expect((await queryClaimsV2({ cwd: other, query: "retry" })).model).toMatchObject({ error: { code: "CACHE_STALE" } });
    const priorHome = process.env.AGENT_MEMORY_HOME;
    const home = path.join(local, "isolated-global-home"); process.env.AGENT_MEMORY_HOME = home;
    try {
      for (const [cwd, key] of [[local, "first-consumer"], [other, "second-consumer"]]) {
        const config = path.join(cwd, "agent-memory.config.yaml");
        fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("version: 1", `version: 2\ndatabase_scope: global\nmemory_key: ${key}`));
      }
      const first = await compileMemory({ cwd: local }); const second = await compileMemory({ cwd: other });
      expect(first.databasePath).not.toBe(second.databasePath);
      const bytes = fs.readFileSync(second.databasePath);
      fs.appendFileSync(claimPath(local, "accounts.receipt_retry"), "\nOnly first checkout changes.\n");
      expect((await queryClaimsV2({ cwd: local, query: "retry" })).exitCode).toBe(5);
      expect((await queryClaimsV2({ cwd: other, query: "retry" })).exitCode).toBe(0);
      await compileMemory({ cwd: local });
      expect(fs.readFileSync(second.databasePath)).toEqual(bytes);
      fs.copyFileSync(first.databasePath, second.databasePath);
      expect((await showClaimV2({ cwd: other, id: "accounts.receipt_retry" })).exitCode).toBe(5);
    } finally { if (priorHome === undefined) delete process.env.AGENT_MEMORY_HOME; else process.env.AGENT_MEMORY_HOME = priorHome; }
  });

  test("category/tag CLI flags use v2 and remain unavailable to v1/show", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    for (const flag of ["--category", "--tag"]) {
      const result = await dispatch(["query", "--format-version", "2", flag, "security", "--json"], { cwd });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout!).mode).toBe("browse");
      expect((await dispatch(["query", flag, "security", "--json"], { cwd })).exitCode).toBe(2);
      expect((await dispatch(["show", "accounts.receipt_retry", "--format-version", "2", flag, "security"], { cwd })).exitCode).toBe(2);
    }
  });

  test("retrieval normalizes realpath spelling through the same canonical-root helper as compile", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    const realpath = fs.realpathSync;
    const spelling = spyOn(fs, "realpathSync").mockImplementation((value, options) => {
      const result = realpath(value, options as never);
      return typeof result === "string" && path.resolve(String(value)) === cwd ? `${result}/` : result;
    });
    try { expect((await queryClaimsV2({ cwd, query: "retry" })).exitCode).toBe(0); }
    finally { spelling.mockRestore(); }
  });

  test("CLI parsing errors obey a valid requested cap in either option order", async () => {
    const unknown = `--${"x".repeat(3000)}`;
    for (const args of [["--max-bytes", "512", unknown], [unknown, "--max-bytes=512"], ["--max-bytes=512", "--task", "one", "--task", "two"]]) {
      const result = await dispatch(["query", "--format-version", "2", "--json", ...args]);
      expect(result.exitCode).toBe(2);
      expect(Buffer.byteLength(result.stdout!)).toBeLessThanOrEqual(512);
      expect(JSON.parse(result.stdout!).error.code).toBe("INVALID_INPUT");
    }
  });

  test("built Node CLI executes production query/context/show and bounded errors", async () => {
    const cwd = fixture(); await compileMemory({ cwd });
    const output = path.join(cwd, "bundle"); fs.mkdirSync(output);
    const build = await Bun.build({ entrypoints: [path.resolve("packages/cli/src/index.ts")], target: "node", packages: "external", outdir: output, naming: "cli.mjs" });
    expect(build.success).toBe(true); fs.symlinkSync(path.resolve("node_modules"), path.join(output, "node_modules"), "dir");
    for (const args of [["query", "actor_user_id"], ["context", "--task", tasks.full], ["show", "accounts.receipt_retry"]]) {
      const run = spawnSync("node", [path.join(output, "cli.mjs"), ...args, "--format-version", "2", "--json"], { cwd, encoding: "utf8", env: { ...process.env, ASDF_NODEJS_VERSION: "26.7.0" } });
      expect(run.status).toBe(0); const model = JSON.parse(run.stdout);
      expect(model.claims.some((claim: { id: string }) => claim.id === "accounts.receipt_retry")).toBe(true);
      expect(model.budget.usedBytes).toBe(Buffer.byteLength(run.stdout));
      expect(run.stdout.endsWith("\n\n")).toBe(false);
    }
    for (const args of [["query", "--max-bytes", "1000"], ["query", "--format-version", "2", "--task", "a", "--task", "b"], ["query", "--format-version", "2", "a", "b"], ["context", "--format-version", "2", "--include-stale"], ["query", "--format-version", "2", "--baseline", "--no-baseline"]]) expect((await dispatch(args, { cwd })).exitCode).toBe(2);
    expect((await dispatch(["query", "--format-version", "2", "--system", "accounts", "--json"], { cwd })).exitCode).toBe(0);
    expect((await dispatch(["query", "retry", "--format-version=1", "--json"], { cwd })).stdout).toBe((await dispatch(["query", "retry", "--json"], { cwd })).stdout);
    expect((await dispatch(["show", "accounts.receipt_retry", "--format-version=2", "--json"], { cwd })).exitCode).toBe(0);
  });
});
