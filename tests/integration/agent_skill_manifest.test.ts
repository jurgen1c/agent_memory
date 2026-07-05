import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";
import { PACKAGE_VERSION } from "../../packages/core/src/version";

describe("install-skill command", () => {
  test("installs the codex skill to the configured default path", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);

    const result = await dispatch(["install-skill", "--agent", "codex"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    const content = fs.readFileSync(skillPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("created");
    expect(content.startsWith(`---
name: repo-memory
description: Use this skill whenever working in this repository to sync and retrieve agent-memory context before code changes and update durable claims when behavior or critical repository knowledge changes.
version: ${PACKAGE_VERSION}
user-invocable: false
---

<!-- agent-memory:generated-skill repo-memory -->
# Repo Memory Skill
`)).toBe(true);
    expect(content).toContain("bin/memory sync");
    expect(content).toContain("bin/memory audit --git-diff");
    expect(content).toContain(".agent-memory/memory.sqlite");
    expect(content).toContain("templates show claim:fact");
    expect(content).toContain("Relationship Graphs");
    expect(content).toContain("Do not edit or commit the SQLite database");
    expect(content).toContain("references/claims.md");
    expect(content).toContain("references/contextual-workflows.md");
    expect(content).toContain("references/plans.md");
    expect(content).toContain("references/profiles.md");
    expect(content).toContain("references/delegation.md");
    expect(content).toContain("If context includes matched recipes");
    expect(content).toContain("plans finish <id>");
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/references/contextual-workflows.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/references/plans.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/references/profiles.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/references/delegation.md"))).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md"), "utf8")).toContain(
      "<!-- agent-memory:generated-reference repo-memory/claims.md -->"
    );
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/contextual-workflows.md"), "utf8")).toContain(
      "Matched Recipes"
    );
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/plans.md"), "utf8")).toContain(
      "plans new --template"
    );
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/profiles.md"), "utf8")).toContain(
      "profiles match"
    );
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/coverage-and-validation.md"), "utf8")).toContain(
      "## Stale Review"
    );
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/delegation.md"), "utf8")).toContain(
      "lower-effort subagent"
    );
  });

  test("installs the generic skill to a configured custom path", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "codex"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    rewriteGenericSkillPath(repoRoot, "docs/custom/AGENT_MEMORY.md");

    const result = await dispatch(["install-skill", "--agent", "generic"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, "docs/custom/AGENT_MEMORY.md");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("docs/custom/AGENT_MEMORY.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("bin/memory context --git-diff");
    expect(fs.readFileSync(skillPath, "utf8")).toContain("If context includes matched recipes");
    expect(fs.readFileSync(skillPath, "utf8")).toContain("plans finish <id>");
    expect(fs.readFileSync(skillPath, "utf8")).not.toContain("references/claims.md");
  });

  test("documents the fixed local plan-run path when database_path is customized", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    rewriteDatabasePath(repoRoot, "tmp/custom-memory.sqlite");

    const result = await dispatch(["install-skill", "--agent", "codex", "--force"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    const content = fs.readFileSync(skillPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(content).toContain("`tmp/custom-memory.sqlite`");
    expect(content).toContain("`.agent-memory/plans` for local one-off plan runs");
    expect(content).not.toContain("`tmp/plans`");
  });

  test("installs the codex skill under a custom location", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);

    const result = await dispatch(["install-skill", "--agent", "codex", "--location", ".agent-skills"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, ".agent-skills/skills/repo-memory/SKILL.md");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".agent-skills/skills/repo-memory/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("bin/memory sync");
  });

  test("installs generic skills under the standard skills directory for custom locations", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "codex"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);

    const result = await dispatch(["install-skill", "--agent", "generic", "--location", ".agents"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, ".agents/skills/repo-memory/SKILL.md");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".agents/skills/repo-memory/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("Repository Memory Instructions");
  });

  test("installs the migration skill under its own standard skill directory", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);

    const result = await dispatch(["install-skill", "--agent", "codex", "--kind", "migration", "--location", ".codex"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory-migration/SKILL.md");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Kind: migration");
    expect(result.stdout).toContain(".codex/skills/repo-memory-migration/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, "utf8");
    expect(content.startsWith(`---
name: repo-memory-migration
description: Use this skill when migrating existing repository documentation into agent-memory atomic claims, indexes, recipes, and graph relationships.
version: ${PACKAGE_VERSION}
user-invocable: false
---

<!-- agent-memory:generated-skill repo-memory-migration -->
# Repo Memory Migration Skill
`)).toBe(true);
    expect(content).toContain("migrate-docs --from <existing-docs> --system <system> --automatic");
    expect(content).toContain("references/system-maps.md");
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory-migration/references/system-maps.md"))).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory-migration/references/system-maps.md"), "utf8")).toContain(
      "<!-- agent-memory:generated-reference repo-memory-migration/system-maps.md -->"
    );
  });

  test("installs a skill to an exact requested path", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);

    const result = await dispatch(["install-skill", "--agent", "codex", "--path", "tools/agent-memory/SKILL.md"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, "tools/agent-memory/SKILL.md");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tools/agent-memory/SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("Repo Memory Skill");
  });

  test("does not overwrite an existing skill unless forced", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    const skillPath = path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md");
    fs.writeFileSync(skillPath, "# Handwritten\n");

    const skipped = await dispatch(["install-skill", "--agent", "generic"], { cwd: repoRoot });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain("skipped");
    expect(fs.readFileSync(skillPath, "utf8")).toBe("# Handwritten\n");

    const overwritten = await dispatch(["install-skill", "--agent", "generic", "--force"], { cwd: repoRoot });
    expect(overwritten.exitCode).toBe(0);
    expect(overwritten.stdout).toContain("overwritten");
    expect(fs.readFileSync(skillPath, "utf8")).toContain("Repository Memory Instructions");
  });

  test("does not create codex references when the main skill is skipped", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    const referencesPath = path.join(repoRoot, ".codex/skills/repo-memory/references");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# Handwritten Codex Skill\n");

    const skipped = await dispatch(["install-skill", "--agent", "codex"], { cwd: repoRoot });

    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain("skipped");
    expect(fs.readFileSync(skillPath, "utf8")).toBe("# Handwritten Codex Skill\n");
    expect(fs.existsSync(referencesPath)).toBe(false);
  });

  test("rejects relative install paths that escape the repository", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    const outsideRelativePath = `../${path.basename(repoRoot)}-outside-skill.md`;
    const outsidePath = path.resolve(repoRoot, outsideRelativePath);

    await expect(dispatch(["install-skill", "--agent", "codex", "--path", outsideRelativePath], { cwd: repoRoot })).rejects.toThrow(
      "Relative output path escapes repository root"
    );

    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  test("reports invalid install-skill options", async () => {
    let stderr = "";
    const conflictingLocation = await runCli(
      ["install-skill", "--agent", "codex", "--location", ".codex", "--path", "custom/SKILL.md"],
      quietStreams((chunk) => {
        stderr += chunk;
      })
    );

    expect(conflictingLocation).toBe(1);
    expect(stderr).toContain("either --location or --path");

    stderr = "";
    const invalidKind = await runCli(
      ["install-skill", "--agent", "codex", "--kind", "unknown"],
      quietStreams((chunk) => {
        stderr += chunk;
      })
    );

    expect(invalidKind).toBe(1);
    expect(stderr).toContain("Unsupported skill kind");

    stderr = "";
    const missingAgent = await runCli(
      ["install-skill"],
      quietStreams((chunk) => {
        stderr += chunk;
      })
    );

    expect(missingAgent).toBe(1);
    expect(stderr).toContain("install-skill requires --agent");
  });
});

