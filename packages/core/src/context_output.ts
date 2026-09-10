import { boundContextDiagnostics, contextOutputError, resolveContextOutputCap, serializeContextOutput } from "./context_output_serialization";
import type { ContextFacet, ContextOutputCandidates, ContextOutputClaim, ContextOutputCollection, ContextOutputEdge, ContextOutputFilters, ContextOutputModel, ContextOutputOwner, ContextOutputReason, ContextOutputRequest, ContextOutputResult, ContextOutputSuggestion } from "./context_output_types";

const ACTIVE = ["current", "proposed", "needs_review"];
const DIRECT = new Set(["EXACT_SOURCE", "EXACT_SYMBOL", "EXACT_ROUTE", "TEXT_MATCH"]);
const COLLECTIONS = ["recipes", "plans", "profiles"] as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unique = (values: string[]) => [...new Set(values)].sort(compare);
const edgeKey = (edge: ContextOutputEdge) => JSON.stringify([edge.sourceClaimId, edge.targetClaimId, edge.relation]);
const ownerKey = (owner: ContextOutputOwner) => JSON.stringify([owner.kind, owner.id, owner.sourcePath]);
const requiredEdge = (edge: ContextOutputEdge) => edge.origin === "explicit" && edge.relation === "requires";
const lastIndex = <T>(values: T[], predicate: (value: T) => boolean): number => {
  for (let index = values.length - 1; index >= 0; index--) if (predicate(values[index])) return index;
  return -1;
};
const emptyCollection = (): ContextOutputCollection => ({ totalEligible: 0, matched: 0, state: "not_requested", items: [] });

export function normalizeContextOutputFilters(filters: ContextOutputFilters = {}): Required<ContextOutputFilters> {
  return { categories: unique(filters.categories ?? []), tags: unique(filters.tags ?? []), systems: unique(filters.systems ?? []), statuses: unique(filters.statuses?.length ? filters.statuses : ACTIVE) };
}

export function contextClaimOutsideFilters(claim: ContextOutputClaim, filters: Required<ContextOutputFilters>): ContextFacet[] {
  const categories = claim.tags.filter((tag) => tag.startsWith("concern:")).map((tag) => tag.slice(8));
  if (!categories.length) categories.push("uncategorized");
  const outside: ContextFacet[] = [];
  if (filters.categories.length && !filters.categories.some((category) => categories.includes(category))) outside.push("category");
  if (filters.tags.length && !filters.tags.some((tag) => claim.tags.includes(tag))) outside.push("tag");
  if (filters.systems.length && !filters.systems.includes(claim.system)) outside.push("system");
  if (filters.statuses.length && !filters.statuses.includes(claim.status)) outside.push("status");
  return outside;
}

/**
 * Pack already ranked retrieval evidence. No database, filesystem or execution access.
 * Outgoing explicit requires edges and explicit collection obligations are the only
 * authority to cross filters. The complete obligation set survives budget removals.
 */
