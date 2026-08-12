import { AgentMemoryError } from "../../../core/src/errors";
import {
  doctorRegistry,
  listRegistry,
  pruneRegistry,
  showRegistryMemory,
  type RegistryCheckoutSummary,
  type RegistryDoctorResult,
  type RegistryListResult,
  type RegistryMemorySummary,
  type RegistryPruneResult
} from "../../../core/src/registry_maintenance";
import { resolveGlobalHome } from "../../../core/src/registry";
import type { ExitCode } from "../../../core/src/types";

export interface RegistryCommandContext {
  env?: NodeJS.ProcessEnv;
}

export interface RegistryCommandResult {
  exitCode: ExitCode;
  stdout: string;
}

export function runRegistryCommand(args: string[], context: RegistryCommandContext = {}): RegistryCommandResult {
  const [subcommand, ...rest] = args;
  const globalHome = resolveGlobalHome({ env: context.env });

  if (subcommand === "list") {
    const json = parseJsonOnly(rest, "registry list");
    const result = listRegistry({ globalHome });
    return { exitCode: 0, stdout: json ? JSON.stringify(result, null, 2) : renderList(result) };
  }

  if (subcommand === "show") {
    const { memoryKey, json } = parseShow(rest);
    const result = showRegistryMemory(memoryKey, { globalHome });
    return { exitCode: 0, stdout: json ? JSON.stringify(result, null, 2) : renderShow(result) };
  }

  if (subcommand === "doctor") {
    const json = parseJsonOnly(rest, "registry doctor");
    const result = doctorRegistry({ globalHome });
    return { exitCode: result.healthy ? 0 : 5, stdout: json ? JSON.stringify(result, null, 2) : renderDoctor(result) };
  }

  if (subcommand === "prune") {
    const options = parsePrune(rest);
    const result = pruneRegistry({ globalHome, force: options.force });
    return { exitCode: 0, stdout: options.json ? JSON.stringify(result, null, 2) : renderPrune(result) };
  }

  throw new AgentMemoryError("registry requires a subcommand.", {
    details: ["Expected one of: list, show, doctor, prune"]
  });
}

function parseJsonOnly(args: string[], command: string): boolean {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw new AgentMemoryError(`Unknown ${command} option: ${arg}`);
  }
  return json;
}

function parseShow(args: string[]): { memoryKey: string; json: boolean } {
  const [memoryKey, ...rest] = args;
  if (!memoryKey || memoryKey.startsWith("--")) {
    throw new AgentMemoryError("registry show requires a memory key.", {
      details: ["Example: agent-memory registry show org-repository"]
    });
  }
  return { memoryKey, json: parseJsonOnly(rest, "registry show") };
}

function parsePrune(args: string[]): { force: boolean; json: boolean } {
  let force = false;
  let dryRun = false;
  let json = false;

  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--force" || arg === "--yes" || arg === "-y") force = true;
    else if (arg === "--dry-run") dryRun = true;
    else throw new AgentMemoryError(`Unknown registry prune option: ${arg}`);
  }

  if (force && dryRun) {
    throw new AgentMemoryError("registry prune cannot combine --force with --dry-run.");
  }

  return { force: force && !dryRun, json };
}

function renderList(result: RegistryListResult): string {
  const lines = ["# Agent Memory Registry", "", `Global home: ${result.global_home}`, `Memory keys: ${result.memory_count}`, `Checkouts: ${result.checkout_count}`];
  for (const memory of result.memories) {
    lines.push(
      "",
      `## ${memory.memory_key}`,
      "",
      `Repository identity: ${memory.repository_identity ?? "unverified"}`,
      `Checkout classification: ${memory.checkout_classification}`,
      `Checkout counts: active=${memory.active_checkout_count}, stale=${memory.stale_checkout_count}, inconclusive=${memory.inconclusive_checkout_count}`
    );
    for (const checkout of memory.checkouts) lines.push(renderCheckoutLine(checkout));
  }
  if (result.memories.length === 0) lines.push("", "No registry entries found.");
  return lines.join("\n");
}

function renderShow(memory: RegistryMemorySummary): string {
  const lines = [
    `# Registry Memory ${memory.memory_key}`,
    "",
    `Repository identity: ${memory.repository_identity ?? "unverified"}`,
    `Checkouts: ${memory.checkout_count}`,
    `Checkout classification: ${memory.checkout_classification}`,
    `Checkout counts: active=${memory.active_checkout_count}, stale=${memory.stale_checkout_count}, inconclusive=${memory.inconclusive_checkout_count}`
  ];
  for (const checkout of memory.checkouts) {
    lines.push(
      "",
      `## ${checkout.checkout_fingerprint}`,
      "",
      `Scope: ${checkout.scope}`,
      `Checkout root: ${checkout.repo_root}`,
      `Config: ${checkout.config_path}`,
      `Effective database: ${checkout.database_path}`,
      `Database status: ${checkout.database_status}`,
      `Checkout status: ${checkout.checkout_status}`,
      `Package version: ${checkout.package_version}`,
      `Config hash: ${checkout.config_hash}`,
      `Git head: ${checkout.git_head ?? "unavailable"}`,
      `Last seen: ${checkout.last_seen_at}`
    );
  }
  return lines.join("\n");
}

function renderDoctor(result: RegistryDoctorResult): string {
  const lines = [
    result.healthy ? "Agent Memory registry doctor passed." : "Agent Memory registry doctor found issues.",
    "",
    `Registry: ${result.registry_path}`,
    `Memory keys: ${result.memory_count}`,
    `Checkouts: ${result.checkout_count}`,
    "",
    "Findings:"
  ];
  if (result.findings.length === 0) lines.push("- [OK] Registry metadata and generated databases are healthy.");
  for (const finding of result.findings) {
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message} Guidance: ${finding.guidance}`);
  }
  return lines.join("\n");
}

function renderPrune(result: RegistryPruneResult): string {
  const action = result.dry_run ? "selected" : "pruned";
  const lines = [
    `Stale registry entries ${action}: ${result.dry_run ? result.stale_count : result.pruned_count}`,
    ...result.entries.map((entry) => `- ${entry.memory_key}/${entry.checkout_fingerprint}: ${entry.repo_root}`),
    ...result.empty_memory_keys.map((memoryKey) => `- ${memoryKey}: empty registry record`)
  ];
  if (result.dry_run && result.stale_count > 0) {
    lines.push("", "Dry run only. Repeat with --force after confirming these checkout roots are stale.");
  }
  return lines.join("\n");
}

function renderCheckoutLine(checkout: RegistryCheckoutSummary): string {
  return `- ${checkout.checkout_fingerprint}: ${checkout.repo_root} (scope=${checkout.scope}, database=${checkout.database_status}, checkout=${checkout.checkout_status})`;
}
