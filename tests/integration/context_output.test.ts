import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packContextOutput, type ContextOutputCandidates } from "../../packages/core/src/index";

// The selector adapter reads only explicit fixture data. It is not an alternate packer.
describe("v2 output integration", () => {
  test("temporary-repository memory and verification commands remain inert data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-v2-output-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", root]).status).toBe(0);
      fs.mkdirSync(path.join(root, "claims"));
      const marker = path.join(root, "must-not-exist");
      const command = `touch ${marker}`;
      const body = `# Verification\n\n\`${command}\`\n\n$(touch ${marker})\n`;
      fs.writeFileSync(path.join(root, "claims", "safe.md"), body);
      const input: ContextOutputCandidates = {
        roots: [{ claimId: "safe", reason: "EXACT_SOURCE" }],
        claims: [{ id: "safe", sourcePath: "claims/safe.md", title: "Inert text", claim: "Read authored text only.", status: "current", system: "test", tags: [], body: fs.readFileSync(path.join(root, "claims", "safe.md"), "utf8"), sections: [{ heading: "Verification", startLine: 1, text: body }] }],
        commands: [{ value: command, origins: [{ kind: "claim", id: "safe", sourcePath: "claims/safe.md" }] }]
      };
      const first = packContextOutput({ mode: "task", budget: "small" }, input);
      const second = packContextOutput({ mode: "task", budget: "small" }, input);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout).toContain("suggested_not_run");
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readFileSync(path.join(root, "claims", "safe.md"), "utf8")).toBe(body);
      expect(fs.existsSync(path.join(root, ".agent-memory"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Node-target bundles expose the same production output API and preserve CLI v1", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-v2-node-"));
    try {
      const library = path.join(root, "output.mjs");
      const cli = path.join(root, "agent-memory.mjs");
      // Bundle the actual output entrypoint, no test-only implementation or network.
      const build = await Bun.build({ entrypoints: [path.resolve("packages/core/src/context_output.ts")], target: "node", outdir: root, naming: "output.mjs" });
      expect(build.success).toBe(true);
      const cliBuild = await Bun.build({ entrypoints: [path.resolve("packages/cli/src/index.ts")], target: "node", packages: "external", outdir: root, naming: "agent-memory.mjs" });
      expect(cliBuild.success).toBe(true);
      fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
      const script = `import {packContextOutput} from ${JSON.stringify(library)}; process.stdout.write(packContextOutput({mode:"task",budget:"small"},{roots:[],claims:[]}).stdout);`;
      const env = { ...process.env, ASDF_NODEJS_VERSION: "26.7.0" };
      const output = spawnSync("node", ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", env });
      expect(output.status).toBe(0);
      expect(output.stdout).toBe(packContextOutput({ mode: "task", budget: "small" }, { roots: [], claims: [] }).stdout);
      for (const argument of ["help", "--version"]) {
        const result = spawnSync("node", [cli, argument], { cwd: root, encoding: "utf8", env });
        expect(result.status).toBe(0);
        expect(result.stdout.length).toBeGreaterThan(0);
        expect(result.stdout).not.toContain("schemaVersion");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
