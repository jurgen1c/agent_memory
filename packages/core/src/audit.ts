import path from "node:path";
import { normalizeChangedFiles, readGitDiffFiles } from "./changes";
import { loadConfig } from "./config";
import { configuredPathRelativeToRepo, pathMatchesPattern, toPosix } from "./files";
import { loadMemory, type MemoryClaim, type MemoryGraph } from "./memory";

export interface AuditOptions {
  cwd?: string;
  changedFiles?: string[];
  gitDiff?: boolean;
  baseRef?: string;
}

export interface AuditFinding {
  code: string;
  message: string;
  claimIds: string[];
  paths: string[];
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

const ACTIVE_STATUSES = new Set(["current", "proposed", "experimental", "needs_review", "needs_verification"]);
const REVIEW_STATUSES = new Set(["needs_review", "needs_verification"]);
const ACTIVE_DEPRECATED_BY_STATUSES = new Set(["current", "proposed", "experimental"]);
const REVIEW_DECISION_RELATIONS = new Set(["replaces", "conflicts_with"]);

export function auditMemory(options: AuditOptions = {}): AuditResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memory = loadMemory(repoRoot);
  const memoryRootRelative = configuredPathRelativeToRepo(repoRoot, loaded.config.memory_root);
  const changedFiles = normalizeAuditFiles(
    [
      ...(options.changedFiles ?? []),
      ...(options.gitDiff ? readGitDiffFiles(repoRoot, { baseRef: options.baseRef, includeCommittedFallback: true }) : [])
    ],
    repoRoot
  );
  const changedFileSet = new Set(changedFiles);
  const claims = memory.claims.map((claim) => ({ ...claim, sourcePath: toPosix(claim.sourcePath) }));
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const explicitRelations = explicitRelationsFromGraphs(memory.graphs);
  const findings = [
    ...findOverlappingChangedClaims(claims, changedFileSet, memoryRootRelative, explicitRelations),
    ...findUnreviewedRelatedSourceClaims(claims, changedFileSet, memoryRootRelative),
    ...findInvalidDeprecatedBy(claims, claimsById, changedFileSet, memoryRootRelative),
    ...findUnreviewedActiveConflicts(claimsById, explicitRelations, changedFileSet, memoryRootRelative)
  ];

  return {
    ok: findings.length === 0,
    changedFiles,
    findings: uniqueFindings(findings),
    warnings: []
  };
}

function findOverlappingChangedClaims(
  claims: ClaimRecord[],
  changedFiles: Set<string>,
  memoryRootRelative: string,
  explicitRelations: ExplicitRelation[]
): AuditFinding[] {
  const activeClaims = claims.filter(isActiveClaim);
  const changedActiveClaims = activeClaims.filter((claim) => changedFiles.has(memoryPath(memoryRootRelative, claim.sourcePath)));
  const findings: AuditFinding[] = [];
  const seenPairs = new Set<string>();

  for (const claim of changedActiveClaims) {
    for (const other of activeClaims) {
      if (claim.id === other.id) {
        continue;
      }

      const key = pairKey(claim.id, other.id);

      if (seenPairs.has(key)) {
        continue;
      }

      seenPairs.add(key);

      const shared = sharedAuditAttributes(claim, other);

      if (shared.length === 0 || hasReviewDecision(claim, other, explicitRelations)) {
        continue;
      }

      findings.push({
        code: "claim.overlap_without_review",
        message: `Changed active claim ${claim.id} overlaps active claim ${other.id} by ${shared.join(", ")} without a replaces or conflicts_with decision.`,
        claimIds: [claim.id, other.id].sort(),
        paths: [memoryPath(memoryRootRelative, claim.sourcePath), memoryPath(memoryRootRelative, other.sourcePath)].sort(),
        remediation: "Update the older claim directly, mark one claim stale/deprecated, or add an explicit replaces or conflicts_with graph edge."
      });
    }
  }

  return findings;
}

function findUnreviewedRelatedSourceClaims(
  claims: ClaimRecord[],
  changedFiles: Set<string>,
  memoryRootRelative: string
): AuditFinding[] {
  const activeClaims = claims.filter(isActiveClaim);
  const changedSourceFiles = Array.from(changedFiles).filter((file) => !isMemoryFile(file, memoryRootRelative));
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
      message: `Changed source file ${sourceFile} has related active claims that were not reviewed in the same memory change set.`,
      claimIds: unreviewedClaims.map((claim) => claim.id).sort(),
      paths: [sourceFile, ...unreviewedClaims.map((claim) => memoryPath(memoryRootRelative, claim.sourcePath)).sort()],
      remediation: "Review every active claim tied to this source file, update the older claim directly, or mark superseded claims stale/deprecated."
    });
  }

  return findings;
}

