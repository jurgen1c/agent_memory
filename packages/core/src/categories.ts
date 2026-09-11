import { categoryVocabulary, claimCategories } from "./category_vocabulary";
import { contextClaimOutsideFilters } from "./context_output";
import { contextOutputError, resolveContextOutputCap, serializeBudgetedOutput } from "./context_output_serialization";
import type { ContextOutputFilters, ContextOutputRequest, ContextOutputResult } from "./context_output_types";
import { readRetrievalCache, RetrievalV2Error } from "./retrieval_cache";
import { validateRetrievalFilters } from "./retrieval_filters";

export interface ListCategoriesOptions {
  cwd?: string;
  counts?: boolean;
  filters?: Pick<ContextOutputFilters, "systems" | "statuses">;
  budget?: ContextOutputRequest["budget"];
  maxBytes?: number;
}
export interface CategoriesModel {
  schemaVersion: 2;
  filters: { systems: string[]; statuses: string[] };
  categories: Array<{ slug: string; description: string; count?: number }>;
  budget: { maxBytes: number; usedBytes: number };
}
export type ListCategoriesResult = { exitCode: 0; model: CategoriesModel; stdout: string; stderr: string } | Exclude<ContextOutputResult, { exitCode: 0 }>;

/** Lists the complete checkout-owned vocabulary; counts never expand graph closure. */
export async function listCategories(options: ListCategoriesOptions = {}): Promise<ListCategoriesResult> {
  try {
    const maxBytes = resolveContextOutputCap(options);
    if (maxBytes === undefined) return contextOutputError("BUDGET_TOO_SMALL", { invalidCap: true });
    if (options.counts !== undefined && typeof options.counts !== "boolean") throw new RetrievalV2Error("INVALID_INPUT", "counts must be a boolean.");
    if (Object.keys(options.filters ?? {}).some(key => key !== "systems" && key !== "statuses")) throw new RetrievalV2Error("INVALID_INPUT", "categories list accepts system/status filters only.");
    const cache = await readRetrievalCache(options.cwd);
    const filters = validateRetrievalFilters(options.filters, cache);
    const counts = new Map<string, Set<string>>();
    if (options.counts) for (const claim of cache.claims) {
      if (contextClaimOutsideFilters(claim, filters).length) continue;
      for (const category of claimCategories(claim.tags)) {
        const ids = counts.get(category) ?? new Set<string>(); ids.add(claim.id); counts.set(category, ids);
      }
    }
    const vocabulary = categoryVocabulary(cache.loaded.config.category_vocabulary);
    const model: CategoriesModel = {
      schemaVersion: 2, filters: { systems: filters.systems, statuses: filters.statuses },
      categories: Object.keys(vocabulary).sort().map(slug => ({ slug, description: vocabulary[slug], ...(options.counts ? { count: counts.get(slug)?.size ?? 0 } : {}) })),
      budget: { maxBytes, usedBytes: 0 }
    };
    const stdout = serializeBudgetedOutput(model);
    if (Buffer.byteLength(stdout) > maxBytes) return contextOutputError("BUDGET_TOO_SMALL", { stderr: "Complete vocabulary exceeds the cap. Increase --max-bytes." });
    return { exitCode: 0, model, stdout, stderr: "" };
  } catch (error) {
    return contextOutputError(error instanceof RetrievalV2Error ? error.code : "VALIDATION_FAILED", { message: error instanceof Error ? error.message : "Could not read repository categories.", maxBytes: options.maxBytes });
  }
}

export function renderCategoriesHuman(model: CategoriesModel): string {
  const text = `Categories\nFilters: ${JSON.stringify(model.filters)}\n${model.categories.map(category => `${category.slug}${category.count === undefined ? "" : ` (${category.count})`}: ${category.description}`).join("\n")}\nBudget: ${JSON.stringify(model.budget)}\n`;
  return Buffer.byteLength(text) <= model.budget.maxBytes ? text : serializeBudgetedOutput(model);
}
