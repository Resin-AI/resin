import crypto from "node:crypto";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { CommandBroker } from "../src/brokers/cmd-broker.js";
import { createInvocationGrant } from "../src/policy/grant.js";
import {
  AttestationVerifier,
  certifyLocalRuntime,
  createSafetyAttestation,
} from "../src/safety-gate/index.js";
import { DENO_WORKER_BOOTSTRAP_SOURCE } from "../src/worker/bootstrap.js";
import { ToolRuntime } from "../src/worker/runner.js";

const manifest = {
  id: "runtime-hardening-tool",
  name: "runtime_hardening_tool",
  version: "1.0.0",
  description: "Runtime hardening fixture",
  parameters: ToolParameterSchema.parse({ properties: {} }),
  outputSchema: { type: "object" as const },
  runtime: ToolRuntimeRequirementSchema.parse({ runtime: "deno" }),
  capabilities: CapabilityManifestSchema.parse({}),
  limits: ToolLimitConfigSchema.parse({}),
  scope: "workspace" as const,
  digest: "a".repeat(64),
  metadata: {},
  createdAt: new Date().toISOString(),
};

describe("Production Runtime trust boundaries", () => {
  it("rejects unsigned production attestations and unknown signing keys", () => {
    const unsignedTest = createSafetyAttestation();
    const unsignedProduction = { ...unsignedTest, environment: "production" as const };
    const strictVerifier = new AttestationVerifier();
    expect(strictVerifier.verify(unsignedProduction).valid).toBe(false);

    const certified = certifyLocalRuntime({
      environment: "production",
      probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
    });
    expect(strictVerifier.verify(certified.attestation).valid).toBe(false);

    const trustedVerifier = new AttestationVerifier({
      trustedPublicKeys: new Map([[certified.keyId, certified.publicKeyPem]]),
    });
    expect(trustedVerifier.verify(certified.attestation).valid).toBe(true);
  });

  it("uses correct Ed25519 verification rather than signature-length fallback", () => {
    const certified = certifyLocalRuntime({
      environment: "production",
      probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
    });
    const tampered = {
      ...certified.attestation,
      signature: {
        ...certified.attestation.signature!,
        signature: crypto.randomBytes(64).toString("base64"),
      },
    };
    const verifier = new AttestationVerifier({
      trustedPublicKeys: new Map([[certified.keyId, certified.publicKeyPem]]),
    });
    expect(verifier.verify(tampered).valid).toBe(false);
  });

  it("exposes only opaque secret references in the Deno worker context", () => {
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).not.toContain("getSecret:");
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).not.toContain('requestBroker("secret", "getSecret"');
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).not.toContain("request: requestBroker");
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).toContain("createReference");
  });

  it("fails closed when production Deno is unavailable", async () => {
    const runtime = new ToolRuntime({
      mode: "deno",
      denoExecutable: "/definitely/not/a/deno/binary",
    });
    await expect(runtime.executeTool(manifest, "export default () => ({})", {})).rejects.toThrow(
      /Deno executable/,
    );
  });

  it("does not allow a direct function to bypass Deno mode", async () => {
    const runtime = new ToolRuntime({ mode: "deno" });
    await expect(runtime.executeTool(manifest, async () => ({}), {})).rejects.toThrow(
      /Direct function handlers are test-only/,
    );
  });

  it("binds allowedBinaries to the requested executable identity for broad invocation", async () => {
    // Intentional broad-binary grant: allowedBinaries permits arbitrary argv for node executable,
    // while allowedCommands remains empty.
    const grant = createInvocationGrant({
      grantId: "grant_allowed_binaries_broad",
      invocationId: "inv_allowed_binaries_broad",
      toolId: "runtime-hardening-tool",
      toolVersion: "1.0.0",
      workspaceId: "workspace-runtime-hardening",
      envelopeId: "env_runtime_hardening",
      capabilities: {
        command: {
          allowShellExecution: false,
          allowedBinaries: [process.execPath],
          allowedCommands: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
      },
    });
    const broker = new CommandBroker();
    const context = {
      grant,
      invocationId: grant.invocationId,
      workspaceRoot: process.cwd(),
      scratchDir: process.cwd(),
      workspaceId: grant.workspaceId,
    };
    await expect(
      broker.execute({ executable: process.execPath, args: ["--version"] }, context),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      broker.execute({ executable: "/bin/echo", args: ["not-authorized"] }, context),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_BINARY" });
  });
});
