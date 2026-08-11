import fs from "node:fs";
import path from "node:path";
import { replaceFileAtomicallySync } from "@jurgen1c/agent-core/filesystem";
import {
  isPathInside,
  nearestExistingAncestor,
  PathContainmentError,
  resolveContainedPath
} from "@jurgen1c/agent-core/repository";
import { sqliteArtifactPaths } from "@jurgen1c/agent-core/sqlite";
import { loadConfig } from "./config";
import { AgentMemoryError } from "./errors";
import { runGit } from "./git";
import { isGeneratedMemoryHook, renderMemoryHook } from "./hooks";
import { buildAgentsMemoryContent, detectGeneratedWrapperPackageManager } from "./init";
import { deriveInitMemoryKey, deriveRepositoryIdentity } from "./memory_key";
import { resolveRepoOutputPath } from "./repo";
import {
  codexSkillReferenceFiles,
  isGeneratedAgentSkillFile,
  isGeneratedSkillReferenceFile,
  renderAgentSkill,
  type AgentTarget
} from "./skills";
import type { AgentMemoryConfig, RepoInfo } from "./types";
import { inspectRepositoryWrapper, tryReadRepositoryWrapper } from "./wrapper";
import { parseYaml, setYamlPathValue, setYamlTopLevelValue } from "./yaml";

export interface GlobalMigrationOptions {
  cwd?: string;
  write: boolean;
  force: boolean;
  memoryKey?: string;
}

export type GlobalMigrationActionStatus =
  | "created"
  | "updated"
  | "would_create"
  | "would_update"
  | "skipped"
  | "preserved";

export interface GlobalMigrationAction {
  path: string;
  kind: "config" | "instructions" | "skill" | "skill_reference" | "hook" | "wrapper" | "local_database";
  status: GlobalMigrationActionStatus;
  detail: string;
}

export interface GlobalMigrationWrapperStatus {
  path: string;
  classification: "generated" | "custom" | "missing";
  safeToRemoveManually: boolean;
}

export interface GlobalMigrationResult {
  repo: RepoInfo;
  write: boolean;
  force: boolean;
  memoryKey: string;
  alreadyGlobal: boolean;
  actions: GlobalMigrationAction[];
  warnings: string[];
  wrapper: GlobalMigrationWrapperStatus;
  nextCommands: string[];
  cleanupGuidance?: string;
}

interface PlannedFileChange {
  absolutePath: string;
  content: string;
  mode?: number;
}

interface FileSnapshot {
  absolutePath: string;
  existed: boolean;
  content?: string;
  mode?: number;
}

const AGENT_TARGETS = ["codex", "generic"] satisfies AgentTarget[];

