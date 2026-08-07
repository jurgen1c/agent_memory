import fs from "node:fs";
import path from "node:path";
import {
  isPathInside,
  nearestExistingAncestor,
  PathContainmentError,
  resolveContainedPath
} from "@jurgen1c/agent-core/repository";
import { loadConfig, renderYamlScalar } from "./config";
import { AgentMemoryError } from "./errors";
import { discoverFiles, resolveConfiguredPath, toPosix } from "./files";
import { normalizeRepoRelativePath } from "./repo";
import { slugify } from "./templates";
import { parseYaml } from "./yaml";

export interface NewRecipeOptions {
  cwd?: string;
  system: string;
  title: string;
  id?: string;
  intentTriggers?: string[];
  relevantFiles?: string[];
  requiredClaims?: string[];
  steps?: string[];
  verification?: string[];
  force?: boolean;
}

export interface NewRecipeResult {
  id: string;
  path: string;
  relativePath: string;
  status: "created";
}

export function createRecipe(options: NewRecipeOptions): NewRecipeResult {
  assertNonBlankRepeatedOptions(options);
  const loaded = loadConfig({ cwd: options.cwd });
  const memoryRoot = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  const system = slugify(options.system, "_");
  const titleSlug = slugify(options.title, "-");
  const idSlug = slugify(options.title, "_");
  const existingIds = collectExistingRecipeIds(memoryRoot, loaded.config.recipes);
  const baseId = options.id ?? `recipe.${system}.${idSlug}`;
  const baseSlug = options.id ? slugify(recipeIdTail(options.id, system), "-") : titleSlug;
  const forcedAbsolutePath = recipeBasePath(memoryRoot, system, baseSlug);
  assertRecipeOutputPath(memoryRoot, forcedAbsolutePath);
  const replacingExistingRecipe = Boolean(options.force && fs.existsSync(forcedAbsolutePath));
  const existingTargetId = replacingExistingRecipe ? readRecipeId(forcedAbsolutePath) : null;

  if (options.id && existingTargetId && options.id !== existingTargetId) {
    throw new AgentMemoryError(
      `Refusing to change recipe ID during forced overwrite: ${existingTargetId} would become ${options.id}.`,
      { details: ["Use the existing recipe ID or choose a different title/path for the new recipe."] }
    );
  }

  const id = replacingExistingRecipe
    ? existingTargetId ?? assertAvailableRecipeId(baseId, existingIds)
    : options.id
      ? assertAvailableRecipeId(options.id, existingIds)
      : nextAvailableRecipeId(baseId, existingIds);
  const absolutePath = assertRecipeOutputPath(
    memoryRoot,
    replacingExistingRecipe ? forcedAbsolutePath : nextAvailableRecipePath(memoryRoot, system, baseSlug)
  );
  const displayPath = displayRecipePath(loaded.repo.root, absolutePath);
  const relevantFiles = (options.relevantFiles ?? []).map((filePath) =>
    normalizeRepoRelativePath(loaded.repo.root, filePath)
  );

  if (fs.existsSync(absolutePath) && !options.force) {
    throw new AgentMemoryError(`Refusing to overwrite existing recipe file: ${absolutePath}`);
  }

  const content = renderRecipe({
    id,
    system,
    title: options.title,
    intentTriggers: nonEmpty(options.intentTriggers, "TODO: Describe when this recipe should be used."),
    relevantFiles,
    requiredClaims: options.requiredClaims ?? [],
    steps: nonEmpty(options.steps, "TODO: Add the first repository-specific step."),
    verification: nonEmpty(options.verification, "TODO: Add a concrete verification command.")
  });

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);

  return {
    id,
    path: absolutePath,
    relativePath: displayPath,
    status: "created"
  };
}

function renderRecipe(options: {
  id: string;
  system: string;
  title: string;
  intentTriggers: string[];
  relevantFiles: string[];
  requiredClaims: string[];
  steps: string[];
  verification: string[];
}): string {
  return `id: ${renderYamlScalar(options.id)}
title: ${renderYamlScalar(options.title)}
system: ${renderYamlScalar(options.system)}
status: needs_review

${renderListField("intent_triggers", options.intentTriggers)}

${renderListField("required_claims", options.requiredClaims)}

optional_claims: []
related_systems: []

${renderListField("relevant_files", options.relevantFiles)}

tags:
  - ${renderYamlScalar(options.system)}

${renderListField("steps", options.steps)}

${renderListField("verification", options.verification)}

memory_updates:
  - Review related claims, graphs, and indexes when this workflow changes durable repository knowledge.
`;
}

