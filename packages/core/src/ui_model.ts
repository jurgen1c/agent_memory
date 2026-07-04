import fs from "node:fs";
import path from "node:path";
import { compileMemory, type CompileResult } from "./compiler";
import { loadConfig, renderYamlScalar } from "./config";
import { doctorMemory, type DoctorResult } from "./doctor";
import { AgentMemoryError, NotFoundError } from "./errors";
import { discoverCanonicalMemoryFiles, resolveConfiguredPath, toPosix } from "./files";
import { parseMarkdown } from "./markdown";
import {
  loadMemory,
  type LoadedMemory,
  type MemoryClaim,
  type MemoryGraphEdge,
  type MemoryPlanTemplate,
  type MemoryProfileTrait,
  type MemoryRecipe
} from "./memory";
import { blockPlanStage, completePlanStage, type PlanRunDetail, type PlanRunStageStatus } from "./plans";
import { commandPrefixForRepo } from "./skills";
import { validateRepository, type ValidationResult } from "./validator";
import { parseYaml } from "./yaml";

export const CLAIM_STATUSES = [
  "current",
  "proposed",
  "stale",
  "deprecated",
  "experimental",
  "needs_verification",
  "needs_review",
  "rejected"
] as const;

export const CLAIM_CONFIDENCE_VALUES = ["low", "medium", "high", "verified"] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ClaimConfidence = (typeof CLAIM_CONFIDENCE_VALUES)[number];
export type UiRelationOrigin = "explicit" | "inferred" | "recipe" | "replacement";

export interface UiMemoryModel {
  repoRoot: string;
  memoryRoot: string;
  databasePath: string;
  commandPrefix: string;
  health: UiHealth;
  graph: UiGraphSummary;
  files: UiFileNode;
  workflowSummary: UiWorkflowSummary;
  validation: ValidationResult;
  doctor: DoctorResult;
  reviewQueue: UiReviewItem[];
}

export interface UiHealth {
  healthy: boolean;
  validationValid: boolean;
  doctorHealthy: boolean;
}

export interface UiClaimSummary {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  sourcePath: string;
  tags: string[];
  reviewPriority: number;
  reviewReason?: string;
}

export interface UiClaim extends UiClaimSummary {
  sourceFiles: string[];
  relatedFiles: string[];
  symbols: string[];
  routes: string[];
  verification: string[];
  body: string;
  raw: Record<string, unknown>;
}

export interface UiRelation {
  id: string;
  source: string;
  target: string;
  relation: string;
  reason?: string;
  strength: number;
  origin: UiRelationOrigin;
  sourcePath?: string;
  bidirectional: boolean;
}

export interface UiFileNode {
  name: string;
  path: string;
  kind: "directory" | "claim" | "graph" | "index" | "recipe" | "plan" | "profile" | "waiver" | "file";
  claimId?: string;
  children?: UiFileNode[];
}

export interface UiWorkflowSummary {
  recipeCount: number;
  planTemplateCount: number;
  profileTraitCount: number;
  activePlanRunCount: number;
  completedPlanRunCount: number;
  abandonedPlanRunCount: number;
  blockedPlanRunCount: number;
  warnings: string[];
}

export interface UiRecipeSummary {
  id: string;
  title: string;
  system: string;
  status: string;
  sourcePath: string;
  requiredClaims: string[];
  intentTriggers: string[];
  steps: string[];
  verification: string[];
  raw: Record<string, unknown>;
}

export interface UiPlanTemplateStageSummary {
  id: string;
  title: string;
  goal: string;
  sequence: number;
  claimRefs: string[];
  recipeRefs: string[];
  profileTraits: string[];
  sourceFiles: string[];
  verification: string[];
  doneWhen: string[];
  memoryUpdates: string[];
}

export interface UiPlanTemplateSummary {
  id: string;
  title: string;
  system: string;
  status: string;
  sourcePath: string;
  intentTriggers: string[];
  stages: UiPlanTemplateStageSummary[];
  raw: Record<string, unknown>;
}

export interface UiProfileTraitSummary {
  id: string;
  title: string;
  status: string;
  category: string;
  priority: string;
  sourcePath: string;
  appliesWhen: Record<string, unknown>;
  snippet: string;
  conflictsWith: string[];
  raw: Record<string, unknown>;
}

export interface UiPlanRunStageSummary {
  id: string;
  title: string;
  goal: string;
  status: PlanRunStageStatus;
  claimRefs: string[];
  recipeRefs: string[];
  profileTraits: string[];
  sourceFiles: string[];
  verification: string[];
  doneWhen: string[];
  memoryUpdates: string[];
  startedAt?: string;
  completedAt?: string;
  blockedAt?: string;
  evidence: string[];
  reason?: string;
}

export interface UiPlanRunSummary {
  id: string;
  templateId?: string;
  task: string;
  status: string;
  currentStage: string;
  branch?: string;
  baseCommit?: string;
  createdAt: string;
  updatedAt: string;
  path: string;
  warnings: string[];
  stages: UiPlanRunStageSummary[];
}

export interface UiReviewItem {
  claimId: string;
  title: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  sourcePath: string;
  priority: number;
  reason: string;
}

export interface UiGraphSummary {
  systems: UiSystemNode[];
  systemRelations: UiSystemRelation[];
}

