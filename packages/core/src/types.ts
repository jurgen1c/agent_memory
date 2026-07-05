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
  plans: string[];
  profiles: string[];
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
    recipe_match_limit: number;
    profile_trait_limit: number;
    plan_template_suggestion_limit: number;
    include_profile_traits: boolean;
    include_recipe_diagnostics: boolean;
    include_profile_diagnostics: boolean;
  };
}

export interface LoadedConfig {
  config: AgentMemoryConfig;
  path: string;
  repo: RepoInfo;
}

export type WorkflowStatus = "current" | "proposed" | "needs_review" | "deprecated" | "stale" | "rejected";

export type ProfileTraitCategory = "retrieval_bias" | "output_contract" | "verification_bias" | "risk_lens" | "scope_control";

export type ProfileTraitPriority = "low" | "normal" | "high" | "critical";

export interface PlanTemplate {
  id: string;
  title: string;
  system: string;
  status: WorkflowStatus;
  intent_triggers?: string[];
  recipes?: string[];
  stages: PlanTemplateStage[];
  metadata?: Record<string, unknown>;
}

export interface PlanTemplateStage {
  id: string;
  title: string;
  goal: string;
  claim_refs?: string[];
  recipe_refs?: string[];
  profile_traits?: string[];
  source_files?: string[];
  verification?: string[];
  done_when?: string[];
  memory_updates?: string[];
}

export interface PlanRun {
  id: string;
  template_id?: string;
  task: string;
  created_at: string;
  updated_at: string;
  status: "active" | "complete" | "blocked" | "abandoned";
  current_stage: string;
  branch?: string;
  base_commit?: string;
  stages: PlanRunStage[];
}

export interface PlanRunStage {
  id: string;
  status: "pending" | "active" | "blocked" | "complete" | "skipped" | "abandoned";
  started_at?: string;
  completed_at?: string;
  blocked_at?: string;
  evidence?: string[];
  reason?: string;
}

export interface ProfileTrait {
  id: string;
  title: string;
  status: WorkflowStatus;
  category: ProfileTraitCategory;
  priority: ProfileTraitPriority;
  applies_when: ProfileTraitAppliesWhen;
  snippet: string;
  conflicts_with?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProfileTraitAppliesWhen {
  always?: boolean;
  aliases?: string[];
  profile_aliases?: string[];
  profiles?: string[];
  commands?: string[];
  intents?: string[];
  task_intents?: string[];
  task_triggers?: string[];
  systems?: string[];
  changed_files?: string[];
  file_globs?: string[];
  files?: string[];
  recipes?: string[];
  recipe_ids?: string[];
  plans?: string[];
  plan_ids?: string[];
  plan_template_ids?: string[];
  stages?: string[];
  plan_stages?: string[];
  claim_types?: string[];
  risk_signals?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}
