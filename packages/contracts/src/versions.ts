import { z } from "zod";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
} from "./common.js";
import { ToolManifestSchema } from "./tools.js";

/**
 * Bundle Reference describing where tool executable artifacts are stored.
 */
export const BundleReferenceSchema = z.object({
  uri: z.string().min(1),
  hash: Sha256DigestSchema,
  sizeBytes: z.number().int().nonnegative(),
  format: z.enum(["js_bundle", "zip", "tar_gz", "embedded", "wasm"]),
});

export type BundleReference = z.infer<typeof BundleReferenceSchema>;

/**
 * Tool Artifact representing the compiled/bundled executable package.
 */
export const ToolArtifactSchema = z.object({
  artifactDigest: Sha256DigestSchema,
  bundleReference: BundleReferenceSchema,
  entrypoint: z.string().min(1),
  sourceCode: z.string().optional(),
  sourceMap: z.string().optional(),
  checksums: z.record(z.string()).default({}),
});

export type ToolArtifact = z.infer<typeof ToolArtifactSchema>;

/**
 * Provenance metadata detailing how the tool version was synthesized.
 */
export const ProvenanceMetadataSchema = z.object({
  sourceCandidateId: IdentifierSchema.optional(),
  synthesizedAt: ISOTimestampSchema,
  synthesizerModel: z.string().min(1),
  promptHash: Sha256DigestSchema.optional(),
  gitCommitSha: z.string().optional(),
  deterministicBuildHash: Sha256DigestSchema,
  environment: z.record(z.string()).default({}),
});

export type ProvenanceMetadata = z.infer<typeof ProvenanceMetadataSchema>;

/**
 * Signature metadata for cryptographic provenance verification.
 */
export const SignatureMetadataSchema = z.object({
  signature: z.string().min(1),
  keyId: z.string().min(1),
  algorithm: z.enum(["ed25519", "ecdsa_p256_sha256", "rsa_pss_sha256"]),
  signedAt: ISOTimestampSchema,
  certificateChain: z.array(z.string()).optional(),
});

export type SignatureMetadata = z.infer<typeof SignatureMetadataSchema>;

/**
 * Status of a tool version in the local catalog.
 */
export const ToolVersionStatusSchema = z.enum(["draft", "active", "deprecated", "revoked"]);

export type ToolVersionStatus = z.infer<typeof ToolVersionStatusSchema>;

/**
 * Tool Version: Immutable record of a synthesized and published tool version.
 */
export const ToolVersionSchema = z.object({
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  manifestDigest: Sha256DigestSchema,
  artifactDigest: Sha256DigestSchema,
  manifest: ToolManifestSchema,
  artifact: ToolArtifactSchema,
  provenance: ProvenanceMetadataSchema,
  signature: SignatureMetadataSchema.optional(),
  status: ToolVersionStatusSchema.default("draft"),
  supersededBy: SchemaVersionSchema.nullable().optional(),
  createdAt: ISOTimestampSchema,
  createdBy: z.string().min(1),
});

export type ToolVersion = z.infer<typeof ToolVersionSchema>;
