import { runQueryCommand } from "./query";
import { runContextCommand } from "./context";
import { runShowCommand } from "./show";
import type { CliResult } from "../router";
import { contextOutputError, renderContextOutputHuman, resolveContextOutputCap } from "../../../core/src/context_output_serialization";
import { buildContextV2, queryClaimsV2, showClaimV2, type QueryClaimsV2Options } from "../../../core/src/retrieval_v2";

const V2_ONLY = new Set(["--format-version", "--max-bytes", "--baseline", "--no-baseline", "--symbol", "--route", "--category", "--tag"]);
export function usesV2Retrieval(args: string[], command: string): boolean {
  const additions = command === "query" ? ["--budget", "--task", "--changed-files", "--git-diff", "--depth", "--include-inferred", "--no-include-inferred"] : command === "context" ? ["--system", "--status", "--limit"] : ["--budget"];
  return args.some(arg => V2_ONLY.has(arg.split("=")[0]) || additions.includes(arg.split("=")[0]));
}

export async function runRetrievalV2Command(command: "query" | "context" | "show", args: string[], cwd?: string): Promise<CliResult> {
  // Error bounds must not depend on whether the cap appears before a malformed option.
  const caps = args.flatMap((arg, index) => arg === "--max-bytes" ? [args[index + 1]] : arg.startsWith("--max-bytes=") ? [arg.slice(12)] : []);
  const validCaps = caps.filter(value => value !== undefined && /^\d+$/.test(value)).map(Number).filter(value => resolveContextOutputCap({ maxBytes: value }) !== undefined);
  const errorCap = validCaps.reduce((cap, value) => Math.min(cap, value), 2048);
  const versions = args.flatMap((arg, index) => arg === "--format-version" ? [args[index + 1]] : arg.startsWith("--format-version=") ? [arg.slice(17)] : []);
  if (versions.length === 0) return contextOutputError("FORMAT_VERSION_REQUIRED", { message: "New retrieval options require --format-version 2.", maxBytes: errorCap });
  if (versions.length === 1 && versions[0] === "1") {
    const legacy = args.filter((arg, index) => arg !== "--format-version" && args[index - 1] !== "--format-version" && !arg.startsWith("--format-version="));
    if (usesV2Retrieval(legacy, command)) return contextOutputError("FORMAT_VERSION_REQUIRED", { message: "New retrieval options require --format-version 2.", maxBytes: errorCap });
    return command === "query" ? runQueryCommand(legacy, { cwd }) : command === "context" ? runContextCommand(legacy, { cwd }) : runShowCommand(legacy, { cwd });
  }
  let json = false;
  try {
    const options: QueryClaimsV2Options = { cwd, changedFiles: [], symbols: [], routes: [], filters: { systems: [], statuses: [] } };
    let positional: string | undefined;
    let version: string | undefined;
    const seen = new Set<string>();
    const single = (key: string) => { if (seen.has(key)) throw new Error(`${key} may appear only once.`); seen.add(key); };
    for (let i = 0; i < args.length; i++) {
      const raw = args[i];
      if (!raw.startsWith("--")) { single("positional text"); positional = raw; continue; }
      const equal = raw.indexOf("=");
      const key = equal < 0 ? raw : raw.slice(0, equal);
      const flag = ["--json", "--git-diff", "--baseline", "--no-baseline", "--include-inferred", "--no-include-inferred"].includes(key);
      if (flag) {
        if (equal >= 0) throw new Error(`${key} does not accept a value.`);
        single(key.replace("--no-", "--"));
        if (key === "--json") json = true;
        if (key === "--git-diff") options.gitDiff = true;
        if (key.endsWith("baseline")) options.baseline = key === "--baseline";
        if (key.endsWith("include-inferred")) options.includeInferred = key === "--include-inferred";
        continue;
      }
      if (key === "--include-stale") throw new Error("--include-stale is v1 only; use repeated --status in v2.");
      if (!["--format-version", "--task", "--changed-files", "--symbol", "--route", "--system", "--status", "--budget", "--max-bytes", "--limit", "--depth"].includes(key)) throw new Error(`Unknown ${command} v2 option: ${key}`);
      const value = equal >= 0 ? raw.slice(equal + 1) : args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value.`);
      if (key === "--changed-files") {
        options.changedFiles!.push(value);
        if (equal < 0) while (args[i + 1] && !args[i + 1].startsWith("--")) options.changedFiles!.push(args[++i]);
        continue;
      }
      if (key === "--symbol") { options.symbols!.push(value); continue; }
      if (key === "--route") { options.routes!.push(value); continue; }
      if (key === "--system") { options.filters!.systems!.push(value); continue; }
      if (key === "--status") { options.filters!.statuses!.push(value); continue; }
      single(key);
      if (key === "--format-version") version = value;
      if (key === "--task") options.task = value;
      if (key === "--budget") {
        if (!["small", "medium", "full"].includes(value)) throw new Error("budget must be small, medium or full.");
        options.budget = value as QueryClaimsV2Options["budget"];
      }
      if (["--max-bytes", "--limit", "--depth"].includes(key)) {
        if (!/^\d+$/.test(value)) {
          if (key === "--max-bytes") return contextOutputError("BUDGET_TOO_SMALL", { invalidCap: true, maxBytes: errorCap });
          throw new Error(`${key} must be an integer.`);
        }
        if (key === "--max-bytes") options.maxBytes = Number(value);
        if (key === "--limit") options.limit = Number(value);
        if (key === "--depth") options.depth = Number(value);
      }
    }
    if (version === undefined || version === "1") return contextOutputError("FORMAT_VERSION_REQUIRED", { message: "New retrieval options require --format-version 2.", maxBytes: errorCap });
    if (version !== "2") throw new Error("Supported format versions are 1 (legacy options) and 2.");
    if (command === "context" && positional !== undefined) throw new Error("context requires --task for task text.");
    if (command === "query" && positional !== undefined) {
      if (options.task !== undefined) throw new Error("Supply positional query text or --task, once.");
      options.query = positional;
    }
    if (command === "show" && (options.task !== undefined || options.changedFiles!.length || options.symbols!.length || options.routes!.length || options.filters!.systems!.length || options.filters!.statuses!.length || options.limit !== undefined || options.depth !== undefined || options.gitDiff !== undefined || options.baseline !== undefined || options.includeInferred !== undefined)) throw new Error("show v2 accepts one ID, --budget, --max-bytes, --format-version and --json.");
    const result = command === "show" ? await showClaimV2({ cwd, id: positional ?? "", budget: options.budget, maxBytes: options.maxBytes }) : command === "query" ? await queryClaimsV2(options) : await buildContextV2(options);
    return !json && result.exitCode === 0 ? { ...result, stdout: renderContextOutputHuman(result.model) } : result;
  } catch (error) { return contextOutputError("INVALID_INPUT", { message: error instanceof Error ? error.message : "Invalid retrieval input.", maxBytes: errorCap }); }
}
