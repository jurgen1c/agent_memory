import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeChangedFiles, readGitDiffFiles } from "./changes";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { canonicalMemoryFileInventory, configuredPathRelativeToRepo, pathMatchesPattern, resolveConfiguredPath, toPosix } from "./files";
import {
  loadMemory,
  type LoadedMemory,
  type MemoryClaim,
  type MemoryGraph,
  type MemoryPlanTemplate,
  type MemoryProfileTrait,
  type MemoryRecipe
} from "./memory";
import type { AgentMemoryConfig } from "./types";

export interface AuditOptions {
  cwd?: string;
  changedFiles?: string[];
  gitDiff?: boolean;
  baseRef?: string;
  strict?: boolean;
}

export type AuditSeverity = "error" | "warning" | "info";

export interface AuditSharedValues {
  source_files?: string[];
  related_files?: string[];
  symbols?: string[];
  routes?: string[];
  tags?: string[];
}

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
  claimIds: string[];
  paths: string[];
  shared_values: AuditSharedValues;
  remediation: string;
}

export interface AuditResult {
  ok: boolean;
  changedFiles: string[];
  findings: AuditFinding[];
  warnings: string[];
}

type ClaimStatus =
  | "current"
  | "proposed"
  | "experimental"
  | "needs_review"
  | "needs_verification"
  | "stale"
  | "deprecated"
  | "rejected"
  | string;

interface ClaimRecord extends MemoryClaim {
  status: ClaimStatus;
  sourcePath: string;
}

interface ExplicitRelation {
  source: string;
  target: string;
  relation: string;
  sourcePath: string;
}

interface AuditBaseline {
  memory?: LoadedMemory;
  memoryRootRelative: string;
  warnings: string[];
}

interface GitTreeFile {
  oid: string;
  repoFile: string;
}

const ACTIVE_STATUSES = new Set(["current", "proposed", "experimental", "needs_review", "needs_verification"]);
const REVIEW_STATUSES = new Set(["needs_review", "needs_verification"]);
const ACTIVE_DEPRECATED_BY_STATUSES = new Set(["current", "proposed", "experimental"]);
const LEGACY_REVIEW_DECISION_RELATIONS = new Set(["replaces", "conflicts_with"]);
const AUDIT_SEVERITY_RANK: Record<AuditSeverity, number> = { info: 0, warning: 1, error: 2 };

export function auditMemory(options: AuditOptions = {}): AuditResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memory = loadMemory(repoRoot);
  const memoryRootRelative = configuredPathRelativeToRepo(repoRoot, loaded.config.memory_root);
  const memoryFiles = canonicalMemoryFiles(repoRoot, memoryRootRelative, loaded.config);
  const changedFiles = normalizeAuditFiles(
    [
      ...(options.changedFiles ?? []),
      ...(options.gitDiff ? readGitDiffFiles(repoRoot, { baseRef: options.baseRef, includeCommittedFallback: true }) : [])
    ],
    repoRoot
  );
  const changedFileSet = new Set(changedFiles);
  const claims = memory.claims.map(normalizeClaimForAudit);
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const explicitRelations = explicitRelationsFromGraphs(memory.graphs);
  const strict = options.strict ?? false;

  if (options.gitDiff && strict && options.baseRef) {
    resolveBaselineRevision(repoRoot, options.baseRef, changedFiles, []);
  }

  const scanAllOverlaps = Boolean(options.gitDiff && !strict && changedFiles.some((file) => isConfiguredGraphFile(file, memoryRootRelative, loaded.config)));
  const overlapFindings = findOverlappingChangedClaims(
    claims,
    changedFileSet,
    memoryRootRelative,
    explicitRelations,
    strict,
    scanAllOverlaps
  );
  const baseline = options.gitDiff && !strict ? loadAuditBaseline(repoRoot, options.baseRef, changedFiles) : undefined;
  const filteredOverlapFindings = baseline?.memory
    ? suppressBaselineOverlapFindings(overlapFindings, baseline.memory, baseline.memoryRootRelative)
    : overlapFindings;
  const findings = uniqueFindings([
    ...filteredOverlapFindings,
    ...findUnreviewedRelatedSourceClaims(claims, changedFileSet, memoryRootRelative, memoryFiles, strict),
    ...findInvalidDeprecatedBy(claims, claimsById, changedFileSet, memoryRootRelative, memoryFiles),
    ...findUnreviewedActiveConflicts(claimsById, explicitRelations, changedFileSet, memoryRootRelative, memoryFiles),
    ...findCurrentRecipesWithInactiveClaims(memory.recipes, claimsById, changedFileSet, memoryRootRelative),
    ...findCurrentPlansWithInactiveRecipes(memory.plans, memory.recipes, changedFileSet, memoryRootRelative),
    ...findUnsafeCriticalProfiles(memory.profiles, changedFileSet, memoryRootRelative),
    ...findUnmarkedProfileConflicts(memory.profiles, changedFileSet, memoryRootRelative)
  ]);

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    changedFiles,
    findings,
    warnings: [...loaded.repo.warnings, ...(baseline?.warnings ?? [])]
  };
}