export function migrateRepositoryToGlobal(options: GlobalMigrationOptions): GlobalMigrationResult {
  const loaded = loadConfig({ cwd: options.cwd });
  const repo = loaded.repo;
  const originalConfig = loaded.config;
  const alreadyGlobal = originalConfig.version === 2 && originalConfig.database_scope === "global";
  const warnings = [...repo.warnings];
  const actions: GlobalMigrationAction[] = [];
  const changes: PlannedFileChange[] = [];
  const configPath = path.join(repo.root, "agent-memory.config.yaml");
  const rawConfig = fs.readFileSync(configPath, "utf8");
  const memoryKey = resolveMigrationMemoryKey(repo.root, originalConfig, options.memoryKey);
  const targetConfig: AgentMemoryConfig = {
    ...structuredClone(originalConfig),
    version: 2,
    memory_key: memoryKey,
    database_scope: "global"
  };
  const preservedLegacyMissingAgent = preserveLegacySingleAgentSelection(
    repo.root,
    rawConfig,
    targetConfig,
    warnings
  );

  planConfigMigration(configPath, rawConfig, targetConfig, preservedLegacyMissingAgent, options, actions, changes);
  planInstructionMigration(repo.root, targetConfig, options, actions, changes, warnings);
  planSkillMigration(repo.root, targetConfig, options, actions, changes, warnings);
  planHookMigration(repo, targetConfig, options, actions, changes, warnings);
  const migrationApplied = options.write || (alreadyGlobal && changes.length === 0);
  const cleanupSafe = migrationApplied && !hasUnresolvedSupportRewrites(actions);
  const writeCommand = migrationWriteCommand(memoryKey, options.force);

  const wrapper = inspectMigrationWrapper(repo.root, cleanupSafe);
  actions.push({
    path: wrapper.path,
    kind: "wrapper",
    status: "preserved",
    detail: wrapperDetail(wrapper, cleanupSafe)
  });

  const absoluteLocalDatabasePath = path.isAbsolute(originalConfig.database_path)
    ? path.normalize(originalConfig.database_path)
    : path.resolve(repo.root, originalConfig.database_path);
  const localDatabasePath = displayPath(repo.root, absoluteLocalDatabasePath);
  actions.push({
    path: localDatabasePath,
    kind: "local_database",
    status: "preserved",
    detail: fs.existsSync(absoluteLocalDatabasePath)
      ? "existing local generated database is unchanged"
      : "configured local database path is unchanged; no database exists"
  });

  assertNoConflictingChanges(changes);
  assertNoProtectedPathChanges(changes, [
    { absolutePath: path.join(repo.root, "bin/memory"), label: "bin/memory wrapper" },
    ...sqliteArtifactPaths(absoluteLocalDatabasePath).map((artifactPath) => ({
      absolutePath: artifactPath,
      label: artifactPath === absoluteLocalDatabasePath
        ? "configured local database"
        : "configured local database sidecar"
    }))
  ]);
  if (options.write) applyFileChanges(changes);

  return {
    repo,
    write: options.write,
    force: options.force,
    memoryKey,
    alreadyGlobal,
    actions,
    warnings,
    wrapper,
    nextCommands: !options.write && changes.length > 0
      ? [writeCommand]
      : ["agent-memory sync", "agent-memory doctor"],
    ...(cleanupSafe && wrapper.classification === "generated"
      ? { cleanupGuidance: "The generated bin/memory wrapper is safe to remove manually after global sync and doctor succeed." }
      : migrationApplied && wrapper.classification === "custom"
        ? { cleanupGuidance: "The custom bin/memory wrapper was preserved and requires manual review before any cleanup." }
        : {})
  };
}

function hasUnresolvedSupportRewrites(actions: GlobalMigrationAction[]): boolean {
  return actions.some((action) =>
    action.status === "skipped"
    && ["instructions", "skill", "skill_reference", "hook"].includes(action.kind)
    && [
      "custom content requires --force",
      "disabled custom content requires manual review",
      "unconfigured custom hook references bin/memory",
      "unconfigured hook symlink requires manual review",
      "not a regular file",
      "git repository not found",
      "installed hooks could not be inspected"
    ].includes(action.detail)
  );
}

function migrationWriteCommand(memoryKey: string, force: boolean): string {
  return [
    "agent-memory upgrade --global --write",
    ...(force ? ["--force"] : []),
    "--memory-key",
    memoryKey
  ].join(" ");
}

function resolveMigrationMemoryKey(
  repoRoot: string,
  config: AgentMemoryConfig,
  explicitMemoryKey: string | undefined
): string {
  deriveRepositoryIdentity(repoRoot);
  if (config.memory_key !== undefined) {
    const current = config.memory_key;
    if (explicitMemoryKey !== undefined && explicitMemoryKey !== current) {
      throw new AgentMemoryError("Global migration cannot replace a committed memory_key.", {
        details: ["Use the existing key, or handle key changes through the collision-repair workflow."]
      });
    }
    return current;
  }

  return deriveInitMemoryKey({ repoRoot, explicitMemoryKey });
}

function planConfigMigration(
  configPath: string,
  rawConfig: string,
  targetConfig: AgentMemoryConfig,
  preservedLegacyMissingAgent: AgentTarget | undefined,
  options: GlobalMigrationOptions,
  actions: GlobalMigrationAction[],
  changes: PlannedFileChange[]
): void {
  let content = setYamlTopLevelValue(rawConfig, "version", 2);
  content = setYamlTopLevelValue(content, "memory_key", targetConfig.memory_key as string);
  content = setYamlTopLevelValue(content, "database_scope", "global");
  if (preservedLegacyMissingAgent !== undefined) {
    content = setYamlPathValue(content, ["agent_skills", preservedLegacyMissingAgent, "enabled"], false);
  }
  planFileChange({
    absolutePath: configPath,
    displayPath: "agent-memory.config.yaml",
    kind: "config",
    content,
    options,
    actions,
    changes,
    detail: "set version 2, memory_key, and global database scope"
  });
}

