import { describe, expect, test } from "bun:test";
import { boundContextDiagnostics, contextOutputError, packContextOutput, renderContextOutputHuman, resolveContextOutputCap, type ContextOutputCandidates, type ContextOutputClaim, type ContextOutputCollection, type ContextOutputResult } from "../../packages/core/src/index";

const claim = (id: string, changes: Partial<ContextOutputClaim> = {}): ContextOutputClaim => ({ id, sourcePath: `claims/${id}.md`, title: id, claim: "Keep the authored guidance.", system: "billing", status: "current", tags: ["concern:security"], sections: [{ heading: "Statement", startLine: 1, text: "Keep the authored guidance." }], ...changes });
const graph = (): ContextOutputCandidates => ({
  roots: [{ claimId: "a", reason: "TEXT_MATCH", evidence: { tier: 2, textScore: 1.2, matchedTokens: ["guidance"], fields: [{ field: "body", section: "Statement", startLine: 1 }] } }, { claimId: "z", reason: "WATCHED_INDEX" }],
  claims: [claim("a"), claim("b"), claim("z")],
  edges: [{ sourceClaimId: "a", targetClaimId: "b", relation: "requires", origin: "explicit" }]
});
const success = (result: ContextOutputResult) => {
  expect(result.exitCode).toBe(0);
  if (result.exitCode !== 0) throw new Error(result.stdout);
  expect(Buffer.byteLength(result.stdout)).toBe(result.model.budget.usedBytes);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(result.model.budget.maxBytes);
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.endsWith("\n\n")).toBe(false);
  expect(JSON.parse(result.stdout)).toEqual(result.model);
  expect(Buffer.byteLength(renderContextOutputHuman(result.model))).toBeLessThanOrEqual(result.model.budget.maxBytes);
  return result.model;
};

