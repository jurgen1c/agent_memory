import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveInitMemoryKey, deriveRepositoryIdentity, slugifyMemoryKey } from "../../packages/core/src/memory_key";

describe("global init memory keys", () => {
  test("derives the same key from equivalent HTTPS and SSH origin paths", () => {
    const repoRoot = makeGitRepo("checkout");

    git(repoRoot, ["remote", "add", "origin", "https://github.com/Acme-Inc/Sample_Repo.git"]);
    expect(deriveInitMemoryKey({ repoRoot })).toBe("acme-inc-sample-repo");

    git(repoRoot, ["remote", "set-url", "origin", "git@github.com:Acme-Inc/Sample_Repo.git"]);
    expect(deriveInitMemoryKey({ repoRoot })).toBe("acme-inc-sample-repo");
    expect(deriveRepositoryIdentity(repoRoot)).toBe("remote:github.com/acme-inc/sample_repo");
  });

  test("normalizes common transports and preserves SSH accounts on unknown hosts", () => {
    const repoRoot = makeGitRepo("checkout");
    git(repoRoot, ["remote", "add", "origin", "https://github.com/Acme/Repo.git"]);
    expect(deriveRepositoryIdentity(repoRoot)).toBe("remote:github.com/acme/repo");

    git(repoRoot, ["remote", "set-url", "origin", "git@github.com:Acme/Repo.git"]);
    expect(deriveRepositoryIdentity(repoRoot)).toBe("remote:github.com/acme/repo");

    git(repoRoot, ["remote", "set-url", "origin", "alice@git.example.test:Acme/Repo.git"]);
    expect(deriveRepositoryIdentity(repoRoot)).toBe("remote:ssh-account:alice@git.example.test/Acme/Repo");
  });

  test("uses a stable checkout identity when origin is unavailable", () => {
    const repoRoot = makeGitRepo("checkout");
    const first = deriveRepositoryIdentity(repoRoot);

    expect(first).toMatch(/^checkout:[0-9a-f]{64}$/);
    expect(deriveRepositoryIdentity(repoRoot)).toBe(first);
  });

  test("uses checkout identity for local-path origins", () => {
    const repoRoot = makeGitRepo("checkout");
    git(repoRoot, ["remote", "add", "origin", "../upstream.git"]);
    expect(deriveRepositoryIdentity(repoRoot)).toMatch(/^checkout:[0-9a-f]{64}$/);

    git(repoRoot, ["remote", "set-url", "origin", "upstream.git"]);
    expect(deriveRepositoryIdentity(repoRoot)).toMatch(/^checkout:[0-9a-f]{64}$/);

    git(repoRoot, ["remote", "set-url", "origin", `file://${path.join(repoRoot, "upstream.git")}`]);
    expect(deriveRepositoryIdentity(repoRoot)).toMatch(/^checkout:[0-9a-f]{64}$/);
  });

  test("rejects non-default ports and remote dot segments", () => {
    const repoRoot = makeGitRepo("checkout");
    git(repoRoot, ["remote", "add", "origin", "ssh://alice@git.example.test:2222/org/repo.git"]);
    expect(() => deriveRepositoryIdentity(repoRoot)).toThrow("Could not derive a safe repository identity");

    git(repoRoot, ["remote", "set-url", "origin", "alice@git.example.test:org/../repo.git"]);
    expect(() => deriveRepositoryIdentity(repoRoot)).toThrow("Could not derive a safe repository identity");

    git(repoRoot, ["remote", "set-url", "origin", "ssh://alice@git.example.test/org/%2e%2e/repo.git"]);
    expect(() => deriveRepositoryIdentity(repoRoot)).toThrow("Could not derive a safe repository identity");
  });

  test("falls back to the repository directory and accepts explicit valid keys", () => {
    const repoRoot = makeGitRepo("Résumé Memory");

    expect(deriveInitMemoryKey({ repoRoot })).toBe("resume-memory");
    expect(deriveInitMemoryKey({ repoRoot, explicitMemoryKey: "stable.repo_key" })).toBe("stable.repo_key");
    expect(slugifyMemoryKey(" Owner / Repository_Name ")).toBe("owner-repository-name");
  });

  test("rejects invalid keys without echoing their value", () => {
    const repoRoot = makeGitRepo("checkout");
    const invalid = "token-containing secret";

    try {
      deriveInitMemoryKey({ repoRoot, explicitMemoryKey: invalid });
      throw new Error("Expected invalid memory key to fail.");
    } catch (error) {
      expect((error as Error).message).toContain("Could not derive a valid memory_key");
      expect((error as Error).message).not.toContain(invalid);
    }
  });
});

function makeGitRepo(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-key-"));
  const repoRoot = path.join(parent, name);
  fs.mkdirSync(repoRoot);
  git(repoRoot, ["init"]);
  return repoRoot;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
}