function preserveLegacySingleAgentSelection(
  repoRoot: string,
  rawConfig: string,
  config: AgentMemoryConfig,
  warnings: string[]
): AgentTarget | undefined {
  const parsedConfig = parseYaml(rawConfig);
  if (Array.isArray(parsedConfig) || parsedConfig === null || typeof parsedConfig !== "object") return undefined;
  if (parsedConfig.version !== undefined && parsedConfig.version !== 1) return undefined;

  const enabledAgents = AGENT_TARGETS.filter((agent) => config.agent_skills[agent].enabled);
  if (enabledAgents.length !== AGENT_TARGETS.length) return undefined;

  const installedAgents = enabledAgents.filter((agent) => {
    try {
      return inspectFile(resolveRepoOutputPath(repoRoot, config.agent_skills[agent].path)).kind === "file";
    } catch {
      return false;
    }
  });
  if (installedAgents.length !== 1) return undefined;

  const existingAgent = installedAgents[0];
  const missingAgent = enabledAgents.find((agent) => agent !== existingAgent) as AgentTarget;
  config.agent_skills[missingAgent].enabled = false;
  warnings.push(
    `Preserved legacy single-agent install: disabled ${missingAgent} skill because only the ${existingAgent} skill is installed.`
  );
  return missingAgent;
}

function planInstructionMigration(
  repoRoot: string,
  config: AgentMemoryConfig,
  options: GlobalMigrationOptions,
  actions: GlobalMigrationAction[],
  changes: PlannedFileChange[],
  warnings: string[]
): void {
  for (const configuredPath of config.agent_instructions.paths) {
    const absolutePath = resolveRepoOutputPath(repoRoot, configuredPath);
    const display = displayPath(repoRoot, absolutePath);
    const state = inspectFile(absolutePath);
    if (state.kind === "other") {
      warnings.push(`Agent instruction path ${display} is not a regular file; skipping.`);
      actions.push({ path: display, kind: "instructions", status: "skipped", detail: "not a regular file" });
      continue;
    }
    const update = buildAgentsMemoryContent(state.content ?? "", config, "agent-memory");
    planFileChange({
      absolutePath,
      displayPath: display,
      kind: "instructions",
      content: update.content,
      options,
      actions,
      changes,
      detail: update.detail
    });
  }
}

function planSkillMigration(
  repoRoot: string,
  config: AgentMemoryConfig,
  options: GlobalMigrationOptions,
  actions: GlobalMigrationAction[],
  changes: PlannedFileChange[],
  warnings: string[]
): void {
  for (const agent of AGENT_TARGETS) {
    const skill = config.agent_skills[agent];
    const absolutePath = resolveRepoOutputPath(repoRoot, skill.path);
    const display = displayPath(repoRoot, absolutePath);
    const state = inspectFile(absolutePath);
    if (!skill.enabled && state.kind === "missing") {
      actions.push({ path: display, kind: "skill", status: "skipped", detail: `${agent} skill disabled in config` });
      continue;
    }
    if (state.kind === "other") {
      warnings.push(`Skill path ${display} is not a regular file; skipping.`);
      actions.push({ path: display, kind: "skill", status: "skipped", detail: "not a regular file" });
      continue;
    }
    const generatedSkill = state.content !== undefined && isGeneratedAgentSkillFile(state.content);
    if (!skill.enabled && !generatedSkill && !options.force) {
      warnings.push(`Disabled skill file ${display} does not look generated; preserving it for manual review.`);
      actions.push({
        path: display,
        kind: "skill",
        status: "skipped",
        detail: "disabled custom content requires manual review"
      });
      continue;
    }
    if (state.content !== undefined && !options.force && !generatedSkill) {
      warnings.push(`Skill file ${display} does not look generated; skipping to avoid overwriting user content.`);
      actions.push({ path: display, kind: "skill", status: "skipped", detail: "custom content requires --force" });
      continue;
    }

    planFileChange({
      absolutePath,
      displayPath: display,
      kind: "skill",
      content: renderAgentSkill({ agent, config, commandPrefix: "agent-memory" }),
      options,
      actions,
      changes,
      detail: !skill.enabled
        ? generatedSkill
          ? "refresh installed disabled generated skill for global mode"
          : "replace installed disabled custom skill for global mode"
        : state.kind === "missing" ? "install global-mode skill" : "refresh generated skill for global mode"
    });

    if (agent === "codex") {
      const skillDirectory = path.dirname(absolutePath);
      for (const reference of codexSkillReferenceFiles("repo", config)) {
        const referencePath = resolveSkillReferencePath(repoRoot, skillDirectory, reference.path);
        const referenceDisplay = displayPath(repoRoot, referencePath);
        const referenceState = inspectFile(referencePath);
        if (referenceState.kind === "other") {
          warnings.push(`Skill reference ${referenceDisplay} is not a regular file; skipping.`);
          actions.push({ path: referenceDisplay, kind: "skill_reference", status: "skipped", detail: "not a regular file" });
          continue;
        }
        if (referenceState.content !== undefined && !options.force && !isGeneratedSkillReferenceFile(referenceState.content)) {
          warnings.push(`Skill reference ${referenceDisplay} does not look generated; skipping to avoid overwriting user content.`);
          actions.push({ path: referenceDisplay, kind: "skill_reference", status: "skipped", detail: "custom content requires --force" });
          continue;
        }
        planFileChange({
          absolutePath: referencePath,
          displayPath: referenceDisplay,
          kind: "skill_reference",
          content: reference.content,
          options,
          actions,
          changes,
          detail: referenceState.kind === "missing" ? "install generated skill reference" : "refresh generated skill reference"
        });
      }
    }
  }
}

