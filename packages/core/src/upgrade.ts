import fs from "node:fs";
import path from "node:path";
import { loadConfig, renderConfigTemplate } from "./config";
import { buildAgentsMemoryContent, detectGeneratedWrapperPackageManager, wrapperTemplate } from "./init";
import { findRepoRoot, resolveRepoOutputPath } from "./repo";
import {
  codexSkillReferenceFiles,
  commandPrefixForRepo,
  isGeneratedAgentSkillFile,
  isGeneratedSkillReferenceFile,
  renderAgentSkill,
  type AgentTarget
} from "./skills";
import type { AgentMemoryConfig, RepoInfo } from "./types";
import { parseYaml } from "./yaml";

export interface UpgradeOptions {
  cwd?: string;
  write: boolean;
  force: boolean;
}

export interface UpgradeAction {
  path: string;
  status: "created" | "skipped" | "updated" | "would_create" | "would_update";
  detail?: string;
}

export interface UpgradeResult {
  repo: RepoInfo;
  write: boolean;
  force: boolean;
  actions: UpgradeAction[];
  warnings: string[];
}

type ConfigSchema = true | { [key: string]: ConfigSchema };
type DeprecatedAliasWarningMode = "applied" | "planned" | "deferred";

const CONFIG_SCHEMA: ConfigSchema = {
  version: true,
  memory_root: true,
  database_path: true,
  claims: true,
  graphs: true,
  indexes: true,
  recipes: true,
  plans: true,
  profiles: true,
  waivers: true,
  agent_skills: {
    codex: {
      enabled: true,
      path: true
    },
    generic: {
      enabled: true,
      path: true
    }
  },
  git: {
    install_hooks: true,
    hooks: true
  },
  validation: {
    require_source_files: true,
    require_verification: true,
    reject_multi_claim_documents: true,
    require_unique_titles_within_system: true,
    require_claim_file_matches_id: true,
    max_claim_frontmatter_length: true,
    max_claim_section_length: true
  },
  context: {
    default_budget: true,
    default_depth: true,
    include_inferred_edges_by_default: true,
    recipe_match_limit: true,
    profile_trait_limit: true,
    plan_template_suggestion_limit: true,
    include_profile_traits: true,
    include_recipe_diagnostics: true,
    include_profile_diagnostics: true,
    include_inferred_edges: true
  }
};

const DEPRECATED_CONFIG_FIELDS = new Map<string, string>([
  ["context.include_inferred_edges", "Use context.include_inferred_edges_by_default instead."]
]);

const AGENT_TARGETS = ["codex", "generic"] satisfies AgentTarget[];
const MEMORY_SCAFFOLD_DIRS = ["claims", "graph", "indexes", "recipes", "plans", "profiles", "waivers"];

export function upgradeRepository(options: UpgradeOptions): UpgradeResult {
  const repo = findRepoRoot(options.cwd);
  const actions: UpgradeAction[] = [];
  const warnings = [...repo.warnings];
  const loaded = loadConfig({ repoRoot: repo.root });
  const configPath = path.join(repo.root, "agent-memory.config.yaml");
  const rawConfig = fs.readFileSync(configPath, "utf8");
  const parsedConfig = parseYaml(rawConfig);
  const unknownConfigPaths = collectUnknownConfigPaths(parsedConfig);
  const configRewriteBlocked = unknownConfigPaths.length > 0 && !options.force;
  const aliasWarningMode: DeprecatedAliasWarningMode = configRewriteBlocked ? "deferred" : options.write ? "applied" : "planned";
  const config = applyDeprecatedConfigAliases(structuredClone(loaded.config), parsedConfig, warnings, aliasWarningMode);
  preserveLegacySingleAgentSelection(repo.root, config, warnings);

  for (const unknownPath of unknownConfigPaths) {
    warnings.push(
      options.force
        ? `Unknown config field ${unknownPath} will be removed because --force was passed.`
        : `Unknown config field ${unknownPath}; skipping config rewrite to avoid dropping user settings.`
    );
  }

  upgradeConfigFile({
    repoRoot: repo.root,
    rawConfig,
    config,
    hasUnknownFields: unknownConfigPaths.length > 0,
    options,
    actions
  });
  upgradeMemoryScaffold(repo.root, config, options, actions, warnings);
  upgradeAgentsFile(repo.root, options, actions);
  upgradeMemoryWrapper(repo.root, options, actions, warnings);
  upgradeSkillFiles(repo.root, config, options, actions, warnings);

  return {
    repo,
    write: options.write,
    force: options.force,
    actions,
    warnings
  };
}

