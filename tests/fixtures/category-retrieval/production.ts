import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { corpus } from "./corpus";

/** Sanitized fixture data only; all compilation and selection use exported production APIs. */
export function productionFixture(variant: "original" | "corrected" = "corrected"): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "am91-production-"));
  const git = spawnSync("git", ["init", "--quiet", cwd]);
  if (git.status !== 0) throw new Error("Could not initialize fixture repository.");
  fs.writeFileSync(path.join(cwd, "agent-memory.config.yaml"), "version: 1\nmemory_root: docs/agent-memory\ndatabase_path: .agent-memory/memory.sqlite\nclaims: [claims/**/*.md]\ngraphs: [graph/**/*.yaml]\nindexes: [indexes/**/*.yaml]\nrecipes: [recipes/**/*.yaml]\n");
  for (const directory of ["claims", "graph", "indexes"]) fs.mkdirSync(path.join(cwd, "docs/agent-memory", directory), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"));
  const claims = corpus(variant);
  for (const claim of claims) {
    const { body, sourcePath: _sourcePath, requires: _requires, ...metadata } = claim;
    fs.writeFileSync(claimPath(cwd, claim.id), `---\n${stringify(metadata)}---\n${body}`);
    for (const file of claim.source_files) fs.writeFileSync(path.join(cwd, file), "// Authored association fixture; not semantic proof.\n");
  }
  fs.writeFileSync(path.join(cwd, "docs/agent-memory/indexes/all.yaml"), stringify({ id: "all", name: "Broad index", watched_files: ["src/**"], claim_globs: ["claims/**/*.md"] }));
  fs.writeFileSync(path.join(cwd, "docs/agent-memory/graph/required.yaml"), stringify({ id: "required", name: "Authored required guidance", edges: claims.flatMap(claim => claim.requires.map(target => ({ source: claim.id, target, relation: "requires", reason: "Authored fixture dependency" }))) }));
  return cwd;
}
export const claimPath = (cwd: string, id: string) => path.join(cwd, "docs/agent-memory/claims", `${id}.md`);
