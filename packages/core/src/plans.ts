import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, renderYamlScalar } from "./config";
import { AgentMemoryError, NotFoundError } from "./errors";
import { resolveConfiguredPath } from "./files";
import { commandPrefixForRepo } from "./skills";
import { parseYaml } from "./yaml";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

export interface PlanTemplateStageDetail {
  id: string;
  title: string;
  goal: string;
  claimRefs: string[];
  recipeRefs: string[];
  profileTraits: string[];
  sourceFiles: string[];
  verification: string[];
  doneWhen: string[];
  memoryUpdates: string[];
}

export interface PlanTemplateDetail {
  id: string;
  title: string;
  system: string;
  status: string;
  sourcePath: string;
  intentTriggers: string[];
  recipes: string[];
  stages: PlanTemplateStageDetail[];
  metadata: Record<string, unknown>;
}

export interface PlanTemplateMatch {
  template: PlanTemplateDetail;
  score: number;
  reasons: Array<{ code: string; detail: string }>;
}

export interface PlanSuggestResult {
  databasePath: string;
  task: string;
  matches: PlanTemplateMatch[];
  adHocPlan?: {
    title: string;
    stages: PlanTemplateStageDetail[];
    warning: string;
  };
}

export type PlanRunStatus = "active" | "complete" | "blocked" | "abandoned";
export type PlanRunStageStatus = "pending" | "active" | "blocked" | "complete" | "skipped" | "abandoned";

export interface PlanRunStageDetail {
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

export interface PlanRunDetail {
  id: string;
  templateId?: string;
  templateSnapshotHash?: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  status: PlanRunStatus;
  currentStage: string;
  branch?: string;
  baseCommit?: string;
  stages: PlanRunStageDetail[];
  path?: string;
}

export interface PlanRunResult {
  run: PlanRunDetail;
  path: string;
  warnings: string[];
}

export interface PlanNextResult extends PlanRunResult {
  stage: PlanRunStageDetail;
  contextCommand: string;
}

export interface PlanFinishResult {
  status: "deleted" | "archived";
  path: string;
  archivePath?: string;
  prompts: string[];
  durableArtifacts: string[];
}

export interface PlanPruneResult {
  dryRun: boolean;
  paths: string[];
}

export interface PlanPromoteResult {
  path: string;
  templateId: string;
  warnings: string[];
}

export async function listPlanTemplates(options: { cwd?: string } = {}): Promise<{ databasePath: string; templates: PlanTemplateDetail[] }> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    return {
      databasePath,
      templates: database
        .all<{ id: string }>("SELECT id FROM plan_templates WHERE status IN ('current', 'proposed', 'needs_review') ORDER BY id")
        .map((row) => hydratePlanTemplate(database, row.id))
        .filter((template): template is PlanTemplateDetail => template !== null)
    };
  } finally {
    database.close();
  }
}

export async function showPlanTemplate(options: { cwd?: string; id: string }): Promise<{ databasePath: string; template: PlanTemplateDetail }> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    const template = hydratePlanTemplate(database, options.id);

    if (!template) {
      throw new NotFoundError(`Plan template not found: ${options.id}`);
    }

    return { databasePath, template };
  } finally {
    database.close();
  }
}

export async function suggestPlans(options: { cwd?: string; task: string; limit?: number }): Promise<PlanSuggestResult> {
  const { database, databasePath, planTemplateSuggestionLimit } = await openConfiguredDatabase(options.cwd);

  try {
    const matches = searchPlanTemplates(database, options.task, options.limit ?? planTemplateSuggestionLimit);
    return {
      databasePath,
      task: options.task,
      matches,
      adHocPlan:
        matches.length === 0
          ? {
              title: `Ad hoc plan for ${options.task}`,
              stages: [minimalStage("inspect_task", "Inspect task", "Inspect the task, code, and available memory before editing.")],
              warning: "No plan template matched; use plans new to create a minimal local plan."
            }
          : undefined
    };
  } finally {
    database.close();
  }
}

