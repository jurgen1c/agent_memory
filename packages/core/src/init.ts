import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { installMemoryHooks } from "./hooks";
import { findRepoRoot } from "./repo";
import { parseAgentTarget, renderAgentSkill, type AgentTarget } from "./skills";
import type { RepoInfo } from "./types";

export type PackageManager = "npm" | "bun";

export interface InitOptions {
  cwd?: string;
  yes: boolean;
  force: boolean;
  packageManager: PackageManager;
  agents: AgentTarget[];
  installHooks: boolean;
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

  writeFile(repo.root, "agent-memory.config.yaml", configTemplate(), options.force, actions);
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
    writeFile(
      repo.root,
      ".codex/skills/repo-memory/SKILL.md",
      renderAgentSkill({ agent: "codex", config: defaultConfig(), commandPrefix: "bin/memory" }),
      options.force,
      actions
    );
  }

  if (agents.includes("generic")) {
    writeFile(
      repo.root,
      "docs/agent-memory/AGENT_SKILL.md",
      renderAgentSkill({ agent: "generic", config: defaultConfig(), commandPrefix: "bin/memory" }),
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

function writeFile(repoRoot: string, relativePath: string, content: string, force: boolean, actions: InitAction[]): void {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existedBefore = fs.existsSync(absolutePath);

  if (existedBefore && !force) {
    actions.push({ path: relativePath, status: "skipped", detail: "already exists" });
    return;
  }

  fs.writeFileSync(absolutePath, content);
  actions.push({ path: relativePath, status: existedBefore && force ? "overwritten" : "created" });
}

function writeExecutable(repoRoot: string, relativePath: string, content: string, force: boolean, actions: InitAction[]): void {
  writeFile(repoRoot, relativePath, content, force, actions);
  const absolutePath = path.join(repoRoot, relativePath);

  if (fs.existsSync(absolutePath)) {
    fs.chmodSync(absolutePath, 0o755);
  }
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

function ensureAgentsMemorySection(repoRoot: string, actions: InitAction[]): void {
  const relativePath = "AGENTS.md";
  const absolutePath = path.join(repoRoot, relativePath);
  const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
  const section = agentsMemorySection();

  if (existing.includes(section)) {
    actions.push({ path: relativePath, status: "skipped", detail: "agent-memory section already present" });
    return;
  }

  const startMarker = "<!-- agent-memory:start -->";
  const endMarker = "<!-- agent-memory:end -->";
  const startIndex = existing.indexOf(startMarker);
  const endIndex = existing.indexOf(endMarker);

  if (startIndex >= 0 && endIndex > startIndex) {
    const before = existing.slice(0, startIndex).trimEnd();
    const after = existing.slice(endIndex + endMarker.length).trimStart();
    const updated = [before, section, after].filter((part) => part.length > 0).join("\n\n");
    fs.writeFileSync(absolutePath, `${updated}\n`);
    actions.push({ path: relativePath, status: "updated", detail: "refreshed agent-memory section" });
    return;
  }

  if (existing.length === 0) {
    fs.writeFileSync(absolutePath, `# Agent Instructions\n\n${section}\n`);
    actions.push({ path: relativePath, status: "created", detail: "added agent-memory section" });
    return;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(absolutePath, `${existing}${separator}${section}\n`);
  actions.push({ path: relativePath, status: "updated", detail: "appended agent-memory section" });
}

function configTemplate(): string {
  return `version: 1
memory_root: docs/agent-memory
database_path: .agent-memory/memory.sqlite

claims:
  - claims/**/*.md

graphs:
  - graph/**/*.yaml

indexes:
  - indexes/**/*.yaml

recipes:
  - recipes/**/*.yaml

waivers:
  - waivers/**/*.yaml

agent_skills:
  codex:
    enabled: true
    path: .codex/skills/repo-memory/SKILL.md
  generic:
    enabled: true
    path: docs/agent-memory/AGENT_SKILL.md

git:
  install_hooks: true
  hooks:
    - post-merge
    - post-checkout
    - post-rewrite

validation:
  require_source_files: true
  require_verification: true
  reject_multi_claim_documents: true
  require_unique_titles_within_system: true
  require_claim_file_matches_id: false

context:
  default_budget: medium
  default_depth: 1
  include_inferred_edges_by_default: false
`;
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
