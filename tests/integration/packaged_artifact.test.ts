import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(".");
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string };

describe("packaged artifact", () => {
  test("smoke-tests built CLI artifacts and public package dry-runs", () => {
    runCommand("bun", ["run", "build"], repoRoot, 120000);

    const packageRoot = copyBuiltCliPackage();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-built-cli-smoke-"));
    const agentMemory = path.join(packageRoot, "dist/agent-memory.js");
    const agentflow = path.join(packageRoot, "dist/agentflow.js");

    expect(runCommand(agentMemory, ["help"], appRoot).stdout).toContain("Repository-local agent memory");
    expect(runCommand(agentMemory, ["--version"], appRoot).stdout).toContain(`agent-memory ${rootPackage.version}`);
    expect(runCommand(agentflow, ["help"], appRoot).stdout).toContain("Lifecycle state management is active");
    expect(runCommand(agentflow, ["--version"], appRoot).stdout).toContain(`agentflow ${rootPackage.version}`);

    const rootPack = packDryRun(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    const agentflowPack = packDryRun(["pack", "--workspace", "@jurgen1c/agentflow-cli", "--dry-run", "--json", "--ignore-scripts"]);
    const agentToolsPack = packDryRun(["pack", "--workspace", "@jurgen1c/agent-tools", "--dry-run", "--json", "--ignore-scripts"]);

    expect(rootPack.name).toBe("@jurgen1c/agent-memory-cli");
    expect(agentflowPack.name).toBe("@jurgen1c/agentflow-cli");
    expect(agentToolsPack.name).toBe("@jurgen1c/agent-tools");

    expect(rootPack.paths).toEqual(expect.arrayContaining(["dist/agent-memory.js", "dist/agentflow.js", "package.json"]));
    expect(agentflowPack.paths).toEqual(expect.arrayContaining(["dist/index.js", "dist/router.js", "src/router.d.ts", "package.json"]));
    expect(agentToolsPack.paths).toEqual(expect.arrayContaining(["dist/index.js", "src/index.ts", "README.md", "package.json"]));

    expect(agentflowPack.paths).not.toContain("src/router.ts");
    expect(agentToolsPack.paths).not.toContain("src/index.d.ts");

    for (const pack of [rootPack, agentflowPack, agentToolsPack]) {
      expectNoGeneratedArtifacts(pack.paths);
    }
  }, 120000);

  test("runs the installed CLI, generated wrapper, and UI static asset path", async () => {
    const appRoot = installPackedCli();
    const cliPath = path.join(appRoot, "node_modules/.bin/agent-memory");
    const agentflowPath = path.join(appRoot, "node_modules/.bin/agentflow");
    const packageRoot = path.join(appRoot, "node_modules/@jurgen1c/agent-memory-cli");

    expect(runCommand(cliPath, ["--version"], appRoot).stdout).toContain(`agent-memory ${rootPackage.version}`);
    expect(runCommand(agentflowPath, ["--version"], appRoot).stdout).toContain(`agentflow ${rootPackage.version}`);
    expect(runCommand(agentflowPath, ["help"], appRoot).stdout).toContain("Lifecycle state management is active");
    expect(runCommand(cliPath, ["upgrade", "--write"], appRoot).stdout).toContain("upgrade applied");
    expect(runCommand(cliPath, ["compile"], appRoot).stdout).toContain("Agent Memory compiled.");

    const query = JSON.parse(runCommand(cliPath, ["query", "oauth", "--json"], appRoot).stdout) as { matches: Array<{ id: string }> };
    expect(query.matches.some((match) => match.id === "auth.student_oauth.uid_is_tenant_scoped")).toBe(true);

    expect(runCommand(path.join(appRoot, "bin/memory"), ["--version"], appRoot).stdout).toContain(`agent-memory ${rootPackage.version}`);
    expect(runCommand(path.join(appRoot, "bin/memory"), ["upgrade"], appRoot).stdout).toContain("dry run");

    await expectUiStaticRoot(cliPath, appRoot, packageRoot);
  }, 120000);
});

interface PackDryRun {
  name: string;
  paths: string[];
}

function copyBuiltCliPackage(): string {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-built-package-"));

  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
  fs.copyFileSync(path.join(repoRoot, "dist/agent-memory.js"), path.join(packageRoot, "dist/agent-memory.js"));
  fs.copyFileSync(path.join(repoRoot, "dist/agentflow.js"), path.join(packageRoot, "dist/agentflow.js"));

  return packageRoot;
}

function packDryRun(args: string[]): PackDryRun {
  const result = runCommand("npm", args, repoRoot, 120000);
  const entries = JSON.parse(result.stdout) as Array<{ name: string; files: Array<{ path: string }> }>;

  expect(entries).toHaveLength(1);

  return {
    name: entries[0].name,
    paths: entries[0].files.map((file) => file.path).sort()
  };
}

function expectNoGeneratedArtifacts(paths: string[]): void {
  for (const filePath of paths) {
    expect(filePath.startsWith(".agent-memory/")).toBe(false);
    expect(filePath.startsWith(".agentflow/runs/")).toBe(false);
    expect(filePath.startsWith("node_modules/")).toBe(false);
    expect(filePath.startsWith("dist/.agent-memory/")).toBe(false);
    expect(filePath.startsWith("agentflow-examples/")).toBe(false);
    expect(filePath.startsWith("agentflow-workflow-specs/")).toBe(false);
  }
}

function installPackedCli(): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-packaged-smoke-"));
  const packDir = path.join(workspaceRoot, "pack");
  const extractDir = path.join(workspaceRoot, "extract");
  const appRoot = path.join(workspaceRoot, "app");

  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });
  fs.cpSync(path.join(repoRoot, "examples/mock-app"), appRoot, { recursive: true });

  runCommand("bun", ["run", "build"], repoRoot, 120000);

  const packed = runCommand("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], repoRoot, 120000);
  const tarballPath = path.join(packDir, packedTarballName(packDir, packed.stdout));
  expect(fs.existsSync(tarballPath)).toBe(true);

  runCommand("tar", ["-xzf", tarballPath, "-C", extractDir], repoRoot);

  const packageRoot = path.join(appRoot, "node_modules/@jurgen1c/agent-memory-cli");
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.cpSync(path.join(extractDir, "package"), packageRoot, { recursive: true });
  installBinShim(appRoot);

  return appRoot;
}

