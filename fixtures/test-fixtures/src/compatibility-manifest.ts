import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { hashCanonicalContent } from "@resin/contracts";
import { z } from "zod";

/**
 * Release Compatibility Manifest
 *
 * Deterministic metadata specifying schema digests, wire protocols,
 * adapter SDKs, platform runtimes, and artifact formats.
 */

// ============================================================================
// Schemas
// ============================================================================

export const SchemaStabilitySchema = z.enum(["experimental", "stable", "deprecated"]);
export type SchemaStability = z.infer<typeof SchemaStabilitySchema>;

export const SchemaCompatibilityEntrySchema = z.object({
  schemaName: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/),
  canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  stability: SchemaStabilitySchema,
  isBreakingSince: z.string().optional(),
});
export type SchemaCompatibilityEntry = z.infer<typeof SchemaCompatibilityEntrySchema>;

export const ProtocolEndpointEntrySchema = z.object({
  path: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  minVersion: z.string(),
});
export type ProtocolEndpointEntry = z.infer<typeof ProtocolEndpointEntrySchema>;

export const ProtocolCompatibilityEntrySchema = z.object({
  wireProtocolVersion: z.string().min(1),
  minClientProtocolVersion: z.string().min(1),
  supportedAuthSchemes: z.array(z.string()).min(1),
  supportedStreamEncodings: z.array(z.string()).min(1),
  httpEndpoints: z.array(ProtocolEndpointEntrySchema),
});
export type ProtocolCompatibilityEntry = z.infer<typeof ProtocolCompatibilityEntrySchema>;

export const AdapterCompatibilityEntrySchema = z.object({
  adapterId: z.string().min(1),
  displayName: z.string().min(1),
  minSupportedAdapterVersion: z.string().min(1),
  supportedVersions: z.array(z.string()).min(1),
  supportedTransports: z.array(z.string()).min(1),
  supportedFidelityTiers: z.array(z.string()).min(1),
});
export type AdapterCompatibilityEntry = z.infer<typeof AdapterCompatibilityEntrySchema>;

export const RuntimeCompatibilityEntrySchema = z.object({
  node: z.object({
    min: z.string().min(1),
    supported: z.array(z.string()).min(1),
  }),
  operatingSystems: z.array(z.string()).min(1),
  architectures: z.array(z.string()).min(1),
});
export type RuntimeCompatibilityEntry = z.infer<typeof RuntimeCompatibilityEntrySchema>;

export const ArtifactCompatibilityEntrySchema = z.object({
  supportedTypes: z.array(z.string()).min(1),
  maxBundleSizeMb: z.number().int().positive(),
  supportedCompression: z.array(z.string()).min(1),
  checksumAlgorithm: z.literal("sha256"),
});
export type ArtifactCompatibilityEntry = z.infer<typeof ArtifactCompatibilityEntrySchema>;

export const ReleaseCompatibilityManifestSchema = z.object({
  manifestVersion: z.literal("1.0.0"),
  releaseVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/),
  generatedAt: z.string().datetime(),
  generatorVersion: z.string().min(1),
  schemas: z.record(SchemaCompatibilityEntrySchema),
  protocols: ProtocolCompatibilityEntrySchema,
  adapterSdks: z.array(AdapterCompatibilityEntrySchema),
  runtimes: RuntimeCompatibilityEntrySchema,
  artifactFormats: ArtifactCompatibilityEntrySchema,
});
export type ReleaseCompatibilityManifest = z.infer<typeof ReleaseCompatibilityManifestSchema>;

// ============================================================================
// Compatibility Target Check Types
// ============================================================================

export interface CompatibilityTarget {
  clientProtocolVersion?: string;
  adapterId?: string;
  adapterVersion?: string;
  nodeVersion?: string;
  os?: string;
  arch?: string;
  schemaVersions?: Record<string, string>;
}

export interface CompatibilityCheckResult {
  compatible: boolean;
  issues: string[];
  warnings: string[];
}

export interface ManifestGenerationOptions {
  releaseVersion?: string;
  customSchemas?: Record<string, Partial<SchemaCompatibilityEntry>>;
  customAdapters?: AdapterCompatibilityEntry[];
}
interface SchemaCompatibilityRegistry {
  [schemaName: string]: SchemaCompatibilityEntry;
}

// ============================================================================
// Default Values & Standard Manifest Generation
// ============================================================================