describe("production v2 output", () => {
  test("normal ranked output preserves evidence and never exposes a database path", () => {
    const input = graph();
    const before = JSON.stringify(input);
    const result = packContextOutput({ mode: "task" }, input);
    const model = success(result);
    expect(model.claims.map((item) => item.id)).toEqual(["a", "b", "z"]);
    expect(model.taskMatches).toBe(1);
    expect(model.claims[0].evidence?.textScore).toBe(1.2);
    expect(model.claims[1].reasons).toEqual([{ code: "REQUIRED_DEPENDENCY", outsideFilters: [] }]);
    expect(model.completeness).toBe("complete");
    expect(result.stdout).not.toContain("databasePath");
    expect(JSON.stringify(input)).toBe(before);
    expect(packContextOutput({ mode: "task" }, input).stdout).toBe(result.stdout);
  });

  test("negative and browse envelopes distinguish task understanding", () => {
    const empty = success(packContextOutput({ mode: "task" }, { roots: [], claims: [] }));
    expect(empty.warnings).toEqual(["NO_TASK_MATCH"]);
    expect(empty.taskMatches).toBe(0);
    expect(empty.claims).toEqual([]);
    expect(empty.recipes).toEqual({ totalEligible: 0, matched: 0, state: "not_requested", items: [] });
    const browse = success(packContextOutput({ mode: "browse", filters: { systems: ["billing"] } }, { roots: [{ claimId: "a", reason: "FILTER_BROWSE" }], claims: [claim("a")] }));
    expect(browse.taskMatches).toBe(0);
    expect(browse.warnings).toEqual([]);
    expect(browse.mode).toBe("browse");
    const broad = graph();
    broad.roots = [{ claimId: "z", reason: "WATCHED_INDEX" }];
    expect(success(packContextOutput({ mode: "task" }, broad)).warnings).toContain("NO_TASK_MATCH");
  });

  test("baseline is opt-in, labeled, zero-match and cannot bypass any facet", () => {
    const input: ContextOutputCandidates = { roots: [{ claimId: "a", reason: "BASELINE_FALLBACK" }], claims: [claim("a")] };
    expect(success(packContextOutput({ mode: "task" }, input)).claims).toEqual([]);
    const baseline = success(packContextOutput({ mode: "task", baseline: true }, input));
    expect(baseline.warnings).toEqual(["NO_TASK_MATCH", "BASELINE_FALLBACK"]);
    expect(baseline.taskMatches).toBe(0);
    for (const filters of [{ categories: ["billing"] }, { systems: ["other"] }, { statuses: ["stale"] }, { tags: ["security"] }]) {
      expect(success(packContextOutput({ mode: "task", baseline: true, filters }, input)).claims).toEqual([]);
    }
    input.roots.push({ claimId: "b", reason: "TEXT_MATCH" });
    input.claims.push(claim("b"));
    expect(success(packContextOutput({ mode: "task", baseline: true }, input)).claims.map((item) => item.id)).toEqual(["b"]);
  });

  test("required closure crosses facets explicitly, cycles and duplicate edges terminate", () => {
    const input = graph();
    input.claims[1] = claim("b", { system: "identity", status: "stale", tags: ["concern:billing"] });
    input.claims.push(input.claims[1]);
    input.edges!.push(input.edges![0], { sourceClaimId: "b", targetClaimId: "a", relation: "requires", origin: "explicit" });
    const model = success(packContextOutput({ mode: "task", filters: { systems: ["billing"], categories: ["security"], tags: ["concern:security"] } }, input));
    expect(model.claims).toHaveLength(3);
    expect(model.edges).toHaveLength(2);
    expect(model.claims[1].reasons[0].outsideFilters).toEqual(["category", "tag", "system", "status"]);
    expect(model.warnings).toContain("REQUIRED_CONTEXT_INACTIVE");
    expect(model.completeness).toBe("incomplete");
    expect(model.budget.omitted.requiredClaims).toBe(0);
  });

  test("missing required payloads are not budget omissions", () => {
    const input = graph();
    input.claims = input.claims.filter((item) => item.id !== "b");
    const model = success(packContextOutput({ mode: "task" }, input));
    expect(model.warnings).toEqual(["REQUIRED_CONTEXT_MISSING"]);
    expect(model.completeness).toBe("incomplete");
    expect(Object.values(model.budget.omitted).every((count) => count === 0)).toBe(true);
    expect(model.edges).toEqual([]);
  });

  test("inferred requires edges are optional and never cross facets", () => {
    const input = graph();
    input.edges![0].origin = "inferred";
    input.claims[1].system = "identity";
    const model = success(packContextOutput({ mode: "task", filters: { systems: ["billing"] } }, input));
    expect(model.claims.map((item) => item.id)).toEqual(["a", "z"]);
    expect(model.completeness).toBe("complete");
  });

  test("dropped origins do not erase required obligations or inflate missing counts", () => {
    const input = graph();
    input.claims[0].claim = "a".repeat(10000);
    input.claims[1].claim = "b".repeat(10000);
    const model = success(packContextOutput({ mode: "task", maxBytes: 1600 }, input));
    expect(model.claims.map((item) => item.id)).not.toContain("a");
    expect(model.taskMatches).toBe(1);
    expect(model.completeness).toBe("incomplete");
    expect(model.budget.omitted).toMatchObject({ claims: 3, requiredClaims: 1, edges: 1, sections: 3 });
    expect(model.warnings).toEqual(["REQUIRED_CONTEXT_OMITTED", "OUTPUT_TRUNCATED"]);
  });

  test("exact cap and one byte over use actual LF and self-count bytes", () => {
    const input = graph();
    const initial = success(packContextOutput({ mode: "task", maxBytes: 9999 }, input));
    const cap = initial.budget.usedBytes;
    const exact = success(packContextOutput({ mode: "task", maxBytes: cap }, input));
    expect(exact.budget.usedBytes).toBe(cap);
    const over = success(packContextOutput({ mode: "task", maxBytes: cap - 1 }, input));
    expect(over.budget.omitted.claims).toBeGreaterThan(0);
    expect(over.warnings).toContain("OUTPUT_TRUNCATED");
  });

  test("Unicode, escaping, long lists and required closure use whole records", () => {
    const input = graph();
    input.claims[1].sections[0].text = '日本語 😀 "\\\n'.repeat(3000);
    const origin = { kind: "claim" as const, id: "a", sourcePath: "claims/a.md" };
    input.files = Array.from({ length: 200 }, (_, index) => ({ value: `src/${index}.ts`, origins: [origin] }));
    input.commands = Array.from({ length: 200 }, (_, index) => ({ value: `echo '${index} 日本語 "\\'`, origins: [origin] }));
    for (const cap of [1024, 4096, 16384, 65536]) {
      const model = success(packContextOutput({ mode: "task", maxBytes: cap }, input));
      expect(new Set(model.claims.map((item) => item.id)).size).toBe(model.claims.length);
      expect(model.edges.every((edge) => model.claims.some((item) => item.id === edge.sourceClaimId) && model.claims.some((item) => item.id === edge.targetClaimId))).toBe(true);
      for (const item of model.claims) expect(item.sections).toEqual(input.claims.find((candidate) => candidate.id === item.id)!.sections);
      expect(model.budget.omitted.commands).toBe(200 - model.commands.length);
      expect(model.budget.omitted.files).toBe(200 - model.files.length);
    }
  });

  test("suggestions merge provenance, follow owning rank and drop commands before files", () => {
    const input = graph();
    const a = { kind: "claim" as const, id: "a", sourcePath: "claims/a.md" };
    const z = { kind: "claim" as const, id: "z", sourcePath: "claims/z.md" };
    input.commands = [{ value: "zzz top", origins: [a] }, { value: "aaa lower", origins: [z] }, { value: "zzz top", origins: [z, a] }];
    input.files = [{ value: "src/a.ts", origins: [a] }];
    const model = success(packContextOutput({ mode: "task" }, input));
    expect(model.commands.map((item) => item.value)).toEqual(["zzz top", "aaa lower"]);
    expect(model.commands[0].origins).toEqual([a, z]);
    expect(model.commands.every((item) => item.state === "suggested_not_run")).toBe(true);
    const reduced = success(packContextOutput({ mode: "task", maxBytes: model.budget.usedBytes - 200 }, input));
    expect(reduced.budget.omitted.commands).toBeGreaterThan(0);
    expect(reduced.budget.omitted.files).toBe(0);
    expect(reduced.budget.omitted.claims).toBe(0);
  });

  test("collection states survive omission with authored required claims and origins", () => {
    const input = graph();
    const collection: ContextOutputCollection = { totalEligible: 3, matched: 1, state: "matched", items: [{ id: "r", sourcePath: "recipes/r.md", requiredClaimIds: ["b", "missing"], required: true, data: { steps: ["not executed"] } }] };
    input.recipes = collection;
    input.plans = { totalEligible: 0, matched: 0, state: "empty", items: [] };
    input.profiles = { totalEligible: 4, matched: 0, state: "no_match", items: [] };
    input.commands = [{ value: "recipe test", origins: [{ kind: "recipe", id: "r", sourcePath: "recipes/r.md" }] }];
    const model = success(packContextOutput({ mode: "task" }, input));
    expect(model.recipes).toMatchObject({ totalEligible: 3, matched: 1, state: "matched" });
    expect(model.recipes.items[0].requiredClaimIds).toEqual(["b"]);
    expect(model.commands[0].origins[0]).toEqual({ kind: "recipe", id: "r", sourcePath: "recipes/r.md" });
    expect(model.warnings).toContain("REQUIRED_CONTEXT_MISSING");
    input.recipes.items[0].data = { steps: ["x".repeat(10000)] };
    const reduced = success(packContextOutput({ mode: "task", maxBytes: 1500 }, input));
    expect(reduced.budget.omitted.recipes).toBe(1);
    expect(reduced.recipes).toMatchObject({ totalEligible: 3, matched: 1, state: "matched" });
    expect(reduced.plans.state).toBe("empty");
    expect(reduced.profiles.state).toBe("no_match");
  });

  test("omitted required collection payloads remain incomplete independently of claim obligations", () => {
    for (const name of ["recipes", "plans", "profiles"] as const) {
      const input: ContextOutputCandidates = { roots: [], claims: [], [name]: { totalEligible: 1, matched: 1, state: "matched", items: [{ id: "required", sourcePath: `${name}/required.md`, required: true, requiredClaimIds: [], data: { steps: ["x".repeat(5000)] } }] } };
      const model = success(packContextOutput({ mode: "task", maxBytes: 1024 }, input));
      expect(model[name].items).toEqual([]);
      expect(model[name].state).toBe("matched");
      expect(model.budget.omitted[name]).toBe(1);
      expect(model.budget.omitted.requiredClaims).toBe(0);
      expect(model.completeness).toBe("incomplete");
      expect(model.warnings).toContain("REQUIRED_CONTEXT_OMITTED");
      input[name]!.items[0].required = false;
      const optional = success(packContextOutput({ mode: "task", maxBytes: 1024 }, input));
      expect(optional.completeness).toBe("complete");
      expect(optional.warnings).not.toContain("REQUIRED_CONTEXT_OMITTED");
    }
  });

  test("human output retains collection guidance, states and suggested command provenance", () => {
    const input = graph();
    for (const name of ["recipes", "plans", "profiles"] as const) {
      input[name] = { totalEligible: 7, matched: 1, state: "matched", items: [{ id: name, sourcePath: `${name}/guidance.md`, required: true, requiredClaimIds: ["b"], data: { steps: [`${name} authored guidance`] } }] };
    }
    input.commands = [{ value: "do-not-run", origins: [{ kind: "recipe", id: "recipes", sourcePath: "recipes/guidance.md" }] }];
    const model = success(packContextOutput({ mode: "task", maxBytes: 16384 }, input));
    const human = renderContextOutputHuman(model);
    for (const name of ["recipes", "plans", "profiles"] as const) {
      expect(human).toContain(`${name} authored guidance`);
      expect(human).toContain(`${name}/guidance.md`);
      expect(human).toContain(`${name}: matched; eligible: 7; matched: 1`);
    }
    expect(human).toContain('"kind":"recipe"');
    expect(human).toContain("Suggested, not run: do-not-run");
  });

  test("required collection suggestion owners outrank optional owners regardless of input position", () => {
    const input: ContextOutputCandidates = { roots: [], claims: [], recipes: { totalEligible: 2, matched: 2, state: "matched", items: [
      { id: "optional", sourcePath: "recipes/optional.md", required: false, requiredClaimIds: [], data: {} },
      { id: "required", sourcePath: "recipes/required.md", required: true, requiredClaimIds: [], data: {} }
    ] } };
    input.commands = ["optional", "required"].map((id) => ({ value: id, origins: [{ kind: "recipe", id, sourcePath: `recipes/${id}.md` }] }));
    input.files = input.commands.map((item) => ({ ...item, value: `src/${item.value}` }));
    const model = success(packContextOutput({ mode: "task", maxBytes: 9999 }, input));
    expect(model.commands.map((item) => item.value)).toEqual(["required", "optional"]);
    expect(model.files.map((item) => item.value)).toEqual(["src/required", "src/optional"]);
    const reduced = success(packContextOutput({ mode: "task", maxBytes: model.budget.usedBytes - 1 }, input));
    expect(reduced.commands.map((item) => item.value)).toEqual(["required"]);
    expect(reduced.budget.omitted.commands).toBe(1);
  });

  test("human output preserves complete selected inactive claims, reasons, provenance and graph", () => {
    const input = graph();
    input.claims[1] = claim("b", { system: "other", status: "rejected", bodySha256: "a".repeat(64), metadata: { verification: ["suggested only"] }, associations: { files: ["src/b.ts"], symbols: ["B"], routes: ["/b"] } });
    const model = success(packContextOutput({ mode: "task", filters: { systems: ["billing"] } }, input));
    const human = renderContextOutputHuman(model);
    for (const item of model.claims) expect(human).toContain(JSON.stringify(item));
    expect(human).toContain(JSON.stringify(model.edges));
    expect(human).toContain('"status":"rejected"');
    expect(human).toContain('"outsideFilters":["system","status"]');
    expect(human).toContain('"code":"REQUIRED_DEPENDENCY"');
    expect(human).toContain(JSON.stringify(model.budget));
  });

  test("bounded golden errors distinguish invalid caps and a valid minimum envelope", () => {
    for (const maxBytes of [0, 511, 16_777_217, 512.5, NaN, Infinity]) {
      const result = packContextOutput({ mode: "task", maxBytes }, graph());
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('{"schemaVersion":2,"error":{"code":"BUDGET_TOO_SMALL"}}\n');
    }
    for (const request of [{ mode: "task" as const, maxBytes: 512 }, { mode: "task" as const, maxBytes: 4096, filters: { tags: ["🦀".repeat(2000)] } }]) {
      const result = packContextOutput(request, { roots: [], claims: [] });
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe('{"schemaVersion":2,"error":{"code":"BUDGET_TOO_SMALL"}}\n');
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(request.maxBytes);
    }
    expect(resolveContextOutputCap({ budget: "small" })).toBe(4096);
    expect(resolveContextOutputCap({ budget: "medium" })).toBe(16384);
    expect(resolveContextOutputCap({ budget: "full" })).toBe(65536);
    expect(resolveContextOutputCap({ budget: "full", maxBytes: 512 })).toBe(512);
    expect(resolveContextOutputCap({ maxBytes: 16_777_216 })).toBe(16_777_216);
    const error = contextOutputError("UNKNOWN_CATEGORY", { message: "日本".repeat(4000), maxBytes: 512, stderr: "😀".repeat(1000) });
    expect(error.exitCode).toBe(2);
    expect(Buffer.byteLength(error.stdout)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(error.stderr)).toBe(2048);
    expect(boundContextDiagnostics("日".repeat(1000))).not.toContain("�");
  });
});
