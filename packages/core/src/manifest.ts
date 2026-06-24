import path from "node:path";
import { buildAgentCommands, type AgentCommandDescription } from "./agent_commands";
import { loadConfig } from "./config";
import { commandPrefixForRepo } from "./skills";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version";

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
}

export interface BuildAgentManifestOptions {
  cwd?: string;
}

export function buildAgentManifest(options: BuildAgentManifestOptions = {}): AgentManifest {
  const loaded = loadConfig({ cwd: options.cwd });
  const repoRoot = loaded.repo.root;
  const commandPrefix = commandPrefixForRepo(repoRoot);

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
    commands: buildAgentCommands(commandPrefix)
  };
}