export interface UiSystemNode {
  id: string;
  system: string;
  color: string;
  claimCount: number;
  statusCounts: Record<string, number>;
  severityCounts: Record<string, number>;
  reviewCount: number;
  searchText: string;
}

export interface UiSystemRelation {
  id: string;
  source: string;
  target: string;
  relation: string;
  origin: UiRelationOrigin;
  count: number;
  strength: number;
  bidirectional: boolean;
}

export interface UiSystemGraph {
  system: string;
  claims: UiClaimSummary[];
  relations: UiRelation[];
}

export interface UiClaimDetail {
  claim: UiClaim;
  relations: UiRelation[];
  relatedClaims: UiClaim[];
}

export interface ReviewClaimOptions {
  cwd?: string;
  id: string;
  status: string;
  confidence?: string;
}

export interface ReviewClaimResult {
  claim: UiClaim;
  validation: ValidationResult;
  compile?: CompileResult;
  doctor?: DoctorResult;
}

export interface UpdateUiPlanRunStageOptions {
  cwd?: string;
  id: string;
  stageId: string;
  status: "complete" | "blocked";
  evidence?: string;
  reason?: string;
}

export interface UpdateUiWorkflowArtifactOptions {
  cwd?: string;
  kind: "recipe" | "plan" | "profile";
  id: string;
  patch: Record<string, unknown>;
}

export interface UpdateUiWorkflowArtifactResult {
  artifact: UiRecipeSummary | UiPlanTemplateSummary | UiProfileTraitSummary;
  validation: ValidationResult;
}

export async function buildUiMemoryModel(cwd?: string): Promise<UiMemoryModel> {
  const loaded = loadConfig({ cwd });
  const memory = loadMemory(cwd);
  const repoRoot = loaded.repo.root;
  const memoryRoot = resolveConfiguredPath(repoRoot, loaded.config.memory_root);
  const databasePath = path.isAbsolute(loaded.config.database_path) ? loaded.config.database_path : path.join(repoRoot, loaded.config.database_path);
  const validation = validateRepository({ cwd });
  const doctor = await doctorMemory({ cwd });
  const claims = memory.claims.map(toUiClaimSummary);
  const relations = buildUiRelations(memory);
  const planRuns = readUiPlanRuns(repoRoot);

  return {
    repoRoot,
    memoryRoot: loaded.config.memory_root,
    databasePath,
    commandPrefix: commandPrefixForRepo(repoRoot),
    health: {
      healthy: validation.valid && doctor.healthy,
      validationValid: validation.valid,
      doctorHealthy: doctor.healthy
    },
    graph: buildUiGraphSummary(claims, relations),
    files: buildFileTree(repoRoot, memoryRoot, loaded.config, claims),
    workflowSummary: buildWorkflowSummary(memory, planRuns),
    validation,
    doctor,
    reviewQueue: buildReviewQueue(claims)
  };
}

export function getUiRecipes(cwd?: string): UiRecipeSummary[] {
  return loadMemory(cwd).recipes.map(toUiRecipeSummary);
}

export function getUiPlans(cwd?: string): UiPlanTemplateSummary[] {
  return loadMemory(cwd).plans.map(toUiPlanTemplateSummary);
}

export function getUiProfiles(cwd?: string): UiProfileTraitSummary[] {
  return loadMemory(cwd).profiles.map(toUiProfileTraitSummary);
}

export function getUiPlanRuns(cwd?: string): { runs: UiPlanRunSummary[]; warnings: string[] } {
  const loaded = loadConfig({ cwd });
  return readUiPlanRuns(loaded.repo.root);
}

export function updateUiPlanRunStage(options: UpdateUiPlanRunStageOptions): UiPlanRunSummary {
  try {
    const loaded = loadConfig({ cwd: options.cwd });
    const result =
      options.status === "complete"
        ? completePlanStage({
            cwd: options.cwd,
            id: options.id,
            stageId: options.stageId,
            evidence: options.evidence ?? ""
          })
        : blockPlanStage({
            cwd: options.cwd,
            id: options.id,
            stageId: options.stageId,
            reason: options.reason ?? ""
          });

    return toUiPlanRunSummary(result.run, result.path, loaded.repo.root, result.warnings);
  } catch (error) {
    if (error instanceof AgentMemoryError && error.code === "NOT_FOUND") {
      throw error;
    }

    if (error instanceof AgentMemoryError) {
      throw new AgentMemoryError(error.message, {
        code: "BAD_REQUEST",
        details: error.details,
        cause: error
      });
    }

    throw error;
  }
}