function renderListField(field: string, values: string[]): string {
  if (values.length === 0) {
    return `${field}: []`;
  }

  return `${field}:\n${values.map((value) => `  - ${renderYamlScalar(value)}`).join("\n")}`;
}

function nonEmpty(values: string[] | undefined, fallback: string): string[] {
  return values && values.length > 0 ? values : [fallback];
}

function assertNonBlankRepeatedOptions(options: NewRecipeOptions): void {
  const repeatedOptions = [
    ["--trigger", options.intentTriggers],
    ["--source-file", options.relevantFiles],
    ["--required-claim", options.requiredClaims],
    ["--step", options.steps],
    ["--verification-step", options.verification]
  ] as const;

  for (const [option, values] of repeatedOptions) {
    if (values?.some((value) => value.trim().length === 0)) {
      throw new AgentMemoryError(`${option} requires a non-blank value.`);
    }
  }
}

function collectExistingRecipeIds(memoryRoot: string, patterns: string[]): Set<string> {
  const ids = new Set<string>();

  for (const filePath of discoverFiles(memoryRoot, patterns)) {
    try {
      const data = parseYaml(fs.readFileSync(filePath, "utf8"));

      if (typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.id === "string") {
        ids.add(data.id);
      }
    } catch {
      // Existing validation reports malformed recipe files.
    }
  }

  return ids;
}

function readRecipeId(filePath: string): string | null {
  try {
    const data = parseYaml(fs.readFileSync(filePath, "utf8"));
    return typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.id === "string" ? data.id : null;
  } catch {
    return null;
  }
}

function assertAvailableRecipeId(id: string, existingIds: Set<string>): string {
  if (existingIds.has(id)) {
    throw new AgentMemoryError(`Recipe ID already exists: ${id}`);
  }

  return id;
}

function nextAvailableRecipeId(baseId: string, existingIds: Set<string>): string {
  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let counter = 2;
  while (existingIds.has(`${baseId}_${counter}`)) counter += 1;
  return `${baseId}_${counter}`;
}

function nextAvailableRecipePath(memoryRoot: string, system: string, baseSlug: string): string {
  const basePath = recipeBasePath(memoryRoot, system, baseSlug);

  if (!fs.existsSync(basePath)) {
    return basePath;
  }

  let counter = 2;
  while (fs.existsSync(path.join(memoryRoot, "recipes", system, `${baseSlug}-${counter}.yaml`))) counter += 1;
  return path.join(memoryRoot, "recipes", system, `${baseSlug}-${counter}.yaml`);
}

function recipeBasePath(memoryRoot: string, system: string, baseSlug: string): string {
  return path.join(memoryRoot, "recipes", system, `${baseSlug}.yaml`);
}

function assertRecipeOutputPath(memoryRoot: string, targetPath: string): string {
  const resolvedMemoryRoot = path.resolve(memoryRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  const containmentRoot = nearestExistingAncestor(resolvedMemoryRoot);

  if (!isPathInside(resolvedMemoryRoot, resolvedTargetPath) || containmentRoot === null) {
    throw new AgentMemoryError("Recipe output path must stay inside the configured memory root.");
  }

  try {
    return resolveContainedPath(containmentRoot, resolvedTargetPath, { rejectFinalSymlink: true }).absolutePath;
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new AgentMemoryError("Recipe output path must stay inside the configured memory root.", {
      details: ["Remove output-path symlinks that leave the memory root and try again."],
      cause: error
    });
  }
}

function displayRecipePath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  const displayPath = relativePath.startsWith("..") || path.isAbsolute(relativePath) ? absolutePath : relativePath;
  return toPosix(displayPath);
}

function recipeIdTail(id: string, system: string): string {
  const prefix = `recipe.${system}.`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id.replace(/^recipe\./, "");
}
