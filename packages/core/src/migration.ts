import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { toPosix } from "./files";
import { isPathInside, resolveRepoOutputPath } from "./repo";
import { parseYaml } from "./yaml";

export type MigrationMode = "plan" | "automatic";
export type MigrationConfidence = "high" | "medium" | "low";

export interface MigrateDocsOptions {
  cwd?: string;
  fromPath: string;
  system: string;
  mode?: MigrationMode;
  force?: boolean;
}

export interface MigratedDocPlan {
  sourcePath: string;
  title: string;
  suggestedId: string;
  targetPath: string;
  status: "planned" | "created" | "skipped" | "overwritten";
  detail?: string;
}

export interface MigrateDocsResult {
  mode: MigrationMode;
  repoRoot: string;
  memoryRoot: string;
  sourceRoot: string;
  system?: string;
  systemMapPath?: string;
  docs: MigratedDocPlan[];
  warnings: string[];
}

export interface ClassifiedDocMapping {
  source: string;
  system: string;
  title: string;
  confidence: MigrationConfidence;
  reason: string;
}

export interface DocsSystemMap {
  version: 1;
  source_root: string;
  mappings: ClassifiedDocMapping[];
}

export interface ClassifyDocsOptions {
  cwd?: string;
  fromPath: string;
  outputPath?: string;
  force?: boolean;
}

export interface ClassifyDocsResult {
  repoRoot: string;
  memoryRoot: string;
  sourceRoot: string;
  systemMapPath: string;
  status: "created" | "skipped" | "overwritten";
  mappings: ClassifiedDocMapping[];
  warnings: string[];
}

export interface MigrateDocsSystemMapOptions {
  cwd?: string;
  systemMapPath: string;
  mode?: MigrationMode;
  force?: boolean;
}

const MIGRATABLE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
const DEFAULT_SYSTEM = "docs";
const GENERIC_PATH_TOKENS = new Set([
  "architecture",
  "canonical",
  "concept",
  "concepts",
  "doc",
  "docs",
  "documentation",
  "guide",
  "guides",
  "index",
  "legacy",
  "manual",
  "notes",
  "overview",
  "readme",
  "reference",
  "references",
  "spec",
  "specs"
]);
const KNOWN_SYSTEM_ALIASES = new Map<string, string>([
  ["account", "accounts"],
  ["accounts", "accounts"],
  ["auth", "auth"],
  ["authentication", "auth"],
  ["authorization", "auth"],
  ["billing", "billing"],
  ["cache", "cache"],
  ["ci", "ci"],
  ["docs", "docs"],
  ["documentation", "docs"],
  ["infra", "infra"],
  ["infrastructure", "infra"],
  ["oauth", "auth"],
  ["payments", "billing"],
  ["platform", "platform"],
  ["search", "search"],
  ["security", "security"],
  ["tenancy", "tenancy"],
  ["tenant", "tenancy"],
  ["tenants", "tenancy"],
  ["ui", "ui"]
]);

export function migrateDocs(options: MigrateDocsOptions): MigrateDocsResult {
  if (!options.fromPath) {
    throw new AgentMemoryError("migrate-docs requires --from.");
  }

  if (!options.system) {
    throw missingMigrationSystemError(options.fromPath);
  }

  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memoryRoot = path.join(repoRoot, loaded.config.memory_root);
  const sourceRoot = resolveSourceRoot(repoRoot, options.fromPath);
  const system = normalizeMigrationSystem(options.system);
  const mode = options.mode ?? "plan";

  if (!fs.existsSync(sourceRoot)) {
    throw new AgentMemoryError(`Migration source does not exist: ${sourceRoot}`);
  }

  if (mode === "automatic" && !isPathInside(repoRoot, sourceRoot)) {
    throw new AgentMemoryError("Automatic migration requires --from to point inside the repository.", {
      details: ["Use plan mode for external docs, then copy source docs into the repo before automatic migration."]
    });
  }

  const docs = planDocs(repoRoot, memoryRoot, system, discoverMigratableDocs(sourceRoot));

  if (mode === "automatic") {
    for (const doc of docs) {
      writeDraftClaim(repoRoot, memoryRoot, doc, Boolean(options.force));
    }
  }

  return {
    mode,
    repoRoot,
    memoryRoot: toPosix(path.relative(repoRoot, memoryRoot)),
    sourceRoot: displayPath(repoRoot, sourceRoot),
    system,
    docs,
    warnings: docs.length === 0 ? [`No migratable docs found under ${displayPath(repoRoot, sourceRoot)}.`] : []
  };
}