function upgradeMemoryScaffold(
  repoRoot: string,
  config: AgentMemoryConfig,
  options: UpgradeOptions,
  actions: UpgradeAction[],
  warnings: string[]
): void {
  for (const memoryDir of MEMORY_SCAFFOLD_DIRS) {
    const relativeGitkeepPath = memoryScaffoldGitkeepPath(repoRoot, config.memory_root, memoryDir);
    const absolutePath = tryResolveMemoryScaffoldPath(repoRoot, relativeGitkeepPath, actions, warnings);

    if (absolutePath === null) {
      continue;
    }

    const directoryPath = path.dirname(absolutePath);
    const displayPath = displayRepoPath(repoRoot, absolutePath);

    if (fs.existsSync(directoryPath) && !fs.statSync(directoryPath).isDirectory()) {
      warnings.push(`Memory scaffold path ${displayRepoPath(repoRoot, directoryPath)} is not a directory; skipping.`);
      actions.push({ path: displayPath, status: "skipped", detail: "parent path is not a directory" });
      continue;
    }

    if (fs.existsSync(absolutePath) || (fs.existsSync(directoryPath) && fs.readdirSync(directoryPath).length > 0)) {
      actions.push({ path: displayPath, status: "skipped", detail: "memory directory already exists" });
      continue;
    }

    if (options.write) {
      fs.mkdirSync(directoryPath, { recursive: true });
      fs.writeFileSync(absolutePath, "");
      actions.push({ path: displayPath, status: "created", detail: "scaffolded memory directory" });
      continue;
    }

    actions.push({ path: displayPath, status: "would_create", detail: "scaffold memory directory" });
  }
}

function memoryScaffoldGitkeepPath(repoRoot: string, memoryRoot: string, memoryDir: string): string {
  const gitkeepPath = path.join(memoryRoot, memoryDir, ".gitkeep");
  return path.isAbsolute(memoryRoot) ? path.relative(repoRoot, gitkeepPath) : gitkeepPath;
}

function tryResolveMemoryScaffoldPath(
  repoRoot: string,
  relativeGitkeepPath: string,
  actions: UpgradeAction[],
  warnings: string[]
): string | null {
  try {
    return resolveRepoOutputPath(repoRoot, relativeGitkeepPath);
  } catch {
    warnings.push(`Memory scaffold path ${relativeGitkeepPath} escapes the repository root; skipping to avoid unintended writes.`);
    actions.push({ path: relativeGitkeepPath, status: "skipped", detail: "relative path escapes repository root" });
    return null;
  }
}

function upgradeMemoryWrapper(repoRoot: string, options: UpgradeOptions, actions: UpgradeAction[], warnings: string[]): void {
  const relativePath = "bin/memory";
  const absolutePath = path.join(repoRoot, relativePath);
  const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : null;
  const detectedPackageManager = existing === null ? null : detectGeneratedWrapperPackageManager(existing);

  if (existing !== null && detectedPackageManager === null) {
    warnings.push("bin/memory does not look generated; skipping to avoid overwriting user content.");
    actions.push({ path: relativePath, status: "skipped", detail: "custom wrapper requires manual review" });
    return;
  }

  const packageManager = detectedPackageManager ?? "npm";
  const next = wrapperTemplate(packageManager);

  if (existing === next) {
    if (!isExecutable(absolutePath)) {
      if (options.write) {
        fs.chmodSync(absolutePath, 0o755);
        actions.push({ path: relativePath, status: "updated", detail: "made wrapper executable" });
        return;
      }

      actions.push({ path: relativePath, status: "would_update", detail: "make wrapper executable" });
      return;
    }

    actions.push({ path: relativePath, status: "skipped", detail: "already current" });
    return;
  }

  if (options.write) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, next);
    fs.chmodSync(absolutePath, 0o755);
    actions.push({
      path: relativePath,
      status: existing === null ? "created" : "updated",
      detail: existing === null ? "installed wrapper" : `refreshed ${packageManager} wrapper`
    });
    return;
  }

  actions.push({
    path: relativePath,
    status: existing === null ? "would_create" : "would_update",
    detail: existing === null ? "install wrapper" : `refresh ${packageManager} wrapper`
  });
}

function isExecutable(filePath: string): boolean {
  return (fs.statSync(filePath).mode & 0o111) !== 0;
}

