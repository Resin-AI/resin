import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import stream from "node:stream";
import { getErrorReporter } from "@resin/observer/error-reporting/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import { encodeMcpMessage } from "../src/protocol/framing.js";
import type { GatewayRouter } from "../src/router.js";
import { McpStdioShim, isPeerClosedError } from "../src/shim/stdio-bridge.js";

// The shim talks to real OS sockets here: the harness's end of stdout and the daemon's end of the
// IPC socket are closed by the peer, exactly as when a harness ends its session or a daemon goes away.

function uniqueSocketPath(prefix: string): string {
  const name = `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}

interface Peer {
  readonly server: net.Server;
  readonly socketPath: string;
  /** The server-side end of the `index`-th accepted connection. */
  connection(index: number): Promise<net.Socket>;
}

async function listen(prefix: string): Promise<Peer> {
  const socketPath = uniqueSocketPath(prefix);
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

/**
 * A harness's stdout pipe as the shim sees it: a socket the shim only writes to and never reads,
 * like `process.stdout` on a pipe, with the harness holding the other end.
 */
async function harnessStdout(): Promise<{
  stdout: net.Socket;
  harnessEnd: net.Socket;
  peer: Peer;
}> {
  const peer = await listen("resin-harness");
  const stdout = net.connect({ path: peer.socketPath, allowHalfOpen: true });
  stdout.pause();
  await once(stdout, "connect");
  const harnessEnd = await peer.connection(0);
  return { stdout, harnessEnd, peer };
}

const request = encodeMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const response = encodeMcpMessage({ jsonrpc: "2.0", id: 1, result: { tools: [] } });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

async function startBridgedShim(stdout: NodeJS.WritableStream) {
  const daemon = await listen("resin-daemon");
  const stdin = new stream.PassThrough();
  const shim = new McpStdioShim({
    socketPath: daemon.socketPath,
    standaloneFallback: false,
    maxStartupAttempts: 0,
    stdin,
    stdout,
    stderr: new stream.PassThrough(),
  });
  cleanups.push(() => {
    void shim.stop();
    daemon.server.close();
  });
  const status = await shim.start();
  expect(status.mode).toBe("daemon_ipc");
  // The reachability probe was the first connection; the bridge is the second.
  const daemonEnd = await daemon.connection(1);
  return { shim, stdin, daemonEnd };
}

/**
 * A standalone shim whose catalog listing is held open until `answer()`, so the test decides what
 * the harness's end looks like when the gateway's response is written.
 */
async function startStandaloneShim(stdout: NodeJS.WritableStream) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shim-stream-"));
  const stdin = new stream.PassThrough();
  const { promise: listing, resolve: listed } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const router: GatewayRouter = {
    listTools: async () => {
      listed();
      await released;
      return [{ name: "manage_tools", inputSchema: { type: "object" } }];
    },
    callTool: async () => ({ content: [] }),
  };
  const handled = vi.spyOn(LocalMcpGateway.prototype, "handleMessage");
  const shim = new McpStdioShim({
    socketPath: "",
    standaloneFallback: true,
    maxStartupAttempts: 0,
    home,
    resinHome: path.join(home, ".resin"),
    router,
    stdin,
    stdout,
    stderr: new stream.PassThrough(),
    cwd: os.tmpdir(),
  });
  cleanups.push(() => {
    void shim.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const status = await shim.start();
  expect(status.mode).toBe("standalone_inprocess");
  stdin.write(
    encodeMcpMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-client", version: "1.0.0" },
        capabilities: {},
      },
    }),
  );
  stdin.write(request);
  /** Lets the listing finish and returns once the gateway has written its answer. */
  const answer = async () => {
    release();
    // `tools/list` is the second message handled; the gateway writes as soon as it settles.
    await handled.mock.results[1]?.value;
    // A stream reports a failed write on the next tick.
    await new Promise<void>((resolve) => process.nextTick(resolve));
  };
  return { shim, listing, answer };
}

describe("MCP shim when a peer closes", () => {
  it("shuts down cleanly when the harness closes stdout while a daemon response is written", async () => {
    const capture = vi.spyOn(getErrorReporter(), "captureException");
    const { stdout, harnessEnd, peer } = await harnessStdout();
    cleanups.push(() => {
      stdout.destroy();
      peer.server.close();
    });
    const { shim, daemonEnd } = await startBridgedShim(stdout);

    harnessEnd.destroy();
    await once(harnessEnd, "close");
    daemonEnd.write(response);

    // The shim hangs up on the daemon instead of crashing on the harness's EPIPE.
    await once(daemonEnd, "close");
    await expect(shim.closed()).resolves.toBe("harness_closed");
    expect(capture).not.toHaveBeenCalled();
  });

  it("shuts down cleanly when the daemon closes while a harness request is written", async () => {
    const capture = vi.spyOn(getErrorReporter(), "captureException");
    const written: string[] = [];
    const stdout = new stream.Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk.toString("utf8"));
        callback();
      },
    });
    const { shim, stdin, daemonEnd } = await startBridgedShim(stdout);

    daemonEnd.destroy();
    stdin.write(request);

    await expect(shim.closed()).resolves.toBe("daemon_closed");
    expect(capture).not.toHaveBeenCalled();
    // Nothing but protocol traffic ever reaches stdout, and there was none to relay.
    expect(written).toEqual([]);
  });

  it("shuts down cleanly when the harness closes stdout before an in-process answer", async () => {
    const capture = vi.spyOn(getErrorReporter(), "captureException");
    const { stdout, harnessEnd, peer } = await harnessStdout();
    cleanups.push(() => {
      stdout.destroy();
      peer.server.close();
    });
    const { shim, listing, answer } = await startStandaloneShim(stdout);

    await listing;
    harnessEnd.destroy();
    await once(harnessEnd, "close");
    await answer();

    await expect(shim.closed()).resolves.toBe("harness_closed");
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not crash when the in-process gateway answers after the shim stopped", async () => {
    const capture = vi.spyOn(getErrorReporter(), "captureException");
    const { shim, listing, answer } = await startStandaloneShim(new stream.PassThrough());

    await listing;
    await shim.stop();
    await answer();

    await expect(shim.closed()).resolves.toBe("stopped");
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports an unexpected stdout failure as a handled error with its code and stops", async () => {
    const capture = vi.spyOn(getErrorReporter(), "captureException");
    const failure = Object.assign(new Error("i/o failure"), { code: "EIO" });
    const stdout = new stream.Writable({
      write(_chunk, _encoding, callback) {
        callback(failure);
      },
    });
    const { shim, daemonEnd } = await startBridgedShim(stdout);

    daemonEnd.write(response);

    await expect(shim.closed()).resolves.toBe("stream_error");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ handled: true, failureClass: "mcp_shim_stream" }),
    );
  });
});

describe("isPeerClosedError", () => {
  it.each(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE", "EOF"])(
    "treats %s as the peer closing",
    (code) => {
      expect(isPeerClosedError(Object.assign(new Error(code), { code }))).toBe(true);
    },
  );

  it.each([new Error("no code"), Object.assign(new Error("io"), { code: "EIO" }), "EPIPE"])(
    "treats %s as unexpected",
    (error) => {
      expect(isPeerClosedError(error)).toBe(false);
    },
  );
});