export function updateUiWorkflowArtifact(options: UpdateUiWorkflowArtifactOptions): UpdateUiWorkflowArtifactResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const memoryRoot = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  const memory = loadMemory(options.cwd);

  if (options.kind === "recipe") {
    const recipe = memory.recipes.find((candidate) => candidate.id === options.id);
    if (!recipe) {
      throw new NotFoundError(`Recipe not found: ${options.id}`);
    }

    updateYamlFile(path.join(memoryRoot, recipe.sourcePath), recipePatchOperations(options.patch));
    return {
      artifact: toUiRecipeSummary(loadMemory(options.cwd).recipes.find((candidate) => candidate.id === options.id) ?? recipe),
      validation: validateRepository({ cwd: options.cwd })
    };
  }

  if (options.kind === "plan") {
    const plan = memory.plans.find((candidate) => candidate.id === options.id);
    if (!plan) {
      throw new NotFoundError(`Plan template not found: ${options.id}`);
    }

    updateYamlFile(path.join(memoryRoot, plan.sourcePath), planPatchOperations(options.patch));
    return {
      artifact: toUiPlanTemplateSummary(loadMemory(options.cwd).plans.find((candidate) => candidate.id === options.id) ?? plan),
      validation: validateRepository({ cwd: options.cwd })
    };
  }

  const profile = memory.profiles.find((candidate) => candidate.id === options.id);
  if (!profile) {
    throw new NotFoundError(`Profile trait not found: ${options.id}`);
  }

  updateYamlFile(path.join(memoryRoot, profile.sourcePath), profilePatchOperations(options.patch));
  return {
    artifact: toUiProfileTraitSummary(loadMemory(options.cwd).profiles.find((candidate) => candidate.id === options.id) ?? profile),
    validation: validateRepository({ cwd: options.cwd })
  };
}

export function getUiClaimDetail(cwd: string | undefined, id: string): UiClaimDetail {
  const loaded = loadConfig({ cwd });
  const memory = loadMemory(cwd);
  const memoryRoot = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  const claims = memory.claims.map((claim) => toUiClaim(memoryRoot, claim));
  const claim = claims.find((candidate) => candidate.id === id);

  if (!claim) {
    throw new NotFoundError(`Claim not found: ${id}`);
  }

  const relations = buildUiRelations(memory).filter((relation) => relation.source === id || relation.target === id);
  const relatedIds = new Set(relations.map((relation) => (relation.source === id ? relation.target : relation.source)));

  return {
    claim,
    relations,
    relatedClaims: claims.filter((candidate) => relatedIds.has(candidate.id))
  };
}

export function getUiSystemGraph(cwd: string | undefined, system: string): UiSystemGraph {
  const memory = loadMemory(cwd);
  const claims = memory.claims.map(toUiClaimSummary);
  const systemClaims = claims.filter((claim) => claim.system === system);

  if (systemClaims.length === 0) {
    throw new NotFoundError(`System not found: ${system}`);
  }

  const systemClaimIds = new Set(systemClaims.map((claim) => claim.id));

  return {
    system,
    claims: systemClaims,
    relations: buildUiRelations(memory).filter((relation) => systemClaimIds.has(relation.source) || systemClaimIds.has(relation.target))
  };
}

export async function reviewClaim(options: ReviewClaimOptions): Promise<ReviewClaimResult> {
  const status = parseClaimStatus(options.status);
  const confidence = options.confidence === undefined ? undefined : parseClaimConfidence(options.confidence);
  const loaded = loadConfig({ cwd: options.cwd });
  const memory = loadMemory(options.cwd);
  const claim = memory.claims.find((candidate) => candidate.id === options.id);

  if (!claim) {
    throw new NotFoundError(`Claim not found: ${options.id}`);
  }

  const memoryRoot = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  const absolutePath = path.join(memoryRoot, claim.sourcePath);
  updateClaimFrontmatter(absolutePath, {
    status,
    confidence,
    updated_at: new Date().toISOString()
  });

  const validation = validateRepository({ cwd: options.cwd });
  let compile: CompileResult | undefined;
  let doctor: DoctorResult | undefined;

  if (validation.valid) {
    compile = await compileMemory({ cwd: options.cwd });
    doctor = await doctorMemory({ cwd: options.cwd });
  }

  return {
    claim: toUiClaim(memoryRoot, loadMemory(options.cwd).claims.find((candidate) => candidate.id === options.id) ?? claim),
    validation,
    compile,
    doctor
  };
}

export async function syncUiMemory(cwd?: string): Promise<{ compile: CompileResult; validation: ValidationResult; doctor: DoctorResult }> {
  const compile = await compileMemory({ cwd });
  const validation = validateRepository({ cwd });
  const doctor = await doctorMemory({ cwd });

  return {
    compile,
    validation,
    doctor
  };
}

function toUiClaimSummary(claim: MemoryClaim): UiClaimSummary {
  const review = reviewPriorityForClaim(claim);

  return {
    id: claim.id,
    type: claim.type,
    system: claim.system,
    status: claim.status,
    confidence: claim.confidence,
    severity: claim.severity,
    title: claim.title,
    claim: claim.claim,
    sourcePath: toPosix(claim.sourcePath),
    tags: claim.tags,
    reviewPriority: review.priority,
    reviewReason: review.reason
  };
}

function toUiClaim(memoryRoot: string, claim: MemoryClaim): UiClaim {
  const parsed = parseMarkdown(fs.readFileSync(path.join(memoryRoot, claim.sourcePath), "utf8"));

  return {
    ...toUiClaimSummary(claim),
    sourceFiles: claim.sourceFiles,
    relatedFiles: claim.relatedFiles,
    symbols: claim.symbols,
    routes: claim.routes,
    verification: claim.verification,
    body: parsed.body,
    raw: claim.raw
  };
}

function toUiRecipeSummary(recipe: MemoryRecipe): UiRecipeSummary {
  return {
    id: recipe.id,
    title: recipe.title,
    system: recipe.system,
    status: recipe.status,
    sourcePath: toPosix(recipe.sourcePath),
    requiredClaims: recipe.requiredClaims,
    intentTriggers: recipe.intentTriggers,
    steps: recipe.steps,
    verification: recipe.verification,
    raw: recipe.raw
  };
}

