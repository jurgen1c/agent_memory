import { describe, expect, test } from "bun:test";
import { dispatch, runCli } from "../../packages/cli/src/router";

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

    expect(init.stdout).toContain("agent-memory init --yes --force");
    expect(query.stdout).toContain("--include-stale");
    expect(templates.stdout).toContain("templates copy claim:fact --to /tmp/fact.md --force");
    expect(installHooks.stdout).toContain("agent-memory install-hooks --json");
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
      "doctor",
      "sync",
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
    expect(result.stdout).toBe("agent-memory 0.1.0");
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
