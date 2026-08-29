import type { CapabilityEnvelope, CapabilityManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  assessRiskLevel,
  diffCapabilities,
  explainDenial,
  generateRemediationCommands,
  inspectPolicy,
} from "../../src/policy/inspector.js";
import type { PolicyViolation } from "../../src/policy/intersection.js";

const testEnvelope: CapabilityEnvelope = {
  envelopeId: "env_test_ws",
  workspaceId: "ws_test_01",
  version: "1.0.0",
  fs: {
    readPaths: ["<WORKSPACE_ROOT>/src/**"],
    writePaths: [],
    allowWorkspaceRoot: true,
    allowTemp: false,
    denyPaths: [".git/**"],
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
    maxConcurrentExecutions: 2,
    maxCpuUsagePercent: 100,
    maxMemoryMb: 128,
    maxExecutionTimeMs: 30000,
    maxOutputSizeBytes: 1048576,
  },
  isFrozen: false,
  createdAt: new Date().toISOString(),
};

describe("Policy Inspector", () => {
  describe("Risk Level Assessment", () => {
    it("assigns CRITICAL risk when shell execution is requested", () => {
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
          allowShellExecution: true,
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

      const { riskLevel, riskFactors } = assessRiskLevel(manifest);
      expect(riskLevel).toBe("CRITICAL");
      expect(riskFactors.some((f) => f.includes("Shell execution"))).toBe(true);
    });

    it("assigns CRITICAL risk when direct secret read is requested", () => {
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
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
        secrets: {
          allowedSecretNames: ["KEY"],
          allowedPrefixes: [],
          denyDirectRead: false,
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

      const { riskLevel, riskFactors } = assessRiskLevel(manifest);
      expect(riskLevel).toBe("CRITICAL");
      expect(riskFactors.some((f) => f.includes("Direct read"))).toBe(true);
    });

    it("assigns HIGH risk when file write access is requested", () => {
      const manifest: CapabilityManifest = {
        fs: {
          readPaths: [],
          writePaths: ["dist/out.js"],
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

      const { riskLevel, riskFactors } = assessRiskLevel(manifest);
      expect(riskLevel).toBe("HIGH");
      expect(riskFactors.some((f) => f.includes("File write access"))).toBe(true);
    });

    it("assigns LOW risk for read-only workspace operations", () => {
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

      const { riskLevel } = assessRiskLevel(manifest);
      expect(riskLevel).toBe("LOW");
    });
  });

  describe("Remediation CLI Commands", () => {
    it("generates actionable CLI remediation commands for violations", () => {
      const violations: PolicyViolation[] = [
        {
          code: "NET_DOMAIN_EXPANSION",
          subsystem: "net",
          message: "Domain not allowed",
          requestedValue: "api.service.com",
        },
        {
          code: "FS_WRITE_PATH_EXPANSION",
          subsystem: "fs",
          message: "Write path not allowed",
          requestedValue: "dist/build/**",
        },
        {
          code: "CMD_COMMAND_EXPANSION",
          subsystem: "command",
          message: "Command not allowed",
          requestedValue: "cargo",
        },
        {
          code: "SECRET_NAME_EXPANSION",
          subsystem: "secrets",
          message: "Secret not allowed",
          requestedValue: "STRIPE_API_KEY",
        },
      ];

      const commands = generateRemediationCommands(violations);

      expect(commands).toContain("resin envelope expand --add-domain api.service.com");
      expect(commands).toContain('resin envelope expand --add-write-path "dist/build/**"');
      expect(commands).toContain("resin envelope expand --add-command cargo");
      expect(commands).toContain("resin envelope expand --add-secret STRIPE_API_KEY");
    });
  });

  describe("Policy Inspection", () => {
    it("inspects policy and returns comprehensive summary", () => {
      const manifest: CapabilityManifest = {
        fs: {
          readPaths: ["src/**", "config/**"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: true,
          allowedDomains: ["api.github.com", "api.stripe.com"],
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
          maxConcurrentExecutions: 2,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const inspection = inspectPolicy(manifest, testEnvelope, {
        workspaceRoot: "/tmp/test-ws",
      });

      expect(inspection.status).toBe("EXPANSION_REQUIRED");
      expect(inspection.violations.length).toBeGreaterThan(0);
      expect(inspection.remediationCommands.length).toBeGreaterThan(0);
      expect(inspection.remediationCommands).toContain(
        "resin envelope expand --add-domain api.stripe.com",
      );
    });
  });

  describe("Capability Diff API", () => {
    it("computes structured diff showing added and broadened capabilities", () => {
      const source: CapabilityManifest = {
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
          allowedCommands: ["git"],
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

      const target: CapabilityManifest = {
        fs: {
          readPaths: ["src/**", "tests/**"],
          writePaths: ["dist/**"],
          allowWorkspaceRoot: true,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 20971520,
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
          allowedCommands: ["git", "node"],
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
          maxConcurrentExecutions: 2,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 256,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      };

      const diff = diffCapabilities(source, target);

      expect(diff.hasChanges).toBe(true);
      expect(diff.isBroadening).toBe(true);
      expect(diff.added["fs.readPaths"]).toContain("tests/**");
      expect(diff.added["fs.writePaths"]).toContain("dist/**");
      expect(diff.added["net.allowedDomains"]).toContain("api.github.com");
      expect(diff.added["command.allowedCommands"]).toContain("node");
      expect(diff.modified["net.allowOutbound"]).toEqual({ before: false, after: true });
    });
  });

  describe("Denial Explanation API", () => {
    it("provides clear human-readable explanation and CLI remediation commands", () => {
      const violations: PolicyViolation[] = [
        {
          code: "NET_DOMAIN_EXPANSION",
          subsystem: "net",
          message: "Requested domain 'api.slack.com' is not authorized in workspace envelope",
          requestedValue: "api.slack.com",
        },
      ];

      const explanation = explainDenial(violations);

      expect(explanation.primaryReason).toContain("api.slack.com");
      expect(explanation.summary).toContain("Found 1 policy violation(s)");
      expect(explanation.remediationCommands).toContain(
        "resin envelope expand --add-domain api.slack.com",
      );
    });
  });
});
