import { describe, expect, spyOn, test } from "bun:test";
import { packContextOutput, serializeContextOutput, type ContextOutputCandidates, type ContextOutputModel } from "../../packages/core/src/index";

const collections = ["recipes", "plans", "profiles"] as const;

// Deliberately straightforward oracle for small fixtures: rebuild and serialize
// every state. It shares neither byte arithmetic nor the optimized retained sets.
function sequentialOracle(full: ContextOutputModel, cap: number): string | undefined {
  const model = structuredClone(full);
  model.budget.maxBytes = cap;
  const requiredIds = new Set(full.claims.filter((claim) => claim.reasons.some((reason) => reason.code === "REQUIRED_DEPENDENCY")).map((claim) => claim.id));
  const requiredEdges = full.edges.filter((edge) => edge.origin === "explicit" && edge.relation === "requires");
  const protectedIds = new Set([...requiredIds, ...requiredEdges.map((edge) => edge.sourceClaimId)]);
  const baseWarnings = [...full.warnings];
  const fit = () => {
    const ids = new Set(model.claims.map((claim) => claim.id));
    model.roots = full.roots.filter((id) => ids.has(id));
    model.edges = full.edges.filter((edge) => ids.has(edge.sourceClaimId) && ids.has(edge.targetClaimId));
    const removed = full.claims.filter((claim) => !ids.has(claim.id));
    const omitted = model.budget.omitted;
    omitted.claims = removed.length;
    omitted.requiredClaims = removed.filter((claim) => requiredIds.has(claim.id)).length;
    omitted.sections = removed.reduce((sum, claim) => sum + claim.sections.length, 0);
    omitted.edges = full.edges.length - model.edges.length;
    omitted.files = full.files.length - model.files.length;
    omitted.commands = full.commands.length - model.commands.length;
    let requiredOmitted = omitted.requiredClaims > 0 || requiredEdges.some((edge) => !ids.has(edge.sourceClaimId) || !ids.has(edge.targetClaimId));
    for (const name of collections) {
      omitted[name] = full[name].items.length - model[name].items.length;
      requiredOmitted ||= full[name].items.some((item) => item.required && !model[name].items.some((retained) => retained.id === item.id));
      model[name].items = model[name].items.map((item) => ({ ...item, requiredClaimIds: item.requiredClaimIds.filter((id) => ids.has(id)) }));
    }
    model.completeness = full.completeness === "incomplete" || requiredOmitted ? "incomplete" : "complete";
    model.warnings = [...baseWarnings, ...(requiredOmitted ? ["REQUIRED_CONTEXT_OMITTED"] : []), ...(Object.values(omitted).some((count) => count > 0) ? ["OUTPUT_TRUNCATED"] : [])];
    const output = serializeContextOutput(model);
    return Buffer.byteLength(output) <= cap ? output : undefined;
  };
  let output = fit();
  if (output) return output;
  while (model.commands.length) { model.commands.pop(); output = fit(); if (output) return output; }
  while (model.files.length) { model.files.pop(); output = fit(); if (output) return output; }
  for (const required of [false, true]) {
    for (const name of [...collections].reverse()) {
      for (const item of [...model[name].items].reverse()) {
        if (item.required !== required) continue;
        model[name].items = model[name].items.filter((retained) => retained.id !== item.id);
        output = fit(); if (output) return output;
      }
    }
    for (const claim of [...model.claims].reverse()) {
      if (protectedIds.has(claim.id) !== required) continue;
      model.claims = model.claims.filter((retained) => retained.id !== claim.id);
      output = fit(); if (output) return output;
    }
  }
  return undefined;
}

function fixture(count: number, statementLength = 20): ContextOutputCandidates {
  return {
    roots: Array.from({ length: count }, (_, i) => ({ claimId: `claim${i}`, reason: "TEXT_MATCH" })),
    claims: Array.from({ length: count }, (_, i) => ({ id: `claim${i}`, sourcePath: `claims/${i}.md`, title: `Claim ${i}`, claim: "x".repeat(statementLength), system: "test", status: "current", tags: [], sections: [] }))
  };
}

