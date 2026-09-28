import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { currentUserSid, readPipeAcl } from "@resin/windows-security";
import {
  PROBE_ACCESS,
  probeOpenWithUserSidDisabled,
  squatPipeForTesting,
} from "@resin/windows-security/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type DaemonConfig, DaemonConfigSchema } from "../src/config.js";
import { IpcClient } from "../src/ipc/client.js";
import { FrameDecoder, MAX_FRAME_SIZE, encodeFrame } from "../src/ipc/framing.js";
import { openDaemonConnection } from "../src/ipc/pipe-trust.js";
import { IPC_ERROR_CODES, type IpcRequest, type IpcResponse } from "../src/ipc/protocol.js";
import { IpcServer, assertUnixSocketPathFits } from "../src/ipc/server.js";
import { createInMemoryIpcPair } from "../src/ipc/transport.js";
import type { DaemonModule, ModuleContext, ModuleLifecycleState } from "../src/lifecycle.js";
import type { JsonObject } from "../src/normalization/redaction.js";
import { DaemonSupervisor } from "../src/supervisor.js";

function createDummyModule(id: string): DaemonModule {
  let state: ModuleLifecycleState = "uninitialized";
  return {
    id,
    name: `Dummy ${id}`,
    getState: () => state,
    start: async () => {
      state = "ready";
    },
    stop: async () => {
      state = "stopped";
    },
    getDiagnostics: async () => ({ status: "ok" }),
  };
}

