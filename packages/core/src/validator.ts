import fs from "node:fs";
import path from "node:path";
import { normalizeChangedFiles } from "./changes";
import { ConfigError } from "./errors";
import { loadConfig } from "./config";
import { discoverFiles, toPosix } from "./files";
import { parseMarkdownFile, extractMarkdownSection } from "./markdown";
import { isPathInside } from "./repo";
import type { AgentMemoryConfig } from "./types";
import { parseYaml } from "./yaml";
import { CLAIM_TYPES } from "./templates";

type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  path?: string;
  id?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  counts: {
    claims: number;
    graphs: number;
    indexes: number;
    recipes: number;
  };
}

export interface ValidateRepositoryOptions {
  cwd?: string;
  strict?: boolean;
  changedFiles?: string[];
}

interface LoadedClaim {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  sourceFiles: string[];
  relatedFiles: string[];
  tags: string[];
  path: string;
  relativePath: string;
  raw: Record<string, unknown>;
}

interface LoadedRecipe {
  id: string;
  status: string;
  requiredClaims: string[];
  path: string;
  relativePath: string;
}

type ValidationConfig = AgentMemoryConfig["validation"];

const CLAIM_STATUSES = [
  "current",
  "proposed",
  "stale",
  "deprecated",
  "experimental",
  "needs_verification",
  "needs_review",
  "rejected"
];
const CONFIDENCE_VALUES = ["low", "medium", "high", "verified"];
const SEVERITIES = ["info", "normal", "important", "critical"];
const RELATIONS = [
  "requires",
  "constrains",
  "explains",
  "conflicts_with",
  "replaces",
  "verifies",
  "same_area",
  "causes",
  "caused_by",
  "blocks",
  "unblocks",
  "implemented_by",
  "tested_by"
];

export function validateRepository(options: ValidateRepositoryOptions = {}): ValidationResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memoryRoot = path.join(repoRoot, loaded.config.memory_root);
  const issues: ValidationIssue[] = [];
  const changedFiles = new Set(normalizeChangedFiles(options.changedFiles ?? [], repoRoot));
  const scoped = changedFiles.size > 0;

  const allClaimFiles = discoverFiles(memoryRoot, loaded.config.claims);
  const allGraphFiles = discoverFiles(memoryRoot, loaded.config.graphs);
  const allIndexFiles = discoverFiles(memoryRoot, loaded.config.indexes);
  const allRecipeFiles = discoverFiles(memoryRoot, loaded.config.recipes);

  const claimFiles = scoped ? selectChangedFiles(allClaimFiles, changedFiles, repoRoot) : allClaimFiles;
  const graphFiles = scoped ? selectChangedFiles(allGraphFiles, changedFiles, repoRoot) : allGraphFiles;
  const indexFiles = scoped ? selectChangedFiles(allIndexFiles, changedFiles, repoRoot) : allIndexFiles;
  const recipeFiles = scoped ? selectChangedFiles(allRecipeFiles, changedFiles, repoRoot) : allRecipeFiles;

  const claims = loadClaims(repoRoot, memoryRoot, claimFiles, loaded.config.validation, issues);
  const recipes = loadRecipes(memoryRoot, recipeFiles, issues);
  const graphs = loadYamlArtifacts(memoryRoot, graphFiles, "graph", issues);
  const indexes = loadYamlArtifacts(memoryRoot, indexFiles, "index", issues);

  const allClaims = scoped ? loadClaimReferences(memoryRoot, allClaimFiles) : claims;
  const allRecipes = scoped ? loadRecipeReferences(memoryRoot, allRecipeFiles) : recipes;
  const claimsById = new Map(allClaims.map((claim) => [claim.id, claim]));

  validateUniqueClaims(claims, issues, allClaims);
  validateUniqueClaimTitles(claims, allClaims, loaded.config.validation, Boolean(options.strict), issues);
  validateClaimFilePaths(claims, loaded.config.validation, Boolean(options.strict), issues);
  validateUniqueRecipes(recipes, issues, allRecipes);
  validateGraphs(graphs, new Set(allClaims.map((claim) => claim.id)), issues);
  validateIndexes(indexes, repoRoot, issues);
  validateRecipeReferences(recipes, claimsById, issues);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      claims: claims.length,
      graphs: graphs.length,
      indexes: indexes.length,
      recipes: recipes.length
    }
  };
}

