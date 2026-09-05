import net from "node:net";
import os from "node:os";
import path from "node:path";
import stream from "node:stream";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/bin/mcp-shim.js";
import { McpStdioShim, checkDaemonReachable } from "../src/shim/stdio-bridge.js";

describe("Stdio Shim & Bridge Lifecycle", () => {
  it("parses CLI flags accurately", () => {
    expect(parseArgs([]).enableToolSearch).toBe(false);
    expect(parseArgs(["--enable-tool-search"]).enableToolSearch).toBe(true);
    const args1 = parseArgs(["--standalone", "--cwd", "/custom/dir", "--harness", "claude"]);
    expect(args1.standaloneFallback).toBe(true);
    expect(args1.cwd).toBe("/custom/dir");
    expect(args1.harnessId).toBe("claude");

    const args2 = parseArgs(["--no-standalone", "--socket", "/tmp/custom.sock"]);
    expect(args2.standaloneFallback).toBe(false);
    expect(args2.socketPath).toBe("/tmp/custom.sock");

    const args3 = parseArgs(["--help"]);
    expect(args3.showHelp).toBe(true);

    const args4 = parseArgs(["-h"]);
    expect(args4.showHelp).toBe(true);
  });
  it("detects absent daemon and starts in standalone mode by default", async () => {
    const nonExistentSocket = path.join(os.tmpdir(), `test-nonexistent-${Date.now()}.sock`);

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const shim = new McpStdioShim({
      socketPath: nonExistentSocket,
      standaloneFallback: true,
      maxStartupAttempts: 0,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("standalone_inprocess");
      expect(status.daemonReachable).toBe(false);
    } finally {
      await shim.stop();
    }
  });

  it.each([false, true])("standalone catalog respects enableToolSearch=%s", async (enabled) => {
    const nonExistentSocket = path.join(
      os.tmpdir(),
      `test-absent-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const shim = new McpStdioShim({
      enableToolSearch: enabled,
      socketPath: nonExistentSocket,
      standaloneFallback: true,
      maxStartupAttempts: 0,
      stdin,
      stdout,
      stderr,
      cwd: os.tmpdir(),
    });

    const { promise: listResultPromise, resolve: resolveListResult } =
      Promise.withResolvers<Array<{ name: string }>>();
    let accumulated = "";

    stdout.on("data", (chunk: Buffer) => {
      accumulated += chunk.toString("utf-8");
      const lines = accumulated.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 2 && parsed.result?.tools) {
            resolveListResult(parsed.result.tools);
          }
        } catch {
          // Incomplete JSON line yet
        }
      }
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("standalone_inprocess");

      // 1. Send MCP initialize
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test-client", version: "1.0.0" },
            capabilities: {},
          },
        })}\n`,
      );

      // 2. Send MCP tools/list
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        })}\n`,
      );

      const tools = await listResultPromise;
      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames).toEqual(
        enabled
          ? ["get_tool_schema", "invoke_tool", "manage_tools", "search_tools"]
          : ["get_tool_schema", "invoke_tool", "manage_tools"],
      );
      expect(toolNames).not.toContain("echo");
      expect(toolNames).not.toContain("workspace_info");
      expect(toolNames).not.toContain("fail_tool");
      expect(toolNames).not.toContain("slow_tool");
    } finally {
      await shim.stop();
    }
  });

  it("reports actionable error when daemon is absent and standalone fallback disabled", async () => {
    const nonExistentSocket = path.join(os.tmpdir(), `test-absent-${Date.now()}.sock`);

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    let stderrOutput = "";
    const stderr = new stream.Writable({
      write(chunk, _enc, cb) {
        stderrOutput += chunk.toString("utf8");
        cb();
      },
    });

    const shim = new McpStdioShim({
      socketPath: nonExistentSocket,
      standaloneFallback: false,
      maxStartupAttempts: 0,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("failed");
      expect(status.daemonReachable).toBe(false);
      expect(stderrOutput).toContain("resin daemon start");
      expect(stderrOutput).toContain("resin mcp --standalone");
    } finally {
      await shim.stop();
    }
  });

  it("bridges to daemon socket when daemon is active", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `test-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );

    // Mock daemon server
    const server = net.createServer((sock) => {
      sock.on("data", (data) => {
        // Echo back
        sock.write(data);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });

    const isReachable = await checkDaemonReachable(socketPath, 500);
    expect(isReachable).toBe(true);

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const shim = new McpStdioShim({
      socketPath,
      standaloneFallback: false,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("daemon_ipc");
      expect(status.daemonReachable).toBe(true);
    } finally {
      await shim.stop();
      server.close();
    }
  });
});
