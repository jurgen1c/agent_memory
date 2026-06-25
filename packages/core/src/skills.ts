import fs from "node:fs";
import path from "node:path";
import { buildAgentCommands } from "./agent_commands";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { resolveInsideRepo } from "./repo";
import type { AgentMemoryConfig, RepoInfo } from "./types";
import { PACKAGE_VERSION } from "./version";

export type AgentTarget = "codex" | "generic";
export type AgentSkillKind = "repo" | "migration";

export const DEFAULT_CODEX_SKILL_LOCATION = ".codex";

export interface SkillInstallAction {
  path: string;
  status: "created" | "skipped" | "overwritten";
  detail?: string;
}

export interface InstallAgentSkillOptions {
  cwd?: string;
  agent: AgentTarget;
  kind?: AgentSkillKind;
  force?: boolean;
  installLocation?: string;
  installPath?: string;
}

export interface SkillInstallResult {
  repo: RepoInfo;
  agent: AgentTarget;
  kind: AgentSkillKind;
  path: string;
  commandPrefix: string;
  actions: SkillInstallAction[];
  warnings: string[];
}

export interface RenderAgentSkillOptions {
  agent: AgentTarget;
  kind?: AgentSkillKind;
  config: AgentMemoryConfig;
  commandPrefix: string;
}

export function installAgentSkill(options: InstallAgentSkillOptions): SkillInstallResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const repo = loaded.repo;
  const actions: SkillInstallAction[] = [];
  const warnings = [...repo.warnings];
  const kind = options.kind ?? "repo";
  const skillConfig = loaded.config.agent_skills[options.agent];
  const targetPath =
    options.installPath ??
    (options.installLocation
      ? skillPathForLocation(options.agent, options.installLocation, kind)
      : kind === "repo"
        ? skillConfig.path
        : skillPathForLocation(options.agent, defaultSkillLocation(options.agent), kind));
  const absolutePath = resolveInsideRepo(repo.root, targetPath);
  const displayPath = displayRepoPath(repo.root, absolutePath);
  const commandPrefix = commandPrefixForRepo(repo.root);

  if (!skillConfig.enabled) {
    warnings.push(`Agent skill ${options.agent} is disabled in config; installing because it was explicitly requested.`);
  }

  writeFile(
    absolutePath,
    displayPath,
    renderAgentSkill({ agent: options.agent, kind, config: loaded.config, commandPrefix }),
    Boolean(options.force),
    actions
  );

  return {
    repo,
    agent: options.agent,
    kind,
    path: displayPath,
    commandPrefix,
    actions,
    warnings
  };
}

export function renderAgentSkill(options: RenderAgentSkillOptions): string {
  if ((options.kind ?? "repo") === "migration") {
    return renderMigrationSkill(options);
  }

  const title = options.agent === "codex" ? "Repo Memory Skill" : "Repository Memory Instructions";
  const memoryRoot = trimTrailingSlash(options.config.memory_root);
  const databasePath = options.config.database_path;
  const commands = buildAgentCommands(options.commandPrefix);

  return `${renderCodexSkillFrontmatter(options.agent, "repo")}# ${title}

Use this skill whenever working in this repository.

This repository uses \`agent-memory\`, a local memory system based on atomic claims, graph relationships, recipes, indexes, and waivers.

Canonical memory lives in:

${renderMemoryPatterns(memoryRoot, "claims", options.config.claims)}
${renderMemoryPatterns(memoryRoot, "graphs", options.config.graphs)}
${renderMemoryPatterns(memoryRoot, "indexes", options.config.indexes)}
${renderMemoryPatterns(memoryRoot, "recipes", options.config.recipes)}
${renderMemoryPatterns(memoryRoot, "waivers", options.config.waivers)}

Generated memory lives in:

- \`${databasePath}\`

Do not edit or commit the SQLite database or other generated files under \`${path.dirname(databasePath)}\`.

## Before Work

Run:

\`\`\`bash
${options.commandPrefix} sync
\`\`\`

Then retrieve task context:

\`\`\`bash
${options.commandPrefix} context --task "<task>"
\`\`\`

If files are already known:

\`\`\`bash
${options.commandPrefix} context --changed-files <file1> <file2>
\`\`\`

If working from an existing diff:

\`\`\`bash
${options.commandPrefix} context --git-diff
\`\`\`

## Available Commands

${commands.map((command) => `- \`${command.name}\`: ${command.whenToUse}`).join("\n")}

## Templates

Use templates instead of inventing claim structure:

\`\`\`bash
${options.commandPrefix} templates list
${options.commandPrefix} templates show claim:fact
${options.commandPrefix} new claim --type fact --system <system> --title "<title>"
\`\`\`

Create one Markdown file per claim. Keep claims atomic and include verification steps.

## Relationship Graphs

Relationships between claims live in graph files such as \`${joinMemoryPath(memoryRoot, options.config.graphs[0] ?? "graph/**/*.yaml")}\`.

Use graph files to connect claims with relationships like \`requires\`, \`constrains\`, \`explains\`, \`conflicts_with\`, \`replaces\`, \`verifies\`, and \`same_area\`.

Do not duplicate relationship metadata in every claim file.

## After Work

If behavior changed, update or add atomic claims. Before finishing:

\`\`\`bash
${options.commandPrefix} validate
${options.commandPrefix} compile
${options.commandPrefix} doctor
${options.commandPrefix} coverage --git-diff
\`\`\`

## When to Update Memory

Update memory when:

- behavior changed
- architecture changed
- a workflow changed
- a critical constraint was discovered
- a previous claim became stale
- a reusable recipe was discovered

Do not update durable memory for formatting-only changes, speculative assumptions, or temporary debugging notes.

If memory conflicts with code, trust code and update or deprecate memory.
`;
}

