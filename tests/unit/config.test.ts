import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig, renderConfigTemplate } from "../../packages/core/src/config";
import { ConfigError } from "../../packages/core/src/errors";

const repoRoot = path.resolve(".");

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

agent_instructions:
  path: CLAUDE.md

claim_sources:
  allow:
    - app/**
    - config/routes.rb
  deny:
    - app/generated/**

context:
  default_budget: full
  default_depth: 2
`);

    const loaded = loadConfig({ repoRoot });

    expect(loaded.config.version).toBe(1);
    expect(loaded.config.database_scope).toBe("local");
    expect(loaded.config.memory_key).toBeUndefined();
    expect(loaded.config.memory_root).toBe("docs/agent-memory");
    expect(loaded.config.claims).toEqual(["claims/**/*.md"]);
    expect(loaded.config.plans).toEqual(["plans/**/*.yaml"]);
    expect(loaded.config.profiles).toEqual(["profiles/**/*.yaml"]);
    expect(loaded.config.agent_instructions.paths).toEqual(["CLAUDE.md"]);
    expect(loaded.config.agent_skills.generic.enabled).toBe(false);
    expect(loaded.config.claim_sources.allow).toEqual(["app/**", "config/routes.rb"]);
    expect(loaded.config.claim_sources.deny).toEqual(["app/generated/**"]);
    expect(loaded.config.context.default_budget).toBe("full");
    expect(loaded.config.context.default_depth).toBe(2);
    expect(loaded.config.context.recipe_match_limit).toBe(3);
    expect(loaded.config.context.profile_trait_limit).toBe(5);
    expect(loaded.config.context.plan_template_suggestion_limit).toBe(3);
    expect(loaded.config.context.include_profile_traits).toBe(true);
    expect(loaded.config.context.include_recipe_diagnostics).toBe(true);
    expect(loaded.config.context.include_profile_diagnostics).toBe(true);
  });

  test("loads contextual workflow config values when provided", () => {
    const repoRoot = makeTempRepo(`
version: 1
plans:
  - workflows/plans/**/*.yaml
profiles:
  - workflows/profiles/**/*.yaml
context:
  recipe_match_limit: 4
  profile_trait_limit: 6
  plan_template_suggestion_limit: 2
  include_profile_traits: false
  include_recipe_diagnostics: false
  include_profile_diagnostics: false
`);

    const loaded = loadConfig({ repoRoot });

    expect(loaded.config.plans).toEqual(["workflows/plans/**/*.yaml"]);
    expect(loaded.config.profiles).toEqual(["workflows/profiles/**/*.yaml"]);
    expect(loaded.config.context.recipe_match_limit).toBe(4);
    expect(loaded.config.context.profile_trait_limit).toBe(6);
    expect(loaded.config.context.plan_template_suggestion_limit).toBe(2);
    expect(loaded.config.context.include_profile_traits).toBe(false);
    expect(loaded.config.context.include_recipe_diagnostics).toBe(false);
    expect(loaded.config.context.include_profile_diagnostics).toBe(false);
  });

  test("loads version 2 local and global storage config", () => {
    const localRepoRoot = makeTempRepo(`
version: 2
database_scope: local
memory_key: jurgen1c-agent-memory
`);
    const globalRepoRoot = makeTempRepo(`
version: 2
database_scope: global
memory_key: jurgen1c-agent-memory
`);

    expect(loadConfig({ repoRoot: localRepoRoot }).config).toMatchObject({
      version: 2,
      database_scope: "local",
      memory_key: "jurgen1c-agent-memory"
    });
    expect(loadConfig({ repoRoot: globalRepoRoot }).config).toMatchObject({
      version: 2,
      database_scope: "global",
      memory_key: "jurgen1c-agent-memory"
    });
  });

  test("rejects unsupported config versions", () => {
    const repoRoot = makeTempRepo("version: 3\n");

    expect(() => loadConfig({ repoRoot })).toThrow(ConfigError);
  });

  test("keeps version 1 local-only and requires explicit version 2 storage fields", () => {
    for (const config of [
      "version: 1\ndatabase_scope: local\n",
      "version: 1\nmemory_key: repo-memory\n",
      "version: 2\n",
      "version: 2\ndatabase_scope: global\n"
    ]) {
      const repoRoot = makeTempRepo(config);
      expect(() => loadConfig({ repoRoot })).toThrow(ConfigError);
    }
  });

  test("rejects invalid database scopes with an actionable error", () => {
    const repoRoot = makeTempRepo("version: 2\ndatabase_scope: shared\n");

    expect(() => loadConfig({ repoRoot })).toThrow(
      "Invalid database_scope value: shared. Expected local or global."
    );
  });

  test("rejects invalid global memory keys", () => {
    const emptyMemoryKeyRepo = makeTempRepo('version: 2\ndatabase_scope: global\nmemory_key: ""\n');
    expect(() => loadConfig({ repoRoot: emptyMemoryKeyRepo })).toThrow('Invalid memory_key value: "".');

    for (const memoryKey of ["Uppercase", "contains/slash", "con", "con.cache", "ends.", "a".repeat(129)]) {
      const repoRoot = makeTempRepo(`version: 2\ndatabase_scope: global\nmemory_key: ${JSON.stringify(memoryKey)}\n`);
      expect(() => loadConfig({ repoRoot })).toThrow("Invalid memory_key value");
    }
  });

  test("rejects invalid context depth defaults", () => {
    const repoRoot = makeTempRepo(`
version: 1
context:
  default_depth: 11
`);

    expect(() => loadConfig({ repoRoot })).toThrow(ConfigError);
  });

  test("rejects invalid contextual workflow limits", () => {
    const repoRoot = makeTempRepo(`
version: 1
context:
  recipe_match_limit: 0
`);

    expect(() => loadConfig({ repoRoot })).toThrow(ConfigError);
  });

  test("normalizes and deduplicates repository-relative instruction paths", () => {
    const repoRoot = makeTempRepo(`
version: 1
agent_instructions:
  paths:
    - ./docs/../AGENTS.md
    - AGENTS.md
    - nested\\CLAUDE.md
`);

    expect(loadConfig({ repoRoot }).config.agent_instructions.paths).toEqual(["AGENTS.md", "nested/CLAUDE.md"]);
  });

  test("rejects absolute and repository-escaping instruction paths", () => {
    for (const instructionPath of ["/tmp/AGENTS.md", "../AGENTS.md", "C:\\outside\\AGENTS.md"]) {
      const repoRoot = makeTempRepo(`
version: 1
agent_instructions:
  paths:
    - ${JSON.stringify(instructionPath)}
`);

      expect(() => loadConfig({ repoRoot })).toThrow(
        "Config field agent_instructions.paths must contain repository-relative paths inside the repository"
      );
    }
  });

  test("normalizes and deduplicates repository-relative claim-source globs", () => {
    const repoRoot = makeTempRepo(`
version: 1
claim_sources:
  allow:
    - ./src/../app/**
    - app/**
  deny:
    - app\\generated\\**
`);

    expect(loadConfig({ repoRoot }).config.claim_sources).toEqual({
      allow: ["app/**"],
      deny: ["app/generated/**"]
    });
  });

  test("rejects absolute and repository-escaping claim-source globs", () => {
    for (const [key, glob] of [
      ["allow", "/tmp/**"],
      ["allow", "../shared/**"],
      ["deny", "C:\\outside\\**"]
    ] as const) {
      const repoRoot = makeTempRepo(`
version: 1
claim_sources:
  ${key}:
    - ${JSON.stringify(glob)}
`);

      expect(() => loadConfig({ repoRoot })).toThrow(
        `Config field claim_sources.${key} must contain repository-relative glob patterns inside the repository`
      );
    }
  });

  test("renders YAML-reserved string values as round-trippable strings", () => {
    const config = defaultConfig();
    config.memory_root = "true";
    config.database_path = "123";
    config.claims = ["null", "**/*.md", "{claims}/**/*.md", "1.2", "01", "1e3"];
    config.git.hooks = ["~"];
    config.agent_skills.codex.path = "false";
    config.agent_instructions.paths = ["AGENTS.md", "CLAUDE.md"];
    config.claim_sources.allow = ["src/**"];
    config.claim_sources.deny = ["src/generated/**"];
    const rendered = renderConfigTemplate(config);
    const repoRoot = makeTempRepo(rendered);
    const loaded = loadConfig({ repoRoot });

    expect(rendered).toContain('- "1.2"');
    expect(rendered).toContain('- "01"');
    expect(rendered).toContain('- "1e3"');
    expect(rendered).toContain("plans:");
    expect(rendered).toContain("profiles:");
    expect(rendered).toContain("agent_instructions:");
    expect(rendered).toContain("claim_sources:");
    expect(rendered).toContain("recipe_match_limit: 3");
    expect(loaded.config.memory_root).toBe("true");
    expect(loaded.config.database_path).toBe("123");
    expect(loaded.config.claims).toEqual(["null", "**/*.md", "{claims}/**/*.md", "1.2", "01", "1e3"]);
    expect(loaded.config.git.hooks).toEqual(["~"]);
    expect(loaded.config.agent_skills.codex.path).toBe("false");
    expect(loaded.config.agent_instructions.paths).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(loaded.config.claim_sources.allow).toEqual(["src/**"]);
    expect(loaded.config.claim_sources.deny).toEqual(["src/generated/**"]);
  });

  test("renders version 2 global storage fields and generated-state guidance", () => {
    const config = defaultConfig();
    config.version = 2;
    config.database_scope = "global";
    config.memory_key = "jurgen1c-agent-memory";

    const rendered = renderConfigTemplate(config);
    const loaded = loadConfig({ repoRoot: makeTempRepo(rendered) });

    expect(rendered).toContain("memory_key: jurgen1c-agent-memory");
    expect(rendered).toContain("database_scope: global");
    expect(rendered).toContain("Global database paths are user-local generated state");
    expect(rendered).toContain("never committed canonical memory");
    expect(loaded.config.database_scope).toBe("global");
    expect(loaded.config.memory_key).toBe("jurgen1c-agent-memory");
  });

  test("schema requires contextual workflow path globs", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/schemas/config.schema.json"), "utf8"));

    expect(schema.required).toContain("plans");
    expect(schema.required).toContain("profiles");
    expect(schema.properties.agent_instructions.properties.path.type).toBe("string");
    expect(schema.properties.agent_instructions.properties.paths.items.type).toBe("string");
    expect(schema.properties.claim_sources.properties.deny.items.type).toBe("string");
    expect(schema.properties.version.enum).toEqual([1, 2]);
    expect(schema.properties.database_scope.enum).toEqual(["local", "global"]);
    expect(schema.properties.memory_key.pattern).toContain("[a-z0-9]");
  });
});

function makeTempRepo(config: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-config-"));
  fs.writeFileSync(path.join(repoRoot, "agent-memory.config.yaml"), config);
  return repoRoot;
}
