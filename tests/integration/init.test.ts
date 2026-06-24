import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";

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
      ".codex/skills/repo-memory/SKILL.md",
      "docs/agent-memory/AGENT_SKILL.md"
    ]) {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(true);
    }

    expect(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8")).toContain(".agent-memory/");
    expect(fs.statSync(path.join(repoRoot, "bin/memory")).mode & 0o111).toBeGreaterThan(0);

    const second = await dispatch(["init", "--yes"], { cwd: repoRoot });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("skipped");
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
});

function makeGitRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-init-"));
  const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
  expect(init.status).toBe(0);
  return repoRoot;
}
