import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import stream from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/bin/mcp-shim.js";
import type { LocalMcpGateway } from "../src/gateway.js";
import { RESIN_LEARNED_TOOL_META } from "../src/protocol/types.js";
import { ManagedToolAccess } from "../src/proxy/tool-access.js";
import type { GatewayRouter } from "../src/router.js";
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shim-home-"));

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const shim = new McpStdioShim({
      socketPath: nonExistentSocket,
      standaloneFallback: true,
      maxStartupAttempts: 0,
      home,
      resinHome: path.join(home, ".resin"),
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
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Windows refuses to delete a file some process still holds open: a database handle kept past
  // stop() pins the user's home against `resin uninstall` for as long as the host lives.
  it("releases the home's database handles on stop, so the home can be deleted", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shim-release-"));
    const close = vi.spyOn(ManagedToolAccess.prototype, "close");
    const shim = new McpStdioShim({
      socketPath: path.join(os.tmpdir(), `test-absent-release-${Date.now()}.sock`),
      standaloneFallback: true,
      maxStartupAttempts: 0,
      home,
      resinHome: path.join(home, ".resin"),
      stdin: new stream.PassThrough(),
      stdout: new stream.PassThrough(),
      stderr: new stream.PassThrough(),
    });
    try {
      await shim.start();
      const accessDb = path.join(home, ".resin", "state", "managed-tool-access", "tool-access.db");
      expect(fs.existsSync(accessDb)).toBe(true);
      await shim.stop();
      fs.rmSync(home, { recursive: true });
      expect(fs.existsSync(home)).toBe(false);
      // POSIX deletes open files, so only the close itself shows the release there.
      expect(close).toHaveBeenCalled();
    } finally {
      close.mockRestore();
    }
  });

  it.each([false, true])(
    "standalone catalog without learned tools lists only invoke_tool (enableToolSearch=%s)",
    async (enabled) => {
      const nonExistentSocket = path.join(
        os.tmpdir(),
        `test-absent-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
      );
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shim-home-"));
      const stdin = new stream.PassThrough();
      const stdout = new stream.PassThrough();
      const stderr = new stream.PassThrough();

      const shim = new McpStdioShim({
        enableToolSearch: enabled,
        socketPath: nonExistentSocket,
        standaloneFallback: true,
        maxStartupAttempts: 0,
        home,
        resinHome: path.join(home, ".resin"),
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
        expect(toolNames).toEqual(["invoke_tool"]);
        expect(toolNames).not.toContain("echo");
        expect(toolNames).not.toContain("workspace_info");
        expect(toolNames).not.toContain("fail_tool");
        expect(toolNames).not.toContain("slow_tool");
      } finally {
        await shim.stop();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  // `resin init` registers OMP as plain `resin mcp`; the harness is known only from the client name.
  async function withOmpHome(
    body: (home: { root: string; appendSystem: string }) => Promise<void>,
  ): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shim-omp-"));
    const appendSystem = path.join(root, ".omp", "agent", "APPEND_SYSTEM.md");
    fs.mkdirSync(path.dirname(appendSystem), { recursive: true });
    const previousOmpHome = process.env.RESIN_OMP_HOME;
    process.env.RESIN_OMP_HOME = path.join(root, ".omp");
    try {
      await body({ root, appendSystem });
    } finally {
      if (previousOmpHome === undefined) delete process.env.RESIN_OMP_HOME;
      else process.env.RESIN_OMP_HOME = previousOmpHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  /** Connects an OMP client to a standalone shim and returns once the connection is initialized. */
  async function connectOmp(
    root: string,
    router?: GatewayRouter,
    fullCatalog = false,
  ): Promise<McpStdioShim> {
    const stdin = new stream.PassThrough();
    const shim = new McpStdioShim({
      fullCatalog,
      socketPath: path.join(os.tmpdir(), `test-absent-omp-${Date.now()}-${Math.random()}.sock`),
      standaloneFallback: true,
      maxStartupAttempts: 0,
      home: root,
      resinHome: path.join(root, ".resin"),
      ...(router === undefined ? {} : { router }),
      stdin,
      stdout: new stream.PassThrough(),
      stderr: new stream.PassThrough(),
      cwd: os.tmpdir(),
    });
    await shim.start();
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "omp-coding-agent", version: "18.3.5" },
          capabilities: {},
        },
      })}\n`,
    );
    const gateway = (shim as unknown as { activeGateway: LocalMcpGateway }).activeGateway;
    await expect.poll(() => gateway.getAllConnections()[0]?.isInitialized).toBe(true);
    expect(gateway.getAllConnections()[0]!.harnessId).toBe("omp");
    return shim;
  }

  function learnedToolsRouter(tools: Array<{ name: string; description: string }>): GatewayRouter {
    return {
      listTools: async () => [
        { name: "manage_tools", inputSchema: { type: "object" } },
        ...tools.map((tool) => ({
          ...tool,
          inputSchema: { type: "object" as const },
          _meta: { [RESIN_LEARNED_TOOL_META]: true },
        })),
      ],
      callTool: async () => ({ content: [] }),
    };
  }

  it.each([
    { catalog: "an empty catalog", tools: [] },
    {
      catalog: "learned tools",
      tools: [{ name: "fast_lint", description: "Lints the workspace." }],
    },
  ])(
    "drops a stale OMP learned-tool block when OMP connects by default to $catalog",
    async ({ tools }) => {
      // The default listing is search-only, so OMP's prompt carries no per-tool block.
      await withOmpHome(async ({ root, appendSystem }) => {
        fs.writeFileSync(
          appendSystem,
          "User notes\n<!-- resin:catalog:start -->\n### `retired_tool`\n<!-- resin:catalog:end -->\n",
        );
        const shim = await connectOmp(
          root,
          tools.length === 0 ? undefined : learnedToolsRouter(tools),
        );
        try {
          await expect.poll(() => fs.readFileSync(appendSystem, "utf8")).toBe("User notes\n");
        } finally {
          await shim.stop();
        }
      });
    },
    30_000,
  );

  it("lists exactly the current learned tools when OMP connects with --full-catalog, and leaves an identical block alone", async () => {
    await withOmpHome(async ({ root, appendSystem }) => {
      fs.writeFileSync(
        appendSystem,
        "User notes\n<!-- resin:catalog:start -->\n### `retired_tool`\n<!-- resin:catalog:end -->\n",
      );
      const router = learnedToolsRouter([
        { name: "fast_lint", description: "Lints the workspace." },
        { name: "fast_build", description: "Builds the workspace." },
      ]);
      const headings = () =>
        [...fs.readFileSync(appendSystem, "utf8").matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]);

      const first = await connectOmp(root, router, true);
      try {
        await expect.poll(headings).toEqual(["fast_lint", "fast_build"]);
        expect(fs.readFileSync(appendSystem, "utf8").startsWith("User notes\n")).toBe(true);
      } finally {
        await first.stop();
      }

      // Back-date the file so any rewrite would move its mtime.
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(appendSystem, past, past);
      const before = fs.statSync(appendSystem).mtimeMs;
      const contentBefore = fs.readFileSync(appendSystem, "utf8");

      const second = await connectOmp(root, router, true);
      try {
        // An unchanged block leaves no observable signal to await, so give the connect-time sync a
        // real moment to finish before checking it wrote nothing.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(fs.statSync(appendSystem).mtimeMs).toBe(before);
        expect(fs.readFileSync(appendSystem, "utf8")).toBe(contentBefore);
      } finally {
        await second.stop();
      }
    });
  }, 30_000);

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
    const socketName = `test-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Windows reaches the daemon only through a local named pipe (verified before use).
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${socketName}`
        : path.join(os.tmpdir(), `${socketName}.sock`);

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
