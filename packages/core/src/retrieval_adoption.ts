import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalContentDigest } from "./canonical_digest";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { discoverCanonicalMemoryFiles, discoverFiles, pathMatchesPattern, toPosix } from "./files";
import { deriveRepositoryIdentity } from "./memory_key";
import { readMemoryClaim } from "./memory";
import { claimQualitySignals, type ClaimQualitySignal } from "./quality_signals";
import { findRepoRoot } from "./repo";
import { codexSkillReferenceFiles, isGeneratedAgentSkillFile, isGeneratedSkillReferenceFile, retrievalAdoptionReference } from "./skills";
import { prepareUpgrade, type PlannedUpgradeWrite, type UpgradeResult } from "./upgrade";
import { validateRepository } from "./validator";
import { PACKAGE_VERSION } from "./version";

export interface RetrievalAdoptionOptions { cwd?: string; force?: boolean }
export interface AdoptionClaim {
  id: string; path: string; fingerprint: string;
  verificationMetadata: "present" | "missing";
  verificationCheck: "not_run";
  signals: Array<ClaimQualitySignal | { code: "UNCATEGORIZED"; claimId: string; path: string; field: "tags"; text: string[]; severity: "advisory" }>;
  suggestedActions: string[];
}
export interface RetrievalAdoptionPlan extends UpgradeResult {
  schemaVersion: 2;
  packageVersion: string;
  adoption: {
    repositoryIdentity: string; mode: "local" | "global"; memoryKey: string | null; memoryRoot: string;
    inventoryDigest: string; supportFingerprint: string; claims: AdoptionClaim[];
    verificationCheck: "not_run";
    guidance: string[];
  };
}
interface Prepared { plan: RetrievalAdoptionPlan; writes: PlannedUpgradeWrite[] }

/** Read-only inventory. No database resolution, registry updates, cache creation or semantic guesses. */
export function planRetrievalAdoption(options: RetrievalAdoptionOptions = {}): RetrievalAdoptionPlan {
  return prepare(options).plan;
}

/** Re-plan all inputs before writing. Callers may retain a reviewed plan across turns. */
export function applyRetrievalAdoption(plan: RetrievalAdoptionPlan): RetrievalAdoptionPlan {
  let current: Prepared;
  try { current = prepare({ cwd: plan.repo.root, force: plan.force }); }
  catch (error) { throw stale(error); }
  if (JSON.stringify(current.plan) !== JSON.stringify(plan)) throw stale();
  applyWrites(current.writes);
  return { ...plan, write: true, actions: plan.actions.map(action => ({ ...action,
    status: action.status === "would_create" ? "created" : action.status === "would_update" ? "updated" : action.status })) };
}

