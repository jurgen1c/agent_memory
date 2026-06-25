import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../packages/core/src/config";
import { ConfigError } from "../../packages/core/src/errors";

describe("loadConfig", () => {
  test("loads repository config with defaults and nested values", () => {
    const repoRoot = makeTempRepo(`
version: 1
memory_root: docs/agent-memory
database_path: .agent-memory/memory.sqlite

claims:
  - claims/**/*.md

graphs:
  - graph/**/*.yaml

indexes:
  - indexes/**/*.yaml

recipes:
  - recipes/**/*.yaml

waivers:
  - waivers/**/*.yaml

agent_skills:
  codex:
    enabled: true
    path: .codex/skills/repo-memory/SKILL.md
  generic:
    enabled: false
    path: docs/agent-memory/AGENT_SKILL.md

context:
  default_budget: full
  default_depth: 2
`);

    const loaded = loadConfig({ repoRoot });

    expect(loaded.config.version).toBe(1);
    expect(loaded.config.memory_root).toBe("docs/agent-memory");
    expect(loaded.config.claims).toEqual(["claims/**/*.md"]);
    expect(loaded.config.agent_skills.generic.enabled).toBe(false);
    expect(loaded.config.context.default_budget).toBe("full");
    expect(loaded.config.context.default_depth).toBe(2);
  });

  test("rejects unsupported config versions", () => {
    const repoRoot = makeTempRepo("version: 2\n");

    expect(() => loadConfig({ repoRoot })).toThrow(ConfigError);
  });

  test("rejects invalid context depth defaults", () => {
    const repoRoot = makeTempRepo(`
version: 1
context:
  default_depth: 11
`);

    expect(() => loadConfig({ repoRoot })).toThrow(ConfigError);
  });
});

function makeTempRepo(config: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-config-"));
  fs.writeFileSync(path.join(repoRoot, "agent-memory.config.yaml"), config);
  return repoRoot;
}
