import path from "node:path";
import { AgentMemoryError } from "./errors";
import { toPosix } from "./files";
import { GitCommandError, runGit } from "./git";

export interface GitDiffOptions {
  baseRef?: string;
  includeCommittedFallback?: boolean;
  includeRenameSources?: boolean;
  gitBinary?: string;
  timeoutMs?: number;
}

export interface GitDiffSelection {
  files: string[];
  usedCommittedFallback: boolean;
}

export function readGitDiffSelection(repoRoot: string, options: GitDiffOptions = {}): GitDiffSelection {
  const files = new Set<string>();
  const trackedFiles = new Set<string>();
  let usedCommittedFallback = false;
  assertGitWorkTree(repoRoot, options);
  const hasHead = gitHeadExists(repoRoot, options);

  if (options.baseRef) {
    addRequiredGitFiles(
      files,
      repoRoot,
      gitDiffArgs(options, `${options.baseRef}...HEAD`),
      options,
      trackedFiles,
      `Could not read Git diff for base ref ${options.baseRef}.`
    );
  }

  if (hasHead) {
    addRequiredGitFiles(files, repoRoot, gitDiffArgs(options, "HEAD"), options, trackedFiles);
  }

  addRequiredGitFiles(files, repoRoot, gitDiffArgs(options, "--cached"), options, trackedFiles);
  addRequiredGitFiles(files, repoRoot, ["ls-files", "--others", "--exclude-standard"], options);

  if (
    trackedFiles.size === 0 &&
    options.includeCommittedFallback &&
    !options.baseRef &&
    hasHead &&
    gitHeadHasParent(repoRoot, options)
  ) {
    addRequiredGitFiles(files, repoRoot, gitDiffArgs(options, "HEAD~1", "HEAD"), options);
    usedCommittedFallback = true;
  }

  return {
    files: Array.from(files).sort(),
    usedCommittedFallback
  };
}

function gitDiffArgs(options: GitDiffOptions, ...revisions: string[]): string[] {
  return ["diff", ...(options.includeRenameSources ? ["--no-renames"] : []), "--name-only", ...revisions];
}

export function readGitDiffFiles(repoRoot: string, options: GitDiffOptions = {}): string[] {
  return readGitDiffSelection(repoRoot, options).files;
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

function addRequiredGitFiles(
  files: Set<string>,
  repoRoot: string,
  args: string[],
  options: GitDiffOptions,
  trackedFiles?: Set<string>,
  message = "Could not inspect Git changes."
): void {
  try {
    const output = runGit(repoRoot, args, gitCommandOptions(options));

    for (const line of output.split(/\r?\n/)) {
      const file = line.trim();

      if (file.length > 0) {
        const normalized = toPosix(file);
        files.add(normalized);
        trackedFiles?.add(normalized);
      }
    }
  } catch (error) {
    throw new AgentMemoryError(message, {
      details: [formatGitFailure(error)],
      cause: error
    });
  }
}

function assertGitWorkTree(repoRoot: string, options: GitDiffOptions): void {
  try {
    const result = runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], gitCommandOptions(options));

    if (result !== "true") {
      throw new Error("Git did not report a working tree.");
    }
  } catch (error) {
    throw new AgentMemoryError("Could not inspect Git changes.", {
      details: [formatGitFailure(error)],
      cause: error
    });
  }
}

function gitHeadExists(repoRoot: string, options: GitDiffOptions): boolean {
  try {
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], gitCommandOptions(options));
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && !error.timedOut && error.status === 128) {
      return false;
    }

    throw new AgentMemoryError("Could not inspect Git revision HEAD.", {
      details: [formatGitFailure(error)],
      cause: error
    });
  }
}

function gitHeadHasParent(repoRoot: string, options: GitDiffOptions): boolean {
  try {
    const output = runGit(repoRoot, ["rev-list", "--parents", "-n", "1", "HEAD"], gitCommandOptions(options));
    const revisions = output.split(/\s+/).filter((revision) => revision.length > 0);

    if (revisions.length === 0) {
      throw new Error("Git returned no revision for HEAD.");
    }

    return revisions.length > 1;
  } catch (error) {
    throw new AgentMemoryError("Could not inspect Git revision HEAD.", {
      details: [formatGitFailure(error)],
      cause: error
    });
  }
}

function gitCommandOptions(options: GitDiffOptions): { gitBinary?: string; timeoutMs?: number } {
  return {
    gitBinary: options.gitBinary,
    timeoutMs: options.timeoutMs
  };
}

function formatGitFailure(error: unknown): string {
  return error instanceof Error ? error.message : "Git command failed without an error message.";
}
