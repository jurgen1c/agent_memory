import fs from "node:fs";
import path from "node:path";
import { buildAgentCommands, type AgentCommandDescription } from "./agent_commands";
import { loadConfig } from "./config";
import { discoverFiles, resolveConfiguredPath } from "./files";
import { commandPrefixForRepo } from "./skills";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version";
import { parseYaml } from "./yaml";

export interface AgentManifest {
  tool: string;
  version: string;
  repoRoot: string;
  commandPrefix: string;
  paths: {
    config: string;
    memoryRoot: string;
    database: string;
    skills: {
      codex: string;
      generic: string;
    };
  };
  commands: AgentCommandDescription[];
  capabilities: {
    contextual_workflows: true;
    recipes: {
      enabled: true;
      commands: string[];
      context_flags: string[];
    };
    plans: {
      enabled: true;
      commands: string[];
      context_flags: string[];
      run_root: string;
    };
    profiles: {
      enabled: true;
      commands: string[];
      context_flags: string[];
    };
  };
  workflow_summary: {
    recipe_count: number;
    plan_template_count: number;
    profile_trait_count: number;
    active_plan_run_count: number;
    completed_plan_run_count: number;
    abandoned_plan_run_count: number;
    warnings: string[];
  };
}

export interface BuildAgentManifestOptions {
  cwd?: string;
}

export function buildAgentManifest(options: BuildAgentManifestOptions = {}): AgentManifest {
  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const commandPrefix = commandPrefixForRepo(repoRoot);

  const workflowSummary = buildWorkflowSummary(repoRoot, loaded.config);

  return {
    tool: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    repoRoot,
    commandPrefix,
    paths: {
      config: path.relative(repoRoot, loaded.path) || loaded.path,
      memoryRoot: loaded.config.memory_root,
      database: loaded.config.database_path,
      skills: {
        codex: loaded.config.agent_skills.codex.path,
        generic: loaded.config.agent_skills.generic.path
      }
    },
    commands: buildAgentCommands(commandPrefix),
    capabilities: buildWorkflowCapabilities(),
    workflow_summary: workflowSummary
  };
}

function buildWorkflowCapabilities(): AgentManifest["capabilities"] {
  return {
    contextual_workflows: true,
    recipes: {
      enabled: true,
      commands: ["recipes list", "recipes search", "recipes show"],
      context_flags: ["--recipe"]
    },
    plans: {
      enabled: true,
      commands: ["plans suggest", "plans new", "plans next", "plans finish", "plans prune", "plans promote"],
      context_flags: ["--plan", "--stage"],
      run_root: ".agent-memory/plans"
    },
    profiles: {
      enabled: true,
      commands: ["profiles list", "profiles match", "profiles show"],
      context_flags: ["--profile", "--profile-trait"]
    }
  };
}

function buildWorkflowSummary(repoRoot: string, config: ReturnType<typeof loadConfig>["config"]): AgentManifest["workflow_summary"] {
  const memoryRoot = resolveConfiguredPath(repoRoot, config.memory_root);
  const warnings: string[] = [];
  const runCounts = countPlanRuns(repoRoot, warnings);

  return {
    recipe_count: countConfiguredFiles(memoryRoot, config.recipes, warnings, "recipes"),
    plan_template_count: countConfiguredFiles(memoryRoot, config.plans, warnings, "plans"),
    profile_trait_count: countConfiguredFiles(memoryRoot, config.profiles, warnings, "profiles"),
    active_plan_run_count: runCounts.active,
    completed_plan_run_count: runCounts.complete,
    abandoned_plan_run_count: runCounts.abandoned,
    warnings
  };
}

function countConfiguredFiles(memoryRoot: string, patterns: string[], warnings: string[], label: string): number {
  try {
    return discoverFiles(memoryRoot, patterns).length;
  } catch (error) {
    warnings.push(`Unable to count ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

function countPlanRuns(repoRoot: string, warnings: string[]): { active: number; complete: number; abandoned: number } {
  const root = path.join(repoRoot, ".agent-memory/plans");
  const counts = { active: 0, complete: 0, abandoned: 0 };

  if (!fs.existsSync(root)) {
    return counts;
  }

  for (const filePath of walkYamlFiles(root)) {
    try {
      const data = parseYaml(fs.readFileSync(filePath, "utf8"));
      const status = typeof data === "object" && data !== null && !Array.isArray(data) ? data.status : undefined;

      if (status === "active") counts.active += 1;
      else if (status === "complete") counts.complete += 1;
      else if (status === "abandoned") counts.abandoned += 1;
    } catch (error) {
      warnings.push(`Unable to read plan run ${path.relative(repoRoot, filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return counts;
}

function walkYamlFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      return walkYamlFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".yaml") ? [entryPath] : [];
  });
}
