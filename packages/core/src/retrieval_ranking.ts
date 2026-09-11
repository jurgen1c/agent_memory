import { claimSearchTokens } from "./claim_sections";
import { contextClaimOutsideFilters, normalizeContextOutputFilters } from "./context_output";
import { pathMatchesPattern } from "./files";
import type { ContextOutputEvidence, ContextOutputFilters, ContextOutputRoot, ContextReasonCode } from "./context_output_types";
import type { RetrievalCache } from "./retrieval_cache";

export const codePointCompare = (a: string, b: string): number => {
  const left = Array.from(a, c => c.codePointAt(0)!); const right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
};
export interface RankRequest { task?: string; files: string[]; symbols: string[]; routes: string[]; filters?: ContextOutputFilters; browse: boolean }
export function rankClaimsV2(cache: RetrievalCache, request: RankRequest): ContextOutputRoot[] {
  const filters = normalizeContextOutputFilters(request.filters);
  const eligible = cache.claims.filter(claim => !contextClaimOutsideFilters(claim, filters).length);
  const claimsById = new Map(eligible.map(claim => [claim.id, claim]));
  const fieldKeys = new Map<string, Set<string>>();
  const tokens = claimSearchTokens(request.task ?? "");
  const evidence = new Map<string, ContextOutputEvidence>();
  for (const token of tokens) {
    const matches = new Map<string, RetrievalCache["terms"]>();
    const proseIds = new Set<string>();
    for (const term of cache.terms) {
      if (!claimsById.has(term.claim_id) || !term.token.startsWith(token)) continue;
      const rows = matches.get(term.claim_id) ?? [];
      rows.push(term); matches.set(term.claim_id, rows);
      if (term.field !== "tags") proseIds.add(term.claim_id);
    }
    // Tags are indexed and exposed but cannot establish a prose match or inflate IDF.
    const score = Math.log(1 + eligible.length / (1 + proseIds.size));
    for (const id of proseIds) {
      const item = evidence.get(id) ?? { tier: 2, textScore: 0, matchedTokens: [], fields: [] };
      const keys = fieldKeys.get(id) ?? new Set<string>();
      const claim = claimsById.get(id)!;
      item.textScore += score; item.matchedTokens.push(token);
      for (const term of matches.get(id)!) {
        const section = claim.sections[term.section_ordinal];
        const field = { field: term.field, ...(section ? { section: section.heading, startLine: section.startLine } : {}) };
        const key = JSON.stringify(field);
        if (!keys.has(key)) { keys.add(key); item.fields.push(field); }
      }
      fieldKeys.set(id, keys); evidence.set(id, item);
    }
  }
  const ranked: Array<{ id: string; reasons: ContextReasonCode[]; evidence: ContextOutputEvidence; status: string }> = [];
  for (const claim of eligible) {
    const reasons: ContextReasonCode[] = [];
    if (claim.associations!.files.some(file => request.files.includes(file))) reasons.push("EXACT_SOURCE");
    if (claim.associations!.symbols.some(symbol => request.symbols.includes(symbol))) reasons.push("EXACT_SYMBOL");
    if (claim.associations!.routes.some(route => request.routes.includes(route))) reasons.push("EXACT_ROUTE");
    const exact = reasons.length > 0;
    if (evidence.has(claim.id)) reasons.push("TEXT_MATCH");
    const related = claim.relatedFiles.some(file => request.files.includes(file));
    if (related) reasons.push("RELATED_FILE");
    const broad = cache.indexes.some(index => (index.watched_files ?? []).some(pattern => request.files.some(file => pathMatchesPattern(pattern, file))) && (index.claim_globs ?? []).some(pattern => pathMatchesPattern(pattern, claim.memoryPath)));
    if (broad) reasons.push("WATCHED_INDEX");
    if (request.browse) reasons.push("FILTER_BROWSE");
    if (!reasons.length) continue;
    const item = evidence.get(claim.id) ?? { tier: 5, textScore: 0, matchedTokens: [], fields: [] };
    item.tier = exact ? 1 : evidence.has(claim.id) ? 2 : related ? 3 : broad ? 4 : 5;
    ranked.push({ id: claim.id, reasons, evidence: item, status: claim.status });
  }
  const lifecycle = (status: string) => ["current", "needs_review", "proposed"].indexOf(status) < 0 ? 3 : ["current", "needs_review", "proposed"].indexOf(status);
  ranked.sort((a, b) => a.evidence.tier - b.evidence.tier || (request.browse ? lifecycle(a.status) - lifecycle(b.status) || (lifecycle(a.status) === 3 ? codePointCompare(a.status, b.status) : 0) : b.evidence.textScore - a.evidence.textScore) || codePointCompare(a.id, b.id));
  return ranked.flatMap(item => item.reasons.map(reason => ({ claimId: item.id, reason: reason as ContextOutputRoot["reason"], evidence: item.evidence })));
}
