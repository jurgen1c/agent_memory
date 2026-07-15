import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentflowRunStateError,
  openAgentflowRunState
} from "../../packages/agentflow-core/src";

const FIXED_TIME = "2026-07-15T12:00:00.000Z";

describe("Agentflow run-state SQLite store", () => {
  test("creates and updates resumable runs in a repository-local database", async () => {
    const repoRoot = temporaryRepo();
    const store = await openAgentflowRunState({ cwd: path.join(repoRoot, "nested"), now: () => FIXED_TIME });

    const created = store.createRun({
      id: "run-platform-1",
      workflow: { name: "ship-release", version: 3, style: "pipeline", maturity: "trusted" },
      inputs: { environment: "staging", nested: { b: 2, a: 1 } }
    });

    expect(store.databasePath).toBe(path.join(repoRoot, ".agentflow/agentflow.sqlite"));
    expect(created).toMatchObject({
      id: "run-platform-1",
      status: "pending",
      workflowName: "ship-release",
      workflowVersion: 3,
      currentStepId: null,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME
    });

    const updated = store.updateRun("run-platform-1", { status: "running", currentStepId: "build" });
    expect(updated).toMatchObject({ status: "running", currentStepId: "build", startedAt: FIXED_TIME, finishedAt: null });
    expect(store.findResumableRun({ workflowName: "ship-release" })?.id).toBe("run-platform-1");

    store.close();
    expect(fs.existsSync(path.join(repoRoot, ".agent-memory/memory.sqlite"))).toBe(false);
  });

  test("stores pipeline, recovery, and collaboration state families", async () => {
    const repoRoot = temporaryRepo();
    const store = await openAgentflowRunState({ cwd: repoRoot, now: () => FIXED_TIME });

    store.createRun({
      id: "run-parent",
      workflow: { name: "review", version: 1, style: "collaborative", maturity: "stable" }
    });
    store.createRun({
      id: "run-recovery",
      workflow: { name: "recover", version: 2, style: "recovery_pipeline", maturity: "experimental" },
      parentRunId: "run-parent",
      recoveryOfRunId: "run-parent"
    });
    store.upsertStep({ runId: "run-recovery", stepId: "diagnose", attempt: 1, status: "running", sessionId: "reviewer" });
    store.upsertArtifact({
      id: "failure-report",
      runId: "run-recovery",
      stepId: "diagnose",
      path: "failures/report.json",
      kind: "failure",
      contentType: "application/json",
      checksum: "sha256:fixture",
      metadata: { private: true }
    });
    store.appendEvent({
      id: "event-1",
      runId: "run-recovery",
      sequence: 1,
      stepId: "diagnose",
      type: "step.started",
      payload: { attempt: 1 }
    });
    store.upsertSession({
      id: "reviewer",
      runId: "run-recovery",
      provider: "codex",
      status: "running",
      externalSessionId: "session-external-1",
      state: { role: "reviewer" }
    });
    store.recordFailure({
      id: "failure-1",
      runId: "run-recovery",
      stepId: "diagnose",
      classification: "test_failure",
      message: "Focused test failed",
      retryable: true,
      payload: { exitCode: 1 }
    });
    store.upsertApproval({
      id: "approval-1",
      runId: "run-recovery",
      stepId: "diagnose",
      status: "requested",
      requestedBy: "reviewer",
      context: { reason: "publish" }
    });
    store.upsertBudget({
      id: "budget-1",
      runId: "run-recovery",
      scope: "run",
      kind: "tokens",
      limit: 10_000,
      used: 2_500,
      unit: "tokens"
    });

    store.upsertStep({ runId: "run-recovery", stepId: "diagnose", attempt: 1, status: "completed", sessionId: "reviewer" });
    store.upsertBudget({
      id: "budget-1",
      runId: "run-recovery",
      scope: "run",
      kind: "tokens",
      limit: 10_000,
      used: 3_000,
      unit: "tokens"
    });

    const database = new Database(store.databasePath, { readonly: true });
    for (const table of ["runs", "run_steps", "artifacts", "events", "sessions", "failures", "approvals", "budgets"]) {
      expect(database.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: table === "runs" ? 2 : 1 });
    }
    expect(database.query("SELECT status FROM run_steps WHERE run_id = ? AND step_id = ?").get("run-recovery", "diagnose")).toEqual({ status: "completed" });
    expect(database.query("SELECT used FROM budgets WHERE run_id = ? AND id = ?").get("run-recovery", "budget-1")).toEqual({ used: 3000 });
    database.close();
    store.close();
  });

  test("excludes terminal runs from resume lookup and prevents terminal reopening", async () => {
    const repoRoot = temporaryRepo();
    const store = await openAgentflowRunState({ cwd: repoRoot, now: () => FIXED_TIME });

    for (const status of ["completed", "failed", "cancelled"] as const) {
      const id = `run-${status}`;
      store.createRun({ id, workflow: { name: "terminal", version: 1, style: "pipeline", maturity: "stable" } });
      const terminal = store.updateRun(id, { status });
      expect(terminal.finishedAt).toBe(FIXED_TIME);
      expect(store.findResumableRun({ workflowName: "terminal" })).toBeNull();
      expect(() => store.updateRun(id, { status: "running" })).toThrow(AgentflowRunStateError);
    }

    store.close();
  });

  test("rejects collisions, invalid artifacts, and database paths outside the repository", async () => {
    const repoRoot = temporaryRepo();
    const store = await openAgentflowRunState({ cwd: repoRoot, now: () => FIXED_TIME });
    const run = { id: "run-1", workflow: { name: "safe", version: 1, style: "pipeline", maturity: "stable" } } as const;
    store.createRun(run);

    expect(() => store.createRun(run)).toThrow(/already exists/);
    expect(() => store.upsertArtifact({
      id: "bad",
      runId: "run-1",
      path: "../outside.txt",
      kind: "output",
      contentType: "text/plain"
    })).toThrow(/repo-relative/);
    store.close();

    await expect(openAgentflowRunState({ cwd: repoRoot, databasePath: path.join(os.tmpdir(), "outside-agentflow.sqlite") }))
      .rejects.toThrow(/inside the repository/);
  });
});

function temporaryRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-run-state-"));
  fs.mkdirSync(path.join(repoRoot, ".git"));
  fs.mkdirSync(path.join(repoRoot, "nested"));
  return repoRoot;
}
