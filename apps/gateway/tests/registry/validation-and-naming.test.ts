import type { CapabilityEnvelope, ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  formatMcpToolName,
  resolveNameCollision,
  sanitizeToolName,
} from "../../src/registry/naming.js";
import { computeManifestDigest, validateToolStaging } from "../../src/registry/validator.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? "tool_val",
    name: overrides?.name ?? "test_validator",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Validator test tool",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    runtime: overrides?.runtime ?? {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: overrides?.capabilities ?? {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https" as const],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: [],
        allowedBinaries: [],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: [],
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
    limits: overrides?.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T12:00:00.000Z",
  };

  const digest = overrides?.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

function makeEnvelope(overrides?: Partial<CapabilityEnvelope>): CapabilityEnvelope {
  return {
    envelopeId: overrides?.envelopeId ?? "env_default",
    workspaceId: overrides?.workspaceId ?? "ws-test",
    version: overrides?.version ?? "1.0.0",
    fs: overrides?.fs ?? {
      readPaths: ["/workspace"],
      writePaths: ["/workspace/build"],
      allowWorkspaceRoot: true,
      allowTemp: true,
      denyPaths: ["/etc", "/var/run", "/root"],
      maxFileSizeBytes: 10485760,
    },
    net: overrides?.net ?? {
      allowOutbound: true,
      allowedDomains: ["api.example.com"],
      allowedHosts: ["api.example.com"],
      allowedPorts: [443],
      allowedProtocols: ["https"],
      allowLocalhost: false,
      denyPrivateRanges: true,
    },
    command: overrides?.command ?? {
      allowShellExecution: false,
      allowedCommands: ["git", "node"],
      allowedBinaries: ["git", "node"],
      forbiddenPatterns: ["rm -rf", "sudo", "eval"],
      allowEnvPassthrough: [],
    },
    secrets: overrides?.secrets ?? {
      allowedSecretNames: [],
      allowedPrefixes: [],
      denyDirectRead: true,
      injectAsEnv: true,
    },
    limits: overrides?.limits ?? {
      maxConcurrentExecutions: 4,
      maxCpuUsagePercent: 100,
      maxMemoryMb: 256,
      maxExecutionTimeMs: 60000,
      maxOutputSizeBytes: 2097152,
    },
    isFrozen: overrides?.isFrozen ?? false,
    createdAt: overrides?.createdAt ?? "2026-08-17T12:00:00.000Z",
  };
}

describe("ToolRegistry - Pre-Staging Validation & Capability Envelope Enforcement", () => {
  it("passes validation for a compliant tool manifest", () => {
    const manifest = makeManifest();
    const envelope = makeEnvelope();
    const result = validateToolStaging(manifest, undefined, envelope);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifestDigest).toBeTruthy();
  });

  it("rejects manifest with digest mismatch", () => {
    const manifest = makeManifest({
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    const result = validateToolStaging(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Manifest digest mismatch"))).toBe(true);
  });

  it("rejects filesystem path traversal and access to denied paths", () => {
    const envelope = makeEnvelope({
      fs: {
        readPaths: ["/workspace"],
        writePaths: ["/workspace/out"],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: ["/etc"],
        maxFileSizeBytes: 10485760,
      },
    });

    const manifestWithTraversal = makeManifest({
      capabilities: {
        ...makeManifest().capabilities,
        fs: {
          readPaths: ["../../etc/shadow"],
          writePaths: ["/workspace/out/file.txt"],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 1048576,
        },
      },
    });

    const result = validateToolStaging(manifestWithTraversal, undefined, envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Disallowed filesystem traversal"))).toBe(true);
  });

  it("rejects network requests to unauthorized hosts or disallowed localhost", () => {
    const envelope = makeEnvelope({
      net: {
        allowOutbound: true,
        allowedDomains: ["api.example.com"],
        allowedHosts: ["api.example.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
    });

    const manifestWithUnauthorizedHost = makeManifest({
      capabilities: {
        ...makeManifest().capabilities,
        net: {
          allowOutbound: true,
          allowedDomains: [],
          allowedHosts: ["127.0.0.1", "untrusted.attacker.com"],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      },
    });

    const result = validateToolStaging(manifestWithUnauthorizedHost, undefined, envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Localhost access is disabled"))).toBe(true);
    expect(result.errors.some((e) => e.includes("outside capability envelope allowedHosts"))).toBe(
      true,
    );
  });

  it("rejects dangerous or forbidden commands", () => {
    const envelope = makeEnvelope();
    const manifestWithDangerousCmd = makeManifest({
      capabilities: {
        ...makeManifest().capabilities,
        command: {
          allowShellExecution: true,
          allowedCommands: ["sudo rm -rf /"],
          allowedBinaries: ["sudo"],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
      },
    });

    const result = validateToolStaging(manifestWithDangerousCmd, undefined, envelope);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("prohibited") || e.includes("forbiddenPattern")),
    ).toBe(true);
  });

  it("rejects new capability requests when envelope is frozen", () => {
    const frozenEnvelope = makeEnvelope({ isFrozen: true });
    const manifest = makeManifest({
      capabilities: {
        ...makeManifest().capabilities,
        fs: {
          readPaths: ["/workspace/data"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 1048576,
        },
      },
    });

    const result = validateToolStaging(manifest, undefined, frozenEnvelope);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("frozen"))).toBe(true);
  });
});

describe("Naming & Collision Resolution", () => {
  it("sanitizes raw tool names to valid MCP names", () => {
    expect(sanitizeToolName("my tool:run!")).toBe("my_tool_run");
    expect(sanitizeToolName("---weird___name---")).toBe("weird_name");
    expect(sanitizeToolName("")).toBe("unnamed_tool");
  });

  it("formats names with namespaces and suffixes", () => {
    expect(formatMcpToolName("build", { namespace: "cargo" })).toBe("cargo__build");
    expect(formatMcpToolName("test", { suffix: "canary" })).toBe("test__canary");
  });

  it("resolves name collisions with scope precedence and uniqueness guarantees", () => {
    const candidates = [
      { toolId: "t_sys", name: "search", scope: "system" },
      { toolId: "t_ws", name: "search", scope: "workspace" },
      { toolId: "t_sess", name: "search", scope: "session" },
    ];

    const resolved = resolveNameCollision(candidates);

    // Highest precedence (session) gets clean canonical name
    expect(resolved.get("t_sess")).toBe("search");
    // Other colliding tools receive distinct names
    const nameWs = resolved.get("t_ws");
    const nameSys = resolved.get("t_sys");

    expect(nameWs).toBeTruthy();
    expect(nameSys).toBeTruthy();
    expect(nameWs).not.toEqual("search");
    expect(nameSys).not.toEqual("search");
    expect(nameWs).not.toEqual(nameSys);
  });
});
