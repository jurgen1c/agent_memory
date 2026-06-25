import fs from "node:fs";
import path from "node:path";
import { loadConfig, renderConfigTemplate } from "./config";
import { buildAgentsMemoryContent } from "./init";
import { findRepoRoot, resolveInsideRepo } from "./repo";
import { commandPrefixForRepo, renderAgentSkill, type AgentTarget } from "./skills";
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

const CONFIG_SCHEMA: ConfigSchema = {
  version: true,
  memory_root: true,
  database_path: true,
  claims: true,
  graphs: true,
  indexes: true,
  recipes: true,
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
    include_inferred_edges: true
  }
};

const DEPRECATED_CONFIG_FIELDS = new Map<string, string>([
  ["context.include_inferred_edges", "Use context.include_inferred_edges_by_default instead."]
]);

export function upgradeRepository(options: UpgradeOptions): UpgradeResult {
  const repo = findRepoRoot(options.cwd);
  const actions: UpgradeAction[] = [];
  const warnings = [...repo.warnings];
  const loaded = loadConfig({ repoRoot: repo.root });
  const configPath = path.join(repo.root, "agent-memory.config.yaml");
  const rawConfig = fs.readFileSync(configPath, "utf8");
  const parsedConfig = parseYaml(rawConfig);
  const config = applyDeprecatedConfigAliases(structuredClone(loaded.config), parsedConfig, warnings);
  const unknownConfigPaths = collectUnknownConfigPaths(parsedConfig);

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
  upgradeAgentsFile(repo.root, options, actions);
  upgradeSkillFiles(repo.root, config, options, actions, warnings);

  return {
    repo,
    write: options.write,
    force: options.force,
    actions,
    warnings
  };
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
  for (const agent of ["codex", "generic"] satisfies AgentTarget[]) {
    const skill = config.agent_skills[agent];

    if (!skill.enabled) {
      actions.push({ path: skill.path, status: "skipped", detail: `${agent} skill disabled in config` });
      continue;
    }

    const absolutePath = resolveInsideRepo(repoRoot, skill.path);
    const relativePath = displayRepoPath(repoRoot, absolutePath);
    const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : null;
    const next = renderAgentSkill({ agent, config, commandPrefix: commandPrefixForRepo(repoRoot) });

    if (existing === next) {
      actions.push({ path: relativePath, status: "skipped", detail: "already current" });
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
      continue;
    }

    actions.push({
      path: relativePath,
      status: existing === null ? "would_create" : "would_update",
      detail: existing === null ? "install skill" : "refresh skill"
    });
  }
}

function applyDeprecatedConfigAliases(
  config: AgentMemoryConfig,
  parsedConfig: unknown,
  warnings: string[]
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
  warnings.push("Deprecated config field context.include_inferred_edges was migrated to context.include_inferred_edges_by_default.");
  return config;
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
  return content.includes("This repository uses `agent-memory`") && content.includes("## Available Commands");
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
