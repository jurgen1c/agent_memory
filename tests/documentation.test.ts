import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const readme = fs.readFileSync(path.resolve("README.md"), "utf8");

describe("global install documentation", () => {
  test("provides copy-pastable global setup and local migration workflows", () => {
    expect(readme).toContain("npm install -g @jurgen1c/agent-memory-cli");
    expect(readme).toContain("agent-memory init --yes --agent codex --install-hooks");
    expect(readme).toContain("agent-memory compile");
    expect(readme).toContain("agent-memory sync");
    expect(readme).toContain("agent-memory doctor");
    expect(readme).toContain('agent-memory context --task "fix student oauth"');
    expect(readme).toContain("agent-memory upgrade --global\n");
    expect(readme).toContain("agent-memory upgrade --global --write");
    expect(readme).toContain("- run: npm install -g @jurgen1c/agent-memory-cli");
    expect(readme).not.toContain("- run: npm install\n");
    expect(readme).not.toContain("- run: npx agent-memory");
  });

  test("documents compatibility, generated-state boundaries, and required troubleshooting", () => {
    for (const term of [
      "Local and Wrapper Compatibility",
      "memory_key",
      "database_scope",
      "database_path",
      "AGENT_MEMORY_HOME",
      "registry.json",
      "do not commit or synchronize them",
      "command not found",
      "Compiled database is missing",
      "Registry reports stale paths",
      "Repository moved",
      "Duplicate or colliding `memory_key`",
      "Custom wrapper during migration"
    ]) {
      expect(readme).toContain(term);
    }
  });

  test("uses the global command in wrapperless workflow examples", () => {
    const wrapperlessGuides = readme.slice(readme.indexOf("## Contextual Workflow Guide"));
    const explicitWrapperExample = [
      "bin/memory sync",
      "bin/memory coverage --git-diff --base origin/main",
      "bin/memory audit --git-diff --base origin/main"
    ].join("\n");

    expect(wrapperlessGuides.replace(explicitWrapperExample, "")).not.toContain("bin/memory");
  });
});
