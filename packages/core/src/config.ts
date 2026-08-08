import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { isValidMemoryKey } from "./memory_key";
import { findRepoRoot, normalizeRepoRelativeOutputPath, normalizeRepoRelativePath, resolveInsideRepo } from "./repo";
import type { AgentMemoryConfig, LoadedConfig, RepoInfo } from "./types";
import { parseYaml } from "./yaml";

const DEFAULT_CONFIG: AgentMemoryConfig = {
  version: 1,
  database_scope: "local",
  memory_root: "docs/agent-memory",
  database_path: ".agent-memory/memory.sqlite",
  claims: ["claims/**/*.md"],
  graphs: ["graph/**/*.yaml"],
  indexes: ["indexes/**/*.yaml"],
  recipes: ["recipes/**/*.yaml"],
  plans: ["plans/**/*.yaml"],
  profiles: ["profiles/**/*.yaml"],
  waivers: ["waivers/**/*.yaml"],
  agent_instructions: {
    paths: ["AGENTS.md"]
  },
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
  claim_sources: {
    allow: [],
    deny: []
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
    include_inferred_edges_by_default: false,
    recipe_match_limit: 3,
    profile_trait_limit: 5,
    plan_template_suggestion_limit: 3,
    include_profile_traits: true,
    include_recipe_diagnostics: true,
    include_profile_diagnostics: true
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
  const config = normalizeConfig(parsed, repo.root);

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
  return `# Config schema version.
version: ${config.version}${renderGlobalStorageFields(config)}

# Canonical memory source directory. The file patterns below are relative to this path.
memory_root: ${renderYamlScalar(config.memory_root)}

# Generated SQLite cache for local mode. Global database paths are user-local generated state,
# never committed canonical memory. Keep the local path under an ignored directory.
database_path: ${renderYamlScalar(config.database_path)}

# Claim Markdown files. Use this to split or relocate atomic claim documents.
${renderStringArrayField("claims", config.claims)}

# Relationship graph YAML files. Use these to connect claims across systems.
${renderStringArrayField("graphs", config.graphs)}

# Index YAML files. Use these to map watched source files to relevant memory.
${renderStringArrayField("indexes", config.indexes)}

# Recipe YAML files. Use these for repeatable workflows agents should follow.
${renderStringArrayField("recipes", config.recipes)}

# Plan template YAML files. Use these for reusable staged workflows.
${renderStringArrayField("plans", config.plans)}

# Profile trait YAML files. Use these for small composable retrieval and output guidance.
${renderStringArrayField("profiles", config.profiles)}

# Coverage waiver YAML files. Use these for intentional memory coverage exceptions.
${renderStringArrayField("waivers", config.waivers)}

# Managed repository instruction files. init and upgrade preserve local content outside each managed section.
agent_instructions:
${renderStringArrayField("paths", config.agent_instructions.paths, 2)}

# Agent instruction output paths. Disable an agent or change where its skill file is installed.
agent_skills:
  codex:
    enabled: ${config.agent_skills.codex.enabled}
    path: ${renderYamlScalar(config.agent_skills.codex.path)}
  generic:
    enabled: ${config.agent_skills.generic.enabled}
    path: ${renderYamlScalar(config.agent_skills.generic.path)}

# Repo-relative source paths eligible for claims. Empty allow means all paths; deny always wins.
claim_sources:
${renderStringArrayField("allow", config.claim_sources.allow, 2)}
${renderStringArrayField("deny", config.claim_sources.deny, 2)}

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
  recipe_match_limit: ${config.context.recipe_match_limit}
  profile_trait_limit: ${config.context.profile_trait_limit}
  plan_template_suggestion_limit: ${config.context.plan_template_suggestion_limit}
  include_profile_traits: ${config.context.include_profile_traits}
  include_recipe_diagnostics: ${config.context.include_recipe_diagnostics}
  include_profile_diagnostics: ${config.context.include_profile_diagnostics}
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

function normalizeConfig(value: unknown, repoRoot: string): AgentMemoryConfig {
  if (!isRecord(value)) {
    throw new ConfigError("Config root must be a YAML mapping.");
  }

  const version = readNumber(value, "version", DEFAULT_CONFIG.version);

  if (version !== 1 && version !== 2) {
    throw new ConfigError(`Unsupported config version ${version}.`, {
      details: ["Supported config versions are 1 and 2."]
    });
  }

  const globalStorage = readGlobalStorageConfig(value, version);

  return {
    version,
    ...globalStorage,
    memory_root: readString(value, "memory_root", DEFAULT_CONFIG.memory_root),
    database_path: readString(value, "database_path", DEFAULT_CONFIG.database_path),
    claims: readStringArray(value, "claims", DEFAULT_CONFIG.claims),
    graphs: readStringArray(value, "graphs", DEFAULT_CONFIG.graphs),
    indexes: readStringArray(value, "indexes", DEFAULT_CONFIG.indexes),
    recipes: readStringArray(value, "recipes", DEFAULT_CONFIG.recipes),
    plans: readStringArray(value, "plans", DEFAULT_CONFIG.plans),
    profiles: readStringArray(value, "profiles", DEFAULT_CONFIG.profiles),
    waivers: readStringArray(value, "waivers", DEFAULT_CONFIG.waivers),
    agent_instructions: readAgentInstructions(value, repoRoot),
    agent_skills: {
      codex: readAgentSkill(value, "codex", DEFAULT_CONFIG.agent_skills.codex),
      generic: readAgentSkill(value, "generic", DEFAULT_CONFIG.agent_skills.generic)
    },
    claim_sources: readClaimSources(value, repoRoot),
    git: readGit(value),
    validation: readValidation(value),
    context: readContext(value)
  };
}

function readGlobalStorageConfig(
  value: Record<string, unknown>,
  version: number
): Pick<AgentMemoryConfig, "memory_key" | "database_scope"> {
  const hasMemoryKey = value.memory_key !== undefined;
  const hasDatabaseScope = value.database_scope !== undefined;

  if (version === 1) {
    if (hasMemoryKey || hasDatabaseScope) {
      throw new ConfigError("Config version 1 does not support memory_key or database_scope.", {
        details: ["Migrate the config to version 2 before configuring global database storage."]
      });
    }

    return { database_scope: "local" };
  }

  if (!hasDatabaseScope) {
    throw new ConfigError("Config field database_scope is required for config version 2.", {
      details: ["Expected database_scope to be local or global."]
    });
  }

  const databaseScope = readString(value, "database_scope", "local");
  if (databaseScope !== "local" && databaseScope !== "global") {
    throw new ConfigError(`Invalid database_scope value: ${databaseScope}. Expected local or global.`);
  }

  const memoryKey = hasMemoryKey ? readString(value, "memory_key", "") : undefined;
  if (memoryKey !== undefined && !isValidMemoryKey(memoryKey)) {
    throw new ConfigError(`Invalid memory_key value: ${JSON.stringify(memoryKey)}.`, {
      details: [
        "Expected 1-128 lowercase letters, digits, dots, underscores, or hyphens, starting with a letter or digit and not using a Windows device name."
      ]
    });
  }

  if (databaseScope === "global" && memoryKey === undefined) {
    throw new ConfigError("Config field memory_key is required when database_scope is global.");
  }

  return {
    database_scope: databaseScope,
    ...(memoryKey === undefined ? {} : { memory_key: memoryKey })
  };
}

function renderGlobalStorageFields(config: AgentMemoryConfig): string {
  if (config.version === 1) {
    return "";
  }

  const scope = config.database_scope ?? "local";
  const fields = [];

  if (config.memory_key !== undefined) {
    fields.push(
      `# Stable repository identity used for user-local global database storage.\nmemory_key: ${renderYamlScalar(config.memory_key)}`
    );
  }

  fields.push(
    `# Database storage mode. Global databases are generated per checkout and are never canonical memory.\ndatabase_scope: ${scope}`
  );
  return `\n\n${fields.join("\n\n")}`;
}

