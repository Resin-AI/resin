import type { CapabilityEnvelope, CapabilityManifest, ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  CapabilityPolicyEngine,
  type InvocationContext,
  verifyInvocationGrant,
} from "../../src/policy/index.js";

const testEnvelope: CapabilityEnvelope = {
  envelopeId: "env_ws_prod",
  workspaceId: "ws_prod_01",
  version: "1.0.0",
  fs: {
    readPaths: ["<WORKSPACE_ROOT>/src/**", "<WORKSPACE_ROOT>/tests/**"],
    writePaths: ["<WORKSPACE_ROOT>/dist/**"],
    allowWorkspaceRoot: true,
    allowTemp: true,
    denyPaths: ["<WORKSPACE_ROOT>/.git/**", "<WORKSPACE_ROOT>/.env*"],
    maxFileSizeBytes: 10485760,
  },
  net: {
    allowOutbound: true,
    allowedDomains: ["api.github.com", "*.npmjs.org"],
    allowedHosts: [],
    allowedPorts: [443],
    allowedProtocols: ["https"],
    allowLocalhost: false,
    denyPrivateRanges: true,
  },
  command: {
    allowShellExecution: false,
    allowedCommands: ["git", "tsc"],
    allowedBinaries: [],
    forbiddenPatterns: ["rm -rf", "sudo"],
    allowEnvPassthrough: ["NODE_ENV"],
  },
  secrets: {
    allowedSecretNames: ["GITHUB_TOKEN"],
    allowedPrefixes: ["APP_"],
    denyDirectRead: true,
    injectAsEnv: true,
  },
  limits: {
    maxConcurrentExecutions: 4,
    maxCpuUsagePercent: 100,
    maxMemoryMb: 256,
    maxExecutionTimeMs: 30000,
    maxOutputSizeBytes: 1048576,
  },
  isFrozen: false,
  createdAt: new Date().toISOString(),
};

const validContext: InvocationContext = {
  invocationId: "inv_test_001",
  toolId: "typecheck_runner",
  toolVersion: "1.0.0",
  workspaceId: "ws_prod_01",
  workspaceRoot: "/tmp/ws_prod_01",
};

