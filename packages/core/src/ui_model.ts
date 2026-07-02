import fs from "node:fs";
import path from "node:path";
import { compileMemory, type CompileResult } from "./compiler";
import { loadConfig } from "./config";
import { doctorMemory, type DoctorResult } from "./doctor";
import { AgentMemoryError, NotFoundError } from "./errors";
import { discoverCanonicalMemoryFiles, resolveConfiguredPath, toPosix } from "./files";
import { parseMarkdown } from "./markdown";
import { loadMemory, type LoadedMemory, type MemoryClaim, type MemoryGraphEdge } from "./memory";
import { commandPrefixForRepo } from "./skills";
import { validateRepository, type ValidationResult } from "./validator";

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
  claims: UiClaim[];
  relations: UiRelation[];
  files: UiFileNode;
  validation: ValidationResult;
  doctor: DoctorResult;
  reviewQueue: UiReviewItem[];
}

export interface UiClaim {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  sourcePath: string;
  sourceFiles: string[];
  relatedFiles: string[];
  symbols: string[];
  routes: string[];
  tags: string[];
  verification: string[];
  body: string;
  raw: Record<string, unknown>;
  reviewPriority: number;
  reviewReason?: string;
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
  kind: "directory" | "claim" | "graph" | "index" | "recipe" | "waiver" | "file";
  claimId?: string;
  children?: UiFileNode[];
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

export async function buildUiMemoryModel(cwd?: string): Promise<UiMemoryModel> {
  const loaded = loadConfig({ cwd });
  const memory = loadMemory(cwd);
  const repoRoot = loaded.repo.root;
  const memoryRoot = resolveConfiguredPath(repoRoot, loaded.config.memory_root);
  const databasePath = path.isAbsolute(loaded.config.database_path) ? loaded.config.database_path : path.join(repoRoot, loaded.config.database_path);
  const validation = validateRepository({ cwd });
  const doctor = await doctorMemory({ cwd });
  const claims = memory.claims.map((claim) => toUiClaim(memoryRoot, claim));
  const relations = buildUiRelations(memory);

  return {
    repoRoot,
    memoryRoot: loaded.config.memory_root,
    databasePath,
    commandPrefix: commandPrefixForRepo(repoRoot),
    claims,
    relations,
    files: buildFileTree(repoRoot, memoryRoot, loaded.config, claims),
    validation,
    doctor,
    reviewQueue: buildReviewQueue(claims)
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

function toUiClaim(memoryRoot: string, claim: MemoryClaim): UiClaim {
  const parsed = parseMarkdown(fs.readFileSync(path.join(memoryRoot, claim.sourcePath), "utf8"));
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
    sourceFiles: claim.sourceFiles,
    relatedFiles: claim.relatedFiles,
    symbols: claim.symbols,
    routes: claim.routes,
    tags: claim.tags,
    verification: claim.verification,
    body: parsed.body,
    raw: claim.raw,
    reviewPriority: review.priority,
    reviewReason: review.reason
  };
}

function buildUiRelations(memory: LoadedMemory): UiRelation[] {
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
    waivers: string[];
  },
  claims: UiClaim[]
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

function buildReviewQueue(claims: UiClaim[]): UiReviewItem[] {
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
