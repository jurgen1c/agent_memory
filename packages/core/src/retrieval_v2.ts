import { NotFoundError } from "./errors";
import { canonicalContentDigest } from "./canonical_digest";
import { selectContextCollections, type ContextCollectionSelectors } from "./context_collections";
import { resolvePlanStageContext } from "./plans";
import { validateRetrievalFilters } from "./retrieval_filters";
import { normalizeChangedFiles, readGitDiffFiles } from "./changes";
import { evaluateClaimSourcePath } from "./claim_sources";
import { contextClaimOutsideFilters, normalizeContextOutputFilters, packContextOutput } from "./context_output";
import { contextOutputError, resolveContextOutputCap } from "./context_output_serialization";
import type { ContextOutputCandidates, ContextOutputClaim, ContextOutputFilters, ContextOutputRequest, ContextOutputResult, ContextOutputRoot } from "./context_output_types";
import { readRetrievalCache, RetrievalV2Error, type CachedClaim, type RetrievalCache } from "./retrieval_cache";
import { codePointCompare, rankClaimsV2 } from "./retrieval_ranking";

export interface QueryClaimsV2Options extends Omit<ContextOutputRequest, "mode"> {
  cwd?: string;
  query?: string;
  task?: string;
  changedFiles?: string[];
  symbols?: string[];
  routes?: string[];
  gitDiff?: boolean;
  limit?: number;
  depth?: number;
  includeInferred?: boolean;
}
export type BuildContextV2Options = QueryClaimsV2Options & ContextCollectionSelectors;
export interface ShowClaimV2Options { cwd?: string; id: string; budget?: ContextOutputRequest["budget"]; maxBytes?: number }

/** Query and context deliberately share the same production selector and envelope. */
export const queryClaimsV2 = (options: QueryClaimsV2Options): Promise<ContextOutputResult> => retrieve(options);
export const buildContextV2 = (options: BuildContextV2Options): Promise<ContextOutputResult> => retrieve(options, true);

