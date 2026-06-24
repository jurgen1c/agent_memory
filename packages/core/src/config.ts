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

  if (!["small", "medium", "full"].includes(defaultBudget)) {
    throw new ConfigError(`Invalid context.default_budget value: ${defaultBudget}`);
  }

  return {
    default_budget: defaultBudget as "small" | "medium" | "full",
    default_depth: readNumber(value, "default_depth", DEFAULT_CONFIG.context.default_depth),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