function loadClaims(
  repoRoot: string,
  memoryRoot: string,
  files: string[],
  validationConfig: ValidationConfig,
  issues: ValidationIssue[]
): LoadedClaim[] {
  const claims: LoadedClaim[] = [];

  for (const filePath of files) {
    const relativePath = toPosix(path.relative(memoryRoot, filePath));

    try {
      const markdown = parseMarkdownFile(filePath);

      if (!isRecord(markdown.frontmatter)) {
        addError(issues, "claim.frontmatter", "Claim frontmatter must be a mapping.", relativePath);
        continue;
      }

      validateOneClaimPerFile(markdown.frontmatterRaw, markdown.body, relativePath, validationConfig, issues);
      const claim = normalizeClaim(markdown.frontmatter, relativePath, issues);

      if (!claim) {
        continue;
      }

      validateClaimFields(claim, repoRoot, validationConfig, issues);
      claims.push({ ...claim, path: filePath });
    } catch (error) {
      addError(issues, "claim.parse", formatCaughtError(error), relativePath);
    }
  }

  return claims;
}

function loadClaimReferences(memoryRoot: string, files: string[]): LoadedClaim[] {
  const claims: LoadedClaim[] = [];

  for (const filePath of files) {
    const relativePath = toPosix(path.relative(memoryRoot, filePath));

    try {
      const markdown = parseMarkdownFile(filePath);

      if (!isRecord(markdown.frontmatter)) {
        continue;
      }

      const claim = normalizeClaimReference(markdown.frontmatter, filePath, relativePath);

      if (claim) {
        claims.push(claim);
      }
    } catch {
      // Scoped reference loading is best effort; changed files still receive full validation.
    }
  }

  return claims;
}

function normalizeClaimReference(raw: Record<string, unknown>, filePath: string, relativePath: string): LoadedClaim | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.system !== "string" ||
    typeof raw.status !== "string" ||
    typeof raw.title !== "string"
  ) {
    return null;
  }

  return {
    id: raw.id,
    type: typeof raw.type === "string" ? raw.type : "",
    system: raw.system,
    status: raw.status,
    confidence: typeof raw.confidence === "string" ? raw.confidence : "",
    severity: typeof raw.severity === "string" ? raw.severity : "",
    title: raw.title,
    claim: typeof raw.claim === "string" ? raw.claim : "",
    sourceFiles: [],
    relatedFiles: [],
    tags: [],
    path: filePath,
    relativePath,
    raw
  };
}

function normalizeClaim(raw: Record<string, unknown>, relativePath: string, issues: ValidationIssue[]): LoadedClaim | null {
  const requiredStrings = ["id", "type", "system", "status", "confidence", "severity", "title", "claim"] as const;
  const missing = requiredStrings.filter((field) => typeof raw[field] !== "string" || String(raw[field]).trim().length === 0);

  if (missing.length > 0) {
    addError(issues, "claim.required", `Missing or invalid required fields: ${missing.join(", ")}`, relativePath);
    return null;
  }

  const sourceFiles = readStringArray(raw, "source_files", relativePath, issues);
  const relatedFiles = readOptionalStringArray(raw, "related_files", relativePath, issues);
  const tags = readStringArray(raw, "tags", relativePath, issues);

  return {
    id: raw.id as string,
    type: raw.type as string,
    system: raw.system as string,
    status: raw.status as string,
    confidence: raw.confidence as string,
    severity: raw.severity as string,
    title: raw.title as string,
    claim: raw.claim as string,
    sourceFiles,
    relatedFiles,
    tags,
    path: "",
    relativePath,
    raw
  };
}

