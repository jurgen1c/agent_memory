import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(".");

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
  files?: string[];
  main?: string;
  workspaces?: string[];
}

const rootPackage = readPackage("package.json");

describe("workspace package layout", () => {
  test("keeps the published Agent Memory CLI package as the compatibility anchor", () => {
    expect(rootPackage.name).toBe("@jurgen1c/agent-memory-cli");
    expect(rootPackage.main).toBe("dist/agent-memory.js");
    expect(rootPackage.bin).toEqual({
      "agent-memory": "dist/agent-memory.js",
      "agentflow": "dist/agentflow.js"
    });
    expect(rootPackage.files).toContain("dist/");
    expect(rootPackage.files).toContain("packages/");
  });

  test("uses explicit workspace package names and entrypoints", () => {
    const packages = {
      "packages/agent-tools/package.json": {
        name: "@jurgen1c/agent-tools",
        exports: { ".": "./src/index.ts" }
      },
      "packages/agentflow/package.json": {
        name: "@jurgen1c/agentflow",
        exports: { ".": "./src/index.ts" }
      },
      "packages/agentflow-agent-memory-adapter/package.json": {
        name: "@jurgen1c/agentflow-agent-memory-adapter",
        exports: { ".": "./src/index.ts" }
      },
      "packages/agentflow-cli/package.json": {
        name: "@jurgen1c/agentflow-cli",
        exports: { ".": "./src/index.ts", "./router": "./src/router.ts" }
      },
      "packages/agentflow-core/package.json": {
        name: "@jurgen1c/agentflow-core",
        exports: { ".": "./src/index.ts" }
      },
      "packages/agentflow-schemas/package.json": {
        name: "@jurgen1c/agentflow-schemas",
        exports: { ".": "./src/index.ts", "./config": "./config.schema.json", "./workflow": "./workflow.schema.json" }
      },
      "packages/cli/package.json": {
        name: "@jurgen1c/agent-memory-cli-workspace",
        exports: { ".": "./src/index.ts", "./router": "./src/router.ts" }
      },
      "packages/core/package.json": {
        name: "@jurgen1c/agent-memory-core",
        exports: { ".": "./src/index.ts" }
      },
      "packages/schemas/package.json": {
        name: "@jurgen1c/agent-memory-schemas",
        exports: {
          "./claim": "./claim.schema.json",
          "./config": "./config.schema.json",
          "./graph": "./graph.schema.json",
          "./index": "./index.schema.json",
          "./plan": "./plan.schema.json",
          "./profile": "./profile.schema.json",
          "./recipe": "./recipe.schema.json"
        }
      },
      "packages/web/package.json": {
        name: "@jurgen1c/agent-memory-web",
        exports: { ".": "./src/App.tsx" }
      }
    } satisfies Record<string, Pick<PackageJson, "name" | "exports">>;

    for (const [packagePath, expected] of Object.entries(packages)) {
      const packageJson = readPackage(packagePath);

      expect(packageJson.private).toBe(true);
      expect(packageJson.version).toBe(rootPackage.version);
      expect(packageJson.name).toBe(expected.name);
      expect(packageJson.exports).toEqual(expected.exports);
    }
  });

  test("keeps Agentflow dependent on shared tools without coupling Agent Memory to Agentflow", () => {
    const agentflow = readPackage("packages/agentflow/package.json");
    const agentflowAdapter = readPackage("packages/agentflow-agent-memory-adapter/package.json");
    const agentflowCli = readPackage("packages/agentflow-cli/package.json");
    const agentflowCore = readPackage("packages/agentflow-core/package.json");
    const core = readPackage("packages/core/package.json");
    const cli = readPackage("packages/cli/package.json");
    const agentflowSource = fs.readFileSync(path.join(repoRoot, "packages/agentflow/src/index.ts"), "utf8");

    expect(agentflow.dependencies).toEqual({
      "@jurgen1c/agentflow-core": "workspace:*"
    });
    expect(agentflowCore.dependencies).toEqual({
      "@jurgen1c/agent-tools": "workspace:*",
      "@jurgen1c/agentflow-schemas": "workspace:*"
    });
    expect(agentflowCli.dependencies).toEqual({
      "@jurgen1c/agentflow-core": "workspace:*"
    });
    expect(agentflowAdapter.dependencies).toEqual({
      "@jurgen1c/agent-memory-core": "workspace:*",
      "@jurgen1c/agentflow-core": "workspace:*"
    });
    expect(agentflowSource).toContain('from "@jurgen1c/agentflow-core"');
    expect(core.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow");
    expect(cli.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow");
    expect(core.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow-core");
    expect(cli.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow-core");
  });
});

function readPackage(packagePath: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf8")) as PackageJson;
}
