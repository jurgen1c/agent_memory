import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBunUiServer, type BunRuntime } from "../../packages/core/src/ui_server";

const mockApp = path.resolve("examples/mock-app");

describe("Bun UI request handler", () => {
  test("serves memory APIs and static assets without opening a socket", async () => {
    const cwd = copyFixture();
    const staticRoot = makeStaticRoot();
    const runtime = fakeBunRuntime();
    const server = await startBunUiServer(runtime.bun, { cwd, host: "127.0.0.1", port: 4317, staticRoot, token: "test-token" });

    try {
      expect(server.port).toBe(4317);
      expect(server.url).toBe("http://127.0.0.1:4317/?token=test-token");

      const memory = await request(runtime, "/api/memory");
      const memoryBody = (await memory.json()) as { graph: { systems: Array<{ system: string }> } };
      expect(memory.status).toBe(200);
      expect(memory.headers.get("cache-control")).toBe("no-store");
      expect(memoryBody.graph.systems.some((system) => system.system === "auth")).toBe(true);

      const recipes = await request(runtime, "/api/workflows/recipes");
      const plans = await request(runtime, "/api/workflows/plans");
      const profiles = await request(runtime, "/api/workflows/profiles");
      const planRuns = await request(runtime, "/api/workflows/plan-runs");
      expect((await recipes.json()) as { recipes: unknown[] }).toHaveProperty("recipes");
      expect((await plans.json()) as { plans: unknown[] }).toEqual({ plans: [] });
      expect((await profiles.json()) as { profiles: unknown[] }).toEqual({ profiles: [] });
      expect((await planRuns.json()) as { runs: unknown[] }).toEqual({ runs: [], warnings: [] });

      const graph = await request(runtime, "/api/graph/systems/auth");
      const graphBody = (await graph.json()) as { system: string; claims: Array<{ id: string }> };
      expect(graphBody.system).toBe("auth");
      expect(graphBody.claims).toContainEqual(expect.objectContaining({ id: "auth.student_oauth.uid_is_tenant_scoped" }));

      const claim = await request(runtime, "/api/claims/auth.student_oauth.uid_is_tenant_scoped");
      expect((await claim.json()) as { claim: { id: string } }).toHaveProperty("claim.id", "auth.student_oauth.uid_is_tenant_scoped");

      const index = await request(runtime, "/");
      const script = await request(runtime, "/app.js");
      const styles = await request(runtime, "/styles.css");
      const data = await request(runtime, "/data.json");
      const binary = await request(runtime, "/asset.bin");
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await index.text()).toContain("Agent Memory Bun UI");
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(styles.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(data.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(binary.headers.get("content-type")).toBe("application/octet-stream");
      expect(await request(runtime, "/missing-route").then((response) => response.text())).toContain("Agent Memory Bun UI");
      expect((await request(runtime, "/anything", { method: "DELETE" })).status).toBe(405);
    } finally {
      await server.close();
      expect(runtime.stopped).toBe(true);
    }
  });

  test("enforces mutation tokens and returns structured request errors", async () => {
    const cwd = copyFixture();
    writeWorkflowFixtures(cwd);
    const staticRoot = makeStaticRoot();
    const runtime = fakeBunRuntime();
    const server = await startBunUiServer(runtime.bun, { cwd, port: 4317, staticRoot, token: "test-token" });
    const reviewPath = "/api/claims/auth.student_oauth.uid_is_tenant_scoped/review";

    try {
      const denied = await request(runtime, reviewPath, { method: "PATCH", body: "{}" });
      expect(denied.status).toBe(403);
      expect((await denied.json()) as { code: string }).toHaveProperty("code", "FORBIDDEN");

      const malformed = await request(runtime, reviewPath, {
        method: "PATCH",
        headers: tokenHeaders(),
        body: "{"
      });
      expect(malformed.status).toBe(400);
      expect((await malformed.json()) as { code: string; error: string }).toEqual(
        expect.objectContaining({ code: "BAD_REQUEST", error: expect.stringContaining("Invalid JSON request body.") })
      );

      const reviewed = await request(runtime, reviewPath, {
        method: "PATCH",
        headers: tokenHeaders(),
        body: JSON.stringify({ status: "needs_review", confidence: "medium" })
      });
      expect(reviewed.status).toBe(200);
      expect(fs.readFileSync(path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md"), "utf8")).toContain(
        "status: needs_review"
      );

      const invalidStagePath = await request(runtime, "/api/workflows/plan-runs/run/stages/one/more", {
        method: "PATCH",
        headers: tokenHeaders(),
        body: "{}"
      });
      expect(invalidStagePath.status).toBe(400);
      expect((await invalidStagePath.json()) as { code: string; error: string }).toEqual(
        expect.objectContaining({ code: "BAD_REQUEST", error: expect.stringContaining("Invalid plan run stage update path.") })
      );

      const recipeUpdate = await request(runtime, "/api/workflows/recipes/recipe.auth.modify_student_oauth", {
        method: "PATCH",
        headers: tokenHeaders(),
        body: JSON.stringify({ title: "Modify OAuth safely" })
      });
      expect(recipeUpdate.status).toBe(200);
      expect(fs.readFileSync(path.join(cwd, "docs/agent-memory/recipes/auth/modify_student_oauth.yaml"), "utf8")).toContain(
        'title: "Modify OAuth safely"'
      );

      const planUpdate = await request(runtime, "/api/workflows/plans/plan_template.auth.oauth_review", {
        method: "PATCH",
        headers: tokenHeaders(),
        body: JSON.stringify({ title: "Review OAuth contract" })
      });
      expect(planUpdate.status).toBe(200);
      expect(fs.readFileSync(path.join(cwd, "docs/agent-memory/plans/auth/oauth_review.yaml"), "utf8")).toContain(
        'title: "Review OAuth contract"'
      );

      const profileUpdate = await request(runtime, "/api/workflows/profiles/profile_trait.implementer.keep_scope_tight", {
        method: "PATCH",
        headers: tokenHeaders(),
        body: JSON.stringify({ priority: "high" })
      });
      expect(profileUpdate.status).toBe(200);
      expect(fs.readFileSync(path.join(cwd, "docs/agent-memory/profiles/implementer/keep_scope_tight.yaml"), "utf8")).toContain(
        "priority: high"
      );

      const stageUpdate = await request(
        runtime,
        "/api/workflows/plan-runs/plan_run.20260703.oauth_review/stages/inspect_current_contract",
        {
          method: "PATCH",
          headers: tokenHeaders(),
          body: JSON.stringify({ status: "complete", evidence: "Reviewed current behavior." })
        }
      );
      expect(stageUpdate.status).toBe(200);
      expect((await stageUpdate.json()) as { status: string }).toHaveProperty("status", "complete");
      expect(fs.readFileSync(path.join(cwd, ".agent-memory/plans/oauth-review.yaml"), "utf8")).toContain("Reviewed current behavior.");

      const sync = await request(runtime, "/api/sync", { method: "POST", headers: tokenHeaders() });
      expect(sync.status).toBe(200);
      expect((await sync.json()) as { validation: { valid: boolean } }).toHaveProperty("validation.valid", true);

      const missing = await request(runtime, "/api/claims/auth.missing");
      expect(missing.status).toBe(404);
      expect((await missing.json()) as { code: string }).toHaveProperty("code", "NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  test("returns a clear 404 when built assets are unavailable", async () => {
    const runtime = fakeBunRuntime();
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-empty-web-"));
    const server = await startBunUiServer(runtime.bun, { cwd: copyFixture(), port: 4317, staticRoot, token: "test-token" });

    try {
      const response = await request(runtime, "/");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Run `bun run build:web`");
    } finally {
      await server.close();
    }
  });

  test("falls through occupied ports and closes the selected Bun server", async () => {
    let attempts = 0;
    let stopped = false;
    const bun: BunRuntime = {
      serve(options) {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
        }
        return { port: options.port, stop: () => void (stopped = true) };
      }
    };

    const server = await startBunUiServer(bun, { port: 4317, staticRoot: makeStaticRoot(), token: "token with spaces" });
    expect(attempts).toBe(2);
    expect(server.port).toBe(4318);
    expect(server.url).toContain("token=token%20with%20spaces");
    await server.close();
    expect(stopped).toBe(true);
  });
});

function fakeBunRuntime(): { bun: BunRuntime; fetch?: (request: Request) => Response | Promise<Response>; stopped: boolean } {
  const runtime: { fetch?: (request: Request) => Response | Promise<Response>; stopped: boolean } = { stopped: false };

  return {
    ...runtime,
    bun: {
      serve(options) {
        runtime.fetch = options.fetch;
        return {
          port: options.port,
          stop() {
            runtime.stopped = true;
          }
        };
      }
    },
    get fetch() {
      return runtime.fetch;
    },
    get stopped() {
      return runtime.stopped;
    }
  };
}

async function request(
  runtime: { fetch?: (request: Request) => Response | Promise<Response> },
  requestPath: string,
  init?: RequestInit
): Promise<Response> {
  if (!runtime.fetch) {
    throw new Error("Bun request handler was not captured.");
  }

  return runtime.fetch(new Request(`http://127.0.0.1:4317${requestPath}`, init));
}

function copyFixture(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-bun-ui-"));
  fs.cpSync(mockApp, target, { recursive: true });
  return target;
}

function makeStaticRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-bun-static-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Agent Memory Bun UI</title>");
  fs.writeFileSync(path.join(root, "app.js"), "console.log('ready');");
  fs.writeFileSync(path.join(root, "styles.css"), "body { color: black; }");
  fs.writeFileSync(path.join(root, "data.json"), "{}");
  fs.writeFileSync(path.join(root, "asset.bin"), "binary");
  return root;
}

function tokenHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-agent-memory-token": "test-token"
  };
}

