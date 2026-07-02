import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAddressInUse, startBunUiServer, startUiServer, type BunRuntime } from "../../packages/core/src/ui_server";

const repoRoot = path.resolve(".");
const mockApp = path.join(repoRoot, "examples/mock-app");

describe("UI server", () => {
  test("serves memory JSON and static assets", async () => {
    const cwd = copyFixture(mockApp);
    const staticRoot = makeStaticRoot();
    const server = await startUiServer({ cwd, port: 0, staticRoot, token: "test-token" });

    try {
      const memory = await getJson<{ claims: Array<{ id: string }>; doctor: { healthy: boolean } }>(`${baseUrl(server.port)}/api/memory`);
      const index = await fetch(`${baseUrl(server.port)}/`);

      expect(memory.claims.some((claim) => claim.id === "auth.student_oauth.uid_is_tenant_scoped")).toBe(true);
      expect(memory.doctor.healthy).toBe(false);
      expect(await index.text()).toContain("Agent Memory Test UI");
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

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}