function toUiPlanTemplateSummary(plan: MemoryPlanTemplate): UiPlanTemplateSummary {
  return {
    id: plan.id,
    title: plan.title,
    system: plan.system,
    status: plan.status,
    sourcePath: toPosix(plan.sourcePath),
    intentTriggers: plan.intentTriggers,
    stages: plan.stages.map((stage) => ({
      id: stage.id,
      title: stage.title,
      goal: stage.goal,
      sequence: stage.sequence,
      claimRefs: readStringArray(stage.raw, "claim_refs"),
      recipeRefs: readStringArray(stage.raw, "recipe_refs"),
      profileTraits: readStringArray(stage.raw, "profile_traits"),
      sourceFiles: readStringArray(stage.raw, "source_files"),
      verification: readStringArray(stage.raw, "verification"),
      doneWhen: readStringArray(stage.raw, "done_when"),
      memoryUpdates: readStringArray(stage.raw, "memory_updates")
    })),
    raw: plan.raw
  };
}

function toUiProfileTraitSummary(profile: MemoryProfileTrait): UiProfileTraitSummary {
  return {
    id: profile.id,
    title: profile.title,
    status: profile.status,
    category: profile.category,
    priority: profile.priority,
    sourcePath: toPosix(profile.sourcePath),
    appliesWhen: profile.appliesWhen,
    snippet: profile.snippet,
    conflictsWith: readStringArray(profile.raw, "conflicts_with"),
    raw: profile.raw
  };
}

function buildWorkflowSummary(memory: LoadedMemory, planRuns: { runs: UiPlanRunSummary[]; warnings: string[] }): UiWorkflowSummary {
  const activePlanRunCount = planRuns.runs.filter((run) => run.status === "active").length;
  const completedPlanRunCount = planRuns.runs.filter((run) => run.status === "complete").length;
  const abandonedPlanRunCount = planRuns.runs.filter((run) => run.status === "abandoned").length;
  const blockedPlanRunCount = planRuns.runs.filter((run) => run.status === "blocked").length;

  return {
    recipeCount: memory.recipes.length,
    planTemplateCount: memory.plans.length,
    profileTraitCount: memory.profiles.length,
    activePlanRunCount,
    completedPlanRunCount,
    abandonedPlanRunCount,
    blockedPlanRunCount,
    warnings: planRuns.warnings
  };
}

