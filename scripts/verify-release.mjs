#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = readJson("package.json");
const expectedName = "@jurgen1c/agent-memory-cli";
const expectedTag = `v${packageJson.version}`;
const actualTag = process.env.GITHUB_REF_NAME ?? process.argv[2];
const errors = [];

if (packageJson.name !== expectedName) {
  errors.push(`Expected package name ${expectedName}, found ${packageJson.name}.`);
}
if (actualTag !== expectedTag) {
  errors.push(`Release tag ${actualTag ?? "(missing)"} does not match ${expectedTag}.`);
}
if (packageJson.private === true) {
  errors.push("Public release package must not be private.");
}
if (packageJson.publishConfig?.access !== "public") {
  errors.push("publishConfig.access must be public.");
}

for (const workspace of ["cli", "core", "schemas", "web"]) {
  const workspacePackage = readJson(`packages/${workspace}/package.json`);
  if (workspacePackage.version !== packageJson.version) {
    errors.push(
      `packages/${workspace}/package.json version ${workspacePackage.version} does not match ${packageJson.version}.`
    );
  }
}

const generatedVersion = fs.readFileSync(
  path.join(repositoryRoot, "packages/core/src/generated_version.ts"),
  "utf8"
);
if (!generatedVersion.includes(`"${packageJson.version}"`)) {
  errors.push("Generated CLI version does not match package.json.");
}

for (const dependencySetName of [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
]) {
  for (const [dependencyName, version] of Object.entries(
    packageJson[dependencySetName] ?? {}
  )) {
    if (
      typeof version === "string"
      && (version.startsWith("workspace:") || version.startsWith("file:"))
    ) {
      errors.push(
        `${dependencySetName}.${dependencyName} must use a registry semver range, not ${version}.`
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Release verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`${expectedName} ${packageJson.version} is ready for ${expectedTag}.`);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}
