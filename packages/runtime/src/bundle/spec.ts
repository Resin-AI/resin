import {
  type CapabilityManifest,
  CapabilityManifestSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolRuntimeRequirement,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { z } from "zod";

/**
 * Standard relative file paths within a tool bundle.
 */
export const BUNDLE_FILE_MANIFEST = "manifest.json";
export const BUNDLE_FILE_ENTRYPOINT_TS = "src/index.ts";
export const BUNDLE_FILE_ENTRYPOINT_JS = "src/index.js";
export const BUNDLE_FILE_TESTS_TS = "tests/index.test.ts";
export const BUNDLE_FILE_TESTS_JS = "tests/index.test.js";
export const BUNDLE_FILE_PACKAGE = "package.json";
export const BUNDLE_FILE_PACKAGE_LOCK = "package-lock.json";
export const BUNDLE_FILE_SIGNATURE = "signature.json";
export const BUNDLE_FILE_INTEGRITY = "integrity.json";
export const BUNDLE_FILE_QUALIFICATION = "qualification.json";

/**
 * Supported bundle archive and storage formats.
 */
export const BundleFormatSchema = z.enum(["tar", "tar_gz", "zip", "directory"]);
export type BundleFormat = z.infer<typeof BundleFormatSchema>;

/**
 * Signature algorithm supported by the bundle signer and verifier.
 */
export const BundleSignatureAlgorithmSchema = z.enum([
  "ed25519",
  "ecdsa_p256_sha256",
  "rsa_pss_sha256",
]);
export type BundleSignatureAlgorithm = z.infer<typeof BundleSignatureAlgorithmSchema>;

/**
 * Metadata for a single file contained within a tool bundle.
 */
export const BundleFileEntrySchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  digest: Sha256DigestSchema,
  mode: z.number().int().optional(),
  executable: z.boolean().default(false),
});
export type BundleFileEntry = z.infer<typeof BundleFileEntrySchema>;

/**
 * Cryptographic bundle signature data stored in signature.json or detached.
 */
export const BundleSignatureDataSchema = z.object({
  keyId: z.string().min(1),
  algorithm: BundleSignatureAlgorithmSchema,
  signature: z.string().min(1),
  bundleDigest: Sha256DigestSchema,
  signedAt: ISOTimestampSchema,
  fileDigests: z.record(Sha256DigestSchema).default({}),
  certificateChain: z.array(z.string()).optional(),
  publicKey: z.string().optional(),
});
export type BundleSignatureData = z.infer<typeof BundleSignatureDataSchema>;

/**
 * Bundle limits and guardrails for decompression and extraction safety.
 */
export const BundleLimitsSchema = z.object({
  maxBundleSizeBytes: z
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024), // 50MB
  maxFileSizeBytes: z
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024), // 10MB
  maxFileCount: z.number().int().positive().default(1000),
  maxDecompressedSizeBytes: z
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024), // 100MB
  maxDecompressionRatio: z.number().int().positive().default(10),
});
export type BundleLimits = z.infer<typeof BundleLimitsSchema>;

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxBundleSizeBytes: 50 * 1024 * 1024,
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxFileCount: 1000,
  maxDecompressedSizeBytes: 100 * 1024 * 1024,
  maxDecompressionRatio: 10,
};

/**
 * Complete tool bundle specification describing layout, metadata, files, and integrity.
 */
export const ToolBundleSpecSchema = z.object({
  format: BundleFormatSchema.default("tar"),
  manifest: ToolManifestSchema,
  entrypoint: z.string().min(1).default(BUNDLE_FILE_ENTRYPOINT_TS),
  testsPath: z.string().optional(),
  packageJson: z.record(z.unknown()).optional(),
  files: z.array(BundleFileEntrySchema).min(1),
  bundleDigest: Sha256DigestSchema,
  signature: BundleSignatureDataSchema.optional(),
  createdAt: ISOTimestampSchema,
  totalSizeBytes: z.number().int().nonnegative(),
});
export type ToolBundleSpec = z.infer<typeof ToolBundleSpecSchema>;
