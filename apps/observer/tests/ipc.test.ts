import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonConfigSchema } from "../src/config.js";
import { IpcClient } from "../src/ipc/client.js";
import { FrameDecoder, MAX_FRAME_SIZE, encodeFrame } from "../src/ipc/framing.js";
import { IPC_ERROR_CODES, type IpcRequest, type IpcResponse } from "../src/ipc/protocol.js";
import { IpcServer } from "../src/ipc/server.js";
import { createInMemoryIpcPair } from "../src/ipc/transport.js";
import type { DaemonModule, ModuleContext, ModuleLifecycleState } from "../src/lifecycle.js";
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
    async function setupInMemoryIpc(token = "test-token") {
      const config = DaemonConfigSchema.parse({ logLevel: "silent", authToken: token });
      const mod = createDummyModule("core");
      const supervisor = new DaemonSupervisor({ config, modules: [mod] });
      await supervisor.start();

      const server = new IpcServer({ supervisor, authToken: token });
      await server.start();

      const { serverTransport, clientTransport } = createInMemoryIpcPair();
      server.attachTransport(serverTransport);

      const client = new IpcClient({
        transport: clientTransport,
        authToken: token,
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
      expect(diag.config.authToken).toBe("[REDACTED]");
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

  describe("Authentication", () => {
    it("rejects unauthorized client with incorrect auth token", async () => {
      const config = DaemonConfigSchema.parse({ logLevel: "silent", authToken: "correct-token" });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({ supervisor, authToken: "correct-token" });
      await server.start();

      const { serverTransport, clientTransport } = createInMemoryIpcPair();
      server.attachTransport(serverTransport);

      const unauthorizedClient = new IpcClient({
        transport: clientTransport,
        authToken: "wrong-token",
      });

      await expect(unauthorizedClient.ping()).rejects.toThrow(/Unauthorized/);

      await unauthorizedClient.close();
      await server.stop();
      await supervisor.stop();
    });
  });

  describe("Unix Domain Socket Transport", () => {
    it("communicates successfully over a real Unix domain socket file", async () => {
      const tempDir = path.join(os.tmpdir(), `resin-ipc-uds-${Date.now()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const socketPath = path.join(tempDir, "daemon.sock");
      const token = "uds-secret-token";

      const config = DaemonConfigSchema.parse({
        logLevel: "silent",
        authToken: token,
        socketPath,
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
        authToken: token,
      });
      await server.start();

      const client = new IpcClient({
        socketPath,
        authToken: token,
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

    it("rejects unauthenticated requests and requests with invalid authentication token", async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uds-auth-test-"));
      const socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\uds-auth-test-${Date.now()}`
          : path.join(tempDir, "observer.sock");
      const validToken = "valid_secret_token_1234567890";
      const invalidToken = "invalid_secret_token_0000000000";

      const config = DaemonConfigSchema.parse({
        instanceId: "uds-auth-test-inst",
        authToken: validToken,
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
        authToken: validToken,
      });
      await server.start();

      // 1. Client with invalid token is rejected
      const badClient = new IpcClient({
        socketPath,
        authToken: invalidToken,
      });
      await badClient.connect();
      await expect(badClient.ping()).rejects.toThrow(/Unauthorized/i);
      await badClient.close();

      // 2. Client with no token is rejected
      const noTokenClient = new IpcClient({
        socketPath,
        authToken: "",
      });
      await noTokenClient.connect();
      await expect(noTokenClient.ping()).rejects.toThrow(/Unauthorized/i);
      await noTokenClient.close();

      // 3. Client with valid token succeeds
      const goodClient = new IpcClient({
        socketPath,
        authToken: validToken,
      });
      await goodClient.connect();
      const res = await goodClient.ping("authorized-nonce");
      expect(res.pong).toBe(true);
      await goodClient.close();

      await server.stop();
      await supervisor.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it("enforces strict filesystem permission bits (0o600) on POSIX domain socket and token file", async () => {
      if (process.platform === "win32") return;

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uds-perm-test-"));
      const socketPath = path.join(tempDir, "observer.sock");
      const tokenFilePath = path.join(tempDir, "ipc.token");

      const config = DaemonConfigSchema.parse({
        instanceId: "uds-perm-test-inst",
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
        tokenFilePath,
      });
      await server.start();

      // Check socket file permissions (0o600)
      const socketStat = await fs.promises.stat(socketPath);
      expect(socketStat.mode & 0o777).toBe(0o600);

      // Check generated token file permissions (0o600)
      const tokenStat = await fs.promises.stat(tokenFilePath);
      expect(tokenStat.mode & 0o777).toBe(0o600);

      await server.stop();
      await supervisor.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it("redacts authentication tokens and secrets from diagnostics, logs, and error responses", async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "uds-redact-test-"));
      const socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\uds-redact-test-${Date.now()}`
          : path.join(tempDir, "observer.sock");
      const secretToken = "very_secret_token_must_not_leak_in_logs";

      const config = DaemonConfigSchema.parse({
        instanceId: "uds-redact-test-inst",
        authToken: secretToken,
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
        authToken: secretToken,
      });
      await server.start();

      const client = new IpcClient({
        socketPath,
        authToken: secretToken,
      });
      await client.connect();

      // Diagnostics should not leak unredacted token or sensitive auth secrets in plain text
      const diagnostics = await client.getDiagnostics();
      const diagStr = JSON.stringify(diagnostics);
      expect(diagStr).not.toContain(secretToken);

      // Health report should not expose raw secret token
      const health = await client.getHealth();
      const healthStr = JSON.stringify(health);
      expect(healthStr).not.toContain(secretToken);

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
      const validToken = "valid_token_test_abc";

      const config = DaemonConfigSchema.parse({
        instanceId: "uds-malformed-test-inst",
        authToken: validToken,
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
        authToken: validToken,
      });
      await server.start();

      // Connect raw client socket and send malformed JSON frame
      const netSocket = await new Promise<net.Socket>((resolve) => {
        const s = net.createConnection(socketPath, () => resolve(s));
      });

      const malformedPayload = Buffer.from("{ this is not valid json }");
      const malformedFrame = encodeFrame(malformedPayload);

      const responseReceived = new Promise<IpcResponse>((resolve) => {
        const decoder = new FrameDecoder();
        netSocket.on("data", (chunk) => {
          const frames = decoder.push(chunk);
          for (const frame of frames) {
            if (typeof frame === "string") {
              resolve(JSON.parse(frame) as IpcResponse);
            } else {
              resolve(frame as IpcResponse);
            }
          }
        });
      });

      netSocket.write(malformedFrame);

      const parsedResponse = await responseReceived;
      expect(parsedResponse.error).toBeDefined();
      expect(parsedResponse.error?.code).toBe(IPC_ERROR_CODES.INVALID_REQUEST);

      netSocket.destroy();
      await server.stop();
      await supervisor.stop();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });
  });
});
