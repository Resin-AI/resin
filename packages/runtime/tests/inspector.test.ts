import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { buildToolBundle } from "../src/bundle/builder.js";
import {
  cliInspect,
  formatInspectionJson,
  formatInspectionSummary,
  inspectBundle,
  inspectBundleArchive,
  inspectBundleDirectory,
} from "../src/loader/inspector.js";

const sampleManifest: ToolManifest = {
  id: "test-tool-inspector",
  name: "inspector-tool",
  version: "2.1.0",
  description: "Tool for testing static inspection safety",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  runtime: {
    runtime: "deno",
    memoryLimitMb: 256,
    timeoutMs: 15000,
    cpuLimitPercent: 80,
    maxOutputSizeBytes: 2097152,
  },
  capabilities: {
    version: "1.0.0",
    description: "Inspection tool caps",
    fs: { read: ["/data"], write: [] },
    net: { allowedHosts: ["api.example.com"], allowDns: true },
    exec: { allowedCommands: [], allowPipes: false },
    harness: { allowRegistration: false, allowTelemetry: false },
  },
  limits: {
    timeoutMs: 15000,
    maxOutputBytes: 2097152,
    maxMemoryBytes: 268435456,
    maxConcurrentInvocations: 4,
  },
  scope: "workspace",
  digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  metadata: { author: "test" },
  createdAt: "2026-08-17T00:00:00.000Z",
};

describe("static inspector", () => {
  it("inspects bundle without evaluating entrypoint code", async () => {
    // Malicious / throwing entrypoint that must NEVER be executed
    const maliciousCode = `
      // This will throw if evaluated in a JS runtime
      throw new Error("FATAL: Untrusted code execution in static inspector!");
    `;

    const built = await buildToolBundle({
      manifest: sampleManifest,
      files: [
        { path: "src/index.ts", content: maliciousCode },
        { path: "tests/index.test.ts", content: "// tests" },
      ],
    });

    // Inspect archive buffer directly
    const inspection = await inspectBundleArchive(built.archiveBuffer);

    expect(inspection.manifest.name).toBe("inspector-tool");
    expect(inspection.manifest.version).toBe("2.1.0");
    expect(inspection.entrypoint).toBe("src/index.ts");
    expect(inspection.hasTests).toBe(true);
    expect(inspection.runtime.runtime).toBe("deno");
    expect(inspection.runtime.memoryLimitMb).toBe(256);
    expect(inspection.capabilities.net.allowedHosts).toContain("api.example.com");
    expect(inspection.files.length).toBeGreaterThanOrEqual(3); // manifest, package, src, tests
  });

  it("inspects extracted directory and formats text and JSON diagnostics", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-dir-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify(sampleManifest));
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), "export const ok = true;");

      const inspection = await inspectBundleDirectory(tempDir);
      expect(inspection.manifest.id).toBe(sampleManifest.id);

      const summaryText = formatInspectionSummary(inspection);
      expect(summaryText).toContain("Tool Bundle: inspector-tool (v2.1.0)");
      expect(summaryText).toContain("Runtime: deno");

      const jsonText = formatInspectionJson(inspection);
      const parsedJson = JSON.parse(jsonText);
      expect(parsedJson.manifest.name).toBe("inspector-tool");

      // Universal inspectBundle
      const universalResult = await inspectBundle(tempDir);
      expect(universalResult.manifest.name).toBe("inspector-tool");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs cliInspect without crashing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-cli-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify(sampleManifest));
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), "export const x = 1;");

      const exitCode = await cliInspect([tempDir, "--json"]);
      expect(exitCode).toBe(0);

      const missingExitCode = await cliInspect([]);
      expect(missingExitCode).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
