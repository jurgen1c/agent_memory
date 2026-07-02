import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfiguredPath } from "../../packages/core/src/files";

describe("resolveConfiguredPath", () => {
  test("resolves relative paths inside the repository", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-files-repo-"));

    expect(resolveConfiguredPath(repoRoot, "docs/agent-memory")).toBe(path.join(repoRoot, "docs/agent-memory"));
  });

  test("rejects relative paths that escape the repository", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-files-repo-"));

    expect(() => resolveConfiguredPath(repoRoot, "../outside-memory")).toThrow("Relative configured path escapes repository root");
  });

  test("allows absolute paths outside the repository", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-files-repo-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-files-outside-"));

    expect(resolveConfiguredPath(repoRoot, outsideRoot)).toBe(outsideRoot);
  });

  test("rejects relative paths that escape through symlinks", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-files-repo-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-files-outside-"));
    fs.symlinkSync(outsideRoot, path.join(repoRoot, "external"), "dir");

    expect(() => resolveConfiguredPath(repoRoot, "external/memory")).toThrow("Relative configured path escapes repository root through a symlink");
  });
});
