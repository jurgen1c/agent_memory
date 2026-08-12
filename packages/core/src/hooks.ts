import fs from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig } from "./config";
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
  commandPrefix: "agent-memory" | "bin/memory";
  actions: HookInstallAction[];
  warnings: string[];
}

export function installMemoryHooks(options: HookInstallOptions = {}): HookInstallResult {
  const repo = findRepoRoot(options.cwd);
  const actions: HookInstallAction[] = [];
  const warnings = [...repo.warnings];
  const commandPrefix = options.commandPrefix ?? commandPrefixForRepo(repo.root);
  const hookConfig = fs.existsSync(path.join(repo.root, "agent-memory.config.yaml"))
    ? loadConfig({ repoRoot: repo.root }).config.git
    : defaultConfig().git;

  if (repo.detectedBy !== "git") {
    warnings.push("Git hooks were requested, but this directory is not inside a Git repository.");
    return { repo, commandPrefix, actions, warnings };
  }

  if (!hookConfig.install_hooks) {
    warnings.push("Git hook installation is disabled by git.install_hooks in agent-memory.config.yaml.");
    return { repo, commandPrefix, actions, warnings };
  }

  for (const hookName of uniqueHookNames(hookConfig.hooks)) {
    if (!isSafeHookName(hookName)) {
      warnings.push(`Skipping invalid configured hook name: ${JSON.stringify(hookName)}.`);
      continue;
    }

    const hookPath = resolveGitHookPath(repo.root, hookName);

    if (!hookPath) {
      warnings.push(`Could not resolve git hook path for ${hookName}.`);
      continue;
    }

    writeExecutable(hookPath.absolutePath, hookPath.actionPath, renderMemoryHook(commandPrefix), Boolean(options.force), actions);
  }

  return { repo, commandPrefix, actions, warnings };
}

function uniqueHookNames(hookNames: string[]): string[] {
  return [...new Set(hookNames)];
}

function isSafeHookName(hookName: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hookName);
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

export function renderMemoryHook(commandPrefix: "agent-memory" | "bin/memory"): string {
  const commandSetup = commandPrefix === "bin/memory"
    ? `MEMORY_COMMAND="\${REPO_ROOT}/bin/memory"

if [ ! -x "\${MEMORY_COMMAND}" ]; then
  printf '%s\\n' "Warning: agent memory sync skipped because \${MEMORY_COMMAND} is not executable." >&2
  exit 0
fi`
    : `if ! command -v agent-memory >/dev/null 2>&1; then
  printf '%s\\n' "Warning: agent memory sync skipped because agent-memory is not available on PATH." >&2
  exit 0
fi

MEMORY_COMMAND="agent-memory"`;

  return `#!/usr/bin/env bash

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf '%s\\n' "Warning: agent memory sync skipped because the repository root could not be resolved." >&2
  exit 0
}

${commandSetup}

echo "Refreshing agent memory..."
(
  cd -- "\${REPO_ROOT}" || exit 1
  "\${MEMORY_COMMAND}" sync
) || printf '%s\\n' "Warning: agent memory sync failed. Run ${commandPrefix} sync manually from \${REPO_ROOT}." >&2

exit 0
`;
}

export function isGeneratedMemoryHook(content: string): boolean {
  const normalized = normalizeGeneratedHook(content);
  return normalized === normalizeGeneratedHook(renderMemoryHook("agent-memory"))
    || normalized === normalizeGeneratedHook(renderMemoryHook("bin/memory"))
    || normalized === normalizeGeneratedHook(renderLegacyMemoryHook("agent-memory"))
    || normalized === normalizeGeneratedHook(renderLegacyMemoryHook("bin/memory"));
}

function renderLegacyMemoryHook(commandPrefix: "agent-memory" | "bin/memory"): string {
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

function normalizeGeneratedHook(content: string): string {
  return content.replaceAll("\r\n", "\n").trimEnd();
}