function validateClaimFields(
  claim: LoadedClaim,
  repoRoot: string,
  validationConfig: Pick<ValidationConfig, "require_source_files" | "require_verification">,
  issues: ValidationIssue[]
): void {
  if (!CLAIM_TYPES.includes(claim.type as never)) {
    addError(issues, "claim.type", `Invalid claim type: ${claim.type}`, claim.relativePath, claim.id);
  }

  if (!CLAIM_STATUSES.includes(claim.status)) {
    addError(issues, "claim.status", `Invalid claim status: ${claim.status}`, claim.relativePath, claim.id);
  }

  if (!CONFIDENCE_VALUES.includes(claim.confidence)) {
    addError(issues, "claim.confidence", `Invalid confidence value: ${claim.confidence}`, claim.relativePath, claim.id);
  }

  if (!SEVERITIES.includes(claim.severity)) {
    addError(issues, "claim.severity", `Invalid severity value: ${claim.severity}`, claim.relativePath, claim.id);
  }

  if (validationConfig.require_source_files && claim.sourceFiles.length === 0) {
    addError(issues, "claim.source_files.required", "Claim must include at least one source file.", claim.relativePath, claim.id);
  }

  if (claim.tags.length === 0) {
    addError(issues, "claim.tags.required", "Claim must include at least one tag.", claim.relativePath, claim.id);
  }

  if (validationConfig.require_verification) {
    const verification = claim.raw.verification;

    if (!Array.isArray(verification) || !verification.every((item) => typeof item === "string") || verification.length === 0) {
      addError(issues, "claim.verification.required", "Claim must include at least one verification step.", claim.relativePath, claim.id);
    }
  }

  validateRepoPathReferences(claim.sourceFiles, "claim.source_files", repoRoot, claim.relativePath, claim.id, true, issues);
  validateRepoPathReferences(claim.relatedFiles, "claim.related_files", repoRoot, claim.relativePath, claim.id, true, issues);
}

function validateOneClaimPerFile(
  frontmatterRaw: string,
  body: string,
  relativePath: string,
  validationConfig: Pick<ValidationConfig, "reject_multi_claim_documents" | "max_claim_frontmatter_length" | "max_claim_section_length">,
  issues: ValidationIssue[]
): void {
  if (!validationConfig.reject_multi_claim_documents) {
    return;
  }

  const claimFieldCount = (frontmatterRaw.match(/^claim\s*:/gm) ?? []).length;

  if (claimFieldCount !== 1) {
    addError(issues, "claim.atomic.field_count", `Expected exactly one frontmatter claim field, found ${claimFieldCount}.`, relativePath);
  }

  if (/^claims\s*:/m.test(frontmatterRaw)) {
    addError(issues, "claim.atomic.claims_array", "Frontmatter must not contain a claims array.", relativePath);
  }

  if (/^##\s+Claim\s+\d+/im.test(body)) {
    addError(issues, "claim.atomic.numbered_headings", "Claim document must not contain numbered claim headings.", relativePath);
  }

  const claimSection = extractMarkdownSection(body, "Claim");

  if (claimSection && claimSection.length > validationConfig.max_claim_section_length) {
    addError(issues, "claim.atomic.section_too_long", "Claim section is longer than the configured maximum.", relativePath);
  }

  const match = frontmatterRaw.match(/^claim\s*:\s*(.*)$/m);

  if (match && match[1].length > validationConfig.max_claim_frontmatter_length) {
    addError(issues, "claim.atomic.frontmatter_too_long", "Frontmatter claim value is longer than the configured maximum.", relativePath);
  }
}

function validateUniqueClaims(claims: LoadedClaim[], issues: ValidationIssue[], referenceClaims: LoadedClaim[] = claims): void {
  const byId = new Map<string, LoadedClaim[]>();

  for (const claim of referenceClaims) {
    byId.set(claim.id, [...(byId.get(claim.id) ?? []), claim]);
  }

  const selectedPaths = new Set(claims.map((claim) => claim.relativePath));

  for (const [id, matchingClaims] of byId.entries()) {
    if (matchingClaims.length > 1) {
      const selectedClaim = matchingClaims.find((claim) => selectedPaths.has(claim.relativePath));

      if (!selectedClaim && referenceClaims !== claims) {
        continue;
      }

      addError(
        issues,
        "claim.id.duplicate",
        `Duplicate claim ID ${id} appears in ${matchingClaims.map((claim) => claim.relativePath).join(", ")}.`,
        selectedClaim?.relativePath ?? matchingClaims[0].relativePath,
        id
      );
    }
  }
}

function validateUniqueClaimTitles(
  claims: LoadedClaim[],
  referenceClaims: LoadedClaim[],
  validationConfig: ValidationConfig,
  strict: boolean,
  issues: ValidationIssue[]
): void {
  if (!validationConfig.require_unique_titles_within_system && !strict) {
    return;
  }

  const selectedPaths = new Set(claims.map((claim) => claim.relativePath));
  const bySystemAndTitle = new Map<string, LoadedClaim[]>();

  for (const claim of referenceClaims) {
    const key = `${normalizeIdentifierPart(claim.system)}\u0000${normalizeIdentifierPart(claim.title)}`;
    bySystemAndTitle.set(key, [...(bySystemAndTitle.get(key) ?? []), claim]);
  }

  for (const matchingClaims of bySystemAndTitle.values()) {
    if (matchingClaims.length <= 1) {
      continue;
    }

    const selectedClaim = matchingClaims.find((claim) => selectedPaths.has(claim.relativePath));

    if (!selectedClaim) {
      continue;
    }

    addError(
      issues,
      "claim.title.duplicate",
      `Duplicate claim title "${selectedClaim.title}" appears in ${matchingClaims.map((claim) => claim.relativePath).join(", ")}.`,
      selectedClaim.relativePath,
      selectedClaim.id
    );
  }
}