function writeWorkflowFixtures(cwd: string): void {
  const planPath = path.join(cwd, "docs/agent-memory/plans/auth/oauth_review.yaml");
  const profilePath = path.join(cwd, "docs/agent-memory/profiles/implementer/keep_scope_tight.yaml");
  const runPath = path.join(cwd, ".agent-memory/plans/oauth-review.yaml");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    `id: plan_template.auth.oauth_review
title: OAuth review
system: auth
status: current
stages:
  - id: inspect_current_contract
    title: Inspect current contract
    goal: Review current OAuth behavior.
    claim_refs:
      - auth.student_oauth.uid_is_tenant_scoped
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits:
      - profile_trait.implementer.keep_scope_tight
    source_files:
      - src/auth.js
    verification:
      - bun test
    done_when:
      - Current behavior is understood.
`
  );
  fs.writeFileSync(
    profilePath,
    `id: profile_trait.implementer.keep_scope_tight
title: Keep scope tight
status: current
category: scope_control
priority: normal
applies_when:
  systems:
    - auth
snippet: Keep implementation scope tied to selected claims.
conflicts_with: []
`
  );
  fs.writeFileSync(
    runPath,
    `id: plan_run.20260703.oauth_review
task: Review OAuth change
created_at: 2026-07-03T00:00:00.000Z
updated_at: 2026-07-03T00:00:00.000Z
status: active
current_stage: inspect_current_contract
stages:
  - id: inspect_current_contract
    title: Inspect current contract
    goal: Review current OAuth behavior.
    status: active
    claim_refs: []
    recipe_refs: []
    profile_traits: []
    source_files: []
    verification: []
    done_when: []
    memory_updates: []
    evidence: []
`
  );
}
