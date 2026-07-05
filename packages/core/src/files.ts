import fs from "node:fs";
import path from "node:path";
import { AgentMemoryError } from "./errors";
import { isPathInside } from "./repo";

export interface CanonicalMemoryFilePatterns {
  claims: string[];
  graphs: string[];
  indexes: string[];
  recipes: string[];
  plans?: string[];
  profiles?: string[];
  waivers: string[];
}

export function discoverFiles(root: string, patterns: string[]): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const allFiles = walkFiles(root).filter((filePath) => !filePath.endsWith(".gitkeep"));

  return allFiles
    .filter((filePath) => {
      const relativePath = toPosix(path.relative(root, filePath));
      return patterns.some((pattern) => globMatches(pattern, relativePath));
    })
    .sort();
}

export function discoverCanonicalMemoryFiles(memoryRoot: string, config: CanonicalMemoryFilePatterns): string[] {
  return [
    ...discoverFiles(memoryRoot, config.claims),
    ...discoverFiles(memoryRoot, config.graphs),
    ...discoverFiles(memoryRoot, config.indexes),
    ...discoverFiles(memoryRoot, config.recipes),
    ...discoverFiles(memoryRoot, config.plans ?? []),
    ...discoverFiles(memoryRoot, config.profiles ?? []),
    ...discoverFiles(memoryRoot, config.waivers)
  ].sort();
}

export function canonicalMemoryFileInventory(memoryRoot: string, config: CanonicalMemoryFilePatterns): string[] {
  return discoverCanonicalMemoryFiles(memoryRoot, config)
    .map((filePath) => toPosix(path.relative(memoryRoot, filePath)))
    .sort();
}

export function pathMatchesPattern(pattern: string, value: string): boolean {
  return globMatches(pattern, toPosix(value));
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function resolveConfiguredPath(repoRoot: string, configuredPath: string): string {
  if (path.isAbsolute(configuredPath)) {
    return path.normalize(configuredPath);
  }

  const resolved = path.resolve(repoRoot, configuredPath);

  if (!isPathInside(repoRoot, resolved)) {
    throw new AgentMemoryError(`Relative configured path escapes repository root: ${configuredPath}`, {
      details: ["Use a path inside the repository, or an absolute path when using memory outside the repository is intentional."]
    });
  }

  const realRepoRoot = safeRealpath(repoRoot);
  const realExistingTarget = safeRealpath(nearestExistingTarget(resolved));

  if (!realRepoRoot || !realExistingTarget || !isPathInside(realRepoRoot, realExistingTarget)) {
    throw new AgentMemoryError(`Relative configured path escapes repository root through a symlink: ${configuredPath}`, {
      details: ["Use a path inside the repository, or an absolute path when using memory outside the repository is intentional."]
    });
  }

  return resolved;
}

export function configuredPathRelativeToRepo(repoRoot: string, configuredPath: string): string {
  return toPosix(path.relative(repoRoot, resolveConfiguredPath(repoRoot, configuredPath)))
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
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

function nearestExistingTarget(targetPath: string): string {
  let candidate = targetPath;

  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);

    if (parent === candidate) {
      return candidate;
    }

    candidate = parent;
  }

  return candidate;
}

function safeRealpath(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
