import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { toPosix } from "./files";

export type MigrationMode = "plan" | "automatic";

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
  system: string;
  docs: MigratedDocPlan[];
  warnings: string[];
}

const MIGRATABLE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);

export function migrateDocs(options: MigrateDocsOptions): MigrateDocsResult {
  if (!options.fromPath) {
    throw new AgentMemoryError("migrate-docs requires --from.");
  }

  if (!options.system) {
    throw new AgentMemoryError("migrate-docs requires --system.");
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

  if (mode === "automatic" && path.relative(repoRoot, sourceRoot).startsWith("..")) {
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

function planOneDoc(
  repoRoot: string,
  memoryRoot: string,
  system: string,
  docPath: string,
  allocatedIds: Set<string>,
  allocatedPaths: Set<string>
): MigratedDocPlan {
  const sourcePath = displayPath(repoRoot, docPath);
  const content = fs.readFileSync(docPath, "utf8");
  const title = extractTitle(content, docPath);
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
