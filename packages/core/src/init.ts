import fs from "node:fs";
import path from "node:path";
import { defaultConfig, renderConfigTemplate } from "./config";
import { AgentMemoryError } from "./errors";
import { installMemoryHooks } from "./hooks";
import { findRepoRoot, resolveRepoOutputPath } from "./repo";
import { parseAgentTarget, renderAgentSkill, skillPathForLocation, writeCodexSkillReferences, type AgentTarget } from "./skills";
import type { RepoInfo } from "./types";

export type PackageManager = "npm" | "bun";

export interface InitOptions {
  cwd?: string;
  yes: boolean;
  force: boolean;
  packageManager: PackageManager;
  agents: AgentTarget[];
  installHooks: boolean;
  skillLocation?: string;
}

export interface InitAction {
  path: string;
  status: "created" | "skipped" | "updated" | "overwritten";
  detail?: string;
}

export interface InitResult {
  repo: RepoInfo;
  actions: InitAction[];
  warnings: string[];
}

export function initRepository(options: InitOptions): InitResult {
  const repo = findRepoRoot(options.cwd);
  const actions: InitAction[] = [];
  const warnings = [...repo.warnings];
  const agents = options.agents.length > 0 ? options.agents : (["codex", "generic"] satisfies AgentTarget[]);
  const config = defaultConfig();

  if (options.skillLocation && agents.length !== 1) {
    throw new AgentMemoryError("skillLocation requires exactly one agent target.");
  }

  if (options.agents.length > 0) {
    for (const agent of ["codex", "generic"] satisfies AgentTarget[]) {
      config.agent_skills[agent].enabled = agents.includes(agent);
    }
  }

  if (options.skillLocation) {
    for (const agent of agents) {
      config.agent_skills[agent].path = skillPathForLocation(agent, options.skillLocation);
      resolveRepoOutputPath(repo.root, config.agent_skills[agent].path);
    }
  }

  writeFile(repo.root, "agent-memory.config.yaml", renderConfigTemplate(config), options.force, actions);
  writeFile(repo.root, "docs/agent-memory/README.md", memoryReadmeTemplate(), options.force, actions);
  ensureAgentsMemorySection(repo.root, actions);

  for (const gitkeepPath of [
    "docs/agent-memory/claims/.gitkeep",
    "docs/agent-memory/graph/.gitkeep",
    "docs/agent-memory/indexes/.gitkeep",
    "docs/agent-memory/recipes/.gitkeep",
    "docs/agent-memory/waivers/.gitkeep"
  ]) {
    writeFile(repo.root, gitkeepPath, "", options.force, actions);
  }

  writeExecutable(repo.root, "bin/memory", wrapperTemplate(options.packageManager), options.force, actions);
  ensureGitignoreEntry(repo.root, ".agent-memory/", actions);

  if (agents.includes("codex")) {
    const skillAction = writeFile(
      repo.root,
      config.agent_skills.codex.path,
      renderAgentSkill({ agent: "codex", config, commandPrefix: "bin/memory" }),
      options.force,
      actions
    );
    if (skillAction.status !== "skipped") {
      writeCodexSkillReferences(repo.root, resolveOutputPath(repo.root, config.agent_skills.codex.path), "repo", options.force, actions);
    }
  }

  if (agents.includes("generic")) {
    writeFile(
      repo.root,
      config.agent_skills.generic.path,
      renderAgentSkill({ agent: "generic", config, commandPrefix: "bin/memory" }),
      options.force,
      actions
    );
  }

  if (options.installHooks) {
    const hookResult = installMemoryHooks({ cwd: repo.root, force: options.force });
    actions.push(...hookResult.actions);
    warnings.push(...hookResult.warnings.filter((warning) => !warnings.includes(warning)));
  }

  return {
    repo,
    actions,
    warnings
  };
}

