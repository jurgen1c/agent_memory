import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { loadConfig } from "./config";
import { parseMarkdownFile, extractMarkdownSection } from "./markdown";
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

  const claimFiles = discoverFiles(memoryRoot, loaded.config.claims);
  const graphFiles = discoverFiles(memoryRoot, loaded.config.graphs);
  const indexFiles = discoverFiles(memoryRoot, loaded.config.indexes);
  const recipeFiles = discoverFiles(memoryRoot, loaded.config.recipes);

  const claims = loadClaims(repoRoot, memoryRoot, claimFiles, loaded.config.validation, issues);
  const recipes = loadRecipes(memoryRoot, recipeFiles, issues);
  const graphs = loadYamlArtifacts(memoryRoot, graphFiles, "graph", issues);
  const indexes = loadYamlArtifacts(memoryRoot, indexFiles, "index", issues);

  validateUniqueClaims(claims, issues);
  validateUniqueRecipes(recipes, issues);
  validateGraphs(graphs, new Set(claims.map((claim) => claim.id)), issues);
  validateIndexes(indexes, issues);
  validateRecipeReferences(recipes, new Map(claims.map((claim) => [claim.id, claim])), issues);

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
  validationConfig: {
    require_source_files: boolean;
    require_verification: boolean;
    reject_multi_claim_documents: boolean;
    max_claim_frontmatter_length: number;
    max_claim_section_length: number;
  },
  issues: ValidationIssue[]
): LoadedClaim[] {
  const claims: LoadedClaim[] = [];

  for (const filePath of files) {
    const relativePath = path.relative(memoryRoot, filePath);

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

function normalizeClaim(raw: Record<string, unknown>, relativePath: string, issues: ValidationIssue[]): LoadedClaim | null {
  const requiredStrings = ["id", "type", "system", "status", "confidence", "severity", "title", "claim"] as const;
  const missing = requiredStrings.filter((field) => typeof raw[field] !== "string" || String(raw[field]).trim().length === 0);

  if (missing.length > 0) {
    addError(issues, "claim.required", `Missing or invalid required fields: ${missing.join(", ")}`, relativePath);
    return null;
  }

  const sourceFiles = readStringArray(raw, "source_files", relativePath, issues);
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
    tags,
    path: "",
    relativePath,
    raw
  };
}

function validateClaimFields(
  claim: LoadedClaim,
  repoRoot: string,
  validationConfig: {
    require_source_files: boolean;
    require_verification: boolean;
  },
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

  for (const sourceFile of claim.sourceFiles) {
    if (!fs.existsSync(path.join(repoRoot, sourceFile))) {
      addError(issues, "claim.source_files.missing", `Referenced source file does not exist: ${sourceFile}`, claim.relativePath, claim.id);
    }
  }
}

function validateOneClaimPerFile(
  frontmatterRaw: string,
  body: string,
  relativePath: string,
  validationConfig: {
    reject_multi_claim_documents: boolean;
    max_claim_frontmatter_length: number;
    max_claim_section_length: number;
  },
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

function validateUniqueClaims(claims: LoadedClaim[], issues: ValidationIssue[]): void {
  const byId = new Map<string, LoadedClaim[]>();

  for (const claim of claims) {
    byId.set(claim.id, [...(byId.get(claim.id) ?? []), claim]);
  }

  for (const [id, matchingClaims] of byId.entries()) {
    if (matchingClaims.length > 1) {
      addError(
        issues,
        "claim.id.duplicate",
        `Duplicate claim ID ${id} appears in ${matchingClaims.map((claim) => claim.relativePath).join(", ")}.`,
        matchingClaims[0].relativePath,
        id
      );
    }
  }
}

function loadYamlArtifacts(memoryRoot: string, files: string[], kind: string, issues: ValidationIssue[]): Array<{ path: string; relativePath: string; data: unknown }> {
  const artifacts: Array<{ path: string; relativePath: string; data: unknown }> = [];

  for (const filePath of files) {
    const relativePath = path.relative(memoryRoot, filePath);

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

function validateIndexes(indexes: Array<{ relativePath: string; data: unknown }>, issues: ValidationIssue[]): void {
  for (const index of indexes) {
    if (!isRecord(index.data)) {
      addError(issues, "index.schema", "Index file must be a mapping.", index.relativePath);
      continue;
    }

    validateStringField(index.data, "id", index.relativePath, "index.id", issues);
    validateStringField(index.data, "name", index.relativePath, "index.name", issues);

    for (const field of ["claim_globs", "recipe_globs", "default_queries", "watched_files", "tags"]) {
      if (index.data[field] !== undefined) {
        readStringArray(index.data, field, index.relativePath, issues);
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

function validateUniqueRecipes(recipes: LoadedRecipe[], issues: ValidationIssue[]): void {
  const byId = new Map<string, LoadedRecipe[]>();

  for (const recipe of recipes) {
    byId.set(recipe.id, [...(byId.get(recipe.id) ?? []), recipe]);
  }

  for (const [id, matchingRecipes] of byId.entries()) {
    if (matchingRecipes.length > 1) {
      addError(
        issues,
        "recipe.id.duplicate",
        `Duplicate recipe ID ${id} appears in ${matchingRecipes.map((recipe) => recipe.relativePath).join(", ")}.`,
        matchingRecipes[0].relativePath,
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

function discoverFiles(memoryRoot: string, patterns: string[]): string[] {
  if (!fs.existsSync(memoryRoot)) {
    return [];
  }

  const allFiles = walkFiles(memoryRoot).filter((filePath) => !filePath.endsWith(".gitkeep"));

  return allFiles
    .filter((filePath) => {
      const relativePath = toPosix(path.relative(memoryRoot, filePath));
      return patterns.some((pattern) => globMatches(pattern, relativePath));
    })
    .sort();
}

function walkFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function globMatches(pattern: string, value: string): boolean {
  return globToRegex(toPosix(pattern)).test(value);
}

function globToRegex(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