function upgradeConfigFile(options: {
  repoRoot: string;
  rawConfig: string;
  config: AgentMemoryConfig;
  hasUnknownFields: boolean;
  options: UpgradeOptions;
  actions: UpgradeAction[];
}): void {
  const relativePath = "agent-memory.config.yaml";

  if (options.hasUnknownFields && !options.options.force) {
    options.actions.push({ path: relativePath, status: "skipped", detail: "unknown config fields require manual review" });
    return;
  }

  const nextConfig = renderConfigTemplate(options.config);

  if (normalizeTrailingNewline(options.rawConfig) === nextConfig) {
    options.actions.push({ path: relativePath, status: "skipped", detail: "already current" });
    return;
  }

  if (options.options.write) {
    fs.writeFileSync(path.join(options.repoRoot, relativePath), nextConfig);
    options.actions.push({ path: relativePath, status: "updated", detail: "refreshed comments and missing defaults" });
    return;
  }

  options.actions.push({ path: relativePath, status: "would_update", detail: "refresh comments and missing defaults" });
}

function upgradeAgentsFile(repoRoot: string, options: UpgradeOptions, actions: UpgradeAction[]): void {
  const relativePath = "AGENTS.md";
  const absolutePath = path.join(repoRoot, relativePath);
  const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
  const update = buildAgentsMemoryContent(existing);

  if (update.status === "skipped") {
    actions.push({ path: relativePath, status: "skipped", detail: update.detail });
    return;
  }

  if (options.write) {
    fs.writeFileSync(absolutePath, update.content);
    actions.push({ path: relativePath, status: update.status, detail: update.detail });
    return;
  }

  actions.push({ path: relativePath, status: update.status === "created" ? "would_create" : "would_update", detail: update.detail });
}

function upgradeSkillFiles(
  repoRoot: string,
  config: AgentMemoryConfig,
  options: UpgradeOptions,
  actions: UpgradeAction[],
  warnings: string[]
): void {
  for (const agent of AGENT_TARGETS) {
    const skill = config.agent_skills[agent];

    if (!skill.enabled) {
      actions.push({ path: skill.path, status: "skipped", detail: `${agent} skill disabled in config` });
      continue;
    }

    const resolvedPath = resolveConfiguredSkillPath(repoRoot, skill.path, actions, warnings);

    if (!resolvedPath) {
      continue;
    }

    const { absolutePath, relativePath } = resolvedPath;
    const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : null;
    const next = renderAgentSkill({ agent, config, commandPrefix: commandPrefixForRepo(repoRoot) });

    if (existing === next) {
      actions.push({ path: relativePath, status: "skipped", detail: "already current" });
      if (agent === "codex") {
        upgradeCodexSkillReferences(repoRoot, absolutePath, options, actions, warnings);
      }
      continue;
    }

    if (existing !== null && !options.force && !isGeneratedSkillFile(existing)) {
      warnings.push(`Skill file ${relativePath} does not look generated; skipping to avoid overwriting user content.`);
      actions.push({ path: relativePath, status: "skipped", detail: "custom content requires --force" });
      continue;
    }

    if (options.write) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, next);
      actions.push({ path: relativePath, status: existing === null ? "created" : "updated", detail: existing === null ? "installed skill" : "refreshed skill" });
      if (agent === "codex") {
        upgradeCodexSkillReferences(repoRoot, absolutePath, options, actions, warnings);
      }
      continue;
    }

    actions.push({
      path: relativePath,
      status: existing === null ? "would_create" : "would_update",
      detail: existing === null ? "install skill" : "refresh skill"
    });

    if (agent === "codex") {
      upgradeCodexSkillReferences(repoRoot, absolutePath, options, actions, warnings);
    }
  }
}

function preserveLegacySingleAgentSelection(repoRoot: string, config: AgentMemoryConfig, warnings: string[]): void {
  const enabledAgents = AGENT_TARGETS.filter((agent) => config.agent_skills[agent].enabled);

  if (enabledAgents.length !== AGENT_TARGETS.length) {
    return;
  }

  const resolvedPaths = enabledAgents.map((agent) => ({ agent, path: tryResolveConfiguredPath(repoRoot, config.agent_skills[agent].path) }));

  if (resolvedPaths.some((resolvedPath) => resolvedPath.path === null)) {
    return;
  }

  const existingAgents = resolvedPaths.filter((resolvedPath) => fs.existsSync(resolvedPath.path as string)).map((resolvedPath) => resolvedPath.agent);
  const missingAgents = resolvedPaths.filter((resolvedPath) => !fs.existsSync(resolvedPath.path as string)).map((resolvedPath) => resolvedPath.agent);

  if (existingAgents.length !== 1 || missingAgents.length !== 1) {
    return;
  }

  const existingAgent = existingAgents[0];
  const missingAgent = missingAgents[0];

  config.agent_skills[missingAgent].enabled = false;
  warnings.push(
    `Preserved legacy single-agent install: disabled ${missingAgent} skill because only the ${existingAgent} skill is installed.`
  );
}

