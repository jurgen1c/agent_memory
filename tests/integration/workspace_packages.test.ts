import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
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
  workspaces?: string[] | { packages?: unknown[] };
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
        exports: {
          ".": { types: "./src/router.d.ts", default: "./dist/router.js" },
          "./router": { types: "./src/router.d.ts", default: "./dist/router.js" }
        }
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
        expect(packageJson.scripts).toEqual({
          build: "bun build src/index.ts --target=node --outfile=dist/index.js",
          prepack: "bun run build"
        });
        expect(packageJson.dependencies ?? {}).toEqual({});
        expect(packageJson.optionalDependencies ?? {}).toEqual({});
        expect(packageJson.peerDependencies ?? {}).toEqual({});
        expect(packageJson.bin ?? {}).toEqual({});
      } else if (packagePath === "packages/agentflow-cli/package.json") {
        expect(packageJson.private).toBeUndefined();
        expect(packageJson.main).toBe("./dist/router.js");
        expect(packageJson.types).toBe("./src/router.d.ts");
        expect(packageJson.publishConfig).toEqual({ access: "public" });
        expect(packageJson.files).toEqual(["dist/", "src/router.d.ts"]);
        expect(packageJson.scripts).toEqual({
          build: "bun build src/index.ts src/router.ts --target=node --outdir=dist",
          prepack: "bun run build"
        });
        expect(packageJson.bin).toEqual({ agentflow: "dist/index.js" });
        expect(packageJson.dependencies ?? {}).toEqual({});
        expect(fs.readFileSync(path.join(repoRoot, "packages/agentflow-cli/src/router.d.ts"), "utf8")).not.toContain("@jurgen1c/agentflow-core");
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
      "@jurgen1c/agentflow-schemas": "workspace:*",
      yaml: "^2.9.0"
    });
    expect(agentflowCli.dependencies ?? {}).toEqual({});
    expect(agentflowAdapter.dependencies).toEqual({
      "@jurgen1c/agent-memory-core": "workspace:*",
      "@jurgen1c/agentflow-core": "workspace:*"
    });
    expect(agentflowSource).toContain('from "@jurgen1c/agentflow-core"');
    expect(fs.readFileSync(path.join(repoRoot, "packages/agentflow-cli/src/router.ts"), "utf8")).toContain('from "@jurgen1c/agentflow-core"');
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
    expect(rootPackage.scripts?.["test:coverage"]).toBe("bun test --coverage --no-concurrent");
    expect(rootPackage.scripts?.ci).toContain("bun run test:coverage");
    expect(rootPackage.scripts?.ci).not.toContain("&& bun test &&");

    const bunfig = fs.readFileSync(path.join(repoRoot, "bunfig.toml"), "utf8");
    expect(bunfig).toContain('coverageReporter = ["text", "lcov"]');
    expect(bunfig).toContain("coverageSkipTestFiles = true");
    expect(bunfig).toContain("coverageThreshold = { lines = 0.9, functions = 0.85, statements = 0.85 }");
    expect(bunfig).toContain("concurrentTestGlob = [");
    expect(bunfig).toContain('"tests/unit/ui_command.test.ts"');

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
      "build:agentflow-cli-package",
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

  test("rejects unknown root verification arguments", () => {
    const unknownFlag = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck", "--plna"], { cwd: repoRoot });
    const extraMode = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck", "build"], { cwd: repoRoot });
    const unknownFlagStderr = new TextDecoder().decode(unknownFlag.stderr);
    const extraModeStderr = new TextDecoder().decode(extraMode.stderr);

    expect(unknownFlag.exitCode).toBe(2);
    expect(unknownFlagStderr).toContain("Unknown option: --plna");
    expect(unknownFlagStderr).toContain("Usage: node scripts/run-root-verification.mjs <build|typecheck> [--plan]");
    expect(extraMode.exitCode).toBe(2);
    expect(extraModeStderr).toContain("Expected exactly one mode argument.");
  });

  test("reports internal verification failures without stack traces", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-root-verification-"));
    fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "packages/bad/src"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/run-root-verification.mjs"),
      path.join(fixtureRoot, "scripts/run-root-verification.mjs")
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "@example/root",
          workspaces: ["packages/*"]
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "packages/bad/package.json"),
      JSON.stringify(
        {
          name: "@example/bad",
          dependencies: {
            "@example/missing": "workspace:^"
          }
        },
        null,
        2
      )
    );

    const result = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck"], { cwd: fixtureRoot });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain(
      "check:workspace-packages failed: packages/bad/package.json references unknown workspace dependency @example/missing"
    );
    expect(stderr).not.toContain("Error:");
    expect(stderr).not.toContain("at ");
  });

  test("reports setup failures without stack traces", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-root-verification-"));
    fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/run-root-verification.mjs"),
      path.join(fixtureRoot, "scripts/run-root-verification.mjs")
    );
    fs.writeFileSync(path.join(fixtureRoot, "package.json"), "{ invalid json");

    const result = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck"], { cwd: fixtureRoot });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Root verification setup failed: package.json:");
    expect(stderr).not.toContain("SyntaxError:");
    expect(stderr).not.toContain("\n    at ");
  });

  test("reports workspace setup failures with the package path", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-root-verification-"));
    fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "packages/bad"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/run-root-verification.mjs"),
      path.join(fixtureRoot, "scripts/run-root-verification.mjs")
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "@example/root",
          workspaces: ["packages/*"]
        },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(fixtureRoot, "packages/bad/package.json"), "{ invalid json");

    const result = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck"], { cwd: fixtureRoot });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Root verification setup failed: packages/bad/package.json:");
    expect(stderr).not.toContain("SyntaxError:");
    expect(stderr).not.toContain("\n    at ");
  });

  test("rejects workspace patterns that escape the repository", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-root-verification-"));
    fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/run-root-verification.mjs"),
      path.join(fixtureRoot, "scripts/run-root-verification.mjs")
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "@example/root",
          workspaces: ["../*"]
        },
        null,
        2
      )
    );

    const result = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck"], { cwd: fixtureRoot });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Root verification setup failed: Workspace path escapes repository: ..");
    expect(stderr).not.toContain("\n    at ");
  });

  test("allows workspace directories with names that start with dot dot", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-root-verification-"));
    fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "..foo"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/run-root-verification.mjs"),
      path.join(fixtureRoot, "scripts/run-root-verification.mjs")
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "@example/root",
          workspaces: ["..foo"]
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "..foo/package.json"),
      JSON.stringify(
        {
          name: "@example/dotdot-name"
        },
        null,
        2
      )
    );

    const result = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck", "--plan"], { cwd: fixtureRoot });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    const plan = JSON.parse(stdout) as VerificationPlan;

    expect(result.exitCode, stderr).toBe(0);
    expect(plan.workspacePackages).toContainEqual({ name: "@example/dotdot-name", path: "..foo" });
  });

  test("reports command task signal termination explicitly", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-root-verification-"));
    const fakeBin = path.join(fixtureRoot, "bin");
    fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/run-root-verification.mjs"),
      path.join(fixtureRoot, "scripts/run-root-verification.mjs")
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "@example/root",
          workspaces: []
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(fakeBin, "bun"),
      [
        "#!/usr/bin/env node",
        "process.kill(process.pid, 'SIGTERM');"
      ].join("\n")
    );
    fs.chmodSync(path.join(fakeBin, "bun"), 0o755);

    const result = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", "typecheck"], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("typecheck:packages terminated by signal SIGTERM.");
    expect(stderr).not.toContain("exit code null");
  });
});