function planHookMigration(
  repo: RepoInfo,
  config: AgentMemoryConfig,
  options: GlobalMigrationOptions,
  actions: GlobalMigrationAction[],
  changes: PlannedFileChange[],
  warnings: string[]
): void {
  if (repo.detectedBy !== "git") {
    if (config.git.install_hooks) {
      warnings.push("Git hooks are configured, but this directory is not inside a Git repository.");
      actions.push({ path: ".git/hooks", kind: "hook", status: "skipped", detail: "git repository not found" });
    } else {
      actions.push({ path: ".git/hooks", kind: "hook", status: "skipped", detail: "hook installation disabled in config" });
    }
    return;
  }

  const hookNames = new Set(config.git.hooks);
  for (const hookName of discoverInstalledGeneratedHookNames(repo.root, hookNames, actions, warnings)) {
    hookNames.add(hookName);
  }

  for (const hookName of hookNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hookName)) {
      warnings.push(`Skipping invalid configured hook name: ${JSON.stringify(hookName)}.`);
      continue;
    }
    const hookPath = resolveHookPath(repo.root, hookName);
    if (hookPath === null) {
      warnings.push(`Could not resolve git hook path for ${hookName}.`);
      continue;
    }
    const state = inspectFile(hookPath.absolutePath);
    if (state.kind === "missing") {
      actions.push({
        path: hookPath.displayPath,
        kind: "hook",
        status: "skipped",
        detail: config.git.install_hooks ? "hook is not installed" : "hook installation disabled; missing hook remains uninstalled"
      });
      continue;
    }
    if (state.kind === "other") {
      warnings.push(`Git hook ${hookPath.displayPath} is not a regular file; skipping.`);
      actions.push({ path: hookPath.displayPath, kind: "hook", status: "skipped", detail: "not a regular file" });
      continue;
    }
    if (state.content !== undefined && !options.force && !isGeneratedMemoryHook(state.content)) {
      warnings.push(`Git hook ${hookPath.displayPath} does not look generated; skipping to avoid overwriting user content.`);
      actions.push({ path: hookPath.displayPath, kind: "hook", status: "skipped", detail: "custom content requires --force" });
      continue;
    }
    planFileChange({
      absolutePath: hookPath.absolutePath,
      displayPath: hookPath.displayPath,
      kind: "hook",
      content: renderMemoryHook("agent-memory"),
      mode: 0o755,
      options,
      actions,
      changes,
      detail: "refresh generated hook for global mode"
    });
  }
}