function loadAuditBaseline(repoRoot: string, baseRef: string | undefined, changedFiles: string[]): AuditBaseline {
  const warnings: string[] = [];
  const revision = resolveBaselineRevision(repoRoot, baseRef, changedFiles, warnings);

  if (!revision) {
    return { memoryRootRelative: "", warnings };
  }

  const snapshot = loadMemoryAtRevision(repoRoot, revision);

  if (snapshot.warning) {
    warnings.push(snapshot.warning);
  }

  return {
    memory: snapshot.memory,
    memoryRootRelative: snapshot.memoryRootRelative,
    warnings
  };
}

function resolveBaselineRevision(repoRoot: string, baseRef: string | undefined, changedFiles: string[], warnings: string[]): string | undefined {
  if (baseRef) {
    try {
      return gitOutput(repoRoot, ["merge-base", baseRef, "HEAD"]);
    } catch {
      throw new AgentMemoryError(`Could not resolve audit base ref: ${baseRef}.`, {
        details: ["Fetch the base ref or pass a commit that shares history with HEAD."]
      });
    }
  }

  try {
    const status = gitOutput(repoRoot, ["status", "--porcelain"]);

    if (status.length > 0) {
      return gitOutput(repoRoot, ["rev-parse", "HEAD"]);
    }

    if (changedFiles.length > 0) {
      return gitOutput(repoRoot, ["rev-parse", "HEAD~1"]);
    }
  } catch {
    warnings.push("Could not resolve an implicit Git baseline; overlap findings were evaluated against the current tree only.");
  }

  return undefined;
}

