import type { V1LockedToolEntry, V1ToolLock } from "@resin/contracts";

export function makeV1ToolLockFixture(
  tools: Record<
    string,
    {
      toolId: string;
      name: string;
      version: string;
      manifestDigest: string;
      artifactDigest: string;
      envelopeDigest?: string;
      signatureIdentity?: {
        keyId: string;
        algorithm: "ed25519" | "ecdsa_p256_sha256" | "rsa_pss_sha256";
        signer?: string;
      };
      status?: "active" | "pinned" | "disabled";
    }
  >,
  overrides?: Partial<V1ToolLock>,
): V1ToolLock {
  const toolsRecord: Record<string, V1LockedToolEntry> = {};
  for (const [key, tool] of Object.entries(tools)) {
    toolsRecord[key] = {
      toolId: tool.toolId,
      name: tool.name,
      version: tool.version,
      manifestDigest: tool.manifestDigest,
      artifactDigest: tool.artifactDigest,
      envelopeDigest: tool.envelopeDigest,
      signatureIdentity: tool.signatureIdentity ?? {
        keyId: "key-1",
        algorithm: "ed25519",
        signer: "system",
      },
      status: tool.status ?? "active",
    };
  }

  return {
    schemaKind: "tool_lock",
    schemaVersion: "1.0.0",
    projectId: overrides?.projectId ?? "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
    updatedAt: "2026-08-24T00:00:00.000Z",
    tools: toolsRecord,
    ...overrides,
  };
}
