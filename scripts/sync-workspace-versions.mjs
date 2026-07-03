import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const rootPackagePath = path.join(repoRoot, "package.json");
const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
const version = rootPackage.version;
const shouldStage = process.argv.includes("--stage");
const shouldCheck = process.argv.includes("--check");

if (typeof version !== "string" || version.length === 0) {
  throw new Error("Root package.json must contain a version string.");
}

const workspacePackagePaths = workspacePackageJsonPaths(rootPackage.workspaces);
const updatedPackagePaths = [];
const mismatchedPackagePaths = [];

for (const packagePath of workspacePackagePaths) {
  const absolutePath = path.join(repoRoot, packagePath);
  const packageJson = JSON.parse(fs.readFileSync(absolutePath, "utf8"));

  if (packageJson.version === version) {
    continue;
  }

  mismatchedPackagePaths.push({ path: packagePath, version: packageJson.version });

  if (shouldCheck) {
    continue;
  }

  packageJson.version = version;
  fs.writeFileSync(absolutePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  updatedPackagePaths.push(packagePath);
  console.log(`Updated ${packagePath} to ${version}`);
}

if (shouldCheck && mismatchedPackagePaths.length > 0) {
  console.error(`Workspace package versions must match root package.json version ${version}.`);

  for (const mismatch of mismatchedPackagePaths) {
    console.error(`- ${mismatch.path}: ${mismatch.version}`);
  }

  console.error("Run `npm version <version>` or `node scripts/sync-workspace-versions.mjs --stage` before tagging a release.");
  process.exit(1);
}

if (shouldStage && updatedPackagePaths.length > 0) {
  execFileSync("git", ["add", "--", ...updatedPackagePaths], {
    cwd: repoRoot,
    stdio: "inherit"
  });
}

function workspacePackageJsonPaths(workspaces) {
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages)
      ? workspaces.packages
      : [];

  return patterns
    .flatMap((pattern) => expandWorkspacePattern(pattern))
    .filter((packagePath, index, allPaths) => allPaths.indexOf(packagePath) === index)
    .sort();
}

function expandWorkspacePattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.startsWith("!")) {
    return [];
  }

  if (!pattern.includes("*")) {
    return packageJsonPathIfPresent(pattern);
  }

  const wildcardIndex = pattern.indexOf("*");
  const baseDir = pattern.slice(0, wildcardIndex).replace(/\/+$/, "");
  const suffix = pattern.slice(wildcardIndex + 1);
  const absoluteBaseDir = path.join(repoRoot, baseDir);

  if (!fs.existsSync(absoluteBaseDir)) {
    return [];
  }

  return fs.readdirSync(absoluteBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => packageJsonPathIfPresent(path.join(baseDir, entry.name, suffix)));
}

function packageJsonPathIfPresent(workspacePath) {
  const packagePath = path.join(workspacePath, "package.json");
  const absolutePackagePath = path.join(repoRoot, packagePath);

  return fs.existsSync(absolutePackagePath) ? [packagePath] : [];
}