function validateClaimFilePaths(
  claims: LoadedClaim[],
  validationConfig: ValidationConfig,
  strict: boolean,
  issues: ValidationIssue[]
): void {
  if (!validationConfig.require_claim_file_matches_id && !strict) {
    return;
  }

  for (const claim of claims) {
    const expectedPath = expectedClaimRelativePath(claim);

    if (claim.relativePath !== expectedPath) {
      addError(
        issues,
        "claim.file_path",
        `Claim file path should be ${expectedPath} for claim ID ${claim.id}.`,
        claim.relativePath,
        claim.id
      );
    }
  }
}

function expectedClaimRelativePath(claim: LoadedClaim): string {
  const idPrefix = `${claim.system}.`;
  const idRemainder = claim.id.startsWith(idPrefix) ? claim.id.slice(idPrefix.length) : claim.id;
  return toPosix(path.join("claims", claim.system, `${idRemainder.replace(/\./g, "_")}.md`));
}

function normalizeIdentifierPart(value: string): string {
  return value.trim().toLowerCase();
}

function loadYamlArtifacts(memoryRoot: string, files: string[], kind: string, issues: ValidationIssue[]): Array<{ path: string; relativePath: string; data: unknown }> {
  const artifacts: Array<{ path: string; relativePath: string; data: unknown }> = [];

  for (const filePath of files) {
    const relativePath = toPosix(path.relative(memoryRoot, filePath));

    try {
      artifacts.push({
        path: filePath,
        relativePath,
        data: parseYaml(fs.readFileSync(filePath, "utf8"))
      });
    } catch (error) {
      addError(issues, `${kind}.parse`, formatCaughtError(error), relativePath);
    }
  }

  return artifacts;
}

function validateGraphs(
  graphs: Array<{ relativePath: string; data: unknown }>,
  claimIds: Set<string>,
  issues: ValidationIssue[]
): void {
  for (const graph of graphs) {
    if (!isRecord(graph.data)) {
      addError(issues, "graph.schema", "Graph file must be a mapping.", graph.relativePath);
      continue;
    }

    validateStringField(graph.data, "id", graph.relativePath, "graph.id", issues);
    validateStringField(graph.data, "name", graph.relativePath, "graph.name", issues);

    const edges = graph.data.edges;

    if (!Array.isArray(edges)) {
      addError(issues, "graph.edges.required", "Graph must include an edges list.", graph.relativePath);
      continue;
    }

    for (const edge of edges) {
      if (!isRecord(edge)) {
        addError(issues, "graph.edge.schema", "Graph edge must be a mapping.", graph.relativePath);
        continue;
      }

      const relation = edge.relation;

      if (typeof relation !== "string" || !RELATIONS.includes(relation)) {
        addError(issues, "graph.edge.relation", `Invalid graph edge relation: ${String(relation)}`, graph.relativePath);
      }

      const refs = edge.claims !== undefined ? readEdgeClaims(edge, graph.relativePath, issues) : readSourceTargetClaims(edge, graph.relativePath, issues);

      for (const claimId of refs) {
        if (!claimIds.has(claimId)) {
          addError(issues, "graph.edge.missing_claim", `Graph edge references missing claim: ${claimId}`, graph.relativePath, claimId);
        }
      }
    }
  }
}

function readEdgeClaims(edge: Record<string, unknown>, relativePath: string, issues: ValidationIssue[]): string[] {
  const claims = edge.claims;

  if (!Array.isArray(claims) || !claims.every((claim) => typeof claim === "string")) {
    addError(issues, "graph.edge.claims", "Graph edge claims must be a list of claim IDs.", relativePath);
    return [];
  }

  if (claims.length < 2) {
    addError(issues, "graph.edge.claims", "Graph edge claims list must contain at least two claim IDs.", relativePath);
  }

  return claims;
}

