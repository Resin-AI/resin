import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import {
  TOOL_CERTIFICATE_SIGNING_DOMAIN,
  type V1ToolCertificate,
  V1ToolCertificateSchema,
  type V1UnsignedToolCertificate,
  toolCertificateSigningPayload,
  verifyToolCertificateSignature,
} from "../src/tool-certificate.js";
import { V1_SCHEMA_KINDS, V1_SCHEMA_VERSION } from "../src/v1.js";

const UNSIGNED: V1UnsignedToolCertificate = {
  schemaKind: V1_SCHEMA_KINDS.TOOL_CERTIFICATE,
  schemaVersion: V1_SCHEMA_VERSION,
  certificateId: "0b9d2f0e-6a8b-4c39-9d43-5d0a3c1e7f21",
  accountId: "acc_123",
  workspaceId: "ws_456",
  toolId: "33333333-3333-4333-8333-333333333333",
  toolName: "calc_tool",
  version: "1.2.3",
  artifactDigest: "a".repeat(64),
  manifestDigest: "b".repeat(64),
  issuedAt: "2026-10-01T12:00:00.000Z",
};

function keyPair() {
  return generateKeyPairSync("ed25519");
}

function signCertificate(
  unsigned: V1UnsignedToolCertificate,
  privateKey: KeyObject,
  keyId = "test-key",
): V1ToolCertificate {
  const signature = sign(null, toolCertificateSigningPayload(unsigned), privateKey).toString("hex");
  return {
    ...unsigned,
    signature: { keyId, algorithm: "ed25519", signature, signedAt: "2026-10-01T12:00:01.000Z" },
  };
}

describe("tool certificate contract", () => {
  it("signs the domain-separated canonical JSON of every field but the signature", () => {
    const payload = Buffer.from(toolCertificateSigningPayload(UNSIGNED)).toString("utf8");
    expect(payload).toBe(`resin-tool-certificate-v1\n${canonicalJson(UNSIGNED)}`);
    expect(payload.startsWith(TOOL_CERTIFICATE_SIGNING_DOMAIN)).toBe(true);
  });

  it("is deterministic and independent of field order", () => {
    const reversed = Object.fromEntries(
      Object.entries(UNSIGNED).reverse(),
    ) as V1UnsignedToolCertificate;
    const first = toolCertificateSigningPayload(UNSIGNED);
    expect(Buffer.from(toolCertificateSigningPayload(UNSIGNED)).equals(Buffer.from(first))).toBe(
      true,
    );
    expect(Buffer.from(toolCertificateSigningPayload(reversed)).equals(Buffer.from(first))).toBe(
      true,
    );
  });

  it("ignores the signature of a full certificate when computing the payload", () => {
    const { privateKey } = keyPair();
    const certificate = signCertificate(UNSIGNED, privateKey);
    expect(
      Buffer.from(toolCertificateSigningPayload(certificate)).equals(
        Buffer.from(toolCertificateSigningPayload(UNSIGNED)),
      ),
    ).toBe(true);
  });

  it("round-trips a signature made with a generated Ed25519 key", () => {
    const { privateKey, publicKey } = keyPair();
    const certificate = signCertificate(UNSIGNED, privateKey);
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(V1ToolCertificateSchema.parse(certificate)).toEqual(certificate);
    expect(certificate.signature.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyToolCertificateSignature(certificate, pem)).toBe(true);
  });

  it.each([
    ["artifactDigest", "c".repeat(64)],
    ["manifestDigest", "c".repeat(64)],
    ["accountId", "acc_other"],
    ["workspaceId", "ws_other"],
    ["toolName", "other_tool"],
    ["version", "1.2.4"],
    ["issuedAt", "2026-10-01T12:00:00.001Z"],
  ] as const)("detects tampering with %s", (field, value) => {
    const { privateKey, publicKey } = keyPair();
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const certificate = signCertificate(UNSIGNED, privateKey);
    expect(verifyToolCertificateSignature({ ...certificate, [field]: value }, pem)).toBe(false);
  });

  it("rejects another key, a non-Ed25519 key, and malformed input without throwing", () => {
    const { privateKey } = keyPair();
    const other = keyPair().publicKey.export({ type: "spki", format: "pem" }).toString();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    const certificate = signCertificate(UNSIGNED, privateKey);
    expect(verifyToolCertificateSignature(certificate, other)).toBe(false);
    expect(verifyToolCertificateSignature(certificate, ec)).toBe(false);
    expect(verifyToolCertificateSignature(certificate, "not a pem")).toBe(false);
    const flipped = `${certificate.signature.signature.slice(0, -1)}${
      certificate.signature.signature.endsWith("0") ? "1" : "0"
    }`;
    expect(
      verifyToolCertificateSignature(
        { ...certificate, signature: { ...certificate.signature, signature: flipped } },
        keyPair().publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
    ).toBe(false);
  });

  it("is strict about unknown fields and the signature encoding", () => {
    const { privateKey } = keyPair();
    const certificate = signCertificate(UNSIGNED, privateKey);
    expect(V1ToolCertificateSchema.safeParse({ ...certificate, extra: 1 }).success).toBe(false);
    expect(
      V1ToolCertificateSchema.safeParse({
        ...certificate,
        signature: {
          ...certificate.signature,
          signature: certificate.signature.signature.toUpperCase(),
        },
      }).success,
    ).toBe(false);
    expect(
      V1ToolCertificateSchema.safeParse({
        ...certificate,
        signature: { ...certificate.signature, algorithm: "rsa_pss_sha256" },
      }).success,
    ).toBe(false);
    expect(V1ToolCertificateSchema.safeParse({ ...certificate, version: "^1.2.3" }).success).toBe(
      false,
    );
    expect(() => toolCertificateSigningPayload({ ...UNSIGNED, toolId: "not-a-uuid" })).toThrow();
  });
});
