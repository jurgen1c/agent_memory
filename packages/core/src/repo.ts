import { execFileSync } from "node:child_process";
import path from "node:path";
import { AgentMemoryError } from "./errors";
import type { RepoInfo } from "./types";

export function findRepoRoot(cwd = process.cwd()): RepoInfo {
  const resolvedCwd = path.resolve(cwd);

  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolvedCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    if (output.length > 0) {
      return {
        root: path.resolve(output),
        detectedBy: "git",
        warnings: []
      };
    }
  } catch {
    // Fall through to the current directory. The warning is surfaced to callers.
  }

  return {
    root: resolvedCwd,
    detectedBy: "cwd",
    warnings: ["Not inside a git repository; using current working directory as repo root."]
  };
}

export function resolveInsideRepo(repoRoot: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return path.normalize(targetPath);
  }

  return path.resolve(repoRoot, targetPath);
}

export function resolveRepoOutputPath(repoRoot: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return path.normalize(targetPath);
  }

  const resolved = path.resolve(repoRoot, targetPath);

  if (!isPathInside(repoRoot, resolved)) {
    throw new AgentMemoryError(`Relative output path escapes repository root: ${targetPath}`, {
      details: ["Use a path inside the repository, or an absolute path when writing outside the repository is intentional."]
    });
  }

  return resolved;
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
