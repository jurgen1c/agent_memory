import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(".");

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, string | { types: string; default: string }>;
  files?: string[];
  main?: string;
  publishConfig?: Record<string, string>;
  scripts?: Record<string, string>;
  types?: string;
  workspaces?: string[];
}

interface VerificationPlan {
  mode: "build" | "typecheck";
  rootPackage: string;
  workspacePackages: Array<{ name: string; path: string }>;
  coveredPackageNames: string[];
  tasks: Array<{
    label: string;
    kind: "command" | "internal";
    command: string | null;
    args: string[] | null;
    packages: string[];
  }>;
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
        exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } }
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

      if (packagePath === "packages/agent-tools/package.json") {
        expect(packageJson.private).toBeUndefined();
        expect(packageJson.main).toBe("./dist/index.js");
        expect(packageJson.types).toBe("./src/index.ts");
        expect(packageJson.publishConfig).toEqual({ access: "public" });
        expect(packageJson.files).toEqual(["dist/", "src/", "README.md"]);
        expect(packageJson.scripts).toEqual({ build: "bun build src/index.ts --target=node --outfile=dist/index.js" });
        expect(packageJson.dependencies ?? {}).toEqual({});
        expect(packageJson.optionalDependencies ?? {}).toEqual({});
        expect(packageJson.peerDependencies ?? {}).toEqual({});
        expect(packageJson.bin ?? {}).toEqual({});
      } else {
        expect(packageJson.private).toBe(true);
      }
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
    expect(agentflowCore.dependencies).toHaveProperty("@jurgen1c/agent-tools");
    expect(core.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agent-tools");
    expect(core.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow");
    expect(cli.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow");
    expect(core.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow-core");
    expect(cli.dependencies ?? {}).not.toHaveProperty("@jurgen1c/agentflow-core");
  });

  test("routes root verification through every workspace package", () => {
    expect(rootPackage.scripts?.build).toBe("node scripts/run-root-verification.mjs build");
    expect(rootPackage.scripts?.typecheck).toBe("node scripts/run-root-verification.mjs typecheck");
    expect(rootPackage.scripts?.test).toBe("bun test");

    const workspaceNames = workspacePackageNames();
    const buildPlan = verificationPlan("build");
    const typecheckPlan = verificationPlan("typecheck");

    expect(buildPlan.rootPackage).toBe(rootPackage.name);
    expect(buildPlan.workspacePackages.map((pkg) => pkg.name).sort()).toEqual(workspaceNames);
    expect(buildPlan.coveredPackageNames).toEqual([rootPackage.name, ...workspaceNames].sort());
    expect(typecheckPlan.coveredPackageNames).toContain("@jurgen1c/agent-memory-core");
    expect(typecheckPlan.coveredPackageNames).toContain("@jurgen1c/agentflow-core");
    expect(typecheckPlan.coveredPackageNames).toContain("@jurgen1c/agent-memory-web");

    expect(buildPlan.tasks.map((task) => task.label)).toEqual([
      "check:workspace-packages",
      "typecheck:packages",
      "typecheck:web",
      "build:web",
      "build:agent-tools",
      "bundle:agent-memory-cli",
      "bundle:agentflow-cli"
    ]);
    expect(typecheckPlan.tasks.map((task) => task.label)).toEqual([
      "check:workspace-packages",
      "typecheck:packages",
      "typecheck:web"
    ]);

    const workspaceCheck = buildPlan.tasks.find((task) => task.label === "check:workspace-packages");
    expect(workspaceCheck?.kind).toBe("internal");
    expect(workspaceCheck?.packages.sort()).toEqual(workspaceNames);
    expect(buildPlan.tasks.find((task) => task.label === "bundle:agent-memory-cli")?.packages).toContain("@jurgen1c/agent-memory-core");
    expect(buildPlan.tasks.find((task) => task.label === "bundle:agentflow-cli")?.packages).toContain("@jurgen1c/agentflow-core");
  });
});

function readPackage(packagePath: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf8")) as PackageJson;
}

function workspacePackageNames(): string[] {
  const workspaces = rootPackage.workspaces ?? [];

  return workspaces
    .flatMap((workspace) => {
      const basePath = workspace.replace(/\/\*$/, "");

      return fs
        .readdirSync(path.join(repoRoot, basePath), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readPackage(path.join(basePath, entry.name, "package.json")).name);
    })
    .sort();
}

function verificationPlan(mode: VerificationPlan["mode"]): VerificationPlan {
  const result = spawnSync("bun", ["scripts/run-root-verification.mjs", mode, "--plan"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  expect(result.status, result.stderr).toBe(0);

  return JSON.parse(result.stdout) as VerificationPlan;
}
