import crypto from "node:crypto";
import {
  type ToolManifest,
  type V1ActivationCertificate,
  type V1LockedToolEntry,
  hashCanonical,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { LocalPreactivationChecker } from "../../src/sync/preactivation.js";
import type { TrustVerificationResult } from "../../src/sync/types.js";
import { createSampleCapabilityEnvelope, createSampleToolManifest } from "./fixtures.js";

function createValidLockedEntry(
  manifest: ToolManifest,
  overrides: Partial<V1LockedToolEntry> = {},
): V1LockedToolEntry {
  const manifestDigest = hashCanonical(manifest);
  const artifactDigest = crypto.createHash("sha256").update("artifact-content").digest("hex");
  return {
    toolId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    manifestDigest,
    artifactDigest,
    status: "active",
    ...overrides,
  };
}

function createValidCertificate(
  manifest: ToolManifest,
  projectId: string,
  overrides: Partial<V1ActivationCertificate> = {},
): V1ActivationCertificate {
  const manifestDigest = hashCanonical(manifest);
  const artifactDigest = crypto.createHash("sha256").update("artifact-content").digest("hex");
  const now = Date.now();
  return {
    schemaKind: "activation_certificate",
    schemaVersion: 1,
    certificateId: crypto.randomUUID(),
    subject: {
      accountId: crypto.randomUUID(),
    },
    projectId,
    toolId: manifest.id,
    toolName: manifest.name,
    version: manifest.version,
    manifestDigest,
    artifactDigest,
    capabilityEnvelopeDigest: crypto.createHash("sha256").update("envelope-content").digest("hex"),
    qualificationEvidenceDigest: crypto
      .createHash("sha256")
      .update("evidence-content")
      .digest("hex"),
    counter: 1,
    nonce: "random-nonce-string-12345",
    issuedAt: new Date(now - 10000).toISOString(),
    notBefore: new Date(now - 10000).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
    status: "active",
    signature: {
      keyId: "key-1",
      algorithm: "ed25519",
      signature: "00".repeat(64),
      signedAt: new Date(now - 10000).toISOString(),
    },
    ...overrides,
  };
}

describe("LocalPreactivationChecker", () => {
  const checker = new LocalPreactivationChecker();

  it("approves a tool candidate whose capabilities conform to workspace envelope", async () => {
    const manifest = createSampleToolManifest("valid-tool", "1.0.0");
    const envelope = createSampleCapabilityEnvelope("ws-1");

    const result = await checker.checkPreactivation({
      manifest,
      workspaceId: "ws-1",
      envelope,
    });

    expect(result.eligible).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  describe("Filesystem Capability Constraints", () => {
    it("rejects read paths not permitted by workspace capability envelope", async () => {
      const manifest = createSampleToolManifest("fs-violator", "1.0.0", {
        capabilities: {
          fs: {
            readPaths: ["/root/.ssh/id_rsa"],
            writePaths: [],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        fs: {
          readPaths: ["src", "lib"],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [".env"],
          maxFileSizeBytes: 10485760,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "FS_READ_PATH_DISALLOWED")).toBe(true);
    });

    it("rejects write paths that match envelope deny paths", async () => {
      const manifest = createSampleToolManifest("deny-violator", "1.0.0", {
        capabilities: {
          fs: {
            readPaths: [],
            writePaths: [".env"],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 1048576,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        fs: {
          readPaths: ["."],
          writePaths: ["."],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [".env", ".git"],
          maxFileSizeBytes: 10485760,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "FS_WRITE_PATH_DISALLOWED")).toBe(true);
    });

    it("rejects max file size exceeding envelope limit", async () => {
      const manifest = createSampleToolManifest("huge-file-tool", "1.0.0", {
        capabilities: {
          fs: {
            readPaths: ["."],
            writePaths: [],
            allowWorkspaceRoot: true,
            allowTemp: true,
            denyPaths: [],
            maxFileSizeBytes: 50 * 1024 * 1024, // 50MB
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        fs: {
          readPaths: ["."],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10 * 1024 * 1024, // 10MB limit
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "FS_MAX_SIZE_EXCEEDED")).toBe(true);
    });
  });

  describe("Network Capability Constraints", () => {
    it("rejects outbound network requests when envelope has allowOutbound=false", async () => {
      const manifest = createSampleToolManifest("net-tool", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedHosts: [],
            allowedPorts: [443],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: false, // Disallowed
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: [],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "NET_OUTBOUND_DISALLOWED")).toBe(true);
    });

    it("rejects domains not present in envelope domain whitelist", async () => {
      const manifest = createSampleToolManifest("domain-violator", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["untrusted-domain.com"],
            allowedHosts: [],
            allowedPorts: [443],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.example.com", "*.trusted.org"],
          allowedHosts: [],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "NET_DOMAIN_DISALLOWED")).toBe(true);
    });

    it("blocks private, loopback, and local IP addresses when denyPrivateRanges is true", async () => {
      const privateAddresses = ["127.0.0.1", "10.0.0.5", "192.168.1.1", "localhost", "172.16.0.1"];

      for (const ip of privateAddresses) {
        const manifest = createSampleToolManifest("private-ip-tool", "1.0.0", {
          capabilities: {
            net: {
              allowOutbound: true,
              allowedDomains: [ip],
              allowedHosts: [],
              allowedPorts: [80],
              allowedProtocols: ["http"],
              allowLocalhost: false,
              denyPrivateRanges: true,
            },
          },
        });
        const envelope = createSampleCapabilityEnvelope("ws-1", {
          net: {
            allowOutbound: true,
            allowedDomains: ["*"],
            allowedHosts: [],
            allowedPorts: [80, 443],
            allowedProtocols: ["http", "https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        });

        const result = await checker.checkPreactivation({
          manifest,
          workspaceId: "ws-1",
          envelope,
        });

        expect(result.eligible).toBe(false);
        expect(result.violations.some((v) => v.code === "NET_PRIVATE_IP_BLOCKED")).toBe(true);
      }
    });

    it("rejects disallowed network ports and protocols", async () => {
      const manifest = createSampleToolManifest("port-proto-tool", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedHosts: [],
            allowedPorts: [22], // SSH port not allowed
            allowedProtocols: ["ws"], // ws not in envelope protocols
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.example.com"],
          allowedHosts: [],
          allowedPorts: [443, 8443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "NET_PORT_DISALLOWED")).toBe(true);
      expect(result.violations.some((v) => v.code === "NET_PROTOCOL_DISALLOWED")).toBe(true);
    });
  });

  describe("Command & Shell Capability Constraints", () => {
    it("rejects shell execution when envelope has allowShellExecution=false", async () => {
      const manifest = createSampleToolManifest("shell-tool", "1.0.0", {
        capabilities: {
          command: {
            allowShellExecution: true,
            allowedCommands: ["bash -c 'ls'"],
            allowedBinaries: ["bash"],
            forbiddenPatterns: [],
            allowEnvPassthrough: [],
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        command: {
          allowShellExecution: false,
          allowedCommands: ["git status"],
          allowedBinaries: ["git"],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "COMMAND_SHELL_DISALLOWED")).toBe(true);
    });

    it("rejects dangerous environment variables requested in command capabilities", async () => {
      const dangerousVars = ["LD_PRELOAD", "NODE_OPTIONS", "PYTHONPATH", "RUBYOPT"];

      for (const envVar of dangerousVars) {
        const manifest = createSampleToolManifest("env-tool", "1.0.0", {
          capabilities: {
            command: {
              allowShellExecution: false,
              allowedCommands: ["git status"],
              allowedBinaries: ["git"],
              forbiddenPatterns: [],
              allowEnvPassthrough: [envVar],
            },
          },
        });
        const envelope = createSampleCapabilityEnvelope("ws-1");

        const result = await checker.checkPreactivation({
          manifest,
          workspaceId: "ws-1",
          envelope,
        });

        expect(result.eligible).toBe(false);
        expect(result.violations.some((v) => v.code === "DANGEROUS_ENV_VAR_REQUESTED")).toBe(true);
      }
    });
  });

  describe("Secrets & Limits Constraints", () => {
    it("rejects unauthorized secret names", async () => {
      const manifest = createSampleToolManifest("secret-tool", "1.0.0", {
        capabilities: {
          secrets: {
            allowedSecretNames: ["AWS_SECRET_ACCESS_KEY"], // Not permitted in envelope
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        secrets: {
          allowedSecretNames: ["API_TOKEN", "GITHUB_TOKEN"],
          allowedPrefixes: ["TOOL_"],
          denyDirectRead: true,
          injectAsEnv: true,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "SECRET_NAME_DISALLOWED")).toBe(true);
    });

    it("rejects memory and execution timeout limits exceeding envelope", async () => {
      const manifest = createSampleToolManifest("limits-tool", "1.0.0", {
        limits: {
          timeoutMs: 60000, // 60s > 30s envelope
          maxOutputBytes: 1048576,
          maxMemoryBytes: 512 * 1024 * 1024, // 512MB > 256MB envelope
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        limits: {
          maxConcurrentExecutions: 4,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 256,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 2097152,
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "LIMIT_TIMEOUT_EXCEEDED")).toBe(true);
      expect(result.violations.some((v) => v.code === "LIMIT_MEMORY_EXCEEDED")).toBe(true);
    });
  });

  describe("User Overrides: Pin & Disable", () => {
    it("rejects candidate when tool is explicitly disabled by user override", async () => {
      const manifest = createSampleToolManifest("disabled-tool", "1.0.0");
      const envelope = createSampleCapabilityEnvelope("ws-1");

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
        overrides: [
          {
            toolId: "disabled-tool",
            workspaceId: "ws-1",
            action: "disable",
            isEnabled: false,
          },
        ],
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "USER_DISABLED_OVERRIDE")).toBe(true);
    });

    it("rejects unpinned candidate version when tool is pinned to a specific version", async () => {
      const manifest = createSampleToolManifest("pinned-tool", "2.0.0"); // Candidate is 2.0.0
      const envelope = createSampleCapabilityEnvelope("ws-1");

      // 1. Version 2.0.0 does not match pinned version 1.0.0 -> Rejected
      const rejected = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
        overrides: [
          {
            toolId: "pinned-tool",
            workspaceId: "ws-1",
            action: "pin",
            pinnedVersion: "1.0.0",
            isEnabled: true,
          },
        ],
      });

      expect(rejected.eligible).toBe(false);
      expect(rejected.violations.some((v) => v.code === "USER_PIN_OVERRIDE")).toBe(true);

      // 2. Exact pinned version 1.0.0 -> Approved
      const pinnedManifest = createSampleToolManifest("pinned-tool", "1.0.0");
      const approved = await checker.checkPreactivation({
        manifest: pinnedManifest,
        workspaceId: "ws-1",
        envelope,
        overrides: [
          {
            toolId: "pinned-tool",
            workspaceId: "ws-1",
            action: "pin",
            pinnedVersion: "1.0.0",
            isEnabled: true,
          },
        ],
      });

      expect(approved.eligible).toBe(true);
      expect(approved.violations).toHaveLength(0);
    });
  });

  describe("Runtime Engine & Non-Executing Inspection", () => {
    it("rejects unsupported runtime engines", async () => {
      const manifest = createSampleToolManifest("unknown-engine-tool", "1.0.0", {
        runtime: {
          runtime: "shell",
          engine: "ruby_mri_3",
          minRuntimeVersion: "3.0.0",
        } as unknown as ToolManifest["runtime"],
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "UNSUPPORTED_RUNTIME")).toBe(true);
    });

    it("rejects inspection findings with invalid signature or path traversal", async () => {
      const manifest = createSampleToolManifest("traversal-tool", "1.0.0");

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        inspection: {
          manifest,
          bundleDigest: "dummy",
          files: [
            { path: "manifest.json", sizeBytes: 100, digest: "abc" },
            { path: "../../../escape.js", sizeBytes: 50, digest: "def" },
          ],
          signature: {
            keyId: "bad-key",
            algorithm: "ed25519",
            valid: false,
            trustLevel: "revoked",
            error: "Key revoked",
          },
        },
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "PATH_TRAVERSAL_DETECTED")).toBe(true);
      expect(result.violations.some((v) => v.code === "INVALID_SIGNATURE")).toBe(true);
    });
  });

  describe("V1 Locked Entry Integrity & Exact Version Gating", () => {
    it("approves a tool candidate when locked entry matches manifest tuple and digests", async () => {
      const manifest = createSampleToolManifest("locked-tool", "1.2.0");
      const envelope = createSampleCapabilityEnvelope("ws-1");
      const lockedEntry = createValidLockedEntry(manifest, {
        envelopeDigest: hashCanonical(envelope),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
        targetDigest: lockedEntry.artifactDigest,
        lockedEntry,
      });

      expect(result.eligible).toBe(true);
      expect(result.outcome).toBe("eligible");
      expect(result.violations).toHaveLength(0);
    });

    it("rejects when tool is disabled in lockfile", async () => {
      const manifest = createSampleToolManifest("disabled-tool", "1.0.0");
      const lockedEntry = createValidLockedEntry(manifest, { status: "disabled" });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        lockedEntry,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "LOCK_TOOL_DISABLED")).toBe(true);
    });

    it("rejects locked entry toolId mismatch", async () => {
      const manifest = createSampleToolManifest("tool-a", "1.0.0");
      const lockedEntry = createValidLockedEntry(manifest, { toolId: crypto.randomUUID() });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        lockedEntry,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "LOCK_TOOL_ID_MISMATCH")).toBe(true);
    });

    it("rejects locked entry tool name mismatch", async () => {
      const manifest = createSampleToolManifest("tool-original", "1.0.0");
      const lockedEntry = createValidLockedEntry(manifest, { name: "tool-different" });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        lockedEntry,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "LOCK_TOOL_NAME_MISMATCH")).toBe(true);
    });

    it("rejects locked entry version mismatch", async () => {
      const manifest = createSampleToolManifest("tool-ver", "1.0.0");
      const lockedEntry = createValidLockedEntry(manifest, { version: "2.0.0" });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        lockedEntry,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "LOCK_VERSION_MISMATCH")).toBe(true);
    });

    it("rejects locked entry manifest digest mismatch", async () => {
      const manifest = createSampleToolManifest("tool-digest", "1.0.0");
      const lockedEntry = createValidLockedEntry(manifest, {
        manifestDigest: "0".repeat(64),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        lockedEntry,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "LOCK_MANIFEST_DIGEST_MISMATCH")).toBe(true);
    });

    it("rejects locked entry artifact digest mismatch", async () => {
      const manifest = createSampleToolManifest("tool-art-digest", "1.0.0");
      const lockedEntry = createValidLockedEntry(manifest, {
        artifactDigest: "a".repeat(64),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        targetDigest: "b".repeat(64),
        lockedEntry,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "LOCK_ARTIFACT_DIGEST_MISMATCH")).toBe(true);
    });

    it("rejects locked entry envelope digest mismatch", async () => {
      const manifest = createSampleToolManifest("tool-env-digest", "1.0.0");
      const envelope = createSampleCapabilityEnvelope("ws-1");
      const lockedEntry = createValidLockedEntry(manifest, {
        envelopeDigest: "c".repeat(64),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
        lockedEntry,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "LOCK_ENVELOPE_DIGEST_MISMATCH")).toBe(true);
    });
  });

  describe("V1 Activation Certificate Binding & Validity", () => {
    const projectId = crypto.randomUUID();

    it("approves when certificate binds exact tuple, project, digests, and active status", async () => {
      const manifest = createSampleToolManifest("cert-tool", "1.0.0");
      const envelope = createSampleCapabilityEnvelope("ws-1");
      const envelopeDigest = hashCanonical(envelope);
      const manifestDigest = hashCanonical(manifest);
      const artifactDigest = "d".repeat(64);
      const evidenceDigest = "e".repeat(64);

      const lockedEntry = createValidLockedEntry(manifest, {
        manifestDigest,
        artifactDigest,
        envelopeDigest,
      });

      const certificate = createValidCertificate(manifest, projectId, {
        manifestDigest,
        artifactDigest,
        capabilityEnvelopeDigest: envelopeDigest,
        qualificationEvidenceDigest: evidenceDigest,
        status: "active",
      });

      const trustVerification: TrustVerificationResult = {
        trusted: true,
        certificate,
      };

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        envelope,
        targetDigest: artifactDigest,
        lockedEntry,
        certificate,
        trustVerification,
        inspection: {
          manifest,
          bundleDigest: artifactDigest,
          artifactDigest,
          manifestDigest,
          qualificationEvidenceDigest: evidenceDigest,
          files: [{ path: "index.js", sizeBytes: 100, digest: "f".repeat(64) }],
        },
      });

      expect(result.eligible).toBe(true);
      expect(result.outcome).toBe("eligible");
      expect(result.violations).toHaveLength(0);
    });

    it("rejects certificate toolId mismatch", async () => {
      const manifest = createSampleToolManifest("tool-cert-id", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        toolId: crypto.randomUUID(),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_TOOL_ID_MISMATCH")).toBe(true);
    });

    it("rejects certificate toolName mismatch", async () => {
      const manifest = createSampleToolManifest("tool-name-a", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        toolName: "tool-name-b",
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_TOOL_NAME_MISMATCH")).toBe(true);
    });

    it("rejects certificate version mismatch", async () => {
      const manifest = createSampleToolManifest("tool-ver-cert", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        version: "1.1.0",
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_VERSION_MISMATCH")).toBe(true);
    });

    it("rejects certificate projectId mismatch", async () => {
      const manifest = createSampleToolManifest("tool-proj-cert", "1.0.0");
      const certificate = createValidCertificate(manifest, crypto.randomUUID());

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_PROJECT_ID_MISMATCH")).toBe(
        true,
      );
    });

    it("rejects certificate manifestDigest mismatch", async () => {
      const manifest = createSampleToolManifest("tool-man-digest", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        manifestDigest: "1".repeat(64),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_MANIFEST_DIGEST_MISMATCH")).toBe(
        true,
      );
    });

    it("rejects certificate artifactDigest mismatch", async () => {
      const manifest = createSampleToolManifest("tool-art-cert", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        artifactDigest: "2".repeat(64),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        targetDigest: "3".repeat(64),
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_ARTIFACT_DIGEST_MISMATCH")).toBe(
        true,
      );
    });

    it("rejects certificate capability envelope digest mismatch", async () => {
      const manifest = createSampleToolManifest("tool-env-cert", "1.0.0");
      const envelope = createSampleCapabilityEnvelope("ws-1");
      const certificate = createValidCertificate(manifest, projectId, {
        capabilityEnvelopeDigest: "4".repeat(64),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        envelope,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_ENVELOPE_DIGEST_MISMATCH")).toBe(
        true,
      );
    });

    it("rejects certificate qualification evidence digest mismatch", async () => {
      const manifest = createSampleToolManifest("tool-evid-cert", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        qualificationEvidenceDigest: "5".repeat(64),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
        inspection: {
          manifest,
          bundleDigest: "6".repeat(64),
          qualificationEvidenceDigest: "7".repeat(64),
          files: [],
        },
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("mismatch");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_EVIDENCE_DIGEST_MISMATCH")).toBe(
        true,
      );
    });

    it("rejects revoked activation certificate", async () => {
      const manifest = createSampleToolManifest("tool-revoked-cert", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        status: "revoked",
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "CERTIFICATE_REVOKED")).toBe(true);
    });

    it("rejects suspended activation certificate", async () => {
      const manifest = createSampleToolManifest("tool-suspended-cert", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId, {
        status: "suspended",
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "CERTIFICATE_SUSPENDED")).toBe(true);
    });

    it("rejects expired activation certificate", async () => {
      const manifest = createSampleToolManifest("tool-expired-cert", "1.0.0");
      const now = Date.now();
      const certificate = createValidCertificate(manifest, projectId, {
        issuedAt: new Date(now - 200000).toISOString(),
        notBefore: new Date(now - 200000).toISOString(),
        expiresAt: new Date(now - 100000).toISOString(),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "CERTIFICATE_EXPIRED")).toBe(true);
    });

    it("rejects activation certificate not yet valid", async () => {
      const manifest = createSampleToolManifest("tool-future-cert", "1.0.0");
      const now = Date.now();
      const certificate = createValidCertificate(manifest, projectId, {
        issuedAt: new Date(now - 10000).toISOString(),
        notBefore: new Date(now + 100000).toISOString(),
        expiresAt: new Date(now + 200000).toISOString(),
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "CERTIFICATE_NOT_YET_VALID")).toBe(true);
    });
  });

  describe("Data-Only Trust Verification & Revocation Metadata", () => {
    const projectId = crypto.randomUUID();

    it("rejects when trustVerification.trusted is false", async () => {
      const manifest = createSampleToolManifest("untrusted-tool", "1.0.0");
      const trustVerification: TrustVerificationResult = {
        trusted: false,
        errorCode: "OFFLINE_TRUST_EXPIRED",
        reason: "Offline trust lease expired",
      };

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        trustVerification,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("untrusted");
      expect(result.violations.some((v) => v.code === "OFFLINE_TRUST_EXPIRED")).toBe(true);
    });

    it("rejects when certificate is listed in revocation metadata", async () => {
      const manifest = createSampleToolManifest("revoked-cert-tool", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId);
      const trustVerification: TrustVerificationResult = {
        trusted: false,
        certificate,
        revocationMetadata: {
          schemaKind: "revocation_metadata",
          schemaVersion: 1,
          revocationListId: crypto.randomUUID(),
          publisher: "cloud-authority",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          revokedCertificates: [
            {
              certificateId: certificate.certificateId,
              revokedAt: new Date().toISOString(),
              reason: "Key compromised",
            },
          ],
          revokedTools: [],
          signature: {
            keyId: "key-1",
            algorithm: "ed25519",
            signature: "00".repeat(64),
            signedAt: new Date().toISOString(),
          },
        },
      };

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
        trustVerification,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("untrusted");
      expect(result.violations.some((v) => v.code === "CERTIFICATE_REVOKED")).toBe(true);
    });

    it("rejects when tool is listed in revocation metadata", async () => {
      const manifest = createSampleToolManifest("revoked-tool-entry", "1.0.0");
      const certificate = createValidCertificate(manifest, projectId);
      const trustVerification: TrustVerificationResult = {
        trusted: false,
        certificate,
        revocationMetadata: {
          schemaKind: "revocation_metadata",
          schemaVersion: 1,
          revocationListId: crypto.randomUUID(),
          publisher: "cloud-authority",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          revokedCertificates: [],
          revokedTools: [
            {
              toolId: manifest.id,
              version: "1.0.0",
              revokedAt: new Date().toISOString(),
              reason: "Malware detected",
            },
          ],
          signature: {
            keyId: "key-1",
            algorithm: "ed25519",
            signature: "00".repeat(64),
            signedAt: new Date().toISOString(),
          },
        },
      };

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        projectId,
        certificate,
        trustVerification,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("untrusted");
      expect(result.violations.some((v) => v.code === "TOOL_REVOKED")).toBe(true);
    });
  });

  describe("Automatic Activation Outcome & Unrelated Tools Independence", () => {
    it("marks blocked_by_capability as deterministic outcome without pending approval", async () => {
      const manifest = createSampleToolManifest("cap-violator", "1.0.0", {
        capabilities: {
          fs: {
            readPaths: ["."],
            writePaths: ["/etc/shadow"],
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        fs: {
          readPaths: ["."],
          writePaths: ["./tmp"],
        },
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("blocked_by_capability");
      // Explicit verification: no proposal or pending approval state is created
      expect((result as Record<string, unknown>).approvalRequired).toBeUndefined();
      expect((result as Record<string, unknown>).pendingApproval).toBeUndefined();
    });

    it("evaluates multiple tools independently so a failure on one does not block unrelated tools", async () => {
      const invalidTool = createSampleToolManifest("bad-tool", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["malicious.site"],
            allowedHosts: [],
            allowedPorts: [80],
            allowedProtocols: ["http"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });

      const validTool = createSampleToolManifest("good-tool", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedHosts: [],
            allowedPorts: [443],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });

      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.example.com"],
          allowedHosts: [],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      const badResult = await checker.checkPreactivation({
        manifest: invalidTool,
        workspaceId: "ws-1",
        envelope,
      });

      const goodResult = await checker.checkPreactivation({
        manifest: validTool,
        workspaceId: "ws-1",
        envelope,
      });

      expect(badResult.eligible).toBe(false);
      expect(badResult.outcome).toBe("blocked_by_capability");

      // Unrelated tool succeeds immediately
      expect(goodResult.eligible).toBe(true);
      expect(goodResult.outcome).toBe("eligible");
    });
  });
  describe("Hostile-Cloud Adversarial Defense Suite", () => {
    const checker = new LocalPreactivationChecker();

    it("rejects unknown capability keys in manifest capabilities", async () => {
      const manifest = createSampleToolManifest("tool-unknown-caps", "1.0.0", {
        capabilities: {
          gpu: { requiredVram: 8192 },
          fs: {
            readPaths: ["src/**"],
            dangerousKey: true,
          },
        } as unknown as ToolManifest["capabilities"],
      });
      const envelope = createSampleCapabilityEnvelope("ws-1");

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("blocked_by_capability");
      expect(result.violations.some((v) => v.code === "UNKNOWN_CAPABILITY_TYPE")).toBe(true);
    });

    it("detects and rejects prototype pollution attempts in manifest", async () => {
      const raw = createSampleToolManifest("tool-pollute", "1.0.0");
      Object.defineProperty(raw.capabilities, "__proto__", {
        value: { admin: true },
        enumerable: true,
        configurable: true,
      });
      const envelope = createSampleCapabilityEnvelope("ws-1");

      const result = await checker.checkPreactivation({
        manifest: raw,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "UNKNOWN_CAPABILITY_TYPE")).toBe(true);
    });

    it("strictly fails closed when capabilities expand beyond envelope even with valid signature", async () => {
      // Tool requests net domain outside envelope
      const manifest = createSampleToolManifest("tool-evil-net", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["hostile-exfiltration.net"],
            allowedHosts: [],
            allowedPorts: [443],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.example.com"],
          allowedHosts: [],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      });

      // Pretend cloud says signature is 100% valid
      const inspection = {
        signature: {
          keyId: "key-prod-1",
          algorithm: "ed25519",
          valid: true,
          trustLevel: "production",
        },
        files: [{ path: "src/index.ts", sizeBytes: 100 }],
        bundleDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      };

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
        inspection,
      });

      // Local envelope authority must prevail - valid signature does NOT imply local permission!
      expect(result.eligible).toBe(false);
      expect(result.outcome).toBe("blocked_by_capability");
      expect(result.violations.some((v) => v.code === "NET_DOMAIN_DISALLOWED")).toBe(true);
    });

    it("rejects workspace binding mismatch on capability envelope", async () => {
      const manifest = createSampleToolManifest("tool-ws-check", "1.0.0");
      const envelope = createSampleCapabilityEnvelope("ws-wrong");

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-expected",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "WORKSPACE_MISMATCH")).toBe(true);
    });

    it("rejects activation when capability envelope is frozen", async () => {
      const manifest = createSampleToolManifest("tool-frozen-check", "1.0.0");
      const envelope = createSampleCapabilityEnvelope("ws-1", {
        isFrozen: true,
      });

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        envelope,
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "ENVELOPE_FROZEN")).toBe(true);
    });

    it("rejects account binding mismatch in activation certificate", async () => {
      const manifest = createSampleToolManifest("tool-account-check", "1.0.0");
      const certificate: V1ActivationCertificate = {
        schemaKind: "v1_activation_certificate",
        schemaVersion: "1.0.0",
        certificateId: "00000000-0000-0000-0000-000000000001",
        subject: {
          userId: "00000000-0000-0000-0000-000000000002",
          accountId: "00000000-0000-0000-0000-000000000003",
        },
        projectId: "00000000-0000-0000-0000-000000000004",
        toolId: manifest.id,
        toolName: manifest.name,
        version: manifest.version,
        manifestDigest: hashCanonical(manifest),
        artifactDigest: "00".repeat(32),
        capabilityEnvelopeDigest: "00".repeat(32),
        qualificationEvidenceDigest: "00".repeat(32),
        counter: 1,
        nonce: "nonce12345678",
        issuedAt: new Date(Date.now() - 60000).toISOString(),
        notBefore: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        status: "active",
        signatures: [],
      };

      const result = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        certificate,
        targetDigest: "00".repeat(32),
        ...({ accountId: "00000000-0000-0000-0000-000000000099" } as Record<string, unknown>),
      });

      expect(result.eligible).toBe(false);
      expect(result.violations.some((v) => v.code === "CERTIFICATE_ACCOUNT_ID_MISMATCH")).toBe(
        true,
      );
    });

    it("rejects expired or suspended certificates and untrusted signing keys", async () => {
      const manifest = createSampleToolManifest("tool-cert-check", "1.0.0");
      const expiredCert: V1ActivationCertificate = {
        schemaKind: "v1_activation_certificate",
        schemaVersion: "1.0.0",
        certificateId: "00000000-0000-0000-0000-000000000001",
        subject: {
          userId: "00000000-0000-0000-0000-000000000002",
          accountId: "00000000-0000-0000-0000-000000000003",
        },
        projectId: "00000000-0000-0000-0000-000000000004",
        toolId: manifest.id,
        toolName: manifest.name,
        version: manifest.version,
        manifestDigest: hashCanonical(manifest),
        artifactDigest: "00".repeat(32),
        capabilityEnvelopeDigest: "00".repeat(32),
        qualificationEvidenceDigest: "00".repeat(32),
        counter: 1,
        nonce: "nonce12345678",
        issuedAt: new Date(Date.now() - 120000).toISOString(),
        notBefore: new Date(Date.now() - 120000).toISOString(),
        expiresAt: new Date(Date.now() - 60000).toISOString(), // Expired
        status: "active",
        signatures: [],
      };

      const expResult = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        certificate: expiredCert,
        targetDigest: "00".repeat(32),
      });
      expect(expResult.eligible).toBe(false);
      expect(expResult.violations.some((v) => v.code === "CERTIFICATE_EXPIRED")).toBe(true);

      // Untrusted signing key in trust verification
      const trustVerification: TrustVerificationResult = {
        trusted: false,
        errorCode: "SIGNING_KEY_UNTRUSTED",
        reason: "Unknown signing key",
      };
      const untrustedResult = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        trustVerification,
      });
      expect(untrustedResult.eligible).toBe(false);
      expect(untrustedResult.violations.some((v) => v.code === "SIGNING_KEY_UNTRUSTED")).toBe(true);
    });

    it("rejects version downgrade and target digest substitution", async () => {
      const manifest = createSampleToolManifest("tool-ver-check", "1.0.0");

      // Target version mismatch (downgrade attempt)
      const verResult = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        targetVersion: "2.0.0",
      });
      expect(verResult.eligible).toBe(false);
      expect(verResult.violations.some((v) => v.code === "LOCK_VERSION_MISMATCH")).toBe(true);

      // Target digest mismatch
      const digestResult = await checker.checkPreactivation({
        manifest,
        workspaceId: "ws-1",
        targetDigest: "99".repeat(32),
      });
      expect(digestResult.eligible).toBe(false);
      expect(digestResult.violations.some((v) => v.code === "TARGET_DIGEST_MISMATCH")).toBe(true);
    });
  });
});
