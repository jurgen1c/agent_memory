import fs from "node:fs";
import path from "node:path";
import { buildAgentCommands } from "./agent_commands";
import { renderClaimSourcePolicy } from "./claim_sources";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { resolveRepoOutputPath } from "./repo";
import type { AgentMemoryConfig, RepoInfo } from "./types";
import { PACKAGE_VERSION } from "./version";

export type AgentTarget = "codex" | "generic";
export type AgentSkillKind = "repo" | "migration";

export const DEFAULT_CODEX_SKILL_LOCATION = ".codex";
export const GENERATED_SKILL_MARKER_PREFIX = "<!-- agent-memory:generated-skill";

export interface SkillInstallAction {
  path: string;
  status: "created" | "skipped" | "overwritten";
  detail?: string;
}

export interface SkillReferenceWriteAction {
  path: string;
  status: "created" | "skipped" | "overwritten";
  detail?: string;
}

export interface SkillReferenceWriteActionAccumulator {
  push(...actions: SkillReferenceWriteAction[]): number;
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
    writeCodexSkillReferences(repo.root, absolutePath, kind, Boolean(options.force), actions, loaded.config);
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
  const globalDatabase = options.config.database_scope === "global";
  const databaseDescription = globalDatabase
    ? "- User-local global SQLite cache resolved at runtime from `memory_key` and checkout identity"
    : `- \`${options.config.database_path}\``;
  const planRunsPath = ".agent-memory/plans";
  const commands = buildAgentCommands(options.commandPrefix);
  const referenceLinks =
    options.agent === "codex"
      ? `
For deeper task guidance, read:

- \`references/claims.md\`
- \`references/memory-worthiness.md\`
- \`references/contextual-workflows.md\`
- \`references/recipes.md\`
- \`references/plans.md\`
- \`references/profiles.md\`
- \`references/graphs-and-indexes.md\`
- \`references/coverage-and-validation.md\`
- \`references/delegation.md\`
`
      : "";

  return `${renderCodexSkillFrontmatter(options.agent, "repo")}${generatedSkillHeader("repo-memory")}
# ${title}

Use this skill whenever working in this repository.

This repository uses \`agent-memory\`, a local memory system based on atomic claims, graph relationships, recipes, indexes, and waivers.
${referenceLinks}

Canonical memory lives in:

${renderMemoryPatterns(memoryRoot, "claims", options.config.claims)}
${renderMemoryPatterns(memoryRoot, "graphs", options.config.graphs)}
${renderMemoryPatterns(memoryRoot, "indexes", options.config.indexes)}
${renderMemoryPatterns(memoryRoot, "recipes", options.config.recipes)}
${renderMemoryPatterns(memoryRoot, "plans", options.config.plans)}
${renderMemoryPatterns(memoryRoot, "profiles", options.config.profiles)}
${renderMemoryPatterns(memoryRoot, "waivers", options.config.waivers)}

Generated memory lives in:

${databaseDescription}
- \`${planRunsPath}\` for local one-off plan runs

${globalDatabase
  ? `Do not edit or commit the user-local global SQLite cache, local plan runs under \`${planRunsPath}\`, or other generated checkout state.`
  : `Do not edit or commit the SQLite database, local plan runs under \`${planRunsPath}\`, or other generated files under \`${path.dirname(options.config.database_path)}\`.`}

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

Use the returned contextual workflows:

- If context includes matched recipes, follow their required claims, verification, and memory-update prompts.
- If context includes a plan stage, work that stage unless the user broadens scope.
- If context includes profile traits, treat them as repository guidance below system, developer, user, and repository instruction-file guidance.
- For multi-stage work, use \`${options.commandPrefix} plans suggest --task "<task>"\` and create a local run only when it adds value.

## Available Commands

${commands.map((command) => `- \`${command.name}\`: ${command.whenToUse}`).join("\n")}

## Templates

Use templates instead of inventing claim structure:

