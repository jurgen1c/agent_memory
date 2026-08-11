import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dispatch } from "../../packages/cli/src/router";
import { loadConfig } from "../../packages/core/src/config";
import { renderMemoryHook } from "../../packages/core/src/hooks";
import { wrapperTemplate } from "../../packages/core/src/init";

describe("upgrade --global", () => {
  test("dry-runs all migration surfaces without changing local mode", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const before = snapshot(repoRoot);

    const result = await dispatch(["upgrade", "--global", "--memory-key", "acme-repo"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("global migration dry run");
    expect(result.stdout).toContain("would_update  agent-memory.config.yaml");
    expect(result.stdout).toContain("Wrapper: generated (preserved)");
    expect(result.stdout).toContain("agent-memory upgrade --global --write --memory-key acme-repo");
    expect(result.stdout).not.toContain("agent-memory sync");
    expect(result.stdout).not.toContain("agent-memory doctor");
    expect(result.stdout).not.toContain("safe to remove manually");
    expect(snapshot(repoRoot)).toEqual(before);
    expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
  });

  test("writes global config and refreshes generated instructions, skills, and hooks", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const wrapperPath = path.join(repoRoot, "bin/memory");
    const databasePath = path.join(repoRoot, ".agent-memory/memory.sqlite");
    const originalWrapper = fs.readFileSync(wrapperPath, "utf8");
    const originalDatabase = fs.readFileSync(databasePath, "utf8");

    const result = await dispatch(["upgrade", "--global", "--write", "--memory-key=acme-repo"], { cwd: repoRoot });
    const config = loadConfig({ repoRoot }).config;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("global migration applied");
    expect(config.version).toBe(2);
    expect(config.memory_key).toBe("acme-repo");
    expect(config.database_scope).toBe("global");
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toContain("agent-memory sync");
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"), "utf8")).toContain("agent-memory sync");
    expect(fs.readFileSync(path.join(repoRoot, ".git/hooks/post-merge"), "utf8")).toContain('MEMORY_COMMAND="agent-memory"');
    expect(result.stdout).toContain("agent-memory sync");
    expect(result.stdout).toContain("agent-memory doctor");
    expect(result.stdout).toContain("safe to remove manually");
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(originalWrapper);
    expect(fs.readFileSync(databasePath, "utf8")).toBe(originalDatabase);
  });

  test("preserves an authoritative key when a version 2 repository returns to global scope", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "missing" });
    fs.writeFileSync(
      path.join(repoRoot, "agent-memory.config.yaml"),
      "version: 2\ndatabase_scope: local\nmemory_key: deliberately-chosen\n"
    );

    const result = await dispatch(["upgrade", "--global", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(loadConfig({ repoRoot }).config).toMatchObject({
      version: 2,
      database_scope: "global",
      memory_key: "deliberately-chosen"
    });
    await expect(
      dispatch(["upgrade", "--global", "--memory-key", "different-key"], { cwd: repoRoot })
    ).rejects.toThrow("cannot replace a committed memory_key");
  });

  test("validates repository identity before migrating an existing version 2 key", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "missing" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    fs.writeFileSync(
      configPath,
      "version: 2\ndatabase_scope: local\nmemory_key: deliberately-chosen\n"
    );
    git(repoRoot, ["remote", "set-url", "origin", "ssh://alice@git.example.test:2222/org/repo.git"]);
    const originalConfig = fs.readFileSync(configPath, "utf8");

    await expect(
      dispatch(["upgrade", "--global", "--write"], { cwd: repoRoot })
    ).rejects.toThrow("Could not derive a safe repository identity");

    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
  });

  test("preserves a legacy single-agent install and persists its selection", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const genericSkillPath = path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md");

    const result = await dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Preserved legacy single-agent install");
    expect(loadConfig({ repoRoot }).config.agent_skills.generic.enabled).toBe(false);
    expect(fs.existsSync(genericSkillPath)).toBe(false);
  });

  test("preserves a legacy single-agent install with an explicit two-agent mapping", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    fs.writeFileSync(configPath, `version: 1
agent_skills:
  codex:
    enabled: true
    path: .codex/skills/repo-memory/SKILL.md
    future_option: retained
  generic:
    enabled: true
    path: docs/agent-memory/AGENT_SKILL.md
`);

    const result = await dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot });
    const configText = fs.readFileSync(configPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Preserved legacy single-agent install");
    expect(loadConfig({ repoRoot }).config.agent_skills.generic.enabled).toBe(false);
    expect(configText).toContain("future_option: retained");
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md"))).toBe(false);
  });

  test("preserves a legacy single-agent install when version is omitted", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const genericSkillPath = path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md");
    fs.writeFileSync(configPath, `agent_skills:
  codex:
    enabled: true
    path: .codex/skills/repo-memory/SKILL.md
  generic:
    enabled: true
    path: docs/agent-memory/AGENT_SKILL.md
`);

    const result = await dispatch(
      ["upgrade", "--global", "--write", "--memory-key", "acme-repo"],
      { cwd: repoRoot }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Preserved legacy single-agent install");
    expect(loadConfig({ repoRoot }).config.agent_skills.generic.enabled).toBe(false);
    expect(fs.existsSync(genericSkillPath)).toBe(false);
  });

  test("refreshes legacy generated hooks without force", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const hookPath = path.join(repoRoot, ".git/hooks/post-merge");
    fs.writeFileSync(hookPath, legacyWrapperHook());
    fs.chmodSync(hookPath, 0o755);

    const result = await dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(hookPath, "utf8")).toBe(renderMemoryHook("agent-memory"));
  });

  test("refreshes installed generated hooks without installing missing disabled hooks", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const installedHookPath = path.join(repoRoot, ".git/hooks/post-merge");
    const missingHookPath = path.join(repoRoot, ".git/hooks/post-rewrite");
    fs.writeFileSync(configPath, `version: 1
git:
  install_hooks: false
  hooks:
    - post-merge
    - post-rewrite
`);
    fs.rmSync(missingHookPath);

    const result = await dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(installedHookPath, "utf8")).toBe(renderMemoryHook("agent-memory"));
    expect(fs.existsSync(missingHookPath)).toBe(false);
    expect(result.stdout).toContain("hook installation disabled; missing hook remains uninstalled");
  });

  test("refreshes stale installed generated hooks that are no longer configured", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const staleHookPath = path.join(repoRoot, ".git/hooks/post-merge");
    fs.writeFileSync(configPath, `version: 1
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
  hooks: []
`);

    const result = await dispatch(
      ["upgrade", "--global", "--write", "--memory-key", "acme-repo", "--json"],
      { cwd: repoRoot }
    );
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ path: string; kind: string; status: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
    };

    expect(parsed.actions).toContainEqual(expect.objectContaining({
      path: ".git/hooks/post-merge",
      kind: "hook",
      status: "updated"
    }));
    expect(fs.readFileSync(staleHookPath, "utf8")).toContain('MEMORY_COMMAND="agent-memory"');
    expect(parsed.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: true });
  });

  test("refreshes installed generated skills even when they are disabled", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "<!-- agent-memory:generated-skill repo-memory -->\nold\n");
    fs.writeFileSync(configPath, `version: 1
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
  hooks: []
`);

    const result = await dispatch(
      ["upgrade", "--global", "--write", "--memory-key", "acme-repo", "--json"],
      { cwd: repoRoot }
    );
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ path: string; kind: string; status: string; detail: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
    };

    expect(parsed.actions).toContainEqual(expect.objectContaining({
      path: ".codex/skills/repo-memory/SKILL.md",
      kind: "skill",
      status: "updated",
      detail: "refresh installed disabled generated skill for global mode"
    }));
    expect(fs.readFileSync(skillPath, "utf8")).toContain("agent-memory sync");
    expect(parsed.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: true });
  });

  test("keeps wrapper cleanup unsafe for installed disabled custom skills", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# Custom skill\n\nRun `bin/memory sync`.\n");
    fs.writeFileSync(configPath, `version: 1
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
  hooks: []
`);

    const result = await dispatch(
      ["upgrade", "--global", "--write", "--memory-key", "acme-repo", "--json"],
      { cwd: repoRoot }
    );
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ path: string; kind: string; status: string; detail: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance?: string;
    };

    expect(parsed.actions).toContainEqual(expect.objectContaining({
      path: ".codex/skills/repo-memory/SKILL.md",
      kind: "skill",
      status: "skipped",
      detail: "disabled custom content requires manual review"
    }));
    expect(fs.readFileSync(skillPath, "utf8")).toContain("bin/memory sync");
    expect(parsed.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: false });
    expect(parsed.cleanupGuidance).toBeUndefined();

    const forced = await dispatch(
      ["upgrade", "--global", "--write", "--force", "--json"],
      { cwd: repoRoot }
    );
    const forcedResult = JSON.parse(forced.stdout) as {
      actions: Array<{ path: string; kind: string; status: string; detail: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
    };
    expect(forcedResult.actions).toContainEqual(expect.objectContaining({
      path: ".codex/skills/repo-memory/SKILL.md",
      kind: "skill",
      status: "updated",
      detail: "replace installed disabled custom skill for global mode"
    }));
    expect(fs.readFileSync(skillPath, "utf8")).toContain("agent-memory sync");
    expect(forcedResult.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: true });
  });

  test("keeps wrapper cleanup unsafe for unconfigured custom hooks that reference it", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const hookPath = path.join(repoRoot, ".git/hooks/post-merge");
    fs.writeFileSync(configPath, `version: 1
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
  hooks: []
`);
    fs.writeFileSync(hookPath, "#!/usr/bin/env bash\nbin/memory sync\n");
    fs.chmodSync(hookPath, 0o755);

    const result = await dispatch(
      ["upgrade", "--global", "--write", "--memory-key", "acme-repo", "--json"],
      { cwd: repoRoot }
    );
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ path: string; kind: string; status: string; detail: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance?: string;
    };

    expect(parsed.actions).toContainEqual(expect.objectContaining({
      path: ".git/hooks/post-merge",
      kind: "hook",
      status: "skipped",
      detail: "unconfigured custom hook references bin/memory"
    }));
    expect(fs.readFileSync(hookPath, "utf8")).toContain("bin/memory sync");
    expect(parsed.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: false });
    expect(parsed.cleanupGuidance).toBeUndefined();
  });

  test("keeps wrapper cleanup unsafe for unconfigured hook symlinks", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const hookTarget = path.join(repoRoot, ".githooks/post-merge");
    const hookPath = path.join(repoRoot, ".git/hooks/post-merge");
    fs.writeFileSync(configPath, `version: 1
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
  hooks: []
`);
    fs.mkdirSync(path.dirname(hookTarget), { recursive: true });
    fs.writeFileSync(hookTarget, "#!/usr/bin/env bash\nbin/memory sync\n");
    fs.chmodSync(hookTarget, 0o755);
    fs.symlinkSync("../../.githooks/post-merge", hookPath);

    const result = await dispatch(
      ["upgrade", "--global", "--write", "--memory-key", "acme-repo", "--json"],
      { cwd: repoRoot }
    );
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ path: string; kind: string; status: string; detail: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance?: string;
    };

    expect(parsed.actions).toContainEqual(expect.objectContaining({
      path: ".git/hooks/post-merge",
      kind: "hook",
      status: "skipped",
      detail: "unconfigured hook symlink requires manual review"
    }));
    expect(fs.readFileSync(hookTarget, "utf8")).toContain("bin/memory sync");
    expect(parsed.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: false });
    expect(parsed.cleanupGuidance).toBeUndefined();
  });

  test("classifies and preserves custom wrappers", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "custom" });
    const wrapperPath = path.join(repoRoot, "bin/memory");
    const originalWrapper = fs.readFileSync(wrapperPath, "utf8");

    const result = await dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout) as {
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance: string;
    };

    expect(parsed.wrapper.classification).toBe("custom");
    expect(parsed.wrapper.safeToRemoveManually).toBe(false);
    expect(parsed.cleanupGuidance).toContain("manual review");
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(originalWrapper);
  });

  test("reports a missing wrapper without cleanup guidance", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "missing" });
    const result = await dispatch(["upgrade", "--global", "--memory-key", "acme-repo", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout) as {
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance?: string;
    };

    expect(parsed.wrapper).toMatchObject({ classification: "missing", safeToRemoveManually: false });
    expect(parsed.cleanupGuidance).toBeUndefined();
  });

  test("treats wrappers reached through symlinked parent directories as custom", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "missing" });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-global-wrapper-outside-"));
    const outsideWrapper = path.join(outside, "memory");
    fs.writeFileSync(outsideWrapper, wrapperTemplate("npm"));
    fs.chmodSync(outsideWrapper, 0o755);
    fs.symlinkSync(outside, path.join(repoRoot, "bin"), "dir");

    const result = await dispatch(["upgrade", "--global", "--memory-key", "acme-repo", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout) as {
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance?: string;
    };

    expect(parsed.wrapper).toMatchObject({ classification: "custom", safeToRemoveManually: false });
    expect(parsed.cleanupGuidance).toBeUndefined();
    expect(fs.readFileSync(outsideWrapper, "utf8")).toBe(wrapperTemplate("npm"));
  });

  test("requires force before replacing custom skill and hook files", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "custom" });
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    const hookPath = path.join(repoRoot, ".git/hooks/post-merge");
    const wrapperPath = path.join(repoRoot, "bin/memory");
    const originalWrapper = fs.readFileSync(wrapperPath, "utf8");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# Custom skill\n");
    fs.writeFileSync(hookPath, "#!/usr/bin/env bash\necho custom\n");

    const safe = await dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot });
    expect(safe.stdout).toContain("custom content requires --force");
    expect(fs.readFileSync(skillPath, "utf8")).toBe("# Custom skill\n");
    expect(fs.readFileSync(hookPath, "utf8")).toContain("echo custom");

    const forced = await dispatch(["upgrade", "--global", "--write", "--force"], { cwd: repoRoot });
    expect(forced.exitCode).toBe(0);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("<!-- agent-memory:generated-skill repo-memory -->");
    expect(fs.readFileSync(hookPath, "utf8")).toContain('MEMORY_COMMAND="agent-memory"');
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(originalWrapper);
  });

  test("is idempotent when rerun after a successful migration", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    await dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot });
    const before = snapshot(repoRoot);

    const rerun = await dispatch(["upgrade", "--global", "--write", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(rerun.stdout) as { actions: Array<{ status: string }> };

    expect(parsed.actions.some((action) => ["created", "updated"].includes(action.status))).toBe(false);
    expect(snapshot(repoRoot)).toEqual(before);
  });

  test("leaves local mode usable when migration planning fails", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const conflictingPath = ".codex/skills/repo-memory/SKILL.md";
    fs.appendFileSync(configPath, `\nagent_instructions:\n  paths:\n    - ${conflictingPath}\n`);
    const originalConfig = fs.readFileSync(configPath, "utf8");
    const originalWrapper = fs.readFileSync(path.join(repoRoot, "bin/memory"), "utf8");

    await expect(
      dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot })
    ).rejects.toThrow("conflicting writes");

    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
    expect(fs.readFileSync(path.join(repoRoot, "bin/memory"), "utf8")).toBe(originalWrapper);
  });

  test("rejects nested planned output paths before writing", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    fs.writeFileSync(configPath, `version: 1
agent_instructions:
  paths:
    - generated/AGENTS.md
agent_skills:
  codex:
    enabled: true
    path: generated
  generic:
    enabled: false
git:
  install_hooks: false
`);
    const originalConfig = fs.readFileSync(configPath, "utf8");

    await expect(
      dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot })
    ).rejects.toThrow("conflicting writes");

    expect(fs.existsSync(path.join(repoRoot, "generated"))).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
  });

  test("rejects output paths that collide with preserved wrapper or database files", async () => {
    for (const targetPath of [
      "bin/memory",
      ".agent-memory/memory.sqlite",
      ".agent-memory/memory.sqlite-journal",
      ".agent-memory/memory.sqlite-wal",
      ".agent-memory/memory.sqlite-shm"
    ]) {
      const repoRoot = makeLocalRepo({ wrapper: "generated" });
      const configPath = path.join(repoRoot, "agent-memory.config.yaml");
      const protectedPath = path.join(repoRoot, targetPath);
      if (!fs.existsSync(protectedPath)) fs.writeFileSync(protectedPath, "local database sidecar");
      const originalProtectedContent = fs.readFileSync(protectedPath, "utf8");
      fs.writeFileSync(configPath, `version: 1
agent_instructions:
  paths:
    - ${targetPath}
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
`);

      await expect(
        dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot })
      ).rejects.toThrow("conflicts with preserved");

      expect(fs.readFileSync(protectedPath, "utf8")).toBe(originalProtectedContent);
      expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
    }
  });

  test("rejects output paths nested beneath protected SQLite artifacts", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const protectedPath = ".agent-memory/memory.sqlite-wal";
    fs.writeFileSync(configPath, `version: 1
agent_instructions:
  paths:
    - ${protectedPath}/note.md
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
`);

    await expect(
      dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot })
    ).rejects.toThrow("conflicts with preserved configured local database sidecar");

    expect(fs.existsSync(path.join(repoRoot, protectedPath))).toBe(false);
    expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
  });

  test("rejects contained symlink aliases of preserved and conflicting output paths", async () => {
    const wrapperRepo = makeLocalRepo({ wrapper: "generated" });
    const wrapperPath = path.join(wrapperRepo, "bin/memory");
    const originalWrapper = fs.readFileSync(wrapperPath, "utf8");
    fs.symlinkSync("bin", path.join(wrapperRepo, "wrapper-alias"), "dir");
    fs.writeFileSync(path.join(wrapperRepo, "agent-memory.config.yaml"), `version: 1
agent_instructions:
  paths:
    - wrapper-alias/memory
agent_skills:
  codex:
    enabled: false
  generic:
    enabled: false
git:
  install_hooks: false
`);

    await expect(
      dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: wrapperRepo })
    ).rejects.toThrow("conflicts with preserved bin/memory wrapper");
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(originalWrapper);

    const conflictRepo = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    fs.symlinkSync(".codex/skills/repo-memory", path.join(conflictRepo, "skill-alias"), "dir");
    fs.writeFileSync(path.join(conflictRepo, "agent-memory.config.yaml"), `version: 1
agent_instructions:
  paths:
    - skill-alias/SKILL.md
`);

    await expect(
      dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: conflictRepo })
    ).rejects.toThrow("conflicting writes");
    expect(loadConfig({ repoRoot: conflictRepo }).config.database_scope).toBe("local");
  });

  test("replays pending dry runs with the options required to apply them", async () => {
    const globalRepo = makeLocalRepo({ wrapper: "missing" });
    fs.writeFileSync(
      path.join(globalRepo, "agent-memory.config.yaml"),
      "version: 2\nmemory_key: acme-repo\ndatabase_scope: global\n"
    );
    const pending = await dispatch(["upgrade", "--global"], { cwd: globalRepo });
    expect(pending.stdout).toContain("would_create  AGENTS.md");
    expect(pending.stdout).toContain("agent-memory upgrade --global --write --memory-key acme-repo");
    expect(pending.stdout).not.toContain("agent-memory sync");

    const forcedRepo = makeLocalRepo({ wrapper: "missing" });
    const customSkillPath = path.join(forcedRepo, ".codex/skills/repo-memory/SKILL.md");
    fs.mkdirSync(path.dirname(customSkillPath), { recursive: true });
    fs.writeFileSync(customSkillPath, "# Custom skill\n");
    const forced = await dispatch(["upgrade", "--global", "--force", "--memory-key", "acme-repo"], { cwd: forcedRepo });
    expect(forced.stdout).toContain(
      "agent-memory upgrade --global --write --force --memory-key acme-repo"
    );
  });

  test("keeps generated wrapper cleanup unsafe while global support rewrites are pending", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    fs.writeFileSync(
      path.join(repoRoot, "agent-memory.config.yaml"),
      "version: 2\nmemory_key: acme-repo\ndatabase_scope: global\n"
    );

    const result = await dispatch(["upgrade", "--global", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ kind: string; status: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance?: string;
      nextCommands: string[];
    };

    expect(parsed.actions.some((action) => action.kind === "hook" && action.status === "would_update")).toBe(true);
    expect(parsed.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: false });
    expect(parsed.cleanupGuidance).toBeUndefined();
    expect(parsed.nextCommands).toEqual(["agent-memory upgrade --global --write --memory-key acme-repo"]);
  });

  test("keeps generated wrapper cleanup unsafe when custom support files are preserved", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated" });
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    const hookPath = path.join(repoRoot, ".git/hooks/post-merge");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# Custom skill\n\nRun `bin/memory sync`.\n");
    fs.writeFileSync(hookPath, "#!/usr/bin/env bash\nbin/memory sync\n");

    const result = await dispatch(
      ["upgrade", "--global", "--write", "--memory-key", "acme-repo", "--json"],
      { cwd: repoRoot }
    );
    const parsed = JSON.parse(result.stdout) as {
      actions: Array<{ kind: string; status: string; detail: string }>;
      wrapper: { classification: string; safeToRemoveManually: boolean };
      cleanupGuidance?: string;
    };

    expect(parsed.actions).toContainEqual(expect.objectContaining({
      kind: "skill",
      status: "skipped",
      detail: "custom content requires --force"
    }));
    expect(parsed.actions).toContainEqual(expect.objectContaining({
      kind: "hook",
      status: "skipped",
      detail: "custom content requires --force"
    }));
    expect(parsed.wrapper).toMatchObject({ classification: "generated", safeToRemoveManually: false });
    expect(parsed.cleanupGuidance).toBeUndefined();
  });

  test("restores migrated files when the final config write fails", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const configPath = path.join(repoRoot, "agent-memory.config.yaml");
    const instructionPath = path.join(repoRoot, ".support/AGENTS.md");
    fs.mkdirSync(path.dirname(instructionPath), { recursive: true });
    fs.writeFileSync(instructionPath, "# Instructions\n\n<!-- agent-memory:start -->\nold\n<!-- agent-memory:end -->\n");
    fs.writeFileSync(configPath, `version: 1
agent_instructions:
  paths:
    - .support/AGENTS.md
`);
    const before = snapshot(repoRoot);
    const originalInstructions = fs.readFileSync(instructionPath, "utf8");
    const originalRepoMode = fs.statSync(repoRoot).mode & 0o777;

    fs.chmodSync(repoRoot, 0o555);
    try {
      await expect(
        dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot })
      ).rejects.toThrow("Global migration failed; prior local-mode files were restored");
    } finally {
      fs.chmodSync(repoRoot, originalRepoMode);
    }

    expect(snapshot(repoRoot)).toEqual(before);
    expect(fs.readFileSync(instructionPath, "utf8")).toBe(originalInstructions);
    expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
  });

  test("rejects generated skill reference paths that escape through a symlink", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "generated", generatedSupport: true });
    const skillDirectory = path.join(repoRoot, ".codex/skills/repo-memory");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-global-migration-outside-"));
    fs.symlinkSync(outside, path.join(skillDirectory, "references"), "dir");
    const originalConfig = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");

    await expect(
      dispatch(["upgrade", "--global", "--write", "--memory-key", "acme-repo"], { cwd: repoRoot })
    ).rejects.toThrow("escapes repository root through a symlink");

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8")).toBe(originalConfig);
    expect(loadConfig({ repoRoot }).config.database_scope).toBe("local");
  });

  test("rejects migration-only options without --global", async () => {
    const repoRoot = makeLocalRepo({ wrapper: "missing" });
    await expect(dispatch(["upgrade", "--memory-key", "acme-repo"], { cwd: repoRoot })).rejects.toThrow(
      "--memory-key requires --global"
    );
  });
});

