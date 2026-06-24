import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentMemoryError, formatError, toAgentMemoryError } from "./errors";
import { buildUiMemoryModel, getUiClaimDetail, reviewClaim, syncUiMemory } from "./ui_model";

export interface UiServerOptions {
  cwd?: string;
  host?: string;
  port?: number;
  staticRoot?: string;
  token?: string;
}

export interface UiServerHandle {
  host: string;
  port: number;
  url: string;
  token: string;
  staticRoot: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const PORT_SCAN_LIMIT = 100;

type BunServer = {
  port: number;
  stop(force?: boolean): void | Promise<void>;
};

type BunRuntime = {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
};

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const bun = bunRuntime();

  if (bun) {
    return startBunUiServer(bun, options);
  }

  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const token = options.token ?? crypto.randomBytes(18).toString("base64url");
  const staticRoot = options.staticRoot ?? defaultStaticRoot();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, { cwd: options.cwd, token, staticRoot });
  });
  const port = await listen(server, host, requestedPort);

  return {
    host,
    port,
    url: `http://${host}:${port}/?token=${encodeURIComponent(token)}`,
    token,
    staticRoot,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      })
  };
}

async function startBunUiServer(bun: BunRuntime, options: UiServerOptions): Promise<UiServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const token = options.token ?? crypto.randomBytes(18).toString("base64url");
  const staticRoot = options.staticRoot ?? defaultStaticRoot();
  const startPort = requestedPort === 0 ? randomEphemeralPort() : requestedPort;
  let lastError: unknown;

  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = startPort + offset;

    try {
      const server = bun.serve({
        hostname: host,
        port,
        fetch: (request) => handleBunRequest(request, { cwd: options.cwd, token, staticRoot })
      });

      return {
        host,
        port: server.port,
        url: `http://${host}:${server.port}/?token=${encodeURIComponent(token)}`,
        token,
        staticRoot,
        close: async () => {
          await server.stop(true);
        }
      };
    } catch (error) {
      lastError = error;

      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function handleBunRequest(
  request: Request,
  context: { cwd?: string; token: string; staticRoot: string }
): Promise<Response> {
  try {
    const url = new URL(request.url);

    if (url.pathname === "/api/memory" && request.method === "GET") {
      return jsonResponse(200, await buildUiMemoryModel(context.cwd));
    }

    if (url.pathname.startsWith("/api/claims/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/claims/".length));
      return jsonResponse(200, getUiClaimDetail(context.cwd, id));
    }

    if (url.pathname.endsWith("/review") && url.pathname.startsWith("/api/claims/") && request.method === "PATCH") {
      requireTokenValue(request.headers.get("x-agent-memory-token"), context.token);
      const id = decodeURIComponent(url.pathname.slice("/api/claims/".length, -"/review".length));
      const body = await readRequestJson<{ status?: string; confidence?: string }>(request);

      return jsonResponse(
        200,
        await reviewClaim({
          cwd: context.cwd,
          id,
          status: body.status ?? "current",
          confidence: body.confidence
        })
      );
    }

    if (url.pathname === "/api/sync" && request.method === "POST") {
      requireTokenValue(request.headers.get("x-agent-memory-token"), context.token);
      return jsonResponse(200, await syncUiMemory(context.cwd));
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    return staticResponse(context.staticRoot, url.pathname);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: { cwd?: string; token: string; staticRoot: string }
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://agent-memory.local");

    if (url.pathname === "/api/memory" && request.method === "GET") {
      return sendJson(response, 200, await buildUiMemoryModel(context.cwd));
    }

    if (url.pathname.startsWith("/api/claims/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/claims/".length));
      return sendJson(response, 200, getUiClaimDetail(context.cwd, id));
    }

    if (url.pathname.endsWith("/review") && url.pathname.startsWith("/api/claims/") && request.method === "PATCH") {
      requireToken(request, context.token);
      const id = decodeURIComponent(url.pathname.slice("/api/claims/".length, -"/review".length));
      const body = await readJson<{ status?: string; confidence?: string }>(request);

      return sendJson(
        response,
        200,
        await reviewClaim({
          cwd: context.cwd,
          id,
          status: body.status ?? "current",
          confidence: body.confidence
        })
      );
    }

    if (url.pathname === "/api/sync" && request.method === "POST") {
      requireToken(request, context.token);
      return sendJson(response, 200, await syncUiMemory(context.cwd));
    }

    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    return serveStatic(response, context.staticRoot, url.pathname);
  } catch (error) {
    const agentMemoryError = toAgentMemoryError(error);
    sendJson(response, statusForError(agentMemoryError), {
      error: formatError(agentMemoryError),
      code: agentMemoryError.code,
      details: agentMemoryError.details
    });
  }
}