export async function createPlanRun(options: { cwd?: string; task: string; templateId?: string }): Promise<PlanRunResult> {
  const loaded = loadConfig({ cwd: options.cwd });
  let template: PlanTemplateDetail | null = null;
  const warnings: string[] = [];

  if (options.templateId) {
    template = (await showPlanTemplate({ cwd: options.cwd, id: options.templateId })).template;
  } else {
    const suggestion = await suggestPlans({ cwd: options.cwd, task: options.task, limit: 1 });
    template = suggestion.matches[0]?.template ?? null;
    if (!template) {
      warnings.push("No template matched; created a minimal task-derived plan.");
    }
  }

  const now = new Date().toISOString();
  const stages = template?.stages.length ? template.stages : [minimalStage("inspect_task", "Inspect task", "Inspect the task, code, and available memory before editing.")];
  const slug = slugify(template?.title ?? options.task);
  const id = collisionSafePlanRunId(loaded.repo.root, options.task, template?.id, now, slug);
  const run: PlanRunDetail = {
    id,
    templateId: template?.id,
    templateSnapshotHash: template ? templateHash(template) : undefined,
    task: options.task,
    createdAt: now,
    updatedAt: now,
    status: "active",
    currentStage: stages[0].id,
    branch: currentGitValue(loaded.repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    baseCommit: currentGitValue(loaded.repo.root, ["rev-parse", "HEAD"]),
    stages: stages.map((stage, index) => ({
      ...stage,
      status: index === 0 ? "active" : "pending",
      startedAt: index === 0 ? now : undefined,
      evidence: []
    }))
  };
  const plansRoot = planRunsRoot(loaded.repo.root);
  const filePath = collisionSafePlanRunPath(plansRoot, run.id);
  writePlanRunAtomic(loaded.repo.root, filePath, run);
  return { run, path: filePath, warnings };
}

export function showPlanRun(options: { cwd?: string; id: string }): PlanRunResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const { run, path: runPath } = loadPlanRun(loaded.repo.root, options.id);
  return { run, path: runPath, warnings: planRunWarnings(loaded.repo.root, run) };
}

export function nextPlanStage(options: { cwd?: string; id: string }): PlanNextResult {
  const result = showPlanRun(options);
  const stage = currentOrNextStage(result.run);
  const loaded = loadConfig({ cwd: options.cwd });
  const contextCommand = `${commandPrefixForRepo(loaded.repo.root)} context --plan ${result.run.id} --stage ${stage.id}`;
  return { ...result, stage, contextCommand };
}

export function completePlanStage(options: { cwd?: string; id: string; stageId: string; evidence: string; allowEmptyEvidence?: boolean }): PlanRunResult {
  if (!options.allowEmptyEvidence && options.evidence.trim().length === 0) {
    throw new AgentMemoryError("complete-stage requires non-empty --evidence.");
  }

  return updatePlanRun(options.cwd, options.id, (run) => {
    const stage = findRunStage(run, options.stageId);
    ensureTransition(stage.status, "complete");
    const now = new Date().toISOString();
    stage.status = "complete";
    stage.completedAt = now;
    if (options.evidence.trim()) {
      stage.evidence.push(options.evidence.trim());
    }
    advanceCurrentStage(run, now);
  });
}

export function blockPlanStage(options: { cwd?: string; id: string; stageId: string; reason: string }): PlanRunResult {
  if (options.reason.trim().length === 0) {
    throw new AgentMemoryError("block-stage requires non-empty --reason.");
  }

  return updatePlanRun(options.cwd, options.id, (run) => {
    const stage = findRunStage(run, options.stageId);
    ensureTransition(stage.status, "blocked");
    const now = new Date().toISOString();
    stage.status = "blocked";
    stage.blockedAt = now;
    stage.reason = options.reason.trim();
    run.status = "blocked";
  });
}

