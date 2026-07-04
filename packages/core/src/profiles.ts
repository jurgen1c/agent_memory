import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { NotFoundError } from "./errors";
import { pathMatchesPattern } from "./files";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";

export type ProfileIntent = "review" | "architect" | "implementer" | "release" | "migration";

export interface ProfileTraitDetail {
  id: string;
  title: string;
  status: string;
  category: string;
  priority: string;
  sourcePath: string;
  appliesWhen: Record<string, unknown>;
  snippet: string;
  conflictsWith: string[];
  metadata: Record<string, unknown>;
}

export interface ProfileTraitReason {
  code:
    | "explicit_trait"
    | "profile_alias"
    | "task_intent"
    | "system_match"
    | "file_glob_match"
    | "recipe_match"
    | "plan_match"
    | "plan_stage_match"
    | "claim_type_match"
    | "risk_signal_match"
    | "text_match"
    | "broad_trait";
  detail: string;
}

export interface ProfileTraitMatch {
  trait: ProfileTraitDetail;
  score: number;
  reasons: ProfileTraitReason[];
}

export interface DroppedProfileTrait {
  id: string;
  reason: string;
}

export interface ProfileMatchDiagnostics {
  intents: Array<{ intent: ProfileIntent; reason: string }>;
  warnings: string[];
}

export interface ProfileMatchInput {
  cwd?: string;
  task?: string;
  changedFiles?: string[];
  systems?: string[];
  recipeIds?: string[];
  planId?: string;
  stageId?: string;
  claimTypes?: string[];
  profileAlias?: string;
  traitIds?: string[];
  limit?: number;
  strictExplicit?: boolean;
  includeInactive?: boolean;
}

export interface ProfileMatchResult {
  databasePath: string;
  traits: ProfileTraitMatch[];
  droppedTraits: DroppedProfileTrait[];
  diagnostics: ProfileMatchDiagnostics;
}

export interface ProfileListResult {
  databasePath: string;
  traits: ProfileTraitDetail[];
}

export interface ProfileShowResult {
  databasePath: string;
  trait: ProfileTraitDetail;
}

const ACTIVE_PROFILE_STATUSES = ["current", "proposed", "needs_review"];
const INTENT_KEYWORDS: Record<ProfileIntent, string[]> = {
  review: ["review", "audit", "inspect", "find issues", "pr comments"],
  architect: ["architecture", "design", "approach", "plan", "tradeoff"],
  implementer: ["implement", "fix", "change", "add", "refactor"],
  release: ["release", "publish", "deploy", "version"],
  migration: ["migrate", "move", "remove legacy", "canonical"]
};
const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 40,
  high: 30,
  normal: 20,
  low: 10
};
const STATUS_WEIGHT: Record<string, number> = {
  current: 8,
  proposed: 2,
  needs_review: 1
};

export async function listProfileTraits(options: { cwd?: string; includeInactive?: boolean } = {}): Promise<ProfileListResult> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    return {
      databasePath,
      traits: profileRows(database, options.includeInactive ?? false)
        .map((row) => hydrateProfileTrait(row))
        .sort(compareTrait)
    };
  } finally {
    database.close();
  }
}

export async function showProfileTrait(options: { cwd?: string; id: string }): Promise<ProfileShowResult> {
  const { database, databasePath } = await openConfiguredDatabase(options.cwd);

  try {
    const trait = getProfileTrait(database, options.id);
    if (!trait) {
      throw new NotFoundError(`Profile trait not found: ${options.id}`);
    }

    return { databasePath, trait };
  } finally {
    database.close();
  }
}

export async function matchProfileTraits(input: ProfileMatchInput): Promise<ProfileMatchResult> {
  const { database, databasePath } = await openConfiguredDatabase(input.cwd);

  try {
    return {
      databasePath,
      ...selectProfileTraits(database, input)
    };
  } finally {
    database.close();
  }
}

export function selectProfileTraits(
  database: SqliteDatabase,
  input: Omit<ProfileMatchInput, "cwd">
): Omit<ProfileMatchResult, "databasePath"> {
  const includeInactive = input.includeInactive ?? false;
  const rows = profileRows(database, includeInactive);
  const traits = rows.map((row) => hydrateProfileTrait(row));
  const traitsById = new Map(traits.map((trait) => [trait.id, trait]));
  const explicitTraitIds = input.traitIds ?? [];
  const explicitTraitIdSet = new Set(explicitTraitIds);
  const intents = detectIntents(input.task, input.profileAlias);
  const matches: ProfileTraitMatch[] = [];
  const droppedTraits: DroppedProfileTrait[] = [];
  const warnings: string[] = [];

  for (const traitId of explicitTraitIds) {
    if (!traitsById.has(traitId) && input.strictExplicit !== false) {
      throw new NotFoundError(`Profile trait not found: ${traitId}`);
    }
  }

  for (const trait of traits) {
    const scored = scoreTrait(trait, {
      ...input,
      explicitTraitIds: explicitTraitIdSet,
      intents
    });

    if (scored.score <= 0) {
      continue;
    }

    if (isBroadTrait(trait)) {
      warnings.push(`${trait.id} is broad; keep profile traits small and specific.`);
    }

    matches.push(scored);
  }

  const resolved = resolveConflicts(matches, droppedTraits).slice(0, input.limit ?? 5);

  for (const match of matches) {
    if (!resolved.some((selected) => selected.trait.id === match.trait.id) && !droppedTraits.some((dropped) => dropped.id === match.trait.id)) {
      droppedTraits.push({ id: match.trait.id, reason: "outside profile trait limit" });
    }
  }

  return {
    traits: resolved,
    droppedTraits,
    diagnostics: {
      intents,
      warnings
    }
  };
}

