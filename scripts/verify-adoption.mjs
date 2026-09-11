import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Exercise the installed guidance on expressly disposable fixtures, never a real consumer. */
export function verifyAdoption(binary, temporaryRoot, globalHome) {
  for (const mode of ["local", "global"]) {
    const cwd = path.join(temporaryRoot, `adoption-${mode}`); fs.mkdirSync(cwd);
    const env = { ...process.env, AGENT_MEMORY_HOME: globalHome };
    const run = (command, args) => {
      const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
      return result.stdout;
    };
    const cli = args => run(process.execPath, [binary, ...args]);
    const json = args => JSON.parse(cli([...args, "--json"]));
    run("git", ["init", "--quiet"]);
    cli(["init", "--yes", ...(mode === "local" ? ["--local"] : ["--memory-key", "adoption-selected"])]);
    const config = fs.readFileSync(path.join(cwd, "agent-memory.config.yaml"), "utf8");
    const memoryRoot = /memory_root: (.+)/.exec(config)[1].trim();
    const write = (relative, content) => { const file = path.join(cwd, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
    const canonical = `${memoryRoot}/claims/smoke.retry.md`;
    const source = "export const canRetry = (role, attempts) => role === 'owner' && attempts < 3;\n";
    write("src/retry.mjs", source); write("src/unrelated.mjs", "export const unrelated = true;\n");
    const legacy = `---\nid: smoke.retry\ntype: fact\nsystem: smoke\nstatus: current\nconfidence: medium\nseverity: normal\ntitle: Retry authority\nclaim: This interaction preserves the documented data contract and failure modes.\nsource_files: [src/unrelated.mjs]\nrelated_files: []\ntags: [smoke.retry]\nverification: [do-not-execute-stored-commands]\nlast_verified_commit: null\n---\n## Contract\nOnly the owner may retry, with fewer than three attempts.\n`;
    write(canonical, legacy);
    cli(["validate"]); cli(["compile"]);
    const beforeProbe = json(["query", "--format-version", "2", "--category", "security"]);
    assert.equal(beforeProbe.claims.length, 0);
    const beforeFiles = snapshot(cwd); const globalBefore = snapshot(globalHome);
    const plan = json(["upgrade", "--adopt-retrieval", "--format-version", "2"]);
    assert.deepEqual(plan, json(["upgrade", "--adopt-retrieval", "--format-version", "2"]));
    assert.deepEqual(snapshot(cwd), beforeFiles); assert.deepEqual(snapshot(globalHome), globalBefore);
    assert.equal(plan.adoption.mode, mode); assert.equal(plan.adoption.claims.length, 1);
    assert.deepEqual(plan.adoption.claims[0].signals.map(signal => signal.code).sort(), ["GENERIC_SUMMARY", "ID_ONLY_TAGS", "UNCATEGORIZED", "VERIFICATION_METADATA_MISSING"].sort());
    cli(["upgrade", "--adopt-retrieval", "--format-version", "2", "--write"]);
    assert.equal(fs.readFileSync(path.join(cwd, canonical), "utf8"), legacy);
    assert.deepEqual(snapshot(globalHome), globalBefore);
    const supportAfter = snapshot(cwd); cli(["upgrade", "--adopt-retrieval", "--format-version", "2", "--write"]); assert.deepEqual(snapshot(cwd), supportAfter);
    const guidance = fs.readFileSync(path.join(cwd, plan.adoption.guidance[0]), "utf8");
    assert.match(guidance, /Propose a concrete Git diff/);
    // Follow the installed workflow: complete body + eligible source inspection, reviewed explicit diff, then probes.
    cli(["compile"]);
    const shown = json(["show", "smoke.retry", "--format-version", "2", "--max-bytes", "65536"]);
    assert.match(shown.claims[0].body, /Only the owner/); assert.equal(fs.readFileSync(path.join(cwd, "src/retry.mjs"), "utf8"), source);
    run("git", ["add", "."]);
    const accepted = legacy.replace("This interaction preserves the documented data contract and failure modes.", "Only owners may retry before the three-attempt limit.").replace("source_files: [src/unrelated.mjs]", "source_files: [src/retry.mjs]").replace("tags: [smoke.retry]", "tags: [smoke.retry, 'concern:security', 'concern:reliability']");
    const reviewed = { authorization: "Disposable smoke fixture only: replace summary, tags and source association after complete fixture inspection; preserve body and verification metadata.", before: legacy, after: accepted };
    assert.equal(reviewed.after.split("---\n")[2], reviewed.before.split("---\n")[2]);
    write(canonical, reviewed.after);
    const diff = run("git", ["diff", "--", canonical]); assert.match(diff, /concern:security/); assert.match(diff, /src\/retry.mjs/);
    cli(["validate"]); cli(["compile"]);
    const afterCategory = json(["context", "--format-version", "2", "--category", "security"]);
    const afterTask = json(["context", "--format-version", "2", "--task", "owner retry"]);
    const afterFile = json(["context", "--format-version", "2", "--changed-files", "src/retry.mjs"]);
    for (const output of [afterCategory, afterTask, afterFile]) { assert.equal(output.claims[0].id, "smoke.retry"); assert.equal(output.completeness, "complete"); assert(output.commands.every(command => command.state === "suggested_not_run")); }
    assert.equal(afterFile.claims[0].evidence.tier, 1);
    const afterPlan = json(["upgrade", "--adopt-retrieval", "--format-version", "2"]);
    assert.deepEqual(afterPlan.adoption.claims[0].signals.map(signal => signal.code), ["VERIFICATION_METADATA_MISSING"]);
    assert.equal(afterPlan.adoption.claims[0].verificationCheck, "not_run");
    // Rollback is a reviewed consumer diff plus selected-cache recompilation.
    write(canonical, legacy); cli(["validate"]); cli(["compile"]);
    assert.equal(json(["query", "--format-version", "2", "--category", "security"]).claims.length, 0);
    const evidence = { mode, packageVersion: cli(["--version"]).trim(), before: { canonical: legacy, probe: beforeProbe }, plan, reviewed, diff, after: { category: afterCategory, task: afterTask, file: afterFile, plan: afterPlan }, rollback: "Original canonical restored; validate and compile passed; category no longer matches.", verification: "Stored commands not executed; no verification commit inferred." };
    if (process.env.AGENT_MEMORY_ADOPTION_EVIDENCE_DIR) { fs.mkdirSync(process.env.AGENT_MEMORY_ADOPTION_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.AGENT_MEMORY_ADOPTION_EVIDENCE_DIR, `${mode}.json`), JSON.stringify(evidence, null, 2)); }
    console.log(`Installed ${mode} adoption: inventory, support-only write, reviewed fixture diff, validate/compile/category/task/file probes and rollback passed.`);
  }
}
function snapshot(root) {
  const entries = {};
  if (!fs.existsSync(root)) return entries;
  const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { if (entry.name === ".git") continue; const file = path.join(directory, entry.name); entries[path.relative(root, file)] = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString("base64"); if (entry.isDirectory()) walk(file); } };
  walk(root); return entries;
}