\`\`\`bash
${options.commandPrefix} templates list
${options.commandPrefix} templates show claim:fact
${options.commandPrefix} new claim --type fact --system <system> --title "<title>"
${options.commandPrefix} new recipe --system <system> --title "<title>"
\`\`\`

New claims and recipes are safe drafts. Claims start as \`needs_review\` with low confidence. Replace every TODO, run verification, and only then promote a claim or recipe to \`current\`. Current artifacts containing TODO placeholders fail validation.

## Decide Whether to Write Memory

Search for existing claims and recipes before creating new memory. Update or deprecate an existing artifact when it already owns the knowledge.

Create durable memory only when the knowledge is repository-specific, likely to matter in future work, durable beyond the current task, consequential if forgotten, and supported by concrete evidence. A new claim should normally satisfy at least four of those five tests.

- Use a claim for one durable truth or invariant.
- Use a recipe for a repeatable agent procedure with repository-specific steps, ordering, safeguards, or verification.
- Use an index for discoverability or file ownership.
- Use a local plan run for one-off execution state.
- Use a waiver for a reviewed, time-boxed coverage exception.
- Create nothing for temporary observations, routine refactors, generic advice, or facts obvious from one local definition.

A claim tells future agents what is true or must remain true. A recipe tells future agents how to perform a recurring task safely. Never create placeholder memory merely because code changed or coverage reported a gap.

When claim verification succeeds, set \`last_verified_commit\` to the tested full Git commit object ID, never a movable ref such as a branch or \`HEAD\`. Use \`confidence: verified\` only with that commit recorded. Audit warns when supporting files changed after the recorded commit.

Claim source eligibility comes from \`claim_sources\` in \`agent-memory.config.yaml\`:

${renderClaimSourcePolicy(options.config.claim_sources)}

Deny patterns win over allow patterns. Do not reference policy-excluded paths through either \`source_files\` or \`related_files\`.

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

If any canonical memory file changed, also run:

\`\`\`bash
${options.commandPrefix} audit --git-diff
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

When a one-off plan run is complete, run \`${options.commandPrefix} plans finish <id>\` or prune old local runs with \`${options.commandPrefix} plans prune\`. Promote a completed run only when it describes a reusable workflow.

If memory conflicts with code, trust code and update or deprecate memory.
`;
}