export function classifyDocs(options: ClassifyDocsOptions): ClassifyDocsResult {
  if (!options.fromPath) {
    throw new AgentMemoryError("migrate-docs requires --from.");
  }

  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memoryRoot = path.join(repoRoot, loaded.config.memory_root);
  const sourceRoot = resolveSourceRoot(repoRoot, options.fromPath);

  if (!fs.existsSync(sourceRoot)) {
    throw new AgentMemoryError(`Migration source does not exist: ${sourceRoot}`);
  }

  const docs = discoverMigratableDocs(sourceRoot);
  const existingSystems = discoverExistingSystems(memoryRoot);
  const mappings = docs.map((docPath) => classifyOneDoc(repoRoot, sourceRoot, docPath, existingSystems));
  const defaultOutputPath = path.join(".agent-memory", "migrations", `${sourceSlugForMap(displayPath(repoRoot, sourceRoot))}.yaml`);
  const outputPath = options.outputPath ?? defaultOutputPath;
  const absoluteOutputPath = resolveRepoOutputPath(repoRoot, outputPath);
  const systemMapPath = displayPath(repoRoot, absoluteOutputPath);
  const existedBefore = fs.existsSync(absoluteOutputPath);
  const warnings = docs.length === 0 ? [`No migratable docs found under ${displayPath(repoRoot, sourceRoot)}.`] : [];

  if (existedBefore && !options.force) {
    warnings.push(`System map already exists; leaving reviewed map unchanged: ${systemMapPath}`);
  } else {
    fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    fs.writeFileSync(
      absoluteOutputPath,
      renderSystemMap({
        version: 1,
        source_root: displayPath(repoRoot, sourceRoot),
        mappings
      })
    );
  }

  return {
    repoRoot,
    memoryRoot: toPosix(path.relative(repoRoot, memoryRoot)),
    sourceRoot: displayPath(repoRoot, sourceRoot),
    systemMapPath,
    status: existedBefore ? (options.force ? "overwritten" : "skipped") : "created",
    mappings,
    warnings
  };
}

export function migrateDocsFromSystemMap(options: MigrateDocsSystemMapOptions): MigrateDocsResult {
  if (!options.systemMapPath) {
    throw new AgentMemoryError("migrate-docs requires --system-map <file>.");
  }

  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const memoryRoot = path.join(repoRoot, loaded.config.memory_root);
  const absoluteMapPath = resolveSourceRoot(repoRoot, options.systemMapPath);
  const mode = options.mode ?? "plan";

  if (!fs.existsSync(absoluteMapPath)) {
    throw new AgentMemoryError(`Migration system map does not exist: ${absoluteMapPath}`);
  }

  const systemMap = readSystemMap(repoRoot, absoluteMapPath);
  const sourceRoot = resolveSourceRoot(repoRoot, systemMap.source_root);

  if (mode === "automatic") {
    for (const mapping of systemMap.mappings) {
      const absoluteSource = resolveSourceRoot(repoRoot, mapping.source);
      if (!isPathInside(repoRoot, absoluteSource)) {
        throw new AgentMemoryError("Automatic migration requires system-map sources to point inside the repository.", {
          details: [`Move or copy external source before migrating automatically: ${mapping.source}`]
        });
      }
    }
  }

  const docs = planDocsFromMappings(repoRoot, memoryRoot, systemMap.mappings);

  if (mode === "automatic") {
    for (const doc of docs) {
      writeDraftClaim(repoRoot, memoryRoot, doc, Boolean(options.force));
    }
  }

  return {
    mode,
    repoRoot,
    memoryRoot: toPosix(path.relative(repoRoot, memoryRoot)),
    sourceRoot: displayPath(repoRoot, sourceRoot),
    systemMapPath: displayPath(repoRoot, absoluteMapPath),
    docs,
    warnings: docs.length === 0 ? [`No migratable docs found in ${displayPath(repoRoot, absoluteMapPath)}.`] : []
  };
}

export function missingMigrationSystemError(fromPath?: string): AgentMemoryError {
  const exampleFrom = fromPath || "docs/legacy";

  return new AgentMemoryError("migrate-docs requires --system <system>.", {
    details: [
      "A system is the lowercase memory namespace or subsystem assigned to generated claims, such as auth, billing, docs, platform, or search.",
      "It is used in claim IDs and paths, for example docs.migrated_canonical and docs/agent-memory/claims/docs/.",
      `Example: agent-memory migrate-docs --from ${exampleFrom} --system docs --automatic`,
      "If the source docs cover multiple subsystems, run migrate-docs separately for each source folder with the matching --system value."
    ]
  });
}

