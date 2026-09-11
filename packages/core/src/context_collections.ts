import { normalizeRepoRelativePath } from "./repo";
import { NotFoundError } from "./errors";
import path from "node:path";
import { listRecipes, searchRecipes } from "./recipes";
import { listProfileTraits, matchProfileTraits } from "./profiles";
import { listPlanTemplates, resolvePlanStageContext, showPlanRun, showPlanTemplate } from "./plans";
import { normalizeChangedFiles } from "./changes";
import { evaluateClaimSourcePath } from "./claim_sources";
import { toPosix } from "./files";
import { RetrievalV2Error, type RetrievalCache } from "./retrieval_cache";
import type { ContextOutputCollection, ContextOutputCollectionItem, ContextOutputData, ContextOutputSuggestion } from "./context_output_types";

export interface ContextCollectionSelectors {
  recipeIds?: string[]; planId?: string; stageId?: string; profileAlias?: string; profileTraitIds?: string[];
}
export type SelectedPlanStage = Awaited<ReturnType<typeof resolvePlanStageContext>>;

/** Existing selectors own eligibility, ranking, explicit inclusion and profile conflicts. */
export async function selectContextCollections(cache: RetrievalCache, options: ContextCollectionSelectors & { cwd?: string; task?: string }, files: string[], claimIds: string[], plan?: SelectedPlanStage, expandContext: (requiredIds: string[]) => string[] = () => claimIds): Promise<{
  recipes: ContextOutputCollection; plans: ContextOutputCollection; profiles: ContextOutputCollection;
  files: ContextOutputSuggestion[]; commands: ContextOutputSuggestion[];
}> {
  const cwd = cache.loaded.repo.root;
  const source = (relative: string) => toPosix(path.relative(cwd, path.resolve(cwd, cache.loaded.config.memory_root, relative)));
  const recipeIds = [...new Set([...(options.recipeIds ?? []), ...(plan?.stage.recipeRefs ?? [])])];
  const traitIds = [...new Set([...(options.profileTraitIds ?? []), ...(plan?.stage.profileTraits ?? [])])];
  const availableRecipes = await listRecipes({ cwd, includeInactive: recipeIds.length > 0 });
  // V2 uses one byte cap rather than v1 item caps. Discover all obligations before packing.
  const recipeMatches = (await searchRecipes({ cwd, query: options.task, completeTextMatches: true, changedFiles: files, claimIds, recipeIds, includeInactive: recipeIds.length > 0, limit: Number.MAX_SAFE_INTEGER })).matches;
  // As in v1's relatedRecipes pass, stage claims and first-pass recipe requirements
  // can associate further recipes, including authored inactive related workflows.
  const relatedClaimIds = [...new Set([...claimIds, ...(plan?.stage.claimRefs ?? []), ...recipeMatches.flatMap(match => match.recipe.requiredClaims)])];
  const related = (await searchRecipes({ cwd, changedFiles: files, claimIds: relatedClaimIds, includeInactive: true, limit: Number.MAX_SAFE_INTEGER })).matches;
  for (const match of related) if (!recipeMatches.some(selected => selected.recipe.id === match.recipe.id)) recipeMatches.push({ ...match, score: 1 });
  recipeMatches.sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id));
  const missingRecipeIds = recipeIds.filter(id => !recipeMatches.some(match => match.recipe.id === id));
  if (missingRecipeIds.length) throw new RetrievalV2Error("INVALID_INPUT", `Selected workflow references missing recipes: ${missingRecipeIds.join(", ")}. Inspect recipes list and review the saved plan references.`);
  const eligibleRecipeIds = new Set([...availableRecipes.recipes.map(recipe => recipe.id), ...related.map(match => match.recipe.id)]);
  const recipeItems = recipeMatches.map(({ recipe, score, reasons }): ContextOutputCollectionItem => ({ id: recipe.id, sourcePath: source(recipe.sourcePath), requiredClaimIds: recipe.requiredClaims, required: recipeIds.includes(recipe.id),
    data: data({ title: recipe.title, status: recipe.status, system: recipe.system, optionalClaims: recipe.optionalClaims, steps: recipe.steps, verification: recipe.verification, memoryUpdates: recipe.memoryUpdates, score, reasons: cache.loaded.config.context.include_recipe_diagnostics ? reasons : [] }) }));
  const templates = (await listPlanTemplates({ cwd })).templates;
  const planItems: ContextOutputCollectionItem[] = [];
  if (plan) {
    let sourcePath: string;
    try { sourcePath = toPosix(path.relative(cwd, showPlanRun({ cwd, id: plan.planId }).path)); }
    catch (error) {
      if (!(error instanceof NotFoundError) || !error.message.startsWith("Plan run not found:")) throw error;
      const template = templates.find(template => template.id === plan.planId) ?? (await showPlanTemplate({ cwd, id: plan.planId })).template;
      sourcePath = source(template.sourcePath);
    }
    planItems.push({ id: plan.planId, sourcePath, required: true, requiredClaimIds: plan.stage.claimRefs, data: data({ stage: plan.stage, warnings: plan.warnings }) });
  }
  const obligations = [...new Set([...recipeItems.flatMap(item => item.requiredClaimIds), ...(plan?.stage.claimRefs ?? [])])];
  // Graph expansion must see collection obligations before profiles inspect the resulting context.
  const required = new Set([...expandContext(obligations), ...obligations]);
  for (const id of required) for (const edge of cache.edges) if (edge.origin === "explicit" && edge.relation === "requires" && edge.sourceClaimId === id) required.add(edge.targetClaimId);
  const claims = cache.claims.filter(claim => required.has(claim.id));
  const profilesEnabled = cache.loaded.config.context.include_profile_traits;
  const availableProfiles = profilesEnabled ? (await listProfileTraits({ cwd, includeInactive: traitIds.length > 0 })).traits : [];
  const profiles = profilesEnabled ? await matchProfileTraits({ cwd, task: options.task, changedFiles: files,
    systems: [...new Set(claims.map(claim => claim.system))], recipeIds: recipeItems.map(item => item.id), planId: plan?.planId, stageId: plan?.stage.id,
    claimTypes: [...new Set(claims.flatMap(claim => typeof claim.metadata?.type === "string" ? [claim.metadata.type] : []))],
    profileAlias: options.profileAlias, traitIds, includeInactive: traitIds.length > 0, limit: Number.MAX_SAFE_INTEGER, strictExplicit: true }) : undefined;
  const profileItems = profiles?.traits.map(({ trait, score, reasons }): ContextOutputCollectionItem => ({ id: trait.id, sourcePath: source(trait.sourcePath), requiredClaimIds: [], required: traitIds.includes(trait.id),
    data: data({ title: trait.title, status: trait.status, category: trait.category, priority: trait.priority, snippet: trait.snippet, appliesWhen: trait.appliesWhen, conflictsWith: trait.conflictsWith, score, reasons, ...(cache.loaded.config.context.include_profile_diagnostics ? { diagnostics: profiles.diagnostics, droppedTraits: profiles.droppedTraits } : {}) }) })) ?? [];
  const suggestedFiles: ContextOutputSuggestion[] = [];
  const commands: ContextOutputSuggestion[] = [];
  const suggest = (kind: "recipe" | "plan", item: ContextOutputCollectionItem, paths: string[], checks: string[]) => {
    const origins = [{ kind, id: item.id, sourcePath: item.sourcePath }];
    for (const candidate of normalizeChangedFiles(paths, cwd)) {
      let value: string;
      try { value = normalizeRepoRelativePath(cwd, candidate); } catch { continue; }
      if (evaluateClaimSourcePath(value, cache.loaded.config.claim_sources, cwd).eligible) suggestedFiles.push({ value, origins });
    }
    for (const value of checks) commands.push({ value, origins });
  };
  recipeMatches.forEach(({ recipe }, index) => suggest("recipe", recipeItems[index], recipe.relevantFiles, recipe.verification));
  if (plan) suggest("plan", planItems[0], plan.stage.sourceFiles, plan.stage.verification);
  return { recipes: collection(eligibleRecipeIds.size, recipeItems), plans: collection(templates.length + (plan && !templates.some(template => template.id === plan.planId) ? 1 : 0), planItems),
    profiles: profilesEnabled ? collection(availableProfiles.length, profileItems) : { totalEligible: 0, matched: 0, state: "not_requested", items: [] }, files: suggestedFiles, commands };
}
function collection(totalEligible: number, items: ContextOutputCollectionItem[]): ContextOutputCollection { return { totalEligible, matched: items.length, state: items.length ? "matched" : totalEligible ? "no_match" : "empty", items }; }
function data(value: unknown): Record<string, ContextOutputData> { return JSON.parse(JSON.stringify(value)); }
