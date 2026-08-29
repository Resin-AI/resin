import type { ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  MANDATORY_SECURITY_PROBES,
  PROBE_ARCHIVE_TAMPERING,
  PROBE_CMD_SUBSTITUTION,
  PROBE_DIRECT_FS,
  PROBE_IMPORT_ESCAPE,
  PROBE_INFINITE_LOOP,
  PROBE_NET_BYPASS,
  PROBE_OUTPUT_FLOODING,
  PROBE_RAW_SECRET_ACCESS,
  PROBE_SCHEMA_SPOOFING,
  runSecurityProbes,
} from "../../src/verifier/probes.js";

describe("Platform Security Probes and Sandbox Isolation Verification", () => {
  const safeManifest: ToolManifest = {
    id: "sample_probe_tool",
    name: "Sample Probe Tool",
    version: "1.0.0",
    description: "Safe test tool for sandbox probes",
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        echo: { type: "string" },
      },
      required: ["echo"],
      additionalProperties: false,
    },
    runtime: {
      runtime: "deno",
      memoryLimitMb: 128,
      timeoutMs: 5000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowedDomains: ["api.example.com"],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        allowOutbound: true,
        denyPrivateRanges: true,
      },
      command: {
        allowedCommands: ["echo"],
        allowedBinaries: ["echo"],
        allowShellExecution: false,
        allowEnvPassthrough: [],
        forbiddenPatterns: [],
      },
      secrets: {
        allowedSecretNames: ["API_KEY"],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: {
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 2,
    },
    scope: "workspace",
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    metadata: {},
    createdAt: new Date().toISOString(),
  };

  const safeSourceCode = `
    import { defineTool, type ToolContext } from "@resin/runtime";

    export default defineTool<{ value: string }, { echo: string }>(async (ctx) => {
      return { echo: ctx.input.value };
    });
  `;

  it("verifies PROBE_DIRECT_FS enforces filesystem mediation", async () => {
    const res = await PROBE_DIRECT_FS.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("verifies PROBE_RAW_SECRET_ACCESS enforces opaque secret references", async () => {
    const res = await PROBE_RAW_SECRET_ACCESS.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("verifies PROBE_CMD_SUBSTITUTION rejects shell injection and command substitution", async () => {
    const res = await PROBE_CMD_SUBSTITUTION.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("verifies PROBE_NET_BYPASS rejects unauthorized host and localhost connections", async () => {
    const res = await PROBE_NET_BYPASS.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("verifies PROBE_IMPORT_ESCAPE verifies rejection of dynamic code generation", async () => {
    const res = await PROBE_IMPORT_ESCAPE.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);

    const maliciousCode = `
      import { defineTool } from "@resin/runtime";
      export default defineTool(async () => {
        eval("process.exit(1)");
        return {};
      });
    `;
    const maliciousRes = await PROBE_IMPORT_ESCAPE.run({
      manifest: safeManifest,
      sourceCode: maliciousCode,
    });
    expect(maliciousRes.passed).toBe(false);
    expect(maliciousRes.error).toBeDefined();
  });

  it("verifies PROBE_SCHEMA_SPOOFING detects invalid outputs and additionalProperties violation", async () => {
    const res = await PROBE_SCHEMA_SPOOFING.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
  });

  it("verifies PROBE_INFINITE_LOOP terminates worker cleanly on timeout", async () => {
    const res = await PROBE_INFINITE_LOOP.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
  });

  it("verifies PROBE_OUTPUT_FLOODING bounds payload safely without crashing", async () => {
    const res = await PROBE_OUTPUT_FLOODING.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
  });

  it("verifies PROBE_ARCHIVE_TAMPERING detects corrupted or altered bundles", async () => {
    const res = await PROBE_ARCHIVE_TAMPERING.run({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });
    expect(res.passed).toBe(true);
  });

  it("runs complete mandatory security probe suite successfully on safe candidate", async () => {
    const suiteResult = await runSecurityProbes({
      manifest: safeManifest,
      sourceCode: safeSourceCode,
    });

    expect(suiteResult.passed).toBe(true);
    expect(suiteResult.failedProbes).toHaveLength(0);
    expect(suiteResult.probes.length).toBe(MANDATORY_SECURITY_PROBES.length);
  });
});