function readUiPlanRuns(repoRoot: string): { runs: UiPlanRunSummary[]; warnings: string[] } {
  const root = path.join(repoRoot, ".agent-memory/plans");
  const warnings: string[] = [];
  const runs: UiPlanRunSummary[] = [];

  if (!fs.existsSync(root)) {
    return { runs, warnings };
  }

  for (const filePath of walkYamlFiles(root)) {
    try {
      const run = parseUiPlanRunFile(filePath);
      runs.push(toUiPlanRunSummary(run, filePath, repoRoot, []));
    } catch (error) {
      warnings.push(`${toPosix(path.relative(repoRoot, filePath))}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return { runs, warnings };
}

function parseUiPlanRunFile(filePath: string): PlanRunDetail {
  const data = readRecord(parseYaml(fs.readFileSync(filePath, "utf8")));

  return {
    id: readString(data, "id"),
    templateId: readOptionalString(data, "template_id"),
    templateSnapshotHash: readOptionalString(data, "template_snapshot_hash"),
    task: readString(data, "task"),
    createdAt: readString(data, "created_at"),
    updatedAt: readString(data, "updated_at"),
    status: readString(data, "status") as PlanRunDetail["status"],
    currentStage: readString(data, "current_stage"),
    branch: readOptionalString(data, "branch"),
    baseCommit: readOptionalString(data, "base_commit"),
    path: filePath,
    stages: readRecords(data, "stages").map((stage) => ({
      id: readString(stage, "id"),
      title: readString(stage, "title"),
      goal: readString(stage, "goal"),
      status: readString(stage, "status") as PlanRunStageStatus,
      claimRefs: readStringArray(stage, "claim_refs"),
      recipeRefs: readStringArray(stage, "recipe_refs"),
      profileTraits: readStringArray(stage, "profile_traits"),
      sourceFiles: readStringArray(stage, "source_files"),
      verification: readStringArray(stage, "verification"),
      doneWhen: readStringArray(stage, "done_when"),
      memoryUpdates: readStringArray(stage, "memory_updates"),
      startedAt: readOptionalString(stage, "started_at"),
      completedAt: readOptionalString(stage, "completed_at"),
      blockedAt: readOptionalString(stage, "blocked_at"),
      evidence: readStringArray(stage, "evidence"),
      reason: readOptionalString(stage, "reason")
    }))
  };
}

function toUiPlanRunSummary(run: PlanRunDetail, filePath: string, repoRoot: string, warnings: string[]): UiPlanRunSummary {
  return {
    id: run.id,
    templateId: run.templateId,
    task: run.task,
    status: run.status,
    currentStage: run.currentStage,
    branch: run.branch,
    baseCommit: run.baseCommit,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    path: toPosix(path.relative(repoRoot, filePath)),
    warnings,
    stages: run.stages.map((stage) => ({
      id: stage.id,
      title: stage.title,
      goal: stage.goal,
      status: stage.status,
      claimRefs: stage.claimRefs,
      recipeRefs: stage.recipeRefs,
      profileTraits: stage.profileTraits,
      sourceFiles: stage.sourceFiles,
      verification: stage.verification,
      doneWhen: stage.doneWhen,
      memoryUpdates: stage.memoryUpdates,
      startedAt: stage.startedAt,
      completedAt: stage.completedAt,
      blockedAt: stage.blockedAt,
      evidence: stage.evidence,
      reason: stage.reason
    }))
  };
}

export function buildUiGraphSummary(claims: UiClaimSummary[], relations: UiRelation[]): UiGraphSummary {
  const claimsBySystem = new Map<string, UiClaimSummary[]>();

  for (const claim of claims) {
    const systemClaims = claimsBySystem.get(claim.system) ?? [];
    systemClaims.push(claim);
    claimsBySystem.set(claim.system, systemClaims);
  }

  return {
    systems: [...claimsBySystem]
      .map(([system, systemClaims]) => ({
        id: system,
        system,
        color: deterministicSystemColor(system),
        claimCount: systemClaims.length,
        statusCounts: countBy(systemClaims, (claim) => claim.status),
        severityCounts: countBy(systemClaims, (claim) => claim.severity),
        reviewCount: systemClaims.filter((claim) => claim.reviewPriority > 0).length,
        searchText: systemSearchText(systemClaims)
      }))
      .sort((left, right) => left.system.localeCompare(right.system)),
    systemRelations: buildSystemRelations(claims, relations)
  };
}

export function deterministicSystemColor(system: string): string {
  const palette = [
    "#0f766e",
    "#2563eb",
    "#7c3aed",
    "#be123c",
    "#b45309",
    "#15803d",
    "#9333ea",
    "#0369a1",
    "#c2410c",
    "#4f46e5"
  ];
  let hash = 0;

  for (const character of system) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return palette[hash % palette.length];
}

function buildSystemRelations(claims: UiClaimSummary[], relations: UiRelation[]): UiSystemRelation[] {
  const claimSystems = new Map(claims.map((claim) => [claim.id, claim.system]));
  const aggregates = new Map<string, UiSystemRelation>();
  const seenRelationIds = new Map<string, Set<string>>();

  for (const relation of relations) {
    const sourceSystem = claimSystems.get(relation.source);
    const targetSystem = claimSystems.get(relation.target);

    if (!sourceSystem || !targetSystem || sourceSystem === targetSystem) {
      continue;
    }

    const key = relation.bidirectional
      ? [
          relation.origin,
          relation.relation,
          ...[sourceSystem, targetSystem].sort()
        ].join(":")
      : [relation.origin, relation.relation, sourceSystem, targetSystem].join(":");
    const existing = aggregates.get(key);
    const relationInstanceKey = relation.bidirectional
      ? [
          relation.origin,
          relation.relation,
          ...[relation.source, relation.target].sort()
        ].join(":")
      : relation.id;
    const seenForAggregate = seenRelationIds.get(key) ?? new Set<string>();
    const firstSeenForAggregate = !seenForAggregate.has(relationInstanceKey);
    seenForAggregate.add(relationInstanceKey);
    seenRelationIds.set(key, seenForAggregate);

    if (existing) {
      if (firstSeenForAggregate) {
        existing.count += 1;
      }

      existing.strength = Math.max(existing.strength, relation.strength);
      existing.bidirectional = existing.bidirectional || relation.bidirectional;
      continue;
    }

    const [aggregateSource, aggregateTarget] = relation.bidirectional ? [sourceSystem, targetSystem].sort() : [sourceSystem, targetSystem];

    aggregates.set(key, {
      id: `system:${key}`,
      source: aggregateSource,
      target: aggregateTarget,
      relation: relation.relation,
      origin: relation.origin,
      count: 1,
      strength: relation.strength,
      bidirectional: relation.bidirectional
    });
  }

  return [...aggregates.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target) ||
      left.relation.localeCompare(right.relation) ||
      left.origin.localeCompare(right.origin)
  );
}

function systemSearchText(claims: UiClaimSummary[]): string {
  return claims
    .flatMap((claim) => [
      claim.id,
      claim.title,
      claim.claim,
      claim.system,
      claim.status,
      claim.severity,
      ...claim.tags,
      claim.sourcePath
    ])
    .join(" ")
    .toLowerCase();
}

function countBy<T>(items: T[], keyForItem: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of items) {
    const key = keyForItem(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildUiRelations(memory: LoadedMemory): UiRelation[] {
  const relations = [
    ...buildExplicitRelations(memory),
    ...buildInferredRelations(memory.claims),
    ...buildRecipeRelations(memory),
    ...buildReplacementRelations(memory.claims)
  ];
  const seen = new Set<string>();

  return relations.filter((relation) => {
    if (seen.has(relation.id)) {
      return false;
    }

    seen.add(relation.id);
    return true;
  });
}

function buildExplicitRelations(memory: LoadedMemory): UiRelation[] {
  const relations: UiRelation[] = [];

  for (const graph of memory.graphs) {
    for (const edge of graph.edges) {
      const pairs = edge.claims && edge.claims.length > 1 ? pairwise(edge.claims, edge.bidirectional) : sourceTargetPairs(edge);

      for (const [source, target, bidirectional] of pairs) {
        relations.push(toRelation(source, target, edge, "explicit", graph.sourcePath, bidirectional));
      }
    }
  }

  return relations;
}

function sourceTargetPairs(edge: MemoryGraphEdge): Array<[string, string, boolean]> {
  if (!edge.source || !edge.target) {
    return [];
  }

  const pairs: Array<[string, string, boolean]> = [[edge.source, edge.target, edge.bidirectional]];

  if (edge.bidirectional) {
    pairs.push([edge.target, edge.source, true]);
  }

  return pairs;
}

function pairwise(claimIds: string[], bidirectional: boolean): Array<[string, string, boolean]> {
  const pairs: Array<[string, string, boolean]> = [];

  for (let left = 0; left < claimIds.length; left += 1) {
    for (let right = left + 1; right < claimIds.length; right += 1) {
      pairs.push([claimIds[left], claimIds[right], bidirectional]);

      if (bidirectional) {
        pairs.push([claimIds[right], claimIds[left], true]);
      }
    }
  }

  return pairs;
}

function buildInferredRelations(claims: MemoryClaim[]): UiRelation[] {
  const relations: UiRelation[] = [];

  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const shared = sharedAttributes(claims[left], claims[right]);

      if (shared.length === 0) {
        continue;
      }

      relations.push({
        id: relationId(claims[left].id, claims[right].id, "same_area", "inferred"),
        source: claims[left].id,
        target: claims[right].id,
        relation: "same_area",
        reason: `Claims share ${shared.join(", ")}.`,
        strength: Math.min(60, 20 + shared.length * 10),
        origin: "inferred",
        bidirectional: false
      });
    }
  }

  return relations;
}

function buildRecipeRelations(memory: LoadedMemory): UiRelation[] {
  const relations: UiRelation[] = [];

  for (const recipe of memory.recipes) {
    const [source, ...targets] = recipe.requiredClaims;

    for (const target of targets) {
      relations.push({
        id: relationId(source, target, "required_by_recipe", "recipe"),
        source,
        target,
        relation: "required_by_recipe",
        reason: `Both claims are required by ${recipe.id}.`,
        strength: 70,
        origin: "recipe",
        sourcePath: recipe.sourcePath,
        bidirectional: false
      });
    }
  }

  return relations;
}

function buildReplacementRelations(claims: MemoryClaim[]): UiRelation[] {
  const claimIds = new Set(claims.map((claim) => claim.id));
  const relations: UiRelation[] = [];

  for (const claim of claims) {
    const replacement = typeof claim.raw.deprecated_by === "string" ? claim.raw.deprecated_by : null;

    if (replacement && claimIds.has(replacement)) {
      relations.push({
        id: relationId(replacement, claim.id, "replaces", "replacement"),
        source: replacement,
        target: claim.id,
        relation: "replaces",
        reason: `${replacement} replaces deprecated claim ${claim.id}.`,
        strength: 100,
        origin: "replacement",
        sourcePath: claim.sourcePath,
        bidirectional: false
      });
    }
  }

  return relations;
}

function toRelation(
  source: string,
  target: string,
  edge: MemoryGraphEdge,
  origin: UiRelationOrigin,
  sourcePath: string,
  bidirectional: boolean
): UiRelation {
  return {
    id: relationId(source, target, edge.relation, origin),
    source,
    target,
    relation: edge.relation,
    reason: edge.reason,
    strength: edge.strength,
    origin,
    sourcePath,
    bidirectional
  };
}

function relationId(source: string, target: string, relation: string, origin: UiRelationOrigin): string {
  return `${origin}:${source}:${relation}:${target}`;
}

function sharedAttributes(left: MemoryClaim, right: MemoryClaim): string[] {
  const shared: string[] = [];

  if (intersects([...left.sourceFiles, ...left.relatedFiles], [...right.sourceFiles, ...right.relatedFiles])) {
    shared.push("files");
  }

  if (intersects(left.symbols, right.symbols)) {
    shared.push("symbols");
  }

  if (intersects(left.routes, right.routes)) {
    shared.push("routes");
  }

  if (intersects(left.tags, right.tags)) {
    shared.push("tags");
  }

  return shared;
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function buildFileTree(
  repoRoot: string,
  memoryRoot: string,
  config: {
    claims: string[];
    graphs: string[];
    indexes: string[];
    recipes: string[];
    plans?: string[];
    profiles?: string[];
    waivers: string[];
  },
  claims: Array<Pick<UiClaimSummary, "id" | "sourcePath">>
): UiFileNode {
  const root: UiFileNode = { name: path.basename(memoryRoot), path: "", kind: "directory", children: [] };
  const claimByPath = new Map(claims.map((claim) => [claim.sourcePath, claim]));

  for (const absolutePath of discoverCanonicalMemoryFiles(memoryRoot, config)) {
    const relativePath = toPosix(path.relative(memoryRoot, absolutePath));
    const parts = relativePath.split("/");
    let current = root;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const nodePath = parts.slice(0, index + 1).join("/");
      const leaf = index === parts.length - 1;
      current.children ??= [];
      let next = current.children.find((child) => child.name === part);

      if (!next) {
        next = {
          name: part,
          path: nodePath,
          kind: leaf ? fileKind(relativePath, config, Boolean(claimByPath.get(relativePath))) : "directory",
          claimId: leaf ? claimByPath.get(relativePath)?.id : undefined,
          children: leaf ? undefined : []
        };
        current.children.push(next);
      }

      current = next;
    }
  }

  sortFileTree(root);
  root.path = toPosix(path.relative(repoRoot, memoryRoot));
  return root;
}

function fileKind(
  relativePath: string,
  config: {
    claims: string[];
    graphs: string[];
    indexes: string[];
    recipes: string[];
    plans?: string[];
    profiles?: string[];
    waivers: string[];
  },
  claim: boolean
): UiFileNode["kind"] {
  if (claim) {
    return "claim";
  }

  if (relativePath.startsWith("graph/")) {
    return "graph";
  }

  if (relativePath.startsWith("indexes/")) {
    return "index";
  }

  if (relativePath.startsWith("recipes/")) {
    return "recipe";
  }

  if (relativePath.startsWith("plans/")) {
    return "plan";
  }

  if (relativePath.startsWith("profiles/")) {
    return "profile";
  }

  if (relativePath.startsWith("waivers/")) {
    return "waiver";
  }

  return config.graphs.some((pattern) => relativePath.includes(pattern.replace("**/*", ""))) ? "graph" : "file";
}

function sortFileTree(node: UiFileNode): void {
  node.children?.sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") {
      return -1;
    }

    if (left.kind !== "directory" && right.kind === "directory") {
      return 1;
    }

    return left.name.localeCompare(right.name);
  });

  for (const child of node.children ?? []) {
    sortFileTree(child);
  }
}

type YamlPatchOperation =
  | { type: "scalar"; key: string; value: string }
  | { type: "array"; key: string; values: string[] }
  | { type: "planStages"; stages: Array<{ id: string; title?: string; goal?: string }> };

function recipePatchOperations(patch: Record<string, unknown>): YamlPatchOperation[] {
  return allowedWorkflowOperations(patch, {
    scalars: ["title", "status"],
    arrays: ["intent_triggers"]
  });
}

function planPatchOperations(patch: Record<string, unknown>): YamlPatchOperation[] {
  const operations = allowedWorkflowOperations(patch, {
    scalars: ["title", "status"],
    arrays: ["intent_triggers"]
  });
  const stages = readPatchStages(patch);

  if (stages.length > 0) {
    operations.push({ type: "planStages", stages });
  }

  return operations;
}

function profilePatchOperations(patch: Record<string, unknown>): YamlPatchOperation[] {
  return allowedWorkflowOperations(patch, {
    scalars: ["title", "status", "priority", "snippet"],
    arrays: ["conflicts_with"]
  });
}

function allowedWorkflowOperations(
  patch: Record<string, unknown>,
  options: { scalars: string[]; arrays: string[] }
): YamlPatchOperation[] {
  const operations: YamlPatchOperation[] = [];

  for (const key of options.scalars) {
    if (patch[key] !== undefined) {
      operations.push({ type: "scalar", key, value: readPatchString(patch[key], key) });
    }
  }

  for (const key of options.arrays) {
    if (patch[key] !== undefined) {
      operations.push({ type: "array", key, values: readPatchStringArray(patch[key], key) });
    }
  }

  return operations;
}

function readPatchStages(patch: Record<string, unknown>): Array<{ id: string; title?: string; goal?: string }> {
  const value = patch.stages;

  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AgentMemoryError("Workflow patch field stages must be an array.", { code: "BAD_REQUEST" });
  }

  return value.map((item) => {
    const record = readRecord(item);
    const id = readPatchString(record.id, "stages.id");
    const stage: { id: string; title?: string; goal?: string } = { id };

    if (record.title !== undefined) {
      stage.title = readPatchString(record.title, "stages.title");
    }

    if (record.goal !== undefined) {
      stage.goal = readPatchString(record.goal, "stages.goal");
    }

    return stage;
  });
}

function readPatchString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AgentMemoryError(`Workflow patch field ${field} must be a string.`, { code: "BAD_REQUEST" });
  }

  return value.trim();
}

function readPatchStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AgentMemoryError(`Workflow patch field ${field} must be a string array.`, { code: "BAD_REQUEST" });
  }

  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function updateYamlFile(filePath: string, operations: YamlPatchOperation[]): void {
  if (operations.length === 0) {
    throw new AgentMemoryError("Workflow patch did not include editable fields.", { code: "BAD_REQUEST" });
  }

  let content = fs.readFileSync(filePath, "utf8");

  for (const operation of operations) {
    if (operation.type === "scalar") {
      content = replaceTopLevelScalar(content, operation.key, operation.value);
    } else if (operation.type === "array") {
      content = replaceTopLevelArray(content, operation.key, operation.values);
    } else {
      content = replacePlanStages(content, operation.stages);
    }
  }

  fs.writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`);
}

function replaceTopLevelScalar(content: string, key: string, value: string): string {
  const lines = content.split("\n");
  const rendered = `${key}: ${renderYamlScalar(value)}`;
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));

  if (index >= 0) {
    lines[index] = rendered;
    return lines.join("\n");
  }

  lines.push(rendered);
  return lines.join("\n");
}

