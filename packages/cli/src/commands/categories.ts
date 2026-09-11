import { listCategories, renderCategoriesHuman, type ListCategoriesOptions } from "../../../core/src/categories";
import { contextOutputError, resolveContextOutputCap } from "../../../core/src/context_output_serialization";
import type { CliResult } from "../router";

export async function runCategoriesCommand(args: string[], cwd?: string): Promise<CliResult> {
  const caps = args.flatMap((arg, index) => arg === "--max-bytes" ? [args[index + 1]] : arg.startsWith("--max-bytes=") ? [arg.slice(12)] : []);
  const errorCap = caps.filter(value => value !== undefined && /^\d+$/.test(value)).map(Number).filter(value => resolveContextOutputCap({ maxBytes: value }) !== undefined).reduce((cap, value) => Math.min(cap, value), 2048);
  try {
    if (args[0] !== "list") throw new Error("Use agent-memory categories list [--counts] [--system SYSTEM] [--status STATUS] [--json].");
    const options: ListCategoriesOptions = { cwd, filters: { systems: [], statuses: [] } };
    let json = false;
    const seen = new Set<string>();
    const single = (key: string) => { if (seen.has(key)) throw new Error(`${key} may appear only once.`); seen.add(key); };
    for (let i = 1; i < args.length; i++) {
      const [key, ...parts] = args[i].split("=");
      if (["--counts", "--json"].includes(key)) {
        single(key);
        if (parts.length) throw new Error(`${key} does not accept a value.`);
        if (key === "--counts") options.counts = true;
        else json = true;
        continue;
      }
      if (!["--system", "--status", "--budget", "--max-bytes", "--format-version"].includes(key)) throw new Error(`Unknown categories list option: ${key}`);
      const value = parts.length ? parts.join("=") : args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value.`);
      if (key === "--system") { options.filters!.systems!.push(value); continue; }
      if (key === "--status") { options.filters!.statuses!.push(value); continue; }
      single(key);
      if (key === "--format-version" && value !== "2") throw new Error("categories list is v2 only; omit --format-version or use 2.");
      if (key === "--budget") {
        if (!["small", "medium", "full"].includes(value)) throw new Error("budget must be small, medium or full.");
        options.budget = value as ListCategoriesOptions["budget"];
      }
      if (key === "--max-bytes") {
        if (!/^\d+$/.test(value) || resolveContextOutputCap({ maxBytes: Number(value) }) === undefined) return contextOutputError("BUDGET_TOO_SMALL", { invalidCap: true });
        options.maxBytes = Number(value);
      }
    }
    const result = await listCategories(options);
    return result.exitCode === 0 && !json ? { ...result, stdout: renderCategoriesHuman(result.model) } : result;
  } catch (error) {
    return contextOutputError("INVALID_INPUT", { message: error instanceof Error ? error.message : "Invalid categories input.", maxBytes: errorCap });
  }
}
