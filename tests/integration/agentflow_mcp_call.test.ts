import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentflowFixtureMcpAdapter,
  createAgentflowLifecycleRun,
  createAgentflowMcpCallRegistry,
  executeAgentflowCommandPipeline,
  MAX_AGENTFLOW_MCP_METADATA_BYTES,
  openAgentflowRunState,
  parseAgentflowSimulationFixture,
  parseAgentflowWorkflowOrThrow,
  simulateAgentflowWorkflow,
  transitionAgentflowLifecycleRun,
  validateAgentflowWorkflow,
  type AgentflowMcpCallRequest
} from "../../packages/agentflow-core/src";

const repoRoot = path.resolve(".");
const examplePath = path.join(repoRoot, "agentflow-examples/agentflow-examples/workflows/jira-ticket-spec.yml");
const fixturePath = path.join(repoRoot, "tests/fixtures/agentflow/simulation/jira-ticket.json");

describe("Agentflow MCP call steps", () => {
  test("requires server, tool, arguments, and declared outputs", () => {
    const workflow = parseAgentflowWorkflowOrThrow(`name: invalid-mcp-contract
version: 1
style: pipeline
maturity: experimental
steps:
  - { id: missing, type: mcp_call }
`);

    expect(validateAgentflowWorkflow(workflow).errors.map((issue) => issue.code)).toEqual([
      "workflow.step.field.required",
      "workflow.step.field.required",
      "workflow.step.field.required",
      "workflow.step.field.required"
    ]);
  });

  test("classifies externally persisted contract failures as rejected MCP policy", async () => {
    const root = temporaryRepo();
    const workflow = parseAgentflowWorkflowOrThrow(`name: rejected-mcp-contract
version: 1
style: pipeline
maturity: experimental
steps:
  - { id: fetch, type: mcp_call, server: fixture, tool: fetch, arguments: {} }
`);
    const store = await openAgentflowRunState({ cwd: root });
    store.createRunWithEvent({
      id: "rejected-contract",
      workflow: {
        name: workflow.name,
        version: workflow.version,
        style: workflow.style,
        maturity: workflow.maturity
      },
      context: { workflow: workflow as never }
    }, { type: "run.created", payload: { status: "pending" } });
    const classifications: string[] = [];
    const recordFailure = store.recordFailure.bind(store);
    store.recordFailure = (input) => {
      classifications.push(input.classification);
      recordFailure(input);
    };

    const result = await executeAgentflowCommandPipeline(store, "rejected-contract", workflow);

    expect(result).toMatchObject({ status: "failed", failedStep: "fetch" });
    expect(classifications).toEqual(["mcp_call_policy"]);
    expect(store.listEvents("rejected-contract").map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "step.rejected",
      "run.failed"
    ]);
    store.close();
  });

  test("rejects malformed, duplicate, and dynamic output declarations", () => {
    const workflow = parseAgentflowWorkflowOrThrow(`name: invalid-mcp-outputs
version: 1
style: pipeline
maturity: experimental
steps:
  - id: fetch
    type: mcp_call
    server: fixture
    tool: fetch
    arguments: {}
    outputs: [ticket.json, ticket.json, ../outside.json, "{{ inputs.output }}"]
`);

    expect(validateAgentflowWorkflow(workflow).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "workflow.mcp_call.output.duplicate", path: "steps[0].outputs[1]" }),
      expect.objectContaining({ code: "workflow.mcp_call.output.invalid", path: "steps[0].outputs[2]" }),
      expect.objectContaining({ code: "workflow.mcp_call.output.invalid", path: "steps[0].outputs[3]" })
    ]));
  });

  test("validates and simulates jira-ticket-spec with fixture-only MCP output", () => {
    const workflow = parseAgentflowWorkflowOrThrow(fs.readFileSync(examplePath, "utf8"));
    const fixtureResult = parseAgentflowSimulationFixture(fs.readFileSync(fixturePath, "utf8"));
    if (!fixtureResult.ok) throw new Error(fixtureResult.error);

    expect(validateAgentflowWorkflow(workflow)).toEqual({ valid: true, errors: [] });
    const result = simulateAgentflowWorkflow(workflow, fixtureResult.fixture);

    expect(result).toMatchObject({ status: "completed" });
    expect(result.availableArtifacts).toEqual(["spec.md", "ticket.json", "ticket.md"]);
    expect(result.artifactValues["ticket.json"]).toMatchObject({ key: "AM-24" });
  });

  test("routes resolved arguments through an adapter and persists request metadata plus outputs", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, {
      id: "mcp-run",
      workflow,
      inputs: { ticket_key: "AM-26" }
    });
    const requests: AgentflowMcpCallRequest[] = [];
    const calls = createAgentflowMcpCallRegistry().register("fixture", (request) => {
      requests.push(request);
      return {
        outputs: { "ticket.json": { key: request.arguments.key, fields: { summary: "MCP contract" } } },
        metadata: { fixture: true, requestId: "fixture-1" }
      };
    });

    const result = await executeAgentflowCommandPipeline(store, "mcp-run", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "completed", completedSteps: ["fetch"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      stepId: "fetch",
      server: "fixture",
      tool: "get_issue",
      arguments: { key: "AM-26" },
      outputs: ["ticket.json"]
    });
    expect(JSON.parse(store.readArtifact("mcp-run", "ticket.json").content.toString())).toMatchObject({
      key: "AM-26",
      fields: { summary: "MCP contract" }
    });
    const requestArtifact = store.listArtifacts("mcp-run").find((artifact) => artifact.kind === "mcp_request")!;
    expect(JSON.parse(store.readArtifact("mcp-run", requestArtifact.declaredPath).content.toString())).toMatchObject({
      stepId: "fetch",
      server: "fixture",
      tool: "get_issue",
      arguments: { key: "AM-26" },
      outputs: ["ticket.json"],
      responseMetadata: { fixture: true, requestId: "fixture-1" }
    });
    expect(store.listEvents("mcp-run").map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "step.started",
      "step.completed",
      "run.completed"
    ]);
    store.close();
  });

  test("snapshots resolved arguments before giving the adapter a mutable request", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "mutable-request", workflow, inputs: { ticket_key: "AM-26" } });
    const calls = createAgentflowMcpCallRegistry().register("fixture", (request) => {
      request.arguments.key = "rewritten";
      return { outputs: { "ticket.json": { key: "AM-26" } } };
    });

    const result = await executeAgentflowCommandPipeline(store, "mutable-request", workflow, undefined, undefined, calls);

    expect(result.status).toBe("completed");
    const requestArtifact = store.listArtifacts("mutable-request").find((artifact) => artifact.kind === "mcp_request")!;
    expect(JSON.parse(store.readArtifact("mutable-request", requestArtifact.declaredPath).content.toString()).arguments)
      .toEqual({ key: "AM-26" });
    store.close();
  });

  test("preserves JSON objects shaped like content metadata without treating them as wrappers", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "content-shaped-json", workflow, inputs: { ticket_key: "AM-26" } });
    const calls = createAgentflowMcpCallRegistry().register("fixture", () => ({
      outputs: { "ticket.json": { content: "body", contentType: "record-type" } },
      contentTypes: { "ticket.json": "application/vnd.agentflow.test+json" }
    }));

    const result = await executeAgentflowCommandPipeline(store, "content-shaped-json", workflow, undefined, undefined, calls);

    expect(result.status).toBe("completed");
    expect(JSON.parse(store.readArtifact("content-shaped-json", "ticket.json").content.toString()))
      .toEqual({ content: "body", contentType: "record-type" });
    expect(store.getArtifact("content-shaped-json", "ticket.json")?.contentType)
      .toBe("application/vnd.agentflow.test+json");
    store.close();
  });

  test("uses an explicit fixture adapter and fails closed when the response is absent", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "missing-fixture", workflow, inputs: { ticket_key: "AM-26" } });
    const calls = createAgentflowMcpCallRegistry().register("fixture", createAgentflowFixtureMcpAdapter({}));

    const result = await executeAgentflowCommandPipeline(store, "missing-fixture", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "paused", failedStep: "fetch" });
    expect(result.message).toContain("no response for step fetch");
    expect(store.listArtifacts("missing-fixture")).toEqual([]);
    store.close();
  });

  test("rejects missing and undeclared adapter outputs without partial publication", async () => {
    for (const outputs of [{}, { "ticket.json": { key: "AM-26" }, "extra.json": {} }]) {
      const root = temporaryRepo();
      const workflow = mcpWorkflow();
      const store = await openAgentflowRunState({ cwd: root });
      createAgentflowLifecycleRun(store, { id: "invalid-output", workflow, inputs: { ticket_key: "AM-26" } });
      const calls = createAgentflowMcpCallRegistry().register("fixture", () => ({ outputs }));

      const result = await executeAgentflowCommandPipeline(store, "invalid-output", workflow, undefined, undefined, calls);

      expect(result).toMatchObject({ status: "paused", failedStep: "fetch" });
      expect(store.listArtifacts("invalid-output")).toEqual([]);
      store.close();
    }
  });

  test("checks output collisions before invoking the adapter", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "collision", workflow, inputs: { ticket_key: "AM-26" } });
    store.writeArtifact({
      id: "existing",
      runId: "collision",
      path: "ticket.json",
      kind: "fixture",
      contentType: "application/json",
      content: "{}"
    });
    let invoked = false;
    const calls = createAgentflowMcpCallRegistry().register("fixture", () => {
      invoked = true;
      return { outputs: { "ticket.json": {} } };
    });

    const result = await executeAgentflowCommandPipeline(store, "collision", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "paused", failedStep: "fetch" });
    expect(result.message).toContain("already exists");
    expect(invoked).toBe(false);
    expect(store.readArtifact("collision", "ticket.json").content.toString()).toBe("{}");
    store.close();
  });

  test("rejects non-static output paths before invoking the adapter", async () => {
    for (const output of ["a/../ticket.json", "{{ inputs.output }}"]) {
      const root = temporaryRepo();
      const workflow = parseAgentflowWorkflowOrThrow(`name: invalid-runtime-output
version: 1
style: pipeline
maturity: experimental
steps:
  - { id: fetch, type: mcp_call, server: fixture, tool: fetch, arguments: {}, outputs: ["${output}"], on_failure: { then: pause } }
`);
      const store = await openAgentflowRunState({ cwd: root });
      store.createRunWithEvent({
        id: "invalid-runtime-output",
        workflow: {
          name: workflow.name,
          version: workflow.version,
          style: workflow.style,
          maturity: workflow.maturity
        },
        context: { workflow: workflow as never }
      }, { type: "run.created", payload: { status: "pending" } });
      let invoked = false;
      const calls = createAgentflowMcpCallRegistry().register("fixture", () => {
        invoked = true;
        return { outputs: { [output]: {} } };
      });

      const result = await executeAgentflowCommandPipeline(store, "invalid-runtime-output", workflow, undefined, undefined, calls);

      expect(result).toMatchObject({ status: "paused", failedStep: "fetch" });
      expect(result.message).toContain("normalized static repo-relative artifact path");
      expect(invoked).toBe(false);
      expect(store.listArtifacts("invalid-runtime-output")).toEqual([]);
      store.close();
    }
  });

  test("checks every output collision before invoking a multi-output adapter", async () => {
    const root = temporaryRepo();
    const workflow = parseAgentflowWorkflowOrThrow(`name: multi-output-collision
version: 1
style: pipeline
maturity: experimental
steps:
  - { id: fetch, type: mcp_call, server: fixture, tool: fetch, arguments: {}, outputs: [new.json, occupied.json], on_failure: { then: pause } }
`);
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "multi-collision", workflow });
    store.writeArtifact({ id: "occupied", runId: "multi-collision", path: "occupied.json", kind: "fixture", contentType: "application/json", content: "{}" });
    let invoked = false;
    const calls = createAgentflowMcpCallRegistry().register("fixture", () => {
      invoked = true;
      return { outputs: { "new.json": {}, "occupied.json": {} } };
    });

    const result = await executeAgentflowCommandPipeline(store, "multi-collision", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "paused", failedStep: "fetch" });
    expect(result.message).toContain("occupied.json already exists");
    expect(invoked).toBe(false);
    expect(store.getArtifact("multi-collision", "new.json")).toBeNull();
    store.close();
  });

  test("retries adapter failures with the declared failure policy", async () => {
    const root = temporaryRepo();
    const workflow = parseAgentflowWorkflowOrThrow(`name: retry-mcp
version: 1
style: pipeline
maturity: experimental
inputs: { ticket_key: { required: true } }
steps:
  - id: fetch
    type: mcp_call
    server: fixture
    tool: get_issue
    arguments: { key: "{{ inputs.ticket_key }}" }
    outputs: [ticket.json]
    on_failure: { retry: 1, then: pause }
`);
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "retry", workflow, inputs: { ticket_key: "AM-26" } });
    let attempts = 0;
    const calls = createAgentflowMcpCallRegistry().register("fixture", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
      return { outputs: { "ticket.json": { key: "AM-26" } } };
    });

    const result = await executeAgentflowCommandPipeline(store, "retry", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "completed", completedSteps: ["fetch"] });
    expect(attempts).toBe(2);
    expect(store.listEvents("retry").filter((event) => event.type === "step.failed")).toHaveLength(1);
    store.close();
  });

  test("aborts an in-flight adapter and publishes nothing after the run is paused", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "paused-call", workflow, inputs: { ticket_key: "AM-26" } });
    let request: AgentflowMcpCallRequest | undefined;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const calls = createAgentflowMcpCallRegistry().register("fixture", (value) => {
      request = value;
      started();
      return new Promise(() => undefined);
    });

    const execution = executeAgentflowCommandPipeline(store, "paused-call", workflow, undefined, undefined, calls);
    await didStart;
    transitionAgentflowLifecycleRun(store, "paused-call", "pause");
    const result = await execution;

    expect(result).toMatchObject({ status: "paused" });
    expect(request?.signal.aborted).toBe(true);
    expect(store.listArtifacts("paused-call")).toEqual([]);
    store.close();
  });

  test("records interruption when cancellation lands immediately after atomic publication", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "cancel-after-publish", workflow, inputs: { ticket_key: "AM-26" } });
    const calls = createAgentflowMcpCallRegistry().register("fixture", () => ({ outputs: { "ticket.json": {} } }));
    const writeArtifactsAtomically = store.writeArtifactsAtomically.bind(store);
    store.writeArtifactsAtomically = (inputs) => {
      const artifacts = writeArtifactsAtomically(inputs);
      transitionAgentflowLifecycleRun(store, "cancel-after-publish", "cancel");
      return artifacts;
    };

    const result = await executeAgentflowCommandPipeline(store, "cancel-after-publish", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "cancelled", completedSteps: [] });
    expect(store.getArtifact("cancel-after-publish", "ticket.json")).not.toBeNull();
    expect(store.listEvents("cancel-after-publish").map((event) => event.type)).toContain("step.interrupted");
    expect(store.listEvents("cancel-after-publish").map((event) => event.type)).not.toContain("step.completed");
    store.close();
  });

  test("records interruption when cancellation races with an atomic publication error", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "cancel-with-error", workflow, inputs: { ticket_key: "AM-26" } });
    const calls = createAgentflowMcpCallRegistry().register("fixture", () => ({ outputs: { "ticket.json": {} } }));
    store.writeArtifactsAtomically = () => {
      transitionAgentflowLifecycleRun(store, "cancel-with-error", "cancel");
      throw new Error("publication raced with cancellation");
    };

    const result = await executeAgentflowCommandPipeline(store, "cancel-with-error", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "cancelled", completedSteps: [] });
    expect(store.listEvents("cancel-with-error").map((event) => event.type)).toContain("step.interrupted");
    expect(store.listEvents("cancel-with-error").find((event) => event.type === "step.interrupted")?.payload)
      .toMatchObject({ status: "cancelled" });
    store.close();
  });

  test("rejects oversized adapter metadata before atomic publication", async () => {
    const root = temporaryRepo();
    const workflow = mcpWorkflow();
    const store = await openAgentflowRunState({ cwd: root });
    createAgentflowLifecycleRun(store, { id: "oversized-metadata", workflow, inputs: { ticket_key: "AM-26" } });
    const calls = createAgentflowMcpCallRegistry().register("fixture", () => ({
      outputs: { "ticket.json": { key: "AM-26" } },
      metadata: { value: "x".repeat(MAX_AGENTFLOW_MCP_METADATA_BYTES + 1) }
    }));

    const result = await executeAgentflowCommandPipeline(store, "oversized-metadata", workflow, undefined, undefined, calls);

    expect(result).toMatchObject({ status: "paused", failedStep: "fetch" });
    expect(result.message).toContain("metadata");
    expect(store.listArtifacts("oversized-metadata")).toEqual([]);
    store.close();
  });

  test("rejects non-JSON output and metadata values instead of coercing them", async () => {
    for (const response of [
      { outputs: { "ticket.json": { invalid: Number.NaN } } },
      { outputs: { "ticket.json": { key: "AM-26" } }, metadata: { invalid: new Date() } }
    ]) {
      const root = temporaryRepo();
      const workflow = mcpWorkflow();
      const store = await openAgentflowRunState({ cwd: root });
      createAgentflowLifecycleRun(store, { id: "invalid-json", workflow, inputs: { ticket_key: "AM-26" } });
      const calls = createAgentflowMcpCallRegistry().register("fixture", () => response as never);

      const result = await executeAgentflowCommandPipeline(store, "invalid-json", workflow, undefined, undefined, calls);

      expect(result).toMatchObject({ status: "paused", failedStep: "fetch" });
      expect(store.listArtifacts("invalid-json")).toEqual([]);
      store.close();
    }
  });
});

function mcpWorkflow() {
  return parseAgentflowWorkflowOrThrow(`name: fixture-mcp
version: 1
style: pipeline
maturity: experimental
inputs:
  ticket_key: { required: true }
steps:
  - id: fetch
    type: mcp_call
    server: fixture
    tool: get_issue
    arguments:
      key: "{{ inputs.ticket_key }}"
    outputs: [ticket.json]
    on_failure: { then: pause }
`);
}

function temporaryRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-mcp-call-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}
