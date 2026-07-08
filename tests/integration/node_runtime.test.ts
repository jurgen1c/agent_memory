import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");
const builtCli = path.join(repoRoot, "dist/agent-memory.js");
const builtAgentflowCli = path.join(repoRoot, "dist/agentflow.js");
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string };

describe("built Node CLI", () => {
  test("compiles and queries through the Node SQLite adapter", () => {
    const build = run(["bun", "run", "build"], repoRoot, process.env);
    expect(build.exitCode).toBe(0);

    const cwd = copyFixture(mockApp);
    const env = {
      ...process.env,
      ASDF_NODEJS_VERSION: process.env.ASDF_NODEJS_VERSION ?? localNodeVersion()
    };
    const compile = run([builtCli, "compile"], cwd, env);

    expect(compile.exitCode).toBe(0);
    expect(compile.stdout).toContain("Agent Memory compiled.");
    expect(compile.stderr).not.toContain("ExperimentalWarning");

    const query = run([builtCli, "query", "oauth", "--json"], cwd, env);
    const parsed = JSON.parse(query.stdout);

    expect(query.exitCode).toBe(0);
    expect(parsed.matches.some((match: { id: string }) => match.id === "auth.student_oauth.uid_is_tenant_scoped")).toBe(true);
    expect(query.stderr).not.toContain("ExperimentalWarning");

    const agentflowHelp = run([builtAgentflowCli, "help"], repoRoot, env);
    const agentflowVersion = run([builtAgentflowCli, "--version"], repoRoot, env);
    const agentflowRun = run([builtAgentflowCli, "run"], repoRoot, env);

    expect(agentflowHelp.exitCode).toBe(0);
    expect(agentflowHelp.stdout).toContain("No workflow execution commands are active yet.");
    expect(agentflowVersion.exitCode).toBe(0);
    expect(agentflowVersion.stdout).toContain("agentflow ");
    expect(agentflowRun.exitCode).toBe(7);
    expect(agentflowRun.stderr).toContain("reserved but not active yet");

    const nestedPackageRoot = installNestedAgentflowPackage();
    const nestedAgentflowVersion = run([path.join(nestedPackageRoot, "dist/agentflow.js"), "--version"], path.dirname(nestedPackageRoot), env);

    expect(nestedAgentflowVersion.exitCode).toBe(0);
    expect(nestedAgentflowVersion.stdout).toContain(`agentflow ${rootPackage.version}`);
  });
});

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-node-runtime-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function installNestedAgentflowPackage(): string {
  const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-nested-parent-"));
  fs.writeFileSync(path.join(parentRoot, "package.json"), `${JSON.stringify({ name: "ancestor-package", version: "9.9.9" }, null, 2)}\n`);

  const packageRoot = path.join(parentRoot, "node_modules/@jurgen1c/agent-memory-cli");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
  fs.copyFileSync(builtAgentflowCli, path.join(packageRoot, "dist/agentflow.js"));

  return packageRoot;
}

function run(command: string[], cwd: string, env: Bun.Env): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { cwd, env });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr)
  };
}

function localNodeVersion(): string {
  const toolVersions = fs.readFileSync(path.join(repoRoot, ".tool-versions"), "utf8");
  const nodeLine = toolVersions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("nodejs "));
  return nodeLine?.split(/\s+/)[1] ?? "25.9.0";
}
