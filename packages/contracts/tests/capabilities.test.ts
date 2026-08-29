import { describe, expect, it } from "vitest";
import { validCapabilityEnvelope, validCapabilityGrant } from "../fixtures/index.js";
import {
  CapabilityEnvelopeSchema,
  CapabilityGrantSchema,
  CapabilityLimitsSchema,
  CapabilityManifestSchema,
  CommandCapabilitySchema,
  FsCapabilitySchema,
  NetCapabilitySchema,
  SecretCapabilitySchema,
} from "../src/capabilities.js";

describe("capabilities contracts", () => {
  describe("FsCapabilitySchema", () => {
    it("parses valid fs capability with defaults", () => {
      const fsCap = FsCapabilitySchema.parse({
        readPaths: ["src/**"],
        writePaths: ["dist/**"],
      });
      expect(fsCap.allowWorkspaceRoot).toBe(true);
      expect(fsCap.allowTemp).toBe(true);
      expect(fsCap.maxFileSizeBytes).toBe(10485760);
    });

    it("rejects non-positive maxFileSizeBytes", () => {
      expect(() =>
        FsCapabilitySchema.parse({
          maxFileSizeBytes: 0,
        }),
      ).toThrow();
    });
  });

  describe("NetCapabilitySchema", () => {
    it("parses valid network capabilities", () => {
      const netCap = NetCapabilitySchema.parse({
        allowOutbound: true,
        allowedDomains: ["api.openai.com"],
        allowedPorts: [443, 8443],
        allowedProtocols: ["https"],
      });
      expect(netCap.allowOutbound).toBe(true);
      expect(netCap.allowedPorts).toContain(443);
    });

    it("rejects invalid network ports", () => {
      expect(() =>
        NetCapabilitySchema.parse({
          allowedPorts: [0],
        }),
      ).toThrow();

      expect(() =>
        NetCapabilitySchema.parse({
          allowedPorts: [70000],
        }),
      ).toThrow();
    });
  });

  describe("CommandCapabilitySchema & SecretCapabilitySchema", () => {
    it("parses command capabilities", () => {
      const cmdCap = CommandCapabilitySchema.parse({
        allowedCommands: ["cargo build", "cargo test"],
        allowedBinaries: ["cargo"],
        forbiddenPatterns: ["sudo"],
      });
      expect(cmdCap.allowShellExecution).toBe(false);
      expect(cmdCap.allowedBinaries).toContain("cargo");
    });

    it("parses secrets capabilities", () => {
      const secCap = SecretCapabilitySchema.parse({
        allowedSecretNames: ["NPM_TOKEN"],
        denyDirectRead: true,
        injectAsEnv: true,
      });
      expect(secCap.denyDirectRead).toBe(true);
      expect(secCap.injectAsEnv).toBe(true);
    });
  });

  describe("CapabilityLimitsSchema", () => {
    it("parses limits within bounds", () => {
      const limits = CapabilityLimitsSchema.parse({
        maxConcurrentExecutions: 8,
        maxCpuUsagePercent: 80,
        maxMemoryMb: 256,
        maxExecutionTimeMs: 10000,
      });
      expect(limits.maxMemoryMb).toBe(256);
      expect(limits.maxCpuUsagePercent).toBe(80);
    });

    it("rejects cpu percent over 100", () => {
      expect(() =>
        CapabilityLimitsSchema.parse({
          maxCpuUsagePercent: 120,
        }),
      ).toThrow();
    });
  });

  describe("CapabilityGrantSchema & CapabilityEnvelopeSchema", () => {
    it("parses valid capability grant fixture", () => {
      const parsed = CapabilityGrantSchema.parse(validCapabilityGrant);
      expect(parsed.grantId).toBe("grant_001");
      expect(parsed.grantType).toBe("explicit");
      expect(parsed.actor.type).toBe("user");
    });

    it("parses valid capability envelope fixture", () => {
      const parsed = CapabilityEnvelopeSchema.parse(validCapabilityEnvelope);
      expect(parsed.envelopeId).toBe("env_ws_001");
      expect(parsed.isFrozen).toBe(false);
      expect(parsed.version).toBe("1.0.0");
    });

    it("rejects capability grant with invalid grantType", () => {
      const invalid = {
        ...validCapabilityGrant,
        grantType: "unauthorized_escalation",
      };
      expect(() => CapabilityGrantSchema.parse(invalid)).toThrow();
    });
  });
});
