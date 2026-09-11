import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { planRetrievalAdoption, applyRetrievalAdoption, compileMemory } from "../../packages/core/src/index";
import { dispatch } from "../../packages/cli/src/router";
import { productionFixture, claimPath } from "../fixtures/category-retrieval/production";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = productionFixture("original"); roots.push(root); return root; }
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === ".git") continue; const file = path.join(dir, entry.name); result[path.relative(root, file)] = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString("base64"); if (entry.isDirectory()) walk(file); } }
  walk(root); return result;
}

describe("retrieval adoption", () => {
  test("deterministic advisory inventory and complete dry-run leave all files unchanged", async () => {
    const cwd = fixture(); const before = tree(cwd);
    const plan = planRetrievalAdoption({ cwd });
    expect(plan).toEqual(planRetrievalAdoption({ cwd }));
    expect(tree(cwd)).toEqual(before);
    expect(plan.adoption.claims.find(claim => claim.id === "accounts.receipt_retry")?.signals.map(signal => signal.code)).toEqual(expect.arrayContaining(["ID_ONLY_TAGS", "UNCATEGORIZED", "GENERIC_SUMMARY", "VERIFICATION_METADATA_MISSING"]));
    expect(plan.adoption.claims.every(claim => claim.verificationCheck === "not_run")).toBe(true);
    const cli = await dispatch(["upgrade", "--adopt-retrieval", "--format-version", "2", "--json"], { cwd });
    expect(cli.exitCode).toBe(0); expect(JSON.parse(cli.stdout!)).toEqual(plan); expect(tree(cwd)).toEqual(before);
  });
  test("write only updates support, keeps canonical bytes and becomes idempotent", () => {
    const cwd = fixture(); const before = tree(path.join(cwd, "docs/agent-memory"));
    const result = applyRetrievalAdoption(planRetrievalAdoption({ cwd }));
    expect(result.write).toBe(true);
    for (const [file, bytes] of Object.entries(before)) expect(tree(path.join(cwd, "docs/agent-memory"))[file]).toBe(bytes);
    const after = tree(cwd);
    const second = applyRetrievalAdoption(planRetrievalAdoption({ cwd }));
    expect(second.actions.every(action => action.status === "skipped")).toBe(true); expect(tree(cwd)).toEqual(after);
    for (const guide of result.adoption.guidance) expect(fs.readFileSync(path.join(cwd, guide), "utf8")).toContain("Propose a concrete Git diff");
  });
  test("custom references survive default writes and are explicitly forceable", () => {
    const cwd = fixture(); applyRetrievalAdoption(planRetrievalAdoption({ cwd }));
    const plan = planRetrievalAdoption({ cwd }); const guide = path.join(cwd, plan.adoption.guidance[0]);
    fs.writeFileSync(guide, "Custom reviewed instructions\n");
    applyRetrievalAdoption(planRetrievalAdoption({ cwd })); expect(fs.readFileSync(guide, "utf8")).toBe("Custom reviewed instructions\n");
    applyRetrievalAdoption(planRetrievalAdoption({ cwd, force: true })); expect(fs.readFileSync(guide, "utf8")).toContain("generated-reference");
  });
  test.each(["canonical", "support", "new canonical"])("stale %s rejects the complete write set", (kind) => {
    const cwd = fixture(); const plan = planRetrievalAdoption({ cwd });
    if (kind === "canonical") fs.appendFileSync(claimPath(cwd, "accounts.receipt_retry"), "\nA reviewed edit.\n");
    else if (kind === "support") fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Changed support\n");
    else fs.copyFileSync(claimPath(cwd, "accounts.receipt_retry"), claimPath(cwd, "new.duplicate"));
    const before = tree(cwd); expect(() => applyRetrievalAdoption(plan)).toThrow("Adoption inputs changed"); expect(tree(cwd)).toEqual(before);
  });
  test.each(["symlink", "duplicate", "invalid", "unsafe support", "late directory", "canonical output", "new canonical output"])("%s fails preflight without partial writes", async kind => {
    const cwd = fixture();
    if (kind === "symlink") fs.symlinkSync(claimPath(cwd, "accounts.receipt_retry"), path.join(cwd, "docs/agent-memory/claims/link.md"));
    if (kind === "duplicate") fs.copyFileSync(claimPath(cwd, "accounts.receipt_retry"), claimPath(cwd, "new.duplicate"));
    if (kind === "invalid") fs.appendFileSync(path.join(cwd, "agent-memory.config.yaml"), "category_vocabulary: { security: bad }\n");
    if (kind === "unsafe support") fs.symlinkSync(path.join(cwd, "src"), path.join(cwd, ".codex"));
    if (kind === "late directory") fs.mkdirSync(path.join(cwd, ".codex/skills/repo-memory/references/claims.md"), { recursive: true });
    if (kind === "canonical output") fs.appendFileSync(path.join(cwd, "agent-memory.config.yaml"), "agent_instructions:\n  paths: [docs/agent-memory/claims/accounts.receipt_retry.md]\n");
    if (kind === "new canonical output") fs.appendFileSync(path.join(cwd, "agent-memory.config.yaml"), "agent_instructions:\n  paths: [docs/agent-memory/claims/new-support.md]\n");
    const before = tree(cwd); const result = await dispatch(["upgrade", "--adopt-retrieval", "--format-version", "2", "--write", "--force", "--json"], { cwd });
    expect(result.exitCode).toBe(4); expect(tree(cwd)).toEqual(before);
  });
  test("late write failure restores earlier files and created directories", () => {
    const cwd = fixture(); const plan = planRetrievalAdoption({ cwd }); const before = tree(cwd);
    const write = fs.writeFileSync; let failed = false;
    const mock = spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      if (!failed && String(file).endsWith("references/claims.md")) { failed = true; throw new Error("injected write failure"); }
      return write(file, ...args);
    });
    try { expect(() => applyRetrievalAdoption(plan)).toThrow("original files restored"); } finally { mock.mockRestore(); }
    expect(failed).toBe(true); expect(tree(cwd)).toEqual(before);
  });
  test("incompatible flags fail before loading a repo and v1 shape stays unchanged", async () => {
    expect((await dispatch(["upgrade", "--adopt-retrieval", "--global", "--format-version", "2", "--json"])).stdout).toContain("INCOMPATIBLE_OPTIONS");
    expect((await dispatch(["upgrade", "--adopt-retrieval", "--json"])).stdout).toContain("FORMAT_VERSION_REQUIRED");
    const cwd = fixture(); expect(JSON.parse((await dispatch(["upgrade", "--json"], { cwd })).stdout!).schemaVersion).toBeUndefined();
  });
  test("two global registrations and personal memory remain byte-identical during selected adoption", async () => {
    const cwd = fixture(); const other = fixture(); const home = path.join(other, "global-home"); const prior = process.env.AGENT_MEMORY_HOME; process.env.AGENT_MEMORY_HOME = home;
    try {
      for (const [root, key] of [[cwd, "selected"], [other, "unrelated"]]) {
        const config = path.join(root, "agent-memory.config.yaml"); fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("version: 1", `version: 2\ndatabase_scope: global\nmemory_key: ${key}`)); await compileMemory({ cwd: root });
      }
      fs.writeFileSync(path.join(home, "personal.md"), "Do not scan personal memory\n"); const before = tree(home); const unrelated = tree(other);
      const plan = planRetrievalAdoption({ cwd }); expect(plan.adoption.memoryKey).toBe("selected"); expect(plan.adoption.mode).toBe("global"); expect(tree(home)).toEqual(before);
      applyRetrievalAdoption(plan); expect(tree(home)).toEqual(before); expect(tree(other)).toEqual(unrelated);
    } finally { if (prior === undefined) delete process.env.AGENT_MEMORY_HOME; else process.env.AGENT_MEMORY_HOME = prior; }
  });
});