const DEFAULT_CORE_SCHEMAS: SchemaCompatibilityRegistry = {
  NormalizedSessionEvent: {
    schemaName: "NormalizedSessionEvent",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "NormalizedSessionEvent", version: "1.0.0" }),
    stability: "stable",
  },
  ToolManifest: {
    schemaName: "ToolManifest",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "ToolManifest", version: "1.0.0" }),
    stability: "stable",
  },
  ToolVersion: {
    schemaName: "ToolVersion",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "ToolVersion", version: "1.0.0" }),
    stability: "stable",
  },
  CapabilityEnvelope: {
    schemaName: "CapabilityEnvelope",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "CapabilityEnvelope", version: "1.0.0" }),
    stability: "stable",
  },
  DeploymentRecord: {
    schemaName: "DeploymentRecord",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "DeploymentRecord", version: "1.0.0" }),
    stability: "stable",
  },
  CatalogSnapshot: {
    schemaName: "CatalogSnapshot",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "CatalogSnapshot", version: "1.0.0" }),
    stability: "stable",
  },
  InstallationRecord: {
    schemaName: "InstallationRecord",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "InstallationRecord", version: "1.0.0" }),
    stability: "stable",
  },
  OfflineRevocationRegistry: {
    schemaName: "OfflineRevocationRegistry",
    version: "1.0.0",
    canonicalDigest: hashCanonicalContent({ type: "OfflineRevocationRegistry", version: "1.0.0" }),
    stability: "stable",
  },
};

/**
 * Generates a complete ReleaseCompatibilityManifest for a release candidate.
 */
export function generateCompatibilityManifest(
  options: ManifestGenerationOptions = {},
): ReleaseCompatibilityManifest {
  const releaseVersion = options.releaseVersion || "0.1.0";
  const schemas: SchemaCompatibilityRegistry = { ...DEFAULT_CORE_SCHEMAS };

  if (options.customSchemas) {
    for (const [name, entry] of Object.entries(options.customSchemas)) {
      schemas[name] = {
        schemaName: entry.schemaName || name,
        version: entry.version || "1.0.0",
        canonicalDigest:
          entry.canonicalDigest ||
          hashCanonicalContent({ type: name, version: entry.version || "1.0.0" }),
        stability: entry.stability || "stable",
        isBreakingSince: entry.isBreakingSince,
      };
    }
  }

  const defaultAdapters: AdapterCompatibilityEntry[] = [
    {
      adapterId: "cline",
      displayName: "Cline VSCode Extension",
      minSupportedAdapterVersion: "3.0.0",
      supportedVersions: ["3.0.0", "3.1.0", "3.2.0"],
      supportedTransports: ["stdio", "http"],
      supportedFidelityTiers: ["tier1_high", "tier2_standard"],
    },
    {
      adapterId: "cursor",
      displayName: "Cursor IDE",
      minSupportedAdapterVersion: "0.40.0",
      supportedVersions: ["0.40.0", "0.45.0"],
      supportedTransports: ["stdio"],
      supportedFidelityTiers: ["tier2_standard"],
    },
  ];

  return {
    manifestVersion: "1.0.0",
    releaseVersion,
    generatedAt: new Date().toISOString(),
    generatorVersion: "0.1.0",
    schemas,
    protocols: {
      wireProtocolVersion: "1.0.0",
      minClientProtocolVersion: "1.0.0",
      supportedAuthSchemes: ["device_ed25519", "bearer_jwt"],
      supportedStreamEncodings: ["application/json", "text/event-stream"],
      httpEndpoints: [
        { path: "/v1/auth/device/bootstrap", method: "POST", minVersion: "1.0.0" },
        { path: "/v1/auth/device/token", method: "POST", minVersion: "1.0.0" },
        { path: "/v1/observations/batch", method: "POST", minVersion: "1.0.0" },
        { path: "/v1/catalog/poll", method: "GET", minVersion: "1.0.0" },
        { path: "/v1/artifacts/fetch", method: "GET", minVersion: "1.0.0" },
        { path: "/v1/candidates/submit", method: "POST", minVersion: "1.0.0" },
        { path: "/v1/deployments/status", method: "POST", minVersion: "1.0.0" },
        { path: "/v1/device/heartbeat", method: "POST", minVersion: "1.0.0" },
      ],
    },
    adapterSdks: options.customAdapters || defaultAdapters,
    runtimes: {
      node: {
        min: "22.0.0",
        supported: [">=22.0.0"],
      },
      operatingSystems: ["darwin", "linux", "win32"],
      architectures: ["arm64", "x64"],
    },
    artifactFormats: {
      supportedTypes: ["application/gzip", "application/tar+gzip", "application/json"],
      maxBundleSizeMb: 50,
      supportedCompression: ["gzip", "none"],
      checksumAlgorithm: "sha256",
    },
  };
}

