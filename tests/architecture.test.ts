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
      engines?: { node?: string };
      repository?: { type?: string; url?: string };
      workspaces?: string[];
    };

    expect(packageJson.name).toBe("@jurgen1c/agent-memory-cli");
    expect(packageJson.bin).toEqual({
      "agent-memory": "dist/agent-memory.js"
    });
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/jurgen1c/agent_memory.git"
    });
    expect(packageJson.dependencies?.["@jurgen1c/agent-core"]).toBe("^0.2.0");
    expect(packageJson.engines?.node).toBe(">=25.9.0");
    expect(packageJson.workspaces).toEqual(["packages/*"]);
    expect(
      Object.keys(packageJson.dependencies ?? {})
        .filter((name) => name.startsWith("@jurgen1c/"))
    ).toEqual(["@jurgen1c/agent-core"]);
    expect(
      fs.readdirSync(path.join(repositoryRoot, "packages")).sort()
    ).toEqual(["cli", "core", "schemas", "web"]);
    for (const range of Object.values(packageJson.dependencies ?? {})) {
      expect(range).not.toMatch(/^(?:workspace:|file:)/);
    }

    const lockfile = fs.readFileSync(path.join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockfile).not.toMatch(/file:\/|\/tmp\//i);
  });

  test("uses Agent Core for YAML, repository safety, and SQLite", () => {
    const coreSource = sourceFiles(path.join(repositoryRoot, "packages", "core", "src"))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    expect(coreSource).toContain("@jurgen1c/agent-core/yaml");
    expect(coreSource).toContain("@jurgen1c/agent-core/repository");
    expect(coreSource).toContain("@jurgen1c/agent-core/sqlite");

    for (const relativePath of [
      "packages/core/src/files.ts",
      "packages/core/src/migration.ts",
      "packages/core/src/repo.ts",
      "packages/core/src/ui_server.ts",
      "packages/core/src/validator.ts"
    ]) {
      expect(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"))
        .toContain("@jurgen1c/agent-core/repository");
    }
  });

  test("routes every Git subprocess through the bounded Git adapter", () => {
    const sourceRoot = path.join(repositoryRoot, "packages", "core", "src");
    const childProcessImports = sourceFiles(sourceRoot)
      .filter((file) => fs.readFileSync(file, "utf8").includes('from "node:child_process"'))
      .map((file) => path.relative(repositoryRoot, file));

    expect(childProcessImports).toEqual(["packages/core/src/git.ts"]);
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
