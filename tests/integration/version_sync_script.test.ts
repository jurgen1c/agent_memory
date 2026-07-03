import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts/sync-workspace-versions.mjs");

describe("workspace version sync script", () => {
  test("syncs workspace package versions from workspace config and stages updates", () => {
    const workspaceRoot = makeWorkspace({
      version: "1.0.0",
      workspaces: ["packages/*", "tools/standalone"],
      packages: {
        "packages/alpha": "0.9.0",
        "packages/bravo": "0.9.0",
        "tools/standalone": "0.9.0"
      }
    });
    fs.mkdirSync(path.join(workspaceRoot, "packages/notes"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "packages/notes/README.md"), "No package here.\n");
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["-c", "user.name=Agent Memory Test", "-c", "user.email=test@example.test", "commit", "-m", "Initial"]);

    writeJson(path.join(workspaceRoot, "package.json"), {
      name: "version-sync-fixture",
      version: "2.0.0",
      workspaces: ["packages/*", "tools/standalone"]
    });

    const result = runScript(workspaceRoot, ["--stage"]);

    expect(result.exitCode).toBe(0);
    expect(readVersion(workspaceRoot, "packages/alpha/package.json")).toBe("2.0.0");
    expect(readVersion(workspaceRoot, "packages/bravo/package.json")).toBe("2.0.0");
    expect(readVersion(workspaceRoot, "tools/standalone/package.json")).toBe("2.0.0");
    expect(readGeneratedVersion(workspaceRoot)).toBe("2.0.0");

    const stagedFiles = git(workspaceRoot, ["diff", "--cached", "--name-only"]).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
    expect(stagedFiles).toEqual([
      "packages/core/src/generated_version.ts",
      "packages/alpha/package.json",
      "packages/bravo/package.json",
      "tools/standalone/package.json"
    ].sort());
  });

  test("supports object-form workspace config and is idempotent when versions already match", () => {
    const workspaceRoot = makeWorkspace({
      version: "3.1.4",
      workspaces: { packages: ["packages/*"] },
      packages: {
        "packages/alpha": "3.1.4"
      }
    });
    const packagePath = path.join(workspaceRoot, "packages/alpha/package.json");
    const before = fs.readFileSync(packagePath, "utf8");

    const result = runScript(workspaceRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(fs.readFileSync(packagePath, "utf8")).toBe(before);
  });

  test("checks workspace package versions without rewriting files", () => {
    const workspaceRoot = makeWorkspace({
      version: "4.0.0",
      workspaces: ["packages/*"],
      packages: {
        "packages/alpha": "3.9.0",
        "packages/bravo": "4.0.0"
      }
    });
    const packagePath = path.join(workspaceRoot, "packages/alpha/package.json");
    const before = fs.readFileSync(packagePath, "utf8");

    const result = runScript(workspaceRoot, ["--check"]);

    expect(result.exitCode).toBe(1);
    expect(fs.readFileSync(packagePath, "utf8")).toBe(before);
  });

  test("checks generated version metadata without rewriting files", () => {
    const workspaceRoot = makeWorkspace({
      version: "5.0.0",
      generatedVersion: "4.9.0",
      workspaces: ["packages/*"],
      packages: {
        "packages/alpha": "5.0.0"
      }
    });
    const generatedPath = path.join(workspaceRoot, "packages/core/src/generated_version.ts");
    const before = fs.readFileSync(generatedPath, "utf8");

    const result = runScript(workspaceRoot, ["--check"]);

    expect(result.exitCode).toBe(1);
    expect(fs.readFileSync(generatedPath, "utf8")).toBe(before);
  });

  test("reports unparseable generated version metadata", () => {
    const workspaceRoot = makeWorkspace({
      version: "6.0.0",
      workspaces: ["packages/*"],
      packages: {
        "packages/alpha": "6.0.0"
      }
    });
    const generatedPath = path.join(workspaceRoot, "packages/core/src/generated_version.ts");
    fs.writeFileSync(generatedPath, "export const OTHER_VERSION = \"6.0.0\";\n");

    const result = runScript(workspaceRoot, ["--check"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/core/src/generated_version.ts: unparseable");
  });
});

function makeWorkspace(input: {
  version: string;
  generatedVersion?: string;
  workspaces: string[] | { packages: string[] };
  packages: Record<string, string>;
}): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-version-sync-"));
  writeJson(path.join(workspaceRoot, "package.json"), {
    name: "version-sync-fixture",
    version: input.version,
    workspaces: input.workspaces
  });

  for (const [packageDir, version] of Object.entries(input.packages)) {
    writeJson(path.join(workspaceRoot, packageDir, "package.json"), {
      name: packageDir.replaceAll("/", "-"),
      version,
      private: true
    });
  }

  writeGeneratedVersion(workspaceRoot, input.generatedVersion ?? input.version);

  return workspaceRoot;
}

function runScript(cwd: string, args: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-version-sync-output-"));
  const stdoutPath = path.join(outputDir, "stdout");
  const stderrPath = path.join(outputDir, "stderr");
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  const result = spawnSync("node", [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", stdoutFd, stderrFd],
    env: {
      ...process.env,
      ASDF_NODEJS_VERSION: process.env.ASDF_NODEJS_VERSION ?? localNodeVersion()
    }
  });
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  return {
    exitCode: result.status ?? 1,
    stdout: fs.readFileSync(stdoutPath, "utf8"),
    stderr: fs.readFileSync(stderrPath, "utf8")
  };
}

function git(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function readVersion(workspaceRoot: string, packagePath: string): string {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, packagePath), "utf8")).version as string;
}

function readGeneratedVersion(workspaceRoot: string): string {
  const content = fs.readFileSync(path.join(workspaceRoot, "packages/core/src/generated_version.ts"), "utf8");
  return content.match(/GENERATED_PACKAGE_VERSION\s*=\s*["']([^"']+)["']/)?.[1] ?? "";
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeGeneratedVersion(workspaceRoot: string, version: string): void {
  const filePath = path.join(workspaceRoot, "packages/core/src/generated_version.ts");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `export const GENERATED_PACKAGE_VERSION = "${version}";\n`);
}

function localNodeVersion(): string {
  const toolVersions = fs.readFileSync(path.join(repoRoot, ".tool-versions"), "utf8");
  const nodeLine = toolVersions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("nodejs "));
  return nodeLine?.split(/\s+/)[1] ?? "25.9.0";
}