describe("agent-manifest command", () => {
  test("returns machine-readable command descriptions and repo paths", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);

    const result = await dispatch(["agent-manifest", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.tool).toBe("agent-memory");
    expect(parsed.commandPrefix).toBe("bin/memory");
    expect(parsed.paths.database).toBe(".agent-memory/memory.sqlite");
    expect(parsed.paths.skills.codex).toBe(".codex/skills/repo-memory/SKILL.md");
    expect(parsed.commands.some((command: { name: string }) => command.name === "context")).toBe(true);
    expect(parsed.commands.some((command: { name: string }) => command.name === "audit")).toBe(true);
    expect(parsed.commands.find((command: { name: string }) => command.name === "context").examples[0]).toContain("bin/memory");
    expect(parsed.capabilities.contextual_workflows).toBe(true);
    expect(parsed.capabilities.recipes.commands).toContain("recipes search");
    expect(parsed.capabilities.plans.context_flags).toEqual(["--plan", "--stage"]);
    expect(parsed.capabilities.plans.run_root).toBe(".agent-memory/plans");
    expect(parsed.capabilities.profiles.context_flags).toContain("--profile-trait");
    expect(parsed.workflow_summary.recipe_count).toBe(0);
    expect(parsed.workflow_summary.plan_template_count).toBe(0);
    expect(parsed.workflow_summary.profile_trait_count).toBe(0);
    expect(parsed.workflow_summary.active_plan_run_count).toBe(0);
    expect(parsed.workflow_summary.blocked_plan_run_count).toBe(0);
    expect(parsed.workflow_summary.warnings).toEqual([]);
  });

  test("reports contextual workflow counts without requiring compile", async () => {
    const repoRoot = makeGitRepo();
    const init = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(init.exitCode).toBe(0);
    writeWorkflowArtifact(repoRoot, "docs/agent-memory/recipes/auth/oauth.yaml", "id: recipe.auth.oauth\n");
    writeWorkflowArtifact(repoRoot, "docs/agent-memory/plans/auth/oauth.yaml", "id: plan_template.auth.oauth\n");
    writeWorkflowArtifact(repoRoot, "docs/agent-memory/profiles/review/findings.yaml", "id: profile_trait.review.findings\n");
    writeWorkflowArtifact(repoRoot, ".agent-memory/plans/active.yaml", "id: plan_run.active\nstatus: active\n");
    writeWorkflowArtifact(repoRoot, ".agent-memory/plans/completed/done.yml", "id: plan_run.done\nstatus: complete\n");
    writeWorkflowArtifact(repoRoot, ".agent-memory/plans/blocked.yml", "id: plan_run.blocked\nstatus: blocked\n");
    writeWorkflowArtifact(repoRoot, ".agent-memory/plans/abandoned.yaml", "id: plan_run.abandoned\nstatus: abandoned\n");

    const result = await dispatch(["agent-manifest", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.workflow_summary).toMatchObject({
      recipe_count: 1,
      plan_template_count: 1,
      profile_trait_count: 1,
      active_plan_run_count: 1,
      completed_plan_run_count: 1,
      blocked_plan_run_count: 1,
      abandoned_plan_run_count: 1,
      warnings: []
    });
  });

  test("renders command help for phase 10 commands", async () => {
    const installSkill = await dispatch(["help", "install-skill"]);
    const manifest = await dispatch(["help", "agent-manifest"]);

    expect(installSkill.exitCode).toBe(0);
    expect(installSkill.stdout).toContain("Install agent-specific");
    expect(installSkill.stdout).toContain("--kind migration");
    expect(manifest.exitCode).toBe(0);
    expect(manifest.stdout).toContain("machine-readable");
  });
});

function makeGitRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-phase10-"));
  const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
  expect(init.status).toBe(0);
  return repoRoot;
}

function rewriteGenericSkillPath(repoRoot: string, skillPath: string): void {
  const configPath = path.join(repoRoot, "agent-memory.config.yaml");
  const config = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, config.replace("    path: docs/agent-memory/AGENT_SKILL.md", `    path: ${skillPath}`));
}

function rewriteDatabasePath(repoRoot: string, databasePath: string): void {
  const configPath = path.join(repoRoot, "agent-memory.config.yaml");
  const config = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, config.replace("database_path: .agent-memory/memory.sqlite", `database_path: ${databasePath}`));
}

function writeWorkflowArtifact(repoRoot: string, relativePath: string, content: string): void {
  const target = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function quietStreams(onStderr: (chunk: string) => void) {
  return {
    stdout: { write: () => true },
    stderr: {
      write: (chunk: string) => {
        onStderr(chunk);
        return true;
      }
    }
  };
}
