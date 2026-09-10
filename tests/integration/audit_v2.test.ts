import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";
import { auditMemoryV2 } from "../../packages/core/src/audit_v2";
import { compileMemory } from "../../packages/core/src/compiler";
import { discoverFiles } from "../../packages/core/src/files";
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

  test("configuration syntax and schema failures are invalid while missing or unreadable configuration is unavailable", async () => {
    const cwd = fixture(); const configPath = path.join(cwd, "agent-memory.config.yaml");
    const original = fs.readFileSync(configPath, "utf8");
    for (const content of ["version: [unterminated\n", "version: 999\n", "memory_root: []\n", "memory_root: ../escape\n"]) {
      fs.writeFileSync(configPath, content);
      const result = await dispatch(["audit", "--format-version", "2", "--json"], { cwd });
      expect(result.exitCode).toBe(6);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.structure.state).toBe("invalid");
      expect(parsed.structure.diagnostics[0]).toMatchObject({ code: "STRUCTURE_INVALID", path: "agent-memory.config.yaml" });
      expect(parsed.structure.diagnostics[0].remediation).toContain("Correct the configuration");
      expect(parsed.structure.diagnostics[0].message.length).toBeLessThanOrEqual(512);
    }
    fs.rmSync(configPath);
    expect((await auditMemoryV2({ cwd })).structure.state).toBe("unavailable");
    fs.writeFileSync(configPath, original); fs.chmodSync(configPath, 0);
    try {
      const result = await auditMemoryV2({ cwd });
      expect(result.structure.state).toBe("unavailable");
      expect(result.structure.diagnostics[0].remediation).toContain("Restore configuration");
    } finally { fs.chmodSync(configPath, 0o644); }
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  test("invalid structure keeps validator source coordinates in JSON and human output", async () => {
    const cwd = fixture(); const claimPath = path.join(cwd, claimRelative);
    fs.writeFileSync(claimPath, fs.readFileSync(claimPath, "utf8").replace(/tags:\n(?:  - .*\n)+/, "tags: []\n"));
    const json = await dispatch(["audit", "--format-version", "2", "--json"], { cwd });
    expect(json.exitCode).toBe(6);
    const result = JSON.parse(json.stdout);
    expect(result.structure.state).toBe("invalid");
    expect(result.structure.diagnostics.find((item: { code: string }) => item.code === "claim.tags.required")).toMatchObject({
      path: claimRelative.replace("docs/agent-memory/", ""), id: "auth.student_oauth.uid_is_tenant_scoped"
    });
    const human = await dispatch(["audit", "--format-version", "2"], { cwd });
    expect(human.stdout).toContain(`Source: "${claimRelative.replace("docs/agent-memory/", "")}"`);
    expect(human.stdout).toContain('Claim: "auth.student_oauth.uid_is_tenant_scoped"');
  });

  test("unrelated malformed artifacts do not erase readable claim diagnostics", async () => {
    const cwd = fixture();
    const before = await auditMemoryV2({ cwd });
    fs.mkdirSync(path.join(cwd, "docs/agent-memory/graph"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs/agent-memory/graph/bad.yaml"), "edges: [unterminated\n");
    const brokenGraph = await auditMemoryV2({ cwd });
    expect(brokenGraph.structure.state).toBe("invalid");
    expect(brokenGraph.claims).toEqual(before.claims);
    const claimPath = path.join(cwd, claimRelative);
    fs.writeFileSync(claimPath, "---\ntags: [unterminated\n---\n");
    const brokenClaim = await auditMemoryV2({ cwd });
    expect(brokenClaim.structure.state).toBe("invalid");
    expect(brokenClaim.claims).toHaveLength(before.claims.length - 1);
    expect(brokenClaim.claims[0].qualitySignals.length).toBeGreaterThan(0);
  });

  test("source drift and readable claim health survive unrelated malformed and inaccessible graph artifacts", async () => {
    const cwd = fixture(); const oid = commit(cwd); const claimPath = path.join(cwd, claimRelative);
    fs.writeFileSync(claimPath, fs.readFileSync(claimPath, "utf8").replace("last_verified_commit: null", `last_verified_commit: ${oid}`));
    fs.appendFileSync(path.join(cwd, "src/auth.js"), "\n// source drift\n");
    const before = await auditMemoryV2({ cwd });
    expect(before.claims[0].qualitySignals.some((signal) => signal.code === "SOURCE_CHANGED_SINCE_VERIFICATION")).toBe(true);
    const graph = path.join(cwd, "docs/agent-memory/graph");
    fs.writeFileSync(path.join(graph, "bad.yaml"), "edges: [unterminated\n");
    const malformed = await auditMemoryV2({ cwd });
    expect(malformed.structure.state).toBe("invalid");
    expect(malformed.claims).toEqual(before.claims);
    fs.chmodSync(graph, 0);
    try {
      expect(() => discoverFiles(path.join(cwd, "docs/agent-memory"), ["claims/**/*.md"])).toThrow();
      const inaccessible = await auditMemoryV2({ cwd });
      expect(inaccessible.structure.state).toBe("unavailable");
      expect(inaccessible.claims).toEqual(before.claims);
      expect(inaccessible.structure.diagnostics.some((item) => item.path === "graph")).toBe(true);
    } finally { fs.chmodSync(graph, 0o755); }
  });

  test("a corrupt referenced commit cannot hide another claim's source drift", async () => {
    const cwd = fixture(); const old = commit(cwd);
    fs.appendFileSync(path.join(cwd, "README.md"), "\nNew verification commit\n");
    const current = commit(cwd);
    const first = path.join(cwd, claimRelative);
    const second = path.join(cwd, "docs/agent-memory/claims/tenancy/current_tenant_required_for_student_auth.md");
    fs.writeFileSync(first, fs.readFileSync(first, "utf8").replace("last_verified_commit: null", `last_verified_commit: ${old}`));
    fs.writeFileSync(second, fs.readFileSync(second, "utf8").replace("last_verified_commit: null", `last_verified_commit: ${current}`));
    fs.appendFileSync(path.join(cwd, "src/tenant.js"), "\n// source drift\n");
    const corrupt = path.join(cwd, ".git/objects", old.slice(0, 2), old.slice(2));
    fs.chmodSync(corrupt, 0o644); fs.writeFileSync(corrupt, "corrupt loose commit");
    const result = await auditMemoryV2({ cwd });
    expect(result.claims[0].diagnostic).toMatchObject({ code: "GIT_CHECK_FAILED", phase: "object" });
    expect(result.claims[1].verificationCheck).toBe("verified");
    expect(result.claims[1].qualitySignals.some((signal) => signal.code === "SOURCE_CHANGED_SINCE_VERIFICATION")).toBe(true);
  });

  test("inaccessible canonical files report unavailable structure and retain other readable claims", async () => {
    const cwd = fixture(); const claimPath = path.join(cwd, claimRelative);
    const original = fs.readFileSync(claimPath, "utf8");
    fs.chmodSync(claimPath, 0);
    try {
      const result = await auditMemoryV2({ cwd });
      expect(result.structure.state).toBe("unavailable");
      expect(result.ok).toBe(false);
      expect(result.structure.diagnostics.every((item) => item.code === "STRUCTURE_UNAVAILABLE")).toBe(true);
      expect(result.structure.diagnostics[0].path).toBe(claimRelative.replace("docs/agent-memory/", ""));
      expect(result.structure.diagnostics[0].remediation).toContain("Restore canonical memory access");
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0].verificationCheck).toBe("not_run");
    } finally { fs.chmodSync(claimPath, 0o644); }
    expect(fs.readFileSync(claimPath, "utf8")).toBe(original);
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

  test("concurrent canonical or configuration changes cannot certify an old compiled snapshot as fresh", async () => {
    for (const changeConfig of [false, true]) {
      const cwd = fixture(); const compiled = await compileMemory({ cwd });
      const oldDatabase = fs.readFileSync(compiled.databasePath);
      const compilation = compileMemory({ cwd });
      const changedPath = path.join(cwd, changeConfig ? "agent-memory.config.yaml" : claimRelative);
      fs.appendFileSync(changedPath, changeConfig ? "\n# Changed during compile\n" : "\nChanged canonical body during compile.\n");
      await expect(compilation).rejects.toThrow("Canonical memory or configuration changed during compilation");
      expect(fs.readFileSync(compiled.databasePath)).toEqual(oldDatabase);
      expect((await auditMemoryV2({ cwd })).cache.state).toBe("stale");
      await compileMemory({ cwd });
      expect((await auditMemoryV2({ cwd })).cache.state).toBe("fresh");
    }
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

  test("built Node Git verification supports quoted alternate paths containing backslashes", () => {
    const cwd = fixture(); commit(cwd);
    const alternate = fixture(); fs.appendFileSync(path.join(alternate, "README.md"), "\nAlternate fixture\n");
    const oid = commit(alternate);
    const store = path.join(alternate, "objects with-é\\quotes\"");
    fs.renameSync(path.join(alternate, ".git/objects"), store);
    fs.writeFileSync(path.join(cwd, ".git/objects/info/alternates"), JSON.stringify(store) + "\n");
    expect(runGit(cwd, ["cat-file", "-t", oid])).toBe("commit");
    // Bun's realpath currently rejects literal backslashes in valid POSIX paths;
    // run this filesystem case against the supported built Node runtime.
    const module = path.join(cwd, "git-verification.mjs");
    const build = spawnSync("bun", ["build", path.resolve("packages/core/src/git_verification.ts"), "--target=node", `--outfile=${module}`], { encoding: "utf8" });
    expect(build.status).toBe(0);
    const script = `import { verifyGitCommit } from ${JSON.stringify(module)}; console.log(JSON.stringify(verifyGitCommit(${JSON.stringify(cwd)}, ${JSON.stringify(oid)})));`;
    const node = spawnSync("node", ["--input-type=module", "-e", script], { cwd, encoding: "utf8" });
    expect(node.error).toBeUndefined(); expect(node.status).toBe(0);
    expect(JSON.parse(node.stdout).code).toBe("GIT_VERIFIED");
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
