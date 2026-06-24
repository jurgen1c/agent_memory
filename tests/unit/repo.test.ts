import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRepoRoot } from "../../packages/core/src/repo";

describe("findRepoRoot", () => {
  test("uses cwd with a warning outside git repositories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-no-git-"));
    const result = findRepoRoot(dir);

    expect(result.root).toBe(dir);
    expect(result.detectedBy).toBe("cwd");
    expect(result.warnings).toHaveLength(1);
  });

  test("uses git top-level when cwd is inside a git repository", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-git-"));
    const nested = path.join(repoRoot, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    const init = spawnSync("git", ["init"], { cwd: repoRoot, encoding: "utf8" });
    expect(init.status).toBe(0);

    const result = findRepoRoot(nested);
    expect(result.root).toBe(repoRoot);
    expect(result.detectedBy).toBe("git");
    expect(result.warnings).toEqual([]);
  });
});
