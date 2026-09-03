import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("executes entry importing bare specifier via importMap pointing at temp ESM file", async () => {
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
  });
});
