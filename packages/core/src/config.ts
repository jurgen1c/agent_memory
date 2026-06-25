import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { findRepoRoot, resolveInsideRepo } from "./repo";
import type { AgentMemoryConfig, LoadedConfig, RepoInfo } from "./types";
import { parseYaml } from "./yaml";

const DEFAULT_CONFIG: AgentMemoryConfig = {
  version: 1,
  memory_root: "docs/agent-memory",
  database_path: ".agent-memory/memory.sqlite",
  claims: ["claims/**/*.md"],
  graphs: ["graph/**/*.yaml"],
  indexes: ["indexes/**/*.yaml"],
  recipes: ["recipes/**/*.yaml"],
  waivers: ["waivers/**/*.yaml"],
  agent_skills: {
    codex: {
      enabled: true,
      path: ".codex/skills/repo-memory/SKILL.md"
    },
    generic: {
      enabled: true,
      path: "docs/agent-memory/AGENT_SKILL.md"
    }
  },
  git: {
    install_hooks: true,
    hooks: ["post-merge", "post-checkout", "post-rewrite"]
  },
  validation: {
    require_source_files: true,
    require_verification: true,
    reject_multi_claim_documents: true,
    require_unique_titles_within_system: true,
    require_claim_file_matches_id: false,
    max_claim_frontmatter_length: 900,
    max_claim_section_length: 1200
  },
  context: {
    default_budget: "medium",
    default_depth: 1,
    include_inferred_edges_by_default: false
  }
};

export interface LoadConfigOptions {
  cwd?: string;
  repoRoot?: string;
  configPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const repo = resolveRepo(options);
  const configPath = resolveConfigPath(repo.root, options.configPath);

  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`Config file not found at ${configPath}`, {
      details: ["Run `agent-memory init` after Phase 2 is implemented, or create agent-memory.config.yaml."]
    });
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parseYaml(raw);
  const config = normalizeConfig(parsed);

  return {
    config,
    path: configPath,
    repo
  };
}

export function resolveConfigPath(repoRoot: string, configPath?: string): string {
  if (configPath) {
    return resolveInsideRepo(repoRoot, configPath);
  }

  return path.join(repoRoot, "agent-memory.config.yaml");
}

export function defaultConfig(): AgentMemoryConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function renderConfigTemplate(config: AgentMemoryConfig = defaultConfig()): string {
  return `# Config schema version. Leave this at 1 unless agent-memory documents an upgrade.
version: ${config.version}

# Canonical memory source directory. The file patterns below are relative to this path.
memory_root: ${yamlScalar(config.memory_root)}

# Generated SQLite cache. Keep this under an ignored directory and do not commit it.
database_path: ${yamlScalar(config.database_path)}

# Claim Markdown files. Use this to split or relocate atomic claim documents.
${renderStringArrayField("claims", config.claims)}

# Relationship graph YAML files. Use these to connect claims across systems.
${renderStringArrayField("graphs", config.graphs)}

# Index YAML files. Use these to map watched source files to relevant memory.
${renderStringArrayField("indexes", config.indexes)}

# Recipe YAML files. Use these for repeatable workflows agents should follow.
${renderStringArrayField("recipes", config.recipes)}

# Coverage waiver YAML files. Use these for intentional memory coverage exceptions.
${renderStringArrayField("waivers", config.waivers)}

# Agent instruction output paths. Disable an agent or change where its skill file is installed.
agent_skills:
  codex:
    enabled: ${config.agent_skills.codex.enabled}
    path: ${yamlScalar(config.agent_skills.codex.path)}
  generic:
    enabled: ${config.agent_skills.generic.enabled}
    path: ${yamlScalar(config.agent_skills.generic.path)}

# Git hook settings. install-hooks reads this list when creating non-blocking sync hooks.
git:
  install_hooks: ${config.git.install_hooks}
${renderStringArrayField("hooks", config.git.hooks, 2)}

# Validation rules for canonical memory. Loosen only when migrating existing docs.
validation:
  require_source_files: ${config.validation.require_source_files}
  require_verification: ${config.validation.require_verification}
  reject_multi_claim_documents: ${config.validation.reject_multi_claim_documents}
  require_unique_titles_within_system: ${config.validation.require_unique_titles_within_system}
  require_claim_file_matches_id: ${config.validation.require_claim_file_matches_id}
  max_claim_frontmatter_length: ${config.validation.max_claim_frontmatter_length}
  max_claim_section_length: ${config.validation.max_claim_section_length}

# Defaults for agent-memory context when command flags are omitted.
context:
  default_budget: ${config.context.default_budget}
  default_depth: ${config.context.default_depth}
  include_inferred_edges_by_default: ${config.context.include_inferred_edges_by_default}
`;
}

function resolveRepo(options: LoadConfigOptions): RepoInfo {
  if (options.repoRoot) {
    return {
      root: path.resolve(options.repoRoot),
      detectedBy: "cwd",
      warnings: []
    };
  }

  return findRepoRoot(options.cwd);
}