function writeFile(repoRoot: string, relativePath: string, content: string, force: boolean, actions: InitAction[]): InitAction {
  const absolutePath = resolveOutputPath(repoRoot, relativePath);
  const displayPath = displayOutputPath(repoRoot, absolutePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existedBefore = fs.existsSync(absolutePath);

  if (existedBefore && !force) {
    const action: InitAction = { path: displayPath, status: "skipped", detail: "already exists" };
    actions.push(action);
    return action;
  }

  fs.writeFileSync(absolutePath, content);
  const action: InitAction = { path: displayPath, status: existedBefore && force ? "overwritten" : "created" };
  actions.push(action);
  return action;
}

function writeExecutable(repoRoot: string, relativePath: string, content: string, force: boolean, actions: InitAction[]): void {
  writeFile(repoRoot, relativePath, content, force, actions);
  const absolutePath = resolveOutputPath(repoRoot, relativePath);

  if (fs.existsSync(absolutePath)) {
    fs.chmodSync(absolutePath, 0o755);
  }
}

function resolveOutputPath(repoRoot: string, targetPath: string): string {
  return resolveRepoOutputPath(repoRoot, targetPath);
}

function displayOutputPath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.startsWith("..") || path.isAbsolute(relativePath) ? absolutePath : relativePath;
}

function ensureGitignoreEntry(repoRoot: string, entry: string, actions: InitAction[]): void {
  const relativePath = ".gitignore";
  const absolutePath = path.join(repoRoot, relativePath);
  const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());

  if (lines.includes(entry)) {
    actions.push({ path: relativePath, status: "skipped", detail: `${entry} already ignored` });
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const prefix = existing.length > 0 && !existing.endsWith("\n\n") ? "" : "";
  fs.writeFileSync(absolutePath, `${existing}${separator}${prefix}${entry}\n`);
  actions.push({ path: relativePath, status: existing.length > 0 ? "updated" : "created", detail: `added ${entry}` });
}

export function ensureAgentsMemorySection(repoRoot: string, actions: InitAction[]): void {
  const relativePath = "AGENTS.md";
  const absolutePath = path.join(repoRoot, relativePath);
  const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
  const update = buildAgentsMemoryContent(existing);

  if (update.status !== "skipped") {
    fs.writeFileSync(absolutePath, update.content);
  }

  actions.push({ path: relativePath, status: update.status, detail: update.detail });
}