function discoverInstalledGeneratedHookNames(
  repoRoot: string,
  configuredHookNames: ReadonlySet<string>,
  actions: GlobalMigrationAction[],
  warnings: string[]
): string[] {
  let hooksDirectory: string;
  try {
    const configuredPath = runGit(repoRoot, ["rev-parse", "--git-path", "hooks"]);
    hooksDirectory = path.isAbsolute(configuredPath)
      ? path.normalize(configuredPath)
      : path.resolve(repoRoot, configuredPath);
  } catch {
    warnings.push("Could not inspect installed Git hooks for wrapper dependencies.");
    actions.push({
      path: ".git/hooks",
      kind: "hook",
      status: "skipped",
      detail: "installed hooks could not be inspected"
    });
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(hooksDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    warnings.push(`Could not inspect installed Git hooks at ${displayPath(repoRoot, hooksDirectory)}.`);
    actions.push({
      path: displayPath(repoRoot, hooksDirectory),
      kind: "hook",
      status: "skipped",
      detail: "installed hooks could not be inspected"
    });
    return [];
  }

  const generatedHookNames: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue;
    const hookPath = path.join(hooksDirectory, entry.name);
    if (
      entry.isSymbolicLink()
      && !entry.name.endsWith(".sample")
      && !configuredHookNames.has(entry.name)
    ) {
      const hookDisplay = displayPath(repoRoot, hookPath);
      warnings.push(`Unconfigured Git hook ${hookDisplay} is a symbolic link; manual review is required.`);
      actions.push({
        path: hookDisplay,
        kind: "hook",
        status: "skipped",
        detail: "unconfigured hook symlink requires manual review"
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const state = inspectFile(hookPath);
    if (state.content === undefined) continue;
    if (isGeneratedMemoryHook(state.content)) {
      generatedHookNames.push(entry.name);
      continue;
    }
    if (!configuredHookNames.has(entry.name) && state.content.includes("bin/memory")) {
      const hookDisplay = displayPath(repoRoot, hookPath);
      warnings.push(`Unconfigured custom Git hook ${hookDisplay} still references bin/memory; manual review is required.`);
      actions.push({
        path: hookDisplay,
        kind: "hook",
        status: "skipped",
        detail: "unconfigured custom hook references bin/memory"
      });
    }
  }
  return generatedHookNames;
}

function resolveHookPath(repoRoot: string, hookName: string): { absolutePath: string; displayPath: string } | null {
  try {
    const output = runGit(repoRoot, ["rev-parse", "--git-path", `hooks/${hookName}`]);
    const absolutePath = path.isAbsolute(output) ? path.normalize(output) : path.resolve(repoRoot, output);
    return { absolutePath, displayPath: displayPath(repoRoot, absolutePath) };
  } catch {
    return null;
  }
}

function inspectMigrationWrapper(repoRoot: string, migrationApplied: boolean): GlobalMigrationWrapperStatus {
  const wrapperPath = path.join(repoRoot, "bin/memory");
  try {
    resolveContainedPath(repoRoot, wrapperPath, {
      rejectFinalSymlink: true,
      rejectSymlinkComponents: true
    });
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    return { path: displayPath(repoRoot, wrapperPath), classification: "custom", safeToRemoveManually: false };
  }
  const status = inspectRepositoryWrapper(repoRoot);
  const display = displayPath(repoRoot, status.path);
  if (!status.exists) return { path: display, classification: "missing", safeToRemoveManually: false };
  const content = tryReadRepositoryWrapper(status);
  if (content !== null && detectGeneratedWrapperPackageManager(content) !== null) {
    return { path: display, classification: "generated", safeToRemoveManually: migrationApplied };
  }
  return { path: display, classification: "custom", safeToRemoveManually: false };
}

function resolveSkillReferencePath(repoRoot: string, skillDirectory: string, referencePath: string): string {
  const candidate = path.join(skillDirectory, referencePath);
  const relativeCandidate = path.relative(repoRoot, candidate);
  const isInsideRepo = relativeCandidate.length > 0
    && !relativeCandidate.startsWith(`..${path.sep}`)
    && relativeCandidate !== ".."
    && !path.isAbsolute(relativeCandidate);
  return isInsideRepo ? resolveRepoOutputPath(repoRoot, relativeCandidate) : candidate;
}

function wrapperDetail(wrapper: GlobalMigrationWrapperStatus, migrationApplied: boolean): string {
  if (wrapper.classification === "generated") {
    return migrationApplied
      ? "generated wrapper preserved; safe to remove manually after verification"
      : "generated wrapper preserved; apply the migration before cleanup";
  }
  if (wrapper.classification === "custom") return "custom wrapper preserved; manual review required before cleanup";
  return "wrapper is missing; no cleanup needed";
}

function planFileChange(options: {
  absolutePath: string;
  displayPath: string;
  kind: GlobalMigrationAction["kind"];
  content: string;
  mode?: number;
  detail: string;
  options: GlobalMigrationOptions;
  actions: GlobalMigrationAction[];
  changes: PlannedFileChange[];
}): void {
  const state = inspectFile(options.absolutePath);
  if (state.kind === "other") {
    throw new AgentMemoryError(`Migration target is not a regular file: ${options.displayPath}`);
  }
  const modeMatches = options.mode === undefined || state.kind === "missing" || ((state.mode as number) & 0o777) === options.mode;
  if (state.content === options.content && modeMatches) {
    options.actions.push({ path: options.displayPath, kind: options.kind, status: "skipped", detail: "already current" });
    return;
  }
  options.actions.push({
    path: options.displayPath,
    kind: options.kind,
    status: options.options.write
      ? state.kind === "missing" ? "created" : "updated"
      : state.kind === "missing" ? "would_create" : "would_update",
    detail: options.detail
  });
  options.changes.push({ absolutePath: options.absolutePath, content: options.content, mode: options.mode });
}

function inspectFile(filePath: string): { kind: "missing" | "file" | "other"; content?: string; mode?: number } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return { kind: "missing" };
    throw error;
  }
  if (!stat.isFile()) return { kind: "other" };
  return { kind: "file", content: fs.readFileSync(filePath, "utf8"), mode: stat.mode };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertNoConflictingChanges(changes: PlannedFileChange[]): void {
  const planned: Array<{ identity: string; change: PlannedFileChange }> = [];
  for (const change of changes) {
    const targetIdentity = canonicalTargetIdentity(change.absolutePath);
    const existing = planned.find((entry) =>
      isPathInside(entry.identity, targetIdentity) || isPathInside(targetIdentity, entry.identity)
    );
    if (
      existing
      && (
        existing.identity !== targetIdentity
        || existing.change.content !== change.content
        || existing.change.mode !== change.mode
      )
    ) {
      throw new AgentMemoryError(`Migration planned conflicting writes to ${change.absolutePath}.`, {
        details: ["Keep instruction, skill, and hook output paths distinct before retrying."]
      });
    }
    if (existing === undefined) planned.push({ identity: targetIdentity, change });
  }
}

function assertNoProtectedPathChanges(
  changes: PlannedFileChange[],
  protectedPaths: Array<{ absolutePath: string; label: string }>
): void {
  const protectedIdentities = protectedPaths.map((entry) => ({
    identity: canonicalTargetIdentity(entry.absolutePath),
    label: entry.label
  }));
  for (const change of changes) {
    const changeIdentity = canonicalTargetIdentity(change.absolutePath);
    const protectedEntry = protectedIdentities.find((entry) =>
      isPathInside(entry.identity, changeIdentity) || isPathInside(changeIdentity, entry.identity)
    );
    if (protectedEntry === undefined) continue;
    throw new AgentMemoryError(`Global migration output conflicts with preserved ${protectedEntry.label}: ${change.absolutePath}.`, {
      details: ["Choose distinct instruction, skill, hook, wrapper, and database paths before retrying."]
    });
  }
}

function canonicalTargetIdentity(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  const existingAncestor = nearestExistingAncestor(absolutePath);
  if (existingAncestor === null) return absolutePath;
  return path.resolve(fs.realpathSync(existingAncestor), path.relative(existingAncestor, absolutePath));
}

function applyFileChanges(changes: PlannedFileChange[]): void {
  const ordered = [...changes].sort((left, right) => {
    const leftConfig = left.absolutePath.endsWith(`${path.sep}agent-memory.config.yaml`);
    const rightConfig = right.absolutePath.endsWith(`${path.sep}agent-memory.config.yaml`);
    return Number(leftConfig) - Number(rightConfig);
  });
  const snapshots: FileSnapshot[] = [];
  try {
    for (const change of ordered) {
      const state = inspectFile(change.absolutePath);
      snapshots.push({
        absolutePath: change.absolutePath,
        existed: state.kind === "file",
        content: state.content,
        mode: state.mode
      });
      writeMigrationFile(change.absolutePath, change.content, change.mode ?? state.mode ?? 0o644);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const snapshot of snapshots.reverse()) {
      try {
        if (snapshot.existed) {
          writeMigrationFile(snapshot.absolutePath, snapshot.content as string, snapshot.mode as number);
        } else if (fs.existsSync(snapshot.absolutePath)) {
          fs.unlinkSync(snapshot.absolutePath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    throw new AgentMemoryError("Global migration failed; prior local-mode files were restored.", {
      details: rollbackErrors.length > 0 ? [`Rollback errors: ${rollbackErrors.join("; ")}`] : [],
      cause: error
    });
  }
}

function writeMigrationFile(filePath: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  replaceFileAtomicallySync(filePath, content, { mode: mode & 0o777 });
}

function displayPath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.startsWith("..") || path.isAbsolute(relativePath) ? absolutePath : relativePath;
}
