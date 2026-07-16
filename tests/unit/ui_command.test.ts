import { describe, expect, test } from "bun:test";
import { AgentMemoryError } from "../../packages/core/src/errors";
import type { UiServerHandle, UiServerOptions } from "../../packages/core/src/ui_server";
import { runUiCommand } from "../../packages/cli/src/commands/ui";

const server: UiServerHandle = {
  host: "0.0.0.0",
  port: 4321,
  url: "http://0.0.0.0:4321/?token=test-token",
  token: "test-token",
  staticRoot: "/tmp/agent-memory-web",
  close: async () => undefined
};

describe("ui command", () => {
  test("passes explicit host and port options to the server and renders text output", async () => {
    let received: UiServerOptions | undefined;
    const result = await runUiCommand(["--host", "0.0.0.0", "--port", "4321"], {
      cwd: "/tmp/example",
      startServer: async (options) => {
        received = options;
        return server;
      }
    });

    expect(received).toEqual({ cwd: "/tmp/example", host: "0.0.0.0", port: 4321 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent Memory UI running.");
    expect(result.stdout).toContain(`URL: ${server.url}`);
    expect(result.stdout).toContain(`Session token: ${server.token}`);
    expect(result.stdout).toContain(`Static assets: ${server.staticRoot}`);
  });

  test("supports equals options, ephemeral ports, and machine-readable output", async () => {
    let received: UiServerOptions | undefined;
    const result = await runUiCommand(["--host=localhost", "--port=0", "--json"], {
      startServer: async (options) => {
        received = options;
        return server;
      }
    });

    expect(received).toEqual({ cwd: undefined, host: "localhost", port: 0 });
    expect(JSON.parse(result.stdout)).toEqual({
      url: server.url,
      host: server.host,
      port: server.port,
      token: server.token,
      staticRoot: server.staticRoot
    });
  });

  test("uses deterministic defaults", async () => {
    let received: UiServerOptions | undefined;
    await runUiCommand([], {
      startServer: async (options) => {
        received = options;
        return server;
      }
    });

    expect(received).toEqual({ cwd: undefined, host: "127.0.0.1", port: 4317 });
  });

  test.each([
    { args: ["--wat"], message: "Unknown ui option: --wat" },
    { args: ["--host"], message: "--host requires a value." },
    { args: ["--port"], message: "--port requires a value." },
    { args: ["--port=1.5"], message: "Invalid ui port: 1.5" },
    { args: ["--port=-1"], message: "Invalid ui port: -1" },
    { args: ["--port=65536"], message: "Invalid ui port: 65536" },
    { args: ["--port=nope"], message: "Invalid ui port: nope" }
  ])("rejects invalid arguments: $message", async ({ args, message }) => {
    expect(runUiCommand(args, { startServer: async () => server })).rejects.toEqual(
      expect.objectContaining<Partial<AgentMemoryError>>({ message })
    );
  });
});
