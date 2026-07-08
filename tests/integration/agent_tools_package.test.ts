import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { agentToolCliPackages, agentToolPackageBoundary } from "../../packages/agent-tools/src";

const repoRoot = path.resolve(".");

describe("Agent Tools meta package", () => {
  test("exports discovery metadata for the individual CLI packages", () => {
    expect(agentToolPackageBoundary).toEqual({
      packageName: "@jurgen1c/agent-tools",
      role: "agent-tools-meta-package",
      includedPackages: agentToolCliPackages,
      runtimeCoupling: "none"
    });
    expect(agentToolCliPackages).toEqual([
      {
        packageName: "@jurgen1c/agent-memory-cli",
        binaryName: "agent-memory",
        role: "repository-memory-cli",
        packageStatus: "published",
        installPackageName: "@jurgen1c/agent-memory-cli",
        installCommand: "npm install --save-dev @jurgen1c/agent-memory-cli"
      },
      {
        packageName: "@jurgen1c/agentflow-cli",
        binaryName: "agentflow",
        role: "workflow-runtime-cli",
        packageStatus: "workspace-private",
        installPackageName: "@jurgen1c/agent-memory-cli",
        installCommand: "npm install --save-dev @jurgen1c/agent-memory-cli"
      }
    ]);
  });

  test("stays lightweight and does not ship replacement CLI bins", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/agent-tools/package.json"), "utf8")) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
      exports?: Record<string, { types: string; default: string }>;
      main?: string;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      private?: boolean;
    };

    expect(packageJson.private).toBeUndefined();
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.exports?.["."]).toEqual({ types: "./src/index.ts", default: "./dist/index.js" });
    expect(packageJson.bin ?? {}).toEqual({});
    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(packageJson.optionalDependencies ?? {}).toEqual({});
    expect(packageJson.peerDependencies ?? {}).toEqual({});
  });

  test("is included in the release publish path", () => {
    const publishWorkflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/publish.yml"), "utf8");
    const releaseDocs = fs.readFileSync(path.join(repoRoot, "docs/releasing.md"), "utf8");

    for (const content of [publishWorkflow, releaseDocs]) {
      expect(content).toContain("npm pack --workspace @jurgen1c/agent-tools --dry-run");
      expect(content).toContain("npm publish --workspace @jurgen1c/agent-tools --provenance --access public");
    }
  });
});