describe("incremental production output accounting", () => {
  test("matches sequential serialization through all omission and warning transitions", () => {
    const input = fixture(12);
    input.claims[1].status = "rejected";
    input.claims[2].sections = [{ heading: "日本語", startLine: 2, text: '"\\😀'.repeat(15) }];
    input.edges = [
      { sourceClaimId: "claim0", targetClaimId: "claim1", relation: "requires", origin: "explicit" },
      { sourceClaimId: "claim1", targetClaimId: "claim0", relation: "requires", origin: "explicit" },
      { sourceClaimId: "claim0", targetClaimId: "claim2", relation: "related_to", origin: "inferred" }
    ];
    input.files = Array.from({ length: 11 }, (_, i) => ({ value: `src/${i}`, origins: [{ kind: "claim", id: "claim0", sourcePath: "claims/0.md" }] }));
    input.commands = input.files.map((file) => ({ ...file, value: `test ${file.value}` }));
    for (const name of collections) input[name] = { totalEligible: 2, matched: 2, state: "matched", items: [
      { id: "optional", sourcePath: `${name}/optional.md`, required: false, requiredClaimIds: [], data: {} },
      { id: "required", sourcePath: `${name}/required.md`, required: true, requiredClaimIds: ["claim0", "claim2", "claim2", "missing"], data: { text: "😀\\\"".repeat(30) } }
    ] };
    const full = packContextOutput({ mode: "task", maxBytes: 65536 }, input);
    expect(full.exitCode).toBe(0);
    if (full.exitCode !== 0) throw new Error("fixture must fit");
    for (const cap of [...Array.from({ length: 180 }, (_, i) => 512 + i * 53), 999, 1000, 9999, 10000]) {
      const expected = sequentialOracle(full.model, cap);
      const actual = packContextOutput({ mode: "task", maxBytes: cap }, input);
      if (expected) expect(actual.stdout).toBe(expected);
      else expect(actual.exitCode).toBe(7);
    }
  });

  test("shared command and file values retain every unique origin in owner order", () => {
    const input = fixture(40);
    input.commands = [...input.claims].reverse().flatMap((claim) => [0, 1].map(() => ({ value: "bun test", origins: [{ kind: "claim" as const, id: claim.id, sourcePath: claim.sourcePath }] })));
    input.files = input.commands.map((item) => ({ ...item, value: "src/shared.ts" }));
    const result = packContextOutput({ mode: "task", maxBytes: 65536 }, input);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) throw new Error("fixture must fit");
    const expected = input.claims.map((claim) => ({ kind: "claim", id: claim.id, sourcePath: claim.sourcePath }));
    expect(result.model.commands).toHaveLength(1);
    expect(result.model.files).toHaveLength(1);
    expect(result.model.commands[0].origins).toEqual(expected);
    expect(result.model.files[0].origins).toEqual(expected);
  });

  test("encodes a 3000-claim corpus a bounded number of times instead of every removal", () => {
    const input = fixture(3000, 2048);
    input.commands = input.claims.map((claim) => ({ value: "bun test", origins: [{ kind: "claim", id: claim.id, sourcePath: claim.sourcePath }] }));
    input.files = input.commands.map((item) => ({ ...item, value: "src/shared.ts" }));
    const stringify = JSON.stringify;
    const inputBytes = Buffer.byteLength(stringify(input));
    let encodedBytes = 0;
    const spy = spyOn(JSON, "stringify").mockImplementation((value) => {
      const encoded = stringify(value);
      if (encoded) encodedBytes += Buffer.byteLength(encoded);
      return encoded;
    });
    let result;
    try { result = packContextOutput({ mode: "task", maxBytes: 4096 }, input); }
    finally { spy.mockRestore(); }
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4096);
    if (result.exitCode === 0) {
      expect(result.model.claims.map((claim) => claim.id)).toEqual(["claim0"]);
      expect(result.model.taskMatches).toBe(3000);
      expect(result.model.budget.omitted.claims).toBe(2999);
      expect(result.model.budget.omitted.commands).toBe(1);
      expect(result.model.budget.omitted.files).toBe(1);
    }
    // Measures encoded work, not wall-clock speed or a fixture-only implementation.
    expect(encodedBytes).toBeLessThan(inputBytes * 3);
  });
});
