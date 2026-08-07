import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGitDiffSelection } from "../../packages/core/src/changes";
import { GitCommandError, repositoryObjectIdLength, runGit } from "../../packages/core/src/git";

describe("bounded Git command runner", () => {
  test("returns trimmed text output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-git-runner-"));
    const gitBinary = writeExecutable(root, "fake-git", "#!/usr/bin/env bash\nprintf 'result\\n'\n");

    expect(runGit(root, ["rev-parse", "HEAD"], { gitBinary })).toBe("result");
  });

  test("terminates stalled commands at the configured deadline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-git-runner-timeout-"));
    const gitBinary = writeExecutable(root, "stalled-git", "#!/usr/bin/env bash\nwhile true; do :; done\n");
    const startedAt = performance.now();

    try {
      runGit(root, ["status"], { gitBinary, timeoutMs: 50 });
      throw new Error("Expected stalled Git command to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as GitCommandError).timedOut).toBe(true);
      expect((error as Error).message).toContain("Git command timed out after 50ms");
    }

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("does not report an empty diff when every Git inspection fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-not-a-git-repo-"));

    expect(() => readGitDiffSelection(root)).toThrow("Could not inspect Git changes");
  });

  test("rejects a partial selection when the tracked working-tree probe fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-partial-git-selection-"));
    const gitBinary = writeExecutable(
      root,
      "partial-git",
      `#!/usr/bin/env bash
case "$*" in
  "rev-parse --is-inside-work-tree") printf 'true\\n' ;;
  "rev-parse --verify HEAD^{commit}") printf '0123456789abcdef\\n' ;;
  "diff --name-only HEAD") printf 'tracked.ts\\n' >&2; exit 7 ;;
  "diff --cached --name-only") printf 'staged.ts\\n' ;;
  "ls-files --others --exclude-standard") printf 'untracked.ts\\n' ;;
  *) exit 9 ;;
esac
`
    );

    expect(() => readGitDiffSelection(root, { gitBinary })).toThrow("Could not inspect Git changes");
  });

  test("rejects a partial selection when the untracked-file probe fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-partial-untracked-selection-"));
    const gitBinary = writeExecutable(
      root,
      "partial-git",
      `#!/usr/bin/env bash
case "$*" in
  "rev-parse --is-inside-work-tree") printf 'true\\n' ;;
  "rev-parse --verify HEAD^{commit}") printf '0123456789abcdef\\n' ;;
  "diff --name-only HEAD") printf 'tracked.ts\\n' ;;
  "diff --cached --name-only") printf 'staged.ts\\n' ;;
  "ls-files --others --exclude-standard") printf 'untracked.ts\\n' >&2; exit 8 ;;
  *) exit 9 ;;
esac
`
    );

    expect(() => readGitDiffSelection(root, { gitBinary })).toThrow("Could not inspect Git changes");
  });

  test("supports staged and untracked files in an unborn repository", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-unborn-selection-"));
    runGit(root, ["init"]);
    fs.writeFileSync(path.join(root, "staged.ts"), "export const staged = true;\n");
    fs.writeFileSync(path.join(root, "untracked.ts"), "export const untracked = true;\n");
    runGit(root, ["add", "staged.ts"]);

    expect(readGitDiffSelection(root).files).toEqual(["staged.ts", "untracked.ts"]);
  });

  test("reads the repository object ID length without spawning Git", () => {
    const sha1Root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-sha1-format-"));
    const sha256Root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-sha256-format-"));
    fs.mkdirSync(path.join(sha1Root, ".git"));
    fs.mkdirSync(path.join(sha256Root, ".git"));
    fs.writeFileSync(path.join(sha1Root, ".git/config"), "[core]\n\trepositoryformatversion = 0\n");
    expect(repositoryObjectIdLength(sha1Root)).toBe(40);

    for (const objectFormat of ['"sha256"', "sha256 # repository hash format", '"sha256" ; repository hash format']) {
      fs.writeFileSync(
        path.join(sha256Root, ".git/config"),
        `[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = ${objectFormat}\n`
      );
      expect(repositoryObjectIdLength(sha256Root)).toBe(64);
    }

    fs.writeFileSync(
      path.join(sha1Root, ".git/config"),
      '[core]\n\trepositoryformatversion = 0\n[extensions "metadata"]\n\tobjectFormat = sha256\n'
    );
    expect(repositoryObjectIdLength(sha1Root)).toBe(40);
  });
});

function writeExecutable(root: string, name: string, content: string): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}