function renderMigrationSkill(options: RenderAgentSkillOptions): string {
  const title = options.agent === "codex" ? "Repo Memory Migration Skill" : "Repository Memory Migration Instructions";
  const memoryRoot = trimTrailingSlash(options.config.memory_root);
  const generatedDatabase = options.config.database_scope === "global"
    ? "Generated SQLite is a user-local global cache resolved at runtime from `memory_key` and checkout identity."
    : `Generated memory lives in \`${options.config.database_path}\`.`;
  const referenceLinks =
    options.agent === "codex"
      ? `
For deeper migration guidance, read:

- \`references/migration-workflow.md\`
- \`references/system-maps.md\`
- \`references/reviewing-drafts.md\`
`
      : "";

  return `${renderCodexSkillFrontmatter(options.agent, "migration")}${generatedSkillHeader("repo-memory-migration")}
# ${title}

Use this skill when migrating existing repository documentation into \`agent-memory\`.

The goal is to convert legacy docs into atomic, reviewable memory that matches this tool's expected files:
${referenceLinks}

${renderMemoryPatterns(memoryRoot, "claims", options.config.claims)}
${renderMemoryPatterns(memoryRoot, "graphs", options.config.graphs)}
${renderMemoryPatterns(memoryRoot, "indexes", options.config.indexes)}
${renderMemoryPatterns(memoryRoot, "recipes", options.config.recipes)}

${generatedDatabase} Do not edit or commit generated SQLite.

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

Automatic migration creates \`needs_review\`, low-confidence claim drafts. Treat them as starting points that still need review and verification.

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

export function commandPrefixForRepo(repoRoot: string): "agent-memory" | "bin/memory" {
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

export function codexSkillReferenceFiles(kind: AgentSkillKind, config?: AgentMemoryConfig): SkillReferenceFile[] {
  if (kind === "migration") {
    return [
      { path: "references/migration-workflow.md", content: migrationWorkflowReference() },
      { path: "references/system-maps.md", content: systemMapsReference() },
      { path: "references/reviewing-drafts.md", content: reviewingDraftsReference() }
    ];
  }

  return [
    { path: "references/claims.md", content: claimsReference() },
    { path: "references/memory-worthiness.md", content: memoryWorthinessReference(config) },
    { path: "references/contextual-workflows.md", content: contextualWorkflowsReference() },
    { path: "references/recipes.md", content: recipesReference() },
    { path: "references/plans.md", content: plansReference() },
    { path: "references/profiles.md", content: profilesReference() },
    { path: "references/graphs-and-indexes.md", content: graphsAndIndexesReference() },
    { path: "references/coverage-and-validation.md", content: coverageAndValidationReference() },
    { path: "references/delegation.md", content: delegationReference() }
  ];
}

export function isGeneratedSkillReferenceFile(content: string): boolean {
  return content.includes("<!-- agent-memory:generated-reference");
}

export function isGeneratedAgentSkillFile(content: string): boolean {
  return content.includes(GENERATED_SKILL_MARKER_PREFIX);
}

export function writeCodexSkillReferences(
  repoRoot: string,
  absoluteSkillPath: string,
  kind: AgentSkillKind,
  force: boolean,
  actions: SkillReferenceWriteActionAccumulator,
  config?: AgentMemoryConfig
): void {
  const skillDir = path.dirname(absoluteSkillPath);

  for (const reference of codexSkillReferenceFiles(kind, config)) {
    const absolutePath = path.join(skillDir, reference.path);
    writeFile(absolutePath, displayRepoPath(repoRoot, absolutePath), reference.content, force, actions);
  }
}

function writeFile(
  absolutePath: string,
  displayPath: string,
  content: string,
  force: boolean,
  actions: SkillReferenceWriteActionAccumulator
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

function generatedSkillHeader(name: string): string {
  return `${GENERATED_SKILL_MARKER_PREFIX} ${name} -->`;
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
- record knowledge that is costly, risky, or time-consuming to rediscover

Avoid broad summaries, temporary implementation notes, and claims that merely restate one obvious local definition. Split a document that describes several behaviors into several claims.

A workflow claim describes a durable lifecycle or invariant, such as required state transitions. It does not replace a YAML recipe. The legacy \`claim:recipe\` template remains available for compatibility, but use first-class recipes for procedures agents should execute.

\`new claim\` creates a \`needs_review\`, low-confidence draft. Replace all TODO fields and run its verification before changing it to \`current\`. Set \`last_verified_commit\` to the full tested Git commit object ID when verification succeeds; \`confidence: verified\` requires that commit.
`;
}

function recipesReference(): string {
  return `${generatedReferenceHeader("repo-memory/recipes.md")}
# Recipes

Recipes capture repeatable workflows for implementation, debugging, release, review, or operations.

Create recipes when a task has reusable steps that future agents should follow. A useful recipe is repository-specific, likely to recur, and contains non-obvious ordering, safeguards, decision points, or verification. Keep one workflow per recipe and link related claims by ID instead of copying claim text.

Prefer recipes for procedures and claims for facts. If a recipe depends on a constraint, represent that constraint as a claim and connect it through graph relationships.

Do not create a recipe for a one-off incident, a generic development loop such as "edit, test, commit," or a single command whose usage is already obvious.

Useful commands:

\`\`\`bash
agent-memory new recipe --system auth --title "Modify student OAuth safely"
agent-memory recipes list
agent-memory recipes search "student oauth"
agent-memory recipes show recipe.auth.modify_student_oauth
agent-memory context --recipe recipe.auth.modify_student_oauth
\`\`\`
`;
}

