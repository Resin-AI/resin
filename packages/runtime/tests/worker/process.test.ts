import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerProcess } from "../../src/worker/process.js";
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
          timeoutMs: 5000,
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
          timeoutMs: 5000,
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
  );
});