function resolveConfiguredSkillPath(
  repoRoot: string,
  skillPath: string,
  actions: UpgradeAction[],
  warnings: string[]
): { absolutePath: string; relativePath: string } | null {
  const absolutePath = tryResolveConfiguredPath(repoRoot, skillPath);

  if (absolutePath === null) {
    warnings.push(`Skill path ${skillPath} escapes the repository root; skipping to avoid unintended writes.`);
    actions.push({ path: skillPath, status: "skipped", detail: "relative path escapes repository root" });
    return null;
  }

  return {
    absolutePath,
    relativePath: displayRepoPath(repoRoot, absolutePath)
  };
}

function tryResolveConfiguredPath(repoRoot: string, skillPath: string): string | null {
  try {
    return resolveRepoOutputPath(repoRoot, skillPath);
  } catch {
    return null;
  }
}

function upgradeCodexSkillReferences(
  repoRoot: string,
  absoluteSkillPath: string,
  options: UpgradeOptions,
  actions: UpgradeAction[],
  warnings: string[]
): void {
  const skillDir = path.dirname(absoluteSkillPath);

  for (const reference of codexSkillReferenceFiles("repo")) {
    const absolutePath = path.join(skillDir, reference.path);
    const relativePath = displayRepoPath(repoRoot, absolutePath);
    const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : null;

    if (existing === reference.content) {
      actions.push({ path: relativePath, status: "skipped", detail: "already current" });
      continue;
    }

    if (existing !== null && !options.force && !isGeneratedSkillReferenceFile(existing)) {
      warnings.push(`Skill reference ${relativePath} does not look generated; skipping to avoid overwriting user content.`);
      actions.push({ path: relativePath, status: "skipped", detail: "custom content requires --force" });
      continue;
    }

    if (options.write) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, reference.content);
      actions.push({
        path: relativePath,
        status: existing === null ? "created" : "updated",
        detail: existing === null ? "installed skill reference" : "refreshed skill reference"
      });
      continue;
    }

    actions.push({
      path: relativePath,
      status: existing === null ? "would_create" : "would_update",
      detail: existing === null ? "install skill reference" : "refresh skill reference"
    });
  }
}

function applyDeprecatedConfigAliases(
  config: AgentMemoryConfig,
  parsedConfig: unknown,
  warnings: string[],
  warningMode: DeprecatedAliasWarningMode
): AgentMemoryConfig {
  if (!isRecord(parsedConfig)) {
    return config;
  }

  const context = parsedConfig.context;

  if (!isRecord(context) || !("include_inferred_edges" in context)) {
    return config;
  }

  const deprecatedValue = context.include_inferred_edges;

  if (typeof deprecatedValue !== "boolean") {
    warnings.push("Deprecated config field context.include_inferred_edges is ignored because it is not a boolean.");
    return config;
  }

  if ("include_inferred_edges_by_default" in context) {
    warnings.push("Deprecated config field context.include_inferred_edges is ignored because context.include_inferred_edges_by_default is already set.");
    return config;
  }

  config.context.include_inferred_edges_by_default = deprecatedValue;
  warnings.push(deprecatedAliasMigrationWarning(warningMode));
  return config;
}

function deprecatedAliasMigrationWarning(mode: DeprecatedAliasWarningMode): string {
  if (mode === "applied") {
    return "Deprecated config field context.include_inferred_edges was migrated to context.include_inferred_edges_by_default.";
  }

  if (mode === "planned") {
    return "Deprecated config field context.include_inferred_edges would be migrated to context.include_inferred_edges_by_default.";
  }

  return "Deprecated config field context.include_inferred_edges migration to context.include_inferred_edges_by_default was deferred because unknown config fields require manual review.";
}

function collectUnknownConfigPaths(value: unknown): string[] {
  return collectUnknownPaths(value, CONFIG_SCHEMA).filter((configPath) => !DEPRECATED_CONFIG_FIELDS.has(configPath));
}

function collectUnknownPaths(value: unknown, schema: ConfigSchema, prefix = ""): string[] {
  if (schema === true || !isRecord(value)) {
    return [];
  }

  const unknown: string[] = [];

  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = schema[key];
    const childPath = prefix ? `${prefix}.${key}` : key;

    if (!childSchema) {
      unknown.push(childPath);
      continue;
    }

    unknown.push(...collectUnknownPaths(childValue, childSchema, childPath));
  }

  return unknown;
}

function isGeneratedSkillFile(content: string): boolean {
  return isGeneratedAgentSkillFile(content);
}

function normalizeTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function displayRepoPath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.startsWith("..") || path.isAbsolute(relativePath) ? absolutePath : relativePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
