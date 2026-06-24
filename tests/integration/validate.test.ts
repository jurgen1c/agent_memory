import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../../packages/cli/src/router";

const repoRoot = path.resolve(".");
const validFixture = path.join(repoRoot, "tests/fixtures/valid_repo");
const invalidFixture = path.join(repoRoot, "tests/fixtures/invalid_repo");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("validate command", () => {
  test("passes a valid fixture repository", async () => {
    const result = await dispatch(["validate"], { cwd: copyFixture(validFixture) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("validation passed");
    expect(result.stdout).toContain("Claims: 1");
  });

  test("passes the mock app repository", async () => {
    const result = await dispatch(["validate"], { cwd: copyFixture(mockApp) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Claims: 2");
    expect(result.stdout).toContain("Graphs: 1");
    expect(result.stdout).toContain("Recipes: 1");
  });

  test("fails invalid fixtures with actionable messages", async () => {
    const result = await dispatch(["validate"], { cwd: copyFixture(invalidFixture) });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("validation failed");
    expect(result.stdout).toContain("claim.source_files.missing");
    expect(result.stdout).toContain("graph.edge.missing_claim");
    expect(result.stdout).toContain("recipe.required_claim.missing");
    expect(result.stdout).toContain("claim.id.duplicate");
    expect(result.stdout).toContain("claim.atomic.numbered_headings");
  });

  test("supports JSON output", async () => {
    const result = await dispatch(["validate", "--json"], { cwd: copyFixture(invalidFixture) });

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.some((issue: { code: string }) => issue.code === "graph.edge.missing_claim")).toBe(true);
  });
});

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-validate-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}
