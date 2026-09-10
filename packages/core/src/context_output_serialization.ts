import type { ContextOutputErrorCode, ContextOutputModel, ContextOutputRequest, ContextOutputResult } from "./context_output_types";

export const CONTEXT_OUTPUT_PRESETS = { small: 4096, medium: 16384, full: 65536 } as const;
export const CONTEXT_OUTPUT_MIN_BYTES = 512;
export const CONTEXT_OUTPUT_MAX_BYTES = 16_777_216;

export function resolveContextOutputCap(request: Pick<ContextOutputRequest, "budget" | "maxBytes">): number | undefined {
  if (request.budget !== undefined && !Object.hasOwn(CONTEXT_OUTPUT_PRESETS, request.budget)) return undefined;
  const cap = request.maxBytes ?? CONTEXT_OUTPUT_PRESETS[request.budget ?? "medium"];
  return Number.isInteger(cap) && cap >= CONTEXT_OUTPUT_MIN_BYTES && cap <= CONTEXT_OUTPUT_MAX_BYTES ? cap : undefined;
}

/** Compact JSON and one LF; the decimal width of usedBytes participates in accounting. */
export function serializeContextOutput(model: ContextOutputModel): string {
  model.budget.usedBytes = 0;
  for (;;) {
    const output = `${JSON.stringify(model)}\n`;
    const bytes = Buffer.byteLength(output, "utf8");
    if (bytes === model.budget.usedBytes) return output;
    model.budget.usedBytes = bytes;
  }
}

/** Operational diagnostics are bounded separately, at Unicode character boundaries. */
export function boundContextDiagnostics(message: string): string {
  let result = "";
  let bytes = 0;
  for (const character of message) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 2048) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function contextOutputError(code: ContextOutputErrorCode, options: { invalidCap?: boolean; message?: string; maxBytes?: number; stderr?: string } = {}): ContextOutputResult {
  const exitCode = code === "BUDGET_TOO_SMALL" ? (options.invalidCap ? 2 : 7)
    : ["CLAIM_NOT_FOUND", "CACHE_MISSING"].includes(code) ? 3
    : code === "VALIDATION_FAILED" ? 4
    : ["CACHE_STALE", "CACHE_SCHEMA_UNSUPPORTED"].includes(code) ? 5 : 2;
  const model = { schemaVersion: 2 as const, error: { code, ...(code !== "BUDGET_TOO_SMALL" && options.message ? { message: options.message } : {}) } };
  let stdout = `${JSON.stringify(model)}\n`;
  const cap = Math.min(options.maxBytes ?? 2048, 2048);
  if (Buffer.byteLength(stdout) > cap) {
    delete model.error.message;
    stdout = `${JSON.stringify(model)}\n`;
  }
  return { exitCode, model, stdout, stderr: boundContextDiagnostics(options.stderr ?? "") };
}

/** Human rendering uses only the packed model and cannot add unbudgeted text. */
export function renderContextOutputHuman(model: ContextOutputModel): string {
  const lines = [
    `Context: ${model.mode}; task matches: ${model.taskMatches}; required context: ${model.completeness}`,
    `Filters: ${JSON.stringify(model.filters)}`,
    `Roots: ${JSON.stringify(model.roots)}`
  ];
  // Keep each full selected record: status, reasons, graph obligations, provenance,
  // and future additive metadata must not disappear in the human representation.
  for (const claim of model.claims) lines.push(`${claim.id}: ${claim.title}`, JSON.stringify(claim));
  lines.push(`Graph: ${JSON.stringify(model.edges)}`);
  for (const file of model.files) lines.push(`File: ${file.value}`, `Origins: ${JSON.stringify(file.origins)}`);
  for (const command of model.commands) lines.push(`Suggested, not run: ${command.value}`, `Origins: ${JSON.stringify(command.origins)}`);
  for (const name of ["recipes", "plans", "profiles"] as const) {
    const collection = model[name];
    lines.push(`${name}: ${collection.state}; eligible: ${collection.totalEligible}; matched: ${collection.matched}`);
    for (const item of collection.items) lines.push(JSON.stringify(item));
  }
  lines.push(`Budget: ${JSON.stringify(model.budget)}`, ...model.warnings);
  const text = `${lines.join("\n")}\n`;
  // JSON is the complete, bounded inspection fallback if a human layout expands it.
  return Buffer.byteLength(text) <= model.budget.maxBytes ? text : serializeContextOutput(model);
}
