import { AgentMemoryError } from "../../../core/src/errors";
import {
  listProfileTraits,
  matchProfileTraits,
  showProfileTrait,
  type ProfileMatchResult,
  type ProfileTraitDetail,
  type ProfileTraitMatch
} from "../../../core/src/profiles";
import type { ExitCode } from "../../../core/src/types";

export interface ProfilesCommandContext {
  cwd?: string;
}

export interface ProfilesCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export async function runProfilesCommand(args: string[], context: ProfilesCommandContext = {}): Promise<ProfilesCommandResult> {
  const [subcommand, ...rest] = args;

  if (subcommand === "list") {
    const options = parseListArgs(rest);
    const result = await listProfileTraits({ cwd: context.cwd, includeInactive: options.includeInactive });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result, null, 2) : renderProfileList(result.traits)
    };
  }

  if (subcommand === "show") {
    const options = parseShowArgs(rest);
    const result = await showProfileTrait({ cwd: context.cwd, id: options.id });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result, null, 2) : renderProfileShow(result.trait)
    };
  }

  if (subcommand === "match") {
    const options = parseMatchArgs(rest);
    const result = await matchProfileTraits({
      cwd: context.cwd,
      task: options.task,
      changedFiles: options.changedFiles,
      systems: options.systems,
      recipeIds: options.recipeIds,
      profileAlias: options.profileAlias,
      traitIds: options.traitIds,
      limit: options.limit,
      includeInactive: options.includeInactive
    });
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(result, null, 2) : renderProfileMatch(result)
    };
  }

  throw new AgentMemoryError("profiles requires a subcommand.", {
    details: ["Expected one of: list, show, match"]
  });
}

function parseListArgs(args: string[]): { json: boolean; includeInactive: boolean } {
  let json = false;
  let includeInactive = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--include-inactive" || arg === "--include-stale") {
      includeInactive = true;
      continue;
    }

    throw new AgentMemoryError(`Unknown profiles list option: ${arg}`);
  }

  return { json, includeInactive };
}

function parseShowArgs(args: string[]): { id: string; json: boolean } {
  const [id, ...rest] = args;
  if (!id || id.startsWith("--")) {
    throw new AgentMemoryError("profiles show requires a profile trait ID.", {
      details: ["Example: agent-memory profiles show profile_trait.review.findings_first"]
    });
  }

  let json = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new AgentMemoryError(`Unknown profiles show option: ${arg}`);
  }

  return { id, json };
}

function parseMatchArgs(args: string[]): {
  task?: string;
  changedFiles: string[];
  systems: string[];
  recipeIds: string[];
  profileAlias?: string;
  traitIds: string[];
  limit: number;
  includeInactive: boolean;
  json: boolean;
} {
  const changedFiles: string[] = [];
  const systems: string[] = [];
  const recipeIds: string[] = [];
  const traitIds: string[] = [];
  let task: string | undefined;
  let profileAlias: string | undefined;
  let limit = 5;
  let includeInactive = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--include-inactive" || arg === "--include-stale") {
      includeInactive = true;
      continue;
    }

    if (arg === "--task") {
      task = readValue(args, index, "--task");
      index += 1;
      continue;
    }

    if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
      continue;
    }

    if (arg === "--changed-files") {
      index += 1;
      while (index < args.length && !args[index].startsWith("--")) {
        changedFiles.push(args[index]);
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (arg === "--profile") {
      profileAlias = readValue(args, index, "--profile");
      index += 1;
      continue;
    }

    if (arg === "--system") {
      systems.push(readValue(args, index, "--system"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--system=")) {
      systems.push(arg.slice("--system=".length));
      continue;
    }

    if (arg === "--recipe") {
      recipeIds.push(readValue(args, index, "--recipe"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--recipe=")) {
      recipeIds.push(arg.slice("--recipe=".length));
      continue;
    }

    if (arg.startsWith("--profile=")) {
      profileAlias = arg.slice("--profile=".length);
      continue;
    }

    if (arg === "--profile-trait") {
      traitIds.push(readValue(args, index, "--profile-trait"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--profile-trait=")) {
      traitIds.push(arg.slice("--profile-trait=".length));
      continue;
    }

    if (arg === "--limit") {
      limit = parsePositiveInteger(readValue(args, index, "--limit"));
      index += 1;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInteger(arg.slice("--limit=".length));
      continue;
    }

    throw new AgentMemoryError(`Unknown profiles match option: ${arg}`);
  }

  if (!task && changedFiles.length === 0 && systems.length === 0 && recipeIds.length === 0 && !profileAlias && traitIds.length === 0) {
    throw new AgentMemoryError("profiles match requires --task, --changed-files, --system, --recipe, --profile, or --profile-trait.", {
      details: ['Example: agent-memory profiles match --task "review auth changes"']
    });
  }

  return { task, changedFiles, systems, recipeIds, profileAlias, traitIds, limit, includeInactive, json };
}

function renderProfileList(traits: ProfileTraitDetail[]): string {
  return ["# Profile Traits", "", `Count: ${traits.length}`, ...traits.map((trait) => `- ${trait.id}: ${trait.title} (${trait.category}, ${trait.priority})`)].join(
    "\n"
  );
}

function renderProfileShow(trait: ProfileTraitDetail): string {
  const lines = [
    `# ${trait.title}`,
    "",
    `ID: ${trait.id}`,
    `Status: ${trait.status}`,
    `Category: ${trait.category}`,
    `Priority: ${trait.priority}`,
    `Source: ${trait.sourcePath}`,
    "",
    "## Guidance",
    "",
    trait.snippet
  ];

  if (trait.conflictsWith.length > 0) {
    lines.push("", "## Conflicts", "", ...trait.conflictsWith.map((id) => `- ${id}`));
  }

  return lines.join("\n");
}

function renderProfileMatch(result: ProfileMatchResult): string {
  const lines = ["# Profile Trait Matches", "", `Matches: ${result.traits.length}`];

  if (result.diagnostics.intents.length > 0) {
    lines.push("", "## Intent Diagnostics", "", ...result.diagnostics.intents.map((intent) => `- ${intent.intent}: ${intent.reason}`));
  }

  if (result.traits.length === 0) {
    lines.push("", "No matching profile traits found.");
  } else {
    for (const match of result.traits) {
      renderTraitMatch(lines, match);
    }
  }

  if (result.droppedTraits.length > 0) {
    lines.push("", "## Dropped Profile Traits", "", ...result.droppedTraits.map((trait) => `- ${trait.id}: ${trait.reason}`));
  }

  if (result.diagnostics.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.diagnostics.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function renderTraitMatch(lines: string[], match: ProfileTraitMatch): void {
  lines.push("", `## ${match.trait.id}`, "", `${match.trait.title} (${match.trait.category}, ${match.trait.priority})`, `Score: ${match.score}`);

  if (match.reasons.length > 0) {
    lines.push("", "Selected because:", ...match.reasons.map((reason) => `- ${reason.code}: ${reason.detail}`));
  }

  lines.push("", "Guidance:", "", match.trait.snippet);
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AgentMemoryError(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new AgentMemoryError(`${option} requires a value.`);
  }
  return value;
}
