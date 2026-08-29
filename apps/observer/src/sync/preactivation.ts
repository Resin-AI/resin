import path from "node:path";
import { type CapabilityManifest, ToolManifestSchema, hashCanonical } from "@resin/contracts";
import type {
  PreactivationCheckOutcome,
  PreactivationCheckResult,
  PreactivationContext,
  PreactivationViolation,
} from "./types.js";

export type { PreactivationContext };

/**
 * Safe SHA-256 digest normalization.
 */
function normalizeDigest(digest?: string | null): string {
  if (!digest || typeof digest !== "string") return "";
  return digest
    .toLowerCase()
    .trim()
    .replace(/^sha256:/, "");
}

/**
 * List of known dangerous environment variables that must never be set in commands.
 */
const DANGEROUS_ENV_VARS: readonly string[] = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "PERL5OPT",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "SSLKEYLOGFILE",
];

const KNOWN_TOP_LEVEL_CAPABILITY_KEYS: Record<string, true> = {
  schemaVersion: true,
  manifestId: true,
  fs: true,
  net: true,
  command: true,
  secrets: true,
  limits: true,
};

const KNOWN_FS_KEYS: Record<string, true> = {
  readPaths: true,
  writePaths: true,
  allowWorkspaceRoot: true,
  allowTemp: true,
  denyPaths: true,
  maxFileSizeBytes: true,
};

const KNOWN_NET_KEYS: Record<string, true> = {
  allowOutbound: true,
  allowedDomains: true,
  allowedHosts: true,
  allowedPorts: true,
  allowedProtocols: true,
  allowLocalhost: true,
  denyPrivateRanges: true,
};

const KNOWN_COMMAND_KEYS: Record<string, true> = {
  allowShellExecution: true,
  allowedCommands: true,
  allowedBinaries: true,
  forbiddenPatterns: true,
  allowEnvPassthrough: true,
};

const KNOWN_SECRETS_KEYS: Record<string, true> = {
  allowedSecretNames: true,
  allowedPrefixes: true,
  denyDirectRead: true,
  injectAsEnv: true,
};

const KNOWN_LIMITS_KEYS: Record<string, true> = {
  maxConcurrentExecutions: true,
  maxConcurrentInvocations: true,
  maxCpuPercent: true,
  maxCpuUsagePercent: true,
  maxExecutionTimeMs: true,
  executionTimeoutMs: true,
  timeoutMs: true,
  maxMemoryBytes: true,
  maxMemoryMb: true,
  memoryLimitMb: true,
  maxOutputSizeBytes: true,
};

export function detectUnknownCapabilityKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return [];
  }

  const unknownKeys: string[] = [];
  const rec = obj as Record<string, unknown>;

  for (const k of Object.keys(rec)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      unknownKeys.push(k);
      continue;
    }
    if (!KNOWN_TOP_LEVEL_CAPABILITY_KEYS[k]) {
      unknownKeys.push(k);
    }
  }

  if (rec.fs && typeof rec.fs === "object" && !Array.isArray(rec.fs)) {
    for (const k of Object.keys(rec.fs as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`fs.${k}`);
        continue;
      }
      if (!KNOWN_FS_KEYS[k]) unknownKeys.push(`fs.${k}`);
    }
  }

  if (rec.net && typeof rec.net === "object" && !Array.isArray(rec.net)) {
    for (const k of Object.keys(rec.net as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`net.${k}`);
        continue;
      }
      if (!KNOWN_NET_KEYS[k]) unknownKeys.push(`net.${k}`);
    }
  }

  if (rec.command && typeof rec.command === "object" && !Array.isArray(rec.command)) {
    for (const k of Object.keys(rec.command as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`command.${k}`);
        continue;
      }
      if (!KNOWN_COMMAND_KEYS[k]) unknownKeys.push(`command.${k}`);
    }
  }

  if (rec.secrets && typeof rec.secrets === "object" && !Array.isArray(rec.secrets)) {
    for (const k of Object.keys(rec.secrets as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`secrets.${k}`);
        continue;
      }
      if (!KNOWN_SECRETS_KEYS[k]) unknownKeys.push(`secrets.${k}`);
    }
  }

  if (rec.limits && typeof rec.limits === "object" && !Array.isArray(rec.limits)) {
    for (const k of Object.keys(rec.limits as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`limits.${k}`);
        continue;
      }
      if (!KNOWN_LIMITS_KEYS[k]) unknownKeys.push(`limits.${k}`);
    }
  }

  return unknownKeys;
}

/**
 * Known private/loopback IP address patterns.
 */
const PRIVATE_IP_REGEX =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|::1|fc00:|fe80:)/i;

/**
 * Options for configuring LocalPreactivationChecker.
 */