function normalizeConfig(value: unknown): AgentMemoryConfig {
  if (!isRecord(value)) {
    throw new ConfigError("Config root must be a YAML mapping.");
  }

  const version = readNumber(value, "version", DEFAULT_CONFIG.version);

  if (version !== 1) {
    throw new ConfigError(`Unsupported config version ${version}.`, {
      details: ["This Phase 1 implementation supports config version 1."]
    });
  }

  return {
    version,
    memory_root: readString(value, "memory_root", DEFAULT_CONFIG.memory_root),
    database_path: readString(value, "database_path", DEFAULT_CONFIG.database_path),
    claims: readStringArray(value, "claims", DEFAULT_CONFIG.claims),
    graphs: readStringArray(value, "graphs", DEFAULT_CONFIG.graphs),
    indexes: readStringArray(value, "indexes", DEFAULT_CONFIG.indexes),
    recipes: readStringArray(value, "recipes", DEFAULT_CONFIG.recipes),
    waivers: readStringArray(value, "waivers", DEFAULT_CONFIG.waivers),
    agent_skills: {
      codex: readAgentSkill(value, "codex", DEFAULT_CONFIG.agent_skills.codex),
      generic: readAgentSkill(value, "generic", DEFAULT_CONFIG.agent_skills.generic)
    },
    git: readGit(value),
    validation: readValidation(value),
    context: readContext(value)
  };
}

function readAgentSkill(root: Record<string, unknown>, key: "codex" | "generic", fallback: { enabled: boolean; path: string }) {
  const agentSkills = readRecord(root, "agent_skills", {});
  const value = readRecord(agentSkills, key, {});

  return {
    enabled: readBoolean(value, "enabled", fallback.enabled),
    path: readString(value, "path", fallback.path)
  };
}

function readGit(root: Record<string, unknown>) {
  const value = readRecord(root, "git", {});

  return {
    install_hooks: readBoolean(value, "install_hooks", DEFAULT_CONFIG.git.install_hooks),
    hooks: readStringArray(value, "hooks", DEFAULT_CONFIG.git.hooks)
  };
}

function readValidation(root: Record<string, unknown>) {
  const value = readRecord(root, "validation", {});

  return {
    require_source_files: readBoolean(value, "require_source_files", DEFAULT_CONFIG.validation.require_source_files),
    require_verification: readBoolean(value, "require_verification", DEFAULT_CONFIG.validation.require_verification),
    reject_multi_claim_documents: readBoolean(
      value,
      "reject_multi_claim_documents",
      DEFAULT_CONFIG.validation.reject_multi_claim_documents
    ),
    require_unique_titles_within_system: readBoolean(
      value,
      "require_unique_titles_within_system",
      DEFAULT_CONFIG.validation.require_unique_titles_within_system
    ),
    require_claim_file_matches_id: readBoolean(
      value,
      "require_claim_file_matches_id",
      DEFAULT_CONFIG.validation.require_claim_file_matches_id
    ),
    max_claim_frontmatter_length: readNumber(
      value,
      "max_claim_frontmatter_length",
      DEFAULT_CONFIG.validation.max_claim_frontmatter_length
    ),
    max_claim_section_length: readNumber(
      value,
      "max_claim_section_length",
      DEFAULT_CONFIG.validation.max_claim_section_length
    )
  };
}

function readContext(root: Record<string, unknown>) {
  const value = readRecord(root, "context", {});
  const defaultBudget = readString(value, "default_budget", DEFAULT_CONFIG.context.default_budget);
  const defaultDepth = readNumber(value, "default_depth", DEFAULT_CONFIG.context.default_depth);

  if (!["small", "medium", "full"].includes(defaultBudget)) {
    throw new ConfigError(`Invalid context.default_budget value: ${defaultBudget}`);
  }

  if (!Number.isInteger(defaultDepth) || defaultDepth < 0 || defaultDepth > 10) {
    throw new ConfigError(`Invalid context.default_depth value: ${defaultDepth}. Expected an integer between 0 and 10.`);
  }

  return {
    default_budget: defaultBudget as "small" | "medium" | "full",
    default_depth: defaultDepth,
    include_inferred_edges_by_default: readBoolean(
      value,
      "include_inferred_edges_by_default",
      DEFAULT_CONFIG.context.include_inferred_edges_by_default
    )
  };
}

function readRecord(root: Record<string, unknown>, key: string, fallback: Record<string, unknown>): Record<string, unknown> {
  const value = root[key];

  if (value === undefined) {
    return fallback;
  }

  if (!isRecord(value)) {
    throw new ConfigError(`Config field ${key} must be a mapping.`);
  }

  return value;
}

function readString(root: Record<string, unknown>, key: string, fallback: string): string {
  const value = root[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new ConfigError(`Config field ${key} must be a string.`);
  }

  return value;
}

function readNumber(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = root[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`Config field ${key} must be a number.`);
  }

  return value;
}

function readBoolean(root: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = root[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new ConfigError(`Config field ${key} must be a boolean.`);
  }

  return value;
}

function readStringArray(root: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = root[key];

  if (value === undefined) {
    return [...fallback];
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigError(`Config field ${key} must be a list of strings.`);
  }

  return [...value];
}

function renderStringArrayField(key: string, values: string[], indent = 0): string {
  const prefix = " ".repeat(indent);

  if (values.length === 0) {
    return `${prefix}${key}: []`;
  }

  return `${prefix}${key}:\n${renderStringList(values, indent + 2)}`;
}

function renderStringList(values: string[], indent: number): string {
  const prefix = " ".repeat(indent);
  return values.map((value) => `${prefix}- ${yamlScalar(value)}`).join("\n");
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./*@{}-]+$/.test(value) && !isYamlReservedScalar(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function isYamlReservedScalar(value: string): boolean {
  return value === "true" || value === "false" || value === "null" || value === "~" || /^-?\d+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
