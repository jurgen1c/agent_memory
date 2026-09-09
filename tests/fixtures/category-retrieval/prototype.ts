/** AM-88 executable design model; deliberately not a package API or CLI. */
import { createHash } from "node:crypto";
import { parseMarkdown } from "../../../packages/core/src/markdown";

export const vocabulary: Record<string, string> = {
  security: "Authority, privacy, and access constraints",
  reliability: "Recovery, idempotency, and durable handoffs",
  billing: "Charges, entitlements, and usage accounting",
  localization: "Language and locale behavior",
  delivery: "Review and verification requirements"
};
export const caps = { small: 4096, medium: 16384, full: 65536 };
export interface Claim {
  id: string; system: string; status: string; title: string; claim: string;
  tags: string[]; source_files: string[]; verification: string[];
  body: string; sourcePath: string; requires: string[]; baseline?: boolean;
}
export interface Request {
  task?: string; files?: string[]; categories?: string[]; systems?: string[];
  statuses?: string[]; tags?: string[]; baseline?: boolean; maxBytes?: number;
  bodySearch?: boolean;
}
export function readClaim(raw: string, sourcePath: string): Claim {
  const parsed = parseMarkdown(raw);
  return { ...(parsed.frontmatter as Omit<Claim, "body" | "sourcePath">), body: parsed.body, sourcePath };
}
export function sections(claim: Claim) {
  const lines = claim.body.split("\n");
  const output: Array<{ heading: string; line: number; text: string }> = [];
  let current = { heading: "preamble", line: 1, text: "" };
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,6} /.test(line)) {
      if (current.text.trim()) output.push({ ...current, text: current.text.trim() });
      current = { heading: line.replace(/^#+ /, ""), line: index + 1, text: "" };
    } else current.text += line + "\n";
  });
  if (current.text.trim()) output.push({ ...current, text: current.text.trim() });
  return output;
}
export function categories(claim: Claim) {
  return claim.tags.filter(tag => tag.startsWith("concern:")).map(tag => tag.slice(8)).sort();
}
export function categoryCounts(claims: Claim[]) {
  return [...Object.keys(vocabulary), "uncategorized"].sort().map(id => ({
    id, description: vocabulary[id] ?? "No authored concern tag",
    count: claims.filter(claim => id === "uncategorized" ? !categories(claim).length : categories(claim).includes(id)).length
  }));
}
const terms = (value: string) => [...new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
const lifecycleRank = (status: string) => ({ current: 0, needs_review: 1, proposed: 2 })[status] ?? 3;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) + "\n", "utf8");
function outside(claim: Claim, request: Request) {
  const result: string[] = [];
  const member = categories(claim);
  if (request.categories?.length && !request.categories.some(category => category === "uncategorized" ? member.length === 0 : member.includes(category))) result.push("category");
  if (request.systems?.length && !request.systems.includes(claim.system)) result.push("system");
  if (!(request.statuses ?? ["current", "proposed", "needs_review"]).includes(claim.status)) result.push("status");
  if (request.tags?.length && !request.tags.some(tag => claim.tags.includes(tag))) result.push("tag");
  return result;
}
export function retrieve(claims: Claim[], request: Request, watched: string[] = []) {
  const cap = request.maxBytes ?? caps.medium;
  if (!Number.isSafeInteger(cap) || cap < 512 || cap > 16777216) throw new Error("BUDGET_TOO_SMALL: --max-bytes must be an integer >= 512");
  for (const category of request.categories ?? []) {
    if (!Object.hasOwn(vocabulary, category) && category !== "uncategorized") throw new Error("UNKNOWN_CATEGORY: browse categories list");
  }
  const appliedFilters = {
    categories: [...new Set(request.categories ?? [])].sort(), systems: [...new Set(request.systems ?? [])].sort(),
    statuses: [...new Set(request.statuses ?? ["current", "proposed", "needs_review"])].sort(), tags: [...new Set(request.tags ?? [])].sort()
  };
  const words = terms(request.task ?? "");
  const browse = !words.length && !request.files?.length;
  if (browse && !appliedFilters.categories.length && !appliedFilters.systems.length && !appliedFilters.tags.length && !request.statuses?.length) throw new Error("INPUT_REQUIRED: provide task, files, or filter");
  const ranked = claims.filter(claim => !outside(claim, request).length).map(claim => {
    const tokens = terms([claim.title, claim.claim, request.bodySearch === false ? "" : claim.body].join(" "));
    const hits = words.filter(word => tokens.some(token => token.startsWith(word)));
    const text = hits.reduce((sum, word) => sum + Math.log(1 + claims.length / (1 + claims.filter(other => terms(other.title + " " + other.claim + " " + (request.bodySearch === false ? "" : other.body)).some(token => token.startsWith(word))).length)), 0);
    const exact = request.files?.some(file => claim.source_files.includes(file)) ?? false;
    const broad = request.files?.some(file => watched.some(prefix => file.startsWith(prefix))) ?? false;
    return { claim, tier: exact ? 3 : text > 0 ? 2 : broad ? 1 : 0, text, hits,
      code: exact ? "EXACT_SOURCE" : text > 0 ? "TEXT_MATCH" : broad ? "WATCHED_INDEX" : "FILTER_BROWSE" };
  }).filter(row => browse || row.tier > 0).sort((a, b) => b.tier - a.tier || b.text - a.text || (browse ? lifecycleRank(a.claim.status) - lifecycleRank(b.claim.status) || (a.claim.status < b.claim.status ? -1 : a.claim.status > b.claim.status ? 1 : 0) : 0) || (a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0));
  type Selected = { claim: Claim; code: string; outsideFilters: string[] };
  const selected = new Map<string, Selected>();
  const edges = new Map<string, { from: string; to: string; relation: string }>();
  const missing = new Set<string>();
  function expand(claim: Claim, code: string) {
    if (selected.has(claim.id)) return;
    selected.set(claim.id, { claim, code, outsideFilters: outside(claim, request) });
    for (const id of [...new Set(claim.requires)].sort()) {
      edges.set(`${claim.id}\0${id}`, { from: claim.id, to: id, relation: "requires" });
      const required = claims.find(candidate => candidate.id === id);
      if (required) expand(required, "REQUIRED_DEPENDENCY");
      else missing.add(id);
    }
  }
  // Expand each highest-ranked root's authored closure before optional roots.
  for (const row of ranked) expand(row.claim, row.code);
  if (!ranked.length && request.baseline) {
    for (const claim of claims.filter(claim => claim.baseline && !outside(claim, request).length).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) expand(claim, "BASELINE_FALLBACK");
  }
  const payloads = [...selected.values()].map(({ claim, code, outsideFilters }) => ({
    id: claim.id, system: claim.system, status: claim.status, categories: categories(claim), title: claim.title,
    statement: claim.claim, reason: { code, outsideFilters },
    provenance: { sourcePath: claim.sourcePath, sha256: createHash("sha256").update(claim.body).digest("hex"), semantics: "authored_not_verified" },
    sections: sections(claim).map(section => ({ ...section, sourcePath: claim.sourcePath, claimId: claim.id })),
    verification: "not_run"
  }));
  const files = [...new Set([...selected.values()].flatMap(({ claim }) => claim.source_files))].map(file => ({
    path: file, claimIds: [...selected.values()].filter(({ claim }) => claim.source_files.includes(file)).map(({ claim }) => claim.id)
  }));
  const commands = [...new Set([...selected.values()].flatMap(({ claim }) => claim.verification))].map(command => ({
    command, claimIds: [...selected.values()].filter(({ claim }) => claim.verification.includes(command)).map(({ claim }) => claim.id), state: "suggested_not_run"
  }));
  const directMatches = browse ? 0 : ranked.filter(row => row.tier >= 2).length;
  const response = {
    schemaVersion: 2, appliedFilters, mode: browse ? "browse" : "task", taskMatches: directMatches,
    completeness: "complete", claims: payloads, edges: [...edges.values()], files, commands,
    collections: { recipes: "empty", plans: "empty", profiles: "empty" },
    warnings: browse || directMatches ? [] : ["NO_TASK_MATCH"], suggestions: browse || directMatches ? [] : ["Use fewer task terms or exact source files; browse categories list."],
    budget: { capBytes: cap, usedBytes: 0, omitted: { claims: 0, requiredClaims: missing.size, edges: 0, files: 0, commands: 0 } }
  };
  function measure() {
    // Solve the small decimal-width fixed point, including newline and usedBytes itself.
    for (let i = 0; i < 8; i++) {
      const bytes = size(response);
      if (bytes === response.budget.usedBytes) return bytes;
      response.budget.usedBytes = bytes;
    }
    return size(response);
  }
  const requiredIds = new Set([...edges.values()].map(edge => edge.to));
  if (missing.size) { response.completeness = "incomplete"; response.warnings.push("REQUIRED_CONTEXT_MISSING"); }
  if ([...selected.values()].some(({ claim }) => requiredIds.has(claim.id) && !["current", "proposed", "needs_review"].includes(claim.status))) {
    response.completeness = "incomplete"; response.warnings.push("REQUIRED_CONTEXT_INACTIVE");
  }
  while (measure() > cap) {
    if (response.commands.length) { response.commands.pop(); response.budget.omitted.commands++; }
    else if (response.files.length) { response.files.pop(); response.budget.omitted.files++; }
    else if (response.claims.length) {
      const removed = response.claims.pop()!;
      response.budget.omitted.claims++;
      if (requiredIds.has(removed.id)) {
        response.budget.omitted.requiredClaims++;
        response.completeness = "incomplete";
        if (!response.warnings.includes("REQUIRED_CONTEXT_OMITTED")) response.warnings.push("REQUIRED_CONTEXT_OMITTED");
      }
      const retained = response.edges.filter(edge => edge.from !== removed.id && edge.to !== removed.id);
      if (retained.length < response.edges.length) {
        response.completeness = "incomplete";
        if (!response.warnings.includes("REQUIRED_CONTEXT_OMITTED")) response.warnings.push("REQUIRED_CONTEXT_OMITTED");
      }
      response.budget.omitted.edges += response.edges.length - retained.length;
      response.edges = retained;
    } else throw new Error("BUDGET_TOO_SMALL: response envelope exceeds cap");
    if (!response.warnings.includes("OUTPUT_TRUNCATED")) response.warnings.push("OUTPUT_TRUNCATED");
  }
  return response;
}

