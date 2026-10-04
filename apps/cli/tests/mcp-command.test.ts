import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import stream from "node:stream";
import { ompHarness } from "@resin/adapter-omp";
import type { McpStdioShimOptions } from "@resin/gateway";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { getErrorReporter } from "@resin/observer/error-reporting/core";
import { describe, expect, it, vi } from "vitest";
import {
  mcpCommand,
  parseMcpArgs,
  printMcpHelp,
  servedHarnessDefinition,
} from "../src/commands/mcp.js";

describe("resin mcp command", () => {
  it("defaults a bare invocation to the in-process gateway", () => {
    expect(parseMcpArgs([])).toMatchObject({
      standaloneMode: true,
      standaloneFallback: true,
      enableToolSearch: false,
      socketPath: undefined,
    });
  });

  it("requires daemon mode only when explicitly requested", () => {
    expect(parseMcpArgs(["--no-standalone"])).toMatchObject({
      standaloneMode: false,
      standaloneFallback: false,
    });
    expect(parseMcpArgs(["--socket", "/tmp/resin.sock"])).toMatchObject({
      standaloneMode: false,
      standaloneFallback: true,
      socketPath: "/tmp/resin.sock",
    });
  });

  it("documents explicit tool search opt-in", () => {
    expect(parseMcpArgs(["--enable-tool-search"]).enableToolSearch).toBe(true);
    let help = "";
    printMcpHelp({
      write: (chunk) => {
        help += chunk;
        return true;
      },
    });
    expect(help).toContain("--enable-tool-search");
    expect(help).toContain("disabled by default");
    expect(help).toContain("--full-catalog");
    expect(help).toContain("--search-listing");
    expect(help).toContain("--cwd");
  });

  it("parses full catalog opt-out", () => {
    expect(parseMcpArgs([]).fullCatalog).toBe(false);
    expect(parseMcpArgs(["--full-catalog"]).fullCatalog).toBe(true);
  });

  it("preserves --cwd across arguments parsing and propagates to shim", async () => {
    expect(parseMcpArgs(["--cwd", "/custom/work/dir"]).cwd).toBe("/custom/work/dir");
    expect(parseMcpArgs(["-C", "/short/work/dir"]).cwd).toBe("/short/work/dir");
    await expect(
      mcpCommand(["--cwd", "/custom/work/dir"], {
        shimFactory: (options) => {
          expect(options.cwd).toBe("/custom/work/dir");
          return { start: async () => ({ mode: "daemon_ipc" }), stop: async () => {} };
        },
      }),
    ).resolves.toBe(0);
  });

  it.each([false, true])("propagates fullCatalog=%s to the shim", async (full) => {
    await expect(
      mcpCommand(full ? ["--full-catalog"] : [], {
        shimFactory: (options) => {
          expect(options.fullCatalog).toBe(full);
          return { start: async () => ({ mode: "daemon_ipc" }), stop: async () => {} };
        },
      }),
    ).resolves.toBe(0);
  });
  it.each([false, true])("propagates enableToolSearch=%s to the shim", async (enabled) => {
    await expect(
      mcpCommand(enabled ? ["--enable-tool-search"] : [], {
        shimFactory: (options) => {
          expect(options.enableToolSearch).toBe(enabled);
          return { start: async () => ({ mode: "daemon_ipc" }), stop: async () => {} };
        },
      }),
    ).resolves.toBe(0);
  });
  it("accepts the retired --search-listing flag as the default listing", () => {
    expect(parseMcpArgs(["--search-listing"])).toEqual(parseMcpArgs([]));
    expect(parseMcpArgs(["--search-listing", "--full-catalog"]).fullCatalog).toBe(true);
  });

  it("starts a bare invocation without selecting the daemon socket", async () => {
    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();
    let socketPath: string | undefined;
    let maxStartupAttempts: number | undefined;

    const result = mcpCommand([], {
      stdin,
      stdout,
      stderr,
      shimFactory: (options) => {
        socketPath = options.socketPath;
        maxStartupAttempts = options.maxStartupAttempts;
        return {
          start: async () => ({ mode: "standalone_inprocess" }),
          stop: async () => {},
        };
      },
    });

    queueMicrotask(() => stdin.end());

    await expect(result).resolves.toBe(0);
    expect(socketPath).toBe("");
    expect(maxStartupAttempts).toBe(0);
  });

  it("ends a standalone session when the shim stops before stdin ends", async () => {
    const stdin = new stream.PassThrough();
    let stopped = false;
    await expect(
      mcpCommand([], {
        stdin,
        stdout: new stream.PassThrough(),
        stderr: new stream.PassThrough(),
        shimFactory: () => ({
          start: async () => ({ mode: "standalone_inprocess" }),
          closed: async () => "harness_closed",
          stop: async () => {
            stopped = true;
          },
        }),
      }),
    ).resolves.toBe(0);
    expect(stopped).toBe(true);
  });

  it.each([
    ["harness_closed", 0],
    ["daemon_closed", 0],
    ["stream_error", 1],
  ] as const)("exits a daemon session that ended with %s with code %i", async (reason, code) => {
    await expect(
      mcpCommand(["--no-standalone"], {
        stderr: new stream.PassThrough(),
        shimFactory: () => ({
          start: async () => ({ mode: "daemon_ipc" }),
          closed: async () => reason,
          stop: async () => {},
        }),
      }),
    ).resolves.toBe(code);
  });

  it("exits 0 without crashing when the harness closes stdout mid-session", async () => {
    const capture = vi.spyOn(getErrorReporter(), "captureException");
    const daemon = await listen("resin-cli-daemon");
    const harness = await listen("resin-cli-harness");
    // The harness's stdout pipe: the shim only writes to it, as to `process.stdout` on a pipe.
    const stdout = net.connect({ path: harness.socketPath, allowHalfOpen: true });
    stdout.pause();
    await once(stdout, "connect");
    const harnessEnd = await harness.connection(0);
    try {
      const session = mcpCommand(["--socket", daemon.socketPath, "--no-standalone"], {
        stdin: new stream.PassThrough(),
        stdout,
        stderr: new stream.PassThrough(),
      });
      // The reachability probe is the first daemon connection; the bridge is the second.
      const daemonEnd = await daemon.connection(1);
      harnessEnd.destroy();
      await once(harnessEnd, "close");
      daemonEnd.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })}\n`);

      // The shim hangs up on the daemon and the session ends cleanly instead of an EPIPE crash.
      await once(daemonEnd, "close");
      await expect(session).resolves.toBe(0);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
      stdout.destroy();
      daemon.server.close();
      harness.server.close();
    }
  });
});

describe("the harness a resin mcp shim serves", () => {
  async function shimOptionsFor(args: string[]): Promise<McpStdioShimOptions> {
    let captured: McpStdioShimOptions | undefined;
    await expect(
      mcpCommand(args, {
        shimFactory: (options) => {
          captured = options;
          return { start: async () => ({ mode: "daemon_ipc" }), stop: async () => {} };
        },
      }),
    ).resolves.toBe(0);
    if (captured === undefined) throw new Error("the shim was never created");
    return captured;
  }

  it("runs native tool steps through OMP when started as plain `resin mcp`, as OMP registers it", async () => {
    const options = await shimOptionsFor([]);

    expect(options.harnessId).toBeUndefined();
    expect(options.recordedHarnessToolInvoker).toBe(ompHarness.nativeToolInvoker);
    expect(options.recordedWorkflowConnections).toBeTypeOf("function");
  });

  it("keeps an explicit --harness: OMP's invoker for omp, none for a harness without one", async () => {
    const omp = await shimOptionsFor(["--harness", "omp"]);
    expect(omp.harnessId).toBe("omp");
    expect(omp.recordedHarnessToolInvoker).toBe(ompHarness.nativeToolInvoker);
    expect(omp.recordedWorkflowConnections).toBeTypeOf("function");

    const codex = await shimOptionsFor(["--harness=codex-cli"]);
    expect(codex.harnessId).toBe("codex-cli");
    expect(codex).not.toHaveProperty("recordedHarnessToolInvoker");
    expect(codex.recordedWorkflowConnections).toBeUndefined();

    const unknown = await shimOptionsFor(["-H", "not-a-harness"]);
    expect(unknown).not.toHaveProperty("recordedHarnessToolInvoker");
    expect(unknown.recordedWorkflowConnections).toBeUndefined();
  });

  it("falls back to the first harness declaring its servers, for connections and invoker alike", () => {
    const { resolveMcpServer: _servers, ...invokerOnly } = ompHarness;
    const { nativeToolInvoker: _invoker, ...serversOnly } = ompHarness;
    const definitions: HarnessDefinition[] = [
      { ...invokerOnly, id: "invoker-only" },
      { ...serversOnly, id: "servers-only" },
      ompHarness,
    ];

    // The invoker comes from the harness whose servers are dialed, never from another one.
    expect(servedHarnessDefinition(undefined, definitions)?.id).toBe("servers-only");
    expect(servedHarnessDefinition("invoker-only", definitions)?.id).toBe("invoker-only");
    expect(servedHarnessDefinition("missing", definitions)).toBeUndefined();
  });
});

interface Peer {
  readonly server: net.Server;
  readonly socketPath: string;
  /** The server-side end of the `index`-th accepted connection. */
  connection(index: number): Promise<net.Socket>;
}

async function listen(prefix: string): Promise<Peer> {
  const name = `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const socketPath =
    process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const accepted: Array<PromiseWithResolvers<net.Socket>> = [];
  const slot = (index: number) => {
    while (accepted.length <= index) accepted.push(Promise.withResolvers<net.Socket>());
    return accepted[index] as PromiseWithResolvers<net.Socket>;
  };
  let count = 0;
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    slot(count++).resolve(socket);
  });
  server.listen(socketPath);
  await once(server, "listening");
  return { server, socketPath, connection: (index) => slot(index).promise };
}
