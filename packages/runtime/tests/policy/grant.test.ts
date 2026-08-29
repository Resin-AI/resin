import type { CapabilityManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  computeGrantDigest,
  createInvocationGrant,
  verifyInvocationGrant,
} from "../../src/policy/grant.js";

const sampleCapabilities: CapabilityManifest = {
  fs: {
    readPaths: ["/app/src/**"],
    writePaths: [],
    allowWorkspaceRoot: true,
    allowTemp: false,
    denyPaths: ["/app/.git/**"],
    maxFileSizeBytes: 10485760,
  },
  net: {
    allowOutbound: true,
    allowedDomains: ["api.github.com"],
    allowedHosts: [],
    allowedPorts: [443],
    allowedProtocols: ["https"],
    allowLocalhost: false,
    denyPrivateRanges: true,
  },
  command: {
    allowShellExecution: false,
    allowedCommands: ["git"],
    allowedBinaries: [],
    forbiddenPatterns: [],
    allowEnvPassthrough: ["NODE_ENV"],
  },
  secrets: {
    allowedSecretNames: ["GITHUB_TOKEN"],
    allowedPrefixes: [],
    denyDirectRead: true,
    injectAsEnv: true,
  },
  limits: {
    maxConcurrentExecutions: 2,
    maxCpuUsagePercent: 80,
    maxMemoryMb: 256,
    maxExecutionTimeMs: 15000,
    maxOutputSizeBytes: 524288,
  },
};

describe("InvocationGrant", () => {
  it("creates an immutable grant with valid cryptographic digest", () => {
    const grant = createInvocationGrant({
      invocationId: "inv_12345",
      toolId: "fast_ast_grep",
      toolVersion: "1.2.0",
      workspaceId: "ws_project_01",
      envelopeId: "env_ws_01",
      capabilities: sampleCapabilities,
      actor: { type: "policy_engine", id: "engine_v1" },
    });

    expect(grant.invocationId).toBe("inv_12345");
    expect(grant.toolId).toBe("fast_ast_grep");
    expect(grant.toolVersion).toBe("1.2.0");
    expect(grant.workspaceId).toBe("ws_project_01");
    expect(grant.envelopeId).toBe("env_ws_01");
    expect(grant.digest).toBeDefined();
    expect(grant.digest).toMatch(/^[a-f0-9]{64}$/);

    // Verify immutability
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.capabilities)).toBe(true);
    expect(Object.isFrozen(grant.capabilities.fs)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating frozen object
      grant.toolId = "hacked_tool";
    }).toThrow();
  });

  it("verifies a valid untampered grant successfully", () => {
    const grant = createInvocationGrant({
      invocationId: "inv_99999",
      toolId: "code_formatter",
      toolVersion: "2.0.0",
      workspaceId: "ws_alpha",
      envelopeId: "env_alpha_01",
      capabilities: sampleCapabilities,
    });

    const result = verifyInvocationGrant(grant, {
      expectedInvocationId: "inv_99999",
      expectedToolId: "code_formatter",
      expectedWorkspaceId: "ws_alpha",
      expectedEnvelopeId: "env_alpha_01",
    });

    expect(result.valid).toBe(true);
  });

  it("detects tampering when grant payload fields are modified", () => {
    const grant = createInvocationGrant({
      invocationId: "inv_001",
      toolId: "my_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_main",
      envelopeId: "env_main",
      capabilities: sampleCapabilities,
    });

    // Clone and tamper with a field
    const tamperedGrant = {
      ...grant,
      toolId: "malicious_tool",
    };

    const result = verifyInvocationGrant(tamperedGrant);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("TAMPERED_DIGEST");
  });

  it("detects tampering when capabilities are broadened", () => {
    const grant = createInvocationGrant({
      invocationId: "inv_002",
      toolId: "my_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_main",
      envelopeId: "env_main",
      capabilities: sampleCapabilities,
    });

    // Tamper with capabilities (e.g. enable shell)
    const tamperedGrant = {
      ...grant,
      capabilities: {
        ...grant.capabilities,
        command: {
          ...grant.capabilities.command,
          allowShellExecution: true,
        },
      },
    };

    const result = verifyInvocationGrant(tamperedGrant);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("TAMPERED_DIGEST");
  });

  it("detects expired grants", () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    const olderTime = new Date(Date.now() - 20000).toISOString();

    const expiredGrant = createInvocationGrant({
      invocationId: "inv_expired",
      toolId: "tool_a",
      toolVersion: "1.0.0",
      workspaceId: "ws_test",
      envelopeId: "env_test",
      capabilities: sampleCapabilities,
      issuedAt: olderTime,
      expiresAt: pastTime,
    });

    const result = verifyInvocationGrant(expiredGrant);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("EXPIRED");
  });

  it("fails verification when contextual IDs do not match", () => {
    const grant = createInvocationGrant({
      invocationId: "inv_correct",
      toolId: "tool_correct",
      toolVersion: "1.0.0",
      workspaceId: "ws_correct",
      envelopeId: "env_correct",
      capabilities: sampleCapabilities,
    });

    expect(verifyInvocationGrant(grant, { expectedInvocationId: "inv_other" }).errorCode).toBe(
      "INVOCATION_MISMATCH",
    );

    expect(verifyInvocationGrant(grant, { expectedToolId: "tool_other" }).errorCode).toBe(
      "TOOL_MISMATCH",
    );

    expect(verifyInvocationGrant(grant, { expectedWorkspaceId: "ws_other" }).errorCode).toBe(
      "WORKSPACE_MISMATCH",
    );

    expect(verifyInvocationGrant(grant, { expectedEnvelopeId: "env_other" }).errorCode).toBe(
      "ENVELOPE_MISMATCH",
    );
  });
});
