import { categoryVocabulary } from "./category_vocabulary";
import { normalizeContextOutputFilters } from "./context_output";
import type { ContextOutputFilters } from "./context_output_types";
import { RetrievalV2Error, type RetrievalCache } from "./retrieval_cache";

export const RETRIEVAL_STATUSES = ["current", "proposed", "needs_review", "stale", "deprecated", "experimental", "needs_verification", "rejected"] as const;
export function validateRetrievalFilters(filters: ContextOutputFilters = {}, cache: RetrievalCache): Required<ContextOutputFilters> {
  for (const values of Object.values(filters)) if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim()))) throw new RetrievalV2Error("INVALID_INPUT", "Filters must be lists of nonempty strings.");
  const vocabulary = categoryVocabulary(cache.loaded.config.category_vocabulary);
  const categories = [...(filters.categories ?? []), ...(filters.tags ?? []).filter(tag => tag.startsWith("concern:")).map(tag => tag.slice(8))];
  if (categories.some(category => !Object.hasOwn(vocabulary, category)) || filters.tags?.includes("concern:uncategorized")) throw new RetrievalV2Error("UNKNOWN_CATEGORY", `Unknown category. Run agent-memory categories list. Legal values include: ${Object.keys(vocabulary).sort().slice(0, 5).join(", ")}.`);
  const systems = new Set(cache.claims.map(claim => claim.system));
  if (filters.systems?.some(system => !systems.has(system))) throw new RetrievalV2Error("UNKNOWN_SYSTEM", "Unknown system in the selected corpus.");
  if (filters.statuses?.some(status => !(RETRIEVAL_STATUSES as readonly string[]).includes(status))) throw new RetrievalV2Error("UNKNOWN_STATUS", `Expected status: ${RETRIEVAL_STATUSES.join(", ")}.`);
  return normalizeContextOutputFilters(filters);
}