function readAgentInstructions(root: Record<string, unknown>, repoRoot: string) {
  const value = readRecord(root, "agent_instructions", {});
  const legacyPath = value.path;

  if (value.paths === undefined && legacyPath !== undefined && typeof legacyPath !== "string") {
    throw new ConfigError("Config field agent_instructions.path must be a string.");
  }

  const paths =
    value.paths !== undefined
      ? readStringArray(value, "paths", DEFAULT_CONFIG.agent_instructions.paths)
      : typeof legacyPath === "string"
        ? [legacyPath]
        : [...DEFAULT_CONFIG.agent_instructions.paths];

  if (paths.length === 0 || paths.some((instructionPath) => instructionPath.trim().length === 0)) {
    throw new ConfigError("Config field agent_instructions.paths must contain at least one non-empty path.");
  }

  const normalizedPaths = paths.map((instructionPath) => {
    try {
      return normalizeRepoRelativeOutputPath(repoRoot, instructionPath);
    } catch (error) {
      throw new ConfigError(
        `Config field agent_instructions.paths must contain repository-relative paths inside the repository: ${instructionPath}`,
        { cause: error }
      );
    }
  });

  return {
    paths: Array.from(new Set(normalizedPaths))
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

function readClaimSources(root: Record<string, unknown>, repoRoot: string) {
  const value = readRecord(root, "claim_sources", {});

  return {
    allow: readClaimSourceGlobs(value, "allow", DEFAULT_CONFIG.claim_sources.allow, repoRoot),
    deny: readClaimSourceGlobs(value, "deny", DEFAULT_CONFIG.claim_sources.deny, repoRoot)
  };
}

function readClaimSourceGlobs(
  value: Record<string, unknown>,
  key: "allow" | "deny",
  fallback: string[],
  repoRoot: string
): string[] {
  const globs = readStringArray(value, key, fallback);
  const normalized = globs.map((glob) => {
    try {
      return normalizeRepoRelativePath(repoRoot, glob);
    } catch (error) {
      throw new ConfigError(
        `Config field claim_sources.${key} must contain repository-relative glob patterns inside the repository: ${glob}`,
        { cause: error }
      );
    }
  });

  return Array.from(new Set(normalized));
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
    ),
    recipe_match_limit: readPositiveInteger(value, "recipe_match_limit", DEFAULT_CONFIG.context.recipe_match_limit),
    profile_trait_limit: readPositiveInteger(value, "profile_trait_limit", DEFAULT_CONFIG.context.profile_trait_limit),
    plan_template_suggestion_limit: readPositiveInteger(
      value,
      "plan_template_suggestion_limit",
      DEFAULT_CONFIG.context.plan_template_suggestion_limit
    ),
    include_profile_traits: readBoolean(value, "include_profile_traits", DEFAULT_CONFIG.context.include_profile_traits),
    include_recipe_diagnostics: readBoolean(value, "include_recipe_diagnostics", DEFAULT_CONFIG.context.include_recipe_diagnostics),
    include_profile_diagnostics: readBoolean(value, "include_profile_diagnostics", DEFAULT_CONFIG.context.include_profile_diagnostics)
  };
}

function readPositiveInteger(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = readNumber(root, key, fallback);

  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`Invalid context.${key} value: ${value}. Expected a positive integer.`);
  }

  return value;
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
  return values.map((value) => `${prefix}- ${renderYamlScalar(value)}`).join("\n");
}

export function renderYamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./*@{}-]+$/.test(value) && !isYamlReservedScalar(value) && !startsWithYamlIndicator(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function isYamlReservedScalar(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "true" ||
    normalized === "false" ||
    normalized === "null" ||
    normalized === "~" ||
    /^[+-]?(?:\d[\d_]*|\d[\d_]*\.[\d_]*|\.[\d_]+)(?:[eE][+-]?\d[\d_]*)?$/.test(value) ||
    /^[+-]?\d[\d_]*[eE][+-]?\d[\d_]*$/.test(value)
  );
}

function startsWithYamlIndicator(value: string): boolean {
  return /^[!#&*,:>?@`[\]{}|%-]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
