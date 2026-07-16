import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAddressInUse, startBunUiServer, startNodeUiServer as startUiServer, type BunRuntime } from "../../packages/core/src/ui_server";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("UI server", () => {
  // Exercise the Node adapter explicitly; ui_bun_handler.test.ts covers Bun's adapter without binding sockets.
  test("serves memory JSON and static assets", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const memory = await getJson<{ graph: { systems: Array<{ system: string }>; systemRelations: Array<{ relation: string }> }; doctor: { healthy: boolean } }>(
        `${baseUrl(server.port)}/api/memory`
      );
      const index = await fetch(`${baseUrl(server.port)}/`);

      expect(memory.graph.systems.some((item) => item.system === "auth")).toBe(true);
      expect(memory.graph.systemRelations.some((relation) => relation.relation === "requires")).toBe(true);
      expect(memory.doctor.healthy).toBe(false);
      expect(await index.text()).toContain("Agent Memory Test UI");
    } finally {
      await server.close();
    }
  });

  test("serves workflow recipe, plan, profile, and plan-run endpoints", async () => {
    const cwd = copyFixture(mockApp);
    writePlanRun(cwd);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const recipes = await getJson<{ recipes: Array<{ id: string }> }>(`${baseUrl(server.port)}/api/workflows/recipes`);
      const plans = await getJson<{ plans: Array<{ id: string }> }>(`${baseUrl(server.port)}/api/workflows/plans`);
      const profiles = await getJson<{ profiles: Array<{ id: string }> }>(`${baseUrl(server.port)}/api/workflows/profiles`);
      const planRuns = await getJson<{ runs: Array<{ id: string; currentStage: string }>; warnings: string[] }>(`${baseUrl(server.port)}/api/workflows/plan-runs`);

      expect(recipes.recipes.map((recipe) => recipe.id)).toContain("recipe.auth.modify_student_oauth");
      expect(plans.plans).toEqual([]);
      expect(profiles.profiles).toEqual([]);
      expect(planRuns.warnings).toEqual([]);
      expect(planRuns.runs).toContainEqual(
        expect.objectContaining({
          id: "plan_run.20260703.oauth_review",
          currentStage: "inspect_current_contract"
        })
      );
    } finally {
      await server.close();
    }
  });

  test("requires token for review updates", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const denied = await fetch(`${baseUrl(server.port)}/api/claims/auth.student_oauth.uid_is_tenant_scoped/review`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "current", confidence: "high" })
      });

      expect(denied.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  test("requires token and validates plan run stage updates", async () => {
    const cwd = copyFixture(mockApp);
    writePlanRun(cwd);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });
    const runPath = path.join(cwd, ".agent-memory/plans/oauth-review.yaml");
    const url = `${baseUrl(server.port)}/api/workflows/plan-runs/plan_run.20260703.oauth_review/stages/inspect_current_contract`;

    try {
      const denied = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "complete", evidence: "Reviewed current behavior." })
      });
      expect(denied.status).toBe(403);

      const invalid = await fetch(url, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ status: "complete", evidence: "" })
      });
      const invalidBody = (await invalid.json()) as { code: string; error: string };
      expect(invalid.status).toBe(400);
      expect(invalidBody.code).toBe("BAD_REQUEST");
      expect(invalidBody.error).toContain("complete-stage requires non-empty --evidence");

      const updated = await fetch(url, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ status: "complete", evidence: "Reviewed current behavior." })
      });
      const body = (await updated.json()) as { status: string; stages: Array<{ id: string; status: string; evidence: string[] }> };

      expect(updated.status).toBe(200);
      expect(body.status).toBe("complete");
      expect(body.stages[0]).toMatchObject({
        id: "inspect_current_contract",
        status: "complete",
        evidence: ["Reviewed current behavior."]
      });
      expect(fs.readFileSync(runPath, "utf8")).toContain("Reviewed current behavior.");
    } finally {
      await server.close();
    }
  });

  test("requires token and updates workflow artifacts through structured patches", async () => {
    const cwd = copyFixture(mockApp);
    writePlan(cwd);
    writeProfile(cwd);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const denied = await fetch(`${baseUrl(server.port)}/api/workflows/recipes/recipe.auth.modify_student_oauth`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "needs_review" })
      });
      expect(denied.status).toBe(403);

      const invalid = await fetch(`${baseUrl(server.port)}/api/workflows/recipes/recipe.auth.modify_student_oauth`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ intent_triggers: "not an array" })
      });
      const invalidBody = (await invalid.json()) as { code: string };
      expect(invalid.status).toBe(400);
      expect(invalidBody.code).toBe("BAD_REQUEST");

      const recipe = await fetch(`${baseUrl(server.port)}/api/workflows/recipes/recipe.auth.modify_student_oauth`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ title: "Modify student OAuth with tenant checks", status: "needs_review" })
      });
      const recipeBody = (await recipe.json()) as { artifact: { title: string; status: string }; validation: { valid: boolean } };
      expect(recipe.status).toBe(200);
      expect(recipeBody.validation.valid).toBe(true);
      expect(recipeBody.artifact).toMatchObject({
        title: "Modify student OAuth with tenant checks",
        status: "needs_review"
      });

      const plan = await fetch(`${baseUrl(server.port)}/api/workflows/plans/plan_template.auth.oauth_review`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ stages: [{ id: "inspect_current_contract", goal: "Review OAuth tenant behavior before editing." }] })
      });
      expect(plan.status).toBe(200);

      const profile = await fetch(`${baseUrl(server.port)}/api/workflows/profiles/profile_trait.implementer.keep_scope_tight`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ priority: "high", snippet: "Keep scope tied to selected auth claims." })
      });
      expect(profile.status).toBe(200);
      expect(fs.readFileSync(path.join(cwd, "docs/agent-memory/plans/auth/oauth_review.yaml"), "utf8")).toContain("Review OAuth tenant behavior before editing.");
      expect(fs.readFileSync(path.join(cwd, "docs/agent-memory/profiles/implementer/keep_scope_tight.yaml"), "utf8")).toContain("priority: high");
    } finally {
      await server.close();
    }
  });

  test("serves claim details with relations and related claims", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const detail = await getJson<{
        claim: { id: string };
        relations: Array<{ relation: string; target: string }>;
        relatedClaims: Array<{ id: string }>;
      }>(`${baseUrl(server.port)}/api/claims/auth.student_oauth.uid_is_tenant_scoped`);

      expect(detail.claim.id).toBe("auth.student_oauth.uid_is_tenant_scoped");
      expect(detail.relations.some((relation) => relation.relation === "requires")).toBe(true);
      expect(detail.relatedClaims.some((claim) => claim.id === "tenancy.current_tenant.required_for_student_auth")).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("serves lazy system graph claims with relations touching that system", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const graph = await getJson<{
        system: string;
        claims: Array<{ id: string; sourcePath: string }>;
        relations: Array<{ relation: string; target: string }>;
      }>(`${baseUrl(server.port)}/api/graph/systems/auth`);

      expect(graph.system).toBe("auth");
      expect(graph.claims).toHaveLength(1);
      expect(graph.claims[0]).toMatchObject({
        id: "auth.student_oauth.uid_is_tenant_scoped",
        sourcePath: "claims/auth/student_oauth_uid_is_tenant_scoped.md"
      });
      expect(graph.relations.some((relation) => relation.relation === "requires")).toBe(true);
      expect(graph.relations.some((relation) => relation.target === "tenancy.current_tenant.required_for_student_auth")).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("returns 404 for unknown system graph", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const response = await fetch(`${baseUrl(server.port)}/api/graph/systems/missing`);
      const body = (await response.json()) as { code: string };

      expect(response.status).toBe(404);
      expect(body.code).toBe("NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  test("returns 404 for unknown claim details", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const response = await fetch(`${baseUrl(server.port)}/api/claims/auth.missing`);
      const body = (await response.json()) as { code: string };

      expect(response.status).toBe(404);
      expect(body.code).toBe("NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  test("requires token for sync and compiles when authorized", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const denied = await fetch(`${baseUrl(server.port)}/api/sync`, { method: "POST" });
      expect(denied.status).toBe(403);

      const response = await fetch(`${baseUrl(server.port)}/api/sync`, {
        method: "POST",
        headers: { "x-agent-memory-token": "test-token" }
      });
      const result = (await response.json()) as { validation: { valid: boolean }; compile: { counts: { claims: number } } };

      expect(response.status).toBe(200);
      expect(result.validation.valid).toBe(true);
      expect(result.compile.counts.claims).toBe(2);
      expect(fs.existsSync(path.join(cwd, ".agent-memory/memory.sqlite"))).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("rejects invalid review payloads without writing claims", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");
    const before = fs.readFileSync(claimPath, "utf8");

    try {
      const response = await fetch(`${baseUrl(server.port)}/api/claims/auth.student_oauth.uid_is_tenant_scoped/review`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ status: "approved", confidence: "high" })
      });
      const body = (await response.json()) as { code: string };

      expect(response.status).toBe(400);
      expect(body.code).toBe("BAD_REQUEST");
      expect(fs.readFileSync(claimPath, "utf8")).toBe(before);
    } finally {
      await server.close();
    }
  });

  test("rejects malformed JSON review payloads", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const response = await fetch(`${baseUrl(server.port)}/api/claims/auth.student_oauth.uid_is_tenant_scoped/review`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: "{"
      });
      const body = (await response.json()) as { code: string };

      expect(response.status).toBe(400);
      expect(body.code).toBe("BAD_REQUEST");
    } finally {
      await server.close();
    }
  });

  test("treats whitespace-only review payloads as empty JSON objects", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const response = await fetch(`${baseUrl(server.port)}/api/claims/auth.student_oauth.uid_is_tenant_scoped/review`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: "\n  \t"
      });
      const result = (await response.json()) as { validation: { valid: boolean }; compile?: { counts: { claims: number } } };

      expect(response.status).toBe(200);
      expect(result.validation.valid).toBe(true);
      expect(result.compile?.counts.claims).toBe(2);
    } finally {
      await server.close();
    }
  });

  test("does not treat unrelated Bun startup errors as address conflicts", async () => {
    expect(isAddressInUse(new Error("Failed to start server. Is port 45984 in use?"))).toBe(true);
    expect(isAddressInUse(new Error("port configuration is in use by an invalid runtime option"))).toBe(false);
  });

  test("keeps scanning fallback ports for Bun port 0 after busy ranges", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    let attempts = 0;
    const fakeBun: BunRuntime = {
      serve(options: { port: number }) {
        attempts += 1;

        if (attempts <= 101) {
          const error = new Error(`port ${options.port} in use`) as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          throw error;
        }

        return {
          port: options.port,
          stop() {}
        };
      }
    };

    const server = await startBunUiServer(fakeBun, { cwd, port: 0, staticRoot, token: "test-token" });

    try {
      expect(attempts).toBe(102);
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  test("review update writes claim, validates, and recompiles", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });
    const claimPath = path.join(cwd, "docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md");

    try {
      const response = await fetch(`${baseUrl(server.port)}/api/claims/auth.student_oauth.uid_is_tenant_scoped/review`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-agent-memory-token": "test-token"
        },
        body: JSON.stringify({ status: "needs_review", confidence: "medium" })
      });
      const result = (await response.json()) as { validation: { valid: boolean }; compile?: { counts: { claims: number } } };

      expect(response.status).toBe(200);
      expect(result.validation.valid).toBe(true);
      expect(result.compile?.counts.claims).toBe(2);
      expect(fs.readFileSync(claimPath, "utf8")).toContain("status: needs_review");
      expect(fs.existsSync(path.join(cwd, ".agent-memory/memory.sqlite"))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

function copyFixture(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-ui-server-"));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function makeStaticRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-ui-static-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Agent Memory Test UI</title>");
  return root;
}

function writePlanRun(cwd: string): void {
  const runPath = path.join(cwd, ".agent-memory/plans/oauth-review.yaml");
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
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
    goal: Review current OAuth and tenancy behavior.
    status: active
    claim_refs:
      - auth.student_oauth.uid_is_tenant_scoped
    recipe_refs:
      - recipe.auth.modify_student_oauth
    profile_traits: []
    source_files:
      - src/auth.js
    verification:
      - bun test
    done_when:
      - Current behavior is understood.
    memory_updates: []
    evidence: []
`
  );
}

function writePlan(cwd: string): void {
  const planPath = path.join(cwd, "docs/agent-memory/plans/auth/oauth_review.yaml");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    `id: plan_template.auth.oauth_review
title: OAuth review
system: auth
status: current
stages:
  - id: inspect_current_contract
    title: Inspect current contract
    goal: Review current OAuth and tenancy behavior.
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
}

function writeProfile(cwd: string): void {
  const profilePath = path.join(cwd, "docs/agent-memory/profiles/implementer/keep_scope_tight.yaml");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
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
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}