function loadMemoryAtRevision(
  repoRoot: string,
  revision: string
): { memory?: LoadedMemory; memoryRootRelative: string; warning?: string } {
  let configSource: string;

  try {
    configSource = gitOutput(repoRoot, ["show", `${revision}:agent-memory.config.yaml`], false);
  } catch {
    return { memoryRootRelative: "" };
  }

  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-audit-base-"));

  try {
    fs.writeFileSync(path.join(snapshotRoot, "agent-memory.config.yaml"), configSource);
    const loaded = loadConfig({ repoRoot: snapshotRoot });

    if (path.isAbsolute(loaded.config.memory_root)) {
      return {
        memoryRootRelative: "",
        warning: "Could not compare audit overlaps with the Git baseline because memory_root is an absolute path."
      };
    }

    const memoryRootRelative = configuredPathRelativeToRepo(snapshotRoot, loaded.config.memory_root);
    const patterns = [
      ...loaded.config.claims,
      ...loaded.config.graphs,
      ...loaded.config.indexes,
      ...loaded.config.recipes,
      ...loaded.config.plans,
      ...loaded.config.profiles,
      ...loaded.config.waivers
    ];
    const treeFiles = gitTreeFiles(repoRoot, revision).filter(({ repoFile }) => {
      const relativeMemoryFile = relativeToConfiguredRoot(repoFile, memoryRootRelative);
      return Boolean(relativeMemoryFile && patterns.some((pattern) => pathMatchesPattern(pattern, relativeMemoryFile)));
    });
    const blobs = readGitBlobs(repoRoot, treeFiles.map((file) => file.oid));

    for (const { oid, repoFile } of treeFiles) {
      const source = blobs.get(oid);

      if (source === undefined) {
        continue;
      }

      const target = path.join(snapshotRoot, repoFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }

    return {
      memory: loadMemory(snapshotRoot),
      memoryRootRelative
    };
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

function relativeToConfiguredRoot(repoFile: string, memoryRootRelative: string): string | undefined {
  if (memoryRootRelative.length === 0) {
    return repoFile;
  }

  const prefix = `${memoryRootRelative}/`;
  return repoFile.startsWith(prefix) ? repoFile.slice(prefix.length) : undefined;
}

function suppressBaselineOverlapFindings(
  currentFindings: AuditFinding[],
  baseMemory: LoadedMemory,
  baseMemoryRootRelative: string
): AuditFinding[] {
  const baseClaims = baseMemory.claims.map(normalizeClaimForAudit);
  const baseFindings = findOverlappingChangedClaims(
    baseClaims,
    new Set<string>(),
    baseMemoryRootRelative,
    explicitRelationsFromGraphs(baseMemory.graphs),
    false,
    true
  );
  const baseSeverityByPair = new Map<string, AuditSeverity>();

  for (const finding of baseFindings) {
    const key = finding.claimIds.join("\0");
    const previous = baseSeverityByPair.get(key);

    if (!previous || AUDIT_SEVERITY_RANK[finding.severity] > AUDIT_SEVERITY_RANK[previous]) {
      baseSeverityByPair.set(key, finding.severity);
    }
  }

  return currentFindings.filter((finding) => {
    const baseSeverity = baseSeverityByPair.get(finding.claimIds.join("\0"));
    return !baseSeverity || AUDIT_SEVERITY_RANK[baseSeverity] < AUDIT_SEVERITY_RANK[finding.severity];
  });
}

function gitOutput(repoRoot: string, args: string[], trim = true): string {
  const output = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return trim ? output.trim() : output;
}

function gitTreeFiles(repoRoot: string, revision: string): GitTreeFile[] {
  return gitOutput(repoRoot, ["ls-tree", "-r", "-z", "--format=%(objectname)%x09%(path)", revision], false)
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf("\t");
      return {
        oid: entry.slice(0, separator),
        repoFile: toPosix(entry.slice(separator + 1))
      };
    });
}

function readGitBlobs(repoRoot: string, oids: string[]): Map<string, string> {
  const uniqueOids = Array.from(new Set(oids));

  if (uniqueOids.length === 0) {
    return new Map();
  }

  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${uniqueOids.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"]
  });
  const blobs = new Map<string, string>();
  let offset = 0;

  for (const oid of uniqueOids) {
    const headerEnd = output.indexOf(10, offset);

    if (headerEnd === -1) {
      throw new AgentMemoryError(`Could not read audit baseline blob ${oid}.`);
    }

    const header = output.subarray(offset, headerEnd).toString("utf8");
    const size = Number(header.split(" ")[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;

    if (!Number.isSafeInteger(size) || size < 0 || contentEnd > output.length) {
      throw new AgentMemoryError(`Could not parse audit baseline blob ${oid}.`);
    }

    blobs.set(oid, output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }

  return blobs;
}

function findCurrentRecipesWithInactiveClaims(
  recipes: MemoryRecipe[],
  claimsById: Map<string, ClaimRecord>,
  changedFiles: Set<string>,
  memoryRootRelative: string
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const recipe of recipes) {
    if (recipe.status !== "current") {
      continue;
    }

    const recipePath = memoryPath(memoryRootRelative, recipe.sourcePath);
    const inactiveClaims = recipe.requiredClaims
      .map((claimId) => claimsById.get(claimId))
      .filter((claim): claim is ClaimRecord => claim !== undefined && ["deprecated", "stale", "rejected"].includes(claim.status));

    if (inactiveClaims.length === 0) {
      continue;
    }

    const touched =
      changedFiles.has(recipePath) || inactiveClaims.some((claim) => changedFiles.has(memoryPath(memoryRootRelative, claim.sourcePath)));

    if (!touched) {
      continue;
    }

    findings.push({
      code: "recipe.required_claim.inactive",
      severity: "error",
      message: `Current recipe ${recipe.id} requires inactive claims: ${inactiveClaims.map((claim) => `${claim.id} (${claim.status})`).join(", ")}.`,
      claimIds: inactiveClaims.map((claim) => claim.id).sort(),
      paths: [recipePath, ...inactiveClaims.map((claim) => memoryPath(memoryRootRelative, claim.sourcePath))].sort(),
      shared_values: {},
      remediation: "Update the recipe to require current claims, reactivate the intended claim, or mark the recipe non-current."
    });
  }

  return findings;
}

function findCurrentPlansWithInactiveRecipes(
  plans: MemoryPlanTemplate[],
  recipes: MemoryRecipe[],
  changedFiles: Set<string>,
  memoryRootRelative: string
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));

  for (const plan of plans) {
    if (plan.status !== "current") {
      continue;
    }

    const inactiveRecipeIds = new Set<string>();

    for (const recipeId of [...readStringArray(plan.raw, "recipes"), ...plan.stages.flatMap((stage) => readStringArray(stage.raw, "recipe_refs"))]) {
      const recipe = recipesById.get(recipeId);
      if (recipe && ["deprecated", "stale", "rejected"].includes(recipe.status)) {
        inactiveRecipeIds.add(recipeId);
      }
    }

    if (inactiveRecipeIds.size === 0) {
      continue;
    }

    const planPath = memoryPath(memoryRootRelative, plan.sourcePath);
    const inactiveRecipes = Array.from(inactiveRecipeIds)
      .map((recipeId) => recipesById.get(recipeId))
      .filter((recipe): recipe is MemoryRecipe => Boolean(recipe));
    const touched =
      changedFiles.has(planPath) || inactiveRecipes.some((recipe) => changedFiles.has(memoryPath(memoryRootRelative, recipe.sourcePath)));

    if (!touched) {
      continue;
    }

    findings.push({
      code: "plan.recipe_ref.inactive",
      severity: "error",
      message: `Current plan template ${plan.id} references inactive recipes: ${inactiveRecipes.map((recipe) => `${recipe.id} (${recipe.status})`).join(", ")}.`,
      claimIds: [],
      paths: [planPath, ...inactiveRecipes.map((recipe) => memoryPath(memoryRootRelative, recipe.sourcePath))].sort(),
      shared_values: {},
      remediation: "Update the plan stage to use a current recipe, reactivate the intended recipe, or mark the plan non-current."
    });
  }

  return findings;
}