test("disabled custom skill locations are preserved without inspecting unrelated paths", () => {
  const cwd = fixture();
  fs.appendFileSync(path.join(cwd, "agent-memory.config.yaml"), "agent_skills:\n  generic:\n    enabled: false\n    path: /unrelated-disabled-skill/SKILL.md\n");
  const before = tree(cwd); const plan = planRetrievalAdoption({ cwd }); expect(tree(cwd)).toEqual(before);
  expect(plan.actions).toContainEqual({ path: "/unrelated-disabled-skill/SKILL.md", status: "skipped", detail: "generic skill disabled in config" });
  applyRetrievalAdoption(plan); expect(plan.adoption.guidance.every(file => !file.includes("unrelated-disabled-skill"))).toBe(true);
});

test("checkout-root memory preserves unrelated symlinks and rejects canonical symlinks", async () => {
  const cwd = fixture(); const config = path.join(cwd, "agent-memory.config.yaml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("memory_root: docs/agent-memory", "memory_root: .").replaceAll("[claims/", "[docs/agent-memory/claims/").replaceAll("[graph/", "[docs/agent-memory/graph/").replaceAll("[indexes/", "[docs/agent-memory/indexes/").replaceAll("[recipes/", "[docs/agent-memory/recipes/"));
  fs.symlinkSync(path.join(cwd, "src"), path.join(cwd, "unrelated-source-link"));
  await compileMemory({ cwd });
  const before = tree(cwd); const canonical = tree(path.join(cwd, "docs/agent-memory"));
  const plan = planRetrievalAdoption({ cwd }); expect(tree(cwd)).toEqual(before);
  expect(plan.adoption.claims.length).toBeGreaterThan(0); applyRetrievalAdoption(plan);
  const after = tree(path.join(cwd, "docs/agent-memory"));
  for (const [file, bytes] of Object.entries(canonical)) expect(after[file]).toBe(bytes);
  fs.symlinkSync(claimPath(cwd, "accounts.receipt_retry"), path.join(cwd, "docs/agent-memory/claims/link.md"));
  expect(() => planRetrievalAdoption({ cwd })).toThrow("Unsafe adoption path");
});
