import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, runCli } from "../../packages/cli/src/router";
import { deriveRepositoryIdentity } from "../../packages/core/src/memory_key";
import { registryPaths, updateRegistryCheckout } from "../../packages/core/src/registry";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("registry CLI", () => {
  test("routes list and show with JSON using an isolated AGENT_MEMORY_HOME", async () => {
    const globalHome = makeTempDirectory("agent-memory-cli-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-cli-registry-repo-");
    registerCheckout(globalHome, repoRoot, "cli-memory");
    const context = { env: { AGENT_MEMORY_HOME: globalHome } };

    const listed = await dispatch(["registry", "list", "--json"], context);
    const listJson = JSON.parse(listed.stdout ?? "{}") as { memories: Array<{ memory_key: string }> };
    expect(listed.exitCode).toBe(0);
    expect(listJson.memories[0].memory_key).toBe("cli-memory");

    const shown = await dispatch(["registry", "show", "cli-memory", "--json"], context);
    expect(JSON.parse(shown.stdout ?? "{}")).toMatchObject({ memory_key: "cli-memory", checkout_count: 1 });
  });

  test("doctor emits structured JSON for corrupt metadata", async () => {
    const globalHome = makeTempDirectory("agent-memory-cli-registry-home-");
    fs.writeFileSync(registryPaths(globalHome).registry, "not json\n", { mode: 0o600 });

    const result = await dispatch(["registry", "doctor", "--json"], {
      env: { AGENT_MEMORY_HOME: globalHome }
    });
    const json = JSON.parse(result.stdout ?? "{}") as { healthy: boolean; findings: Array<{ code: string }> };

    expect(result.exitCode).toBe(5);
    expect(json.healthy).toBe(false);
    expect(json.findings[0].code).toBe("corrupt_metadata");
  });

  test("renders inconclusive checkout status when config inspection fails", async () => {
    const globalHome = makeTempDirectory("agent-memory-cli-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-cli-registry-repo-");
    registerCheckout(globalHome, repoRoot, "inconclusive-cli-memory");
    fs.writeFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "version: [\n");
    const context = { env: { AGENT_MEMORY_HOME: globalHome } };

    const listed = await dispatch(["registry", "list", "--json"], context);
    expect(JSON.parse(listed.stdout ?? "{}").memories[0].checkouts[0]).toMatchObject({
      checkout_status: "inconclusive",
      stale: false
    });

    const shown = await dispatch(["registry", "show", "inconclusive-cli-memory"], context);
    expect(shown.stdout).toContain("Checkout status: inconclusive");
  });

  test("prune is a dry run unless force is explicit", async () => {
    const globalHome = makeTempDirectory("agent-memory-cli-registry-home-");
    const repoRoot = makeTempDirectory("agent-memory-cli-registry-repo-");
    registerCheckout(globalHome, repoRoot, "stale-cli-memory");
    fs.rmSync(repoRoot, { recursive: true });
    const context = { env: { AGENT_MEMORY_HOME: globalHome } };

    const preview = await dispatch(["registry", "prune", "--json"], context);
    expect(JSON.parse(preview.stdout ?? "{}")).toMatchObject({ dry_run: true, stale_count: 1, pruned_count: 0 });

    const forced = await dispatch(["registry", "prune", "--force", "--json"], context);
    expect(JSON.parse(forced.stdout ?? "{}")).toMatchObject({ dry_run: false, stale_count: 1, pruned_count: 1 });
  });

  test("reports common invalid registry input errors", async () => {
    const globalHome = makeTempDirectory("agent-memory-cli-registry-home-");
    const context = { env: { AGENT_MEMORY_HOME: globalHome } };

    await expect(dispatch(["registry"], context)).rejects.toThrow("registry requires a subcommand");
    await expect(dispatch(["registry", "show"], context)).rejects.toThrow("registry show requires a memory key");
    await expect(dispatch(["registry", "list", "extra"], context)).rejects.toThrow("Unknown registry list option");
    await expect(dispatch(["registry", "prune", "--force", "--dry-run"], context)).rejects.toThrow(
      "cannot combine --force with --dry-run"
    );

    let stderr = "";
    const exitCode = await runCli(["registry", "unknown"], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } }
    }, context);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("registry requires a subcommand");
  });
});

function registerCheckout(globalHome: string, repoRoot: string, memoryKey: string): void {
  const configPath = path.join(repoRoot, "agent-memory.config.yaml");
  fs.writeFileSync(configPath, `version: 2\nmemory_key: ${memoryKey}\ndatabase_scope: global\n`);
  updateRegistryCheckout({
    globalHome,
    memoryKey,
    repositoryIdentity: deriveRepositoryIdentity(repoRoot),
    repoRoot,
    configPath,
    packageVersion: "0.4.0",
    configHash: `sha256:${memoryKey}`,
    gitHead: null
  });
}

function makeTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}