function renderMigrationSkill(options: RenderAgentSkillOptions): string {
  const title = options.agent === "codex" ? "Repo Memory Migration Skill" : "Repository Memory Migration Instructions";
  const memoryRoot = trimTrailingSlash(options.config.memory_root);

  return `${renderCodexSkillFrontmatter(options.agent, "migration")}# ${title}

Use this skill when migrating existing repository documentation into \`agent-memory\`.

The goal is to convert legacy docs into atomic, reviewable memory that matches this tool's expected files:

${renderMemoryPatterns(memoryRoot, "claims", options.config.claims)}
${renderMemoryPatterns(memoryRoot, "graphs", options.config.graphs)}
${renderMemoryPatterns(memoryRoot, "indexes", options.config.indexes)}
${renderMemoryPatterns(memoryRoot, "recipes", options.config.recipes)}

Generated memory lives in \`${options.config.database_path}\`. Do not edit or commit generated SQLite.

## Migration Workflow

Start with a scan:

\`\`\`bash
${options.commandPrefix} migrate-docs --from <existing-docs> --system <system>
\`\`\`

For automatic starter drafts, opt in explicitly:

\`\`\`bash
${options.commandPrefix} migrate-docs --from <existing-docs> --system <system> --automatic
\`\`\`

Automatic migration creates \`current\`, low-confidence claim drafts. Treat them as starting points that still need review and verification.

## Agent Duties

- Read the source docs and split broad prose into one atomic claim per file.
- Keep migrated claims low-confidence until verified against code, and update or deprecate them if code disagrees.
- Reference the original doc path in \`source_files\`.
- Create indexes for watched files and systems.
- Create graph edges for relationships such as \`requires\`, \`constrains\`, \`explains\`, \`conflicts_with\`, \`replaces\`, \`verifies\`, and \`same_area\`.
- Use templates instead of inventing structure.

Useful commands:

\`\`\`bash
${options.commandPrefix} templates list
${options.commandPrefix} templates show claim:fact
${options.commandPrefix} validate
${options.commandPrefix} compile
${options.commandPrefix} doctor
\`\`\`

If migrated memory conflicts with code, trust code and update or deprecate the memory.
`;
}

export function parseAgentTarget(value: string): AgentTarget {
  if (value === "codex" || value === "generic") {
    return value;
  }

  throw new AgentMemoryError(`Unsupported agent target: ${value}`, {
    details: ["Expected one of: codex, generic"]
  });
}

export function parseAgentSkillKind(value: string): AgentSkillKind {
  if (value === "repo" || value === "migration") {
    return value;
  }

  throw new AgentMemoryError(`Unsupported skill kind: ${value}`, {
    details: ["Expected one of: repo, migration"]
  });
}

export function commandPrefixForRepo(repoRoot: string): string {
  return fs.existsSync(path.join(repoRoot, "bin/memory")) ? "bin/memory" : "agent-memory";
}

export function skillPathForLocation(agent: AgentTarget, location: string, kind: AgentSkillKind = "repo"): string {
  const normalized = trimTrailingSlash(location || defaultSkillLocation(agent));
  const skillName = kind === "migration" ? "repo-memory-migration" : "repo-memory";
  return path.join(normalized, `skills/${skillName}/SKILL.md`);
}

export function defaultSkillLocation(agent: AgentTarget): string {
  return agent === "codex" ? DEFAULT_CODEX_SKILL_LOCATION : "docs/agent-memory";
}

function writeFile(absolutePath: string, displayPath: string, content: string, force: boolean, actions: SkillInstallAction[]): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existedBefore = fs.existsSync(absolutePath);

  if (existedBefore && !force) {
    actions.push({ path: displayPath, status: "skipped", detail: "already exists" });
    return;
  }

  fs.writeFileSync(absolutePath, content);
  actions.push({ path: displayPath, status: existedBefore ? "overwritten" : "created" });
}

function displayRepoPath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.startsWith("..") || path.isAbsolute(relativePath) ? absolutePath : relativePath;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinMemoryPath(memoryRoot: string, pattern: string): string {
  return memoryRoot.length > 0 ? `${memoryRoot}/${pattern}` : pattern;
}

function renderMemoryPatterns(memoryRoot: string, label: string, patterns: string[]): string {
  const rendered = patterns.map((pattern) => `\`${joinMemoryPath(memoryRoot, pattern)}\``).join(", ");
  return `- ${label}: ${rendered}`;
}

function renderCodexSkillFrontmatter(agent: AgentTarget, kind: AgentSkillKind): string {
  if (agent !== "codex") {
    return "";
  }

  const metadata =
    kind === "migration"
      ? {
          name: "repo-memory-migration",
          description:
            "Use this skill when migrating existing repository documentation into agent-memory atomic claims, indexes, recipes, and graph relationships."
        }
      : {
          name: "repo-memory",
          description:
            "Use this skill whenever working in this repository to sync and retrieve agent-memory context before code changes and update durable claims when behavior or critical repository knowledge changes."
        };

  return `---
name: ${metadata.name}
description: ${metadata.description}
version: ${PACKAGE_VERSION}
user-invocable: false
---

`;
}