export function gitDiagnostic(result: { error?: string; status: number | null; stdout: string; unknownObject?: boolean; objectType?: string }, expectedOid = "a".repeat(40)) {
  const code = result.error === "EPERM" || result.error === "EACCES" ? "GIT_PERMISSION_DENIED"
    : result.error === "ENOENT" ? "GIT_EXECUTABLE_MISSING"
    : result.error === "ETIMEDOUT" ? "GIT_TIMEOUT"
    : result.error || result.status === null ? "GIT_UNAVAILABLE"
    : result.unknownObject ? "GIT_UNKNOWN_OBJECT"
    : result.status !== 0 ? "GIT_CHECK_FAILED"
    : result.objectType !== undefined && result.objectType !== "commit" ? "GIT_NOT_COMMIT"
    : !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(result.stdout.trim()) || result.stdout.trim().toLowerCase() !== expectedOid.toLowerCase() ? "GIT_INVALID_OUTPUT" : "GIT_VERIFIED";
  return { code, state: code === "GIT_VERIFIED" ? "verified" : code === "GIT_UNKNOWN_OBJECT" ? "invalid_reference" : "unavailable",
    repairReference: code === "GIT_UNKNOWN_OBJECT", errorCode: result.error ?? null, status: result.status };
}

/** Review-only adoption inventory. No paths are opened, writes performed or commands executed. */
export function adoptionPlan(claims: Claim[], registryMode: "local" | "global") {
  return { schemaVersion: 2, registryMode, writesCanonical: false, requiresReview: true,
    entries: [...claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(claim => ({
      id: claim.id, sourcePath: claim.sourcePath,
      fingerprint: createHash("sha256").update(JSON.stringify(claim)).digest("hex"),
      signals: [...(!categories(claim).length ? ["UNCATEGORIZED"] : []),
        ...(claim.tags.length === 1 && claim.tags[0] === claim.id ? ["ID_ONLY_TAGS"] : []),
        ...(claim.claim.includes("preserves the documented data contract") ? ["GENERIC_SUMMARY"] : [])],
      action: "inspect_source_and_propose_diff", inferredCategories: [], verification: "not_run"
    })) };
}