function findUnsafeCriticalProfiles(
  profiles: MemoryProfileTrait[],
  changedFiles: Set<string>,
  memoryRootRelative: string
): AuditFinding[] {
  return profiles
    .filter((profile) => profile.status === "current" && profile.priority === "critical" && isBroadProfile(profile))
    .filter((profile) => changedFiles.has(memoryPath(memoryRootRelative, profile.sourcePath)))
    .map((profile) => ({
      code: "profile.critical_broad",
      severity: "error" as const,
      message: `Current critical profile trait ${profile.id} has broad applies_when.`,
      claimIds: [],
      paths: [memoryPath(memoryRootRelative, profile.sourcePath)],
      shared_values: {},
      remediation: "Narrow applies_when with systems, changed_files, recipes, plan_stages, or lower the priority."
    }));
}

function findUnmarkedProfileConflicts(
  profiles: MemoryProfileTrait[],
  changedFiles: Set<string>,
  memoryRootRelative: string
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const currentProfiles = profiles.filter((profile) => profile.status === "current");
  const seenPairs = new Set<string>();

  for (const profile of currentProfiles) {
    for (const other of currentProfiles) {
      if (profile.id === other.id) {
        continue;
      }

      const key = pairKey(profile.id, other.id);
      if (seenPairs.has(key)) {
        continue;
      }

      seenPairs.add(key);

      if (
        !changedFiles.has(memoryPath(memoryRootRelative, profile.sourcePath)) &&
        !changedFiles.has(memoryPath(memoryRootRelative, other.sourcePath))
      ) {
        continue;
      }

      if (!profilesMayConflict(profile, other) || hasProfileConflictReference(profile, other)) {
        continue;
      }

      findings.push({
        code: "profile.conflict_missing",
        severity: "error",
        message: `Current profile traits ${profile.id} and ${other.id} appear to overlap but do not declare conflicts_with.`,
        claimIds: [],
        paths: [memoryPath(memoryRootRelative, profile.sourcePath), memoryPath(memoryRootRelative, other.sourcePath)].sort(),
        shared_values: {},
        remediation: "Add conflicts_with to one trait, narrow applies_when, or clarify that both traits can safely compose."
      });
    }
  }

  return findings;
}

