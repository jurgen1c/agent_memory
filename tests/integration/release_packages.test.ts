import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(".");

interface ReleasePackage {
  name: string;
  packageJsonPath: string;
  packCommand: string;
  publishCommand: string;
}

describe("release package manifest", () => {
  test("lists public packages in deterministic publish order", () => {
    const releasePackages = listReleasePackages();

    expect(releasePackages.map((releasePackage) => releasePackage.name)).toEqual([
      "@jurgen1c/agent-memory-cli",
      "@jurgen1c/agentflow-cli",
      "@jurgen1c/agent-tools"
    ]);
    expect(releasePackages.map((releasePackage) => releasePackage.packCommand)).toEqual([
      "npm pack --dry-run",
      "npm pack --workspace @jurgen1c/agentflow-cli --dry-run",
      "npm pack --workspace @jurgen1c/agent-tools --dry-run"
    ]);
    expect(releasePackages.map((releasePackage) => releasePackage.publishCommand)).toEqual([
      "npm publish --provenance --access public",
      "npm publish --workspace @jurgen1c/agentflow-cli --provenance --access public",
      "npm publish --workspace @jurgen1c/agent-tools --provenance --access public"
    ]);
  });

  test("verifies public package versions and trusted publishing metadata", () => {
    const result = runReleaseScript(["verify-versions"]);

    expect(result.status, result.stderr).toBe(0);
  });

  test("rejects a private root release package", () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-release-package-test-"));

    fs.mkdirSync(path.join(tempRepo, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(tempRepo, "packages/agentflow-cli"), { recursive: true });
    fs.mkdirSync(path.join(tempRepo, "packages/agent-tools"), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "scripts/release-packages.mjs"), path.join(tempRepo, "scripts/release-packages.mjs"));
    writeJson(path.join(tempRepo, "package.json"), {
      name: "@jurgen1c/agent-memory-cli",
      version: "0.2.0",
      private: true,
      publishConfig: { access: "public" }
    });
    writeJson(path.join(tempRepo, "packages/agentflow-cli/package.json"), {
      name: "@jurgen1c/agentflow-cli",
      version: "0.2.0",
      publishConfig: { access: "public" }
    });
    writeJson(path.join(tempRepo, "packages/agent-tools/package.json"), {
      name: "@jurgen1c/agent-tools",
      version: "0.2.0",
      publishConfig: { access: "public" }
    });

    const result = runReleaseScript(["verify-versions"], tempRepo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@jurgen1c/agent-memory-cli: public release package must not be private");
  });

  test("keeps workflow and docs routed through the release package script", () => {
    const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/publish.yml"), "utf8");
    const docs = fs.readFileSync(path.join(repoRoot, "docs/releasing.md"), "utf8");

    expect(workflow).toContain("node scripts/release-packages.mjs verify-tag");
    expect(workflow).toContain("node scripts/release-packages.mjs pack-dry-run");
    expect(workflow).toContain("node scripts/release-packages.mjs publish");
    expect(docs).toContain("npm pack --workspace @jurgen1c/agentflow-cli --dry-run");
    expect(docs).toContain("npm publish --workspace @jurgen1c/agentflow-cli --provenance --access public");
  });
});

function listReleasePackages(): ReleasePackage[] {
  const result = runReleaseScript(["list"]);

  expect(result.status, result.stderr).toBe(0);

  return JSON.parse(result.stdout) as ReleasePackage[];
}

function runReleaseScript(args: string[], cwd = repoRoot): { status: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["node", "scripts/release-packages.mjs", ...args], {
    cwd,
    env: {
      ...process.env,
      ASDF_NODEJS_VERSION: process.env.ASDF_NODEJS_VERSION ?? localNodeVersion()
    }
  });

  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr)
  };
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function localNodeVersion(): string {
  const toolVersions = fs.readFileSync(path.join(repoRoot, ".tool-versions"), "utf8");
  const nodeLine = toolVersions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("nodejs "));
  return nodeLine?.split(/\s+/)[1] ?? "25.9.0";
}