function findInvalidDeprecatedBy(
  claims: ClaimRecord[],
  claimsById: Map<string, ClaimRecord>,
  changedFiles: Set<string>,
  memoryRootRelative: string
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const claim of claims) {
    const replacementId = readString(claim.raw, "deprecated_by");

    if (!replacementId) {
      continue;
    }

    const replacement = claimsById.get(replacementId);

    if (
      !claimTouchedByChangedFiles(claim, changedFiles, memoryRootRelative) &&
      (!replacement || !claimTouchedByChangedFiles(replacement, changedFiles, memoryRootRelative))
    ) {
      continue;
    }

    if (!replacement) {
      findings.push({
        code: "claim.deprecated_by_missing",
        message: `Claim ${claim.id} has deprecated_by ${replacementId}, but the replacement claim does not exist.`,
        claimIds: [claim.id, replacementId],
        paths: [memoryPath(memoryRootRelative, claim.sourcePath)],
        remediation: "Create the replacement claim, correct deprecated_by, or remove the deprecated_by value."
      });
    } else if (!isActiveClaim(replacement)) {
      findings.push({
        code: "claim.deprecated_by_inactive",
        message: `Claim ${claim.id} has deprecated_by ${replacementId}, but the replacement claim is ${replacement.status}.`,
        claimIds: [claim.id, replacementId],
        paths: [memoryPath(memoryRootRelative, claim.sourcePath), memoryPath(memoryRootRelative, replacement.sourcePath)],
        remediation: "Point deprecated_by at an active replacement claim or reactivate the intended replacement."
      });
    }

    if (ACTIVE_DEPRECATED_BY_STATUSES.has(claim.status)) {
      findings.push({
        code: "claim.deprecated_by_active_status",
        message: `Claim ${claim.id} has deprecated_by but is still ${claim.status}.`,
        claimIds: [claim.id],
        paths: [memoryPath(memoryRootRelative, claim.sourcePath)],
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
  memoryRootRelative: string
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
      !claimTouchedByChangedFiles(source, changedFiles, memoryRootRelative) &&
      !claimTouchedByChangedFiles(target, changedFiles, memoryRootRelative)
    ) {
      continue;
    }

    if (REVIEW_STATUSES.has(source.status) || REVIEW_STATUSES.has(target.status)) {
      continue;
    }

    findings.push({
      code: "graph.active_conflict_unreviewed",
      message: `Active conflicting claims ${source.id} and ${target.id} need an explicit review status on at least one side.`,
      claimIds: [source.id, target.id].sort(),
      paths: [memoryPath(memoryRootRelative, source.sourcePath), memoryPath(memoryRootRelative, target.sourcePath)].sort(),
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

function sharedAuditAttributes(left: ClaimRecord, right: ClaimRecord): string[] {
  const shared: string[] = [];

  if (intersects(left.sourceFiles, right.sourceFiles)) {
    shared.push("source_files");
  }

  if (intersects(left.relatedFiles, right.relatedFiles)) {
    shared.push("related_files");
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

function claimMentionsFile(claim: ClaimRecord, sourceFile: string): boolean {
  return [...claim.sourceFiles, ...claim.relatedFiles].some((pattern) => pattern === sourceFile || pathMatchesPattern(pattern, sourceFile));
}

function claimTouchedByChangedFiles(claim: ClaimRecord, changedFiles: Set<string>, memoryRootRelative: string): boolean {
  if (changedFiles.has(memoryPath(memoryRootRelative, claim.sourcePath))) {
    return true;
  }

  return Array.from(changedFiles)
    .filter((file) => !isMemoryFile(file, memoryRootRelative))
    .some((file) => claimMentionsFile(claim, file));
}

function hasReviewDecision(left: ClaimRecord, right: ClaimRecord, explicitRelations: ExplicitRelation[]): boolean {
  return hasExplicitReviewDecision(left.id, right.id, explicitRelations) || hasDeprecatedByReviewDecision(left, right);
}

function hasExplicitReviewDecision(leftId: string, rightId: string, explicitRelations: ExplicitRelation[]): boolean {
  return explicitRelations.some(
    (relation) =>
      REVIEW_DECISION_RELATIONS.has(relation.relation) &&
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
  const rightSet = new Set(right.filter((value) => value.length > 0));
  return left.some((value) => value.length > 0 && rightSet.has(value));
}

function normalizeAuditFiles(files: string[], repoRoot: string): string[] {
  return Array.from(new Set(normalizeChangedFiles(files, repoRoot))).sort();
}

function isMemoryFile(file: string, memoryRootRelative: string): boolean {
  return file === memoryRootRelative || file.startsWith(`${memoryRootRelative}/`);
}

function memoryPath(memoryRootRelative: string, sourcePath: string): string {
  return toPosix(path.join(memoryRootRelative, sourcePath));
}

function readString(data: Record<string, unknown>, field: string): string {
  return typeof data[field] === "string" ? data[field] : "";
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\0");
}

function uniqueFindings(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  const unique: AuditFinding[] = [];

  for (const finding of findings) {
    const key = `${finding.code}\0${finding.claimIds.join("\0")}\0${finding.paths.join("\0")}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(finding);
  }

  return unique.sort((left, right) => `${left.code}:${left.paths.join(",")}`.localeCompare(`${right.code}:${right.paths.join(",")}`));
}