describe("ipc", () => {
  describe("Framing and Stream Decoder", () => {
    it("encodes and decodes a single frame", () => {
      const message = { id: "123", method: "ping", params: { nonce: "abc" } };
      const frame = encodeFrame(message);
      expect(frame.length).toBeGreaterThan(4);

      const decoder = new FrameDecoder();
      const decoded = decoder.push(frame);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toEqual(message);
    });

    it("decodes multiple frames received in a single chunk", () => {
      const msg1 = { id: "1", method: "ping" };
      const msg2 = { id: "2", method: "getHealth" };

      const frame1 = encodeFrame(msg1);
      const frame2 = encodeFrame(msg2);
      const combined = Buffer.concat([frame1, frame2]);

      const decoder = new FrameDecoder();
      const decoded = decoder.push(combined);
      expect(decoded).toHaveLength(2);
      expect(decoded[0]).toEqual(msg1);
      expect(decoded[1]).toEqual(msg2);
    });

    it("decodes a frame fragmented across multiple chunks", () => {
      const message = { id: "frag-1", method: "getDiagnostics", data: "large-string-".repeat(100) };
      const frame = encodeFrame(message);

      const splitIndex = Math.floor(frame.length / 2);
      const chunk1 = frame.subarray(0, splitIndex);
      const chunk2 = frame.subarray(splitIndex);

      const decoder = new FrameDecoder();
      const decoded1 = decoder.push(chunk1);
      expect(decoded1).toHaveLength(0); // Incomplete

      const decoded2 = decoder.push(chunk2);
      expect(decoded2).toHaveLength(1);
      expect(decoded2[0]).toEqual(message);
    });

    it("rejects payloads exceeding maximum allowable frame size", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_FRAME_SIZE + 100, 0);

      const decoder = new FrameDecoder();
      expect(() => decoder.push(header)).toThrow(/exceeds limit/);
    });
  });

  describe("In-Memory Transport RPC Operations", () => {
    async function setupInMemoryIpc() {
      const config = DaemonConfigSchema.parse({
        logLevel: "silent",
        custom: {
          authToken: "test-token",
        },
      });
      const mod = createDummyModule("core");
      const supervisor = new DaemonSupervisor({ config, modules: [mod] });
      await supervisor.start();

      const server = new IpcServer({ supervisor });
      await server.start();

      const { serverTransport, clientTransport } = createInMemoryIpcPair();
      server.attachTransport(serverTransport);

      const client = new IpcClient({
        transport: clientTransport,
      });

      return { supervisor, server, client };
    }

    it("executes ping RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const res = await client.ping("test-nonce");
      expect(res.pong).toBe(true);
      expect(res.nonce).toBe("test-nonce");
      expect(res.timestamp).toBeGreaterThan(0);

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes getHealth RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const health = await client.getHealth();
      expect(health.status).toBe("fully-ready");
      expect(health.modules.core.status).toBe("ready");

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes getModuleStatus RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const statusList = await client.getModuleStatus();
      expect(statusList).toHaveLength(1);
      expect(statusList[0].id).toBe("core");
      expect(statusList[0].state).toBe("ready");

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes reloadConfig RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const reloadRes = await client.reloadConfig({ port: 9876 });
      expect(reloadRes.success).toBe(true);
      expect(supervisor.getConfig().port).toBe(9876);

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes getDiagnostics RPC method with secret redaction", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const diag = await client.getDiagnostics();
      expect((diag.config.custom as JsonObject).authToken).toBe("[REDACTED]");
      expect(diag.modules.core).toEqual({ status: "ok" });

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes gracefulShutdown RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const res = await client.gracefulShutdown({ reason: "test shutdown" });
      expect(res.accepted).toBe(true);

      // Wait a microtask cycle for shutdown to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(supervisor.currentState).toBe("stopped");

      await client.close();
      await server.stop();
    });
  });

  describe("Unix Domain Socket Transport", () => {
    it("refuses to start on a socket path longer than the platform can bind", async () => {
      if (process.platform === "win32") return;
      const tempDir = path.join(os.tmpdir(), `resin-ipc-long-${Date.now()}`, "x".repeat(120));
      const socketPath = path.join(tempDir, "daemon.sock");
      const config = DaemonConfigSchema.parse({ logLevel: "silent", socketPath });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();
      const server = new IpcServer({ supervisor, socketPath });
      await expect(server.start()).rejects.toThrow(/Unix socket limit.*RESIN_SOCKET_PATH/s);
      expect(server.listening).toBe(false);
      await supervisor.stop();
    });

    it("applies the macOS 103-byte limit where the macOS kernel would silently misbind", () => {
      const at = (bytes: number) => `/${"a".repeat(bytes - 1)}`;
      expect(() => assertUnixSocketPathFits(at(103), "darwin")).not.toThrow();
      expect(() => assertUnixSocketPathFits(at(104), "darwin")).toThrow(/103-byte/);
      expect(() => assertUnixSocketPathFits(at(107), "linux")).not.toThrow();
      expect(() => assertUnixSocketPathFits(at(108), "linux")).toThrow(/107-byte/);
    });

    it("communicates successfully over a real Unix domain socket file without credentials", async () => {
      const tempDir = path.join(os.tmpdir(), `resin-ipc-uds-${Date.now()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\resin-ipc-uds-${process.pid}-${Date.now()}`
          : path.join(tempDir, "daemon.sock");

      const config = DaemonConfigSchema.parse({
        logLevel: "silent",
        socketPath,
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
      });
      await server.start();

      const client = new IpcClient({
        socketPath,
      });

      await client.connect();
      expect(client.connected).toBe(true);

      const pingResult = await client.ping("uds-test-nonce");
      expect(pingResult.pong).toBe(true);
      expect(pingResult.nonce).toBe("uds-test-nonce");

      const health = await client.getHealth();
      expect(health.status).toBe("fully-ready");

      await client.close();
      await server.stop();
      await supervisor.stop();

      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    // Named pipes only: a forced close disconnects the client and discards what it has not read
    // yet, while a Unix socket keeps already-written bytes readable after the server closes.
    it.runIf(process.platform === "win32")(
      "delivers a reply written just before the IPC server stops",
      async () => {
        const socketPath = `\\\\.\\pipe\\resin-ipc-stop-reply-${process.pid}-${Date.now()}`;
        // Larger than the pipe buffer, so the write is still pending when stop() runs.
        const payload = "x".repeat(512 * 1024);
        let server: IpcServer | undefined;
        // SAFETY: Stub supervisor implementing the subset of DaemonSupervisor the IPC server calls.
        const supervisor = {
          getConfig() {
            return {};
          },
          async getDiagnostics() {
            // The daemon stops (an idle daemon does so at once) right after this reply is sent.
            setImmediate(() => void server?.stop());
            return { payload };
          },
        } as unknown as DaemonSupervisor;
        server = new IpcServer({ supervisor, socketPath });
        await server.start();
        const client = new IpcClient({ socketPath });
        try {
          await client.connect();
          await expect(client.getDiagnostics()).resolves.toEqual({ payload });
        } finally {
          await client.close();
          await server.stop();
        }
      },
    );

    it("connects and executes requests over local socket without credentials", async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uds-auth-test-"));
      const socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\uds-auth-test-${Date.now()}`
          : path.join(tempDir, "observer.sock");

      const config = DaemonConfigSchema.parse({
        instanceId: "uds-auth-test-inst",
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
      });
      await server.start();

      const client = new IpcClient({
        socketPath,
      });
      await client.connect();
      expect(client.connected).toBe(true);

      const res = await client.ping("unauthenticated-nonce");
      expect(res.pong).toBe(true);
      expect(res.nonce).toBe("unauthenticated-nonce");
      await client.close();

      await server.stop();
      await supervisor.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it.runIf(process.platform === "win32")(
      "serves Windows IPC over an owner-only pipe that other principals cannot open",
      async () => {
        const socketPath = `\\\\.\\pipe\\uds-acl-test-${process.pid}-${Date.now()}`;
        const supervisor = new DaemonSupervisor({
          config: DaemonConfigSchema.parse({ instanceId: "uds-acl-test-inst" }),
        });
        await supervisor.start();
        const server = new IpcServer({ supervisor, socketPath });
        await server.start();
        try {
          const sid = currentUserSid();
          const acl = readPipeAcl(socketPath);
          expect(acl.owner).toBe(sid);
          expect(acl.protected).toBe(true);
          expect(acl.entries.map((entry) => [entry.type, entry.sid])).toEqual([
            ["deny", "S-1-5-2"],
            ["allow", sid],
          ]);
          // Everyone, Users, Authenticated Users, INTERACTIVE, ... are all refused.
          expect(probeOpenWithUserSidDisabled(socketPath, PROBE_ACCESS.readWrite)).toEqual({
            ok: false,
            win32Error: 5,
          });
          // The connection a client talks over is the one whose server was verified.
          const verified = await openDaemonConnection(socketPath);
          expect(verified).toMatchObject({ serverPid: process.pid });
          verified.destroy();

          const client = new IpcClient({ socketPath });
          expect((await client.ping("pipe-acl")).nonce).toBe("pipe-acl");
          await client.close();

          // A second daemon never shares the name.
          const second = new IpcServer({ supervisor, socketPath });
          await expect(second.start()).rejects.toMatchObject({
            code: "EADDRINUSE",
            message: expect.stringContaining("Another Resin daemon for this user"),
          });
        } finally {
          await server.stop();
          await supervisor.stop();
        }
      },
    );

    it.runIf(process.platform === "win32")(
      "fails closed when another principal squats the daemon pipe name",
      async () => {
        const socketPath = `\\\\.\\pipe\\uds-squat-test-${process.pid}-${Date.now()}`;
        const squatter = squatPipeForTesting(socketPath, "D:P(A;;GA;;;SY)");
        const supervisor = new DaemonSupervisor({
          config: DaemonConfigSchema.parse({ instanceId: "uds-squat-test-inst" }),
        });
        await supervisor.start();
        try {
          const server = new IpcServer({ supervisor, socketPath });
          await expect(server.start()).rejects.toMatchObject({
            code: "EADDRINUSE",
            message: expect.stringContaining("held by another principal (access-denied)"),
          });
          expect(server.listening).toBe(false);

          await expect(openDaemonConnection(socketPath)).rejects.toMatchObject({
            code: IPC_ERROR_CODES.UNTRUSTED_SERVER,
            reason: "access-denied",
          });
          const client = new IpcClient({ socketPath, timeoutMs: 2_000 });
          await expect(client.ping()).rejects.toMatchObject({
            code: IPC_ERROR_CODES.UNTRUSTED_SERVER,
          });
          expect(client.connected).toBe(false);
        } finally {
          squatter.release();
          await supervisor.stop();
        }
      },
    );

    it.runIf(process.platform === "win32")(
      "refuses to serve or dial Windows IPC anywhere but a local named pipe",
      async () => {
        const supervisor = new DaemonSupervisor({
          config: DaemonConfigSchema.parse({ instanceId: "uds-path-test-inst" }),
        });
        const server = new IpcServer({
          supervisor,
          socketPath: path.join(os.tmpdir(), "observer.sock"),
        });
        await expect(server.start()).rejects.toThrow(/must be a local named pipe/);
        for (const target of [path.join(os.tmpdir(), "observer.sock"), "\\\\server\\pipe\\resin"]) {
          await expect(new IpcClient({ socketPath: target }).connect()).rejects.toMatchObject({
            code: IPC_ERROR_CODES.UNTRUSTED_SERVER,
          });
        }
      },
    );

    it.skipIf(process.platform === "win32")(
      "enforces strict filesystem permission bits (0o600) on POSIX domain socket",
      async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uds-perm-test-"));
        const socketPath = path.join(tempDir, "observer.sock");

        const config = DaemonConfigSchema.parse({
          instanceId: "uds-perm-test-inst",
        });
        const supervisor = new DaemonSupervisor({ config });
        await supervisor.start();

        const server = new IpcServer({
          supervisor,
          socketPath,
        });
        await server.start();

        // Check socket file permissions (0o600)
        const socketStat = await fs.promises.stat(socketPath);
        expect(socketStat.mode & 0o777).toBe(0o600);

        await server.stop();
        await supervisor.stop();
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      },
    );

    it("redacts sensitive data from diagnostics, logs, and error responses", async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uds-redact-test-"));
      const socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\uds-redact-test-${Date.now()}`
          : path.join(tempDir, "observer.sock");
      const secretValue = "very_secret_token_must_not_leak_in_logs";

      const config = DaemonConfigSchema.parse({
        instanceId: "uds-redact-test-inst",
        custom: {
          apiSecret: secretValue,
        },
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
      });
      await server.start();

      const client = new IpcClient({
        socketPath,
      });
      await client.connect();

      // Diagnostics should not leak sensitive keys in plain text
      const diagnostics = await client.getDiagnostics();
      const diagStr = JSON.stringify(diagnostics);
      expect(diagStr).not.toContain(secretValue);
      expect((diagnostics.config.custom as JsonObject).apiSecret).toBe("[REDACTED]");

      // Health report should not expose sensitive keys
      const health = await client.getHealth();
      const healthStr = JSON.stringify(health);
      expect(healthStr).not.toContain(secretValue);

      await client.close();
      await server.stop();
      await supervisor.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it("fails closed against malformed, corrupted, or non-conforming IPC payloads", async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uds-malformed-test-"));
      const socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\uds-malformed-test-${Date.now()}`
          : path.join(tempDir, "observer.sock");

      const config = DaemonConfigSchema.parse({
        instanceId: "uds-malformed-test-inst",
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
      });
      await server.start();

      const netSocket = net.createConnection(socketPath);
      await new Promise<void>((res) => netSocket.once("connect", res));

      const malformedPayload = Buffer.from("NOT_A_VALID_JSON_OBJECT");
      const malformedFrame = encodeFrame(malformedPayload as unknown as IpcRequest);

      const responsePromise = new Promise<Buffer>((res) => {
        const chunks: Buffer[] = [];
        netSocket.on("data", (chunk) => {
          chunks.push(chunk);
          if (chunks.length >= 1) res(Buffer.concat(chunks));
        });
      });

      netSocket.write(malformedFrame);
      const responseRaw = await responsePromise;

      const decoder = new FrameDecoder();
      const decodedFrames = decoder.push(responseRaw);
      expect(decodedFrames.length).toBeGreaterThan(0);

      const parsedResponse = decodedFrames[0] as IpcResponse;
      expect(parsedResponse.error).toBeDefined();
      expect(parsedResponse.error?.code).toBe(IPC_ERROR_CODES.INVALID_REQUEST);

      netSocket.destroy();
      await server.stop();
      await supervisor.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });
  });
});
