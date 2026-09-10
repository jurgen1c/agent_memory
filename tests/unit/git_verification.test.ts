import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitCommandError, runGit, type GitCommandOptions } from "../../packages/core/src/git";
import { verifyGitCommit } from "../../packages/core/src/git_verification";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function repository(format = "sha1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-git-verification-")); roots.push(root);
  runGit(root, ["init", `--object-format=${format}`]);
  runGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  return { root, oid: runGit(root, ["rev-parse", "HEAD"]) };
}
function result(stdout: string, overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null, ...overrides };
}

describe("production Git verification diagnostics", () => {
  for (const format of ["sha1", "sha256"]) test(`exact ${format} commits and actual status-zero missing objects`, () => {
    const { root, oid } = repository(format);
    expect(verifyGitCommit(root, oid.toUpperCase()).code).toBe("GIT_VERIFIED");
    const missing = "f".repeat(oid.length);
    const actual = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: root, input: `${missing}\n`, encoding: "utf8" });
    expect(actual.status).toBe(0); expect(actual.stdout).toBe(`${missing} missing\n`);
    const diagnostic = verifyGitCommit(root, missing);
    expect(diagnostic.code).toBe("GIT_UNKNOWN_OBJECT"); expect(diagnostic.remediation).toContain("repair the reference only after review");
  });

  for (const [errorCode, code] of [["EPERM", "GIT_PERMISSION_DENIED"], ["EACCES", "GIT_PERMISSION_DENIED"],
    ["ENOENT", "GIT_EXECUTABLE_MISSING"], ["ETIMEDOUT", "GIT_TIMEOUT"], ["EIO", "GIT_UNAVAILABLE"]]) {
    test(`${errorCode} dominates status zero and complete valid stdout at the object probe`, () => {
      const { root, oid } = repository();
      const error = Object.assign(new Error("fixture failure"), { code: errorCode });
      const spawn: GitCommandOptions["spawn"] = (binary, args, options) => args.includes("cat-file")
        ? result(`${oid} commit\n`, { error, stderr: "x".repeat(3000) }) : spawnSync(binary, args, options);
      const diagnostic = verifyGitCommit(root, oid, { spawn });
      expect(diagnostic.code).toBe(code); expect(diagnostic.state).toBe("unavailable");
      expect(diagnostic.status).toBe(0); expect(diagnostic.errorCode).toBe(errorCode);
      expect(diagnostic.diagnostic.length).toBe(512); expect(diagnostic.message.length).toBeLessThanOrEqual(512);
      expect(diagnostic.remediation).not.toContain("repair"); expect(diagnostic.remediation).not.toContain("fetch");
      try { runGit(root, ["cat-file"], { spawn }); } catch (caught) {
        expect(caught).toBeInstanceOf(GitCommandError); expect((caught as GitCommandError).cause).toBe(error);
      }
    });
  }

  for (const overrides of [{ signal: "SIGKILL" as const }, { status: null }, { status: 128, stderr: "localized failure" }]) {
    test(`killed, no-status and repository failures: ${JSON.stringify(overrides)}`, () => {
      const { root, oid } = repository();
      const diagnostic = verifyGitCommit(root, oid, { spawn: () => result("sha1\n", overrides) });
      expect(diagnostic.code).toBe(overrides.status === 128 ? "GIT_CHECK_FAILED" : "GIT_UNAVAILABLE");
      expect(diagnostic.state).toBe("unavailable"); expect(diagnostic.signal).toBe(overrides.signal ?? null);
      expect(diagnostic.remediation).not.toContain("repair");
    });
  }

  test("repository and missing object-store failures never suggest unknown history", () => {
    const { root, oid } = repository();
    fs.renameSync(path.join(root, ".git/objects"), path.join(root, ".git/objects-unavailable"));
    expect(verifyGitCommit(root, oid).code).toBe("GIT_CHECK_FAILED");
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    expect(verifyGitCommit(root, oid).code).toBe("GIT_CHECK_FAILED");
    expect(verifyGitCommit(root, oid, { gitBinary: path.join(root, "nonexistent-git") }).code).toBe("GIT_EXECUTABLE_MISSING");
  });

  test("unreadable object directories cannot become missing objects", () => {
    const { root, oid } = repository();
    const objectDir = path.join(root, ".git/objects", oid.slice(0, 2));
    fs.chmodSync(objectDir, 0);
    try { expect(verifyGitCommit(root, "f".repeat(40)).code).toBe("GIT_PERMISSION_DENIED"); }
    finally { fs.chmodSync(objectDir, 0o755); }
  });

  test("malformed, wrong OID, noncommit and extra output never verify", () => {
    const { root, oid } = repository();
    for (const stdout of ["", `${oid} blob\n`, `${oid} tag\n`, `${oid} tree\n`, `${oid} mystery\n`, `${"e".repeat(40)} commit\n`, `${oid} commit\nextra\n`, "missing\n"]) {
      const diagnostic = verifyGitCommit(root, oid, { spawn: (binary, args, options) =>
        args.includes("cat-file") ? result(stdout) : spawnSync(binary, args, options) });
      expect(diagnostic.code).toBe("VERIFICATION_METADATA_MALFORMED"); expect(diagnostic.state).toBe("invalid_reference");
      expect(diagnostic.remediation).not.toContain("repair");
    }
    const blob = runGit(root, ["hash-object", "-w", "--stdin"], { input: "fixture" });
    expect(verifyGitCommit(root, blob).code).toBe("VERIFICATION_METADATA_MALFORMED");
    runGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-a", "fixture", "-m", "tag"]);
    expect(verifyGitCommit(root, runGit(root, ["rev-parse", "fixture"])).code).toBe("VERIFICATION_METADATA_MALFORMED");
    expect(verifyGitCommit(root, "HEAD").code).toBe("VERIFICATION_METADATA_MALFORMED");
  });
});