function makeLocalRepo(options: { wrapper: "generated" | "custom" | "missing"; generatedSupport?: boolean }): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-global-migration-"));
  git(repoRoot, ["init"]);
  git(repoRoot, ["remote", "add", "origin", "git@github.com:acme/repo.git"]);
  fs.writeFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "version: 1\n");
  fs.mkdirSync(path.join(repoRoot, ".agent-memory"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".agent-memory/memory.sqlite"), "local database");

  if (options.wrapper !== "missing") {
    fs.mkdirSync(path.join(repoRoot, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "bin/memory"),
      options.wrapper === "generated" ? wrapperTemplate("npm") : "#!/usr/bin/env bash\necho custom wrapper\n"
    );
    fs.chmodSync(path.join(repoRoot, "bin/memory"), 0o755);
  }

  if (options.generatedSupport) {
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# Instructions\n\n<!-- agent-memory:start -->\nold\n<!-- agent-memory:end -->\n");
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "<!-- agent-memory:generated-skill repo-memory -->\nold\n");
    for (const hookName of ["post-merge", "post-checkout", "post-rewrite"]) {
      const hookPath = path.join(repoRoot, ".git/hooks", hookName);
      fs.writeFileSync(hookPath, renderMemoryHook("bin/memory"));
      fs.chmodSync(hookPath, 0o755);
    }
  }

  return repoRoot;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function legacyWrapperHook(): string {
  return `#!/usr/bin/env bash

if [ -x bin/memory ]; then
  echo "Refreshing agent memory..."
  bin/memory sync || echo "Warning: agent memory sync failed. Run bin/memory sync manually."
fi
`;
}

function snapshot(repoRoot: string): Record<string, string> {
  const files = [
    "agent-memory.config.yaml",
    "AGENTS.md",
    ".codex/skills/repo-memory/SKILL.md",
    ".git/hooks/post-merge",
    ".git/hooks/post-checkout",
    ".git/hooks/post-rewrite",
    "bin/memory",
    ".agent-memory/memory.sqlite"
  ];
  return Object.fromEntries(
    files.map((relativePath) => {
      const absolutePath = path.join(repoRoot, relativePath);
      return [relativePath, fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "<missing>"];
    })
  );
}
