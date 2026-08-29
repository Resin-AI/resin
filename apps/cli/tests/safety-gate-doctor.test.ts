import path from "node:path";
import {
  CURRENT_SAFETY_GATE_VERSION,
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_BUNDLE_VERIFIER_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  SAFETY_GATE_ERROR_CODES,
  UNSAFE_DEV_OVERRIDE_ENV_VAR,
} from "@resin/contracts";
import { createSafetyAttestation } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  doctorCommand,
  formatDoctorForTerminal,
  repairState,
  runDiagnostics,
} from "../src/commands/doctor.js";
import { collectStatus, formatStatusForTerminal } from "../src/commands/status.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
    async mkdir(_dirPath: string): Promise<void> {
      // In-memory mock
    },
    async mkdirp(_dirPath: string): Promise<void> {
      // In-memory mock
    },
  };
}
describe("CLI Safety Gate Doctor & Status Diagnostics", () => {
  const originalEnv = { ...process.env };
  const homeDir = "/home/testuser";
  const resinHome = path.join(homeDir, ".resin");
  const attestationPath = path.join(resinHome, "safety-attestation.json");

  beforeEach(() => {
    delete process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Doctor Diagnostics", () => {
    it("reports fail when safety attestation is missing on fresh install", async () => {
      const fsBridge = createMockFsBridge();
      const items = await runDiagnostics({ home: homeDir, fsBridge });

      const safetyItem = items.find((i) => i.id === "safety_gate");
      expect(safetyItem).toBeDefined();
      expect(safetyItem?.status).toBe("fail");
      expect(safetyItem?.message).toContain("No production safety attestation found");
      expect(safetyItem?.remediation).toContain("repair");
    });

    it("reports fail when safety attestation has expired", async () => {
      const expired = createSafetyAttestation({
        expiresAt: new Date(Date.now() - 10000).toISOString(),
      });
      const fsBridge = createMockFsBridge({
        [attestationPath]: JSON.stringify(expired),
      });

      const items = await runDiagnostics({ home: homeDir, fsBridge });
      const safetyItem = items.find((i) => i.id === "safety_gate");

      expect(safetyItem?.status).toBe("fail");
      expect(safetyItem?.message).toContain("expired");
    });

    it("reports fail when runtime version is incompatible (downgrade/upgrade)", async () => {
      const incompatible = createSafetyAttestation({
        compatibility: {
          runtimeVersion: "99.0.0",
          brokerProtocolVersion: REQUIRED_BROKER_PROTOCOL_VERSION,
          bundleVerifierVersion: REQUIRED_BUNDLE_VERIFIER_VERSION,
          policyVersion: REQUIRED_POLICY_VERSION,
        },
      });
      const fsBridge = createMockFsBridge({
        [attestationPath]: JSON.stringify(incompatible),
      });

      const items = await runDiagnostics({ home: homeDir, fsBridge });
      const safetyItem = items.find((i) => i.id === "safety_gate");

      expect(safetyItem?.status).toBe("fail");
      expect(safetyItem?.message).toContain("Runtime version mismatch");
    });

    it("reports warn when unsafe development override is active", async () => {
      process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR] = "1";
      const fsBridge = createMockFsBridge();

      const items = await runDiagnostics({ home: homeDir, fsBridge });
      const safetyItem = items.find((i) => i.id === "safety_gate");

      expect(safetyItem?.status).toBe("warn");
      expect(safetyItem?.message).toContain("Unsafe development override active");
    });

    it("reports pass when a valid attestation is present", async () => {
      const valid = createSafetyAttestation();
      const fsBridge = createMockFsBridge({
        [attestationPath]: JSON.stringify(valid),
      });

      const items = await runDiagnostics({ home: homeDir, fsBridge });
      const safetyItem = items.find((i) => i.id === "safety_gate");

      expect(safetyItem?.status).toBe("pass");
      expect(safetyItem?.message).toContain("Production safety attestation verified and valid");
    });
  });

  describe("Doctor Repair", () => {
    it("repairs missing safety attestation by executing signed local certification", async () => {
      const fsBridge = createMockFsBridge();

      // Verify fail before repair
      const beforeItems = await runDiagnostics({ home: homeDir, fsBridge });
      expect(beforeItems.find((i) => i.id === "safety_gate")?.status).toBe("fail");

      // Run repair
      const actions = await repairState({
        home: homeDir,
        fsBridge,
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },
      });
      expect(
        actions.some((a) => a.includes("Certified and wrote production safety attestation")),
      ).toBe(true);

      // Verify file was written
      expect(await fsBridge.exists(attestationPath)).toBe(true);

      // Verify pass after repair
      const afterItems = await runDiagnostics({ home: homeDir, fsBridge });
      expect(afterItems.find((i) => i.id === "safety_gate")?.status).toBe("pass");
    });
  });

  describe("Status Command", () => {
    it("reports BLOCKED in status output when attestation is missing", async () => {
      const fsBridge = createMockFsBridge();
      const summary = await collectStatus({ home: homeDir, fsBridge });

      expect(summary.safetyGate).toBeDefined();
      expect(summary.safetyGate?.isOpen).toBe(false);
      expect(summary.safetyGate?.status).toBe("uninitialized");

      const formatted = formatStatusForTerminal(summary);
      expect(formatted).toContain("[Production Safety Gate]");
      expect(formatted).toContain("BLOCKED (fail-closed)");
    });

    it("reports PASS in status output when attestation is valid", async () => {
      const valid = createSafetyAttestation();
      const fsBridge = createMockFsBridge({
        [attestationPath]: JSON.stringify(valid),
      });
      const summary = await collectStatus({ home: homeDir, fsBridge });

      expect(summary.safetyGate?.isOpen).toBe(true);
      expect(summary.safetyGate?.status).toBe("passed");

      const formatted = formatStatusForTerminal(summary);
      expect(formatted).toContain("[Production Safety Gate]");
      expect(formatted).toContain("PASS (open)");
    });

    it("reports OVERRIDE in status output when unsafe override is enabled", async () => {
      process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR] = "true";
      const fsBridge = createMockFsBridge();
      const summary = await collectStatus({ home: homeDir, fsBridge });

      expect(summary.safetyGate?.isOpen).toBe(true);
      expect(summary.safetyGate?.status).toBe("unsafe_override");

      const formatted = formatStatusForTerminal(summary);
      expect(formatted).toContain("OVERRIDE (unsafe dev mode)");
    });
  });
});