export function finishPlanRun(options: {
  cwd?: string;
  id: string;
  confirmUnresolved?: boolean;
  archive?: boolean;
  abandonBlocked?: boolean;
  reason?: string;
}): PlanFinishResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const { run, path: runPath } = loadPlanRun(loaded.repo.root, options.id);
  const unresolved = unresolvedMemoryUpdates(run);
  const hasBlockedStages = run.stages.some((stage) => stage.status === "blocked");

  if (run.stages.some((stage) => stage.status === "active" || stage.status === "pending") && !(options.abandonBlocked && hasBlockedStages)) {
    throw new AgentMemoryError("Cannot finish plan run while stages are active or pending.");
  }

  if (hasBlockedStages && !options.abandonBlocked) {
    throw new AgentMemoryError("Cannot finish plan run with blocked stages unless --abandon-blocked is passed.");
  }

  if (unresolved.length > 0 && !options.confirmUnresolved) {
    throw new AgentMemoryError("Plan run has unresolved memory update prompts.", {
      details: unresolved
    });
  }

  if (options.archive) {
    const archiveDir = path.join(planRunsRoot(loaded.repo.root), "completed");
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, path.basename(runPath));
    const now = new Date().toISOString();
    if (options.abandonBlocked) {
      abandonIncompleteStages(run, now, options.reason);
    }
    run.status = options.abandonBlocked ? "abandoned" : "complete";
    run.updatedAt = now;
    writePlanRunAtomic(loaded.repo.root, runPath, run);
    fs.renameSync(runPath, archivePath);
    return { status: "archived", path: archivePath, archivePath, prompts: unresolved, durableArtifacts: durableArtifacts() };
  }

  fs.unlinkSync(runPath);
  return { status: "deleted", path: runPath, prompts: unresolved, durableArtifacts: durableArtifacts() };
}

export function prunePlanRuns(options: {
  cwd?: string;
  completed?: boolean;
  abandoned?: boolean;
  dryRun?: boolean;
  olderThanDays?: number;
  includeBlocked?: boolean;
}): PlanPruneResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const root = planRunsRoot(loaded.repo.root);
  const paths = fs.existsSync(root) ? walkPlanRunFiles(root) : [];
  const selected: string[] = [];
  const cutoff = options.olderThanDays ? Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000 : null;

  for (const filePath of paths) {
    const run = parsePlanRunFile(filePath);
    const statusMatches =
      (options.completed && run.status === "complete") ||
      (options.abandoned && run.status === "abandoned") ||
      (options.includeBlocked && run.status === "blocked");

    if (!statusMatches) {
      continue;
    }

    if (cutoff && new Date(run.updatedAt || run.createdAt).getTime() > cutoff) {
      continue;
    }

    selected.push(filePath);
  }

  if (!options.dryRun) {
    for (const filePath of selected) {
      fs.unlinkSync(filePath);
    }
  }

  return { dryRun: options.dryRun ?? false, paths: selected };
}

export function promotePlanRun(options: {
  cwd?: string;
  id: string;
  title?: string;
  system?: string;
  finishAfterPromote?: boolean;
}): PlanPromoteResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const { run } = loadPlanRun(loaded.repo.root, options.id);

  if (run.status !== "complete" && run.status !== "abandoned") {
    throw new AgentMemoryError("Only complete or abandoned plan runs can be promoted.");
  }

  const system = options.system ?? inferSystem(run);
  const title = options.title ?? titleFromTask(run.task);
  const templateId = `plan_template.${system}.${slugify(title).replace(/-/g, "_")}`;
  const memoryRoot = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  const target = collisionSafeTemplatePath(memoryRoot, system, templateId);
  const yaml = renderPlanTemplateYaml(templateId, title, system, run.stages);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, yaml);

  if (options.finishAfterPromote) {
    fs.unlinkSync(loadPlanRun(loaded.repo.root, options.id).path);
  }

  return {
    path: target,
    templateId,
    warnings: ["Review the generated template, generalize task-specific wording, then run validation before committing."]
  };
}

