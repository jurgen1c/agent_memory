import { canonicalMemoryContentDigest } from "./canonical_digest";
import crypto from "node:crypto";
import fs from "node:fs";
import { auditMemory, type AuditOptions, type AuditResult } from "./audit";
import { loadConfig } from "./config";
import { assertGlobalDatabaseProvenance, resolveConfiguredDatabaseLocation } from "./database";
import { boundedGitDiagnostic, isFullGitObjectId } from "./git";
import { verifyGitCommit, type GitVerificationDiagnostic, type VerificationCheckState } from "./git_verification";
import { canonicalMemoryFileInventory, resolveConfiguredPath } from "./files";
import { loadMemory } from "./memory";
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
  diagnostics: { code: string; message: string; remediation: string }[];
}
export interface AuditResultV2 extends AuditResult {
  formatVersion: 2;
  structure: AuditHealthDimension<"valid" | "invalid" | "unavailable">;
  cache: AuditHealthDimension<"fresh" | "stale" | "missing" | "unsupported" | "unavailable">;
  claims: AuditClaimHealth[];
}

export async function auditMemoryV2(options: AuditOptions = {}): Promise<AuditResultV2> {
  const result: AuditResultV2 = { formatVersion: 2, ok: false, changedFiles: options.changedFiles ?? [], findings: [], warnings: [],
    structure: { state: "unavailable", diagnostics: [] }, cache: { state: "unavailable", diagnostics: [] }, claims: [] };
  const diagnostic = (code: string, error: unknown, remediation: string) =>
    ({ code, message: boundedGitDiagnostic(error instanceof Error ? error.message : String(error)), remediation });
  let loaded: ReturnType<typeof loadConfig>;
  try { loaded = loadConfig({ cwd: options.cwd }); }
  catch (error) {
    result.structure.diagnostics.push(diagnostic("STRUCTURE_UNAVAILABLE", error, "Restore configuration and canonical memory access, then rerun."));
    return result;
  }
  const repoRoot = loaded.repo.root;
  try {
    const validation = validateRepository({ cwd: repoRoot });
    result.structure = { state: validation.valid ? "valid" : "invalid", diagnostics: validation.errors.map((issue) =>
      diagnostic(issue.code, issue.message, "Review the canonical source and validation finding.")) };
  } catch (error) {
    result.structure.diagnostics.push(diagnostic("STRUCTURE_UNAVAILABLE", error, "Restore canonical memory access and rerun."));
  }
  result.cache = await auditCacheHealth(loaded);
  try {
    const memory = loadMemory(repoRoot);
    const checks = new Map<string, GitVerificationDiagnostic>();
    result.claims = memory.claims.map((claim): AuditClaimHealth => {
      const reference = claim.raw.last_verified_commit;
      const missing = reference == null;
      const valid = typeof reference === "string" && isFullGitObjectId(reference);
      let check: GitVerificationDiagnostic | undefined;
      if (!missing) {
        const key = typeof reference === "string" ? reference : "";
        check = checks.get(key) ?? verifyGitCommit(repoRoot, key, { gitBinary: options.gitBinary, timeoutMs: options.gitTimeoutMs });
        checks.set(key, check);
      }
      return { id: claim.id, path: claim.sourcePath,
        verificationMetadata: missing ? "missing" : valid && check?.code !== "VERIFICATION_METADATA_MALFORMED" ? "present" : "malformed",
        verificationCheck: check?.state ?? "not_run", diagnostic: check, qualitySignals: claimQualitySignals(claim) };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (result.structure.state === "valid") {
      const audit = auditMemory(options);
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
