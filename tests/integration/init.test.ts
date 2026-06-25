import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";
import { loadConfig } from "../../packages/core/src/config";
import { initRepository } from "../../packages/core/src/init";

describe("init command", () => {
  test("scaffolds an empty repository idempotently", async () => {
    const repoRoot = makeGitRepo();

    const first = await dispatch(["init", "--yes", "--package-manager", "npm"], { cwd: repoRoot });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("created");

    for (const relativePath of [
      "agent-memory.config.yaml",
      "docs/agent-memory/README.md",
      "docs/agent-memory/claims/.gitkeep",
      "docs/agent-memory/graph/.gitkeep",
      "docs/agent-memory/indexes/.gitkeep",
      "docs/agent-memory/recipes/.gitkeep",
      "docs/agent-memory/waivers/.gitkeep",
      "bin/memory",
      "AGENTS.md",
      ".codex/skills/repo-memory/SKILL.md",
      "docs/agent-memory/AGENT_SKILL.md"
    ]) {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(true);
    }

    expect(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8")).toContain(".agent-memory/");
    const config = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");
    expect(config).toContain("# Canonical memory source directory.");
    expect(config).toContain("# Defaults for agent-memory context when command flags are omitted.");
    expect(loadConfig({ repoRoot }).config.context.default_budget).toBe("medium");
    const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- agent-memory:start -->");
    expect(agents).toContain("## Agent Memory Knowledge Base");
    expect(agents).toContain("Use the repo-memory skill or instruction file whenever it is available.");
    expect(agents).toContain("bin/memory context --task");
    expect(agents).toContain("After non-trivial work:");
    expect(agents).toContain("Update memory in the same change when durable repository knowledge changed.");
    expect(agents).toContain("Recipes for new or changed repeatable workflows.");
    expect(agents).toContain("Waivers for intentional coverage exceptions with a reason and expiration.");
    expect(fs.statSync(path.join(repoRoot, "bin/memory")).mode & 0o111).toBeGreaterThan(0);

    const second = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("skipped");
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(agents);
  });

  test("updates the managed AGENTS section without replacing local instructions", async () => {
    const repoRoot = makeGitRepo();
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      `# Agent Instructions

Keep project-specific guidance.

<!-- agent-memory:start -->
## Old Agent Memory Section
<!-- agent-memory:end -->

Keep this footer too.
`
    );

    const result = await dispatch(["init", "--yes"], { cwd: repoRoot });
    const agents = fs.readFileSync(agentsPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refreshed agent-memory section");
    expect(agents).toContain("Keep project-specific guidance.");
    expect(agents).toContain("Keep this footer too.");
    expect(agents).toContain("## Agent Memory Knowledge Base");
    expect(agents).not.toContain("## Old Agent Memory Section");
  });

  test("preserves user whitespace around refreshed AGENTS sections", async () => {
    const repoRoot = makeGitRepo();
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      `# Agent Instructions

Keep project-specific guidance.${"   "}

<!-- agent-memory:start -->
## Old Agent Memory Section
<!-- agent-memory:end -->

    Keep this indented footer too.
`
    );

    const result = await dispatch(["init", "--yes"], { cwd: repoRoot });
    const agents = fs.readFileSync(agentsPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refreshed agent-memory section");
    expect(agents).toContain("Keep project-specific guidance.   \n\n<!-- agent-memory:start -->");
    expect(agents).toContain("<!-- agent-memory:end -->\n\n    Keep this indented footer too.");
  });

  test("pairs AGENTS markers after the managed start marker", async () => {
    const repoRoot = makeGitRepo();
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      `# Agent Instructions

Document a literal <!-- agent-memory:end --> marker before the managed section.

<!-- agent-memory:start -->
## Old Agent Memory Section
<!-- agent-memory:end -->

Keep this footer too.
`
    );

    const result = await dispatch(["init", "--yes"], { cwd: repoRoot });
    const agents = fs.readFileSync(agentsPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refreshed agent-memory section");
    expect(agents).toContain("Document a literal <!-- agent-memory:end --> marker before the managed section.");
    expect(agents).toContain("Keep this footer too.");
    expect(agents).toContain("## Agent Memory Knowledge Base");
    expect(agents).not.toContain("## Old Agent Memory Section");
  });

  test("preserves inline marker text when appending an AGENTS section", async () => {
    const repoRoot = makeGitRepo();
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      `# Agent Instructions

Document a literal <!-- agent-memory:end --> marker without creating a managed section.
`
    );

    const result = await dispatch(["init", "--yes"], { cwd: repoRoot });
    const agents = fs.readFileSync(agentsPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("appended agent-memory section");
    expect(agents).toContain("Document a literal <!-- agent-memory:end --> marker without creating a managed section.");
    expect(agents).toContain("## Agent Memory Knowledge Base");
  });

  test("repairs an AGENTS section with an unmatched start marker", async () => {
    const repoRoot = makeGitRepo();
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      `# Agent Instructions

Keep project-specific guidance.

<!-- agent-memory:start -->
## Old Agent Memory Section
This section is missing its end marker.
`
    );

    const result = await dispatch(["init", "--yes"], { cwd: repoRoot });
    const agents = fs.readFileSync(agentsPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("repaired agent-memory section");
    expect(agents).toContain("Keep project-specific guidance.");
    expect(agents).toContain("## Agent Memory Knowledge Base");
    expect(agents).toContain("<!-- agent-memory:end -->");
    expect(agents).not.toContain("## Old Agent Memory Section");
    expect(agents).not.toContain("This section is missing its end marker.");
  });

  test("repairs an AGENTS section with an unmatched end marker", async () => {
    const repoRoot = makeGitRepo();
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      `# Agent Instructions

Keep project-specific guidance.

## Old Agent Memory Section
<!-- agent-memory:end -->

Keep this footer too.
`
    );

    const result = await dispatch(["init", "--yes"], { cwd: repoRoot });
    const agents = fs.readFileSync(agentsPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("repaired agent-memory section");
    expect(agents).toContain("Keep project-specific guidance.");
    expect(agents).toContain("Keep this footer too.");
    expect(agents).toContain("## Agent Memory Knowledge Base");
    expect(agents).toContain("<!-- agent-memory:start -->");
    expect(agents).toContain("<!-- agent-memory:end -->");
    expect(agents.match(/<!-- agent-memory:end -->/g)).toHaveLength(1);
  });

  test("creates a wrapper that can execute the built CLI through AGENT_MEMORY_CLI", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes", "--package-manager", "bun"], { cwd: repoRoot });

    const cliPath = path.resolve("packages/cli/src/index.ts");
    const helperPath = path.join(repoRoot, "agent-memory-dev-helper");
    fs.writeFileSync(helperPath, `#!/usr/bin/env bash\nexec bun "${cliPath}" "$@"\n`);
    fs.chmodSync(helperPath, 0o755);

    const result = spawnSync("bash", ["bin/memory", "help"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENT_MEMORY_CLI: helperPath
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent-memory");
  });

  test("can install non-blocking git hooks during init", async () => {
    const repoRoot = makeGitRepo();
    const result = await dispatch(["init", "--yes", "--install-hooks"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);

    for (const hookName of ["post-merge", "post-checkout", "post-rewrite"]) {
      const hookPath = path.join(repoRoot, ".git/hooks", hookName);
      expect(fs.existsSync(hookPath)).toBe(true);
      expect(fs.readFileSync(hookPath, "utf8")).toContain("bin/memory sync");
    }
  });

  test("honors a single requested agent target", async () => {
    const repoRoot = makeGitRepo();
    await dispatch(["init", "--yes", "--agent", "generic"], { cwd: repoRoot });

    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"))).toBe(false);
  });

  test("installs a selected agent skill under a custom location", async () => {
    const repoRoot = makeGitRepo();
    const result = await dispatch(["init", "--yes", "--agent", "codex", "--skill-location", ".agents"], { cwd: repoRoot });
    const skillPath = path.join(repoRoot, ".agents/skills/repo-memory/SKILL.md");
    const config = loadConfig({ repoRoot }).config;

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"))).toBe(false);
    expect(config.agent_skills.codex.path).toBe(".agents/skills/repo-memory/SKILL.md");
    expect(fs.readFileSync(skillPath, "utf8")).toContain("Canonical memory lives in:");
  });

  test("requires an explicit single agent when init uses a custom skill location", async () => {
    const repoRoot = makeGitRepo();

    await expect(dispatch(["init", "--yes", "--skill-location", ".agents"], { cwd: repoRoot })).rejects.toThrow(
      "--skill-location requires exactly one --agent target"
    );

    await expect(
      dispatch(["init", "--yes", "--agent", "codex", "--agent", "generic", "--skill-location", ".agents"], { cwd: repoRoot })
    ).rejects.toThrow("--skill-location requires exactly one --agent target");
  });

  test("core init rejects custom skill locations with multiple agent targets", () => {
    const repoRoot = makeGitRepo();

    expect(() =>
      initRepository({
        cwd: repoRoot,
        yes: true,
        force: false,
        packageManager: "npm",
        agents: ["codex", "generic"],
        installHooks: false,
        skillLocation: ".agents"
      })
    ).toThrow("skillLocation requires exactly one agent target");
  });
});

function makeGitRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-init-"));
  const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
  expect(init.status).toBe(0);
  return repoRoot;
}