function replaceTopLevelArray(content: string, key: string, values: string[]): string {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  const rendered = renderYamlArrayField(key, values, 0);

  if (index < 0) {
    lines.push(rendered);
    return lines.join("\n");
  }

  const end = nextTopLevelIndex(lines, index + 1);
  lines.splice(index, end - index, rendered);
  return lines.join("\n");
}

function replacePlanStages(content: string, stages: Array<{ id: string; title?: string; goal?: string }>): string {
  const lines = content.split("\n");
  const stagePatches = new Map(stages.map((stage) => [stage.id, stage]));

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^  - id: (.+)$/.exec(lines[index]);

    if (!match) {
      continue;
    }

    const stageId = unquoteYamlScalar(match[1].trim());
    const patch = stagePatches.get(stageId);

    if (!patch) {
      continue;
    }

    const end = nextStageIndex(lines, index + 1);
    replaceIndentedScalar(lines, index + 1, end, "title", patch.title, 4);
    replaceIndentedScalar(lines, index + 1, end, "goal", patch.goal, 4);
  }

  return lines.join("\n");
}

function replaceIndentedScalar(lines: string[], start: number, end: number, key: string, value: string | undefined, indent: number): void {
  if (value === undefined) {
    return;
  }

  const prefix = `${" ".repeat(indent)}${key}:`;
  const index = lines.slice(start, end).findIndex((line) => line.startsWith(prefix));
  const rendered = `${" ".repeat(indent)}${key}: ${renderYamlScalar(value)}`;

  if (index >= 0) {
    lines[start + index] = rendered;
  }
}