function findOverlappingChangedClaims(
  claims: ClaimRecord[],
  changedFiles: Set<string>,
  memoryRootRelative: string,
  explicitRelations: ExplicitRelation[],
  strict: boolean,
  scanAll = false
): AuditFinding[] {
  const activeClaims = claims.filter(isActiveClaim);
  const changedActiveClaims = scanAll
    ? activeClaims
    : activeClaims.filter((claim) => changedFiles.has(memoryPath(memoryRootRelative, claim.sourcePath)));
  const claimsByAttribute = indexClaimsByAuditAttribute(activeClaims);
  const findings: AuditFinding[] = [];
  const seenPairs = new Set<string>();

  for (const claim of changedActiveClaims) {
    for (const other of candidateOverlappingClaims(claim, claimsByAttribute)) {
      if (claim.id === other.id) {
        continue;
      }

      const key = pairKey(claim.id, other.id);

      if (seenPairs.has(key)) {
        continue;
      }

      seenPairs.add(key);

      const sharedValues = sharedAuditValues(claim, other);
      const shared = Object.keys(sharedValues);

      if (shared.length === 0 || hasReviewDecision(claim, other, explicitRelations, strict)) {
        continue;
      }

      const severity = strict ? "error" : overlapSeverity(claim, other, sharedValues);

      findings.push({
        code: "claim.overlap_without_review",
        severity,
        message: strict
          ? `Changed active claim ${claim.id} overlaps active claim ${other.id} by ${shared.join(", ")} without a replaces or conflicts_with decision.`
          : `Changed active claim ${claim.id} overlaps active claim ${other.id} by ${shared.join(", ")} without an explicit review relationship.`,
        claimIds: [claim.id, other.id].sort(),
        paths: [memoryPath(memoryRootRelative, claim.sourcePath), memoryPath(memoryRootRelative, other.sourcePath)].sort(),
        shared_values: sharedValues,
        remediation: strict
          ? "Update the older claim directly, mark one claim stale/deprecated, or add an explicit replaces or conflicts_with graph edge."
          : "Review the claims and, when semantically accurate, connect them with an explicit graph relationship, update the older claim, or mark it stale/deprecated."
      });
    }
  }

  return findings;
}

function findUnreviewedRelatedSourceClaims(
  claims: ClaimRecord[],
  changedFiles: Set<string>,
  memoryRootRelative: string,
  memoryFiles: Set<string>,
  strict: boolean
): AuditFinding[] {
  const activeClaims = claims.filter(isActiveClaim);
  const changedSourceFiles = Array.from(changedFiles).filter((file) => !isMemoryFile(file, memoryFiles));
  const findings: AuditFinding[] = [];

  for (const sourceFile of changedSourceFiles) {
    const relatedClaims = activeClaims.filter((claim) => claimMentionsFile(claim, sourceFile));
    const changedRelatedClaims = relatedClaims.filter((claim) => changedFiles.has(memoryPath(memoryRootRelative, claim.sourcePath)));

    if (relatedClaims.length === 0 || changedRelatedClaims.length === 0) {
      continue;
    }

    const unreviewedClaims = relatedClaims.filter((claim) => !changedFiles.has(memoryPath(memoryRootRelative, claim.sourcePath)));

    if (unreviewedClaims.length === 0) {
      continue;
    }

    findings.push({
      code: "source.related_claims_not_reviewed",
      severity: strict ? "error" : "warning",
      message: `Changed source file ${sourceFile} has related active claims that were not reviewed in the same memory change set.`,
      claimIds: unreviewedClaims.map((claim) => claim.id).sort(),
      paths: [sourceFile, ...unreviewedClaims.map((claim) => memoryPath(memoryRootRelative, claim.sourcePath)).sort()],
      shared_values: {},
      remediation: "Review every active claim tied to this source file, update the older claim directly, or mark superseded claims stale/deprecated."
    });
  }

  return findings;
}