function requireToken(request: http.IncomingMessage, token: string): void {
  requireTokenValue(request.headers["x-agent-memory-token"], token);
}

function requireTokenValue(value: string | string[] | null | undefined, token: string): void {
  if (Array.isArray(value) ? !value.includes(token) : value !== token) {
    throw new AgentMemoryError("Missing or invalid UI session token.", {
      code: "FORBIDDEN"
    });
  }
}

function statusForError(error: AgentMemoryError): number {
  if (error.code === "FORBIDDEN") {
    return 403;
  }

  if (error.exitCode === 7) {
    return 404;
  }

  return 500;
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function errorResponse(error: unknown): Response {
  const agentMemoryError = toAgentMemoryError(error);

  return jsonResponse(statusForError(agentMemoryError), {
    error: formatError(agentMemoryError),
    code: agentMemoryError.code,
    details: agentMemoryError.details
  });
}

function sendJson(response: http.ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data, null, 2));
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw.length > 0 ? JSON.parse(raw) : {}) as T;
}

async function readRequestJson<T>(request: Request): Promise<T> {
  const raw = await request.text();
  return (raw.length > 0 ? JSON.parse(raw) : {}) as T;
}

function serveStatic(response: http.ServerResponse, staticRoot: string, requestPath: string): void {
  const resolved = resolveStaticFile(staticRoot, requestPath);

  if (resolved.status !== 200) {
    if (resolved.status === 403) {
      response.writeHead(403);
      response.end("Forbidden");
    } else {
      response.writeHead(404);
      response.end("Agent Memory UI assets were not found. Run `bun run build:web`.");
    }
    return;
  }

  response.writeHead(200, {
    "content-type": contentType(resolved.filePath),
    "cache-control": "no-store"
  });
  fs.createReadStream(resolved.filePath).pipe(response);
}

function staticResponse(staticRoot: string, requestPath: string): Response {
  const resolved = resolveStaticFile(staticRoot, requestPath);

  if (resolved.status !== 200) {
    return resolved.status === 403
      ? new Response("Forbidden", { status: 403 })
      : new Response("Agent Memory UI assets were not found. Run `bun run build:web`.", { status: 404 });
  }

  return new Response(fs.readFileSync(resolved.filePath), {
    status: 200,
    headers: {
      "content-type": contentType(resolved.filePath),
      "cache-control": "no-store"
    }
  });
}

function resolveStaticFile(
  staticRoot: string,
  requestPath: string
): { status: 200; filePath: string } | { status: 403 | 404 } {
  const root = path.resolve(staticRoot);
  const safePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const absolutePath = path.resolve(root, safePath);
  const relative = path.relative(root, absolutePath);
  const fallbackPath = path.join(root, "index.html");

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { status: 403 };
  }

  const filePath = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile() ? absolutePath : fallbackPath;

  if (!fs.existsSync(filePath)) {
    return { status: 404 };
  }

  return { status: 200, filePath };
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  return "application/octet-stream";
}

function listen(server: http.Server, host: string, requestedPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const startPort = requestedPort === 0 ? randomEphemeralPort() : requestedPort;

    const tryPort = (port: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        if (error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }

        reject(error);
      };

      server.once("error", onError);

      server.listen(port, host, () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    };

    tryPort(startPort);
  });
}

function randomEphemeralPort(): number {
  return 45000 + Math.floor(Math.random() * 1000);
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ("code" in error ? (error as { code?: string }).code === "EADDRINUSE" : String(error).includes("EADDRINUSE"))
  );
}

function bunRuntime(): BunRuntime | undefined {
  const runtime = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  return typeof runtime?.serve === "function" ? runtime : undefined;
}

function defaultStaticRoot(): string {
  const coreSourceDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(coreSourceDir, "web"),
    path.resolve(coreSourceDir, "../../../dist/web"),
    path.resolve(coreSourceDir, "../../web/dist"),
    path.join(path.dirname(process.argv[1] ?? ""), "web"),
    path.resolve("dist/web"),
    path.resolve("packages/web/dist")
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
