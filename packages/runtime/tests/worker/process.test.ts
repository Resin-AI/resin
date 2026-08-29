import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { WorkerProcess } from "../../src/worker/process.js";

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
});
