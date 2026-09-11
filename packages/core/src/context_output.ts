import { claimCategories } from "./category_vocabulary";
import { ContextOutputByteCounter } from "./context_output_budget";
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
const emptyCollection = (): ContextOutputCollection => ({ totalEligible: 0, matched: 0, state: "not_requested", items: [] });

export function normalizeContextOutputFilters(filters: ContextOutputFilters = {}): Required<ContextOutputFilters> {
  return { categories: unique(filters.categories ?? []), tags: unique(filters.tags ?? []), systems: unique(filters.systems ?? []), statuses: unique(filters.statuses?.length ? filters.statuses : ACTIVE) };
}

export function contextClaimOutsideFilters(claim: ContextOutputClaim, filters: Required<ContextOutputFilters>): ContextFacet[] {
  const categories = claimCategories(claim.tags);
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
  for (const edge of orderedEdges.filter(requiredEdge)) {
    const targets = outgoing.get(edge.sourceClaimId) ?? [];
    targets.push(edge);
    outgoing.set(edge.sourceClaimId, targets);
  }
  const eligibleRoots = input.roots.filter((root) => {
    const claim = claims.get(root.claimId);
    return claim && !contextClaimOutsideFilters(claim, filters).length &&
      (root.reason !== "BASELINE_FALLBACK" || (request.baseline === true && request.mode === "task"));
  });
  const taskMatches = request.mode === "browse" ? 0 : Math.max(Number.isSafeInteger(input.taskMatchCount) ? input.taskMatchCount! : 0, new Set(eligibleRoots.filter((root) => DIRECT.has(root.reason)).map((root) => root.claimId)).size);
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
    const itemsById = new Map<string, typeof collection.items[number]>();
    for (const item of collection.items) if (!itemsById.has(item.id)) itemsById.set(item.id, item);
    collection.items = [...itemsById.values()];
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
    const byValue = new Map<string, Map<string, ContextOutputOwner>>();
    for (const item of items) for (const origin of item.origins) {
      const key = ownerKey(origin);
      if (!ownerPriorities.has(key)) continue;
      const origins = byValue.get(item.value) ?? new Map<string, ContextOutputOwner>();
      if (!origins.has(key)) origins.set(key, origin);
      byValue.set(item.value, origins);
    }
    return [...byValue].map(([value, origins]) => ({ value, origins: [...origins.values()].sort((a, b) => compareOwners(a, b) || compare(ownerKey(a), ownerKey(b))) }))
      .sort((a, b) => compareOwners(a.origins[0], b.origins[0]) || compare(a.value, b.value));
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
  const retained = new Set(allClaims.map((claim) => claim.id));
  const retainedRoots = new Set(model.roots);
  const retainedEdges = new Set(allEdges);
  const retainedItems = Object.fromEntries(COLLECTIONS.map((name) => [name, new Set(model[name].items)])) as Record<typeof COLLECTIONS[number], Set<ContextOutputModel["recipes"]["items"][number]>>;
  for (const name of COLLECTIONS) for (const item of model[name].items) item.requiredClaimIds = item.requiredClaimIds.filter((id) => retained.has(id));
  const counter = new ContextOutputByteCounter(model);
  const itemSizes = new Map(COLLECTIONS.flatMap((name) => model[name].items.map((item) => [item, counter.recordBytes(item)] as const)));
  const itemRefCounts = new Map(COLLECTIONS.flatMap((name) => model[name].items.map((item) => [item, item.requiredClaimIds.length] as const)));
  const itemLinks = new Map<string, Array<{ name: typeof COLLECTIONS[number]; item: ContextOutputModel["recipes"]["items"][number]; count: number }>>();
  for (const name of COLLECTIONS) for (const item of model[name].items) {
    const counts = new Map<string, number>();
    for (const id of item.requiredClaimIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) {
      const links = itemLinks.get(id) ?? [];
      links.push({ name, item, count });
      itemLinks.set(id, links);
    }
  }
  const touchingEdges = new Map<string, ContextOutputEdge[]>();
  for (const edge of allEdges) for (const id of new Set([edge.sourceClaimId, edge.targetClaimId])) {
    const touching = touchingEdges.get(id) ?? [];
    touching.push(edge);
    touchingEdges.set(id, touching);
  }
  let requiredOmitted = false;
  let filesCount = allFiles.length;
  let commandsCount = allCommands.length;
  const hasBaseline = allClaims.some((claim) => claim.reasons.some((reason) => reason.code === "BASELINE_FALLBACK"));
  const refreshState = () => {
    model.completeness = missingIds.size || inactiveIds.size || requiredOmitted ? "incomplete" : "complete";
    model.warnings = [
      ...(request.mode === "task" && !taskMatches ? ["NO_TASK_MATCH"] : []),
      ...(hasBaseline ? ["BASELINE_FALLBACK"] : []),
      ...(missingIds.size ? ["REQUIRED_CONTEXT_MISSING"] : []),
      ...(inactiveIds.size ? ["REQUIRED_CONTEXT_INACTIVE"] : []),
      ...(requiredOmitted ? ["REQUIRED_CONTEXT_OMITTED"] : []),
      ...(Object.values(model.budget.omitted).some((value) => value > 0) ? ["OUTPUT_TRUNCATED"] : [])
    ];
  };
  const resultIfFits = (): ContextOutputResult | undefined => {
    refreshState();
    if (counter.measure(model) > cap) return undefined;
    model.roots = [...retainedRoots];
    model.claims = allClaims.filter((claim) => retained.has(claim.id));
    model.edges = allEdges.filter((edge) => retainedEdges.has(edge));
    model.files = allFiles.slice(0, filesCount);
    model.commands = model.commands.slice(0, commandsCount);
    for (const name of COLLECTIONS) model[name].items = [...retainedItems[name]].map((item) => ({ ...item, requiredClaimIds: item.requiredClaimIds.filter((id) => retained.has(id)) }));
    const stdout = serializeContextOutput(model);
    // Actual serialized bytes remain the final authority, independently of caching.
    if (model.budget.usedBytes > cap) return undefined;
    return { exitCode: 0, model, stdout, stderr: boundContextDiagnostics(options.stderr ?? "") };
  };
  const initial = resultIfFits();
  if (initial) return initial;
  // Preserve the exact sequential removal order, even at nonmonotone warning or
  // decimal-width transitions. Each payload/edge is encoded once and removed once.
  for (const command of [...model.commands].reverse()) {
    counter.remove("commands", command);
    commandsCount--;
    model.budget.omitted.commands++;
    const result = resultIfFits();
    if (result) return result;
  }
  for (const file of [...allFiles].reverse()) {
    counter.remove("files", file);
    filesCount--;
    model.budget.omitted.files++;
    const result = resultIfFits();
    if (result) return result;
  }
  for (const required of [false, true]) {
    for (const name of [...COLLECTIONS].reverse()) for (const item of [...retainedItems[name]].reverse()) {
      if (item.required !== required) continue;
      retainedItems[name].delete(item);
      counter.removeBytes(name, itemSizes.get(item)!);
      model.budget.omitted[name]++;
      if (item.required) requiredOmitted = true;
      const result = resultIfFits();
      if (result) return result;
    }
    for (const claim of [...allClaims].reverse()) {
      if (protectedIds.has(claim.id) !== required) continue;
      retained.delete(claim.id);
      counter.remove("claims", claim);
      model.budget.omitted.claims++;
      model.budget.omitted.sections += claim.sections.length;
      if (requiredIds.has(claim.id)) { model.budget.omitted.requiredClaims++; requiredOmitted = true; }
      if (retainedRoots.delete(claim.id)) counter.remove("roots", claim.id);
      for (const edge of touchingEdges.get(claim.id) ?? []) {
        if (!retainedEdges.delete(edge)) continue;
        counter.remove("edges", edge);
        model.budget.omitted.edges++;
        if (requiredEdges.has(edgeKey(edge))) requiredOmitted = true;
      }
      for (const { name, item, count } of itemLinks.get(claim.id) ?? []) {
        if (!retainedItems[name].has(item)) continue;
        const previous = itemRefCounts.get(item)!;
        const delta = count * counter.recordBytes(claim.id) + Math.max(0, previous - 1) - Math.max(0, previous - count - 1);
        itemRefCounts.set(item, previous - count);
        itemSizes.set(item, itemSizes.get(item)! - delta);
        counter.shrink(name, delta);
      }
      const result = resultIfFits();
      if (result) return result;
    }
  }
  return contextOutputError("BUDGET_TOO_SMALL", { maxBytes: cap, stderr: options.stderr });
}
