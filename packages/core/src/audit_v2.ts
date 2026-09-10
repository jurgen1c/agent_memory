import { canonicalMemoryContentDigest } from "./canonical_digest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { auditClaimVerification, auditMemory, type AuditOptions, type AuditResult } from "./audit";
import { loadConfig } from "./config";
import { assertGlobalDatabaseProvenance, resolveConfiguredDatabaseLocation } from "./database";
import { boundedGitDiagnostic, isFullGitObjectId } from "./git";
import { createGitCommitVerifier, type GitVerificationDiagnostic, type VerificationCheckState } from "./git_verification";
import { canonicalMemoryFileInventory, configuredPathRelativeToRepo, discoverFiles, resolveConfiguredPath } from "./files";
import { readMemoryClaim, type MemoryClaim } from "./memory";
import { claimQualitySignals, type ClaimQualitySignal } from "./quality_signals";
import { openSqliteDatabase } from "./sqlite";
import { validateRepository } from "./validator";

export interface AuditClaimHealth {
  id: string;
  path: string;
  verificationMetadata: "present" | "missing" | "malformed";
  verificationCheck: VerificationCheckState;
  diagnostic?: GitVerificationDiagnostic;
  qualitySignals: ClaimQualitySignal[];
}
export interface AuditHealthDimension<T extends string> {
  state: T;
  diagnostics: { code: string; message: string; remediation: string; path?: string; id?: string }[];
}
export interface AuditResultV2 extends AuditResult {
  schemaVersion: 2;
  structure: AuditHealthDimension<"valid" | "invalid" | "unavailable">;
  cache: AuditHealthDimension<"fresh" | "stale" | "missing" | "unsupported" | "unavailable">;
  claims: AuditClaimHealth[];
}

export async function auditMemoryV2(options: AuditOptions = {}): Promise<AuditResultV2> {
  const result: AuditResultV2 = { schemaVersion: 2, ok: false, changedFiles: options.changedFiles ?? [], findings: [], warnings: [],
    structure: { state: "unavailable", diagnostics: [] }, cache: { state: "unavailable", diagnostics: [] }, claims: [] };
  const diagnostic = (code: string, error: unknown, remediation: string) =>
    ({ code, message: boundedGitDiagnostic(error instanceof Error ? error.message : String(error)), remediation });
  let loaded: ReturnType<typeof loadConfig>;
  let memoryRoot: string;
  try {
    loaded = loadConfig({ cwd: options.cwd });
    memoryRoot = resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root);
  }
  catch (error) {
    result.structure.diagnostics.push(diagnostic("STRUCTURE_UNAVAILABLE", error, "Restore configuration and canonical memory access, then rerun."));
    return result;
  }
  const repoRoot = loaded.repo.root;
  const accessFailures: AuditResultV2["structure"]["diagnostics"] = [];
  const accessFailure = (error: unknown, sourcePath?: string) => ({
    ...diagnostic("STRUCTURE_UNAVAILABLE", error, "Restore canonical memory access and rerun; retain canonical content and metadata."), path: sourcePath
  });
  try {
    fs.accessSync(memoryRoot, fs.constants.R_OK | fs.constants.X_OK);
    for (const sourcePath of canonicalMemoryFileInventory(memoryRoot, loaded.config)) {
      try { fs.accessSync(path.join(memoryRoot, sourcePath), fs.constants.R_OK); }
      catch (error) { accessFailures.push(accessFailure(error, sourcePath)); }
    }
    if (accessFailures.length > 0) result.structure = { state: "unavailable", diagnostics: accessFailures };
    else {
      const validation = validateRepository({ cwd: repoRoot });
      result.structure = { state: validation.valid ? "valid" : "invalid", diagnostics: validation.errors.map((issue) =>
        ({ ...diagnostic(issue.code, issue.message, "Review the canonical source and validation finding."), path: issue.path, id: issue.id })) };
    }
  } catch (error) {
    result.structure = { state: "unavailable", diagnostics: [accessFailure(error)] };
  }
  result.cache = await auditCacheHealth(loaded);
  try {
    const claims: MemoryClaim[] = [];
    for (const filePath of discoverFiles(memoryRoot, loaded.config.claims, {
      onDirectoryError: (directory, error) => {
        if (result.structure.state !== "unavailable") result.structure = { state: "unavailable", diagnostics: [] };
        result.structure.diagnostics.push(accessFailure(error, path.relative(memoryRoot, directory)));
      }
    })) {
      try { claims.push(readMemoryClaim(memoryRoot, filePath)); }
      catch (error) {
        const sourcePath = path.relative(memoryRoot, filePath);
        if (isFilesystemFailure(error)) {
          if (result.structure.state !== "unavailable") result.structure = { state: "unavailable", diagnostics: [] };
          if (!result.structure.diagnostics.some((item) => item.path === sourcePath)) result.structure.diagnostics.push(accessFailure(error, sourcePath));
        } else if (result.structure.state === "valid") {
          result.structure = { state: "invalid", diagnostics: [{ ...diagnostic("claim.parse", error, "Review the canonical claim syntax."), path: sourcePath }] };
        }
      }
    }
    const verify = createGitCommitVerifier(repoRoot, { gitBinary: options.gitBinary, timeoutMs: options.gitTimeoutMs });
    const checks = new Map<string, GitVerificationDiagnostic>();
    result.claims = claims.map((claim): AuditClaimHealth => {
      const rawReference = claim.raw.last_verified_commit;
      const reference = typeof rawReference === "string" ? rawReference.trim() : rawReference;
      const missing = reference == null;
      const valid = typeof reference === "string" && isFullGitObjectId(reference);
      let check: GitVerificationDiagnostic | undefined;
      if (!missing) {
        const key = typeof reference === "string" ? reference : "";
        check = checks.get(key) ?? verify(key);
        checks.set(key, check);
      }
      return { id: claim.id, path: claim.sourcePath,
        verificationMetadata: missing ? "missing" : valid && check?.code !== "VERIFICATION_METADATA_MALFORMED" ? "present" : "malformed",
        verificationCheck: check?.state ?? "not_run", diagnostic: check, qualitySignals: claimQualitySignals(claim) };
    }).sort((a, b) => a.id.localeCompare(b.id));
    {
      const audit = result.structure.state === "valid" ? auditMemory(options) : {
        ...auditClaimVerification(repoRoot, claims, configuredPathRelativeToRepo(repoRoot, loaded.config.memory_root), options),
        changedFiles: result.changedFiles
      };
      result.changedFiles = audit.changedFiles;
      result.warnings = audit.warnings;
      result.findings = audit.findings.filter((finding) => !["claim.last_verified_commit_invalid"].includes(finding.code));
      for (const finding of result.findings.filter((item) => item.code === "claim.verification_outdated")) {
        for (const claim of result.claims.filter((item) => finding.claimIds.includes(item.id))) {
          claim.qualitySignals.push({ code: "SOURCE_CHANGED_SINCE_VERIFICATION", claimId: claim.id, path: claim.path,
            field: "source_files", text: finding.shared_values.source_files ?? [], severity: "advisory" });
        }
      }
    }
  } catch (error) {
    result.findings.push({ ...diagnostic("AUDIT_CHECK_UNAVAILABLE", error, "Restore repository and canonical memory access; retain recorded metadata."),
      severity: "error", claimIds: [], paths: [], shared_values: {} });
  }
  result.ok = result.structure.state === "valid" && result.cache.state !== "unavailable" && result.cache.state !== "unsupported" &&
    result.findings.every((finding) => finding.severity !== "error") &&
    result.claims.every((claim) => claim.verificationCheck === "verified" || claim.verificationCheck === "not_run");
  return result;
}