export function packContextOutput(request: ContextOutputRequest, candidates: ContextOutputCandidates, options: { stderr?: string } = {}): ContextOutputResult {
  const cap = resolveContextOutputCap(request);
  if (cap === undefined) return contextOutputError("BUDGET_TOO_SMALL", { invalidCap: true, stderr: options.stderr });
  const filters = normalizeContextOutputFilters(request.filters);
  // Clone input data: neither deduplication nor self-accounting changes caller state.
  const input = structuredClone(candidates);
  const claims = new Map<string, ContextOutputClaim>();
  for (const claim of input.claims) if (!claims.has(claim.id)) claims.set(claim.id, claim);
  const edges = new Map<string, ContextOutputEdge>();
  for (const edge of input.edges ?? []) {
    const key = edgeKey(edge);
    const previous = edges.get(key);
    if (!previous || (requiredEdge(edge) && !requiredEdge(previous))) edges.set(key, edge);
  }
  const orderedEdges = [...edges.values()].sort((a, b) => Number(requiredEdge(b)) - Number(requiredEdge(a)) || (b.strength ?? 0) - (a.strength ?? 0) || compare(edgeKey(a), edgeKey(b)));
  const outgoing = new Map<string, ContextOutputEdge[]>();
  for (const edge of orderedEdges.filter(requiredEdge)) outgoing.set(edge.sourceClaimId, [...(outgoing.get(edge.sourceClaimId) ?? []), edge]);
  const eligibleRoots = input.roots.filter((root) => {
    const claim = claims.get(root.claimId);
    return claim && !contextClaimOutsideFilters(claim, filters).length &&
      (root.reason !== "BASELINE_FALLBACK" || (request.baseline === true && request.mode === "task"));
  });
  const taskMatches = request.mode === "browse" ? 0 : new Set(eligibleRoots.filter((root) => DIRECT.has(root.reason)).map((root) => root.claimId)).size;
  const roots = eligibleRoots.filter((root) => root.reason !== "BASELINE_FALLBACK" || taskMatches === 0);
  const selected = new Map<string, ContextOutputModel["claims"][number]>();
  const requiredIds = new Set<string>();
  const requiredEdges = new Set<string>();
  const protectedIds = new Set<string>();
  const missingIds = new Set<string>();
  const inactiveIds = new Set<string>();
  const visited = new Set<string>();
  const addReason = (id: string, reason: ContextOutputReason) => {
    const claim = claims.get(id);
    if (!claim) return;
    let entry = selected.get(id);
    if (!entry) { entry = { ...claim, reasons: [] }; selected.set(id, entry); }
    if (!entry.reasons.some((existing) => existing.code === reason.code)) entry.reasons.push(reason);
  };
  const requireClaim = (id: string) => {
    requiredIds.add(id);
    protectedIds.add(id);
    const claim = claims.get(id);
    if (!claim) { missingIds.add(id); return; }
    if (!ACTIVE.includes(claim.status)) inactiveIds.add(id);
    addReason(id, { code: "REQUIRED_DEPENDENCY", outsideFilters: contextClaimOutsideFilters(claim, filters) });
  };
  const expand = (seed: string) => {
    const queue = [seed];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of outgoing.get(id) ?? []) {
        requiredEdges.add(edgeKey(edge));
        protectedIds.add(id);
        requireClaim(edge.targetClaimId);
        if (claims.has(edge.targetClaimId)) queue.push(edge.targetClaimId);
      }
    }
  };
  for (const root of roots) {
    addReason(root.claimId, { code: root.reason, outsideFilters: [] });
    const claim = selected.get(root.claimId);
    if (claim && root.evidence && !claim.evidence) claim.evidence = root.evidence;
    expand(root.claimId);
  }
  const collections = Object.fromEntries(COLLECTIONS.map((name) => {
    const collection = input[name] ?? emptyCollection();
    collection.items = [...new Map(collection.items.map((item) => [item.id, item])).values()];
    for (const item of collection.items) for (const id of item.requiredClaimIds) { requireClaim(id); expand(id); }
    return [name, collection];
  })) as Record<typeof COLLECTIONS[number], ContextOutputCollection>;
  for (const id of input.requiredClaimIds ?? []) { requireClaim(id); expand(id); }

  const allClaims = [...selected.values()];
  // Missing graph endpoints are diagnostics, not budget omissions.
  const allEdges = orderedEdges.filter((edge) => selected.has(edge.sourceClaimId) && selected.has(edge.targetClaimId));
  const ownerPriorities = new Map<string, { tier: number; rank: number }>();
  const compareOwners = (a: ContextOutputOwner, b: ContextOutputOwner) => {
    const left = ownerPriorities.get(ownerKey(a))!;
    const right = ownerPriorities.get(ownerKey(b))!;
    return left.tier - right.tier || left.rank - right.rank;
  };
  for (const [rank, claim] of allClaims.entries()) ownerPriorities.set(ownerKey({ kind: "claim", id: claim.id, sourcePath: claim.sourcePath }), { tier: 0, rank });
  for (const name of COLLECTIONS) for (const [rank, item] of collections[name].items.entries()) {
    const kind = name === "recipes" ? "recipe" : name === "plans" ? "plan" : "profile";
    ownerPriorities.set(ownerKey({ kind, id: item.id, sourcePath: item.sourcePath }), { tier: item.required ? 0 : 1, rank });
  }
  const suggestions = (items: ContextOutputSuggestion[]) => {
    const byValue = new Map<string, ContextOutputSuggestion>();
    for (const item of items) {
      const origins = item.origins.filter((origin) => ownerPriorities.has(ownerKey(origin)));
      if (!origins.length) continue;
      const existing = byValue.get(item.value) ?? { value: item.value, origins: [] };
      existing.origins = [...new Map([...existing.origins, ...origins].map((origin) => [ownerKey(origin), origin])).values()].sort((a, b) => compareOwners(a, b) || compare(ownerKey(a), ownerKey(b)));
      byValue.set(item.value, existing);
    }
    return [...byValue.values()].sort((a, b) => compareOwners(a.origins[0], b.origins[0]) || compare(a.value, b.value));
  };
  const allFiles = suggestions(input.files ?? []);
  const allCommands = suggestions(input.commands ?? []);
  const model: ContextOutputModel = {
    schemaVersion: 2, mode: request.mode, filters, taskMatches, completeness: "complete",
    roots: [...new Set(roots.map((root) => root.claimId))], claims: [...allClaims], edges: [...allEdges],
    files: [...allFiles], commands: allCommands.map((item) => ({ ...item, state: "suggested_not_run" })),
    recipes: { ...collections.recipes, items: [...collections.recipes.items] },
    plans: { ...collections.plans, items: [...collections.plans.items] },
    profiles: { ...collections.profiles, items: [...collections.profiles.items] },
    warnings: [], budget: { maxBytes: cap, usedBytes: 0, omitted: { claims: 0, requiredClaims: 0, edges: 0, sections: 0, files: 0, commands: 0, recipes: 0, plans: 0, profiles: 0 } }
  };
  const refresh = () => {
    const retained = new Set(model.claims.map((claim) => claim.id));
    model.roots = model.roots.filter((id) => retained.has(id));
    model.edges = allEdges.filter((edge) => retained.has(edge.sourceClaimId) && retained.has(edge.targetClaimId));
    const retainedEdges = new Set(model.edges.map(edgeKey));
    const omittedClaims = allClaims.filter((claim) => !retained.has(claim.id));
    const omitted = model.budget.omitted;
    omitted.claims = omittedClaims.length;
    omitted.requiredClaims = omittedClaims.filter((claim) => requiredIds.has(claim.id)).length;
    omitted.sections = omittedClaims.reduce((count, claim) => count + claim.sections.length, 0);
    omitted.edges = allEdges.length - model.edges.length;
    omitted.files = allFiles.length - model.files.length;
    omitted.commands = allCommands.length - model.commands.length;
    for (const name of COLLECTIONS) {
      omitted[name] = collections[name].items.length - model[name].items.length;
      // These are emitted references, unlike opaque authored collection data.
      model[name].items = model[name].items.map((item) => ({ ...item, requiredClaimIds: item.requiredClaimIds.filter((id) => retained.has(id)) }));
    }
    const requiredCollectionOmitted = COLLECTIONS.some((name) => {
      const retainedItems = new Set(model[name].items.map((item) => item.id));
      return collections[name].items.some((item) => item.required && !retainedItems.has(item.id));
    });
    const requiredOmitted = requiredCollectionOmitted || omitted.requiredClaims > 0 || allEdges.some((edge) => requiredEdges.has(edgeKey(edge)) && !retainedEdges.has(edgeKey(edge)));
    model.completeness = missingIds.size || inactiveIds.size || requiredOmitted ? "incomplete" : "complete";
    model.warnings = [
      ...(request.mode === "task" && !taskMatches ? ["NO_TASK_MATCH"] : []),
      ...(allClaims.some((claim) => claim.reasons.some((reason) => reason.code === "BASELINE_FALLBACK")) ? ["BASELINE_FALLBACK"] : []),
      ...(missingIds.size ? ["REQUIRED_CONTEXT_MISSING"] : []),
      ...(inactiveIds.size ? ["REQUIRED_CONTEXT_INACTIVE"] : []),
      ...(requiredOmitted ? ["REQUIRED_CONTEXT_OMITTED"] : []),
      ...(Object.values(omitted).some((value) => value > 0) ? ["OUTPUT_TRUNCATED"] : [])
    ];
  };
  // Suggestions go first, so later claim/collection removals cannot dangle origins.
  for (;;) {
    refresh();
    const stdout = serializeContextOutput(model);
    if (model.budget.usedBytes <= cap) return { exitCode: 0, model, stdout, stderr: boundContextDiagnostics(options.stderr ?? "") };
    if (model.commands.length) { model.commands.pop(); continue; }
    if (model.files.length) { model.files.pop(); continue; }
    let removed = false;
    for (const required of [false, true]) {
      for (const name of [...COLLECTIONS].reverse()) {
        const index = lastIndex(model[name].items, (item) => item.required === required);
        if (index >= 0) { model[name].items.splice(index, 1); removed = true; break; }
      }
      if (removed) break;
      const index = lastIndex(model.claims, (claim) => protectedIds.has(claim.id) === required);
      if (index >= 0) { model.claims.splice(index, 1); removed = true; break; }
    }
    if (!removed) return contextOutputError("BUDGET_TOO_SMALL", { maxBytes: cap, stderr: options.stderr });
  }
}
