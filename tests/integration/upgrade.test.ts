import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";
import { loadConfig } from "../../packages/core/src/config";
import { wrapperTemplate } from "../../packages/core/src/init";

describe("upgrade command", () => {
  test("dry-runs support file updates without writing files", async () => {
    const repoRoot = makeRepo(oldConfig());
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), oldAgents());
    fs.mkdirSync(path.join(repoRoot, ".codex/skills/repo-memory"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"), oldGeneratedSkill());
    const originalConfig = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");
    const originalAgents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");

    const result = await dispatch(["upgrade"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain("would_update");
    expect(fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8")).toBe(originalConfig);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(originalAgents);
  });

  test("writes commented config defaults and refreshes managed support files", async () => {
    const repoRoot = makeRepo(oldConfig());
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), oldAgents());
    fs.mkdirSync(path.join(repoRoot, ".codex/skills/repo-memory"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"), oldGeneratedSkill());

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const configText = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");
    const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    const skill = fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"), "utf8");
    const claimsReference = fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md"), "utf8");
    const coverageReference = fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/coverage-and-validation.md"), "utf8");
    const loaded = loadConfig({ repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("upgrade applied");
    expect(configText).toContain("# Defaults for agent-memory context when command flags are omitted.");
    expect(configText).toContain("max_claim_frontmatter_length: 900");
    expect(loaded.config.memory_root).toBe("memory");
    expect(loaded.config.validation.require_source_files).toBe(false);
    expect(loaded.config.context.default_budget).toBe("full");
    expect(agents).toContain("Keep local instructions.");
    expect(agents).toContain("### Agent-Memory-First Workflow");
    expect(agents).not.toContain("Old managed text");
    expect(fs.readFileSync(path.join(repoRoot, "bin/memory"), "utf8")).toBe(wrapperTemplate("npm"));
    expect(skill).toContain("## Available Commands");
    expect(skill).toContain("memory audit --git-diff");
    expect(skill).toContain("memory/claims/**/*.md");
    expect(skill).toContain("references/claims.md");
    expect(claimsReference).toContain("<!-- agent-memory:generated-reference repo-memory/claims.md -->");
    expect(coverageReference).toContain("## Stale Review");
  });

  test("refreshes known generated wrappers while preserving their package manager fallback", async () => {
    const repoRoot = makeRepo(oldConfig());
    const wrapperPath = path.join(repoRoot, "bin/memory");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, oldGeneratedWrapper("bun"));

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const wrapper = fs.readFileSync(wrapperPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refreshed bun wrapper");
    expect(wrapper).toBe(wrapperTemplate("bun"));
    expect(wrapper).toContain("bunx @jurgen1c/agent-memory-cli");
  });

  test("refreshes generated wrappers with EOF whitespace drift", async () => {
    const repoRoot = makeRepo(oldConfig());
    const wrapperPath = path.join(repoRoot, "bin/memory");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, wrapperTemplate("bun").trimEnd());

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refreshed bun wrapper");
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe(wrapperTemplate("bun"));
  });

  test("does not chmod current generated wrappers during dry runs", async () => {
    const repoRoot = makeRepo(oldConfig());
    const wrapperPath = path.join(repoRoot, "bin/memory");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, wrapperTemplate("npm"));
    fs.chmodSync(wrapperPath, 0o644);

    const result = await dispatch(["upgrade"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would_update");
    expect(result.stdout).toContain("make wrapper executable");
    expect(fs.statSync(wrapperPath).mode & 0o777).toBe(0o644);
  });

  test("chmods current generated wrappers when upgrade writes", async () => {
    const repoRoot = makeRepo(oldConfig());
    const wrapperPath = path.join(repoRoot, "bin/memory");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, wrapperTemplate("npm"));
    fs.chmodSync(wrapperPath, 0o644);

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("made wrapper executable");
    expect(fs.statSync(wrapperPath).mode & 0o111).toBeGreaterThan(0);
  });

  test("skips custom wrappers during upgrade", async () => {
    const repoRoot = makeRepo(oldConfig());
    const wrapperPath = path.join(repoRoot, "bin/memory");
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, "#!/usr/bin/env bash\necho custom memory wrapper\n");

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bin/memory does not look generated");
    expect(fs.readFileSync(wrapperPath, "utf8")).toBe("#!/usr/bin/env bash\necho custom memory wrapper\n");
  });

  test("is idempotent after writing the current support files", async () => {
    const repoRoot = makeRepo(oldConfig());
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), oldAgents());
    fs.mkdirSync(path.join(repoRoot, ".codex/skills/repo-memory"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"), oldGeneratedSkill());

    const first = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const configAfterFirst = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");
    const agentsAfterFirst = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    const skillAfterFirst = fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"), "utf8");
    const referenceAfterFirst = fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md"), "utf8");
    const second = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already current");
    expect(fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8")).toBe(configAfterFirst);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(agentsAfterFirst);
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"), "utf8")).toBe(skillAfterFirst);
    expect(fs.readFileSync(path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md"), "utf8")).toBe(referenceAfterFirst);
  });

  test("supports JSON output for upgrade plans", async () => {
    const repoRoot = makeRepo(oldConfig());

    const result = await dispatch(["upgrade", "--json"], { cwd: repoRoot });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.write).toBe(false);
    expect(parsed.force).toBe(false);
    expect(parsed.repo.root).toBe(repoRoot);
    expect(
      parsed.actions.some(
        (action: { path: string; status: string }) => action.path === "agent-memory.config.yaml" && action.status === "would_update"
      )
    ).toBe(true);
  });

  test("migrates deprecated config aliases while preserving their values", async () => {
    const repoRoot = makeRepo(`
version: 1
context:
  include_inferred_edges: true
`);

    const dryRun = await dispatch(["upgrade"], { cwd: repoRoot });
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain("Deprecated config field context.include_inferred_edges would be migrated");

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const configText = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");
    const loaded = loadConfig({ repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Deprecated config field context.include_inferred_edges was migrated");
    expect(loaded.config.context.include_inferred_edges_by_default).toBe(true);
    expect(configText).toContain("include_inferred_edges_by_default: true");
    expect(configText).not.toContain("include_inferred_edges: true");
  });

  test("defers deprecated alias migration warnings when unknown fields block config rewrite", async () => {
    const repoRoot = makeRepo(`
version: 1
custom_setting: true
context:
  include_inferred_edges: true
`);

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const configText = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unknown config field custom_setting");
    expect(result.stdout).toContain("Deprecated config field context.include_inferred_edges migration to context.include_inferred_edges_by_default was deferred");
    expect(result.stdout).not.toContain("Deprecated config field context.include_inferred_edges was migrated");
    expect(configText).toContain("custom_setting: true");
    expect(configText).toContain("include_inferred_edges: true");
    expect(configText).not.toContain("include_inferred_edges_by_default: true");
  });

  test("warns and keeps explicit replacement when deprecated config aliases are redundant", async () => {
    const repoRoot = makeRepo(`
version: 1
context:
  include_inferred_edges: true
  include_inferred_edges_by_default: false
`);

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const loaded = loadConfig({ repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Deprecated config field context.include_inferred_edges is ignored");
    expect(loaded.config.context.include_inferred_edges_by_default).toBe(false);
  });

  test("warns when deprecated config aliases have invalid values", async () => {
    const repoRoot = makeRepo(`
version: 1
context:
  include_inferred_edges: sometimes
`);

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const loaded = loadConfig({ repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Deprecated config field context.include_inferred_edges is ignored because it is not a boolean");
    expect(loaded.config.context.include_inferred_edges_by_default).toBe(false);
  });

  test("does not rewrite config with unknown fields unless forced", async () => {
    const repoRoot = makeRepo(`${oldConfig()}\ncustom_setting: true\n`);

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const configText = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unknown config field custom_setting");
    expect(result.stdout).toContain("skipped");
    expect(configText).toContain("custom_setting: true");
    expect(configText).not.toContain("max_claim_frontmatter_length");

    const forced = await dispatch(["upgrade", "--write", "--force"], { cwd: repoRoot });
    const forcedConfigText = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");

    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("will be removed because --force was passed");
    expect(forcedConfigText).not.toContain("custom_setting: true");
    expect(forcedConfigText).toContain("max_claim_frontmatter_length");
  });

  test("detects nested unknown config fields", async () => {
    const repoRoot = makeRepo(`
version: 1
validation:
  require_source_files: true
  future_rule: strict
`);

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const configText = fs.readFileSync(path.join(repoRoot, "agent-memory.config.yaml"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unknown config field validation.future_rule");
    expect(configText).toContain("future_rule: strict");
  });

  test("skips disabled skills during upgrade", async () => {
    const repoRoot = makeRepo(oldConfig());

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("docs/agent-memory/AGENT_SKILL.md");
    expect(result.stdout).toContain("generic skill disabled in config");
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md"))).toBe(false);
  });

  test("preserves legacy codex-only installs with both agent targets enabled", async () => {
    const repoRoot = makeRepo(oldConfigWithBothAgentsEnabled());
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, oldGeneratedSkill());

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const config = loadConfig({ repoRoot }).config;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Preserved legacy single-agent install");
    expect(config.agent_skills.codex.enabled).toBe(true);
    expect(config.agent_skills.generic.enabled).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md"))).toBe(false);
  });

  test("preserves legacy generic-only installs with both agent targets enabled", async () => {
    const repoRoot = makeRepo(oldConfigWithBothAgentsEnabled());
    const skillPath = path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, oldGeneratedSkill());

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });
    const config = loadConfig({ repoRoot }).config;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Preserved legacy single-agent install");
    expect(config.agent_skills.codex.enabled).toBe(false);
    expect(config.agent_skills.generic.enabled).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "docs/agent-memory/AGENT_SKILL.md"))).toBe(true);
  });

  test("skips custom skill files unless forced", async () => {
    const repoRoot = makeRepo(oldConfig());
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# Custom Skill\n\nDo not replace me.\n");

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("does not look generated");
    expect(fs.readFileSync(skillPath, "utf8")).toContain("Do not replace me.");

    const forced = await dispatch(["upgrade", "--write", "--force"], { cwd: repoRoot });

    expect(forced.exitCode).toBe(0);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("This repository uses `agent-memory`");
  });

  test("does not treat unmarked skill-like content as generated", async () => {
    const repoRoot = makeRepo(oldConfig());
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    const customSkill = `# Custom Repo Memory Skill

This repository uses \`agent-memory\`, but this file is hand-maintained.

## Available Commands

- custom
`;
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, customSkill);

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("does not look generated");
    expect(fs.readFileSync(skillPath, "utf8")).toBe(customSkill);
  });

  test("refreshes generated skill references and skips custom references unless forced", async () => {
    const repoRoot = makeRepo(oldConfig());
    const skillPath = path.join(repoRoot, ".codex/skills/repo-memory/SKILL.md");
    const generatedReferencePath = path.join(repoRoot, ".codex/skills/repo-memory/references/claims.md");
    const customReferencePath = path.join(repoRoot, ".codex/skills/repo-memory/references/recipes.md");
    fs.mkdirSync(path.dirname(generatedReferencePath), { recursive: true });
    fs.writeFileSync(skillPath, oldGeneratedSkill());
    fs.writeFileSync(generatedReferencePath, "<!-- agent-memory:generated-reference repo-memory/claims.md -->\n# Old\n");
    fs.writeFileSync(customReferencePath, "# Custom Recipes\n");

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Skill reference .codex/skills/repo-memory/references/recipes.md does not look generated");
    expect(fs.readFileSync(generatedReferencePath, "utf8")).toContain("# Claims");
    expect(fs.readFileSync(customReferencePath, "utf8")).toBe("# Custom Recipes\n");

    const forced = await dispatch(["upgrade", "--write", "--force"], { cwd: repoRoot });

    expect(forced.exitCode).toBe(0);
    expect(fs.readFileSync(customReferencePath, "utf8")).toContain("<!-- agent-memory:generated-reference repo-memory/recipes.md -->");
  });

  test("skips relative configured skill paths that escape the repository", async () => {
    const repoRoot = makeRepo(oldConfig());
    const outsideRelativePath = `../${path.basename(repoRoot)}-outside-skill/SKILL.md`;
    const outsidePath = path.resolve(repoRoot, outsideRelativePath);
    fs.writeFileSync(
      path.join(repoRoot, "agent-memory.config.yaml"),
      oldConfig().replace("path: .codex/skills/repo-memory/SKILL.md", `path: ${outsideRelativePath}`)
    );

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Skill path ${outsideRelativePath} escapes the repository root`);
    expect(result.stdout).toContain("relative path escapes repository root");
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  test("can refresh configured absolute skill paths", async () => {
    const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-absolute-skill-"));
    const skillPath = path.join(skillRoot, "SKILL.md");
    const repoRoot = makeRepo(
      oldConfig().replace("path: .codex/skills/repo-memory/SKILL.md", `path: ${skillPath}`)
    );

    const result = await dispatch(["upgrade", "--write"], { cwd: repoRoot });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("This repository uses `agent-memory`");
  });
});

function makeRepo(config: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-upgrade-"));
  fs.writeFileSync(path.join(repoRoot, "agent-memory.config.yaml"), config.trimStart());
  return repoRoot;
}

function oldConfig(): string {
  return `
version: 1
memory_root: memory
database_path: cache/memory.sqlite

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

validation:
  require_source_files: false

context:
  default_budget: full
  default_depth: 2
  include_inferred_edges_by_default: true
`;
}

function oldConfigWithBothAgentsEnabled(): string {
  return oldConfig().replace("    enabled: false", "    enabled: true");
}

function oldAgents(): string {
  return `# Agent Instructions

Keep local instructions.

<!-- agent-memory:start -->
## Old managed text
<!-- agent-memory:end -->
`;
}

function oldGeneratedSkill(): string {
  return `<!-- agent-memory:generated-skill repo-memory -->
# Repo Memory Skill

This repository uses \`agent-memory\`.

## Available Commands

- old
`;
}

function oldGeneratedWrapper(packageManager: "npm" | "bun"): string {
  const fallback = packageManager === "bun" ? "bunx agent-memory" : "npx agent-memory";

  return `#!/usr/bin/env bash
set -euo pipefail

if [ -n "\${AGENT_MEMORY_CLI:-}" ]; then
  exec "\${AGENT_MEMORY_CLI}" "$@"
fi

if command -v agent-memory >/dev/null 2>&1; then
  exec agent-memory "$@"
fi

exec ${fallback} "$@"
`;
}