export async function resolvePlanStageContext(options: { cwd?: string; planId: string; stageId?: string }): Promise<{
  planId: string;
  stage: PlanRunStageDetail;
  warnings: string[];
}> {
  const loaded = loadConfig({ cwd: options.cwd });

  try {
    const { run } = loadPlanRun(loaded.repo.root, options.planId);
    const stageId = options.stageId ?? run.currentStage;
    return {
      planId: run.id,
      stage: findRunStage(run, stageId),
      warnings: planRunWarnings(loaded.repo.root, run)
    };
  } catch (error) {
    if (!(error instanceof NotFoundError) || !error.message.startsWith("Plan run not found:")) {
      throw error;
    }
  }

  const template = (await showPlanTemplate({ cwd: options.cwd, id: options.planId })).template;
  const stage = template.stages.find((candidate) => candidate.id === (options.stageId ?? template.stages[0]?.id));

  if (!stage) {
    throw new NotFoundError(`Plan stage not found: ${options.stageId ?? "(first stage)"}`);
  }

  return {
    planId: template.id,
    stage: { ...stage, status: "active", evidence: [] },
    warnings: []
  };
}

function searchPlanTemplates(database: SqliteDatabase, task: string, limit: number): PlanTemplateMatch[] {
  const query = toFtsQuery(task);
  if (query === '""') {
    return [];
  }

  return database
    .all<{ id: string; rank_score: number }>(
      `SELECT id, bm25(plan_templates_fts) AS rank_score
       FROM plan_templates_fts
       WHERE plan_templates_fts MATCH ?
       ORDER BY rank_score ASC
       LIMIT ?`,
      [query, limit]
    )
    .map((row) => hydratePlanTemplate(database, row.id))
    .filter((template): template is PlanTemplateDetail => template !== null)
    .map((template) => ({
      template,
      score: 10,
      reasons: [{ code: "template_fts", detail: task }]
    }));
}

async function openConfiguredDatabase(cwd?: string): Promise<{ database: SqliteDatabase; databasePath: string; planTemplateSuggestionLimit: number }> {
  const loaded = loadConfig({ cwd });
  const databasePath = path.isAbsolute(loaded.config.database_path)
    ? loaded.config.database_path
    : path.join(loaded.repo.root, loaded.config.database_path);

  if (!fs.existsSync(databasePath)) {
    throw new NotFoundError(`Compiled memory database not found at ${databasePath}`, {
      details: ["Run `agent-memory compile` first."]
    });
  }

  return {
    database: await openSqliteDatabase(databasePath, { readonly: true }),
    databasePath,
    planTemplateSuggestionLimit: loaded.config.context.plan_template_suggestion_limit
  };
}

function hydratePlanTemplate(database: SqliteDatabase, id: string): PlanTemplateDetail | null {
  const row = database.get<PlanTemplateRow>("SELECT * FROM plan_templates WHERE id = ?", [id]);

  if (!row) {
    return null;
  }

  const metadata = parseJson(row.metadata_json);
  const stages = database
    .all<PlanStageRow>("SELECT * FROM plan_stages WHERE plan_id = ? ORDER BY sequence", [id])
    .map((stage) => stageFromMetadata(stage.stage_id, stage.title, stage.goal, parseJson(stage.metadata_json)));

  return {
    id: row.id,
    title: row.title,
    system: row.system,
    status: row.status,
    sourcePath: row.source_path,
    intentTriggers: readStringArray(metadata, "intent_triggers"),
    recipes: readStringArray(metadata, "recipes"),
    stages,
    metadata
  };
}

function stageFromMetadata(id: string, title: string, goal: string, metadata: Record<string, unknown>): PlanTemplateStageDetail {
  return {
    id,
    title,
    goal,
    claimRefs: readStringArray(metadata, "claim_refs"),
    recipeRefs: readStringArray(metadata, "recipe_refs"),
    profileTraits: readStringArray(metadata, "profile_traits"),
    sourceFiles: readStringArray(metadata, "source_files"),
    verification: readStringArray(metadata, "verification"),
    doneWhen: readStringArray(metadata, "done_when"),
    memoryUpdates: readStringArray(metadata, "memory_updates")
  };
}