function memoryWorthinessReference(config?: AgentMemoryConfig): string {
  const policy = config
    ? renderClaimSourcePolicy(config.claim_sources)
    : "- Allowed claim sources: all repository paths\n- Denied claim sources: none";

  return `${generatedReferenceHeader("repo-memory/memory-worthiness.md")}
# Memory Worthiness

Durable memory should reduce future uncertainty, rework, or risk. It should not become a changelog or a transcription of the codebase.

## Before Creating Anything

1. Search existing claims and recipes. Update, deprecate, or extend the artifact that already owns the knowledge.
2. Identify the smallest durable proposition or repeatable procedure.
3. Check the repository's claim source policy.
4. Choose the narrowest artifact that represents the knowledge without duplication.

## Claim Threshold

A new claim should normally pass at least four of these five tests:

1. **Repository-specific**: this is not generic engineering knowledge.
2. **Future-relevant**: a later implementation, debugging, review, release, or operations task is likely to need it.
3. **Durable**: it should remain true after the current branch or task is complete.
4. **Consequential**: forgetting it could cause an incorrect change, security or reliability risk, repeated investigation, or a broken workflow.
5. **Evidence-backed**: code, tests, configuration, committed documentation, or another concrete source can verify it.

Atomicity and verification are necessary but not sufficient. A perfectly formatted claim can still be noise.

## Choose the Artifact

- **Update an existing claim** when the same durable truth changed or gained better evidence.
- **Create a claim** for one durable fact, rule, constraint, decision, risk, or lifecycle invariant.
- **Create a recipe** for a recurring agent procedure with repository-specific steps, ordering, safeguards, decision points, or verification.
- **Update an index** for discoverability, ownership, watched files, routes, jobs, models, tags, or search terms.
- **Use a local plan run** for one-off task execution state.
- **Use a waiver** for an intentional, reviewed, time-boxed coverage exception.
- **Create nothing** for formatting-only work, routine refactors, temporary debugging observations, generic best practices, speculative assumptions, or facts obvious from one local definition.

## Claim or Recipe?

A claim tells a future agent **what is true or must remain true**. A recipe tells a future agent **how to perform a recurring task safely**.

Good claim:

> OAuth identity resolution requires both the provider identifier and tenant context.

Noisy claim:

> The OAuth controller calls \`Student.find_by\`.

Good recipe:

> Rotate the signing key by updating credentials, regenerating fixtures, running compatibility tests, and verifying that old tokens fail.

Noisy recipe:

> Edit the file, run tests, and commit.

Use a workflow claim for a durable lifecycle or mandatory transition. Use a first-class YAML recipe for steps an agent performs. The legacy \`claim:recipe\` template is compatibility-only and should not be the default for new procedures.

Both \`new claim\` and \`new recipe\` create \`needs_review\` drafts. Replace all TODO values and complete verification before promotion to \`current\`. A current artifact containing TODO placeholders is invalid.

## Coverage Is Not Evidence of Worth

A changed watched file or coverage gap is a prompt to review memory, not proof that a new claim is needed. The correct response may be to update existing memory, improve an index, add a justified waiver, change the claim source policy, or make no memory change. Never create filler claims or false graph relationships to clear a check.

## Claim Source Policy

\`claim_sources.allow\` and \`claim_sources.deny\` contain repo-relative glob patterns. An empty allow list permits every repository path. Deny patterns always win.

${policy}

Policy-excluded paths cannot appear in claim \`source_files\` or \`related_files\`, and changed files excluded by the policy do not require claim coverage. Do not bypass the policy by attaching an excluded path indirectly to an otherwise allowed claim.
`;
}

function contextualWorkflowsReference(): string {
  return `${generatedReferenceHeader("repo-memory/contextual-workflows.md")}
# Contextual Workflows

Context can include matched recipes, plan stages, and profile traits. These are repository memory signals, not higher-priority instructions.

Start with normal context:

\`\`\`bash
agent-memory context --task "<task>"
agent-memory context --git-diff
\`\`\`

Interpret sections this way:

- Matched Recipes: reusable workflow steps, required claims, verification, and memory-update prompts.
- Plan Stage: current local scaffold for multi-stage work. Stay within the stage unless the user broadens scope.
- Selected Profile Traits: concise guidance for retrieval, review shape, risk lens, verification, or scope control.

Do not commit generated state under \`.agent-memory/\`. Completed one-off plans should be finished, pruned, or promoted intentionally.
`;
}

