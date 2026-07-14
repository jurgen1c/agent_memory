import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";
import { PACKAGE_VERSION } from "../../packages/core/src/version";

const repoRoot = path.resolve(".");
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string };

describe("CLI", () => {
  test("renders help", async () => {
    const result = await dispatch(["help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent-memory");
    expect(result.stdout).toContain("Available now");
  });

  test("renders command-specific help", async () => {
    const result = await dispatch(["help", "context"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Build task-ready memory context");
    expect(result.stdout).toContain("--include-inferred");
  });

  test("documents implemented command flags in help output", async () => {
    const init = await dispatch(["help", "init"]);
    const query = await dispatch(["help", "query"]);
    const templates = await dispatch(["help", "templates"]);
    const installHooks = await dispatch(["help", "install-hooks"]);
    const upgrade = await dispatch(["help", "upgrade"]);
    const migrateDocs = await dispatch(["help", "migrate-docs"]);
    const audit = await dispatch(["help", "audit"]);

    expect(init.stdout).toContain("agent-memory init --yes --force");
    expect(init.stdout).toContain("--skill-location .agents");
    expect(query.stdout).toContain("--include-stale");
    expect(templates.stdout).toContain("templates copy claim:fact --to /tmp/fact.md --force");
    expect(installHooks.stdout).toContain("agent-memory install-hooks --json");
    expect(upgrade.stdout).toContain("agent-memory upgrade --write --force");
    expect(migrateDocs.stdout).toContain("lowercase memory namespace");
    expect(audit.stdout).toContain("agent-memory audit --git-diff --base origin/main");
    expect(audit.stdout).toContain("agent-memory audit --git-diff --strict");
  });

  test("renders inline help for every command", async () => {
    const commands = [
      "init",
      "templates",
      "validate",
      "compile",
      "query",
      "show",
      "system",
      "context",
      "coverage",
      "audit",
      "doctor",
      "sync",
      "upgrade",
      "install-hooks",
      "ui",
      "install-skill",
      "agent-manifest",
      "migrate-docs",
      "new"
    ];

    for (const command of commands) {
      const result = await dispatch([command, "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`agent-memory ${command}`);
    }
  });

  test("renders version", async () => {
    const result = await dispatch(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`agent-memory ${rootPackage.version}`);
  });

  test("keeps CLI version metadata aligned with package metadata", () => {
    const workspacePackagePaths = [
      "packages/agent-tools/package.json",
      "packages/agentflow/package.json",
      "packages/agentflow-agent-memory-adapter/package.json",
      "packages/agentflow-cli/package.json",
      "packages/agentflow-core/package.json",
      "packages/agentflow-schemas/package.json",
      "packages/cli/package.json",
      "packages/core/package.json",
      "packages/schemas/package.json",
      "packages/web/package.json"
    ];

    expect(PACKAGE_VERSION).toBe(rootPackage.version);

    for (const packagePath of workspacePackagePaths) {
      const workspacePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf8")) as { version: string };
      expect(workspacePackage.version).toBe(rootPackage.version);
    }
  });

  test("unknown commands return not found", async () => {
    let stderr = "";
    const exitCode = await runCli(["missing"], {
      stdout: { write: () => true },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        }
      }
    });

    expect(exitCode).toBe(7);
    expect(stderr).toContain("Unknown command");
  });
});
