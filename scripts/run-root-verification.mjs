#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const parsedArgs = parseArgs(args);

if (!parsedArgs.ok) {
  console.error(parsedArgs.error);
  console.error("Usage: node scripts/run-root-verification.mjs <build|typecheck> [--plan]");
  process.exit(2);
}

const { mode, planOnly } = parsedArgs;

let rootPackage;
let workspacePackages;

try {
  rootPackage = readJson(path.join(repoRoot, "package.json"));
  workspacePackages = workspacePackageJsonPaths(rootPackage.workspaces)
    .map((packageJsonPath) => {
      const packageJson = readJson(packageJsonPath);

      return {
        name: packageJson.name,
        packageJson,
        packageJsonPath,
        path: path.dirname(packageJsonPath),
        relativePath: path.relative(repoRoot, path.dirname(packageJsonPath)).split(path.sep).join("/")
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
} catch (error) {
  console.error(`Root verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const typecheckTasks = [
  internalTask("check:workspace-packages", workspacePackages.map((pkg) => pkg.name), checkWorkspacePackages),
  commandTask("typecheck:packages", ["bun", ["run", "typecheck:packages"]], sourcePackageNames()),
  commandTask("typecheck:web", ["bun", ["run", "typecheck:web"]], ["@jurgen1c/agent-memory-web"])
];

const buildTasks = [
  ...typecheckTasks,
  commandTask("build:web", ["bun", ["run", "build:web"]], ["@jurgen1c/agent-memory-web"]),
  commandTask("build:agent-tools", ["bun", ["run", "build:agent-tools"]], ["@jurgen1c/agent-tools"]),
  commandTask("bundle:agent-memory-cli", ["bun", ["run", "build:agent-memory"]], [
    rootPackage.name,
    "@jurgen1c/agent-memory-cli-workspace",
    "@jurgen1c/agent-memory-core",
    "@jurgen1c/agent-memory-schemas"
  ]),
  commandTask("bundle:agentflow-cli", ["bun", ["run", "build:agentflow"]], [
    rootPackage.name,
    "@jurgen1c/agentflow",
    "@jurgen1c/agentflow-agent-memory-adapter",
    "@jurgen1c/agentflow-cli",
    "@jurgen1c/agentflow-core",
    "@jurgen1c/agentflow-schemas",
    "@jurgen1c/agent-tools"
  ])
];

const tasks = mode === "build" ? buildTasks : typecheckTasks;
const plan = {
  mode,
  rootPackage: rootPackage.name,
  workspacePackages: workspacePackages.map((pkg) => ({ name: pkg.name, path: pkg.relativePath })),
  coveredPackageNames: [...new Set([rootPackage.name, ...tasks.flatMap((task) => task.packages)])].sort(),
  tasks: tasks.map((task) => ({
    label: task.label,
    kind: task.kind,
    command: task.command,
    args: task.args,
    packages: task.packages
  }))
};

if (planOnly) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

for (const task of tasks) {
  console.log(`\n> ${task.label}`);

  if (task.kind === "internal") {
    try {
      task.run();
    } catch (error) {
      console.error(`${task.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    continue;
  }

  const result = spawnSync(task.command, task.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(`Failed to run ${task.label}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`${task.label} terminated by signal ${result.signal}.`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`${task.label} failed with exit code ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

function internalTask(label, packages, run) {
  return {
    label,
    kind: "internal",
    command: null,
    args: null,
    packages,
    run
  };
}

function commandTask(label, [command, args], packages) {
  return {
    label,
    kind: "command",
    command,
    args,
    packages,
    run: null
  };
}

function parseArgs(args) {
  const modes = [];
  let planOnly = false;

  for (const arg of args) {
    if (arg === "--plan") {
      planOnly = true;
      continue;
    }

    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${arg}` };
    }

    modes.push(arg);
  }

  if (modes.length !== 1) {
    return { ok: false, error: "Expected exactly one mode argument." };
  }

  const [mode] = modes;

  if (!["build", "typecheck"].includes(mode)) {
    return { ok: false, error: `Unknown mode: ${mode}` };
  }

  return { ok: true, mode, planOnly };
}

function checkWorkspacePackages() {
  const seenNames = new Set();
  const packageNames = new Set(workspacePackages.map((pkg) => pkg.name));

  for (const pkg of workspacePackages) {
    if (!pkg.name || typeof pkg.name !== "string") {
      throw new Error(`${pkg.relativePath}/package.json is missing a package name.`);
    }

    if (seenNames.has(pkg.name)) {
      throw new Error(`Duplicate workspace package name: ${pkg.name}`);
    }

    seenNames.add(pkg.name);
    assertExportTargetsExist(pkg);
    assertWorkspaceDependenciesExist(pkg, packageNames);
  }
}

function assertExportTargetsExist(pkg) {
  for (const target of exportTargets(pkg.packageJson.exports)) {
    const targetPath = path.resolve(pkg.path, target);

    if (!target.startsWith("./") || target.startsWith("./dist/")) {
      continue;
    }

    if (!fs.existsSync(targetPath)) {
      throw new Error(`${pkg.relativePath}/package.json exports missing target ${target}`);
    }
  }
}

function assertWorkspaceDependenciesExist(pkg, packageNames) {
  for (const dependencySetName of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencySet = pkg.packageJson[dependencySetName] ?? {};

    for (const [dependencyName, version] of Object.entries(dependencySet)) {
      if (!isWorkspaceProtocol(version)) {
        continue;
      }

      if (!packageNames.has(dependencyName)) {
        throw new Error(`${pkg.relativePath}/package.json references unknown workspace dependency ${dependencyName}`);
      }
    }
  }
}

function isWorkspaceProtocol(version) {
  return typeof version === "string" && version.startsWith("workspace:");
}

function exportTargets(exportsField) {
  if (!exportsField) {
    return [];
  }

  if (typeof exportsField === "string") {
    return [exportsField];
  }

  if (Array.isArray(exportsField)) {
    return exportsField.flatMap(exportTargets);
  }

  if (typeof exportsField === "object") {
    return Object.values(exportsField).flatMap(exportTargets);
  }

  return [];
}

function sourcePackageNames() {
  return workspacePackages
    .filter((pkg) => fs.existsSync(path.join(pkg.path, "src")))
    .map((pkg) => pkg.name);
}

function workspacePackageJsonPaths(workspaces) {
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages)
      ? workspaces.packages
      : [];

  const includedPackagePaths = new Set(
    patterns
      .filter(isIncludedWorkspacePattern)
      .flatMap((pattern) => packageJsonPathsForPattern(pattern))
  );
  const excludedPackagePaths = new Set(
    patterns
      .filter(isExcludedWorkspacePattern)
      .flatMap((pattern) => packageJsonPathsForPattern(pattern.trim().slice(1)))
  );

  return [...includedPackagePaths]
    .filter((packagePath) => !excludedPackagePaths.has(packagePath))
    .sort();
}

function packageJsonPathsForPattern(pattern) {
  if (!isIncludedWorkspacePattern(pattern)) {
    return [];
  }

  const trimmedPattern = pattern.trim();
  const starIndex = trimmedPattern.indexOf("*");

  if (starIndex === -1) {
    return packageJsonPathIfPresent(trimmedPattern);
  }

  const baseDir = trimmedPattern.slice(0, starIndex).replace(/\/+$/, "");
  const suffixSegments = trimmedPattern.slice(starIndex + 1).split("/").filter(Boolean);
  const basePath = resolveRepoPath(baseDir);

  if (!fs.existsSync(basePath)) {
    return [];
  }

  return fs
    .readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => packageJsonPathIfPresent(path.join(baseDir, entry.name, ...suffixSegments)));
}

function packageJsonPathIfPresent(workspacePath) {
  const packagePath = resolveRepoPath(workspacePath, "package.json");

  return fs.existsSync(packagePath) ? [packagePath] : [];
}

function resolveRepoPath(...segments) {
  const resolvedPath = path.resolve(repoRoot, ...segments);
  const relativePath = path.relative(repoRoot, resolvedPath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return resolvedPath;
  }

  const requestedPath = segments.join("/");

  throw new Error(`Workspace path escapes repository: ${requestedPath}`);
}

function isIncludedWorkspacePattern(pattern) {
  return typeof pattern === "string" && pattern.trim().length > 0 && !pattern.trim().startsWith("!");
}

function isExcludedWorkspacePattern(pattern) {
  return typeof pattern === "string" && pattern.trim().startsWith("!") && pattern.trim().slice(1).trim().length > 0;
}

function readJson(filePath) {
  const displayPath = path.relative(repoRoot, filePath).split(path.sep).join("/") || path.basename(filePath);

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`${displayPath}: ${message}`);
  }
}