export function getProfileTrait(database: SqliteDatabase, id: string): ProfileTraitDetail | null {
  const row = database.get<ProfileTraitRow>("SELECT * FROM profile_traits WHERE id = ?", [id]);
  return row ? hydrateProfileTrait(row) : null;
}

function scoreTrait(
  trait: ProfileTraitDetail,
  input: Omit<ProfileMatchInput, "cwd"> & {
    explicitTraitIds: Set<string>;
    intents: Array<{ intent: ProfileIntent; reason: string }>;
  }
): ProfileTraitMatch {
  const reasons: ProfileTraitReason[] = [];
  let score = (PRIORITY_WEIGHT[trait.priority] ?? 0) + (STATUS_WEIGHT[trait.status] ?? -10);
  const appliesWhen = trait.appliesWhen;

  if (input.explicitTraitIds.has(trait.id)) {
    score += 1000;
    reasons.push({ code: "explicit_trait", detail: trait.id });
  }

  if (input.profileAlias && input.profileAlias !== "auto") {
    const aliases = readStringArray(appliesWhen, "aliases", "profile_aliases", "profiles");
    if (aliases.includes(input.profileAlias)) {
      score += 90;
      reasons.push({ code: "profile_alias", detail: input.profileAlias });
    }
  }

  const configuredIntents = readStringArray(appliesWhen, "intents", "task_intents");
  for (const intent of input.intents) {
    if (configuredIntents.includes(intent.intent)) {
      score += 70;
      reasons.push({ code: "task_intent", detail: intent.intent });
      break;
    }
  }

  for (const system of input.systems ?? []) {
    if (readStringArray(appliesWhen, "systems").includes(system)) {
      score += 45;
      reasons.push({ code: "system_match", detail: system });
      break;
    }
  }

  for (const changedFile of input.changedFiles ?? []) {
    if (readStringArray(appliesWhen, "file_globs", "files", "changed_files").some((pattern) => pathMatchesPattern(pattern, changedFile))) {
      score += 55;
      reasons.push({ code: "file_glob_match", detail: changedFile });
      break;
    }
  }

  for (const recipeId of input.recipeIds ?? []) {
    if (readStringArray(appliesWhen, "recipes", "recipe_ids").includes(recipeId)) {
      score += 55;
      reasons.push({ code: "recipe_match", detail: recipeId });
      break;
    }
  }

  if (input.planId && readStringArray(appliesWhen, "plans", "plan_ids").includes(input.planId)) {
    score += 50;
    reasons.push({ code: "plan_match", detail: input.planId });
  }

  if (input.stageId && readStringArray(appliesWhen, "stages", "plan_stages").includes(input.stageId)) {
    score += 35;
    reasons.push({ code: "plan_stage_match", detail: input.stageId });
  }

  for (const claimType of input.claimTypes ?? []) {
    if (readStringArray(appliesWhen, "claim_types").includes(claimType)) {
      score += 30;
      reasons.push({ code: "claim_type_match", detail: claimType });
      break;
    }
  }

  const riskSignals = readStringArray(appliesWhen, "risk_signals");
  if (input.task && riskSignals.some((signal) => input.task?.toLowerCase().includes(signal.toLowerCase()))) {
    const signal = riskSignals.find((candidate) => input.task?.toLowerCase().includes(candidate.toLowerCase())) ?? riskSignals[0];
    score += 35;
    reasons.push({ code: "risk_signal_match", detail: signal });
  }

  if (input.task) {
    const textScore = textScoreForTrait(trait, input.task);
    if (textScore > 0) {
      score += textScore;
      reasons.push({ code: "text_match", detail: input.task });
    }
  }

  if (isBroadTrait(trait)) {
    score -= 15;
    reasons.push({ code: "broad_trait", detail: "applies_when is broad" });
  }

  if (trait.snippet.length > 1_000) {
    score -= 10;
  }

  if (reasons.length === 0) {
    score = 0;
  }

  return { trait, score, reasons };
}

