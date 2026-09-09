/** Offline evidence runner. Optional installed bundle is only run in a temporary fixture repo. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { dispatch } from "../../../packages/cli/src/router";
import { corpus, requiredIds, tasks } from "./corpus";
import { caps, retrieve, type Request } from "./prototype";

const requests: Record<string, Request> = {
  full: { task: tasks.full }, short: { task: tasks.short },
  files: { files: ["src/receipts-controller.ts", "src/diagnostics-controller.ts"] },
  taskFiles: { task: tasks.full, files: ["src/receipts-controller.ts", "src/diagnostics-controller.ts"] },
  body: { task: "actor_user_id" }, negative: { task: "zzzauditnohitxyz", maxBytes: caps.small }, heldOut: { task: tasks.heldOut }
};
const report: Record<string, unknown> = { prototype: [], current: [], installed: [] };
for (const variant of ["original", "corrected"] as const) {
  for (const [name, request] of Object.entries(requests)) {
    const started = performance.now();
    const result = retrieve(corpus(variant), request, ["src/"]);
    (report.prototype as unknown[]).push({ variant, name, expected: name === "heldOut" ? ["identity.rotation", "identity.overlap"] : ["full", "short", "files", "taskFiles"].includes(name) ? requiredIds : [],
      ids: result.claims.map(claim => claim.id), referenceHits: requiredIds.filter(id => result.claims.some(claim => claim.id === id)).length,
      top: result.claims[0]?.id ?? null, bytes: result.budget.usedBytes, completeness: result.completeness, elapsedMs: +(performance.now() - started).toFixed(3) });
  }
}
const installed = process.argv[2];
if (installed) report.installedBundle = { sha256: createHash("sha256").update(fs.readFileSync(installed)).digest("hex") };
for (const variant of ["original", "corrected"] as const) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "am88-probe-"));
  try {
    fs.writeFileSync(path.join(cwd, "agent-memory.config.yaml"), "version: 1\nmemory_root: docs/agent-memory\ndatabase_path: .agent-memory/memory.sqlite\nclaims: [claims/**/*.md]\ngraphs: [graph/**/*.yaml]\nindexes: [indexes/**/*.yaml]\nrecipes: [recipes/**/*.yaml]\n");
    const claims = corpus(variant);
    fs.mkdirSync(path.join(cwd, "docs/agent-memory/claims"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "docs/agent-memory/graph"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "docs/agent-memory/indexes"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    for (const claim of claims) {
      const { body, sourcePath: _sourcePath, requires: _requires, ...metadata } = claim;
      fs.writeFileSync(path.join(cwd, "docs/agent-memory/claims", claim.id + ".md"), `---\n${stringify(metadata)}\n---\n${body}`);
      for (const file of claim.source_files) fs.writeFileSync(path.join(cwd, file), "// Sanitized evidence placeholder, not proof of semantics.\n");
    }
    fs.writeFileSync(path.join(cwd, "docs/agent-memory/indexes/all.yaml"), JSON.stringify({ id: "all", name: "Broad index", watched_files: ["src/**"], claim_globs: ["claims/**/*.md"] }));
    fs.writeFileSync(path.join(cwd, "docs/agent-memory/graph/required.yaml"), JSON.stringify({ id: "required", name: "Required guidance", edges: claims.flatMap(claim => claim.requires.map(target => ({ source: claim.id, target, relation: "requires", reason: "Authored fixture dependency" }))) }));
    for (const runner of ["current", ...(installed ? ["installed"] : [])]) {
      const run = async (args: string[]) => {
        if (runner === "current") {
          try {
            const result = await dispatch(args, { cwd });
            return { ...result, stdout: result.stdout ?? "" };
          } catch (error) { return { exitCode: 1, stdout: String(error) }; }
        }
        const result = spawnSync("node", [installed!, ...args], { cwd, encoding: "utf8", env: process.env });
        if (result.error) throw result.error;
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
      };
      const compile = await run(["compile"]);
      if (compile.exitCode !== 0) throw new Error(`${runner} fixture compile: ${JSON.stringify(compile)}`);
      for (const [name, request] of Object.entries(requests)) {
        const args = ["context", "--json", "--budget", name === "negative" ? "small" : "medium"];
        if (request.task) args.push("--task", request.task);
        if (request.files) args.push("--changed-files", request.files.join(","));
        const start = performance.now();
        const result = await run(args);
        if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
        if (!result.stdout.trim()) throw new Error(JSON.stringify({ runner, args, result }));
        const parsed = JSON.parse(result.stdout);
        const ids = [...new Set<string>([...parsed.matchedClaims.map((claim: { id: string }) => claim.id), ...parsed.relatedClaims.map((row: { claim: { id: string } }) => row.claim.id)])];
        (report[runner] as unknown[]).push({ variant, name, args, exitCode: result.exitCode, ids, referenceHits: requiredIds.filter(id => ids.includes(id)).length,
          top: parsed.matchedClaims[0]?.id ?? null, bytes: Buffer.byteLength(result.stdout), files: parsed.relevantFiles.length, commands: parsed.verificationSteps.length,
          warnings: parsed.warnings, elapsedMs: +(performance.now() - start).toFixed(3) });
      }
      for (const args of [["query", "--category", "security", "--json"], ["query", "--system", "accounts", "--json"], ["query", "actor_user_id", "--json"], ["show", "accounts.receipt_retry", "--json"]]) {
        const result = await run(args);
        (report[runner] as unknown[]).push({ variant, args, exitCode: result.exitCode, hasContractBody: result.stdout.includes("actor_user_id(owner|admin)"), ...(args[0] === "show" ? {} : { stdout: result.stdout.replaceAll(cwd, "<fixture>") }) });
      }
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
console.log(JSON.stringify(report, null, 2));
