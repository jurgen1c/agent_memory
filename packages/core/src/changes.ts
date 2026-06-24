import { execFileSync } from "node:child_process";
import path from "node:path";
import { toPosix } from "./files";

export interface GitDiffOptions {
  baseRef?: string;
  includeCommittedFallback?: boolean;
}

export function readGitDiffFiles(repoRoot: string, options: GitDiffOptions = {}): string[] {
  const files = new Set<string>();
  const trackedFiles = new Set<string>();

  if (options.baseRef) {
    addGitFiles(files, repoRoot, ["diff", "--name-only", `${options.baseRef}...HEAD`], trackedFiles);
  }

  addGitFiles(files, repoRoot, ["diff", "--name-only", "HEAD"], trackedFiles);
  addGitFiles(files, repoRoot, ["diff", "--cached", "--name-only"], trackedFiles);
  addGitFiles(files, repoRoot, ["ls-files", "--others", "--exclude-standard"]);

  if (trackedFiles.size === 0 && options.includeCommittedFallback && !options.baseRef) {
    addGitFiles(files, repoRoot, ["diff", "--name-only", "HEAD~1", "HEAD"]);
  }

  return Array.from(files).sort();
}

export function normalizeChangedFiles(files: string[], repoRoot: string): string[] {
  return files
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .map((file) => {
      const normalized = path.normalize(file);
      const relative = path.isAbsolute(normalized) ? path.relative(repoRoot, normalized) : normalized;
      return toPosix(relative).replace(/^(?:\.\/)+/, "");
    })
    .filter((file) => file.length > 0 && file !== ".");
}

function addGitFiles(files: Set<string>, repoRoot: string, args: string[], trackedFiles?: Set<string>): void {
  try {
    const output = execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    for (const line of output.split(/\r?\n/)) {
      const file = line.trim();

      if (file.length > 0) {
        const normalized = toPosix(file);
        files.add(normalized);
        trackedFiles?.add(normalized);
      }
    }
  } catch {
    // Repos without matching refs can still pass explicit --changed-files.
  }
}
