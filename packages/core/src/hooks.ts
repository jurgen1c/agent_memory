import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git";
import { findRepoRoot } from "./repo";
import { commandPrefixForRepo } from "./skills";
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
  commandPrefix?: "agent-memory" | "bin/memory";
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
  const commandPrefix = options.commandPrefix ?? commandPrefixForRepo(repo.root);

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

    writeExecutable(hookPath.absolutePath, hookPath.actionPath, hookTemplate(commandPrefix), Boolean(options.force), actions);
  }

  return { repo, actions, warnings };
}

function resolveGitHookPath(repoRoot: string, hookName: string): { absolutePath: string; actionPath: string } | null {
  try {
    const output = runGit(repoRoot, ["rev-parse", "--git-path", `hooks/${hookName}`]);
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

function hookTemplate(commandPrefix: "agent-memory" | "bin/memory"): string {
  const availabilityCheck = commandPrefix === "bin/memory"
    ? "[ -x bin/memory ]"
    : "command -v agent-memory >/dev/null 2>&1";
  return `#!/usr/bin/env bash

if ${availabilityCheck}; then
  echo "Refreshing agent memory..."
  ${commandPrefix} sync || echo "Warning: agent memory sync failed. Run ${commandPrefix} sync manually."
fi
`;
}
