#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-global-smoke-"));
const consumingRepo = path.join(temporaryRoot, "consumer");
const globalHome = path.join(temporaryRoot, "home");
let binary;

try {
  binary = resolveBinary(process.argv.slice(2));
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
  ).version;
  fs.mkdirSync(consumingRepo, { mode: 0o700 });
  fs.mkdirSync(globalHome, { mode: 0o700 });
  run("git", ["init"], consumingRepo);

  expectOutput(cli(["help"]), "agent-memory", "help");
  expectOutput(cli(["--version"]), `agent-memory ${packageVersion}`, "version metadata");
  expectOutput(cli(["templates", "show", "claim:fact"]), "type: fact", "embedded templates");
  expectOutput(
    cli(["init", "--yes", "--memory-key", "packaged-global-smoke"]),
    "Agent Memory initialized.",
    "global init"
  );

  const config = fs.readFileSync(path.join(consumingRepo, "agent-memory.config.yaml"), "utf8");
  expectOutput(config, "version: 2", "global config version");
  expectOutput(config, "database_scope: global", "global database scope");
  expectOutput(config, "memory_key: packaged-global-smoke", "global memory key");

  expectOutput(cli(["sync"]), "Agent Memory synced.", "global sync");
  expectOutput(cli(["compile"]), "Agent Memory compiled.", "global compile");
  expectOutput(cli(["doctor"]), "Agent Memory doctor passed.", "global doctor");

  const context = JSON.parse(
    cli(["context", "--task", "verify packaged global registry", "--json"])
  );
  if (!isInside(globalHome, context.databasePath)) {
    fail(`Context used a database outside the temporary global home: ${context.databasePath}`);
  }

  const registryList = JSON.parse(cli(["registry", "list", "--json"]));
  if (registryList.memories?.[0]?.memory_key !== "packaged-global-smoke") {
    fail("Registry list did not include the packaged global smoke repository.");
  }

  const registryEntry = JSON.parse(
    cli(["registry", "show", "packaged-global-smoke", "--json"])
  );
  if (registryEntry.checkout_count !== 1) {
    fail(`Registry show reported ${registryEntry.checkout_count ?? "no"} checkout instead of one.`);
  }

  if (fs.existsSync(path.join(consumingRepo, ".agent-memory", "memory.sqlite"))) {
    fail("Packaged global smoke wrote a database inside the consuming repository.");
  }
  if (!fs.existsSync(path.join(globalHome, "registry.json"))) {
    fail("Packaged global smoke did not create registry metadata in AGENT_MEMORY_HOME.");
  }

  console.log("Agent Memory packaged global CLI smoke test passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function resolveBinary(args) {
  if (args.length === 0) return path.join(repositoryRoot, "dist", "agent-memory.js");
  if (args.length === 2 && args[0] === "--binary") return path.resolve(args[1]);
  fail("Usage: verify-global-cli.mjs [--binary <path>]");
}

function cli(args) {
  return run(process.execPath, [binary, ...args], consumingRepo, {
    ...process.env,
    AGENT_MEMORY_HOME: globalHome
  });
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const commandOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const detail = result.error?.message ?? (commandOutput || `exit status ${result.status}`);
    fail(`${command} ${args.join(" ")} failed: ${detail.trim()}`);
  }
  return result.stdout;
}

function expectOutput(output, expected, label) {
  if (!output.includes(expected)) {
    fail(`${label} output did not include ${JSON.stringify(expected)}.`);
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function fail(message) {
  throw new Error(message);
}
