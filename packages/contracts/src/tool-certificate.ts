import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical.js";
import { ISOTimestampSchema, IdentifierSchema, Sha256DigestSchema, UUIDSchema } from "./common.js";
import { V1ExactSemVerSchema, V1_SCHEMA_KINDS, V1_SCHEMA_VERSION } from "./v1.js";

/**
 * Domain separator prefixed to every tool certificate signing payload, so a signature over a tool
 * certificate can never be replayed as a signature over any other signed Resin document.
 */
export const TOOL_CERTIFICATE_SIGNING_DOMAIN = "resin-tool-certificate-v1\n";

/**
 * Account and workspace ids as they appear in device credential claims: the same bound as the
 * protocol's authentication identifiers, so a certificate names exactly the ids a device holds.
 */
export const ToolCertificateEntityIdentifierSchema = IdentifierSchema.max(
  64,
  "Certificate identifier exceeds the 64-character authentication identifier limit",
);

/** Pure Ed25519 signature over {@link toolCertificateSigningPayload}, as lowercase hex. */
export const V1ToolCertificateSignatureSchema = z
  .object({
    keyId: z.string().min(1).max(256).regex(/^\S+$/, "Key id must not contain whitespace"),
    algorithm: z.literal("ed25519"),
    signature: z
      .string()
      .regex(/^[0-9a-f]{128}$/, "Signature must be 128 lowercase hex characters (64 bytes)"),
    signedAt: ISOTimestampSchema,
  })
  .strict();

export type V1ToolCertificateSignature = z.infer<typeof V1ToolCertificateSignatureSchema>;

const toolCertificateFields = {
  schemaKind: z.literal(V1_SCHEMA_KINDS.TOOL_CERTIFICATE),
  schemaVersion: z.literal(V1_SCHEMA_VERSION),
  certificateId: UUIDSchema,
  accountId: ToolCertificateEntityIdentifierSchema,
  workspaceId: ToolCertificateEntityIdentifierSchema,
  toolId: UUIDSchema,
  toolName: IdentifierSchema,
  version: V1ExactSemVerSchema,
  artifactDigest: Sha256DigestSchema,
  manifestDigest: Sha256DigestSchema,
  issuedAt: ISOTimestampSchema,
};

/** The certified fields: everything a certificate binds, without its signature. */
export const V1UnsignedToolCertificateSchema = z.object(toolCertificateFields).strict();

export type V1UnsignedToolCertificate = z.infer<typeof V1UnsignedToolCertificateSchema>;

/**
 * A cloud-issued statement, signed with the environment's tool signing key, that one exact tool
 * version (its artifact and manifest digests) was published to one account workspace.
 */
export const V1ToolCertificateSchema = z
  .object({ ...toolCertificateFields, signature: V1ToolCertificateSignatureSchema })
  .strict();

export type V1ToolCertificate = z.infer<typeof V1ToolCertificateSchema>;

/**
 * The exact bytes a tool certificate signature covers: UTF-8 of
 * `'resin-tool-certificate-v1\n' + canonicalJsonStringify(fields)`, where `fields` are every
 * certificate field except `signature`. Key order of the input does not matter. A `signature`
 * property on the input is ignored, so a full certificate yields the bytes its signature covers.
 *
 * @throws ZodError when the certified fields are not a valid unsigned tool certificate.
 */
export function toolCertificateSigningPayload(
  certificate: V1UnsignedToolCertificate & { signature?: unknown },
): Uint8Array {
  const { signature: _signature, ...fields } = certificate;
  const unsigned = V1UnsignedToolCertificateSchema.parse(fields);
  return Buffer.from(
    `${TOOL_CERTIFICATE_SIGNING_DOMAIN}${canonicalJsonStringify(unsigned)}`,
    "utf8",
  );
}

/**
 * Verifies a tool certificate's Ed25519 signature with one public key (SPKI PEM). Returns false
 * for an invalid certificate, a non-Ed25519 or unreadable key, or a signature that does not verify;
 * it never throws. It does not check which key a caller should trust, nor what the certificate
 * binds: callers compare `signature.keyId` against their pinned keys and the bound fields against
 * what they expect.
 */
export function verifyToolCertificateSignature(
  certificate: V1ToolCertificate,
  publicKeyPem: string,
): boolean {
  try {
    const parsed = V1ToolCertificateSchema.safeParse(certificate);
    if (!parsed.success) return false;
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(
      null,
      toolCertificateSigningPayload(parsed.data),
      key,
      Buffer.from(parsed.data.signature.signature, "hex"),
    );
  } catch {
    return false;
  }
}