export function buildAgentsMemoryContent(existing: string): { content: string; status: "created" | "skipped" | "updated"; detail: string } {
  const section = agentsMemorySection();

  if (existing.includes(section)) {
    return { content: existing, status: "skipped", detail: "agent-memory section already present" };
  }

  const startMarker = "<!-- agent-memory:start -->";
  const endMarker = "<!-- agent-memory:end -->";
  const start = findStandaloneMarker(existing, startMarker);
  const end = findStandaloneMarker(existing, endMarker, start ? start.lineEnd : 0);

  if (start && end) {
    const before = trimTrailingNewlines(existing.slice(0, start.lineStart));
    const after = trimLeadingNewlines(existing.slice(end.lineEnd));
    const updated = [before, section, after].filter((part) => part.length > 0).join("\n\n");
    return { content: `${updated}\n`, status: "updated", detail: "refreshed agent-memory section" };
  }

  if (start) {
    const before = trimTrailingNewlines(existing.slice(0, start.lineStart));
    const updated = [before, section].filter((part) => part.length > 0).join("\n\n");
    return { content: `${updated}\n`, status: "updated", detail: "repaired agent-memory section" };
  }

  if (end) {
    const before = trimTrailingNewlines(existing.slice(0, end.lineStart));
    const after = trimLeadingNewlines(existing.slice(end.lineEnd));
    const cleaned = [before, after].filter((part) => part.length > 0).join("\n\n");
    const separator = cleaned.length > 0 ? "\n\n" : "";
    return { content: `${cleaned}${separator}${section}\n`, status: "updated", detail: "repaired agent-memory section" };
  }

  if (existing.length === 0) {
    return { content: `# Agent Instructions\n\n${section}\n`, status: "created", detail: "added agent-memory section" };
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${separator}${section}\n`, status: "updated", detail: "appended agent-memory section" };
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function trimLeadingNewlines(value: string): string {
  return value.replace(/^[\r\n]+/, "");
}

function findStandaloneMarker(content: string, marker: string, fromIndex = 0): { lineStart: number; lineEnd: number } | null {
  let searchIndex = fromIndex;

  while (searchIndex < content.length) {
    const markerIndex = content.indexOf(marker, searchIndex);

    if (markerIndex < 0) {
      return null;
    }

    const lineStart = content.lastIndexOf("\n", markerIndex - 1) + 1;
    const lineBreak = content.indexOf("\n", markerIndex);
    const lineEnd = lineBreak >= 0 ? lineBreak + 1 : content.length;
    const lineContentEnd = lineBreak >= 0 ? lineBreak : content.length;

    if (content.slice(lineStart, lineContentEnd).trim() === marker) {
      return { lineStart, lineEnd };
    }

    searchIndex = markerIndex + marker.length;
  }

  return null;
}

function memoryReadmeTemplate(): string {
  return `# Agent Memory

This repository uses \`agent-memory\` for durable agent-readable memory.

Canonical memory lives in:

- \`claims/**/*.md\`
- \`graph/**/*.yaml\`
- \`indexes/**/*.yaml\`
- \`recipes/**/*.yaml\`

Generated memory lives in \`.agent-memory/\` and should not be committed.
`;
}

function agentsMemorySection(): string {
  return `<!-- agent-memory:start -->
## Agent Memory Knowledge Base

Use the repo-memory skill or instruction file whenever it is available. This section is the repo-level fallback and requirement.

Durable repository knowledge lives in \`docs/agent-memory/\` and must stay versioned and reviewable. Generated memory lives in \`.agent-memory/\` and must not be committed.

Memory artifacts:

- \`claims/\`: atomic behavior, rules, constraints, workflows, risks, decisions, and deprecations.
- \`graph/\`: relationships between claim IDs, including dependencies, constraints, conflicts, and replacements.
- \`indexes/\`: watched files, default queries, tags, and claim globs for discoverability.
- \`recipes/\`: repeatable implementation, debugging, release, or review workflows.
- \`waivers/\`: reviewed exceptions for memory coverage checks.

### Agent-Memory-First Workflow

Before non-trivial work:

1. Run \`bin/memory sync\`.
2. Run \`bin/memory context --task "<task>"\`.
3. If files are known, run \`bin/memory context --changed-files <file1> <file2>\`.
4. If working from a diff, run \`bin/memory context --git-diff\`.
5. Use \`bin/memory query\`, \`bin/memory show\`, or \`bin/memory system\` for precise claims, graph links, recipes, or watched-file context.

For non-trivial work, cite the relevant claim IDs, system IDs, and verification commands in plans or PR notes.

After non-trivial work:

1. Update memory in the same change when durable repository knowledge changed.
2. Use \`bin/memory templates list\` and \`bin/memory templates show <template>\` before creating artifacts.
3. Run \`bin/memory validate\` and \`bin/memory sync\` before finishing changes that touch memory.
4. Run \`bin/memory audit --git-diff\` before finishing when canonical memory files changed.

Update targets:

- Claims for changed behavior, interfaces, system boundaries, auth rules, dependencies, risks, or decisions.
- Graphs for changed triggers, handoffs, constraints, replacements, conflicts, or causal links.
- Indexes for changed route/job/model discoverability, watched files, default queries, or tags.
- Recipes for new or changed repeatable workflows.
- Waivers for intentional coverage exceptions with a reason and expiration.
<!-- agent-memory:end -->`;
}

function wrapperTemplate(packageManager: PackageManager): string {
  const fallback = packageManager === "bun" ? "bunx agent-memory" : "npx agent-memory";

  return `#!/usr/bin/env bash
set -euo pipefail

if [ -n "\${AGENT_MEMORY_CLI:-}" ]; then
  exec "\${AGENT_MEMORY_CLI}" "$@"
fi

if command -v agent-memory >/dev/null 2>&1; then
  exec agent-memory "$@"
fi

exec ${fallback} "$@"
`;
}

export function parseInitPackageManager(value: string): PackageManager {
  if (value === "npm" || value === "bun") {
    return value;
  }

  throw new AgentMemoryError(`Unsupported package manager: ${value}`, {
    details: ["Expected one of: npm, bun"]
  });
}

export function parseInitAgent(value: string): AgentTarget {
  return parseAgentTarget(value);
}