function readSourceTargetClaims(edge: Record<string, unknown>, relativePath: string, issues: ValidationIssue[]): string[] {
  const refs: string[] = [];

  if (typeof edge.source !== "string") {
    addError(issues, "graph.edge.source", "Graph edge source must be a claim ID.", relativePath);
  } else {
    refs.push(edge.source);
  }

  if (typeof edge.target !== "string") {
    addError(issues, "graph.edge.target", "Graph edge target must be a claim ID.", relativePath);
  } else {
    refs.push(edge.target);
  }

  return refs;
}

function validateIndexes(indexes: Array<{ relativePath: string; data: unknown }>, repoRoot: string, issues: ValidationIssue[]): void {
  for (const index of indexes) {
    if (!isRecord(index.data)) {
      addError(issues, "index.schema", "Index file must be a mapping.", index.relativePath);
      continue;
    }

    validateStringField(index.data, "id", index.relativePath, "index.id", issues);
    validateStringField(index.data, "name", index.relativePath, "index.name", issues);

    for (const field of ["claim_globs", "recipe_globs", "default_queries", "watched_files", "tags"]) {
      if (index.data[field] !== undefined) {
        const values = readStringArray(index.data, field, index.relativePath, issues);

        if (field === "watched_files") {
          validateRepoPathReferences(values, "index.watched_files", repoRoot, index.relativePath, undefined, false, issues);
        }
      }
    }
  }
}

function loadRecipes(memoryRoot: string, files: string[], issues: ValidationIssue[]): LoadedRecipe[] {
  const recipes: LoadedRecipe[] = [];
  const artifacts = loadYamlArtifacts(memoryRoot, files, "recipe", issues);

  for (const artifact of artifacts) {
    if (!isRecord(artifact.data)) {
      addError(issues, "recipe.schema", "Recipe file must be a mapping.", artifact.relativePath);
      continue;
    }

    validateStringField(artifact.data, "id", artifact.relativePath, "recipe.id", issues);
    validateStringField(artifact.data, "title", artifact.relativePath, "recipe.title", issues);
    validateStringField(artifact.data, "system", artifact.relativePath, "recipe.system", issues);
    validateStringField(artifact.data, "status", artifact.relativePath, "recipe.status", issues);

    if (typeof artifact.data.status === "string" && !CLAIM_STATUSES.includes(artifact.data.status)) {
      addError(issues, "recipe.status", `Invalid recipe status: ${artifact.data.status}`, artifact.relativePath);
    }

    if (typeof artifact.data.id !== "string" || typeof artifact.data.status !== "string") {
      continue;
    }

    recipes.push({
      id: artifact.data.id,
      status: artifact.data.status,
      requiredClaims: readStringArray(artifact.data, "required_claims", artifact.relativePath, issues),
      path: artifact.path,
      relativePath: artifact.relativePath
    });
  }

  return recipes;
}

function loadRecipeReferences(memoryRoot: string, files: string[]): LoadedRecipe[] {
  const recipes: LoadedRecipe[] = [];

  for (const filePath of files) {
    const relativePath = toPosix(path.relative(memoryRoot, filePath));

    try {
      const data = parseYaml(fs.readFileSync(filePath, "utf8"));

      if (!isRecord(data) || typeof data.id !== "string") {
        continue;
      }

      recipes.push({
        id: data.id,
        status: typeof data.status === "string" ? data.status : "",
        requiredClaims: [],
        path: filePath,
        relativePath
      });
    } catch {
      // Scoped reference loading is best effort; changed files still receive full validation.
    }
  }

  return recipes;
}

function validateUniqueRecipes(recipes: LoadedRecipe[], issues: ValidationIssue[], referenceRecipes: LoadedRecipe[] = recipes): void {
  const byId = new Map<string, LoadedRecipe[]>();

  for (const recipe of referenceRecipes) {
    byId.set(recipe.id, [...(byId.get(recipe.id) ?? []), recipe]);
  }

  const selectedPaths = new Set(recipes.map((recipe) => recipe.relativePath));

  for (const [id, matchingRecipes] of byId.entries()) {
    if (matchingRecipes.length > 1) {
      const selectedRecipe = matchingRecipes.find((recipe) => selectedPaths.has(recipe.relativePath));

      if (!selectedRecipe && referenceRecipes !== recipes) {
        continue;
      }

      addError(
        issues,
        "recipe.id.duplicate",
        `Duplicate recipe ID ${id} appears in ${matchingRecipes.map((recipe) => recipe.relativePath).join(", ")}.`,
        selectedRecipe?.relativePath ?? matchingRecipes[0].relativePath,
        id
      );
    }
  }
}