function minimalStage(id: string, title: string, goal: string): PlanTemplateStageDetail {
  return {
    id,
    title,
    goal,
    claimRefs: [],
    recipeRefs: [],
    profileTraits: [],
    sourceFiles: [],
    verification: [],
    doneWhen: ["Task has been inspected and next action is clear."],
    memoryUpdates: []
  };
}

function planRunsRoot(repoRoot: string): string {
  return path.join(repoRoot, ".agent-memory/plans");
}

function loadPlanRun(repoRoot: string, id: string): { run: PlanRunDetail; path: string } {
  const root = planRunsRoot(repoRoot);
  const files = fs.existsSync(root) ? walkPlanRunFiles(root) : [];
  const stemMatch = files.find((candidate) => planRunFileStem(candidate) === id);
  if (stemMatch) {
    const run = parsePlanRunFile(stemMatch);
    run.path = stemMatch;
    return { run, path: stemMatch };
  }

  for (const filePath of files) {
    try {
      const run = parsePlanRunFile(filePath);
      if (run.id === id) {
        run.path = filePath;
        return { run, path: filePath };
      }
    } catch {
      continue;
    }
  }

  throw new NotFoundError(`Plan run not found: ${id}`);
}

function parsePlanRunFile(filePath: string): PlanRunDetail {
  const data = asRecord(parseYaml(fs.readFileSync(filePath, "utf8")));
  return {
    id: readString(data, "id"),
    templateId: readOptionalString(data, "template_id"),
    templateSnapshotHash: readOptionalString(data, "template_snapshot_hash"),
    task: readString(data, "task"),
    createdAt: readString(data, "created_at"),
    updatedAt: readString(data, "updated_at"),
    status: readString(data, "status") as PlanRunStatus,
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

function writePlanRunAtomic(repoRoot: string, filePath: string, run: PlanRunDetail): void {
  const lockPath = path.join(repoRoot, ".agent-memory/locks/plans.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let lockHandle: number | null = null;

  try {
    lockHandle = fs.openSync(lockPath, "wx");
  } catch {
    throw new AgentMemoryError(`Plan lock already exists at ${lockPath}.`, {
      details: ["If it is stale, remove it manually after confirming no plan command is running."]
    });
  }

  let tempPath: string | null = null;

  try {
    tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, renderPlanRunYaml(run));
    fs.renameSync(tempPath, filePath);
    tempPath = null;
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    if (lockHandle !== null) {
      fs.closeSync(lockHandle);
      fs.unlinkSync(lockPath);
    }
  }
}

function updatePlanRun(cwd: string | undefined, id: string, update: (run: PlanRunDetail) => void): PlanRunResult {
  const loaded = loadConfig({ cwd });
  const { run, path: runPath } = loadPlanRun(loaded.repo.root, id);
  update(run);
  run.updatedAt = new Date().toISOString();
  writePlanRunAtomic(loaded.repo.root, runPath, run);
  return { run, path: runPath, warnings: planRunWarnings(loaded.repo.root, run) };
}

function renderPlanRunYaml(run: PlanRunDetail): string {
  const lines = [
    `id: ${renderYamlScalar(run.id)}`,
    run.templateId ? `template_id: ${renderYamlScalar(run.templateId)}` : null,
    run.templateSnapshotHash ? `template_snapshot_hash: ${renderYamlScalar(run.templateSnapshotHash)}` : null,
    `task: ${renderYamlScalar(run.task)}`,
    `created_at: ${renderYamlScalar(run.createdAt)}`,
    `updated_at: ${renderYamlScalar(run.updatedAt)}`,
    `status: ${renderYamlScalar(run.status)}`,
    `current_stage: ${renderYamlScalar(run.currentStage)}`,
    run.branch ? `branch: ${renderYamlScalar(run.branch)}` : null,
    run.baseCommit ? `base_commit: ${renderYamlScalar(run.baseCommit)}` : null,
    "stages:",
    ...run.stages.flatMap(renderPlanRunStageYaml)
  ].filter((line): line is string => line !== null);
  return `${lines.join("\n")}\n`;
}

function renderPlanRunStageYaml(stage: PlanRunStageDetail): string[] {
  return [
    `  - id: ${renderYamlScalar(stage.id)}`,
    `    title: ${renderYamlScalar(stage.title)}`,
    `    goal: ${renderYamlScalar(stage.goal)}`,
    `    status: ${renderYamlScalar(stage.status)}`,
    stage.startedAt ? `    started_at: ${renderYamlScalar(stage.startedAt)}` : null,
    stage.completedAt ? `    completed_at: ${renderYamlScalar(stage.completedAt)}` : null,
    stage.blockedAt ? `    blocked_at: ${renderYamlScalar(stage.blockedAt)}` : null,
    stage.reason ? `    reason: ${renderYamlScalar(stage.reason)}` : null,
    renderYamlArray("claim_refs", stage.claimRefs, 4),
    renderYamlArray("recipe_refs", stage.recipeRefs, 4),
    renderYamlArray("profile_traits", stage.profileTraits, 4),
    renderYamlArray("source_files", stage.sourceFiles, 4),
    renderYamlArray("verification", stage.verification, 4),
    renderYamlArray("done_when", stage.doneWhen, 4),
    renderYamlArray("memory_updates", stage.memoryUpdates, 4),
    renderYamlArray("evidence", stage.evidence, 4)
  ].filter((line): line is string => line !== null);
}

function renderPlanTemplateYaml(id: string, title: string, system: string, stages: PlanRunStageDetail[]): string {
  return `${[
    `id: ${renderYamlScalar(id)}`,
    `title: ${renderYamlScalar(title)}`,
    `system: ${renderYamlScalar(system)}`,
    "status: proposed",
    "stages:",
    ...stages.flatMap((stage) => [
      `  - id: ${renderYamlScalar(stage.id)}`,
      `    title: ${renderYamlScalar(stage.title)}`,
      `    goal: ${renderYamlScalar(stage.goal)}`,
      renderYamlArray("claim_refs", stage.claimRefs, 4),
      renderYamlArray("recipe_refs", stage.recipeRefs, 4),
      renderYamlArray("profile_traits", stage.profileTraits, 4),
      renderYamlArray("source_files", stage.sourceFiles, 4),
      renderYamlArray("verification", stage.verification, 4),
      renderYamlArray("done_when", stage.doneWhen, 4),
      renderYamlArray("memory_updates", stage.memoryUpdates, 4)
    ])
  ]
    .filter(Boolean)
    .join("\n")}\n`;
}

function renderYamlArray(name: string, values: string[], indent: number): string {
  const prefix = " ".repeat(indent);
  if (values.length === 0) {
    return `${prefix}${name}: []`;
  }
  return `${prefix}${name}:\n${values.map((value) => `${prefix}  - ${renderYamlScalar(value)}`).join("\n")}`;
}

function planRunWarnings(repoRoot: string, run: PlanRunDetail): string[] {
  const warnings: string[] = [];
  if (run.branch && currentGitValue(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) !== run.branch) {
    warnings.push(`Plan run was created on branch ${run.branch}.`);
  }
  if (run.baseCommit && currentGitValue(repoRoot, ["rev-parse", "HEAD"]) !== run.baseCommit) {
    warnings.push(`Plan run base commit was ${run.baseCommit}.`);
  }
  return warnings;
}

function currentOrNextStage(run: PlanRunDetail): PlanRunStageDetail {
  return run.stages.find((stage) => stage.id === run.currentStage) ?? run.stages.find((stage) => stage.status === "pending") ?? run.stages[0];
}

function findRunStage(run: PlanRunDetail, stageId: string): PlanRunStageDetail {
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (!stage) {
    throw new NotFoundError(`Plan stage not found: ${stageId}`);
  }
  return stage;
}

function ensureTransition(from: PlanRunStageStatus, to: PlanRunStageStatus): void {
  const allowed = new Set([
    "pending:active",
    "pending:skipped",
    "pending:abandoned",
    "active:complete",
    "active:blocked",
    "active:abandoned",
    "blocked:abandoned",
    "blocked:active",
    "blocked:skipped"
  ]);
  if (!allowed.has(`${from}:${to}`)) {
    throw new AgentMemoryError(`Invalid plan stage transition: ${from} -> ${to}`);
  }
}

function abandonIncompleteStages(run: PlanRunDetail, now: string, reason?: string): void {
  for (const stage of run.stages) {
    if (stage.status !== "active" && stage.status !== "pending" && stage.status !== "blocked") {
      continue;
    }
    stage.status = "abandoned";
    stage.completedAt = now;
    stage.reason = reason?.trim() || stage.reason || "Abandoned blocked plan run.";
  }
}

function advanceCurrentStage(run: PlanRunDetail, now: string): void {
  const next = run.stages.find((stage) => stage.status === "pending");
  if (next) {
    next.status = "active";
    next.startedAt = now;
    run.currentStage = next.id;
    run.status = "active";
    return;
  }
  run.status = "complete";
}

function unresolvedMemoryUpdates(run: PlanRunDetail): string[] {
  return Array.from(new Set(run.stages.flatMap((stage) => stage.memoryUpdates)));
}

function durableArtifacts(): string[] {
  return ["claims", "recipes", "graph edges", "indexes", "profile traits"];
}

function inferSystem(run: PlanRunDetail): string {
  const recipe = run.stages.flatMap((stage) => stage.recipeRefs)[0];
  if (recipe?.startsWith("recipe.")) {
    return recipe.split(".")[1] || "general";
  }
  return "general";
}

function titleFromTask(task: string): string {
  return task.trim().replace(/\s+/g, " ").slice(0, 80) || "Reusable plan";
}

function collisionSafePlanRunId(repoRoot: string, task: string, templateId: string | undefined, timestamp: string, slug: string): string {
  const date = timestamp.slice(0, 10).replace(/-/g, "");
  const hash = crypto.createHash("sha256").update(`${repoRoot}\0${templateId ?? ""}\0${task}\0${timestamp}`).digest("hex").slice(0, 8);
  return `plan_run.${date}.${slug.replace(/-/g, "_")}.${hash}`;
}

function collisionSafePlanRunPath(root: string, id: string): string {
  const base = id.replace(/^plan_run\./, "").replace(/\./g, "-");
  let candidate = path.join(root, `${base}.yaml`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${base}-${suffix}.yaml`);
    suffix += 1;
  }
  return candidate;
}

function collisionSafeTemplatePath(memoryRoot: string, system: string, id: string): string {
  const base = path.join(memoryRoot, "plans", system, `${id.split(".").slice(2).join("_")}.yaml`);
  let candidate = base;
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = base.replace(/\.yaml$/, `-${suffix}.yaml`);
    suffix += 1;
  }
  return candidate;
}

function templateHash(template: PlanTemplateDetail): string {
  return crypto.createHash("sha256").update(JSON.stringify(template)).digest("hex");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.slice(0, 6)
      .join("-") || "plan"
  );
}

function currentGitValue(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function walkPlanRunFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return walkPlanRunFiles(entryPath);
    }
    return entry.isFile() && isYamlFile(entry.name) ? [entryPath] : [];
  });
}

function isYamlFile(fileName: string): boolean {
  return fileName.endsWith(".yaml") || fileName.endsWith(".yml");
}

function planRunFileStem(filePath: string): string {
  return path.basename(filePath).replace(/\.(yaml|yml)$/, "");
}

function toFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.map((term) => `${term.replace(/"/g, "")}*`);
  return terms?.length ? terms.join(" OR ") : '""';
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function readRecords(data: Record<string, unknown>, field: string): Array<Record<string, unknown>> {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

interface PlanTemplateRow {
  id: string;
  title: string;
  system: string;
  status: string;
  source_path: string;
  metadata_json: string;
}

interface PlanStageRow {
  plan_id: string;
  stage_id: string;
  title: string;
  goal: string;
  sequence: number;
  metadata_json: string;
}
