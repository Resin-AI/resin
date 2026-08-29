import crypto from "node:crypto";
import {
  CURRENT_SAFETY_GATE_VERSION,
  REQUIRED_SAFETY_CHECKS,
  type SafetyAttestationRecord,
  canonicalJson,
} from "@resin/contracts";
import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditTrailManager } from "../../src/observability/audit-trail.js";
import { DeploymentActivator } from "../../src/sync/activator.js";
import {
  ArtifactTransferClient,
  AttestationVerificationError,
  DigestMismatchError,
  EnvelopeViolationError,
  InMemoryKeyStore,
  IncompatibleRuntimeError,
  InvalidSignatureError,
  RevokedSigningKeyError,
  UnknownSigningKeyError,
} from "../../src/sync/client.js";
import {
  buildTarArchive,
  createSampleCapabilityEnvelope,
  createSampleToolManifest,
  createSignedTestBundle,
  generateTestSigningKey,
} from "./fixtures.js";

describe("Signed Version Activation, Envelope Enforcement & Quarantine Suite", () => {
  let store: LocalStateStore;
  let keyStore: InMemoryKeyStore;
  let client: ArtifactTransferClient;
  let auditTrail: AuditTrailManager;
  let activator: DeploymentActivator;
  let testKey: ReturnType<typeof generateTestSigningKey>;

  const workspaceId = "ws-signed-test";

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    keyStore = new InMemoryKeyStore();
    testKey = generateTestSigningKey("ed25519-prod-1", "production");
    await keyStore.addKey(testKey.keyEntry);

    client = new ArtifactTransferClient({
      keyStore,
      allowDevKeys: false,
    });

    auditTrail = new AuditTrailManager(store.conn);
    await auditTrail.initialize();
    activator = new DeploymentActivator({
      conn: store.conn,
      toolRepo: store.tools,
      keyStore,
      client,
      auditTrail,
    });

    // Initialize workspace in SQLite
    const envelope = createSampleCapabilityEnvelope(workspaceId);
    store.conn.run(
      `INSERT INTO workspaces (
        workspace_id, root_path, name, config_json, capability_envelope_json, active_tools_json, created_at, updated_at
      ) VALUES (?, ?, ?, '{}', ?, '{}', ?, ?);`,
      [
        workspaceId,
        `/workspaces/${workspaceId}`,
        workspaceId,
        canonicalJson(envelope),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  });

  it("successfully activates a valid Ed25519 signed candidate bundle", async () => {
    const manifest = createSampleToolManifest("formatter_service", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, testKey);

    // Stage tool
    await activator.stageTool(manifest, {
      workspaceId,
      artifactDigest: digest,
    });

    // Activate tool with artifact buffer verification
    const result = await activator.activate({
      workspaceId,
      toolId: "formatter_service",
      version: "1.0.0",
      artifactBuffer: archiveBuffer,
      requireSignature: true,
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe("active");
    expect(result.snapshot.tools.formatter_service?.version).toBe("1.0.0");

    // Verify workspace active tools in DB
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      [workspaceId],
    );
    const activeTools = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools.formatter_service).toBe("1.0.0");
  });

  it("detects and rejects signed bundle tampering and records quarantine record", async () => {
    const manifest = createSampleToolManifest("tampered_tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, testKey);

    // Tamper with archive buffer (modifying byte contents)
    const tamperedBuffer = Buffer.from(archiveBuffer);
    tamperedBuffer[520] ^= 0x55;

    await activator.stageTool(manifest, {
      workspaceId,
      artifactDigest: digest,
    });

    // Attempting activation with tampered buffer fails and quarantines
    await expect(
      activator.activate({
        workspaceId,
        toolId: "tampered_tool",
        version: "1.0.0",
        artifactBuffer: tamperedBuffer,
        requireSignature: true,
        quarantineOnFailure: true,
      }),
    ).rejects.toThrow();

    // Verify quarantine table in DB
    const qRows = store.conn.all<{ tool_id: string; tool_version: string; reason: string }>(
      "SELECT tool_id, tool_version, reason FROM quarantined_artifacts WHERE tool_id = ?;",
      ["tampered_tool"],
    );
    expect(qRows.length).toBeGreaterThanOrEqual(1);
    expect(qRows[0].tool_version).toBe("1.0.0");
  });

  it("rejects candidate signed with revoked key and quarantines candidate", async () => {
    const revokedKey = generateTestSigningKey("ed25519-revoked-key", "production");
    await keyStore.addKey(revokedKey.keyEntry);
    await keyStore.revokeKey("ed25519-revoked-key");

    const manifest = createSampleToolManifest("revoked_key_tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, revokedKey);

    await activator.stageTool(manifest, {
      workspaceId,
      artifactDigest: digest,
    });

    await expect(
      activator.activate({
        workspaceId,
        toolId: "revoked_key_tool",
        version: "1.0.0",
        artifactBuffer: archiveBuffer,
        requireSignature: true,
        quarantineOnFailure: true,
      }),
    ).rejects.toThrow(RevokedSigningKeyError);

    const qRows = store.conn.all<{ tool_id: string; reason: string }>(
      "SELECT tool_id, reason FROM quarantined_artifacts WHERE tool_id = ?;",
      ["revoked_key_tool"],
    );
    expect(qRows.length).toBeGreaterThanOrEqual(1);
    expect(qRows[0].reason).toBe("signature_mismatch");
  });

  it("rejects candidate with unsupported runtime engine", async () => {
    const manifest = createSampleToolManifest("unsupported_runtime_tool", "1.0.0", {
      runtime: {
        runtime: "deno",
        memoryLimitMb: 128,
        timeoutMs: 30000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    });

    // Set unsupported custom engine in manifest and recompute digest
    // SAFETY: Mutates manifest runtime engine for negative test scenario.
    (manifest.runtime as { engine?: string }).engine = "docker_unsupported";
    manifest.digest = crypto.createHash("sha256").update(canonicalJson(manifest)).digest("hex");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, testKey);

    await activator.stageTool(manifest, {
      workspaceId,
      artifactDigest: digest,
    });

    await expect(
      activator.activate({
        workspaceId,
        toolId: "unsupported_runtime_tool",
        version: "1.0.0",
        artifactBuffer: archiveBuffer,
      }),
    ).rejects.toThrow(IncompatibleRuntimeError);
  });

  it("verifies production safety attestation and rejects unmet safety checks", async () => {
    const manifest = createSampleToolManifest("attestation_tested_tool", "1.0.0");

    // Create valid checks
    const validChecks: Record<string, boolean> = {};
    for (const check of REQUIRED_SAFETY_CHECKS) {
      validChecks[check] = true;
    }

    const validAttestation: SafetyAttestationRecord = {
      attestationId: "att-12345",
      schemaVersion: CURRENT_SAFETY_GATE_VERSION,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      environment: "production",
      compatibility: {
        runtimeVersion: "0.1.0",
        brokerProtocolVersion: "1.0.0",
        bundleVerifierVersion: "1.0.0",
        policyVersion: "1.0.0",
      },
      checks: validChecks,
    };

    // Valid attestation in bundle passes
    const validFiles = [
      { name: "index.js", content: "export default function() {}" },
      {
        name: "package.json",
        content: JSON.stringify({ name: manifest.name, version: manifest.version }),
      },
      { name: "manifest.json", content: JSON.stringify(manifest) },
      { name: "attestation.json", content: JSON.stringify(validAttestation) },
    ];
    const validArchive = buildTarArchive(validFiles);

    const inspResult = await client.inspectArtifactBytes(validArchive, {
      requireAttestation: true,
    });
    expect(inspResult.attestation?.attestationId).toBe("att-12345");

    const invalidChecks = { ...validChecks, sandboxIsolation: false };
    const invalidAttestation = { ...validAttestation, checks: invalidChecks };
    const invalidFiles = [
      { name: "index.js", content: "export default function() {}" },
      {
        name: "package.json",
        content: JSON.stringify({ name: manifest.name, version: manifest.version }),
      },
      { name: "manifest.json", content: JSON.stringify(manifest) },
      { name: "attestation.json", content: JSON.stringify(invalidAttestation) },
    ];
    const invalidArchive = buildTarArchive(invalidFiles);

    await expect(
      client.inspectArtifactBytes(invalidArchive, { requireAttestation: true }),
    ).rejects.toThrow(AttestationVerificationError);
  });

  it("re-evaluates local capability envelope and refuses out-of-envelope candidate decisions", async () => {
    // Restrictive local envelope allowing only api.safe.com
    const restrictedEnvelope = createSampleCapabilityEnvelope(workspaceId, {
      net: {
        allowedDomains: ["api.safe.com"],
        allowedHosts: ["api.safe.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
    });

    store.conn.run("UPDATE workspaces SET capability_envelope_json = ? WHERE workspace_id = ?;", [
      canonicalJson(restrictedEnvelope),
      workspaceId,
    ]);

    // Candidate manifest requests unauthorized network host
    const outOfEnvelopeManifest = createSampleToolManifest("out_of_envelope_tool", "1.0.0", {
      capabilities: {
        net: {
          allowedDomains: ["malicious.unauthorized.org"],
          allowedHosts: ["malicious.unauthorized.org"],
          allowedPorts: [80, 443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      },
    });

    await activator.stageTool(outOfEnvelopeManifest, {
      workspaceId,
    });

    // Candidate should be refused due to envelope violation
    await expect(
      activator.activate({
        workspaceId,
        toolId: "out_of_envelope_tool",
        version: "1.0.0",
        manifest: outOfEnvelopeManifest,
        quarantineOnFailure: true,
      }),
    ).rejects.toThrow(EnvelopeViolationError);

    // Verify refusal audit event
    const auditRows = store.conn.all<{ event_type: string; details_json: string }>(
      "SELECT event_type, details_json FROM audit_trail_chain WHERE event_type = 'safety_gate_refusal';",
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].details_json).toContain("malicious.unauthorized.org");
  });

  it("transactional installation guarantees crash safety and leaves database consistent on failure", async () => {
    // 1. Install initial version 1.0.0
    const manifestV1 = createSampleToolManifest("trans_tool", "1.0.0");
    await activator.stageTool(manifestV1, { workspaceId });
    await activator.activate({
      workspaceId,
      toolId: "trans_tool",
      version: "1.0.0",
    });

    const initialWsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      [workspaceId],
    );
    expect(JSON.parse(initialWsRow!.active_tools_json).trans_tool).toBe("1.0.0");

    // 2. Attempt activating a corrupt/invalid candidate with deliberate failure
    const corruptManifest = createSampleToolManifest("trans_tool", "2.0.0", {
      capabilities: {
        net: {
          allowedDomains: ["evil-exfiltrate.com"],
          allowedHosts: ["evil-exfiltrate.com"],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      },
    });

    // Set restrictive envelope
    const restrictedEnvelope = createSampleCapabilityEnvelope(workspaceId, {
      net: {
        allowedDomains: ["api.example.com"],
        allowedHosts: ["api.example.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
    });
    store.conn.run("UPDATE workspaces SET capability_envelope_json = ? WHERE workspace_id = ?;", [
      canonicalJson(restrictedEnvelope),
      workspaceId,
    ]);

    await activator.stageTool(corruptManifest, { workspaceId });

    await expect(
      activator.activate({
        workspaceId,
        toolId: "trans_tool",
        version: "2.0.0",
        manifest: corruptManifest,
      }),
    ).rejects.toThrow(EnvelopeViolationError);

    // 3. Verify database state remains intact with version 1.0.0 active (zero partial writes)
    const postFailWsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      [workspaceId],
    );
    expect(JSON.parse(postFailWsRow!.active_tools_json).trans_tool).toBe("1.0.0");

    const instRow = store.conn.get<{ tool_version: string; state: string }>(
      "SELECT tool_version, state FROM installations WHERE workspace_id = ? AND tool_id = ?;",
      [workspaceId, "trans_tool"],
    );
    expect(instRow?.tool_version).toBe("1.0.0");
    expect(instRow?.state).toBe("active");
  });

  it("offline activation recovery correctly resolves active version from persisted SQLite state", async () => {
    // 1. Activate tools
    const m1 = createSampleToolManifest("tool_alpha", "1.0.0");
    const m2 = createSampleToolManifest("tool_beta", "2.1.0");

    await activator.stageTool(m1, { workspaceId });
    await activator.activate({ workspaceId, toolId: "tool_alpha", version: "1.0.0" });

    await activator.stageTool(m2, { workspaceId });
    await activator.activate({ workspaceId, toolId: "tool_beta", version: "2.1.0" });

    // 2. Simulate daemon restart with new DeploymentActivator sharing same DB
    const freshActivator = new DeploymentActivator({
      conn: store.conn,
      toolRepo: store.tools,
    });

    const activeTools = await freshActivator.getActiveTools(workspaceId);
    expect(activeTools.tool_alpha).toBe("1.0.0");
    expect(activeTools.tool_beta).toBe("2.1.0");
  });

  it("hostile cloud defense: a valid signature from an external signer never bypasses local capability envelope", async () => {
    // Manifest attempts unauthorized exfiltration network access
    const hostileManifest = createSampleToolManifest("hostile_exfil_tool", "1.0.0", {
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

    const { archiveBuffer, digest } = createSignedTestBundle(hostileManifest, testKey);

    // Stage tool with signed buffer and restrictive envelope
    await activator.stageTool(hostileManifest, {
      workspaceId,
      archiveBuffer,
      artifactDigest: digest,
      envelope: createSampleCapabilityEnvelope(workspaceId, {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.local-only.com"],
          allowedHosts: [],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      }),
    });

    // Activation MUST fail closed and refuse activation
    await expect(
      activator.activate({
        workspaceId,
        toolId: "hostile_exfil_tool",
        version: "1.0.0",
        manifest: hostileManifest,
        quarantineOnFailure: true,
      }),
    ).rejects.toThrow(EnvelopeViolationError);

    // Verify safety gate refusal audit record
    const auditRows = store.conn.all<{ event_type: string; details_json: string }>(
      "SELECT event_type, details_json FROM audit_trail_chain WHERE event_type = 'safety_gate_refusal';",
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].details_json).toContain("hostile-exfiltration.net");
  });
});