function validateRecipeReferences(recipes: LoadedRecipe[], claimsById: Map<string, LoadedClaim>, issues: ValidationIssue[]): void {
  for (const recipe of recipes) {
    for (const claimId of recipe.requiredClaims) {
      const claim = claimsById.get(claimId);

      if (!claim) {
        addError(issues, "recipe.required_claim.missing", `Recipe references missing required claim: ${claimId}`, recipe.relativePath, claimId);
        continue;
      }

      if (recipe.status === "current" && claim.status === "deprecated") {
        addError(
          issues,
          "recipe.required_claim.deprecated",
          `Current recipe requires deprecated claim: ${claimId}`,
          recipe.relativePath,
          claimId
        );
      }
    }
  }
}

function validateStringField(data: Record<string, unknown>, field: string, relativePath: string, code: string, issues: ValidationIssue[]): void {
  if (typeof data[field] !== "string" || String(data[field]).trim().length === 0) {
    addError(issues, code, `Missing or invalid required field: ${field}`, relativePath);
  }
}

function readStringArray(data: Record<string, unknown>, field: string, relativePath: string, issues: ValidationIssue[]): string[] {
  const value = data[field];

  if (value === undefined) {
    addError(issues, `${field}.required`, `Missing required list field: ${field}`, relativePath);
    return [];
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    addError(issues, `${field}.schema`, `Field ${field} must be a list of strings.`, relativePath);
    return [];
  }

  return value;
}

function readOptionalStringArray(data: Record<string, unknown>, field: string, relativePath: string, issues: ValidationIssue[]): string[] {
  if (data[field] === undefined) {
    return [];
  }

  return readStringArray(data, field, relativePath, issues);
}

function addError(issues: ValidationIssue[], code: string, message: string, filePath?: string, id?: string): void {
  issues.push({
    severity: "error",
    code,
    message,
    path: filePath,
    id
  });
}

function formatCaughtError(error: unknown): string {
  if (error instanceof ConfigError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectChangedFiles(files: string[], changedFiles: Set<string>, repoRoot: string): string[] {
  return files.filter((filePath) => changedFiles.has(toPosix(path.relative(repoRoot, filePath))));
}

function validateRepoPathReferences(
  references: string[],
  fieldCode: string,
  repoRoot: string,
  relativePath: string,
  id: string | undefined,
  requireExists: boolean,
  issues: ValidationIssue[]
): void {
  for (const reference of references) {
    const resolved = resolveRepoReference(repoRoot, reference);

    if (!isPathInside(repoRoot, resolved) || existingParentEscapesRepo(repoRoot, resolved)) {
      addError(issues, `${fieldCode}.outside_repo`, `Referenced path escapes repository root or cannot be validated safely: ${reference}`, relativePath, id);
      continue;
    }

    if (requireExists && !fs.existsSync(resolved)) {
      addError(issues, `${fieldCode}.missing`, `Referenced ${referenceLabel(fieldCode)} does not exist: ${reference}`, relativePath, id);
    }
  }
}

function referenceLabel(fieldCode: string): string {
  if (fieldCode.endsWith(".source_files")) {
    return "source file";
  }

  if (fieldCode.endsWith(".related_files")) {
    return "related file";
  }

  if (fieldCode.endsWith(".watched_files")) {
    return "watched file";
  }

  return "path";
}

function resolveRepoReference(repoRoot: string, reference: string): string {
  const normalizedReference = reference.replaceAll("\\", "/");
  return path.isAbsolute(normalizedReference) ? path.normalize(normalizedReference) : path.resolve(repoRoot, normalizedReference);
}

function existingParentEscapesRepo(repoRoot: string, resolvedPath: string): boolean {
  const existingParent = nearestExistingParent(resolvedPath);

  try {
    return !isPathInside(fs.realpathSync(repoRoot), fs.realpathSync(existingParent));
  } catch {
    return true;
  }
}

function nearestExistingParent(targetPath: string): string {
  let candidate = fs.existsSync(targetPath) ? targetPath : path.dirname(targetPath);

  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);

    if (parent === candidate) {
      return candidate;
    }

    candidate = parent;
  }

  return candidate;
}