export async function auditCacheHealth(loaded: ReturnType<typeof loadConfig>): Promise<AuditResultV2["cache"]> {
  const state = (value: AuditResultV2["cache"]["state"], message: string): AuditResultV2["cache"] => ({ state: value,
    diagnostics: value === "fresh" ? [] : [{ code: `CACHE_${value.toUpperCase()}`, message, remediation: "Restore cache access if needed, then run agent-memory compile." }] });
  try {
    const location = resolveConfiguredDatabaseLocation({ loaded });
    try { fs.accessSync(location.path, fs.constants.R_OK); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return state("missing", "Compiled cache is missing.");
      throw error;
    }
    const database = await openSqliteDatabase(location.path, { readonly: true });
    try {
      assertGlobalDatabaseProvenance(database, location, loaded, { includeConfigHash: false });
      const table = database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compile_metadata'");
      if (!table) return state("unsupported", "Cache metadata schema is missing.");
      const requiredTables = ["claims", "claim_files", "claim_symbols", "claim_tags", "claim_routes", "claim_relations",
        "indexes", "recipes", "recipe_claims", "profile_traits", "plan_templates", "plan_stages", "claims_fts",
        "recipes_fts", "plan_templates_fts", "profile_traits_fts"];
      const tables = new Set(database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
      if (requiredTables.some((name) => !tables.has(name))) return state("unsupported", "Required cache query tables are missing.");
      const metadata = new Map(database.all<{ key: string; value: string }>("SELECT key, value FROM compile_metadata").map((row) => [row.key, row.value]));
      if (metadata.get("schema_version") !== "1") return state("unsupported", "Cache schema version is unsupported.");
      const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
      const inventory = canonicalMemoryFileInventory(resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root), loaded.config);
      if (metadata.get("canonical_content_hash") !== canonicalMemoryContentDigest(resolveConfiguredPath(loaded.repo.root, loaded.config.memory_root), loaded.config) || metadata.get("canonical_files_hash") !== hash(JSON.stringify(inventory)) || metadata.get("config_hash") !== hash(fs.readFileSync(loaded.path, "utf8"))) {
        return state("stale", "Canonical inventory or configuration differs from the compiled cache.");
      }
      return state("fresh", "Cache matches canonical inventory.");
    } finally { database.close(); }
  } catch (error) { return state("unavailable", boundedGitDiagnostic(error instanceof Error ? error.message : String(error))); }
}

function isFilesystemFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" &&
    ["EACCES", "EPERM", "ENOENT", "EIO", "EMFILE", "ENFILE", "ENOTDIR", "EISDIR", "ELOOP", "ENAMETOOLONG", "EBUSY", "ESTALE"].includes(error.code);
}