function findInvalidDeprecatedBy(
  claims: ClaimRecord[],
  claimsById: Map<string, ClaimRecord>,
  changedFiles: Set<string>,
  memoryRootRelative: string,
  memoryFiles: Set<string>
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const claim of claims) {
    const replacementId = readString(claim.raw, "deprecated_by");

    if (!replacementId) {
      continue;
    }

    const replacement = claimsById.get(replacementId);

    if (
      !claimTouchedByChangedFiles(claim, changedFiles, memoryRootRelative, memoryFiles) &&
      (!replacement || !claimTouchedByChangedFiles(replacement, changedFiles, memoryRootRelative, memoryFiles))
    ) {
      continue;
    }

    if (!replacement) {
      findings.push({
        code: "claim.deprecated_by_missing",
        severity: "error",
        message: `Claim ${claim.id} has deprecated_by ${replacementId}, but the replacement claim does not exist.`,
        claimIds: [claim.id, replacementId].sort(),
        paths: [memoryPath(memoryRootRelative, claim.sourcePath)],
        shared_values: {},
        remediation: "Create the replacement claim, correct deprecated_by, or remove the deprecated_by value."
      });
    } else if (!isActiveClaim(replacement)) {
      findings.push({
        code: "claim.deprecated_by_inactive",
        severity: "error",
        message: `Claim ${claim.id} has deprecated_by ${replacementId}, but the replacement claim is ${replacement.status}.`,
        claimIds: [claim.id, replacementId].sort(),
        paths: [memoryPath(memoryRootRelative, claim.sourcePath), memoryPath(memoryRootRelative, replacement.sourcePath)].sort(),
        shared_values: {},
        remediation: "Point deprecated_by at an active replacement claim or reactivate the intended replacement."
      });
    }

    if (ACTIVE_DEPRECATED_BY_STATUSES.has(claim.status)) {
      findings.push({
        code: "claim.deprecated_by_active_status",
        severity: "error",
        message: `Claim ${claim.id} has deprecated_by but is still ${claim.status}.`,
        claimIds: [claim.id],
        paths: [memoryPath(memoryRootRelative, claim.sourcePath)],
        shared_values: {},
        remediation: "Change the superseded claim status to stale, deprecated, rejected, needs_review, or needs_verification."
      });
    }
  }

  return findings;
}

function findUnreviewedActiveConflicts(
  claimsById: Map<string, ClaimRecord>,
  explicitRelations: ExplicitRelation[],
  changedFiles: Set<string>,
  memoryRootRelative: string,
  memoryFiles: Set<string>
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const seenPairs = new Set<string>();

  for (const relation of explicitRelations) {
    if (relation.relation !== "conflicts_with") {
      continue;
    }

    const source = claimsById.get(relation.source);
    const target = claimsById.get(relation.target);

    if (!source || !target || !isActiveClaim(source) || !isActiveClaim(target)) {
      continue;
    }

    const key = pairKey(source.id, target.id);

    if (seenPairs.has(key)) {
      continue;
    }

    seenPairs.add(key);

    if (
      !changedFiles.has(memoryPath(memoryRootRelative, relation.sourcePath)) &&
      !claimTouchedByChangedFiles(source, changedFiles, memoryRootRelative, memoryFiles) &&
      !claimTouchedByChangedFiles(target, changedFiles, memoryRootRelative, memoryFiles)
    ) {
      continue;
    }

    if (REVIEW_STATUSES.has(source.status) || REVIEW_STATUSES.has(target.status)) {
      continue;
    }

    findings.push({
      code: "graph.active_conflict_unreviewed",
      severity: "error",
      message: `Active conflicting claims ${source.id} and ${target.id} need an explicit review status on at least one side.`,
      claimIds: [source.id, target.id].sort(),
      paths: [memoryPath(memoryRootRelative, source.sourcePath), memoryPath(memoryRootRelative, target.sourcePath)].sort(),
      shared_values: {},
      remediation: "Set one conflicting claim to needs_review or needs_verification, or resolve the conflict by updating/deprecating a claim."
    });
  }

  return findings;
}

function explicitRelationsFromGraphs(graphs: MemoryGraph[]): ExplicitRelation[] {
  const relations: ExplicitRelation[] = [];

  for (const graph of graphs) {
    const sourcePath = toPosix(graph.sourcePath);

    for (const edge of graph.edges) {
      if (edge.claims && edge.claims.length > 1) {
        for (let left = 0; left < edge.claims.length; left += 1) {
          for (let right = left + 1; right < edge.claims.length; right += 1) {
            relations.push({ source: edge.claims[left], target: edge.claims[right], relation: edge.relation, sourcePath });

            if (edge.bidirectional) {
              relations.push({ source: edge.claims[right], target: edge.claims[left], relation: edge.relation, sourcePath });
            }
          }
        }

        continue;
      }

      if (!edge.source || !edge.target) {
        continue;
      }

      relations.push({ source: edge.source, target: edge.target, relation: edge.relation, sourcePath });

      if (edge.bidirectional) {
        relations.push({ source: edge.target, target: edge.source, relation: edge.relation, sourcePath });
      }
    }
  }

  return relations;
}