async function retrieve(options: BuildContextV2Options, collections = false): Promise<ContextOutputResult> {
  try {
    validateInput(options);
    for (const value of [options.planId, options.stageId, options.profileAlias]) if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new RetrievalV2Error("INVALID_INPUT", "Collection selectors must be nonempty strings.");
    if (options.stageId && !options.planId) throw new RetrievalV2Error("INVALID_INPUT", "stageId requires planId.");
    for (const values of [options.recipeIds, options.profileTraitIds]) if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim()))) throw new RetrievalV2Error("INVALID_INPUT", "Collection selectors must be lists of nonempty IDs.");
    const cache = await readRetrievalCache(options.cwd);
    const digest = canonicalContentDigest(cache.loaded);
    const plan = collections && options.planId ? await resolvePlanStageContext({ ...options, planId: options.planId! }) : undefined;
    const filters = validateRetrievalFilters(options.filters, cache);
    const requestedFiles = normalizeChangedFiles([...(options.changedFiles ?? []), ...(plan?.stage.sourceFiles ?? []), ...(options.gitDiff ? readGitDiffFiles(cache.loaded.repo.root) : [])], cache.loaded.repo.root);
    if (requestedFiles.some(file => file === ".." || file.startsWith("../"))) throw new RetrievalV2Error("INVALID_INPUT", "Changed files must be inside this repository.");
    const files = [...new Set(requestedFiles)].filter(file => evaluateClaimSourcePath(file, cache.loaded.config.claim_sources, cache.loaded.repo.root).eligible).sort(codePointCompare);
    const task = options.task ?? options.query;
    const browse = !task?.trim() && !requestedFiles.length && !options.gitDiff && !options.symbols?.length && !options.routes?.length;
    if (browse && !Object.values(options.filters ?? {}).some(values => values?.length) && !(collections && (options.recipeIds?.length || options.planId || options.profileAlias || options.profileTraitIds?.length))) throw new RetrievalV2Error("INPUT_REQUIRED", "Supply task text, exact files/symbols/routes, or a category/tag/system/status filter.");
    const selectorOnly = browse && !Object.values(options.filters ?? {}).some(values => values?.length);
    let roots = selectorOnly ? [] : rankClaimsV2(cache, { task, files, symbols: options.symbols ?? [], routes: options.routes ?? [], filters, browse });
    const taskMatchCount = new Set(roots.filter(root => ["TEXT_MATCH", "EXACT_SOURCE", "EXACT_SYMBOL", "EXACT_ROUTE"].includes(root.reason)).map(root => root.claimId)).size;
    if (options.baseline && !browse && taskMatchCount === 0) {
      roots.push(...cache.claims.filter(claim => claim.metadata?.severity === "critical" && !contextClaimOutsideFilters(claim, normalizeContextOutputFilters(filters)).length).map(claim => ({ claimId: claim.id, reason: "BASELINE_FALLBACK" as const })));
    }
    const allRootIds = new Set(roots.map(root => root.claimId));
    // A limit controls optional roots, never obligations already discovered in the ranked set.
    const rootIds = [...allRootIds].slice(0, options.limit);
    const requiredClaimIds = cache.edges.filter(edge => edge.origin === "explicit" && edge.relation === "requires" && allRootIds.has(edge.sourceClaimId) && !rootIds.includes(edge.sourceClaimId)).map(edge => edge.sourceClaimId);
    roots = roots.filter(root => rootIds.includes(root.claimId));
    const expand = (obligations: string[] = []): string[] => {
      requiredClaimIds.push(...obligations);
      roots = expandOptionalRoots(cache, roots, options.depth ?? 0, options.includeInferred ?? false, filters, options.limit, requiredClaimIds);
      return [...roots.map(root => root.claimId), ...requiredClaimIds];
    };
    const selected = collections ? await selectContextCollections(cache, { ...options, task }, files, [...allRootIds], plan, expand) : undefined;
    if (!collections) expand();
    const candidates: ContextOutputCandidates = { roots, requiredClaimIds, taskMatchCount, claims: cache.claims.map(claim => payload(claim, false)), edges: cache.edges.filter(edge => edge.origin === "explicit" || options.includeInferred === true),
      ...(selected ? { recipes: selected.recipes, plans: selected.plans, profiles: selected.profiles } : {}) };
    candidates.files = [...cache.claims.flatMap(claim => [...claim.associations!.files, ...claim.relatedFiles].map(value => ({ value, origins: [{ kind: "claim" as const, id: claim.id, sourcePath: claim.sourcePath }] }))), ...(selected?.files ?? [])];
    candidates.commands = [...cache.claims.flatMap(claim => claim.verification.map(value => ({ value, origins: [{ kind: "claim" as const, id: claim.id, sourcePath: claim.sourcePath }] }))), ...(selected?.commands ?? [])];
    if (canonicalContentDigest(cache.loaded) !== digest) throw new RetrievalV2Error("CACHE_STALE", "Canonical memory changed while selecting workflows. Recompile and retry.");
    return packContextOutput({ mode: browse ? "browse" : "task", ...options, filters }, candidates);
  } catch (error) { return retrievalError(error, options); }
}

export async function showClaimV2(options: ShowClaimV2Options): Promise<ContextOutputResult> {
  try {
    if (resolveContextOutputCap(options) === undefined) return contextOutputError("BUDGET_TOO_SMALL", { invalidCap: true });
    if (typeof options.id !== "string" || !options.id.trim()) throw new RetrievalV2Error("INVALID_INPUT", "show requires one claim ID.");
    const cache = await readRetrievalCache(options.cwd);
    const claim = cache.claims.find(item => item.id === options.id);
    if (!claim) throw new RetrievalV2Error("CLAIM_NOT_FOUND", "Claim not found in this checkout.");
    // Complete inspection is independent of task eligibility and graph expansion.
    const result = packContextOutput({ ...options, mode: "browse", filters: { statuses: [claim.status] } }, { roots: [{ claimId: claim.id, reason: "FILTER_BROWSE" }], claims: [payload(claim, true)] });
    if (result.exitCode === 0 && (result.model.claims.length !== 1 || result.model.budget.omitted.claims > 0 || result.model.budget.omitted.sections > 0)) return contextOutputError("BUDGET_TOO_SMALL", { stderr: "Complete claim exceeds the cap. Increase --max-bytes or inspect its canonical file." });
    return result;
  } catch (error) { return retrievalError(error, options); }
}