function resolveSourceRoot(repoRoot: string, fromPath: string): string {
  return path.isAbsolute(fromPath) ? path.normalize(fromPath) : path.resolve(repoRoot, fromPath);
}

function discoverMigratableDocs(sourceRoot: string): string[] {
  const stat = fs.statSync(sourceRoot);

  if (stat.isFile()) {
    return MIGRATABLE_EXTENSIONS.has(path.extname(sourceRoot).toLowerCase()) ? [sourceRoot] : [];
  }

  if (!stat.isDirectory()) {
    return [];
  }

  return walkFiles(sourceRoot)
    .filter((filePath) => MIGRATABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort();
}

function planDocs(repoRoot: string, memoryRoot: string, system: string, docPaths: string[]): MigratedDocPlan[] {
  const allocatedIds = new Set<string>();
  const allocatedPaths = new Set<string>();

  return docPaths.map((docPath) => planOneDoc(repoRoot, memoryRoot, system, docPath, allocatedIds, allocatedPaths));
}

function planDocsFromMappings(repoRoot: string, memoryRoot: string, mappings: ClassifiedDocMapping[]): MigratedDocPlan[] {
  const allocations = new Map<string, { ids: Set<string>; paths: Set<string> }>();

  return mappings.map((mapping) => {
    const absoluteSource = resolveSourceRoot(repoRoot, mapping.source);

    if (!fs.existsSync(absoluteSource)) {
      throw new AgentMemoryError(`Migration source does not exist: ${absoluteSource}`);
    }

    if (!MIGRATABLE_EXTENSIONS.has(path.extname(absoluteSource).toLowerCase())) {
      throw new AgentMemoryError(`System-map source is not a migratable doc: ${mapping.source}`);
    }

    const system = normalizeMigrationSystem(mapping.system);
    const allocation = allocations.get(system) ?? { ids: new Set<string>(), paths: new Set<string>() };
    allocations.set(system, allocation);
    return planOneDoc(repoRoot, memoryRoot, system, absoluteSource, allocation.ids, allocation.paths, mapping.title);
  });
}

function planOneDoc(
  repoRoot: string,
  memoryRoot: string,
  system: string,
  docPath: string,
  allocatedIds: Set<string>,
  allocatedPaths: Set<string>,
  mappedTitle?: string
): MigratedDocPlan {
  const sourcePath = displayPath(repoRoot, docPath);
  const content = fs.readFileSync(docPath, "utf8");
  const title = mappedTitle?.trim() || extractTitle(content, docPath);
  const slug = slugify(title || path.basename(docPath, path.extname(docPath)));
  const migrationSlug = uniqueMigrationSlug(system, slug, allocatedIds, allocatedPaths);
  const suggestedId = `${system}.${migrationSlug}`;
  const targetPath = targetPathForDraft(repoRoot, memoryRoot, system, migrationSlug);

  return {
    sourcePath,
    title,
    suggestedId,
    targetPath,
    status: "planned"
  };
}

function writeDraftClaim(repoRoot: string, memoryRoot: string, doc: MigratedDocPlan, force: boolean): void {
  const absoluteTarget = path.resolve(repoRoot, doc.targetPath);
  assertInsideMemoryRoot(memoryRoot, absoluteTarget);
  const existedBefore = fs.existsSync(absoluteTarget);

  if (existedBefore && !force) {
    doc.status = "skipped";
    doc.detail = "already exists";
    return;
  }

  fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
  fs.writeFileSync(absoluteTarget, draftClaimTemplate(doc));
  doc.status = existedBefore ? "overwritten" : "created";
}

function uniqueMigrationSlug(system: string, sourceSlug: string, allocatedIds: Set<string>, allocatedPaths: Set<string>): string {
  let counter = 1;

  while (true) {
    const migrationSlug = counter === 1 ? `migrated_${sourceSlug}` : `migrated_${sourceSlug}_${counter}`;
    const suggestedId = `${system}.${migrationSlug}`;
    const targetName = `${migrationSlug}.md`;

    if (!allocatedIds.has(suggestedId) && !allocatedPaths.has(targetName)) {
      allocatedIds.add(suggestedId);
      allocatedPaths.add(targetName);
      return migrationSlug;
    }

    counter += 1;
  }
}

function targetPathForDraft(repoRoot: string, memoryRoot: string, system: string, migrationSlug: string): string {
  const absoluteTarget = path.resolve(memoryRoot, "claims", system, `${migrationSlug}.md`);
  assertInsideMemoryRoot(memoryRoot, absoluteTarget);
  return toPosix(path.relative(repoRoot, absoluteTarget));
}

function normalizeMigrationSystem(system: string): string {
  const normalized = system.trim();

  if (!/^[a-z0-9][a-z0-9_]*$/.test(normalized)) {
    throw new AgentMemoryError(`Invalid migration system: ${system}`, {
      details: ["Use lowercase letters, numbers, and underscores only, with no path separators or dot segments."]
    });
  }

  return normalized;
}

function discoverExistingSystems(memoryRoot: string): string[] {
  const systems = new Set<string>();

  for (const childPath of [
    path.join(memoryRoot, "claims"),
    path.join(memoryRoot, "graph"),
    path.join(memoryRoot, "indexes"),
    path.join(memoryRoot, "recipes")
  ]) {
    if (!fs.existsSync(childPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(childPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const rawName = entry.isFile() ? path.basename(entry.name, path.extname(entry.name)) : entry.name;
      const normalized = normalizeSystemCandidate(rawName);

      if (normalized) {
        systems.add(normalized);
      }
    }
  }

  return [...systems].sort();
}

function classifyOneDoc(
  repoRoot: string,
  sourceRoot: string,
  docPath: string,
  existingSystems: string[]
): ClassifiedDocMapping {
  const source = displayPath(repoRoot, docPath);
  const content = fs.readFileSync(docPath, "utf8");
  const title = extractTitle(content, docPath);
  const relativeToSource = toPosix(path.relative(sourceRoot, docPath));
  const pathTokens = tokenizePath(relativeToSource);
  const titleTokens = tokenizeText(title);
  const existing = new Set(existingSystems);
  const pathExistingMatch = pathTokens.find((token) => existing.has(token));

  if (pathExistingMatch) {
    return {
      source,
      system: pathExistingMatch,
      title,
      confidence: "high",
      reason: `Path matched existing ${pathExistingMatch} system`
    };
  }

  const pathAlias = pathTokens.map((token) => KNOWN_SYSTEM_ALIASES.get(token) ?? token).find((token) => isSystemCandidate(token));

  if (pathAlias) {
    return {
      source,
      system: pathAlias,
      title,
      confidence: "medium",
      reason: "Source path suggested system"
    };
  }

  const titleExistingMatch = titleTokens.find((token) => existing.has(token));

  if (titleExistingMatch) {
    return {
      source,
      system: titleExistingMatch,
      title,
      confidence: "medium",
      reason: `Title matched existing ${titleExistingMatch} system`
    };
  }

  const titleAlias = titleTokens.map((token) => KNOWN_SYSTEM_ALIASES.get(token)).find((token) => isSystemCandidate(token));

  if (titleAlias) {
    return {
      source,
      system: titleAlias,
      title,
      confidence: "medium",
      reason: "Title suggested system"
    };
  }

  return {
    source,
    system: DEFAULT_SYSTEM,
    title,
    confidence: "low",
    reason: "No subsystem match; defaulted to docs"
  };
}

function tokenizePath(value: string): string[] {
  const pathParts = value.split(/[\\/]+/);
  const directoryParts = pathParts.length > 1 ? pathParts.slice(0, -1) : [];
  const parts = directoryParts.flatMap((part) => tokenizeText(path.basename(part, path.extname(part))));
  return unique(parts.filter((part) => !GENERIC_PATH_TOKENS.has(part)));
}

function tokenizeText(value: string): string[] {
  return unique(value.split(/[^A-Za-z0-9]+/).map(normalizeSystemCandidate).filter((token): token is string => Boolean(token)));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSystemCandidate(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return isSystemCandidate(normalized) ? normalized : null;
}

function isSystemCandidate(value: string | undefined): value is string {
  return Boolean(value && /^[a-z0-9][a-z0-9_]*$/.test(value));
}

function readSystemMap(repoRoot: string, absoluteMapPath: string): DocsSystemMap {
  const parsed = parseYaml(fs.readFileSync(absoluteMapPath, "utf8"));

  if (!isRecord(parsed)) {
    throw new AgentMemoryError("Migration system map must be a YAML mapping.");
  }

  if (parsed.version !== 1) {
    throw new AgentMemoryError("Migration system map version must be 1.");
  }

  if (typeof parsed.source_root !== "string") {
    throw new AgentMemoryError("Migration system map requires source_root.");
  }

  if (!Array.isArray(parsed.mappings)) {
    throw new AgentMemoryError("Migration system map requires mappings.");
  }

  return {
    version: 1,
    source_root: parsed.source_root,
    mappings: parsed.mappings.map((mapping, index) => readSystemMapMapping(repoRoot, mapping, index))
  };
}

function readSystemMapMapping(repoRoot: string, value: unknown, index: number): ClassifiedDocMapping {
  if (!isRecord(value)) {
    throw new AgentMemoryError(`Invalid system-map mapping at index ${index}.`);
  }

  if (typeof value.source !== "string" || value.source.trim().length === 0) {
    throw new AgentMemoryError(`System-map mapping ${index} requires source.`);
  }

  if (typeof value.system !== "string" || value.system.trim().length === 0) {
    throw new AgentMemoryError(`System-map mapping ${index} requires system.`);
  }

  const absoluteSource = resolveSourceRoot(repoRoot, value.source);
  const title = typeof value.title === "string" && value.title.trim().length > 0
    ? value.title.trim()
    : fs.existsSync(absoluteSource)
      ? extractTitle(fs.readFileSync(absoluteSource, "utf8"), absoluteSource)
      : titleize(path.basename(value.source, path.extname(value.source)));
  const confidence = readConfidence(value.confidence);

  return {
    source: displayPath(repoRoot, absoluteSource),
    system: normalizeMigrationSystem(value.system),
    title,
    confidence,
    reason: typeof value.reason === "string" && value.reason.trim().length > 0 ? value.reason.trim() : "Reviewed system-map entry"
  };
}

function readConfidence(value: unknown): MigrationConfidence {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "medium";
}

function renderSystemMap(systemMap: DocsSystemMap): string {
  const lines = [
    "version: 1",
    `source_root: ${yamlScalar(systemMap.source_root)}`,
    "mappings:"
  ];

  for (const mapping of systemMap.mappings) {
    lines.push(
      `  - source: ${yamlScalar(mapping.source)}`,
      `    system: ${yamlScalar(mapping.system)}`,
      `    title: ${yamlScalar(mapping.title)}`,
      `    confidence: ${mapping.confidence}`,
      `    reason: ${yamlScalar(mapping.reason)}`
    );
  }

  return `${lines.join("\n")}\n`;
}

function sourceSlugForMap(sourceRoot: string): string {
  return slugify(sourceRoot).replace(/_/g, "-") || "docs";
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInsideMemoryRoot(memoryRoot: string, absoluteTarget: string): void {
  const relativePath = path.relative(path.resolve(memoryRoot), path.resolve(absoluteTarget));

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AgentMemoryError("Migration target must stay inside the configured memory root.");
  }
}

function draftClaimTemplate(doc: MigratedDocPlan): string {
  return `---
id: ${doc.suggestedId}
type: fact
system: ${systemSafeFromId(doc.suggestedId)}
status: current
confidence: low
severity: normal

title: ${doc.title}

claim: >
  Legacy documentation at ${doc.sourcePath} describes ${doc.title}. Review the source and split this draft into precise atomic claims before marking it current.

source_files:
  - ${doc.sourcePath}

related_files: []
symbols: []
routes: []
tags:
  - ${systemSafeFromId(doc.suggestedId)}
  - migration

verification:
  - Review migrated claim against ${doc.sourcePath}

last_verified_commit: null
---

# ${doc.title}

## Claim

Legacy documentation at \`${doc.sourcePath}\` describes ${doc.title}. Review the source and split this draft into precise atomic claims before marking it current.

## Migration Notes

- Source document: \`${doc.sourcePath}\`
- Migration status: current
- Confidence: low

## Verification

- Review migrated claim against \`${doc.sourcePath}\`
`;
}

function extractTitle(content: string, docPath: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();

  if (heading) {
    return heading;
  }

  return titleize(path.basename(docPath, path.extname(docPath)));
}

function systemSafeFromId(id: string): string {
  return id.split(".")[0] || "general";
}

function titleize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug || "doc";
}

function displayPath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.startsWith("..") || path.isAbsolute(relativePath) ? absolutePath : toPosix(relativePath);
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
