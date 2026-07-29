import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.join(import.meta.dir, "..");

describe("standalone Agent Memory architecture", () => {
  test("publishes only Agent Memory with a registry-safe Core dependency", () => {
    const packageJson = readJson("package.json") as {
      name: string;
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
      workspaces?: string[];
    };

    expect(packageJson.name).toBe("@jurgen1c/agent-memory-cli");
    expect(packageJson.bin).toEqual({
      "agent-memory": "./dist/agent-memory.js"
    });
    expect(packageJson.dependencies?.["@jurgen1c/agent-core"]).toBe("^0.1.0");
    expect(packageJson.workspaces).toEqual(["packages/*"]);
    for (const range of Object.values(packageJson.dependencies ?? {})) {
      expect(range).not.toMatch(/^(?:workspace:|file:)/);
    }
  });

  test("contains no Agent Flow package, implementation, import, fixture, or binary", () => {
    const packageDirectories = fs.readdirSync(path.join(repositoryRoot, "packages"));
    const tests = sourceFiles(path.join(repositoryRoot, "tests"));
    const source = sourceFiles(path.join(repositoryRoot, "packages"))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    expect(packageDirectories.some((entry) => /agentflow|agent-flow/i.test(entry))).toBe(false);
    expect(tests.some((file) => /agentflow|agent_flow|agent-flow/i.test(file))).toBe(false);
    expect(source).not.toMatch(/@jurgen1c\/agent-flow/);
    expect(source).not.toMatch(/@jurgen1c\/agentflow/);
    expect(fs.existsSync(path.join(repositoryRoot, "dist", "agentflow.js"))).toBe(false);
    expect(fs.existsSync(path.join(repositoryRoot, "dist", "agent-flow.js"))).toBe(false);

    const lockfile = fs.readFileSync(path.join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockfile).not.toMatch(/agentflow|agent-tools|file:\/|\/tmp\//i);
  });

  test("uses Agent Core for YAML, repository safety, and SQLite", () => {
    const coreSource = sourceFiles(path.join(repositoryRoot, "packages", "core", "src"))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    expect(coreSource).toContain("@jurgen1c/agent-core/yaml");
    expect(coreSource).toContain("@jurgen1c/agent-core/repository");
    expect(coreSource).toContain("@jurgen1c/agent-core/sqlite");
  });
});

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(candidate);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [candidate] : [];
  });
}
