import fs from "node:fs";
import path from "node:path";
import { AgentMemoryError } from "./errors";
import { installMemoryHooks } from "./hooks";
import { findRepoRoot } from "./repo";
import type { RepoInfo } from "./types";

export type PackageManager = "npm" | "bun";
export type AgentTarget = "codex" | "generic";

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
    writeFile(repo.root, ".codex/skills/repo-memory/SKILL.md", skillTemplate("codex"), options.force, actions);
  }

  if (agents.includes("generic")) {
    writeFile(repo.root, "docs/agent-memory/AGENT_SKILL.md", skillTemplate("generic"), options.force, actions);
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

function skillTemplate(agent: AgentTarget): string {
  const title = agent === "codex" ? "Repo Memory Skill" : "Repository Memory Instructions";

  return `# ${title}

Use this skill whenever working in this repository.

This repository uses \`agent-memory\`, a local memory system based on atomic claims.

Canonical memory lives in:

- \`docs/agent-memory/claims/**/*.md\`
- \`docs/agent-memory/graph/**/*.yaml\`
- \`docs/agent-memory/indexes/**/*.yaml\`
- \`docs/agent-memory/recipes/**/*.yaml\`

Generated memory lives in:

- \`.agent-memory/memory.sqlite\`

Do not edit or commit the SQLite database.

## Before Work

Run:

\`\`\`bash
bin/memory sync
\`\`\`

Then retrieve task context:

\`\`\`bash
bin/memory context --task "<task>"
\`\`\`

If files are already known:

\`\`\`bash
bin/memory context --changed-files <file1> <file2>
\`\`\`

If working from an existing diff:

\`\`\`bash
bin/memory context --git-diff
\`\`\`

## During Work

Use:

\`\`\`bash
bin/memory query "<topic>"
bin/memory show <claim-id> --include-related
bin/memory system <system>
bin/memory templates list
bin/memory templates show claim:fact
\`\`\`

## After Work

If behavior changed, update or add atomic claims.

Use one Markdown file per claim.

Create a claim with:

\`\`\`bash
bin/memory new claim --type fact --system <system> --title "<title>"
\`\`\`

Before finishing:

\`\`\`bash
bin/memory validate
bin/memory compile
bin/memory doctor
\`\`\`

## When to Update Memory

Update memory when:

- behavior changed
- architecture changed
- a workflow changed
- a critical constraint was discovered
- a previous claim became stale
- a reusable recipe was discovered

Do not update durable memory for:

- formatting-only changes
- speculative assumptions
- temporary debugging notes

## Relationship Graphs

Relationships between claims live in:

\`\`\`text
docs/agent-memory/graph/**/*.yaml
\`\`\`

Do not duplicate relationship metadata in every claim file.

Use graph files to connect claims with relationships like:

- requires
- constrains
- explains
- conflicts_with
- replaces
- verifies
- same_area

## Conflict Rule

If memory conflicts with code, trust code and update memory.
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
  if (value === "codex" || value === "generic") {
    return value;
  }

  throw new AgentMemoryError(`Unsupported agent target: ${value}`, {
    details: ["Expected one of: codex, generic"]
  });
}