export type ReleaseCompatibilityManifestInput = z.input<typeof ReleaseCompatibilityManifestSchema>;

export interface CompatibilityValidationResult {
  valid: boolean;
  manifest?: ReleaseCompatibilityManifest;
  errors?: string[];
}

/**
 * Validate a compatibility manifest against the schema.
 */
export function validateCompatibilityManifest(
  manifest: ReleaseCompatibilityManifestInput | null | undefined,
): CompatibilityValidationResult {
  const result = ReleaseCompatibilityManifestSchema.safeParse(manifest);
  if (result.success) {
    return { valid: true, manifest: result.data };
  }
  const errors = result.error.issues.map((i: z.ZodIssue) => `${i.path.join(".")}: ${i.message}`);
  return { valid: false, errors };
}

/**
 * Check if a client, runtime, or adapter target is compatible with the given manifest.
 */
export function checkReleaseCompatibility(
  manifest: ReleaseCompatibilityManifest,
  target: CompatibilityTarget,
): CompatibilityCheckResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  // Check Protocol Version
  if (target.clientProtocolVersion) {
    if (target.clientProtocolVersion < manifest.protocols.minClientProtocolVersion) {
      issues.push(
        `Client protocol version ${target.clientProtocolVersion} is below minimum supported version ${manifest.protocols.minClientProtocolVersion}`,
      );
    }
  }

  // Check Adapter Compatibility
  if (target.adapterId) {
    const adapterEntry = manifest.adapterSdks.find((a) => a.adapterId === target.adapterId);
    if (!adapterEntry) {
      issues.push(`Adapter '${target.adapterId}' is not listed in supported adapter SDKs`);
    } else if (target.adapterVersion) {
      if (target.adapterVersion < adapterEntry.minSupportedAdapterVersion) {
        issues.push(
          `Adapter '${target.adapterId}' version ${target.adapterVersion} is below minimum ${adapterEntry.minSupportedAdapterVersion}`,
        );
      }
    }
  }

  // Check Node runtime
  if (target.nodeVersion) {
    const semverClean = target.nodeVersion.replace(/^v/, "");
    if (semverClean < manifest.runtimes.node.min) {
      issues.push(
        `Node version ${target.nodeVersion} is below minimum required version ${manifest.runtimes.node.min}`,
      );
    }
  }

  // Check OS
  if (target.os && !manifest.runtimes.operatingSystems.includes(target.os)) {
    issues.push(
      `Operating system '${target.os}' is not supported. Supported OS: ${manifest.runtimes.operatingSystems.join(", ")}`,
    );
  }

  // Check Arch
  if (target.arch && !manifest.runtimes.architectures.includes(target.arch)) {
    issues.push(
      `Architecture '${target.arch}' is not supported. Supported Arch: ${manifest.runtimes.architectures.join(", ")}`,
    );
  }

  // Check Schema Versions
  if (target.schemaVersions) {
    for (const [schemaName, requestedVer] of Object.entries(target.schemaVersions)) {
      const schemaEntry = manifest.schemas[schemaName];
      if (!schemaEntry) {
        warnings.push(`Schema '${schemaName}' is not recognized in release manifest`);
      } else {
        if (schemaEntry.stability === "deprecated") {
          warnings.push(`Schema '${schemaName}' is deprecated`);
        }
        if (schemaEntry.isBreakingSince && requestedVer < schemaEntry.isBreakingSince) {
          issues.push(
            `Schema '${schemaName}' version ${requestedVer} has breaking changes since ${schemaEntry.isBreakingSince}`,
          );
        }
      }
    }
  }

  return {
    compatible: issues.length === 0,
    issues,
    warnings,
  };
}

/**
 * Save compatibility manifest to a JSON file.
 */
export async function saveCompatibilityManifest(
  manifest: ReleaseCompatibilityManifest,
  filePath: string,
): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Load compatibility manifest from a JSON file.
 */
export async function loadCompatibilityManifest(
  filePath: string,
): Promise<ReleaseCompatibilityManifest> {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  const validation = validateCompatibilityManifest(parsed);
  if (!validation.valid || !validation.manifest) {
    throw new Error(
      `Invalid compatibility manifest at ${filePath}:\n${(validation.errors || []).join("\n")}`,
    );
  }
  return validation.manifest;
}