function readPackage(packagePath: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf8")) as PackageJson;
}

function workspacePackageNames(): string[] {
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces && Array.isArray(rootPackage.workspaces.packages)
      ? rootPackage.workspaces.packages
      : [];
  const includedPackagePaths = new Set(
    workspaces
      .filter(isIncludedWorkspacePattern)
      .flatMap((workspace) => packagePathsForWorkspace(workspace))
  );
  const excludedPackagePaths = new Set(
    workspaces
      .filter(isExcludedWorkspacePattern)
      .flatMap((workspace) => packagePathsForWorkspace(workspace.trim().slice(1)))
  );

  return [...includedPackagePaths]
    .filter((packagePath) => !excludedPackagePaths.has(packagePath))
    .map((packagePath) => readPackage(packagePath).name)
    .sort();
}

function packagePathsForWorkspace(workspace: string): string[] {
  if (!isIncludedWorkspacePattern(workspace)) {
    return [];
  }

  const trimmedWorkspace = workspace.trim();

  if (!trimmedWorkspace.includes("*")) {
    const packagePath = path.join(trimmedWorkspace, "package.json");

    return fs.existsSync(path.join(repoRoot, packagePath)) ? [packagePath] : [];
  }

  const wildcardIndex = trimmedWorkspace.indexOf("*");
  const baseDir = trimmedWorkspace.slice(0, wildcardIndex).replace(/\/+$/, "");
  const suffixSegments = trimmedWorkspace.slice(wildcardIndex + 1).split("/").filter(Boolean);
  const absoluteBaseDir = path.join(repoRoot, baseDir);

  if (!fs.existsSync(absoluteBaseDir)) {
    return [];
  }

  return fs
    .readdirSync(absoluteBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packagePath = path.join(baseDir, entry.name, ...suffixSegments, "package.json");

      return fs.existsSync(path.join(repoRoot, packagePath)) ? [packagePath] : [];
    });
}

function isIncludedWorkspacePattern(workspace: unknown): workspace is string {
  return typeof workspace === "string" && workspace.trim().length > 0 && !workspace.trim().startsWith("!");
}

function isExcludedWorkspacePattern(workspace: unknown): workspace is string {
  return typeof workspace === "string" && workspace.trim().startsWith("!") && workspace.trim().slice(1).trim().length > 0;
}

function verificationPlan(mode: VerificationPlan["mode"]): VerificationPlan {
  const result = Bun.spawnSync(["node", "scripts/run-root-verification.mjs", mode, "--plan"], { cwd: repoRoot });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  expect(result.exitCode, stderr).toBe(0);

  return JSON.parse(stdout) as VerificationPlan;
}
