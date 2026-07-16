import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/?token=test-token" });
const exposedGlobals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  location: browser.location,
  localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement,
  SVGElement: browser.SVGElement,
  Element: browser.Element,
  Node: browser.Node,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser)
};

for (const [name, value] of Object.entries(exposedGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { default: App } = await import("../../packages/web/src/App");
const originalFetch = globalThis.fetch;

const claim = {
  id: "auth.oauth",
  type: "fact",
  system: "auth",
  status: "needs_review",
  confidence: "medium",
  severity: "high",
  title: "OAuth identities are tenant scoped",
  claim: "An OAuth identity belongs to exactly one tenant.",
  sourcePath: "claims/auth/oauth.md",
  tags: ["oauth", "tenancy"],
  reviewPriority: 10,
  sourceFiles: ["src/auth.ts"],
  relatedFiles: ["src/tenant.ts"],
  symbols: ["OAuthIdentity"],
  routes: ["/oauth/callback"],
  verification: ["bun test"],
  body: "## Contract\n\nOAuth identities are scoped by `tenant_id`.",
  raw: {}
};

const memory = {
  repoRoot: "/tmp/example",
  memoryRoot: "docs/agent-memory",
  databasePath: ".agent-memory/memory.sqlite",
  commandPrefix: "bin/memory",
  health: { healthy: true, validationValid: true, doctorHealthy: true },
  graph: {
    systems: [
      {
        id: "system:auth",
        system: "auth",
        color: "#2563eb",
        claimCount: 1,
        statusCounts: { needs_review: 1 },
        severityCounts: { high: 1 },
        reviewCount: 1,
        searchText: "auth oauth identities tenant scoped"
      }
    ],
    systemRelations: []
  },
  files: {
    name: "agent-memory",
    path: "docs/agent-memory",
    kind: "directory",
    children: [
      {
        name: "oauth.md",
        path: "docs/agent-memory/claims/auth/oauth.md",
        kind: "claim",
        claimId: "auth.oauth"
      }
    ]
  },
  workflowSummary: {
    recipeCount: 0,
    planTemplateCount: 0,
    profileTraitCount: 0,
    activePlanRunCount: 0,
    completedPlanRunCount: 0,
    abandonedPlanRunCount: 0,
    blockedPlanRunCount: 0,
    warnings: []
  },
  validation: { valid: true, errors: [], warnings: [], counts: { claims: 1, graphs: 0, indexes: 0, recipes: 0 } },
  doctor: { healthy: true, checks: [] },
  reviewQueue: [
    {
      claimId: "auth.oauth",
      title: claim.title,
      system: "auth",
      status: "needs_review",
      confidence: "medium",
      severity: "high",
      sourcePath: claim.sourcePath,
      priority: 10,
      reason: "The source changed after the last review."
    }
  ]
};

describe("Agent Memory web interactions", () => {
  afterEach(() => {
    cleanup();
    browser.localStorage.clear();
    browser.history.replaceState({}, "", "/?token=test-token");
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    browser.close();
  });

  test("loads memory and supports the primary navigation and claim workflow", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    globalThis.fetch = async (input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), browser.location.href).pathname;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      requests.push({ method, path });

      if (path === "/api/memory") {
        return Response.json(memory);
      }

      if (path === "/api/claims/auth.oauth") {
        return Response.json({ claim, relations: [], relatedClaims: [] });
      }

      if (path === "/api/workflows/recipes") {
        return Response.json({ recipes: [] });
      }

      if (path === "/api/workflows/plans") {
        return Response.json({ plans: [] });
      }

      if (path === "/api/workflows/profiles") {
        return Response.json({ profiles: [] });
      }

      if (path === "/api/workflows/plan-runs") {
        return Response.json({ runs: [], warnings: [] });
      }

      if (path === "/api/claims/auth.oauth/review" || path === "/api/sync") {
        return Response.json({ validation: { valid: true, errors: [] } });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    };

    const view = render(<App />);
    await waitFor(() => expect(view.getByText("Memory loaded.")).toBeTruthy());
    expect(view.getByText("docs/agent-memory")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Files" }));
    fireEvent.click(view.getByRole("button", { name: /oauth\.md/ }));
    await waitFor(() => expect(view.getByRole("heading", { name: claim.title })).toBeTruthy());
    expect(view.getByText(claim.claim)).toBeTruthy();

    const resizeHandle = view.getByRole("separator", { name: "Resize claim drawer" });
    fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });
    expect(browser.localStorage.getItem("agent-memory.drawer-width")).toBeTruthy();

    fireEvent.click(view.getAllByRole("button", { name: "Hide" })[1]);
    expect(view.getByRole("button", { name: "Details" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Details" }));
    fireEvent.click(view.getByRole("button", { name: "Read" }));
    expect(view.getByRole("dialog", { name: `Claim ${claim.title}` })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close reader" }));

    fireEvent.click(view.getByRole("button", { name: "Review" }));
    fireEvent.click(view.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(requests).toContainEqual({ method: "PATCH", path: "/api/claims/auth.oauth/review" }));

    fireEvent.click(view.getByRole("button", { name: "Workflows" }));
    await waitFor(() => expect(view.getByText("Workflows loaded.")).toBeTruthy());
    expect(view.getByText("No local plan runs.")).toBeTruthy();
    expect(view.getByText("No recipes.")).toBeTruthy();
    expect(view.getByText("No plan templates.")).toBeTruthy();
    expect(view.getByText("No profile traits.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(requests).toContainEqual({ method: "POST", path: "/api/sync" }));
    expect(requests.filter((request) => request.path === "/api/memory").length).toBeGreaterThanOrEqual(3);
  });

  test("surfaces API failures without losing the application shell", async () => {
    globalThis.fetch = async () => new Response("backend unavailable", { status: 503 });

    const view = render(<App />);

    await waitFor(() => expect(view.getByText("backend unavailable")).toBeTruthy());
    expect(view.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(view.getByText("Needs attention")).toBeTruthy();
  });
});