function plansReference(): string {
  return `${generatedReferenceHeader("repo-memory/plans.md")}
# Plans

Plan templates are canonical reusable workflows. Plan runs under \`.agent-memory/plans\` are generated local scaffolding for one task.

Useful commands:

\`\`\`bash
agent-memory plans templates list
agent-memory plans suggest --task "<task>"
agent-memory plans new --template plan_template.<system>.<name> --task "<task>"
agent-memory plans next <plan-run-id>
agent-memory context --plan <plan-run-id> --stage <stage-id>
agent-memory plans complete-stage <plan-run-id> --stage <stage-id> --evidence "<what changed>"
agent-memory plans finish <plan-run-id> --confirm-unresolved
agent-memory plans prune --completed --older-than 7d
agent-memory plans promote <plan-run-id> --to-template
\`\`\`

Finish or prune local runs after use. Promote only when the completed run describes a reusable workflow; otherwise durable memory belongs in claims, recipes, graph edges, indexes, or profile traits.
`;
}

function profilesReference(): string {
  return `${generatedReferenceHeader("repo-memory/profiles.md")}
# Profiles

Profile traits are small, explainable context snippets. They are not personalities and they do not override system, developer, user, or repository instructions.

Useful commands:

\`\`\`bash
agent-memory profiles list
agent-memory profiles match --task "review auth changes"
agent-memory profiles show profile_trait.review.findings_first
agent-memory context --task "review auth changes" --profile review
agent-memory context --task "review auth changes" --profile-trait profile_trait.review.findings_first
\`\`\`

Use profile traits for retrieval bias, output contracts, verification bias, risk lens, and scope control. Keep snippets short and resolve conflicts through \`conflicts_with\`.
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

## Stale Review

Run \`audit --git-diff\` when canonical memory files changed. Strong duplicate signals block; shared tags and weak file overlap are advisory. Audit requires \`last_verified_commit\` values to be full immutable Git commit object IDs and warns when supporting files changed afterward. Re-run verification and record the full tested commit object ID, or move the claim to \`needs_verification\`. Resolve failures by reviewing the exact shared values and then updating or deprecating a claim, or adding any semantically accurate explicit graph relationship. Never invent \`replaces\` or \`conflicts_with\` solely to clear an audit finding. Repositories that intentionally depend on the legacy all-overlap gate can run \`audit --git-diff --strict\`.

All Git subprocesses are bounded. If a restricted subprocess stalls, agent-memory terminates it and follows the command's documented warning or fallback behavior. Audit conservatively retains current-tree overlap findings when baseline memory cannot be loaded.

Generated files under \`.agent-memory/\` are cache data and must not be committed.
`;
}

function delegationReference(): string {
  return `${generatedReferenceHeader("repo-memory/delegation.md")}
# Delegation

Use a lower-effort subagent for memory retrieval, broad search, and draft analysis when the task touches several systems, many claims, or an unclear workflow surface. Keep small, obvious lookups inline in the primary agent.

The primary agent owns final interpretation, canonical memory edits, validation, audit signoff, commits, pushes, and external writes.

Good subagent tasks:

- run read-only memory commands such as \`context\`, \`query\`, \`show\`, \`system\`, \`recipes\`, \`plans\`, and \`profiles\`
- summarize relevant claims, recipes, plan stages, profile traits, and verification steps
- identify candidate stale, deprecated, overlapping, or conflicting claims for primary-agent review
- draft possible claim, graph, recipe, index, profile, or plan-template updates without writing files
- prepare an audit or coverage finding summary with exact IDs, paths, commands, and uncertainty

Do not delegate these tasks:

- editing canonical memory files
- deciding whether a semantic stale or conflict finding is true
- marking audit, coverage, validation, or doctor results as final
- committing, pushing, resolving PR threads, or replying on external services
- treating generated files under \`.agent-memory/\` as source of truth

Subagent prompt contract:

1. State that the task is read-only and proposal-only.
2. Give exact commands and paths to inspect.
3. Require claim IDs, recipe IDs, plan IDs, profile trait IDs, and file paths in the response.
4. Ask for concise findings grouped by action: use as-is, update, deprecate, replace, conflict, or ignore.
5. Require uncertainty notes when evidence is incomplete.

Before acting on subagent output, the primary agent must verify key claims against source files or command output and rerun the relevant deterministic checks.
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

Automatic migration writes low-confidence \`needs_review\` drafts. They are placeholders, not finished memory.

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
