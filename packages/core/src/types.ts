export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface RepoInfo {
  root: string;
  detectedBy: "git" | "cwd";
  warnings: string[];
}

export interface AgentSkillConfig {
  enabled: boolean;
  path: string;
}

export interface AgentMemoryConfig {
  version: number;
  memory_root: string;
  database_path: string;
  claims: string[];
  graphs: string[];
  indexes: string[];
  recipes: string[];
  waivers: string[];
  agent_skills: {
    codex: AgentSkillConfig;
    generic: AgentSkillConfig;
  };
  git: {
    install_hooks: boolean;
    hooks: string[];
  };
  validation: {
    require_source_files: boolean;
    require_verification: boolean;
    reject_multi_claim_documents: boolean;
    require_unique_titles_within_system: boolean;
    require_claim_file_matches_id: boolean;
    max_claim_frontmatter_length: number;
    max_claim_section_length: number;
  };
  context: {
    default_budget: "small" | "medium" | "full";
    default_depth: number;
    include_inferred_edges_by_default: boolean;
  };
}

export interface LoadedConfig {
  config: AgentMemoryConfig;
  path: string;
  repo: RepoInfo;
}