function payload(claim: CachedClaim, complete: boolean): ContextOutputClaim {
  const { memoryPath: _memoryPath, relatedFiles, verification: _verification, ...output } = claim;
  // Retrieval carries complete excerpts; show additionally carries the unabridged document and metadata.
  if (!complete) { delete output.body; delete output.metadata; }
  output.associations = { ...output.associations!, relatedFiles };
  return output;
}

function validateInput(options: QueryClaimsV2Options): void {
  if (resolveContextOutputCap(options) === undefined) throw new RetrievalV2Error("BUDGET_TOO_SMALL", "Invalid output cap.");
  if (options.task !== undefined && options.query !== undefined) throw new RetrievalV2Error("INVALID_INPUT", "Supply task or query, once.");
  const task = options.task ?? options.query;
  if (task !== undefined && (typeof task !== "string" || Buffer.byteLength(task, "utf8") > 65536)) throw new RetrievalV2Error("INVALID_INPUT", "Task text must be at most 64 KiB UTF-8.");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) throw new RetrievalV2Error("INVALID_INPUT", "limit must be a positive integer.");
  if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 0 || options.depth > 10)) throw new RetrievalV2Error("INVALID_INPUT", "depth must be an integer from 0 through 10; required closure is never capped.");
  for (const values of [options.changedFiles, options.symbols, options.routes, ...Object.values(options.filters ?? {})]) if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim()))) throw new RetrievalV2Error("INVALID_INPUT", "Filters and associations must be lists of nonempty strings.");
}

function expandOptionalRoots(cache: RetrievalCache, roots: ContextOutputRoot[], depth: number, inferred: boolean, filters: ContextOutputFilters, limit?: number, requiredIds: string[] = []): ContextOutputRoot[] {
  const selected = new Set([...roots.map(root => root.claimId), ...requiredIds]);
  const claimsById = new Map(cache.claims.map(claim => [claim.id, claim]));
  const requiredTargets = new Map<string, string[]>();
  for (const edge of cache.edges) {
    if (edge.origin !== "explicit" || edge.relation !== "requires") continue;
    const targets = requiredTargets.get(edge.sourceClaimId) ?? [];
    targets.push(edge.targetClaimId); requiredTargets.set(edge.sourceClaimId, targets);
  }
  const visited = new Set<string>();
  const requiredClosure = (seeds: string[]): string[] => {
    const queue = [...seeds]; const added: string[] = [];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (visited.has(id)) continue;
      visited.add(id);
      for (const target of requiredTargets.get(id) ?? []) {
        if (!selected.has(target)) { selected.add(target); added.push(target); }
        if (!visited.has(target)) queue.push(target);
      }
    }
    return added;
  };
  requiredClosure([...selected]);
  let frontier = new Set(selected);
  let rootCount = new Set(roots.map(root => root.claimId)).size;
  const normalizedFilters = normalizeContextOutputFilters(filters);
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const edge of cache.edges) {
      if (rootCount >= (limit ?? Infinity)) return roots;
      if (edge.origin === "inferred" && !inferred) continue;
      const target = frontier.has(edge.sourceClaimId) ? edge.targetClaimId : frontier.has(edge.targetClaimId) ? edge.sourceClaimId : undefined;
      if (!target || selected.has(target)) continue;
      const claim = claimsById.get(target);
      if (!claim || contextClaimOutsideFilters(claim, normalizedFilters).length) continue;
      roots.push({ claimId: target, reason: "RELATED_CONTEXT" }); selected.add(target); next.push(target); rootCount++;
      next.push(...requiredClosure([target]));
    }
    frontier = new Set(next);
  }
  return roots;
}

function retrievalError(error: unknown, options: { budget?: ContextOutputRequest["budget"]; maxBytes?: number }): ContextOutputResult {
  if (error instanceof NotFoundError) return contextOutputError("INVALID_INPUT", { message: error.message, maxBytes: options.maxBytes });
  if (error instanceof RetrievalV2Error) return contextOutputError(error.code, { message: error.message, maxBytes: options.maxBytes, invalidCap: error.code === "BUDGET_TOO_SMALL" });
  return contextOutputError("VALIDATION_FAILED", { message: error instanceof Error ? error.message : "Could not read canonical memory.", maxBytes: options.maxBytes });
}
