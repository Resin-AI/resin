import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkerProcess } from "../../src/worker/process.js";
import {
  type BrokerRequestMessage,
  WorkerFrameEncoder,
  createBrokerRequestMessage,
  createHeartbeatMessage,
  createProgressMessage,
  createResultMessage,
} from "../../src/worker/protocol.js";
function checkExecutable(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function canRunDeno(): boolean {
  if (process.env.RESIN_DENO_EXECUTABLE && checkExecutable(process.env.RESIN_DENO_EXECUTABLE)) {
    return true;
  }
  const resinHome = process.env.RESIN_HOME || path.join(os.homedir(), ".resin");
  const resinDeno = path.join(
    resinHome,
    "current",
    "deno",
    process.platform === "win32" ? "deno.exe" : "deno",
  );
  if (checkExecutable(resinDeno)) {
    return true;
  }
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    if (!p) continue;
    const candidate = path.join(p, process.platform === "win32" ? "deno.exe" : "deno");
    if (checkExecutable(candidate)) {
      return true;
    }
  }
  return false;
}

const hasDeno = canRunDeno();

describe("WorkerProcess", () => {
  it("handles non-existent deno executable gracefully with error status", async () => {
    const worker = new WorkerProcess({
      manifest: { id: "t1", name: "tool", version: "1.0.0" },
      bundleEntrypoint: "/nonexistent/entry.ts",
      denoExecutable: "nonexistent-deno-binary-12345",
      timeoutMs: 1000,
    });

    const res = await worker.execute("inv-1", { input: 123 });
    expect(res.status).toBe("error");
    expect(res.error?.message).toBeDefined();

    // Verify scratch directory was cleaned up
    const scratchDir = worker.getScratchDir();
    if (scratchDir) {
      expect(fs.existsSync(scratchDir)).toBe(false);
    }
  });

  it("cleans up scratch workspace on manual cleanup", () => {
    const worker = new WorkerProcess({
      manifest: { id: "t1", name: "tool", version: "1.0.0" },
      bundleEntrypoint: "/dummy/entry.ts",
      denoExecutable: "nonexistent-deno-binary",
    });

    worker.cleanup();
    const scratchDir = worker.getScratchDir();
    if (scratchDir) {
      expect(fs.existsSync(scratchDir)).toBe(false);
    }
  });

  it.skipIf(!hasDeno)(
    "executes entry importing bare specifier via importMap pointing at temp ESM file",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-importmap-test-"));
      try {
        const modPath = path.join(tempDir, "calculator.js");
        fs.writeFileSync(modPath, "export function multiply(a, b) { return a * b; }\n", "utf-8");

        const entryPath = path.join(tempDir, "entry.ts");
        fs.writeFileSync(
          entryPath,
          `import { multiply } from "bare-calc";
export default async function (context: { input: { x: number; y: number } }) {
  return { result: multiply(context.input.x, context.input.y) };
};
`,
          "utf-8",
        );

        const worker = new WorkerProcess({
          manifest: { id: "test-import-map-tool", name: "calculator", version: "1.0.0" },
          bundleEntrypoint: entryPath,
          importMap: {
            "bare-calc": modPath,
          },
          timeoutMs: 5000,
        });

        const res = await worker.execute("inv-calc-1", { x: 6, y: 7 });
        expect(res.status).toBe("success");
        expect(res.output).toEqual({ result: 42 });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!hasDeno)(
    "processes heartbeat message while invoke is in flight without blocking",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-inflight-test-"));
      try {
        const entryPath = path.join(tempDir, "entry.ts");
        fs.writeFileSync(
          entryPath,
          `export default async function (context: { progress: (p: number, m?: string) => Promise<void>; fs: { readFile: (p: string) => Promise<string> } }) {
  await context.progress(10, "started");
  const content = await context.fs.readFile("test.txt");
  return { completed: true, content };
};
`,
          "utf-8",
        );

        const pongReceived = Promise.withResolvers<{ kind: string; sequence: number }>();
        const brokerRelease = Promise.withResolvers<{ content: string }>();

        const worker = new WorkerProcess({
          manifest: { id: "test-inflight-tool", name: "sleeper", version: "1.0.0" },
          bundleEntrypoint: entryPath,
          timeoutMs: 20_000,
          onProgress: () => {
            // Tool has started and is waiting on broker; send heartbeat ping
            worker.sendHeartbeat(42);
          },
          onHeartbeat: (hb) => {
            pongReceived.resolve(hb);
            // Release the broker once heartbeat pong has been verified
            brokerRelease.resolve({ content: "broker-data" });
          },
          brokerHandler: async (_service, action) => {
            if (action === "readFile") {
              return await brokerRelease.promise;
            }
            return {};
          },
        });

        const execPromise = worker.execute("inv-inflight-1", {});

        const pong = await pongReceived.promise;
        expect(pong.kind).toBe("pong");
        expect(pong.sequence).toBe(42);

        const res = await execPromise;
        expect(res.status).toBe("success");
        expect(res.output).toEqual({ completed: true, content: "broker-data" });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!hasDeno)(
    "cancels an in-flight invocation via abort signal when cancel message is received",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-cancel-test-"));
      try {
        const entryPath = path.join(tempDir, "entry.ts");
        fs.writeFileSync(
          entryPath,
          `export default async function (context: { progress: (p: number, m?: string) => Promise<void>; signal?: AbortSignal }) {
  await context.progress(10, "ready_to_cancel");
  return new Promise((_resolve, reject) => {
    context.signal?.addEventListener("abort", () => {
      const err = new Error("Tool invocation aborted via signal");
      err.name = "AbortError";
      reject(err);
    });
  });
};
`,
          "utf-8",
        );

        const worker = new WorkerProcess({
          manifest: { id: "test-cancel-tool", name: "cancellable", version: "1.0.0" },
          bundleEntrypoint: entryPath,
          timeoutMs: 20_000,
          onProgress: () => {
            // Invocation is confirmed running, send cancel immediately
            worker.sendCancel("inv-cancel-1", "User requested cancel");
          },
        });

        const res = await worker.execute("inv-cancel-1", {});
        expect(res.status).toBe("cancelled");
        expect(res.error?.message).toContain("Tool invocation aborted via signal");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!hasDeno)(
    "processes coalesced heartbeat and progress frames while broker request is pending and succeeds",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-coalesced-success-"));
      try {
        const entryPath = path.join(tempDir, "entry.ts");
        fs.writeFileSync(
          entryPath,
          `declare const Deno: { stdout: { writeSync: (data: Uint8Array) => number } };
export default async function (context: { progress: (p: number, m?: string) => Promise<void>; fs: { readFile: (p: string) => Promise<string> } }) {
  const encoder = new TextEncoder();
  const chunk = [
    JSON.stringify({
      id: "br_coalesced_1",
      type: "broker_request",
      timestamp: Date.now(),
      version: "1.0.0",
      requestId: "req_coalesced_1",
      service: "fs",
      action: "readFile",
      payload: { path: "pending.txt" },
    }),
    JSON.stringify({
      id: "hb_coalesced_1",
      type: "heartbeat",
      timestamp: Date.now(),
      version: "1.0.0",
      kind: "pong",
      sequence: 101,
    }),
    JSON.stringify({
      id: "pr_coalesced_1",
      type: "progress",
      timestamp: Date.now(),
      version: "1.0.0",
      invocationId: "inv-coalesced-1",
      percentage: 60,
      message: "coalesced_progress_running",
    }),
  ].join("\\n") + "\\n";

  Deno.stdout.writeSync(encoder.encode(chunk));

  const content = await context.fs.readFile("final.txt");
  return { completed: true, content };
};
`,
          "utf-8",
        );

        let heartbeatProcessedWhileBrokerPending = false;
        let progressProcessedWhileBrokerPending = false;
        let brokerExecuting = false;

        const brokerRelease = Promise.withResolvers<{ content: string }>();

        const worker = new WorkerProcess({
          manifest: { id: "test-coalesced-tool", name: "coalesced-success", version: "1.0.0" },
          bundleEntrypoint: entryPath,
          timeoutMs: 20_000,
          onHeartbeat: (hb) => {
            if (brokerExecuting && hb.sequence === 101) {
              heartbeatProcessedWhileBrokerPending = true;
            }
          },
          onProgress: (prog) => {
            if (brokerExecuting && prog.percentage === 60) {
              progressProcessedWhileBrokerPending = true;
              brokerRelease.resolve({ content: "broker-released-content" });
            }
          },
          brokerHandler: async (_service, action) => {
            if (action === "readFile") {
              brokerExecuting = true;
              try {
                return await brokerRelease.promise;
              } finally {
                brokerExecuting = false;
              }
            }
            return {};
          },
        });

        const res = await worker.execute("inv-coalesced-1", {});

        expect(heartbeatProcessedWhileBrokerPending).toBe(true);
        expect(progressProcessedWhileBrokerPending).toBe(true);
        expect(res.status).toBe("success");
        expect(res.output).toEqual({ completed: true, content: "broker-released-content" });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!hasDeno)(
    "processes coalesced heartbeat and progress while broker request is pending and handles broker error",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-coalesced-error-"));
      try {
        const entryPath = path.join(tempDir, "entry.ts");
        fs.writeFileSync(
          entryPath,
          `declare const Deno: { stdout: { writeSync: (data: Uint8Array) => number } };
export default async function (context: { progress: (p: number, m?: string) => Promise<void>; fs: { readFile: (p: string) => Promise<string> } }) {
  const encoder = new TextEncoder();
  const chunk = [
    JSON.stringify({
      id: "br_coalesced_err",
      type: "broker_request",
      timestamp: Date.now(),
      version: "1.0.0",
      requestId: "req_coalesced_err",
      service: "fs",
      action: "readFile",
      payload: { path: "failing.txt" },
    }),
    JSON.stringify({
      id: "hb_coalesced_err",
      type: "heartbeat",
      timestamp: Date.now(),
      version: "1.0.0",
      kind: "pong",
      sequence: 202,
    }),
    JSON.stringify({
      id: "pr_coalesced_err",
      type: "progress",
      timestamp: Date.now(),
      version: "1.0.0",
      invocationId: "inv-coalesced-err",
      percentage: 25,
      message: "coalesced_error_in_flight",
    }),
  ].join("\\n") + "\\n";

  Deno.stdout.writeSync(encoder.encode(chunk));

  await context.fs.readFile("failing.txt");
  return { completed: false };
};
`,
          "utf-8",
        );

        let heartbeatProcessedWhileBrokerPending = false;
        let progressProcessedWhileBrokerPending = false;
        let brokerExecuting = false;

        const brokerRelease = Promise.withResolvers<void>();

        const worker = new WorkerProcess({
          manifest: { id: "test-coalesced-err-tool", name: "coalesced-error", version: "1.0.0" },
          bundleEntrypoint: entryPath,
          timeoutMs: 20_000,
          onHeartbeat: (hb) => {
            if (brokerExecuting && hb.sequence === 202) {
              heartbeatProcessedWhileBrokerPending = true;
            }
          },
          onProgress: (prog) => {
            if (brokerExecuting && prog.percentage === 25) {
              progressProcessedWhileBrokerPending = true;
              brokerRelease.resolve();
            }
          },
          brokerHandler: async (_service, action) => {
            if (action === "readFile") {
              brokerExecuting = true;
              try {
                await brokerRelease.promise;
                throw new Error("Simulated broker I/O failure");
              } finally {
                brokerExecuting = false;
              }
            }
            return {};
          },
        });

        const res = await worker.execute("inv-coalesced-err", {});

        expect(heartbeatProcessedWhileBrokerPending).toBe(true);
        expect(progressProcessedWhileBrokerPending).toBe(true);
        expect(res.status).toBe("error");
        expect(res.error?.message).toContain("Simulated broker I/O failure");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
  it.skipIf(!hasDeno)(
    "processes coalesced final result frame alongside broker request, heartbeat, and progress without head-of-line blocking",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-coalesced-final-"));
      try {
        const brokerReq = createBrokerRequestMessage({
          requestId: "req_coalesced_final",
          service: "fs",
          action: "readFile",
          payload: { path: "deferred.txt" },
        });
        const resultMsg = createResultMessage({
          invocationId: "inv-coalesced-final",
          output: { ok: true, source: "coalesced_result_frame" },
          durationMs: 42,
        });
        const heartbeatMsg = createHeartbeatMessage({
          kind: "pong",
          sequence: 777,
        });
        const progressMsg = createProgressMessage({
          invocationId: "inv-coalesced-final",
          percentage: 95,
          message: "progress_following_final_result",
        });

        const chunkStr = `${[
          JSON.stringify(brokerReq),
          JSON.stringify(resultMsg),
          JSON.stringify(heartbeatMsg),
          JSON.stringify(progressMsg),
        ].join("\n")}\n`;

        const entryPath = path.join(tempDir, "entry.ts");
        fs.writeFileSync(
          entryPath,
          `declare const Deno: { stdout: { writeSync: (data: Uint8Array) => number } };
export default async function () {
  const encoder = new TextEncoder();
  const chunk = ${JSON.stringify(chunkStr)};
  Deno.stdout.writeSync(encoder.encode(chunk));
  return new Promise(() => {});
};
`,
          "utf-8",
        );

        let heartbeatProcessedWhileBrokerPending = false;
        let progressProcessedWhileBrokerPending = false;
        let brokerExecuting = false;
        let brokerFinished = false;

        const brokerRelease = Promise.withResolvers<{ content: string }>();

        const worker = new WorkerProcess({
          manifest: { id: "test-coalesced-final-tool", name: "coalesced-final", version: "1.0.0" },
          bundleEntrypoint: entryPath,
          timeoutMs: 20_000,
          onHeartbeat: (hb) => {
            if (brokerExecuting && hb.sequence === 777) {
              heartbeatProcessedWhileBrokerPending = true;
            }
          },
          onProgress: (prog) => {
            if (brokerExecuting && prog.percentage === 95) {
              progressProcessedWhileBrokerPending = true;
              brokerRelease.resolve({ content: "broker-coalesced-done" });
            }
          },
          brokerHandler: async (_service, action) => {
            if (action === "readFile") {
              brokerExecuting = true;
              try {
                return await brokerRelease.promise;
              } finally {
                brokerExecuting = false;
                brokerFinished = true;
              }
            }
            return {};
          },
        });

        const res = await worker.execute("inv-coalesced-final", {});

        expect(heartbeatProcessedWhileBrokerPending).toBe(true);
        expect(progressProcessedWhileBrokerPending).toBe(true);
        expect(brokerFinished).toBe(true);
        expect(res.status).toBe("success");
        expect(res.output).toEqual({ ok: true, source: "coalesced_result_frame" });
        expect(res.progress.some((p) => p.percentage === 95)).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("handles initial frame write error gracefully and cleans up workspace", async () => {
    const encodeSpy = vi.spyOn(WorkerFrameEncoder, "encodeNDJSON").mockImplementationOnce(() => {
      throw new Error("Simulated initial frame encoding failure");
    });
    try {
      const worker = new WorkerProcess({
        manifest: { id: "test-write-err-tool", name: "write-error-tool", version: "1.0.0" },
        bundleEntrypoint: "/dummy/entry.ts",
        denoExecutable: process.execPath,
        timeoutMs: 5000,
      });

      const res = await worker.execute("inv-init-write-err", { x: 1 });
      expect(res.status).toBe("error");
      expect(res.error?.type).toBe("write_error");
      expect(res.error?.message).toContain("Failed to write initial RPC frames to worker");
      expect(res.error?.message).toContain("Simulated initial frame encoding failure");

      const scratchDir = worker.getScratchDir();
      if (scratchDir) {
        expect(fs.existsSync(scratchDir)).toBe(false);
      }
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("cleans up scratch workspace and pending broker work without unhandled rejections when disposed during active broker work", async () => {
    const { promise: brokerPromise, resolve: brokerResolve } = Promise.withResolvers<unknown>();

    const worker = new WorkerProcess({
      manifest: { id: "test-cleanup-tool", name: "cleanup-tool", version: "1.0.0" },
      bundleEntrypoint: "/dummy/entry.ts",
      brokerHandler: async () => {
        return await brokerPromise;
      },
    });

    const msg: BrokerRequestMessage = {
      id: "br_cleanup_test_1",
      type: "broker_request",
      timestamp: Date.now(),
      version: "1.0.0",
      requestId: "req_cleanup_test_1",
      service: "fs",
      action: "readFile",
      payload: { path: "pending.txt" },
    };

    interface WorkerProcessInternal {
      dispatchBrokerRequest(m: BrokerRequestMessage, id: string): void;
      pendingBrokerWork: Set<Promise<void>>;
    }
    const internalWorker: WorkerProcessInternal = worker as unknown as WorkerProcessInternal;
    internalWorker.dispatchBrokerRequest(msg, "inv-cleanup-test-1");

    expect(internalWorker.pendingBrokerWork.size).toBe(1);

    // Call cleanup while broker work is in-flight
    worker.cleanup();
    expect(internalWorker.pendingBrokerWork.size).toBe(0);

    // Sending messages after disposal does not throw
    expect(() => {
      worker.sendHeartbeat(99);
      worker.sendCancel("inv-cleanup-test-1", "disposed");
      worker.sendMessage({
        id: "hb_disposed",
        type: "heartbeat",
        timestamp: Date.now(),
        version: "1.0.0",
        kind: "ping",
        sequence: 99,
      });
    }).not.toThrow();

    // Settle broker promise after disposal
    brokerResolve({ content: "resolved after disposal" });
    await Promise.resolve();
    await Promise.resolve();

    const scratchDir = worker.getScratchDir();
    if (scratchDir) {
      expect(fs.existsSync(scratchDir)).toBe(false);
    }
  });
});
