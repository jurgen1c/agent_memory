import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig, renderConfigTemplate } from "../../packages/core/src/config";
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

  test("renders YAML-reserved string values as round-trippable strings", () => {
    const config = defaultConfig();
    config.memory_root = "true";
    config.database_path = "123";
    config.claims = ["null", "**/*.md", "{claims}/**/*.md", "1.2", "01", "1e3"];
    config.git.hooks = ["~"];
    config.agent_skills.codex.path = "false";
    const rendered = renderConfigTemplate(config);
    const repoRoot = makeTempRepo(rendered);
    const loaded = loadConfig({ repoRoot });

    expect(rendered).toContain('- "1.2"');
    expect(rendered).toContain('- "01"');
    expect(rendered).toContain('- "1e3"');
    expect(loaded.config.memory_root).toBe("true");
    expect(loaded.config.database_path).toBe("123");
    expect(loaded.config.claims).toEqual(["null", "**/*.md", "{claims}/**/*.md", "1.2", "01", "1e3"]);
    expect(loaded.config.git.hooks).toEqual(["~"]);
    expect(loaded.config.agent_skills.codex.path).toBe("false");
  });
});

function makeTempRepo(config: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-config-"));
  fs.writeFileSync(path.join(repoRoot, "agent-memory.config.yaml"), config);
  return repoRoot;
}
