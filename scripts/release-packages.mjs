#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const releasePackages = [
  {
    name: "@jurgen1c/agent-memory-cli",
    packageJsonPath: "package.json",
    packArgs: ["pack", "--dry-run"],
    publishArgs: ["publish", "--provenance", "--access", "public"]
  },
  {
    name: "@jurgen1c/agentflow-cli",
    packageJsonPath: "packages/agentflow-cli/package.json",
    packArgs: ["pack", "--workspace", "@jurgen1c/agentflow-cli", "--dry-run"],
    publishArgs: ["publish", "--workspace", "@jurgen1c/agentflow-cli", "--provenance", "--access", "public"]
  },
  {
    name: "@jurgen1c/agent-tools",
    packageJsonPath: "packages/agent-tools/package.json",
    packArgs: ["pack", "--workspace", "@jurgen1c/agent-tools", "--dry-run"],
    publishArgs: ["publish", "--workspace", "@jurgen1c/agent-tools", "--provenance", "--access", "public"]
  }
];

const command = process.argv[2];

switch (command) {
  case "list":
    printPackageList();
    break;
  case "verify-tag":
    verifyTag();
    break;
  case "verify-versions":
    verifyPackageVersions();
    break;
  case "pack-dry-run":
    runNpmCommands("packArgs");
    break;
  case "publish":
    runNpmCommands("publishArgs");
    break;
  default:
    console.error("Usage: node scripts/release-packages.mjs <list|verify-tag|verify-versions|pack-dry-run|publish>");
    process.exit(2);
}

function printPackageList() {
  console.log(JSON.stringify(releasePackages.map((releasePackage) => packageSummary(releasePackage)), null, 2));
}

function verifyTag() {
  const rootPackage = readPackageJson("package.json");
  const expectedTag = `v${rootPackage.version}`;
  const actualTag = process.env.GITHUB_REF_NAME ?? process.argv[3];

  if (actualTag !== expectedTag) {
    console.error(`Release tag ${actualTag ?? "(missing)"} does not match package version ${expectedTag}.`);
    process.exit(1);
  }

  verifyPackageVersions();
}

function verifyPackageVersions() {
  const rootPackage = readPackageJson("package.json");
  const mismatches = [];

  for (const releasePackage of releasePackages) {
    const packageJson = readPackageJson(releasePackage.packageJsonPath);

    if (packageJson.name !== releasePackage.name) {
      mismatches.push(`${releasePackage.packageJsonPath}: expected name ${releasePackage.name}, found ${packageJson.name}`);
    }

    if (packageJson.version !== rootPackage.version) {
      mismatches.push(`${releasePackage.name}: expected version ${rootPackage.version}, found ${packageJson.version}`);
    }

    if (packageJson.private === true) {
      mismatches.push(`${releasePackage.name}: public release package must not be private`);
    }

    if (packageJson.publishConfig?.access !== "public") {
      mismatches.push(`${releasePackage.name}: publishConfig.access must be public`);
    }

    for (const dependencySetName of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const dependencySet = packageJson[dependencySetName] ?? {};

      for (const [dependencyName, version] of Object.entries(dependencySet)) {
        if (typeof version === "string" && version.startsWith("workspace:")) {
          mismatches.push(`${releasePackage.name}: ${dependencySetName}.${dependencyName} must not use ${version} in a public release package`);
        }
      }
    }
  }

  if (mismatches.length > 0) {
    console.error("Release package verification failed:");
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    process.exit(1);
  }
}

function runNpmCommands(argsProperty) {
  verifyPackageVersions();

  for (const releasePackage of releasePackages) {
    const args = releasePackage[argsProperty];

    console.log(`\n> npm ${args.join(" ")}`);
    const result = spawnSync("npm", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit"
    });

    if (result.error) {
      console.error(`Failed to run npm ${args.join(" ")}: ${result.error.message}`);
      process.exit(1);
    }

    if (result.signal) {
      console.error(`npm ${args.join(" ")} terminated by signal ${result.signal}.`);
      process.exit(1);
    }

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

function packageSummary(releasePackage) {
  return {
    name: releasePackage.name,
    packageJsonPath: releasePackage.packageJsonPath,
    packCommand: ["npm", ...releasePackage.packArgs].join(" "),
    publishCommand: ["npm", ...releasePackage.publishArgs].join(" ")
  };
}

function readPackageJson(packageJsonPath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, packageJsonPath), "utf8"));
}