function prepare(options: RetrievalAdoptionOptions): Prepared {
  try {
    const repo = findRepoRoot(options.cwd);
    safePath(repo.root, "agent-memory.config.yaml");
    const loaded = loadConfig({ repoRoot: repo.root });
    const memoryRoot = safePath(repo.root, loaded.config.memory_root, true);
    const canonicalPatterns = [...loaded.config.claims, ...loaded.config.graphs, ...loaded.config.indexes, ...loaded.config.recipes, ...loaded.config.plans, ...loaded.config.profiles, ...loaded.config.waivers];
    assertSafeTree(repo.root, memoryRoot, canonicalPatterns);
    const canonical = [...new Set(discoverCanonicalMemoryFiles(memoryRoot, loaded.config))];
    for (const file of canonical) safePath(repo.root, path.relative(repo.root, file));
    const validation = validateRepository({ cwd: repo.root });
    if (!validation.valid) throw invalid("Canonical memory is invalid. Run agent-memory validate.", validation.errors.map(issue => `${issue.code}: ${issue.path ?? ""} ${issue.message}`));
    const support = new Set<string>(["agent-memory.config.yaml", "bin/memory", ...loaded.config.agent_instructions.paths]);
    for (const skill of Object.values(loaded.config.agent_skills)) {
      if (!skill.enabled) continue;
      support.add(skill.path);
      for (const reference of [...codexSkillReferenceFiles("repo", loaded.config), { path: "references/retrieval-adoption.md" }]) support.add(path.join(path.dirname(skill.path), reference.path));
    }
    for (const file of support) safePath(repo.root, file);
    const prepared = prepareUpgrade({ cwd: repo.root, force: options.force ?? false });
    const guidance: string[] = [];
    for (const skill of Object.values(loaded.config.agent_skills)) {
      if (!skill.enabled) continue;
      const skillAction = prepared.result.actions.find(action => action.path === toPosix(skill.path));
      if (skillAction?.detail?.includes("disabled")) continue;
      const skillPath = safePath(repo.root, skill.path);
      const target = safePath(repo.root, path.join(path.dirname(skill.path), "references/retrieval-adoption.md"));
      const relative = toPosix(path.relative(repo.root, target));
      guidance.push(relative);
      const customSkill = fs.existsSync(skillPath) && !isGeneratedAgentSkillFile(fs.readFileSync(skillPath, "utf8"));
      const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      const content = retrievalAdoptionReference();
      if ((customSkill || (existing !== null && !isGeneratedSkillReferenceFile(existing))) && !options.force) {
        prepared.result.actions.push({ path: relative, status: "skipped", detail: "custom content requires --force; use packaged docs/features/category-retrieval/adoption.md" });
      } else if (existing === content) prepared.result.actions.push({ path: relative, status: "skipped", detail: "already current" });
      else { prepared.writes.push({ path: target, content }); prepared.result.actions.push({ path: relative, status: existing === null ? "created" : "updated", detail: "managed adoption guidance" }); }
    }
    for (const action of prepared.result.actions) if (!action.detail?.includes("skill disabled in config")) support.add(action.path);
    const protectedPaths = [...canonical, path.join(repo.root, ".git"), path.resolve(repo.root, loaded.config.database_path)];
    const targets = new Set<string>();
    for (const write of prepared.writes) {
      safePath(repo.root, path.relative(repo.root, write.path));
      const memoryRelative = toPosix(path.relative(memoryRoot, write.path));
      if (!memoryRelative.endsWith("/.gitkeep") && canonicalPatterns.some(pattern => pathMatchesPattern(pattern, memoryRelative))) throw invalid("Upgrade output would create canonical memory. Choose a separate support path.");
      if (protectedPaths.some(file => overlaps(file, write.path)) || [...targets].some(file => overlaps(file, write.path))) throw invalid("Upgrade outputs overlap canonical, protected or other support paths.");
      targets.add(write.path);
      let ancestor = path.dirname(write.path);
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      fs.accessSync(ancestor, fs.constants.W_OK | fs.constants.X_OK);
      if (fs.existsSync(write.path)) fs.accessSync(write.path, fs.constants.W_OK);
    }
    const supportFingerprint = hash([...support].sort().map(file => [toPosix(file), fileFingerprint(safePath(repo.root, file))]));
    const claims: AdoptionClaim[] = discoverFiles(memoryRoot, loaded.config.claims).map((file): AdoptionClaim => {
      const claim = readMemoryClaim(memoryRoot, file);
      const sourcePath = toPosix(path.relative(repo.root, file));
      const signals: AdoptionClaim["signals"] = claimQualitySignals({ ...claim, sourcePath });
      if (!claim.tags.some(tag => tag.startsWith("concern:"))) signals.push({ code: "UNCATEGORIZED", claimId: claim.id, path: sourcePath, field: "tags", text: claim.tags, severity: "advisory" });
      return { id: claim.id, path: sourcePath, fingerprint: hash(fs.readFileSync(file)), verificationMetadata: claim.raw.last_verified_commit == null ? "missing" : "present", verificationCheck: "not_run", signals,
        suggestedActions: signals.length ? ["Inspect the complete canonical body and eligible source within authorized scope.", "Propose and review specific metadata or required-edge diffs; never infer a verification commit from retrieval."] : [] };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const plan: RetrievalAdoptionPlan = { ...prepared.result, write: false,
      actions: prepared.result.actions.map(action => ({ ...action, status: action.status === "created" ? "would_create" : action.status === "updated" ? "would_update" : action.status })),
      schemaVersion: 2, packageVersion: PACKAGE_VERSION,
      adoption: { repositoryIdentity: deriveRepositoryIdentity(repo.root), mode: loaded.config.database_scope ?? "local", memoryKey: loaded.config.memory_key ?? null,
        memoryRoot: toPosix(path.relative(repo.root, memoryRoot)), inventoryDigest: canonicalContentDigest(loaded), supportFingerprint, claims, verificationCheck: "not_run", guidance } };
    return { plan, writes: prepared.writes };
  } catch (error) {
    if (error instanceof AgentMemoryError && error.code === "VALIDATION_FAILED") throw error;
    throw invalid(error instanceof Error ? error.message : "Cannot inventory canonical memory.");
  }
}

function safePath(root: string, relative: string, directory = false): string {
  const target = path.resolve(root, relative);
  const normalized = path.relative(root, target);
  if ((!normalized && !directory) || normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) throw invalid(`Adoption path must stay in this checkout: ${relative}`);
  if (!normalized) return target;
  let current = root;
  const parts = normalized.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) throw invalid(`Unsafe adoption path: ${relative}`);
  }
  return target;
}
function assertSafeTree(root: string, memoryRoot: string, patterns: string[], directory = memoryRoot): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const relative = toPosix(path.relative(memoryRoot, file));
    // Only canonical paths belong to this inventory; a root-level memory layout
    // may also contain unrelated source trees and dependency symlinks.
    const relevant = patterns.some(pattern => {
      if (pathMatchesPattern(pattern, relative)) return true;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
      const prefix = toPosix(pattern).split("*", 1)[0];
      return prefix.startsWith(`${relative}/`) || relative.startsWith(prefix);
    });
    if (!relevant) continue;
    safePath(root, path.relative(root, file), entry.isDirectory());
    if (entry.isDirectory()) assertSafeTree(root, memoryRoot, patterns, file);
  }
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`); }
function fileFingerprint(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return hash([stat.mode, stat.ino, stat.nlink, hash(fs.readFileSync(file))]);
}
function hash(value: unknown): string { return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function invalid(message: string, details?: string[]): AgentMemoryError { return new AgentMemoryError(message, { code: "VALIDATION_FAILED", exitCode: 4, details }); }
function stale(cause?: unknown): AgentMemoryError { return new AgentMemoryError("Adoption inputs changed. Rerun upgrade --adopt-retrieval --format-version 2 and review the new plan.", { code: "ADOPTION_PLAN_STALE", exitCode: 5, cause }); }

function applyWrites(writes: PlannedUpgradeWrite[]): void {
  const snapshots = writes.map(write => ({ ...write, previous: fs.existsSync(write.path) ? fs.readFileSync(write.path) : null, previousMode: fs.existsSync(write.path) ? fs.statSync(write.path).mode : undefined }));
  const directories: string[] = [];
  const attempted: typeof snapshots = [];
  try {
    for (const write of snapshots) {
      const missing: string[] = [];
      let parent = path.dirname(write.path);
      while (!fs.existsSync(parent)) { missing.unshift(parent); parent = path.dirname(parent); }
      for (const dir of missing) { fs.mkdirSync(dir); directories.push(dir); }
      attempted.push(write);
      fs.writeFileSync(write.path, write.content);
      if (write.mode !== undefined) fs.chmodSync(write.path, write.mode);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const write of attempted.reverse()) {
      try { if (write.previous === null) { if (fs.existsSync(write.path)) fs.unlinkSync(write.path); } else { fs.writeFileSync(write.path, write.previous); fs.chmodSync(write.path, write.previousMode!); } }
      catch (restore) { failures.push(String(restore)); }
    }
    for (const dir of directories.reverse()) { try { fs.rmdirSync(dir); } catch (restore) { failures.push(String(restore)); } }
    throw new AgentMemoryError(failures.length ? "Adoption write failed; rollback needs manual attention." : "Adoption write failed; original files restored.", { code: "ADOPTION_WRITE_FAILED", exitCode: 4, cause: error, details: failures });
  }
}
