import { describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_VERSION,
  WorkerFrameDecoder,
  WorkerFrameEncoder,
  WorkerMessageSchema,
  createBrokerRequestMessage,
  createBrokerResponseMessage,
  createCancelMessage,
  createErrorMessage,
  createHeartbeatMessage,
  createInitializeMessage,
  createInvokeMessage,
  createLogMessage,
  createProgressMessage,
  createResultMessage,
  createShutdownMessage,
  withResolvers,
} from "../../src/worker/protocol.js";

describe("Worker Protocol", () => {
  describe("Message Factories and Schemas", () => {
    it("creates and validates initialize message", () => {
      const msg = createInitializeMessage({
        manifest: { id: "tool-1", name: "Test Tool", version: "1.0.0" },
        bundleEntrypoint: "/path/to/entry.ts",
        workspaceRoot: "/workspace",
        environment: { FOO: "bar" },
        limits: { timeoutMs: 15000, memoryLimitMb: 256, maxOutputSizeBytes: 500000 },
      });

      expect(msg.type).toBe("initialize");
      expect(msg.version).toBe(WORKER_PROTOCOL_VERSION);
      expect(msg.bundleEntrypoint).toBe("/path/to/entry.ts");
      expect(msg.limits?.timeoutMs).toBe(15000);
      expect(msg.limits?.memoryLimitMb).toBe(256);
      expect(WorkerMessageSchema.parse(msg)).toEqual(msg);
    });

    it("creates and validates invoke message", () => {
      const msg = createInvokeMessage({
        invocationId: "inv-123",
        input: { query: "hello" },
        context: { sessionId: "sess-1", workspaceId: "ws-1" },
      });

      expect(msg.type).toBe("invoke");
      expect(msg.invocationId).toBe("inv-123");
      expect(msg.input).toEqual({ query: "hello" });
      expect(msg.context?.sessionId).toBe("sess-1");
      expect(WorkerMessageSchema.parse(msg)).toEqual(msg);
    });

    it("creates and validates broker_request and broker_response messages", () => {
      const req = createBrokerRequestMessage({
        requestId: "req-1",
        service: "fs",
        action: "readFile",
        payload: { path: "data.txt" },
      });

      expect(req.type).toBe("broker_request");
      expect(req.service).toBe("fs");
      expect(req.action).toBe("readFile");
      expect(WorkerMessageSchema.parse(req)).toEqual(req);

      const resp = createBrokerResponseMessage({
        requestId: "req-1",
        success: true,
        payload: { content: "file content" },
      });

      expect(resp.type).toBe("broker_response");
      expect(resp.success).toBe(true);
      expect(resp.payload).toEqual({ content: "file content" });
      expect(WorkerMessageSchema.parse(resp)).toEqual(resp);
    });

    it("creates and validates progress and log messages", () => {
      const prog = createProgressMessage({
        invocationId: "inv-1",
        percentage: 50,
        message: "Processing data",
        stage: "transform",
      });

      expect(prog.type).toBe("progress");
      expect(prog.percentage).toBe(50);
      expect(prog.message).toBe("Processing data");
      expect(WorkerMessageSchema.parse(prog)).toEqual(prog);

      const log = createLogMessage({
        invocationId: "inv-1",
        level: "info",
        message: "Step completed",
        data: { count: 42 },
      });

      expect(log.type).toBe("log");
      expect(log.level).toBe("info");
      expect(log.data).toEqual({ count: 42 });
      expect(WorkerMessageSchema.parse(log)).toEqual(log);
    });

    it("creates and validates result, error, cancel, heartbeat, shutdown messages", () => {
      const res = createResultMessage({
        invocationId: "inv-1",
        output: { answer: 42 },
        durationMs: 120,
        resourceUsage: { cpuTimeMs: 100, memoryBytes: 1024 },
      });
      expect(res.type).toBe("result");
      expect(res.output).toEqual({ answer: 42 });
      expect(WorkerMessageSchema.parse(res)).toEqual(res);

      const err = createErrorMessage({
        invocationId: "inv-1",
        errorType: "validation_error",
        message: "Invalid field",
      });
      expect(err.type).toBe("error");
      expect(err.errorType).toBe("validation_error");
      expect(WorkerMessageSchema.parse(err)).toEqual(err);

      const cancel = createCancelMessage({
        invocationId: "inv-1",
        reason: "User requested abort",
      });
      expect(cancel.type).toBe("cancel");
      expect(cancel.reason).toBe("User requested abort");
      expect(WorkerMessageSchema.parse(cancel)).toEqual(cancel);

      const hb = createHeartbeatMessage({ kind: "ping", sequence: 1 });
      expect(hb.type).toBe("heartbeat");
      expect(hb.kind).toBe("ping");
      expect(WorkerMessageSchema.parse(hb)).toEqual(hb);

      const shutdown = createShutdownMessage({ reason: "Worker complete", graceful: true });
      expect(shutdown.type).toBe("shutdown");
      expect(shutdown.graceful).toBe(true);
      expect(WorkerMessageSchema.parse(shutdown)).toEqual(shutdown);
    });
  });

  describe("NDJSON Framing", () => {
    it("encodes and decodes NDJSON stream single message", () => {
      const decoder = new WorkerFrameDecoder({ format: "ndjson" });
      const msg = createInvokeMessage({
        invocationId: "inv-1",
        input: { a: 1 },
      });

      const encoded = WorkerFrameEncoder.encodeNDJSON(msg);
      expect(encoded.endsWith("\n")).toBe(true);

      const messages = decoder.push(encoded);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "invoke",
        invocationId: "inv-1",
      });
    });

    it("handles multiple messages across chunks and partial lines", () => {
      const decoder = new WorkerFrameDecoder({ format: "ndjson" });
      const msg1 = createHeartbeatMessage({ kind: "ping", sequence: 1 });
      const msg2 = createHeartbeatMessage({ kind: "pong", sequence: 1 });

      const line1 = WorkerFrameEncoder.encodeNDJSON(msg1);
      const line2 = WorkerFrameEncoder.encodeNDJSON(msg2);
      const full = line1 + line2;

      // Split into 3 arbitrary chunks
      const chunk1 = full.slice(0, 15);
      const chunk2 = full.slice(15, 45);
      const chunk3 = full.slice(45);

      const res1 = decoder.push(chunk1);
      expect(res1).toHaveLength(0);

      const res2 = decoder.push(chunk2);
      // Might have 0 or 1 depending on where line1 ends
      const res3 = decoder.push(chunk3);

      const all = [...res1, ...res2, ...res3];
      expect(all).toHaveLength(2);
      expect(all[0]?.type).toBe("heartbeat");
      expect(all[1]?.type).toBe("heartbeat");
    });

    it("throws when decoding invalid JSON", () => {
      const decoder = new WorkerFrameDecoder({ format: "ndjson" });
      expect(() => {
        decoder.push("NOT_A_JSON_LINE\n");
      }).toThrow(/Failed to decode worker frame/);
    });
  });

  describe("Length-Prefixed Framing", () => {
    it("encodes and decodes length-prefixed frames", () => {
      const decoder = new WorkerFrameDecoder({ format: "length-prefixed" });
      const msg = createInvokeMessage({
        invocationId: "inv-lp-1",
        input: { key: "value" },
      });

      const frame = WorkerFrameEncoder.encodeLengthPrefixed(msg);
      expect(Buffer.isBuffer(frame)).toBe(true);
      expect(frame.length).toBeGreaterThan(4);

      const messages = decoder.push(frame);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "invoke",
        invocationId: "inv-lp-1",
      });
    });

    it("handles chunked length-prefixed stream", () => {
      const decoder = new WorkerFrameDecoder({ format: "length-prefixed" });
      const msg1 = createHeartbeatMessage({ kind: "ping", sequence: 10 });
      const msg2 = createHeartbeatMessage({ kind: "pong", sequence: 10 });

      const frame1 = WorkerFrameEncoder.encodeLengthPrefixed(msg1);
      const frame2 = WorkerFrameEncoder.encodeLengthPrefixed(msg2);
      const combined = Buffer.concat([frame1, frame2]);

      // Feed byte by byte
      const collected = [];
      for (let i = 0; i < combined.length; i++) {
        const slice = combined.subarray(i, i + 1);
        const msgs = decoder.push(slice);
        collected.push(...msgs);
      }

      expect(collected).toHaveLength(2);
      expect(collected[0]?.type).toBe("heartbeat");
      expect(collected[1]?.type).toBe("heartbeat");
    });
  });

  describe("withResolvers helper", () => {
    it("resolves promise with value", async () => {
      const { promise, resolve } = withResolvers<number>();
      resolve(42);
      const val = await promise;
      expect(val).toBe(42);
    });

    it("rejects promise with error", async () => {
      const { promise, reject } = withResolvers<number>();
      reject(new Error("fail"));
      await expect(promise).rejects.toThrow("fail");
    });
  });
});
