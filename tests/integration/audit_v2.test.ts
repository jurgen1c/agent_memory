import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";
import { auditMemoryV2 } from "../../packages/core/src/audit_v2";
import { compileMemory } from "../../packages/core/src/compiler";
import { runGit } from "../../packages/core/src/git";
import { openSqliteDatabase } from "../../packages/core/src/sqlite";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const claimRelative = "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-audit-v2-")); roots.push(root);
  fs.cpSync(path.resolve("examples/mock-app"), root, { recursive: true });
  fs.rmSync(path.join(root, ".agent-memory"), { recursive: true, force: true });
  return root;
}
function commit(root: string) {
  runGit(root, ["init"]); runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

describe("v2 audit health", () => {
  test("separate dimensions and advisory metadata preserve v1 JSON", async () => {
    const cwd = fixture();
    const v1 = JSON.parse((await dispatch(["audit", "--changed-files", "README.md", "--json"], { cwd })).stdout);
    expect(Object.keys(v1)).toEqual(["ok", "changedFiles", "findings", "warnings"]);
    const result = await dispatch(["audit", "--format-version", "2", "--json"], { cwd });
    const v2 = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0); expect(v2.schemaVersion).toBe(2);
    expect(v2.structure.state).toBe("valid"); expect(v2.cache.state).toBe("missing");
    expect(v2.claims[0].verificationMetadata).toBe("missing"); expect(v2.claims[0].verificationCheck).toBe("not_run");
    expect(v2.claims[0].qualitySignals[0].code).toBe("VERIFICATION_METADATA_MISSING");
    const human = await dispatch(["audit", "--format-version=2"], { cwd });
    expect(human.stdout).toContain("Structure: valid"); expect(human.stdout).toContain("verificationCheck=not_run");
    expect((await dispatch(["help", "audit"], { cwd })).stdout).toContain("--format-version 2");
    expect((await dispatch(["agent-manifest", "--json"], { cwd })).stdout).toContain("audit --format-version 2");
    await expect(dispatch(["audit", "--format-version", "3"], { cwd })).rejects.toThrow("must be 1 or 2");
  });

  test("cache uses canonical content digests including bodies, not timestamps", async () => {
    const cwd = fixture();
    const compiled = await compileMemory({ cwd });
    expect((await auditMemoryV2({ cwd })).cache.state).toBe("fresh");
    const claimPath = path.join(cwd, claimRelative); const stat = fs.statSync(claimPath);
    fs.appendFileSync(claimPath, "\nBody-only review note.\n"); fs.utimesSync(claimPath, stat.atime, stat.mtime);
    expect((await auditMemoryV2({ cwd })).cache.state).toBe("stale");
    const incomplete = await openSqliteDatabase(compiled.databasePath);
    incomplete.run("DROP TABLE claims_fts"); incomplete.close();
    expect((await auditMemoryV2({ cwd })).cache.state).toBe("unsupported");
    await compileMemory({ cwd });
    const database = await openSqliteDatabase(compiled.databasePath);
    database.run("UPDATE compile_metadata SET value = '999' WHERE key = 'schema_version'"); database.close();
    expect((await auditMemoryV2({ cwd })).cache.state).toBe("unsupported");
    fs.writeFileSync(compiled.databasePath, "not sqlite");
    expect((await auditMemoryV2({ cwd })).cache.state).toBe("unavailable");
  });

  test("source-backed quality signals and all checks leave canonical data and stored commands untouched", async () => {
    const cwd = fixture(); const oid = commit(cwd);
    const claimPath = path.join(cwd, claimRelative);
    const original = fs.readFileSync(claimPath, "utf8");
    const changed = original.replace("last_verified_commit: null", `last_verified_commit: "  ${oid}  "`)
      .replace("verification:\n  - bun test", "verification:\n  - touch SHOULD_NOT_EXIST")
      .replace(/claim:.*\n/, 'claim: "This interaction preserves the documented data contract and failure modes."\n')
      .replace(/tags:\n(?:  - .*\n)+/, "tags:\n  - auth.student_oauth.uid_is_tenant_scoped\n")
      + "\n## Verification\n\n`touch SHOULD_NOT_EXIST`\n";
    fs.writeFileSync(claimPath, changed); fs.appendFileSync(path.join(cwd, "src/auth.js"), "\n// changed\n");
    const result = await auditMemoryV2({ cwd });
    const health = result.claims.find((claim) => claim.id === "auth.student_oauth.uid_is_tenant_scoped")!;
    expect(health.verificationMetadata).toBe("present"); expect(health.verificationCheck).toBe("verified");
    expect(health.qualitySignals.map((signal) => signal.code)).toEqual(["GENERIC_SUMMARY", "ID_ONLY_TAGS", "SOURCE_CHANGED_SINCE_VERIFICATION"]);
    expect(health.qualitySignals[0].text).toBe("This interaction preserves the documented data contract and failure modes.");
    expect(fs.readFileSync(claimPath, "utf8")).toBe(changed); expect(fs.existsSync(path.join(cwd, "SHOULD_NOT_EXIST"))).toBe(false);
    const unavailable = await auditMemoryV2({ cwd, gitBinary: path.join(cwd, "missing-executable") });
    expect(unavailable.ok).toBe(false);
    expect(unavailable.claims.find((claim) => claim.id === health.id)?.diagnostic?.code).toBe("GIT_EXECUTABLE_MISSING");
    expect(fs.readFileSync(claimPath, "utf8")).toBe(changed);
    fs.writeFileSync(claimPath, changed.replace(oid, "f".repeat(40)));
    const missing = await auditMemoryV2({ cwd });
    expect(missing.claims.find((claim) => claim.id === health.id)?.diagnostic?.code).toBe("GIT_UNKNOWN_OBJECT");
    fs.writeFileSync(claimPath, changed.replace(oid, "HEAD"));
    const malformed = await auditMemoryV2({ cwd });
    expect(malformed.structure.state).toBe("invalid");
    expect(malformed.claims.find((claim) => claim.id === health.id)?.verificationMetadata).toBe("malformed");
  });

  test("built Node CLI supports v2 health and exit 6 without executing memory", () => {
    const cwd = fixture(); const oid = commit(cwd); const claimPath = path.join(cwd, claimRelative);
    const content = fs.readFileSync(claimPath, "utf8").replace("last_verified_commit: null", `last_verified_commit: "  ${oid}  "`);
    fs.writeFileSync(claimPath, content);
    const cli = path.join(cwd, "audit-cli.js");
    const build = spawnSync("bun", ["build", path.resolve("packages/cli/src/index.ts"), "--target=node", "--packages=external", `--outfile=${cli}`], { encoding: "utf8" });
    expect(build.status).toBe(0);
    fs.symlinkSync(path.resolve("node_modules"), path.join(cwd, "node_modules"), "dir");
    const success = spawnSync("node", [cli, "audit", "--format-version", "2", "--json"], { cwd, encoding: "utf8" });
    expect(success.error).toBeUndefined(); expect(success.status).toBe(0);
    expect(JSON.parse(success.stdout).claims.some((claim: { verificationCheck: string }) => claim.verificationCheck === "verified")).toBe(true);
    fs.writeFileSync(claimPath, content.replace(oid, "f".repeat(40)));
    const missing = spawnSync("node", [cli, "audit", "--format-version", "2", "--json"], { cwd, encoding: "utf8" });
    expect(missing.status).toBe(6); expect(missing.stdout).toContain("GIT_UNKNOWN_OBJECT");
  });
});