function resolveConflicts(matches: ProfileTraitMatch[], droppedTraits: DroppedProfileTrait[]): ProfileTraitMatch[] {
  const selected: ProfileTraitMatch[] = [];

  for (const match of matches.sort(compareMatch)) {
    const conflictingIndex = selected.findIndex((existing) => traitsConflict(existing.trait, match.trait));

    if (conflictingIndex === -1) {
      selected.push(match);
      continue;
    }

    const existing = selected[conflictingIndex];
    const winner = compareMatch(match, existing) < 0 ? match : existing;
    const loser = winner === match ? existing : match;

    droppedTraits.push({
      id: loser.trait.id,
      reason: `conflicts_with ${winner.trait.id}`
    });

    if (winner === match) {
      selected[conflictingIndex] = match;
    }
  }

  return selected.sort(compareMatch);
}

function traitsConflict(left: ProfileTraitDetail, right: ProfileTraitDetail): boolean {
  return left.conflictsWith.includes(right.id) || right.conflictsWith.includes(left.id);
}

function compareMatch(left: ProfileTraitMatch, right: ProfileTraitMatch): number {
  return (
    right.score - left.score ||
    priorityRank(right.trait.priority) - priorityRank(left.trait.priority) ||
    specificity(right.trait.appliesWhen) - specificity(left.trait.appliesWhen) ||
    statusRank(right.trait.status) - statusRank(left.trait.status) ||
    left.trait.id.localeCompare(right.trait.id)
  );
}

function compareTrait(left: ProfileTraitDetail, right: ProfileTraitDetail): number {
  return left.id.localeCompare(right.id);
}

function priorityRank(priority: string): number {
  return PRIORITY_WEIGHT[priority] ?? 0;
}

function statusRank(status: string): number {
  return STATUS_WEIGHT[status] ?? 0;
}

function specificity(value: Record<string, unknown>): number {
  return Object.entries(value).reduce((total, [, item]) => {
    if (Array.isArray(item)) return total + item.length;
    if (typeof item === "string") return total + 1;
    if (item === true) return total + 1;
    return total;
  }, 0);
}

function isBroadTrait(trait: ProfileTraitDetail): boolean {
  const keys = Object.keys(trait.appliesWhen);
  return keys.length === 0 || trait.appliesWhen.always === true || readStringArray(trait.appliesWhen, "commands").includes("*");
}

function textScoreForTrait(trait: ProfileTraitDetail, task: string): number {
  const queryTerms = new Set(task.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  const textTerms = new Set(`${trait.title} ${trait.category} ${trait.snippet}`.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  let matches = 0;

  for (const term of queryTerms) {
    if (term.length >= 4 && textTerms.has(term)) {
      matches += 1;
    }
  }

  return Math.min(matches * 4, 16);
}

function detectIntents(task: string | undefined, profileAlias: string | undefined): Array<{ intent: ProfileIntent; reason: string }> {
  const intents = new Map<ProfileIntent, string>();

  if (profileAlias && profileAlias !== "auto" && isProfileIntent(profileAlias)) {
    intents.set(profileAlias, "profile alias");
  }

  const normalizedTask = task?.toLowerCase() ?? "";
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS) as Array<[ProfileIntent, string[]]>) {
    const keyword = keywords.find((candidate) => normalizedTask.includes(candidate));
    if (keyword) {
      intents.set(intent, intents.get(intent) ?? `task keyword: ${keyword}`);
    }
  }

  return Array.from(intents.entries()).map(([intent, reason]) => ({ intent, reason }));
}

function isProfileIntent(value: string): value is ProfileIntent {
  return value === "review" || value === "architect" || value === "implementer" || value === "release" || value === "migration";
}

async function openConfiguredDatabase(cwd?: string): Promise<{ database: SqliteDatabase; databasePath: string }> {
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
    databasePath
  };
}

function profileRows(database: SqliteDatabase, includeInactive: boolean): ProfileTraitRow[] {
  if (includeInactive) {
    return database.all<ProfileTraitRow>("SELECT * FROM profile_traits ORDER BY id");
  }

  return database.all<ProfileTraitRow>(
    `SELECT * FROM profile_traits WHERE status IN (${ACTIVE_PROFILE_STATUSES.map(() => "?").join(",")}) ORDER BY id`,
    ACTIVE_PROFILE_STATUSES
  );
}

function hydrateProfileTrait(row: ProfileTraitRow): ProfileTraitDetail {
  const metadata = parseJson(row.metadata_json);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    category: row.category,
    priority: row.priority,
    sourcePath: row.source_path,
    appliesWhen: parseJson(row.applies_when_json),
    snippet: row.snippet,
    conflictsWith: readStringArray(metadata, "conflicts_with"),
    metadata
  };
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readStringArray(data: Record<string, unknown>, ...fields: string[]): string[] {
  for (const field of fields) {
    const value = data[field];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
  }

  return [];
}

interface ProfileTraitRow {
  id: string;
  title: string;
  status: string;
  category: string;
  priority: string;
  source_path: string;
  applies_when_json: string;
  metadata_json: string;
  snippet: string;
}