export interface LocalPreactivationCheckerOptions {
  supportedEngines?: string[];
  supportedSdkVersions?: string[];
  strictPathChecks?: boolean;
}

/**
 * Helper to match domain with wildcard support (e.g. *.api.com matches sub.api.com).
 */
export function isDomainAllowed(domain: string, allowedPatterns: string[]): boolean {
  const normDomain = domain.toLowerCase().trim();
  for (const pattern of allowedPatterns) {
    const normPattern = pattern.toLowerCase().trim();
    if (normPattern === normDomain || normPattern === "*") {
      return true;
    }
    if (normPattern.startsWith("*.")) {
      const suffix = normPattern.slice(2);
      if (normDomain === suffix || normDomain.endsWith(`.${suffix}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Helper to check if a path is safe and permitted under base allowed/denied paths.
 */
export function isPathPermitted(
  targetPath: string,
  allowedPaths: string[],
  denyPaths: string[],
  workspaceRoot?: string,
): { permitted: boolean; reason?: string } {
  const normalizedTarget = path.normalize(targetPath);

  // Check deny paths first (denials take strict precedence)
  for (const deny of denyPaths) {
    const normalizedDeny = path.normalize(deny);
    if (
      normalizedTarget === normalizedDeny ||
      normalizedTarget.startsWith(`${normalizedDeny}${path.sep}`) ||
      normalizedTarget.startsWith(normalizedDeny)
    ) {
      return {
        permitted: false,
        reason: `Path '${targetPath}' is matched by deny pattern '${deny}'`,
      };
    }
  }

  // If no allowed paths are specified, allow if workspaceRoot contains it
  if (allowedPaths.length === 0) {
    if (workspaceRoot) {
      const normRoot = path.normalize(workspaceRoot);
      if (normalizedTarget === normRoot || normalizedTarget.startsWith(`${normRoot}${path.sep}`)) {
        return { permitted: true };
      }
      return {
        permitted: false,
        reason: `Path '${targetPath}' is outside workspace root '${workspaceRoot}'`,
      };
    }
    return { permitted: true };
  }

  // Check if matches any allowed path
  for (const allowed of allowedPaths) {
    const normalizedAllowed = path.normalize(allowed);
    if (
      normalizedTarget === normalizedAllowed ||
      normalizedTarget.startsWith(`${normalizedAllowed}${path.sep}`) ||
      normalizedAllowed === "." ||
      normalizedAllowed === "*"
    ) {
      return { permitted: true };
    }
  }

  return {
    permitted: false,
    reason: `Path '${targetPath}' is not within any allowed paths: [${allowedPaths.join(", ")}]`,
  };
}

/**
 * Local preactivation checker verifying capability envelope constraints (TE-021),
 * user pin/disable overrides, runtime/SDK support, and non-executing loader inspection (TE-019).
 */
export class LocalPreactivationChecker {
  private readonly supportedEngines: Set<string>;
  private readonly supportedSdkVersions: Set<string>;

  constructor(options: LocalPreactivationCheckerOptions = {}) {
    this.supportedEngines = new Set(
      options.supportedEngines ?? ["deno", "node", "bun", "wasm", "process", "builtin"],
    );
    this.supportedSdkVersions = new Set(options.supportedSdkVersions ?? ["1.0.0", "0.1.0"]);
  }

  /**
   * Evaluates all preactivation checks for a tool candidate.
   */
  async checkPreactivation(context: PreactivationContext): Promise<PreactivationCheckResult> {
    const violations: PreactivationViolation[] = [];
    const warnings: string[] = [];
    const metadata: Record<string, unknown> = {};

    const {
      manifest,
      workspaceId,
      projectId,
      envelope,
      overrides,
      inspection,
      targetVersion,
      targetDigest,
      workspaceRoot,
      lockedEntry,
      certificate,
      trustVerification,
    } = context;
    const versionToCheck = targetVersion ?? manifest?.version ?? "0.0.0";

    // -------------------------------------------------------------------------
    // 0. Manifest Schema Validation & Integrity
    // -------------------------------------------------------------------------
    if (!manifest || typeof manifest !== "object") {
      violations.push({
        code: "INVALID_MANIFEST",
        subsystem: "manifest",
        message: "Tool manifest is missing or not a valid object",
        field: "manifest",
      });
    } else if (!manifest.id || !manifest.name || !manifest.version) {
      violations.push({
        code: "INVALID_MANIFEST",
        subsystem: "manifest",
        message: "Tool manifest is missing required identity fields (id, name, version)",
        field: "manifest",
      });
    }

    if (targetVersion && manifest && manifest.version !== targetVersion) {
      violations.push({
        code: "LOCK_VERSION_MISMATCH",
        subsystem: "manifest",
        message: `Manifest version '${manifest.version}' does not match targetVersion '${targetVersion}'`,
        field: "manifest.version",
        requestedValue: manifest.version,
      });
    }

    if (targetDigest && manifest) {
      const normTarget = normalizeDigest(targetDigest);
      const manifestDig = normalizeDigest(manifest.digest);
      const inspectionDig = normalizeDigest(inspection?.bundleDigest ?? inspection?.artifactDigest);
      const lockedDig = normalizeDigest(lockedEntry?.artifactDigest);
      if (normTarget !== manifestDig && normTarget !== inspectionDig && normTarget !== lockedDig) {
        violations.push({
          code: "TARGET_DIGEST_MISMATCH",
          subsystem: "manifest",
          message: `Target digest '${targetDigest}' does not match manifest or artifact digest`,
          field: "targetDigest",
          requestedValue: targetDigest,
        });
      }
    }

    const accountId = (context as unknown as Record<string, unknown>).accountId as
      | string
      | undefined;
    if (
      accountId &&
      certificate?.subject?.accountId &&
      certificate.subject.accountId !== accountId
    ) {
      violations.push({
        code: "CERTIFICATE_ACCOUNT_ID_MISMATCH",
        subsystem: "certificate",
        message: `Activation certificate accountId '${certificate.subject.accountId}' does not match context accountId '${accountId}'`,
        field: "certificate.subject.accountId",
        requestedValue: certificate.subject.accountId,
      });
    }

    // -------------------------------------------------------------------------
    // 1. Non-executing loader inspection checks (TE-019)
    // -------------------------------------------------------------------------
    if (inspection) {
      if (inspection.signature && !inspection.signature.valid) {
        violations.push({
          code: "INVALID_SIGNATURE",
          subsystem: "security",
          message: `Artifact signature verification failed: ${inspection.signature.error ?? "Invalid"}`,
          field: "signature",
        });
      }

      for (const file of inspection.files) {
        if (file.path.startsWith("../") || file.path.includes("/../")) {
          violations.push({
            code: "PATH_TRAVERSAL_DETECTED",
            subsystem: "security",
            message: `Bundle contains dangerous path traversal entry: ${file.path}`,
            field: "files",
            requestedValue: file.path,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. User Overrides & Pin Constraints
    // -------------------------------------------------------------------------
    if (overrides && overrides.length > 0) {
      for (const override of overrides) {
        if (override.toolId === manifest.id) {
          // Check explicit disable override
          if (override.action === "disable" || override.isEnabled === false) {
            violations.push({
              code: "USER_DISABLED_OVERRIDE",
              subsystem: "override",
              message: `Tool '${manifest.id}' is explicitly disabled by user override`,
              field: "action",
              requestedValue: "disable",
            });
          }

          // Check explicit version pin override
          if (override.action === "pin" && override.pinnedVersion) {
            if (versionToCheck !== override.pinnedVersion) {
              violations.push({
                code: "USER_PIN_OVERRIDE",
                subsystem: "override",
                message: `Tool '${manifest.id}' is pinned to version '${override.pinnedVersion}'; candidate version '${versionToCheck}' rejected`,
                field: "pinnedVersion",
                requestedValue: versionToCheck,
              });
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Runtime & SDK Support
    // -------------------------------------------------------------------------
    const runtimeReq = manifest.runtime as Record<string, unknown> | undefined;
    if (runtimeReq) {
      const engine =
        typeof runtimeReq.engine === "string" ? runtimeReq.engine.toLowerCase() : "node";
      if (!this.supportedEngines.has(engine)) {
        violations.push({
          code: "UNSUPPORTED_RUNTIME",
          subsystem: "runtime",
          message: `Tool requires unsupported runtime engine '${engine}'. Supported: ${Array.from(this.supportedEngines).join(", ")}`,
          field: "runtime.engine",
          requestedValue: engine,
        });
      }

      if (typeof runtimeReq.sdkVersion === "string") {
        if (
          this.supportedSdkVersions.size > 0 &&
          !this.supportedSdkVersions.has(runtimeReq.sdkVersion)
        ) {
          warnings.push(
            `Tool requested SDK version '${runtimeReq.sdkVersion}' may not be fully supported`,
          );
        }
      }
    }
    // -------------------------------------------------------------------------
    // 4. V1 Tool Lock Integrity & Exact Version Checks
    // -------------------------------------------------------------------------
    if (lockedEntry) {
      if (lockedEntry.status === "disabled") {
        violations.push({
          code: "LOCK_TOOL_DISABLED",
          subsystem: "lock",
          message: `Tool '${manifest.id}' is disabled in the project lockfile`,
          field: "lockedEntry.status",
          requestedValue: lockedEntry.status,
        });
      }

      if (lockedEntry.toolId !== manifest.id) {
        violations.push({
          code: "LOCK_TOOL_ID_MISMATCH",
          subsystem: "lock",
          message: `Locked entry toolId '${lockedEntry.toolId}' does not match manifest id '${manifest.id}'`,
          field: "lockedEntry.toolId",
          requestedValue: lockedEntry.toolId,
        });
      }

      if (lockedEntry.name !== manifest.name) {
        violations.push({
          code: "LOCK_TOOL_NAME_MISMATCH",
          subsystem: "lock",
          message: `Locked entry name '${lockedEntry.name}' does not match manifest name '${manifest.name}'`,
          field: "lockedEntry.name",
          requestedValue: lockedEntry.name,
        });
      }

      if (lockedEntry.version !== manifest.version) {
        violations.push({
          code: "LOCK_VERSION_MISMATCH",
          subsystem: "lock",
          message: `Locked entry version '${lockedEntry.version}' does not match manifest version '${manifest.version}'`,
          field: "lockedEntry.version",
          requestedValue: lockedEntry.version,
        });
      }

      const computedManifestDigest = normalizeDigest(hashCanonical(manifest));
      const lockedManifestDigest = normalizeDigest(lockedEntry.manifestDigest);
      const inspectionManifestDigest = normalizeDigest(inspection?.manifestDigest);

      if (
        lockedManifestDigest !== computedManifestDigest &&
        (inspectionManifestDigest ? lockedManifestDigest !== inspectionManifestDigest : true)
      ) {
        violations.push({
          code: "LOCK_MANIFEST_DIGEST_MISMATCH",
          subsystem: "lock",
          message: `Locked manifest digest '${lockedEntry.manifestDigest}' does not match computed/inspected manifest digest`,
          field: "lockedEntry.manifestDigest",
          requestedValue: lockedEntry.manifestDigest,
        });
      }

      const expectedArtifactDigest = normalizeDigest(lockedEntry.artifactDigest);
      const actualArtifactDigest = normalizeDigest(
        targetDigest ?? inspection?.artifactDigest ?? inspection?.bundleDigest,
      );
      if (actualArtifactDigest && expectedArtifactDigest !== actualArtifactDigest) {
        violations.push({
          code: "LOCK_ARTIFACT_DIGEST_MISMATCH",
          subsystem: "lock",
          message: `Locked artifact digest '${lockedEntry.artifactDigest}' does not match artifact digest '${actualArtifactDigest}'`,
          field: "lockedEntry.artifactDigest",
          requestedValue: lockedEntry.artifactDigest,
        });
      }

      if (lockedEntry.envelopeDigest && envelope) {
        const computedEnvDigest = normalizeDigest(hashCanonical(envelope));
        const lockedEnvDigest = normalizeDigest(lockedEntry.envelopeDigest);
        if (lockedEnvDigest !== computedEnvDigest) {
          violations.push({
            code: "LOCK_ENVELOPE_DIGEST_MISMATCH",
            subsystem: "lock",
            message: `Locked envelope digest '${lockedEntry.envelopeDigest}' does not match workspace capability envelope digest`,
            field: "lockedEntry.envelopeDigest",
            requestedValue: lockedEntry.envelopeDigest,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // 5. V1 Activation Certificate & Trust Verification Checks
    // -------------------------------------------------------------------------
    if (certificate) {
      if (certificate.toolId !== manifest.id) {
        violations.push({
          code: "CERTIFICATE_TOOL_ID_MISMATCH",
          subsystem: "certificate",
          message: `Activation certificate toolId '${certificate.toolId}' does not match manifest id '${manifest.id}'`,
          field: "certificate.toolId",
          requestedValue: certificate.toolId,
        });
      }

      if (certificate.toolName !== manifest.name) {
        violations.push({
          code: "CERTIFICATE_TOOL_NAME_MISMATCH",
          subsystem: "certificate",
          message: `Activation certificate toolName '${certificate.toolName}' does not match manifest name '${manifest.name}'`,
          field: "certificate.toolName",
          requestedValue: certificate.toolName,
        });
      }

      if (certificate.version !== manifest.version) {
        violations.push({
          code: "CERTIFICATE_VERSION_MISMATCH",
          subsystem: "certificate",
          message: `Activation certificate version '${certificate.version}' does not match manifest version '${manifest.version}'`,
          field: "certificate.version",
          requestedValue: certificate.version,
        });
      }

      if (projectId && certificate.projectId !== projectId) {
        violations.push({
          code: "CERTIFICATE_PROJECT_ID_MISMATCH",
          subsystem: "certificate",
          message: `Activation certificate projectId '${certificate.projectId}' does not match project '${projectId}'`,
          field: "certificate.projectId",
          requestedValue: certificate.projectId,
        });
      }

      const certManifestDigest = normalizeDigest(certificate.manifestDigest);
      const expectedManifestDigest = normalizeDigest(
        lockedEntry?.manifestDigest ?? inspection?.manifestDigest ?? hashCanonical(manifest),
      );
      if (certManifestDigest !== expectedManifestDigest) {
        violations.push({
          code: "CERTIFICATE_MANIFEST_DIGEST_MISMATCH",
          subsystem: "certificate",
          message: `Activation certificate manifest digest '${certificate.manifestDigest}' does not match expected manifest digest`,
          field: "certificate.manifestDigest",
          requestedValue: certificate.manifestDigest,
        });
      }

      const certArtifactDigest = normalizeDigest(certificate.artifactDigest);
      const expectedArtifactDigest = normalizeDigest(
        lockedEntry?.artifactDigest ??
          targetDigest ??
          inspection?.artifactDigest ??
          inspection?.bundleDigest,
      );
      if (expectedArtifactDigest && certArtifactDigest !== expectedArtifactDigest) {
        violations.push({
          code: "CERTIFICATE_ARTIFACT_DIGEST_MISMATCH",
          subsystem: "certificate",
          message: `Activation certificate artifact digest '${certificate.artifactDigest}' does not match expected artifact digest`,
          field: "certificate.artifactDigest",
          requestedValue: certificate.artifactDigest,
        });
      }

      if (envelope) {
        const computedEnvDigest = normalizeDigest(hashCanonical(envelope));
        const certEnvDigest = normalizeDigest(certificate.capabilityEnvelopeDigest);
        if (certEnvDigest !== computedEnvDigest) {
          violations.push({
            code: "CERTIFICATE_ENVELOPE_DIGEST_MISMATCH",
            subsystem: "certificate",
            message: `Activation certificate capability envelope digest '${certificate.capabilityEnvelopeDigest}' does not match envelope digest`,
            field: "certificate.capabilityEnvelopeDigest",
            requestedValue: certificate.capabilityEnvelopeDigest,
          });
        }
      }

      const inspectionEvidenceDigest = normalizeDigest(
        inspection?.qualificationEvidenceDigest ??
          ((inspection as Record<string, unknown> | null | undefined)?.evidenceDigest as
            | string
            | undefined),
      );
      if (inspectionEvidenceDigest) {
        const certEvidenceDigest = normalizeDigest(certificate.qualificationEvidenceDigest);
        if (certEvidenceDigest !== inspectionEvidenceDigest) {
          violations.push({
            code: "CERTIFICATE_EVIDENCE_DIGEST_MISMATCH",
            subsystem: "certificate",
            message: `Activation certificate evidence digest '${certificate.qualificationEvidenceDigest}' does not match qualification evidence digest`,
            field: "certificate.qualificationEvidenceDigest",
            requestedValue: certificate.qualificationEvidenceDigest,
          });
        }
      }

      if (certificate.status === "revoked") {
        violations.push({
          code: "CERTIFICATE_REVOKED",
          subsystem: "certificate",
          message: "Activation certificate has status 'revoked'",
          field: "certificate.status",
          requestedValue: certificate.status,
        });
      } else if (certificate.status === "suspended") {
        violations.push({
          code: "CERTIFICATE_SUSPENDED",
          subsystem: "certificate",
          message: "Activation certificate has status 'suspended'",
          field: "certificate.status",
          requestedValue: certificate.status,
        });
      } else if (certificate.status !== "active") {
        violations.push({
          code: "CERTIFICATE_NOT_ACTIVE",
          subsystem: "certificate",
          message: `Activation certificate status is '${certificate.status}', expected 'active'`,
          field: "certificate.status",
          requestedValue: certificate.status,
        });
      }

      const now = Date.now();
      const expiresTime = new Date(certificate.expiresAt).getTime();
      const notBeforeTime = new Date(certificate.notBefore).getTime();
      if (!Number.isNaN(expiresTime) && now > expiresTime) {
        violations.push({
          code: "CERTIFICATE_EXPIRED",
          subsystem: "certificate",
          message: `Activation certificate expired at ${certificate.expiresAt}`,
          field: "certificate.expiresAt",
          requestedValue: certificate.expiresAt,
        });
      }
      if (!Number.isNaN(notBeforeTime) && now < notBeforeTime) {
        violations.push({
          code: "CERTIFICATE_NOT_YET_VALID",
          subsystem: "certificate",
          message: `Activation certificate is not valid before ${certificate.notBefore}`,
          field: "certificate.notBefore",
          requestedValue: certificate.notBefore,
        });
      }
    }

    if (trustVerification) {
      if (!trustVerification.trusted) {
        const code = trustVerification.errorCode ?? "TRUST_VERIFICATION_FAILED";
        const message = trustVerification.reason ?? "Tool trust verification failed";
        violations.push({
          code,
          subsystem: "trust",
          message,
          field: "trustVerification.trusted",
          requestedValue: false,
        });
      }

      if (trustVerification.revocationMetadata) {
        const rev = trustVerification.revocationMetadata;
        if (certificate && rev.revokedCertificates && Array.isArray(rev.revokedCertificates)) {
          const isRevoked = rev.revokedCertificates.some(
            (entry: { certificateId: string }) => entry.certificateId === certificate.certificateId,
          );
          if (isRevoked) {
            violations.push({
              code: "CERTIFICATE_REVOKED",
              subsystem: "certificate",
              message: `Activation certificate ${certificate.certificateId} is revoked`,
              field: "trustVerification.revocationMetadata.revokedCertificates",
            });
          }
        }
        if (manifest && rev.revokedTools && Array.isArray(rev.revokedTools)) {
          const isToolRevoked = rev.revokedTools.some(
            (entry: { toolId: string; version?: string }) =>
              entry.toolId === manifest.id &&
              (!entry.version || entry.version === manifest.version),
          );
          if (isToolRevoked) {
            violations.push({
              code: "TOOL_REVOKED",
              subsystem: "trust",
              message: `Tool ${manifest.id} is revoked in revocation metadata`,
              field: "trustVerification.revocationMetadata.revokedTools",
            });
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 4. Capability Envelope Constraints (TE-021)
    // -------------------------------------------------------------------------
    if (envelope) {
      if (envelope.workspaceId && envelope.workspaceId !== workspaceId) {
        violations.push({
          code: "WORKSPACE_MISMATCH",
          subsystem: "capability",
          message: `Capability envelope workspaceId '${envelope.workspaceId}' does not match workspace '${workspaceId}'`,
          field: "envelope.workspaceId",
          requestedValue: envelope.workspaceId,
        });
      }

      if (envelope.isFrozen) {
        violations.push({
          code: "ENVELOPE_FROZEN",
          subsystem: "capability",
          message: `Capability envelope '${envelope.envelopeId}' is frozen and strictly prohibits capability modifications or activations`,
          field: "envelope.isFrozen",
          requestedValue: true,
        });
      }

      const caps: Partial<CapabilityManifest> =
        (manifest?.capabilities as Partial<CapabilityManifest> | undefined) ?? {};

      const unknownCapKeys = detectUnknownCapabilityKeys(caps);
      for (const unk of unknownCapKeys) {
        violations.push({
          code: "UNKNOWN_CAPABILITY_TYPE",
          subsystem: "capability",
          message: `Unknown or unauthorized capability property '${unk}' detected in request`,
          field: `capabilities.${unk}`,
          requestedValue: unk,
        });
      }

      // --- FS Capabilities ---
      if (caps.fs) {
        const envFs = envelope.fs;
        const toolFs = caps.fs;

        // Check read paths
        for (const readPath of toolFs.readPaths ?? []) {
          const res = isPathPermitted(
            readPath,
            envFs.readPaths ?? [],
            envFs.denyPaths ?? [],
            workspaceRoot,
          );
          if (!res.permitted) {
            violations.push({
              code: "FS_READ_PATH_DISALLOWED",
              subsystem: "fs",
              message: res.reason ?? `Read access to path '${readPath}' disallowed by envelope`,
              field: "capabilities.fs.readPaths",
              requestedValue: readPath,
            });
          }
        }

        // Check write paths
        for (const writePath of toolFs.writePaths ?? []) {
          const res = isPathPermitted(
            writePath,
            envFs.writePaths ?? [],
            envFs.denyPaths ?? [],
            workspaceRoot,
          );
          if (!res.permitted) {
            violations.push({
              code: "FS_WRITE_PATH_DISALLOWED",
              subsystem: "fs",
              message: res.reason ?? `Write access to path '${writePath}' disallowed by envelope`,
              field: "capabilities.fs.writePaths",
              requestedValue: writePath,
            });
          }
        }

        // Check max file size limit
        if (toolFs.maxFileSizeBytes && envFs.maxFileSizeBytes) {
          if (toolFs.maxFileSizeBytes > envFs.maxFileSizeBytes) {
            violations.push({
              code: "FS_MAX_SIZE_EXCEEDED",
              subsystem: "fs",
              message: `Requested maxFileSizeBytes (${toolFs.maxFileSizeBytes}) exceeds envelope limit (${envFs.maxFileSizeBytes})`,
              field: "capabilities.fs.maxFileSizeBytes",
              requestedValue: toolFs.maxFileSizeBytes,
            });
          }
        }
      }

      // --- Net Capabilities ---
      if (caps.net) {
        const envNet = envelope.net;
        const toolNet = caps.net;

        // If tool requests outbound, envelope must allow outbound
        if (toolNet.allowOutbound && !envNet.allowOutbound) {
          violations.push({
            code: "NET_OUTBOUND_DISALLOWED",
            subsystem: "net",
            message: "Tool requested network outbound access, but envelope has allowOutbound=false",
            field: "capabilities.net.allowOutbound",
            requestedValue: true,
          });
        }

        // Check domains
        for (const domain of toolNet.allowedDomains ?? []) {
          if (envNet.denyPrivateRanges && PRIVATE_IP_REGEX.test(domain)) {
            violations.push({
              code: "NET_PRIVATE_IP_BLOCKED",
              subsystem: "net",
              message: `Domain/host '${domain}' is a private or loopback address prohibited by envelope`,
              field: "capabilities.net.allowedDomains",
              requestedValue: domain,
            });
            continue;
          }

          if (envNet.allowedDomains && envNet.allowedDomains.length > 0) {
            if (!isDomainAllowed(domain, envNet.allowedDomains)) {
              violations.push({
                code: "NET_DOMAIN_DISALLOWED",
                subsystem: "net",
                message: `Domain '${domain}' is not permitted by capability envelope allowedDomains: [${envNet.allowedDomains.join(", ")}]`,
                field: "capabilities.net.allowedDomains",
                requestedValue: domain,
              });
            }
          }
        }

        // Check ports
        if (envNet.allowedPorts && envNet.allowedPorts.length > 0 && toolNet.allowedPorts) {
          const allowedPortsSet = new Set(envNet.allowedPorts);
          for (const port of toolNet.allowedPorts) {
            if (!allowedPortsSet.has(port)) {
              violations.push({
                code: "NET_PORT_DISALLOWED",
                subsystem: "net",
                message: `Port ${port} is not in capability envelope allowedPorts: [${envNet.allowedPorts.join(", ")}]`,
                field: "capabilities.net.allowedPorts",
                requestedValue: port,
              });
            }
          }
        }

        // Check protocols
        if (
          envNet.allowedProtocols &&
          envNet.allowedProtocols.length > 0 &&
          toolNet.allowedProtocols
        ) {
          const allowedProtoSet = new Set(envNet.allowedProtocols);
          for (const proto of toolNet.allowedProtocols) {
            if (!allowedProtoSet.has(proto)) {
              violations.push({
                code: "NET_PROTOCOL_DISALLOWED",
                subsystem: "net",
                message: `Protocol '${proto}' is not in capability envelope allowedProtocols: [${envNet.allowedProtocols.join(", ")}]`,
                field: "capabilities.net.allowedProtocols",
                requestedValue: proto,
              });
            }
          }
        }
      }

      // --- Command Capabilities ---
      if (caps.command) {
        const envCmd = envelope.command;
        const toolCmd = caps.command;

        // Shell execution
        if (toolCmd.allowShellExecution && !envCmd.allowShellExecution) {
          violations.push({
            code: "COMMAND_SHELL_DISALLOWED",
            subsystem: "command",
            message:
              "Tool requested shell execution, but capability envelope has allowShellExecution=false",
            field: "capabilities.command.allowShellExecution",
            requestedValue: true,
          });
        }

        // Whitelisted commands
        if (
          envCmd.allowedCommands &&
          envCmd.allowedCommands.length > 0 &&
          toolCmd.allowedCommands
        ) {
          const allowedCmdsSet = new Set(envCmd.allowedCommands.map((c) => c.toLowerCase()));
          for (const cmd of toolCmd.allowedCommands) {
            if (!allowedCmdsSet.has(cmd.toLowerCase())) {
              violations.push({
                code: "COMMAND_DISALLOWED",
                subsystem: "command",
                message: `Command '${cmd}' is not in capability envelope allowedCommands whitelist`,
                field: "capabilities.command.allowedCommands",
                requestedValue: cmd,
              });
            }
          }
        }

        // Dangerous environment variables
        const envPassthrough =
          toolCmd.allowEnvPassthrough ??
          ((toolCmd as Record<string, unknown>).allowedEnvVars as string[] | undefined);
        if (envPassthrough) {
          for (const envVar of envPassthrough) {
            if (DANGEROUS_ENV_VARS.includes(envVar.toUpperCase())) {
              violations.push({
                code: "DANGEROUS_ENV_VAR_REQUESTED",
                subsystem: "command",
                message: `Dangerous environment variable '${envVar}' cannot be granted`,
                field: "capabilities.command.allowEnvPassthrough",
                requestedValue: envVar,
              });
            }
          }
        }
      }

      // --- Secrets Capabilities ---
      if (caps.secrets) {
        const envSec = envelope.secrets;
        const toolSec = caps.secrets;

        if (
          toolSec.denyDirectRead === false ||
          (toolSec as Record<string, unknown>).allowDirectRead === true
        ) {
          violations.push({
            code: "DIRECT_READ_DISALLOWED",
            subsystem: "secrets",
            message: `Tool '${manifest.id}' requests direct secret reads (denyDirectRead: false), which is prohibited by protocol v1.0.0. Migrate tool to use opaque secret references and trusted broker mediation.`,
            field: "capabilities.secrets.denyDirectRead",
            requestedValue: false,
          });
        }

        const secretNames =
          toolSec.allowedSecretNames ??
          ((toolSec as Record<string, unknown>).requiredSecrets as string[] | undefined);
        if (envSec.allowedSecretNames && envSec.allowedSecretNames.length > 0 && secretNames) {
          const allowedSecretsSet = new Set(envSec.allowedSecretNames);
          for (const secret of secretNames) {
            if (!allowedSecretsSet.has(secret)) {
              violations.push({
                code: "SECRET_NAME_DISALLOWED",
                subsystem: "secrets",
                message: `Secret '${secret}' is not permitted by capability envelope allowedSecretNames`,
                field: "capabilities.secrets.allowedSecretNames",
                requestedValue: secret,
              });
            }
          }
        }
      }

      // --- Limits ---
      if (envelope.limits) {
        const envLimits = envelope.limits;
        const rawLimits = (manifest.limits ?? {}) as Record<string, unknown>;
        const maxMem =
          typeof rawLimits.maxMemoryMb === "number"
            ? rawLimits.maxMemoryMb
            : typeof rawLimits.maxMemoryBytes === "number"
              ? Math.ceil(rawLimits.maxMemoryBytes / (1024 * 1024))
              : undefined;

        if (maxMem && envLimits.maxMemoryMb && maxMem > envLimits.maxMemoryMb) {
          violations.push({
            code: "LIMIT_MEMORY_EXCEEDED",
            subsystem: "limits",
            message: `Requested maxMemoryMb (${maxMem}MB) exceeds envelope limit (${envLimits.maxMemoryMb}MB)`,
            field: "limits.maxMemoryMb",
            requestedValue: maxMem,
          });
        }

        const timeout =
          typeof rawLimits.timeoutMs === "number"
            ? rawLimits.timeoutMs
            : typeof rawLimits.maxExecutionTimeMs === "number"
              ? rawLimits.maxExecutionTimeMs
              : typeof rawLimits.executionTimeoutMs === "number"
                ? rawLimits.executionTimeoutMs
                : undefined;

        if (timeout && envLimits.maxExecutionTimeMs && timeout > envLimits.maxExecutionTimeMs) {
          violations.push({
            code: "LIMIT_TIMEOUT_EXCEEDED",
            subsystem: "limits",
            message: `Requested timeout (${timeout}ms) exceeds envelope limit (${envLimits.maxExecutionTimeMs}ms)`,
            field: "limits.timeoutMs",
            requestedValue: timeout,
          });
        }
      }
    }

    const eligible = violations.length === 0;

    let outcome: PreactivationCheckOutcome = "eligible";
    if (!eligible) {
      const hasCapabilityViolation = violations.some((v) =>
        ["fs", "net", "command", "secrets", "limits", "capability"].includes(v.subsystem),
      );
      const hasTrustViolation = violations.some(
        (v) =>
          ["trust", "security"].includes(v.subsystem) ||
          v.code.includes("REVOKED") ||
          v.code.includes("SIGNATURE") ||
          v.code.includes("UNTRUSTED"),
      );
      const hasMismatchViolation = violations.some(
        (v) =>
          ["lock", "certificate", "manifest"].includes(v.subsystem) || v.code.includes("MISMATCH"),
      );

      if (hasCapabilityViolation) {
        outcome = "blocked_by_capability";
      } else if (hasTrustViolation) {
        outcome = "untrusted";
      } else if (hasMismatchViolation) {
        outcome = "mismatch";
      } else {
        outcome = "rejected";
      }
    }

    return {
      eligible,
      outcome,
      violations,
      warnings,
      metadata: {
        workspaceId,
        projectId,
        toolId: manifest?.id ?? "unknown",
        version: versionToCheck,
        envelopeChecked: Boolean(envelope),
        overridesChecked: Boolean(overrides && overrides.length > 0),
        lockedEntryChecked: Boolean(lockedEntry),
        certificateChecked: Boolean(certificate),
        trustVerificationChecked: Boolean(trustVerification),
        ...metadata,
      },
    };
  }
}
