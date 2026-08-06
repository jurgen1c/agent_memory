import path from "node:path";
import {
  findGitRepositoryRoot,
  isPathInside,
  PathContainmentError,
  resolveContainedPath
} from "@jurgen1c/agent-core/repository";
import { AgentMemoryError } from "./errors";
import type { RepoInfo } from "./types";

export function findRepoRoot(cwd = process.cwd()): RepoInfo {
  const resolvedCwd = path.resolve(cwd);
  const root = findGitRepositoryRoot(resolvedCwd);

  if (root !== null) {
    return {
      root,
      detectedBy: "git",
      warnings: []
    };
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

  try {
    return resolveContainedPath(repoRoot, targetPath).absolutePath;
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    const throughSymlink = error.reason === "symlink_escape";
    throw new AgentMemoryError(
      throughSymlink
        ? `Relative output path escapes repository root through a symlink: ${targetPath}`
        : `Relative output path escapes repository root: ${targetPath}`,
      {
        details: ["Use a path inside the repository, or an absolute path when writing outside the repository is intentional."],
        cause: error
      }
    );
  }
}

export function normalizeRepoRelativePath(repoRoot: string, targetPath: string): string {
  const portablePath = targetPath.replaceAll("\\", "/");

  if (path.posix.isAbsolute(portablePath) || path.win32.isAbsolute(targetPath)) {
    throw new AgentMemoryError(`Path must be repository-relative: ${targetPath}`, {
      details: ["Choose a path inside the repository."]
    });
  }

  try {
    const absolutePath = resolveContainedPath(repoRoot, portablePath, { rejectFinalSymlink: true }).absolutePath;
    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");

    if (relativePath.length === 0) {
      throw new AgentMemoryError(`Path must name a file inside the repository: ${targetPath}`);
    }

    return relativePath;
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    const throughSymlink = error.reason === "symlink_escape" || error.reason === "final_symlink";
    throw new AgentMemoryError(
      throughSymlink
        ? `Path escapes repository root through a symlink: ${targetPath}`
        : `Path escapes repository root: ${targetPath}`,
      {
        details: ["Choose a repository-relative path that stays inside the repository."],
        cause: error
      }
    );
  }
}

export { isPathInside };
