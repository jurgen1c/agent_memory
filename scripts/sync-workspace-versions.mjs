import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const rootPackagePath = path.join(repoRoot, "package.json");
const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
const version = rootPackage.version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error("Root package.json must contain a version string.");
}

const workspacePackagePaths = [
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/schemas/package.json",
  "packages/web/package.json"
];

for (const packagePath of workspacePackagePaths) {
  const absolutePath = path.join(repoRoot, packagePath);
  const packageJson = JSON.parse(fs.readFileSync(absolutePath, "utf8"));

  if (packageJson.version === version) {
    continue;
  }

  packageJson.version = version;
  fs.writeFileSync(absolutePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Updated ${packagePath} to ${version}`);
}
