import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";
import { loadConfig } from "../../packages/core/src/config";
import { applyRetrievalAdoption, planRetrievalAdoption, compileMemory, upgradeRepository } from "../../packages/core/src/index";
import { productionFixture, claimPath } from "../fixtures/category-retrieval/production";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const cwd = productionFixture(); roots.push(cwd); return cwd; }
function configPath(cwd: string) { return path.join(cwd, "agent-memory.config.yaml"); }
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.parentPath.includes(`${path.sep}.git`))
    .map(entry => { const file = path.join(entry.parentPath, entry.name); return [path.relative(root, file), fs.readFileSync(file).toString("base64")]; }));
}
const adoption = ["upgrade", "--adopt-retrieval", "--format-version", "2"];

test.each([true, false])("fresh init selects v2 independently of local storage=%s; repeat init preserves it", async local => {
  const cwd = fixture(); fs.unlinkSync(configPath(cwd));
  const args = ["init", "--yes", ...(local ? ["--local"] : ["--memory-key", "default-smoke"])];
  expect((await dispatch(args, { cwd })).exitCode).toBe(0);
  expect(loadConfig({ cwd }).config.retrieval?.default_format_version).toBe(2);
  const before = fs.readFileSync(configPath(cwd), "utf8");
  await dispatch(args, { cwd }); expect(fs.readFileSync(configPath(cwd), "utf8")).toBe(before);
  expect(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8")).toContain("default to format 2");
});

test("existing apps and ordinary upgrade/init retain v1, including explicit v1 selection", async () => {
  const cwd = fixture(); await compileMemory({ cwd });
  expect(loadConfig({ cwd }).config.retrieval?.default_format_version).toBe(1);
  expect(JSON.parse((await dispatch(["query", "retry", "--json"], { cwd })).stdout!).schemaVersion).toBeUndefined();
  upgradeRepository({ cwd, write: true, force: false });
  await dispatch(["init", "--yes", "--force"], { cwd });
  expect(loadConfig({ cwd }).config.retrieval?.default_format_version).toBe(1);
  const result = await dispatch(["query", "--category", "security", "--json"], { cwd });
  expect(result.exitCode).toBe(2); expect(result.stdout).toContain("FORMAT_VERSION_REQUIRED");
});

test("migration previews without writes, applies only support/defaults, overrides and rollback work", async () => {
  const cwd = fixture(); await compileMemory({ cwd });
  const claim = claimPath(cwd, "accounts.receipt_retry"); const original = fs.readFileSync(claim);
  const before = snapshot(cwd);
  const preview = await dispatch([...adoption, "--default-format-version", "2", "--json"], { cwd });
  expect(preview.exitCode).toBe(0);
  const human = await dispatch([...adoption, "--default-format-version", "2"], { cwd });
  expect(human.stdout).toContain("CLI default: 1 -> 2");
  expect(human.stdout).toContain("--default-format-version 2 --write");
  expect(human.stdout).not.toContain("\n  agent-memory upgrade --write\n");
  expect(JSON.parse(preview.stdout!).adoption.defaultFormatVersion).toEqual({ before: 1, after: 2 });
  expect(snapshot(cwd)).toEqual(before);
  expect((await dispatch([...adoption, "--default-format-version", "2", "--write"], { cwd })).exitCode).toBe(0);
  expect(fs.readFileSync(claim)).toEqual(original);
  const stale = await dispatch(["query", "retry", "--json"], { cwd });
  expect(stale.exitCode).toBe(5); expect(stale.stdout).toContain("CACHE_STALE");
  await compileMemory({ cwd });
  for (const args of [["query", "retry"], ["context", "--task", "retry"], ["show", "accounts.receipt_retry"], ["audit"]]) {
    const result = await dispatch([...args, "--json"], { cwd });
    expect(JSON.parse(result.stdout!).schemaVersion).toBe(2);
  }
  expect(JSON.parse((await dispatch(["query", "retry", "--format-version=1", "--json"], { cwd })).stdout!).schemaVersion).toBeUndefined();
  const manifest = JSON.parse((await dispatch(["agent-manifest", "--json"], { cwd })).stdout!);
  expect(manifest.capabilities.retrieval_defaults.format_version).toBe(2);
  expect(fs.readFileSync(path.join(cwd, ".codex/skills/repo-memory/SKILL.md"), "utf8")).toContain("default to format 2");
  const current = snapshot(cwd);
  applyRetrievalAdoption(planRetrievalAdoption({ cwd, defaultFormatVersion: 2 }));
  expect(snapshot(cwd)).toEqual(current);
  applyRetrievalAdoption(planRetrievalAdoption({ cwd, defaultFormatVersion: 1 }));
  await compileMemory({ cwd });
  expect(JSON.parse((await dispatch(["query", "retry", "--json"], { cwd })).stdout!).schemaVersion).toBeUndefined();
  expect(JSON.parse((await dispatch(["query", "retry", "--format-version=2", "--json"], { cwd })).stdout!).schemaVersion).toBe(2);
  expect(fs.readFileSync(claim)).toEqual(original);
});

test("migration preserves unknown configuration/custom guidance and rejects a stale saved plan", () => {
  const cwd = fixture();
  fs.appendFileSync(configPath(cwd), "\nretrieval:\n  default_format_version: 1\n  custom_setting: retained\ncustom_root: retained\n");
  const plan = planRetrievalAdoption({ cwd, defaultFormatVersion: 2 });
  applyRetrievalAdoption(plan);
  expect(fs.readFileSync(configPath(cwd), "utf8")).toContain("custom_setting: retained");
  expect(fs.readFileSync(configPath(cwd), "utf8")).toContain("custom_root: retained");
  expect(loadConfig({ cwd }).config.retrieval?.default_format_version).toBe(2);
  const guide = path.join(cwd, plan.adoption.guidance[0]); fs.writeFileSync(guide, "Custom instructions\n");
  const next = planRetrievalAdoption({ cwd, defaultFormatVersion: 1 });
  fs.appendFileSync(configPath(cwd), "\n# changed\n"); const before = snapshot(cwd);
  expect(() => applyRetrievalAdoption(next)).toThrow("Adoption inputs changed"); expect(snapshot(cwd)).toEqual(before);
  applyRetrievalAdoption(planRetrievalAdoption({ cwd, defaultFormatVersion: 1 }));
  expect(fs.readFileSync(guide, "utf8")).toBe("Custom instructions\n");
});

test.each(["3", "2.5", "true", "\"2\"", "null"])("invalid configured default %s is rejected", value => {
  const cwd = fixture(); fs.appendFileSync(configPath(cwd), `\nretrieval:\n  default_format_version: ${value}\n`);
  expect(() => loadConfig({ cwd })).toThrow("default_format_version must be 1 or 2");
});

test("default migration flags are strict and do not accidentally migrate storage", async () => {
  const cwd = fixture(); const before = snapshot(cwd);
  expect((await dispatch(["upgrade", "--help"], { cwd })).stdout).toContain("--default-format-version");
  for (const args of [["upgrade", "--default-format-version", "2"], [...adoption, "--default-format-version", "3"], [...adoption, "--default-format-version", "2", "--default-format-version", "1"], [...adoption, "--default-format-version", "2", "--global"]]) {
    expect((await dispatch(args, { cwd })).exitCode).toBe(2);
  }
  expect(snapshot(cwd)).toEqual(before);
});
