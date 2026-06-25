import fs from "node:fs";
import path from "node:path";
import { buildAgentCommands } from "./agent_commands";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { resolveRepoOutputPath } from "./repo";
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

export interface SkillReferenceWriteAction {
  path: string;
  status: "created" | "skipped" | "overwritten" | "updated";
  detail?: string;
}

export interface SkillReferenceFile {
  path: string;
  content: string;
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
  const absolutePath = resolveRepoOutputPath(repo.root, targetPath);
  const displayPath = displayRepoPath(repo.root, absolutePath);
  const commandPrefix = commandPrefixForRepo(repo.root);

  if (!skillConfig.enabled) {
    warnings.push(`Agent skill ${options.agent} is disabled in config; installing because it was explicitly requested.`);
  }

  const skillAction = writeFile(
    absolutePath,
    displayPath,
    renderAgentSkill({ agent: options.agent, kind, config: loaded.config, commandPrefix }),
    Boolean(options.force),
    actions
  );

  if (options.agent === "codex" && skillAction.status !== "skipped") {
    writeCodexSkillReferences(repo.root, absolutePath, kind, Boolean(options.force), actions);
  }

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
  const referenceLinks =
    options.agent === "codex"
      ? `
For deeper task guidance, read:

- \`references/claims.md\`
- \`references/recipes.md\`
- \`references/graphs-and-indexes.md\`
- \`references/coverage-and-validation.md\`
`
      : "";

  return `${renderCodexSkillFrontmatter(options.agent, "repo")}# ${title}

Use this skill whenever working in this repository.

This repository uses \`agent-memory\`, a local memory system based on atomic claims, graph relationships, recipes, indexes, and waivers.
${referenceLinks}

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
  const referenceLinks =
    options.agent === "codex"
      ? `
For deeper migration guidance, read:

- \`references/migration-workflow.md\`
- \`references/system-maps.md\`
- \`references/reviewing-drafts.md\`
`
      : "";

  return `${renderCodexSkillFrontmatter(options.agent, "migration")}# ${title}

Use this skill when migrating existing repository documentation into \`agent-memory\`.

The goal is to convert legacy docs into atomic, reviewable memory that matches this tool's expected files:
${referenceLinks}

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

For broad folders that may cover several subsystems, classify first and review the system map:

\`\`\`bash
${options.commandPrefix} migrate-docs --from <existing-docs> --classify
${options.commandPrefix} migrate-docs --system-map .agent-memory/migrations/<source>.yaml
\`\`\`

For automatic starter drafts, opt in explicitly:

\`\`\`bash
${options.commandPrefix} migrate-docs --from <existing-docs> --system <system> --automatic
${options.commandPrefix} migrate-docs --system-map .agent-memory/migrations/<source>.yaml --automatic
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

export function codexSkillReferenceFiles(kind: AgentSkillKind): SkillReferenceFile[] {
  if (kind === "migration") {
    return [
      { path: "references/migration-workflow.md", content: migrationWorkflowReference() },
      { path: "references/system-maps.md", content: systemMapsReference() },
      { path: "references/reviewing-drafts.md", content: reviewingDraftsReference() }
    ];
  }

  return [
    { path: "references/claims.md", content: claimsReference() },
    { path: "references/recipes.md", content: recipesReference() },
    { path: "references/graphs-and-indexes.md", content: graphsAndIndexesReference() },
    { path: "references/coverage-and-validation.md", content: coverageAndValidationReference() }
  ];
}

export function isGeneratedSkillReferenceFile(content: string): boolean {
  return content.includes("<!-- agent-memory:generated-reference");
}

export function writeCodexSkillReferences(
  repoRoot: string,
  absoluteSkillPath: string,
  kind: AgentSkillKind,
  force: boolean,
  actions: SkillReferenceWriteAction[]
): void {
  const skillDir = path.dirname(absoluteSkillPath);

  for (const reference of codexSkillReferenceFiles(kind)) {
    const absolutePath = path.join(skillDir, reference.path);
    writeFile(absolutePath, displayRepoPath(repoRoot, absolutePath), reference.content, force, actions);
  }
}

function writeFile(
  absolutePath: string,
  displayPath: string,
  content: string,
  force: boolean,
  actions: SkillReferenceWriteAction[]
): SkillInstallAction {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existedBefore = fs.existsSync(absolutePath);

  if (existedBefore && !force) {
    const action: SkillInstallAction = { path: displayPath, status: "skipped", detail: "already exists" };
    actions.push(action);
    return action;
  }

  fs.writeFileSync(absolutePath, content);
  const action: SkillInstallAction = { path: displayPath, status: existedBefore ? "overwritten" : "created" };
  actions.push(action);
  return action;
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

function generatedReferenceHeader(name: string): string {
  return `<!-- agent-memory:generated-reference ${name} -->`;
}

function claimsReference(): string {
  return `${generatedReferenceHeader("repo-memory/claims.md")}
# Claims

Claims are the durable unit of repository memory. Create one Markdown file per atomic behavior, rule, decision, risk, or workflow fact.

Use \`templates show claim:fact\` or another claim template before creating files. Keep IDs stable, scoped by system, and aligned with the file path under \`claims/<system>/\`.

Good claims:

- state one thing that can be verified
- name source files, routes, symbols, or tests when known
- include concrete verification steps
- use low confidence until checked against code

Avoid broad summaries. Split a document that describes several behaviors into several claims.
`;
}