function packedTarballName(packDir: string, stdout: string): string {
  if (stdout.trim().length > 0) {
    const packEntries = JSON.parse(stdout) as Array<{ filename: string }>;
    return packEntries[0].filename;
  }

  const tarballs = fs.readdirSync(packDir).filter((entry) => entry.endsWith(".tgz")).sort();
  expect(tarballs).toHaveLength(1);
  return tarballs[0];
}

function installBinShim(appRoot: string): void {
  const binDir = path.join(appRoot, "node_modules/.bin");
  const binPath = path.join(binDir, "agent-memory");
  const agentflowBinPath = path.join(binDir, "agentflow");

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
exec node "\${SCRIPT_DIR}/../@jurgen1c/agent-memory-cli/dist/agent-memory.js" "$@"
`
  );
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(
    agentflowBinPath,
    `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
exec node "\${SCRIPT_DIR}/../@jurgen1c/agent-memory-cli/dist/agentflow.js" "$@"
`
  );
  fs.chmodSync(agentflowBinPath, 0o755);
}

function runCommand(command: string, args: string[], cwd: string, timeout = 30000): { stdout: string; stderr: string } {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-command-output-"));
  const stdoutPath = path.join(outputDir, "stdout");
  const stderrPath = path.join(outputDir, "stderr");
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: commandEnv(),
    stdio: ["ignore", stdoutFd, stderrFd],
    timeout
  });
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const stdout = fs.readFileSync(stdoutPath, "utf8");
  const stderr = fs.readFileSync(stderrPath, "utf8");

  const errorMessage = result.error ? `\nERROR:\n${result.error.message}` : "";
  expect(result.status, `${command} ${args.join(" ")}${errorMessage}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`).toBe(0);

  return {
    stdout,
    stderr
  };
}

async function expectUiStaticRoot(cliPath: string, appRoot: string, packageRoot: string): Promise<void> {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-ui-output-"));
  const stdoutPath = path.join(outputDir, "stdout");
  const stderrPath = path.join(outputDir, "stderr");
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  const child = spawn(cliPath, ["ui", "--json", "--port", "0"], {
    cwd: appRoot,
    env: commandEnv(),
    stdio: ["ignore", stdoutFd, stderrFd]
  });

  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const closeOutput = () => {
      try {
        fs.closeSync(stdoutFd);
      } catch {
        // Already closed.
      }

      try {
        fs.closeSync(stderrFd);
      } catch {
        // Already closed.
      }
    };
    const readOutput = () => ({
      stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : "",
      stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8") : ""
    });
    const interval = setInterval(() => {
      const { stdout } = readOutput();
      const parsed = tryParseJson(stdout);

      if (!parsed || settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      child.kill("SIGTERM");
      closeOutput();

      const staticRoot = String(parsed.staticRoot);
      expect(path.resolve(staticRoot)).toBe(path.join(packageRoot, "dist/web"));
      expect(fs.existsSync(path.join(staticRoot, "index.html"))).toBe(true);
      resolve();
    }, 100);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(interval);
        child.kill("SIGTERM");
        closeOutput();
        const { stdout, stderr } = readOutput();
        reject(new Error(`Timed out waiting for ui --json output.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    }, 15000);

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(interval);
        closeOutput();
        reject(error);
      }
    });

    child.on("exit", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      closeOutput();
      const { stdout, stderr } = readOutput();
      const parsed = tryParseJson(stdout);

      if (code !== 0 || !parsed) {
        reject(new Error(`ui exited before reporting JSON with code ${code}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }

      const staticRoot = String(parsed.staticRoot);
      expect(path.resolve(staticRoot)).toBe(path.join(packageRoot, "dist/web"));
      expect(fs.existsSync(path.join(staticRoot, "index.html"))).toBe(true);
      resolve();
    });
  });
}

function tryParseJson(value: string): { staticRoot?: unknown } | null {
  try {
    return JSON.parse(value.trim()) as { staticRoot?: unknown };
  } catch {
    return null;
  }
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ASDF_NODEJS_VERSION: process.env.ASDF_NODEJS_VERSION ?? localNodeVersion(),
    npm_config_cache: path.join(os.tmpdir(), "agent-memory-npm-cache")
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