describe("CapabilityPolicyEngine", () => {
  it("grants invocation when requested capabilities are within approved envelope", () => {
    const engine = new CapabilityPolicyEngine({
      workspaceRoot: "/tmp/ws_prod_01",
    });
    engine.setEnvelope(testEnvelope);

    const validManifest: CapabilityManifest = {
      fs: {
        readPaths: ["src/main.ts"],
        writePaths: ["dist/main.js"],
        allowWorkspaceRoot: true,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 5242880,
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
        allowedCommands: ["tsc"],
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
        maxCpuUsagePercent: 50,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 10000,
        maxOutputSizeBytes: 524288,
      },
    };

    const result = engine.evaluateInvocation(validManifest, testEnvelope, validContext);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.grant).toBeDefined();
      expect(result.grant.invocationId).toBe("inv_test_001");
      expect(result.grant.workspaceId).toBe("ws_prod_01");
      expect(result.effectiveCapabilities.command.allowedCommands).toEqual(["tsc"]);

      // Verify the generated grant signature
      const verification = verifyInvocationGrant(result.grant);
      expect(verification.valid).toBe(true);
    }
  });

  it("evaluates a full ToolManifest input correctly", () => {
    const engine = new CapabilityPolicyEngine({
      workspaceRoot: "/tmp/ws_prod_01",
    });

    const toolManifest: ToolManifest = {
      id: "git_fetcher",
      name: "git-fetcher",
      version: "2.1.0",
      description: "Fetches git branches safely",
      capabilities: {
        fs: {
          readPaths: ["src/**"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
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
          allowEnvPassthrough: [],
        },
        secrets: {
          allowedSecretNames: ["GITHUB_TOKEN"],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      },
      runtime: { type: "deno_worker" },
      parameters: { type: "object", properties: {} },
      entrypoint: "src/index.ts",
      limits: { maxMemoryBytes: 134217728, maxExecutionTimeMs: 30000 },
      scope: "workspace",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      createdAt: new Date().toISOString(),
    };

    const context: InvocationContext = {
      ...validContext,
      toolId: "git_fetcher",
      toolVersion: "2.1.0",
    };

    const result = engine.evaluateInvocation(toolManifest, testEnvelope, context);
    expect(result.allowed).toBe(true);
  });

  describe("Denial on Attempted Envelope Expansion", () => {
    it("denies expansion on unauthorized filesystem path", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const manifest: CapabilityManifest = {
        fs: {
          readPaths: ["config/passwords.json"], // Inside workspace, but not allowed by envelope (which allows only src/** and tests/**)
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const result = engine.evaluateInvocation(manifest, testEnvelope, validContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("FS_PATH_NOT_ALLOWED");
        expect(result.violations.length).toBeGreaterThan(0);
      }
    });

    it("denies expansion on path traversal escaping workspace root", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const manifest: CapabilityManifest = {
        fs: {
          readPaths: ["../../etc/shadow"], // Path traversal escaping workspace
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const result = engine.evaluateInvocation(manifest, testEnvelope, validContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("FS_TRAVERSAL_DETECTED");
        expect(result.violations.length).toBeGreaterThan(0);
      }
    });

    it("denies expansion on unauthorized network domain", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const manifest: CapabilityManifest = {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: true,
          allowedDomains: ["unauthorized-data-sink.com"],
          allowedHosts: [],
          allowedPorts: [443],
          allowedProtocols: ["https"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const result = engine.evaluateInvocation(manifest, testEnvelope, validContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("NET_DOMAIN_NOT_ALLOWED");
      }
    });

    it("denies expansion when tool attempts shell execution", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const manifest: CapabilityManifest = {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
        command: {
          allowShellExecution: true, // Forbidden by envelope
          allowedCommands: ["bash"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const result = engine.evaluateInvocation(manifest, testEnvelope, validContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("CMD_SHELL_FORBIDDEN");
      }
    });
  });

  describe("Unknown Capability Types Rejection", () => {
    it("denies requests with unknown top-level capability properties", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const manifestWithUnknown = {
        fs: {
          readPaths: ["src/**"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
        rawDiskAccess: true, // Unknown capability type
        bluetooth: { enabled: true }, // Unknown capability type
      };

      const result = engine.evaluateInvocation(manifestWithUnknown, testEnvelope, validContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("UNKNOWN_CAPABILITY_TYPE");
        expect(result.violations.some((v) => v.code === "UNKNOWN_CAPABILITY_TYPE")).toBe(true);
      }
    });

    it("denies requests with unknown subsystem properties", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const manifestWithUnknownSub = {
        fs: {
          readPaths: ["src/**"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
          rawInodeAccess: true, // Unknown sub-key
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const result = engine.evaluateInvocation(manifestWithUnknownSub, testEnvelope, validContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("UNKNOWN_CAPABILITY_TYPE");
      }
    });
  });

  describe("Frozen Envelope & Workspace Mismatch", () => {
    it("denies dynamic expansion attempts on frozen envelope", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const frozenEnvelope: CapabilityEnvelope = {
        ...testEnvelope,
        isFrozen: true,
      };

      const expandingManifest: CapabilityManifest = {
        fs: {
          readPaths: ["extra/path/**"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const result = engine.evaluateInvocation(expandingManifest, frozenEnvelope, validContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("ENVELOPE_FROZEN");
      }
    });

    it("denies invocation when context workspaceId does not match envelope workspaceId", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });

      const mismatchedContext: InvocationContext = {
        ...validContext,
        workspaceId: "ws_other_workspace",
      };

      const manifest: CapabilityManifest = {
        fs: {
          readPaths: ["src/**"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const result = engine.evaluateInvocation(manifest, testEnvelope, mismatchedContext);

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.denyCode).toBe("WORKSPACE_MISMATCH");
      }
    });
  });

  describe("Cache Invalidation", () => {
    it("caches evaluation results and invalidates immediately when envelope is updated", () => {
      const engine = new CapabilityPolicyEngine({
        workspaceRoot: "/tmp/ws_prod_01",
      });
      engine.setEnvelope(testEnvelope);

      const manifest: CapabilityManifest = {
        fs: {
          readPaths: ["src/index.ts"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      // First evaluation (not cached)
      const res1 = engine.evaluateInvocation(manifest, testEnvelope, validContext);
      expect(res1.allowed).toBe(true);

      // Second evaluation (cached)
      const res2 = engine.evaluateInvocation(manifest, testEnvelope, validContext);
      expect(res2.allowed).toBe(true);
      if (res2.allowed) {
        expect(res2.cached).toBe(true);
      }

      // Update envelope -> cache must be invalidated
      const updatedEnvelope: CapabilityEnvelope = {
        ...testEnvelope,
        version: "1.1.0",
      };
      engine.setEnvelope(updatedEnvelope);

      // Third evaluation after invalidation
      const res3 = engine.evaluateInvocation(manifest, updatedEnvelope, validContext);
      expect(res3.allowed).toBe(true);
      if (res3.allowed) {
        expect(res3.cached).toBeUndefined();
      }
    });
  });
});