function normalizeClaimForAudit(claim: MemoryClaim): ClaimRecord {
  return {
    ...claim,
    sourcePath: toPosix(claim.sourcePath),
    sourceFiles: claim.sourceFiles.map(toAuditFileReference),
    relatedFiles: claim.relatedFiles.map(toAuditFileReference)
  };
}

function canonicalMemoryFiles(
  repoRoot: string,
  memoryRootRelative: string,
  config: AgentMemoryConfig
): Set<string> {
  const memoryRoot = resolveConfiguredPath(repoRoot, config.memory_root);
  return new Set(canonicalMemoryFileInventory(memoryRoot, config).map((file) => memoryPath(memoryRootRelative, file)));
}

function isConfiguredGraphFile(file: string, memoryRootRelative: string, config: AgentMemoryConfig): boolean {
  const relativeMemoryFile = relativeToConfiguredRoot(file, memoryRootRelative);
  return Boolean(relativeMemoryFile && config.graphs.some((pattern) => pathMatchesPattern(pattern, relativeMemoryFile)));
}

function toAuditFileReference(value: string): string {
  return toPosix(value).replaceAll("\\", "/");
}

function indexClaimsByAuditAttribute(claims: ClaimRecord[]): Map<string, ClaimRecord[]> {
  const index = new Map<string, ClaimRecord[]>();

  for (const claim of claims) {
    for (const key of auditAttributeKeys(claim)) {
      index.set(key, [...(index.get(key) ?? []), claim]);
    }
  }

  return index;
}

function candidateOverlappingClaims(claim: ClaimRecord, claimsByAttribute: Map<string, ClaimRecord[]>): ClaimRecord[] {
  const candidates = new Map<string, ClaimRecord>();

  for (const key of auditAttributeKeys(claim)) {
    for (const candidate of claimsByAttribute.get(key) ?? []) {
      candidates.set(candidate.id, candidate);
    }
  }

  return Array.from(candidates.values());
}

function auditAttributeKeys(claim: ClaimRecord): string[] {
  return [
    ...claim.sourceFiles.map((value) => auditAttributeKey("source_files", value)),
    ...claim.relatedFiles.map((value) => auditAttributeKey("related_files", value)),
    ...claim.symbols.map((value) => auditAttributeKey("symbols", value)),
    ...claim.routes.map((value) => auditAttributeKey("routes", value)),
    ...claim.tags.map((value) => auditAttributeKey("tags", value))
  ].filter((key) => key.length > 0);
}

function auditAttributeKey(kind: string, value: string): string {
  return value.length > 0 ? `${kind}\0${value}` : "";
}

function sharedAuditValues(left: ClaimRecord, right: ClaimRecord): AuditSharedValues {
  const shared: AuditSharedValues = {};
  const fields: Array<[keyof AuditSharedValues, string[], string[]]> = [
    ["source_files", left.sourceFiles, right.sourceFiles],
    ["related_files", left.relatedFiles, right.relatedFiles],
    ["symbols", left.symbols, right.symbols],
    ["routes", left.routes, right.routes],
    ["tags", left.tags, right.tags]
  ];

  for (const [field, leftValues, rightValues] of fields) {
    const values = intersection(leftValues, rightValues);

    if (values.length > 0) {
      shared[field] = values;
    }
  }

  return shared;
}

function overlapSeverity(left: ClaimRecord, right: ClaimRecord, shared: AuditSharedValues): AuditSeverity {
  if (
    (shared.routes?.length ?? 0) > 0 ||
    (shared.symbols?.length ?? 0) > 0 ||
    (left.system.length > 0 && left.system === right.system && (shared.source_files?.length ?? 0) >= 2)
  ) {
    return "error";
  }

  if ((shared.source_files?.length ?? 0) > 0 || (shared.related_files?.length ?? 0) > 0) {
    return "warning";
  }

  return "info";
}

function claimMentionsFile(claim: ClaimRecord, sourceFile: string): boolean {
  return [...claim.sourceFiles, ...claim.relatedFiles].some((pattern) => pattern === sourceFile || pathMatchesPattern(pattern, sourceFile));
}

