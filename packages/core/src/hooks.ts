import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./repo";
import type { RepoInfo } from "./types";

export const DEFAULT_HOOKS = ["post-merge", "post-checkout", "post-rewrite"] as const;

export interface HookInstallAction {
  path: string;
  status: "created" | "skipped" | "overwritten";
  detail?: string;
}

export interface HookInstallOptions {
  cwd?: string;
  force?: boolean;
}

export interface HookInstallResult {
  repo: RepoInfo;
  actions: HookInstallAction[];
  warnings: string[];
}

export function installMemoryHooks(options: HookInstallOptions = {}): HookInstallResult {
  const repo = findRepoRoot(options.cwd);
  const actions: HookInstallAction[] = [];
  const warnings = [...repo.warnings];

  if (repo.detectedBy !== "git") {
    warnings.push("Git hooks were requested, but this directory is not inside a Git repository.");
    return { repo, actions, warnings };
  }

  for (const hookName of DEFAULT_HOOKS) {
    const hookPath = resolveGitHookPath(repo.root, hookName);

    if (!hookPath) {
      warnings.push(`Could not resolve git hook path for ${hookName}.`);
      continue;
    }

    writeExecutable(hookPath.absolutePath, hookPath.actionPath, hookTemplate(), Boolean(options.force), actions);
  }

  return { repo, actions, warnings };
}

function resolveGitHookPath(repoRoot: string, hookName: string): { absolutePath: string; actionPath: string } | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--git-path", `hooks/${hookName}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const absolutePath = path.isAbsolute(output) ? path.normalize(output) : path.resolve(repoRoot, output);
    const relativePath = path.relative(repoRoot, absolutePath);

    return {
      absolutePath,
      actionPath: relativePath.length > 0 ? relativePath : absolutePath
    };
  } catch {
    return null;
  }
}

function writeExecutable(absolutePath: string, actionPath: string, content: string, force: boolean, actions: HookInstallAction[]): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existedBefore = fs.existsSync(absolutePath);

  if (existedBefore && !force) {
    actions.push({ path: actionPath, status: "skipped", detail: "already exists" });
    return;
  }

  fs.writeFileSync(absolutePath, content);
  fs.chmodSync(absolutePath, 0o755);
  actions.push({ path: actionPath, status: existedBefore ? "overwritten" : "created" });
}

function hookTemplate(): string {
  return `#!/usr/bin/env bash

if [ -x bin/memory ]; then
  echo "Refreshing agent memory..."
  bin/memory sync || echo "Warning: agent memory sync failed. Run bin/memory sync manually."
fi
`;
}