function nextTopLevelIndex(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^[A-Za-z0-9_./-]+:/.test(lines[index])) {
      return index;
    }
  }

  return lines.length;
}

function nextStageIndex(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^  - id: /.test(lines[index])) {
      return index;
    }
  }

  return lines.length;
}

function renderYamlArrayField(key: string, values: string[], indent: number): string {
  const prefix = " ".repeat(indent);

  if (values.length === 0) {
    return `${prefix}${key}: []`;
  }

  return `${prefix}${key}:\n${values.map((value) => `${prefix}  - ${renderYamlScalar(value)}`).join("\n")}`;
}

function unquoteYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function walkYamlFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkYamlFiles(entryPath));
    } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readRecords(data: Record<string, unknown>, field: string): Array<Record<string, unknown>> {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function readString(data: Record<string, unknown>, field: string): string {
  return typeof data[field] === "string" ? data[field] : "";
}

function readOptionalString(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(data: Record<string, unknown>, field: string): string[] {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function buildReviewQueue(claims: UiClaimSummary[]): UiReviewItem[] {
  return claims
    .filter((claim) => claim.reviewPriority > 0)
    .map((claim) => ({
      claimId: claim.id,
      title: claim.title,
      system: claim.system,
      status: claim.status,
      confidence: claim.confidence,
      severity: claim.severity,
      sourcePath: claim.sourcePath,
      priority: claim.reviewPriority,
      reason: claim.reviewReason ?? "Review recommended"
    }))
    .sort((left, right) => right.priority - left.priority || left.system.localeCompare(right.system) || left.title.localeCompare(right.title));
}

function reviewPriorityForClaim(claim: MemoryClaim): { priority: number; reason?: string } {
  if (claim.status === "needs_review") {
    return { priority: 100, reason: "Needs review" };
  }

  if (claim.status === "needs_verification") {
    return { priority: 90, reason: "Needs verification" };
  }

  if (claim.status === "proposed") {
    return { priority: 80, reason: "Proposed claim" };
  }

  if (claim.tags.includes("migration") || claim.id.includes(".migrated_")) {
    return { priority: 70, reason: "Migrated draft" };
  }

  if (claim.status === "stale") {
    return { priority: 60, reason: "Stale claim" };
  }

  if (claim.status === "deprecated") {
    return { priority: 50, reason: "Deprecated claim" };
  }

  return { priority: 0 };
}

function parseClaimStatus(value: string): ClaimStatus {
  if ((CLAIM_STATUSES as readonly string[]).includes(value)) {
    return value as ClaimStatus;
  }

  throw new AgentMemoryError(`Invalid claim status: ${value}`, {
    code: "BAD_REQUEST",
    details: [`Expected one of: ${CLAIM_STATUSES.join(", ")}`]
  });
}

function parseClaimConfidence(value: string): ClaimConfidence {
  if ((CLAIM_CONFIDENCE_VALUES as readonly string[]).includes(value)) {
    return value as ClaimConfidence;
  }

  throw new AgentMemoryError(`Invalid claim confidence: ${value}`, {
    code: "BAD_REQUEST",
    details: [`Expected one of: ${CLAIM_CONFIDENCE_VALUES.join(", ")}`]
  });
}

function updateClaimFrontmatter(filePath: string, updates: Record<string, string | undefined>): void {
  const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");

  if (!raw.startsWith("---\n")) {
    throw new AgentMemoryError(`Claim file must start with YAML frontmatter: ${filePath}`);
  }

  const closing = raw.indexOf("\n---", 4);

  if (closing === -1) {
    throw new AgentMemoryError(`Claim file is missing closing frontmatter marker: ${filePath}`);
  }

  let frontmatter = raw.slice(4, closing);
  const body = raw.slice(closing);

  for (const [field, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }

    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}:\\s*.*$`, "m");
    const replacement = `${field}: ${value}`;

    if (pattern.test(frontmatter)) {
      frontmatter = frontmatter.replace(pattern, replacement);
    } else {
      frontmatter = `${frontmatter.trimEnd()}\n${replacement}\n`;
    }
  }

  fs.writeFileSync(filePath, `---\n${frontmatter.trim()}\n${body}`);
}
