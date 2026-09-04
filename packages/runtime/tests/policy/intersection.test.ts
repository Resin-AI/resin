import type { CapabilityEnvelope, CapabilityManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { intersectCapabilities } from "../../src/policy/intersection.js";

const testWorkspace = "/tmp/test-ws";

const baseEnvelope: CapabilityEnvelope = {
  envelopeId: "env_ws_001",
  workspaceId: "ws_001",
  version: "1.0.0",
  fs: {
    readPaths: ["<WORKSPACE_ROOT>/src/**", "<WORKSPACE_ROOT>/public/**"],
    writePaths: ["<WORKSPACE_ROOT>/dist/**"],
    allowWorkspaceRoot: true,
    allowTemp: true,
    denyPaths: ["<WORKSPACE_ROOT>/.git/**", "<WORKSPACE_ROOT>/.env*"],
    maxFileSizeBytes: 10485760, // 10MB
  },
  net: {
    allowOutbound: true,
    allowedDomains: ["api.github.com", "*.npmjs.org"],
    allowedHosts: [],
    allowedPorts: [443, 80],
    allowedProtocols: ["https"],
    allowLocalhost: false,
    denyPrivateRanges: true,
  },
  command: {
    allowShellExecution: false,
    allowedCommands: ["git", "node"],
    allowedBinaries: ["/usr/bin/git"],
    forbiddenPatterns: ["rm -rf", "sudo", "eval"],
    allowEnvPassthrough: ["NODE_ENV", "PORT"],
  },
  secrets: {
    allowedSecretNames: ["GITHUB_TOKEN", "NPM_TOKEN"],
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

function createCommandRequest(allowedCommands: string[]): CapabilityManifest {
  return {
    fs: {
      readPaths: [],
      writePaths: [],
      allowWorkspaceRoot: false,
      allowTemp: false,
      denyPaths: [],
      maxFileSizeBytes: 10485760,
    },
    net: {
      allowOutbound: false,
      allowedDomains: [],
      allowedHosts: [],
      allowedPorts: [],
      allowedProtocols: [],
      allowLocalhost: false,
      denyPrivateRanges: true,
    },
    command: {
      allowShellExecution: false,
      allowedCommands,
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
}

describe("Capability Intersection", () => {
  it("computes exact least-privilege intersection when request is a valid subset", () => {
    const requested: CapabilityManifest = {
      manifestId: "man_001",
      fs: {
        readPaths: ["src/index.ts", "public/logo.png"],
        writePaths: ["dist/bundle.js"],
        allowWorkspaceRoot: true,
        allowTemp: false,
        denyPaths: [".git/**"],
        maxFileSizeBytes: 5242880, // 5MB (less than 10MB)
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
        maxMemoryMb: 128,
        maxExecutionTimeMs: 10000,
        maxOutputSizeBytes: 524288,
      },
    };

    const result = intersectCapabilities(requested, baseEnvelope, {
      workspaceRoot: testWorkspace,
    });

    expect(result.isExactSubset).toBe(true);
    expect(result.expansionAttempted).toBe(false);
    expect(result.violations).toHaveLength(0);

    // Verify granted capabilities are exactly the requested subset
    expect(result.grantCapabilities.fs.readPaths).toHaveLength(2);
    expect(result.grantCapabilities.fs.writePaths).toHaveLength(1);
    expect(result.grantCapabilities.fs.maxFileSizeBytes).toBe(5242880);
    expect(result.grantCapabilities.net.allowedDomains).toEqual(["api.github.com"]);
    expect(result.grantCapabilities.command.allowedCommands).toEqual(["git"]);
    expect(result.grantCapabilities.secrets.allowedSecretNames).toEqual(["GITHUB_TOKEN"]);
    expect(result.grantCapabilities.limits.maxMemoryMb).toBe(128);
  });

  describe("Filesystem Intersection Violations", () => {
    it("detects read path expansion outside approved envelope", () => {
      const requested: CapabilityManifest = {
        fs: {
          readPaths: ["src/index.ts", "config/passwords.json"], // config/ is not in envelope
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.isExactSubset).toBe(false);
      expect(result.expansionAttempted).toBe(true);
      expect(result.violations.some((v) => v.code === "FS_PATH_EXPANSION")).toBe(true);
      expect(result.grantCapabilities.fs.readPaths).toHaveLength(1); // Only src/index.ts granted
    });

    it("detects write path expansion outside approved envelope", () => {
      const requested: CapabilityManifest = {
        fs: {
          readPaths: ["src/index.ts"],
          writePaths: ["src/overwritten.ts"], // write to src/ is not allowed by envelope (only dist/)
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.isExactSubset).toBe(false);
      expect(result.violations.some((v) => v.code === "FS_WRITE_PATH_EXPANSION")).toBe(true);
    });

    it("denies access to paths covered by envelope denyPaths", () => {
      const requested: CapabilityManifest = {
        fs: {
          readPaths: [".env.local"],
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.expansionAttempted).toBe(true);
      expect(result.grantCapabilities.fs.readPaths).toHaveLength(0);
    });
  });

  describe("Network Intersection Violations", () => {
    it("detects unauthorized domain request", () => {
      const requested: CapabilityManifest = {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: true,
          allowedDomains: ["api.evil.com"], // Not allowed by envelope
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.violations.some((v) => v.code === "NET_DOMAIN_EXPANSION")).toBe(true);
      expect(result.grantCapabilities.net.allowedDomains).toHaveLength(0);
    });

    it("blocks private/internal IP requests strictly", () => {
      const requested: CapabilityManifest = {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: true,
          allowedDomains: ["169.254.169.254", "127.0.0.1", "10.0.0.1"],
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.violations.some((v) => v.code === "NET_PRIVATE_IP_BLOCKED")).toBe(true);
      expect(result.grantCapabilities.net.allowedDomains).toHaveLength(0);
    });

    it("detects outbound forbidden when envelope disables outbound network", () => {
      const noNetEnvelope: CapabilityEnvelope = {
        ...baseEnvelope,
        net: {
          ...baseEnvelope.net,
          allowOutbound: false,
        },
      };

      const requested: CapabilityManifest = {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
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

      const result = intersectCapabilities(requested, noNetEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.violations.some((v) => v.code === "NET_OUTBOUND_FORBIDDEN")).toBe(true);
      expect(result.grantCapabilities.net.allowOutbound).toBe(false);
    });
  });

  describe("Command Subsystem Violations", () => {
    it("detects shell execution denial", () => {
      const requested: CapabilityManifest = {
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
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
        command: {
          allowShellExecution: true, // Envelope has allowShellExecution: false
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.violations.some((v) => v.code === "CMD_SHELL_FORBIDDEN")).toBe(true);
      expect(result.grantCapabilities.command.allowShellExecution).toBe(false);
    });

    it("detects command expansion outside allowed commands", () => {
      const requested: CapabilityManifest = {
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
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
        command: {
          allowShellExecution: false,
          allowedCommands: ["curl", "wget"], // Not in allowed commands
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.violations.some((v) => v.code === "CMD_COMMAND_EXPANSION")).toBe(true);
      expect(result.grantCapabilities.command.allowedCommands).toHaveLength(0);
    });

    it("authorizes requested command profiles through envelope profiles", () => {
      const requestedTemplate = createCommandRequest(["node --test $TEST_FILE"]);
      const bareExecutableEnvelope: CapabilityEnvelope = {
        ...baseEnvelope,
        command: {
          ...baseEnvelope.command,
          allowedCommands: ["node"],
        },
      };

      const bareResult = intersectCapabilities(requestedTemplate, bareExecutableEnvelope, {
        workspaceRoot: testWorkspace,
      });
      expect(bareResult.grantCapabilities.command.allowedCommands).toEqual([
        "node --test $TEST_FILE",
      ]);
      expect(bareResult.violations.some((v) => v.code === "CMD_COMMAND_EXPANSION")).toBe(false);

      const templatedEnvelope: CapabilityEnvelope = {
        ...baseEnvelope,
        command: {
          ...baseEnvelope.command,
          allowedCommands: ["node --test $TEST_FILE"],
        },
      };
      const templatedResult = intersectCapabilities(requestedTemplate, templatedEnvelope, {
        workspaceRoot: testWorkspace,
      });
      expect(templatedResult.grantCapabilities.command.allowedCommands).toEqual([
        "node --test $TEST_FILE",
      ]);

      const mismatchedResult = intersectCapabilities(
        createCommandRequest(["node --check $TEST_FILE"]),
        templatedEnvelope,
        { workspaceRoot: testWorkspace },
      );
      expect(mismatchedResult.grantCapabilities.command.allowedCommands).toEqual([]);
      expect(mismatchedResult.violations.some((v) => v.code === "CMD_COMMAND_EXPANSION")).toBe(
        true,
      );
    });
  });

  describe("Secrets Subsystem Violations", () => {
    it("detects secret alias expansion outside approved envelope", () => {
      const requested: CapabilityManifest = {
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
          allowedSecretNames: ["AWS_SECRET_ACCESS_KEY", "STRIPE_SECRET_KEY"], // Not authorized
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

      const result = intersectCapabilities(requested, baseEnvelope, {
        workspaceRoot: testWorkspace,
      });

      expect(result.violations.some((v) => v.code === "SECRET_NAME_EXPANSION")).toBe(true);
      expect(result.grantCapabilities.secrets.allowedSecretNames).toHaveLength(0);
    });
  });
});
