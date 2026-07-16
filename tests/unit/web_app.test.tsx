import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import App, { ClaimDrawer, ClaimReader, FileView, HealthPanel, ReviewView, WorkflowView } from "../../packages/web/src/App";

const originalWindow = globalThis.window;

describe("Agent Memory web app", () => {
  afterEach(() => {
    globalThis.window = originalWindow;
  });

  test("renders the initial repository shell with its primary controls", () => {
    globalThis.window = {
      innerWidth: 1280,
      location: { search: "?token=test-token" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined
      }
    } as unknown as Window & typeof globalThis;

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Agent Memory");
    expect(html).toContain("Loading repository memory");
    expect(html).toContain('aria-label="Views"');
    expect(html).toContain("Graph");
    expect(html).toContain("Files");
    expect(html).toContain("Workflows");
    expect(html).toContain("Review");
    expect(html).toContain("Loading memory...");
  });

  test("renders repository health, files, and actionable review items", () => {
    const healthMemory = {
      validation: {
        valid: false,
        errors: [{ message: "A claim source is missing." }]
      },
      doctor: {
        healthy: false,
        checks: [{ name: "database", status: "warning", message: "Compile memory before querying." }]
      }
    } as unknown as NonNullable<Parameters<typeof HealthPanel>[0]["memory"]>;
    const fileRoot: Parameters<typeof FileView>[0]["root"] = {
      name: "agent-memory",
      path: "docs/agent-memory",
      kind: "directory",
      children: [
        {
          name: "claims",
          path: "docs/agent-memory/claims",
          kind: "directory",
          children: [
            {
              name: "oauth.md",
              path: "docs/agent-memory/claims/auth/oauth.md",
              kind: "claim",
              claimId: "auth.oauth"
            },
            {
              name: "README.md",
              path: "docs/agent-memory/README.md",
              kind: "file"
            }
          ]
        }
      ]
    };
    const reviewItems: Parameters<typeof ReviewView>[0]["items"] = [
      {
        claimId: "auth.oauth",
        title: "OAuth identities are tenant scoped",
        system: "auth",
        status: "needs_review",
        confidence: "medium",
        severity: "high",
        sourcePath: "claims/auth/oauth.md",
        priority: 10,
        reason: "The source changed after the last review."
      }
    ];

    const html = renderToStaticMarkup(
      <>
        <HealthPanel memory={healthMemory} notice="Validation failed." busy onSync={() => undefined} />
        <FileView root={fileRoot} onSelectClaim={() => undefined} />
        <ReviewView items={reviewItems} onSelect={() => undefined} onApprove={() => undefined} />
        <ReviewView items={[]} onSelect={() => undefined} onApprove={() => undefined} />
      </>
    );

    expect(html).toContain("Needs attention");
    expect(html).toContain("A claim source is missing.");
    expect(html).toContain("Compile memory before querying.");
    expect(html).toContain("oauth.md");
    expect(html).toContain("OAuth identities are tenant scoped");
    expect(html).toContain("No claims currently need review.");
  });

  test("renders complete workflow data and plan-stage actions", () => {
    type WorkflowProps = Parameters<typeof WorkflowView>[0];
    const summary: WorkflowProps["summary"] = {
      recipeCount: 1,
      planTemplateCount: 1,
      profileTraitCount: 1,
      activePlanRunCount: 1,
      completedPlanRunCount: 0,
      abandonedPlanRunCount: 0,
      blockedPlanRunCount: 1,
      warnings: ["Template changed since the run started."]
    };
    const data: NonNullable<WorkflowProps["data"]> = {
      warnings: ["Template changed since the run started.", "One run needs attention."],
      recipes: [
        {
          id: "recipe.auth.modify_oauth",
          title: "Modify OAuth",
          system: "auth",
          status: "current",
          sourcePath: "recipes/auth/modify_oauth.yaml",
          requiredClaims: ["auth.oauth"],
          intentTriggers: ["change oauth"],
          steps: ["Inspect the current contract"],
          verification: ["bun test"]
        }
      ],
      plans: [
        {
          id: "plan.auth.oauth_review",
          title: "OAuth review",
          system: "auth",
          status: "current",
          sourcePath: "plans/auth/oauth_review.yaml",
          intentTriggers: ["review oauth"],
          stages: [
            {
              id: "inspect",
              title: "Inspect current behavior",
              goal: "Understand the tenant boundary.",
              sequence: 1,
              claimRefs: ["auth.oauth"],
              recipeRefs: ["recipe.auth.modify_oauth"],
              profileTraits: ["profile.implementer"],
              sourceFiles: ["src/auth.ts"],
              verification: ["bun test"],
              doneWhen: ["The boundary is documented."],
              memoryUpdates: []
            }
          ]
        }
      ],
      profiles: [
        {
          id: "profile.implementer",
          title: "Keep scope tight",
          status: "current",
          category: "scope_control",
          priority: "high",
          sourcePath: "profiles/implementer.yaml",
          appliesWhen: { systems: ["auth"] },
          snippet: "Keep changes inside the selected system.",
          conflictsWith: ["profile.explorer"]
        }
      ],
      planRuns: [
        {
          id: "run.oauth",
          templateId: "plan.auth.oauth_review",
          task: "Review OAuth behavior",
          status: "active",
          currentStage: "inspect",
          branch: "AM-21/example",
          baseCommit: "abc123",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T01:00:00.000Z",
          path: ".agent-memory/plans/oauth.yaml",
          warnings: ["Run is based on an older template."],
          stages: [
            {
              id: "inspect",
              title: "Inspect current behavior",
              goal: "Understand the tenant boundary.",
              status: "active",
              claimRefs: ["auth.oauth"],
              recipeRefs: ["recipe.auth.modify_oauth"],
              profileTraits: ["profile.implementer"],
              sourceFiles: ["src/auth.ts"],
              verification: ["bun test"],
              doneWhen: ["The boundary is documented."],
              memoryUpdates: [],
              evidence: []
            },
            {
              id: "verify",
              title: "Verify behavior",
              goal: "Run the authoritative suite.",
              status: "blocked",
              claimRefs: [],
              recipeRefs: [],
              profileTraits: [],
              sourceFiles: [],
              verification: ["bun test"],
              doneWhen: ["Tests pass."],
              memoryUpdates: [],
              evidence: [],
              reason: "Waiting for the fixture."
            }
          ]
        }
      ]
    };

    const html = renderToStaticMarkup(
      <WorkflowView
        summary={summary}
        data={data}
        loading={false}
        busy={false}
        onRefresh={() => undefined}
        onUpdateStage={() => undefined}
        onUpdateArtifact={() => undefined}
      />
    );

    expect(html).toContain("Review OAuth behavior");
    expect(html).toContain("Template changed since the run started.");
    expect(html.match(/Template changed since the run started\./g)).toHaveLength(1);
    expect(html).toContain("Complete");
    expect(html).toContain("Update");
    expect(html).toContain("Modify OAuth");
    expect(html).toContain("OAuth review");
    expect(html).toContain("Keep scope tight");
  });

  test("renders empty and populated claim details for review", () => {
    type DrawerProps = Parameters<typeof ClaimDrawer>[0];
    const relatedClaim = {
      id: "tenancy.current_tenant",
      type: "fact",
      system: "tenancy",
      status: "current",
      confidence: "high",
      severity: "high",
      title: "Current tenant is required",
      claim: "Authentication requires a current tenant.",
      sourcePath: "claims/tenancy/current_tenant.md",
      tags: ["tenancy"],
      reviewPriority: 0,
      sourceFiles: ["src/tenant.ts"],
      relatedFiles: [],
      symbols: [],
      routes: [],
      verification: ["bun test"],
      body: "Tenant context is established before authentication.",
      raw: {}
    };
    const detail: NonNullable<DrawerProps["detail"]> = {
      claim: {
        ...relatedClaim,
        id: "auth.oauth",
        system: "auth",
        title: "OAuth identities are tenant scoped",
        claim: "An OAuth identity belongs to exactly one tenant.",
        sourcePath: "claims/auth/oauth.md",
        sourceFiles: ["src/auth.ts"],
        relatedFiles: ["src/tenant.ts"],
        symbols: ["OAuthIdentity"],
        routes: ["/oauth/callback"],
        tags: ["oauth", "tenancy"],
        verification: ["bun test tests/integration/auth.test.ts"],
        body: "## Contract\n\nOAuth identities are scoped by `tenant_id`."
      },
      relations: [
        {
          id: "auth-requires-tenancy",
          source: "auth.oauth",
          target: "tenancy.current_tenant",
          relation: "requires",
          strength: 1,
          origin: "explicit",
          bidirectional: false
        }
      ],
      relatedClaims: [relatedClaim]
    };
    const callbacks = {
      commandPrefix: "bin/memory",
      onClose: () => undefined,
      onHide: () => undefined,
      onOpenReader: () => undefined,
      onResize: () => undefined,
      onResizeBy: () => undefined,
      onResizeStart: () => undefined,
      onReview: () => undefined
    };

    const html = renderToStaticMarkup(
      <>
        <ClaimDrawer detail={null} {...callbacks} />
        <ClaimDrawer detail={detail} {...callbacks} />
        <ClaimReader detail={detail} commandPrefix="bin/memory" onClose={() => undefined} onReview={() => undefined} />
      </>
    );

    expect(html).toContain("Select a claim to inspect its contents.");
    expect(html).toContain("OAuth identities are tenant scoped");
    expect(html).toContain("tenancy.current_tenant · Current tenant is required");
    expect(html).toContain("Show command");
    expect(html).toContain("OAuth identities are scoped by");
    expect(html).toContain("Claim OAuth identities are tenant scoped");
  });
});