function claimTouchedByChangedFiles(
  claim: ClaimRecord,
  changedFiles: Set<string>,
  memoryRootRelative: string,
  memoryFiles: Set<string>
): boolean {
  if (changedFiles.has(memoryPath(memoryRootRelative, claim.sourcePath))) {
    return true;
  }

  return Array.from(changedFiles)
    .filter((file) => !isMemoryFile(file, memoryFiles))
    .some((file) => claimMentionsFile(claim, file));
}

function hasReviewDecision(left: ClaimRecord, right: ClaimRecord, explicitRelations: ExplicitRelation[], strict: boolean): boolean {
  return hasExplicitReviewDecision(left.id, right.id, explicitRelations, strict) || hasDeprecatedByReviewDecision(left, right);
}

function hasExplicitReviewDecision(leftId: string, rightId: string, explicitRelations: ExplicitRelation[], strict: boolean): boolean {
  return explicitRelations.some(
    (relation) =>
      (!strict || LEGACY_REVIEW_DECISION_RELATIONS.has(relation.relation)) &&
      ((relation.source === leftId && relation.target === rightId) || (relation.source === rightId && relation.target === leftId))
  );
}

function hasDeprecatedByReviewDecision(left: ClaimRecord, right: ClaimRecord): boolean {
  return readString(left.raw, "deprecated_by") === right.id || readString(right.raw, "deprecated_by") === left.id;
}

function isActiveClaim(claim: ClaimRecord): boolean {
  return ACTIVE_STATUSES.has(claim.status);
}

function intersects(left: string[], right: string[]): boolean {
  return intersection(left, right).length > 0;
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.filter((value) => value.length > 0));
  return Array.from(new Set(left.filter((value) => value.length > 0 && rightSet.has(value)))).sort();
}

function normalizeAuditFiles(files: string[], repoRoot: string): string[] {
  return Array.from(new Set(normalizeChangedFiles(files, repoRoot))).sort();
}

function isMemoryFile(file: string, memoryFiles: Set<string>): boolean {
  return memoryFiles.has(file);
}

function memoryPath(memoryRootRelative: string, sourcePath: string): string {
  return toPosix(path.join(memoryRootRelative, sourcePath));
}

function readString(data: Record<string, unknown>, field: string): string {
  return typeof data[field] === "string" ? data[field] : "";
}

function readStringArray(data: Record<string, unknown>, field: string): string[] {
  const value = data[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isBroadProfile(profile: MemoryProfileTrait): boolean {
  const keys = Object.keys(profile.appliesWhen);
  return keys.length === 0 || profile.appliesWhen.always === true || readStringArray(profile.appliesWhen, "commands").includes("*");
}

function profilesMayConflict(left: MemoryProfileTrait, right: MemoryProfileTrait): boolean {
  if (left.category !== right.category) {
    return false;
  }

  if (isBroadProfile(left) || isBroadProfile(right)) {
    return true;
  }

  return (
    sharedProfileAppliesWhen(left, right, "systems") ||
    sharedProfileAppliesWhen(left, right, "changed_files") ||
    sharedProfileAppliesWhen(left, right, "file_globs") ||
    sharedProfileAppliesWhen(left, right, "recipes") ||
    sharedProfileAppliesWhen(left, right, "plan_stages") ||
    sharedProfileAppliesWhen(left, right, "tags")
  );
}

function sharedProfileAppliesWhen(left: MemoryProfileTrait, right: MemoryProfileTrait, field: string): boolean {
  return intersects(readStringArray(left.appliesWhen, field), readStringArray(right.appliesWhen, field));
}

function hasProfileConflictReference(left: MemoryProfileTrait, right: MemoryProfileTrait): boolean {
  return readStringArray(left.raw, "conflicts_with").includes(right.id) || readStringArray(right.raw, "conflicts_with").includes(left.id);
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\0");
}

function uniqueFindings(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  const unique: AuditFinding[] = [];

  for (const finding of findings) {
    const key = `${finding.code}\0${finding.severity}\0${finding.claimIds.join("\0")}\0${finding.paths.join("\0")}\0${JSON.stringify(finding.shared_values)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(finding);
  }

  return unique.sort((left, right) => `${left.code}:${left.paths.join(",")}`.localeCompare(`${right.code}:${right.paths.join(",")}`));
}