function recipesReference(): string {
  return `${generatedReferenceHeader("repo-memory/recipes.md")}
# Recipes

Recipes capture repeatable workflows for implementation, debugging, release, review, or operations.

Create recipes when a task has reusable steps that future agents should follow. Keep one workflow per recipe and link related claims by ID instead of copying claim text.

Prefer recipes for procedures and claims for facts. If a recipe depends on a constraint, represent that constraint as a claim and connect it through graph relationships.
`;
}

function graphsAndIndexesReference(): string {
  return `${generatedReferenceHeader("repo-memory/graphs-and-indexes.md")}
# Graphs And Indexes

Graph files connect claim IDs with relationships such as \`requires\`, \`constrains\`, \`explains\`, \`conflicts_with\`, \`replaces\`, \`verifies\`, and \`same_area\`.

Indexes make memory discoverable by watched files, default queries, tags, and claim globs. Add or update indexes when source ownership, routes, jobs, models, or important search terms change.

Do not duplicate graph relationships inside every claim. Keep relationships in graph YAML and use indexes for retrieval hints.
`;
}

function coverageAndValidationReference(): string {
  return `${generatedReferenceHeader("repo-memory/coverage-and-validation.md")}
# Coverage And Validation

Run \`validate\` before finishing memory changes. Run \`compile\` and \`doctor\` when retrieval behavior or generated SQLite freshness matters.

Use \`coverage --git-diff\` for non-trivial code changes. If watched files changed without memory updates, either update the relevant claim, index, recipe, or graph, or add a time-boxed waiver with a clear reason.

Generated files under \`.agent-memory/\` are cache data and must not be committed.
`;
}

function migrationWorkflowReference(): string {
  return `${generatedReferenceHeader("repo-memory-migration/migration-workflow.md")}
# Migration Workflow

Use focused single-system migration when the source folder clearly belongs to one subsystem:

\`\`\`bash
agent-memory migrate-docs --from docs/auth --system auth
agent-memory migrate-docs --from docs/auth --system auth --automatic
\`\`\`

For broad folders, classify first:

\`\`\`bash
agent-memory migrate-docs --from docs/canonical --classify
\`\`\`

Review the generated map before automatic writes. If one source document spans multiple systems, split it manually or rerun focused migrations against narrower source paths.
`;
}

function systemMapsReference(): string {
  return `${generatedReferenceHeader("repo-memory-migration/system-maps.md")}
# System Maps

A system map assigns each source document to the memory system used for draft claim IDs and target paths.

\`\`\`yaml
version: 1
source_root: docs/canonical
mappings:
  - source: docs/canonical/oauth.md
    system: auth
    title: OAuth behavior
    confidence: medium
    reason: Path/title matched auth system
\`\`\`

Treat low-confidence \`docs\` assignments as prompts for review. Edit \`system\`, \`title\`, and \`reason\` before running \`migrate-docs --system-map <file> --automatic\`.
`;
}

function reviewingDraftsReference(): string {
  return `${generatedReferenceHeader("repo-memory-migration/reviewing-drafts.md")}
# Reviewing Drafts

Automatic migration writes low-confidence current drafts. They are placeholders, not finished memory.

For each draft:

- compare the claim against source docs and code
- split broad prose into atomic claims
- keep source document paths in \`source_files\`
- add source files, symbols, routes, tags, and verification steps
- connect related claims through graph files
- run \`validate\`, \`compile\`, and \`doctor\`

If migrated docs disagree with code, trust code and update or deprecate the migrated memory.
`;
}
