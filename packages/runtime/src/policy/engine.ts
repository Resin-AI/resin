import {
  type CanonicalJsonRecord,
  type CanonicalJsonValue,
  type CapabilityEnvelope,
  CapabilityEnvelopeSchema,
  type CapabilityManifest,
  CapabilityManifestSchema,
  type ToolManifest,
  canonicalJson,
} from "@resin/contracts";
import { sha256 } from "@resin/crypto";
import {
  type GrantActor,
  type InvocationGrant,
  createInvocationGrant,
  verifyInvocationGrant,
} from "./grant.js";
import { type PolicyViolation, intersectCapabilities } from "./intersection.js";

/**
 * Standard deny reason codes returned by the policy engine.
 */
export type PolicyDenyCode =
  | "ENVELOPE_EXPANSION_ATTEMPT"
  | "UNKNOWN_CAPABILITY_TYPE"
  | "ENVELOPE_FROZEN"
  | "WORKSPACE_MISMATCH"
  | "INVALID_MANIFEST"
  | "INVALID_ENVELOPE"
  | "INVALID_CONTEXT"
  | "FS_PATH_NOT_ALLOWED"
  | "FS_TRAVERSAL_DETECTED"
  | "NET_OUTBOUND_FORBIDDEN"
  | "NET_DOMAIN_NOT_ALLOWED"
  | "NET_PRIVATE_IP_BLOCKED"
  | "NET_PORT_NOT_ALLOWED"
  | "NET_PROTOCOL_NOT_ALLOWED"
  | "NET_LOCALHOST_FORBIDDEN"
  | "CMD_NOT_ALLOWED"
  | "CMD_SHELL_FORBIDDEN"
  | "CMD_FORBIDDEN_PATTERN"
  | "CMD_DANGEROUS_ENV"
  | "SECRET_NOT_ALLOWED"
  | "LIMIT_EXCEEDED";

export interface InvocationContext {
  invocationId: string;
  toolId: string;
  toolVersion?: string;
  workspaceId: string;
  projectId?: string;
  accountId?: string;
  customScope?: string;
  workspaceRoot?: string;
  actor?: GrantActor;
  reason?: string;
  timestamp?: number;
}

export type PolicyEvaluationResult =
  | {
      allowed: true;
      grant: InvocationGrant;
      effectiveCapabilities: CapabilityManifest;
      cached?: boolean;
    }
  | {
      allowed: false;
      denyCode: PolicyDenyCode;
      reason: string;
      violations: PolicyViolation[];
      details?: Record<string, CanonicalJsonValue>;
      cached?: boolean;
    };

export interface CapabilityValidationResult {
  valid: boolean;
  unknownKeys: string[];
  error?: string;
}

export interface CapabilityPolicyEngineOptions {
  workspaceRoot?: string;
  policyVersion?: string;
  grantTtlMs?: number;
  allowEnvelopeExpansion?: boolean;
  strictUnknownCheck?: boolean;
  enableCache?: boolean;
  defaultActor?: GrantActor;
}

const KNOWN_TOP_LEVEL_CAPABILITY_KEYS = {
  schemaVersion: true,
  manifestId: true,
  fs: true,
  net: true,
  command: true,
  secrets: true,
  limits: true,
} as const satisfies Record<string, true>;

const KNOWN_FS_KEYS = {
  readPaths: true,
  writePaths: true,
  allowWorkspaceRoot: true,
  allowTemp: true,
  denyPaths: true,
  maxFileSizeBytes: true,
} as const satisfies Record<string, true>;

const KNOWN_NET_KEYS = {
  allowOutbound: true,
  allowedDomains: true,
  allowedHosts: true,
  allowedPorts: true,
  allowedProtocols: true,
  allowLocalhost: true,
  denyPrivateRanges: true,
} as const satisfies Record<string, true>;

const KNOWN_COMMAND_KEYS = {
  allowShellExecution: true,
  allowedCommands: true,
  allowedBinaries: true,
  forbiddenPatterns: true,
  allowEnvPassthrough: true,
} as const satisfies Record<string, true>;

const KNOWN_SECRETS_KEYS = {
  allowedSecretNames: true,
  allowedPrefixes: true,
  denyDirectRead: true,
  injectAsEnv: true,
} as const satisfies Record<string, true>;

const KNOWN_LIMITS_KEYS = {
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
} as const satisfies Record<string, true>;

/**
 * Validates that an object contains only known capability schema keys.
 */
export function detectUnknownCapabilityKeys(
  obj: CapabilityManifest | ToolManifest | CanonicalJsonValue | null | undefined,
): string[] {
  if (!obj || !(obj instanceof Object) || Array.isArray(obj)) {
    return [];
  }

  const unknownKeys: string[] = [];
  // SAFETY: Object tag check confirms obj is a record.
  const rec = obj as CanonicalJsonRecord;

  // Check top-level keys
  for (const k of Object.keys(rec)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      unknownKeys.push(k);
      continue;
    }
    if (!Object.hasOwn(KNOWN_TOP_LEVEL_CAPABILITY_KEYS, k)) {
      unknownKeys.push(k);
    }
  }

  // Check fs subsystem
  if ("fs" in rec && rec.fs && rec.fs instanceof Object && !Array.isArray(rec.fs)) {
    // SAFETY: Tag check confirms rec.fs is an object record.
    const fsRec = rec.fs as CanonicalJsonRecord;
    for (const k of Object.keys(fsRec)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`fs.${k}`);
        continue;
      }
      if (!Object.hasOwn(KNOWN_FS_KEYS, k)) unknownKeys.push(`fs.${k}`);
    }
  }

  // Check net subsystem
  if ("net" in rec && rec.net && rec.net instanceof Object && !Array.isArray(rec.net)) {
    // SAFETY: Tag check confirms rec.net is an object record.
    const netRec = rec.net as CanonicalJsonRecord;
    for (const k of Object.keys(netRec)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`net.${k}`);
        continue;
      }
      if (!Object.hasOwn(KNOWN_NET_KEYS, k)) unknownKeys.push(`net.${k}`);
    }
  }

  // Check command subsystem
  if (
    "command" in rec &&
    rec.command &&
    rec.command instanceof Object &&
    !Array.isArray(rec.command)
  ) {
    // SAFETY: Tag check confirms rec.command is an object record.
    const cmdRec = rec.command as CanonicalJsonRecord;
    for (const k of Object.keys(cmdRec)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`command.${k}`);
        continue;
      }
      if (!Object.hasOwn(KNOWN_COMMAND_KEYS, k)) unknownKeys.push(`command.${k}`);
    }
  }

  // Check secrets subsystem
  if (
    "secrets" in rec &&
    rec.secrets &&
    rec.secrets instanceof Object &&
    !Array.isArray(rec.secrets)
  ) {
    // SAFETY: Tag check confirms rec.secrets is an object record.
    const secretRec = rec.secrets as CanonicalJsonRecord;
    for (const k of Object.keys(secretRec)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`secrets.${k}`);
        continue;
      }
      if (!Object.hasOwn(KNOWN_SECRETS_KEYS, k)) unknownKeys.push(`secrets.${k}`);
    }
  }

  // Check limits subsystem
  if ("limits" in rec && rec.limits && rec.limits instanceof Object && !Array.isArray(rec.limits)) {
    // SAFETY: Tag check confirms rec.limits is an object record.
    const limitRec = rec.limits as CanonicalJsonRecord;
    for (const k of Object.keys(limitRec)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        unknownKeys.push(`limits.${k}`);
        continue;
      }
      if (!Object.hasOwn(KNOWN_LIMITS_KEYS, k)) unknownKeys.push(`limits.${k}`);
    }
  }

  return unknownKeys;
}

/**
 * Map PolicyViolationCode to primary PolicyDenyCode.
 */
function violationToDenyCode(violation: PolicyViolation): PolicyDenyCode {
  switch (violation.code) {
    case "FS_PATH_EXPANSION":
    case "FS_WRITE_PATH_EXPANSION":
    case "FS_WORKSPACE_ROOT_FORBIDDEN":
    case "FS_TEMP_FORBIDDEN":
      return "FS_PATH_NOT_ALLOWED";
    case "FS_TRAVERSAL_DETECTED":
      return "FS_TRAVERSAL_DETECTED";
    case "FS_MAX_FILE_SIZE_EXPANSION":
      return "LIMIT_EXCEEDED";
    case "NET_OUTBOUND_FORBIDDEN":
      return "NET_OUTBOUND_FORBIDDEN";
    case "NET_DOMAIN_EXPANSION":
    case "NET_HOST_EXPANSION":
      return "NET_DOMAIN_NOT_ALLOWED";
    case "NET_PORT_EXPANSION":
      return "NET_PORT_NOT_ALLOWED";
    case "NET_PROTOCOL_EXPANSION":
      return "NET_PROTOCOL_NOT_ALLOWED";
    case "NET_LOCALHOST_FORBIDDEN":
      return "NET_LOCALHOST_FORBIDDEN";
    case "NET_PRIVATE_IP_BLOCKED":
      return "NET_PRIVATE_IP_BLOCKED";
    case "CMD_SHELL_FORBIDDEN":
      return "CMD_SHELL_FORBIDDEN";
    case "CMD_COMMAND_EXPANSION":
    case "CMD_BINARY_EXPANSION":
      return "CMD_NOT_ALLOWED";
    case "CMD_FORBIDDEN_PATTERN_VIOLATION":
      return "CMD_FORBIDDEN_PATTERN";
    case "CMD_ENV_EXPANSION":
      return "CMD_DANGEROUS_ENV";
    case "SECRET_NAME_EXPANSION":
    case "SECRET_PREFIX_EXPANSION":
    case "SECRET_DIRECT_READ_FORBIDDEN":
      return "SECRET_NOT_ALLOWED";
    case "LIMIT_EXPANSION":
      return "LIMIT_EXCEEDED";
    case "UNKNOWN_CAPABILITY_TYPE":
      return "UNKNOWN_CAPABILITY_TYPE";
    default:
      return "ENVELOPE_EXPANSION_ATTEMPT";
  }
}

/**
 * Capability Policy Engine.
 * Evaluates tool execution requests against workspace capability envelopes,
 * computes exact least-privilege grants, and produces immutable InvocationGrants.
 */
export class CapabilityPolicyEngine {
  private readonly workspaceRoot: string;
  private readonly policyVersion: string;
  private readonly grantTtlMs: number;
  private readonly allowEnvelopeExpansion: boolean;
  private readonly strictUnknownCheck: boolean;
  private readonly enableCache: boolean;
  private readonly defaultActor: GrantActor;

  // In-memory envelope store: workspaceId -> CapabilityEnvelope
  private readonly envelopes = new Map<string, CapabilityEnvelope>();

  // Evaluation cache: cacheKey -> PolicyEvaluationResult
  private readonly cache = new Map<string, PolicyEvaluationResult>();

  constructor(options: CapabilityPolicyEngineOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.policyVersion = options.policyVersion ?? "1.0.0";
    this.grantTtlMs = options.grantTtlMs ?? 5 * 60 * 1000;
    this.allowEnvelopeExpansion = options.allowEnvelopeExpansion ?? false;
    this.strictUnknownCheck = options.strictUnknownCheck !== false; // Default true
    this.enableCache = options.enableCache !== false; // Default true
    this.defaultActor = options.defaultActor ?? {
      type: "policy_engine",
      id: "engine_v1",
    };
  }

  // ===========================================================================
  // Envelope Management & Cache Invalidation
  // ===========================================================================

  /**
   * Registers or updates a workspace capability envelope.
   * Immediately invalidates any cached evaluation results for this workspace.
   */
  setEnvelope(envelope: CapabilityEnvelope): void {
    const parsed = CapabilityEnvelopeSchema.parse(envelope);
    this.envelopes.set(parsed.workspaceId, parsed);
    this.invalidateCache(parsed.workspaceId);
  }

  /**
   * Alias for setEnvelope.
   */
  updateEnvelope(envelope: CapabilityEnvelope): void {
    this.setEnvelope(envelope);
  }

  /**
   * Retrieves registered envelope for a workspace.
   */
  getEnvelope(workspaceId: string): CapabilityEnvelope | undefined {
    return this.envelopes.get(workspaceId);
  }

  /**
   * Clears the evaluation cache immediately for a workspace or across all workspaces.
   */
  invalidateCache(workspaceId?: string): void {
    if (!workspaceId) {
      this.cache.clear();
      return;
    }

    // Invalidate keys belonging to this workspace
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${workspaceId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Validates capability manifest object for schema compliance and unknown properties.
   */
  validateCapabilities(
    capabilities: CapabilityManifest | ToolManifest | CanonicalJsonValue | null | undefined,
  ): CapabilityValidationResult {
    const unknownKeys = detectUnknownCapabilityKeys(capabilities);
    const parsed = CapabilityManifestSchema.safeParse(capabilities);
    return {
      valid: parsed.success && unknownKeys.length === 0,
      unknownKeys,
      error: parsed.success ? undefined : parsed.error.message,
    };
  }

  // ===========================================================================
  // Invocation Evaluation
  // ===========================================================================

  /**
   * Evaluates a requested invocation against a workspace envelope.
   */
  evaluateInvocation(
    manifestOrCapabilities:
      | ToolManifest
      | CapabilityManifest
      | CanonicalJsonValue
      | null
      | undefined,
    envelopeOrWorkspaceId: CapabilityEnvelope | string,
    context: InvocationContext,
  ): PolicyEvaluationResult {
    // 1. Validate Context
    if (!context || !context.invocationId || !context.toolId || !context.workspaceId) {
      return {
        allowed: false,
        denyCode: "INVALID_CONTEXT",
        reason: "Invocation context is missing required fields (invocationId, toolId, workspaceId)",
        violations: [],
      };
    }

    // 2. Resolve Envelope
    let envelope: CapabilityEnvelope;
    if (String(envelopeOrWorkspaceId) === envelopeOrWorkspaceId) {
      const found = this.envelopes.get(envelopeOrWorkspaceId);
      if (!found) {
        return {
          allowed: false,
          denyCode: "INVALID_ENVELOPE",
          reason: `No capability envelope registered for workspace: ${envelopeOrWorkspaceId}`,
          violations: [],
        };
      }
      envelope = found;
    } else {
      const parsedEnv = CapabilityEnvelopeSchema.safeParse(envelopeOrWorkspaceId);
      if (!parsedEnv.success) {
        return {
          allowed: false,
          denyCode: "INVALID_ENVELOPE",
          reason: `Invalid capability envelope schema: ${parsedEnv.error.message}`,
          violations: [],
        };
      }
      envelope = parsedEnv.data;
    }

    // 3. Check Workspace, Project & Account Mismatches
    if (envelope.workspaceId !== context.workspaceId) {
      return {
        allowed: false,
        denyCode: "WORKSPACE_MISMATCH",
        reason: `Workspace mismatch: envelope is bound to '${envelope.workspaceId}' but context requested '${context.workspaceId}'`,
        violations: [],
        details: {
          envelopeWorkspaceId: envelope.workspaceId,
          contextWorkspaceId: context.workspaceId,
        },
      };
    }

    const envProjectId =
      "projectId" in envelope && String(envelope.projectId) === envelope.projectId
        ? envelope.projectId
        : undefined;
    if (context.projectId && envProjectId && envProjectId !== context.projectId) {
      return {
        allowed: false,
        denyCode: "WORKSPACE_MISMATCH",
        reason: `Project mismatch: envelope is bound to project '${envProjectId}' but context requested '${context.projectId}'`,
        violations: [],
      };
    }

    const envAccountId =
      "accountId" in envelope && String(envelope.accountId) === envelope.accountId
        ? envelope.accountId
        : undefined;
    if (context.accountId && envAccountId && envAccountId !== context.accountId) {
      return {
        allowed: false,
        denyCode: "WORKSPACE_MISMATCH",
        reason: `Account mismatch: envelope is bound to account '${envAccountId}' but context requested '${context.accountId}'`,
        violations: [],
      };
    }

    // 4. Extract & Validate CapabilityManifest
    let requestedCapabilities: CapabilityManifest;
    let rawCapabilityObject: CanonicalJsonValue | CapabilityManifest | ToolManifest =
      manifestOrCapabilities;
    let toolVersion = context.toolVersion ?? "0.0.0";

    if (!manifestOrCapabilities || !(manifestOrCapabilities instanceof Object)) {
      return {
        allowed: false,
        denyCode: "INVALID_MANIFEST",
        reason: "Manifest or capability object is missing or not a valid object",
        violations: [],
      };
    }

    // SAFETY: Tag check confirms manifestOrCapabilities is an object.
    const recManifest = manifestOrCapabilities as CanonicalJsonRecord;

    if ("capabilities" in recManifest) {
      if (String(recManifest.id) === recManifest.id && recManifest.id !== context.toolId) {
        return {
          allowed: false,
          denyCode: "INVALID_CONTEXT",
          reason: `Tool ID mismatch: manifest is '${recManifest.id}' but context requested '${context.toolId}'`,
          violations: [],
        };
      }
      if (
        context.toolVersion &&
        String(recManifest.version) === recManifest.version &&
        recManifest.version !== context.toolVersion
      ) {
        return {
          allowed: false,
          denyCode: "INVALID_CONTEXT",
          reason: `Tool version mismatch / downgrade attempt: manifest is '${recManifest.version}' but context requested '${context.toolVersion}'`,
          violations: [],
        };
      }
      if (String(recManifest.version) === recManifest.version) {
        // SAFETY: String equality check confirms recManifest.version is a string primitive.
        toolVersion = recManifest.version as string;
      }

      // SAFETY: Checked as non-null property for capability manifest parsing.
      rawCapabilityObject = recManifest.capabilities as CanonicalJsonValue;
      const parsedCap = CapabilityManifestSchema.safeParse(recManifest.capabilities);
      if (!parsedCap.success) {
        return {
          allowed: false,
          denyCode: "INVALID_MANIFEST",
          reason: `Invalid capability manifest schema: ${parsedCap.error.message}`,
          violations: [],
        };
      }
      requestedCapabilities = parsedCap.data;
    } else {
      const parsedCap = CapabilityManifestSchema.safeParse(manifestOrCapabilities);
      if (!parsedCap.success) {
        return {
          allowed: false,
          denyCode: "INVALID_MANIFEST",
          reason: `Invalid capability manifest schema: ${parsedCap.error.message}`,
          violations: [],
        };
      }
      requestedCapabilities = parsedCap.data;
      rawCapabilityObject = manifestOrCapabilities;
    }

    // 5. Strict Unknown Capability Types Check
    if (this.strictUnknownCheck) {
      const unknownKeys = detectUnknownCapabilityKeys(rawCapabilityObject);
      if (unknownKeys.length > 0) {
        const violations: PolicyViolation[] = unknownKeys.map((key) => ({
          code: "UNKNOWN_CAPABILITY_TYPE",
          subsystem: "general",
          message: `Unknown or unauthorized capability property '${key}' detected in request`,
          requestedValue: key,
        }));

        return {
          allowed: false,
          denyCode: "UNKNOWN_CAPABILITY_TYPE",
          reason: `Manifest contains unknown capability types or unrecognized properties: ${unknownKeys.join(", ")}`,
          violations,
          details: { unknownKeys },
        };
      }
    }

    // 6. Check Cache
    const effectiveWorkspaceRoot = context.workspaceRoot ?? this.workspaceRoot;
    const cacheKey = this.computeCacheKey(
      envelope,
      requestedCapabilities,
      context,
      effectiveWorkspaceRoot,
    );

    if (this.enableCache) {
      const cachedResult = this.cache.get(cacheKey);
      if (cachedResult) {
        if (cachedResult.allowed) {
          // If cached grant is expired, recompute
          const grantVerification = verifyInvocationGrant(cachedResult.grant, {
            currentTimestamp: context.timestamp,
          });
          if (grantVerification.valid) {
            return {
              ...cachedResult,
              cached: true,
            };
          }
        } else {
          return {
            ...cachedResult,
            cached: true,
          };
        }
      }
    }

    // 7. Check if Envelope is Frozen
    if (envelope.isFrozen) {
      // Frozen envelope allows only exact matches or zero capabilities
      const intersection = intersectCapabilities(requestedCapabilities, envelope, {
        workspaceRoot: effectiveWorkspaceRoot,
      });

      if (intersection.expansionAttempted) {
        const primaryViolation = intersection.violations[0];
        const denyCode = primaryViolation
          ? violationToDenyCode(primaryViolation)
          : "ENVELOPE_FROZEN";
        const result: PolicyEvaluationResult = {
          allowed: false,
          denyCode: "ENVELOPE_FROZEN",
          reason: `Workspace envelope '${envelope.envelopeId}' is frozen and strictly prohibits capability modifications or expansions`,
          violations: intersection.violations,
          details: { envelopeId: envelope.envelopeId, primaryDenyCode: denyCode },
        };
        if (this.enableCache) this.cache.set(cacheKey, result);
        return result;
      }
    }

    // 8. Compute Capability Intersection
    const intersection = intersectCapabilities(requestedCapabilities, envelope, {
      workspaceRoot: effectiveWorkspaceRoot,
    });

    // 9. Enforce Policy Decision
    if (intersection.expansionAttempted && !this.allowEnvelopeExpansion) {
      const primaryViolation = intersection.violations[0];
      const denyCode = violationToDenyCode(primaryViolation);
      const result: PolicyEvaluationResult = {
        allowed: false,
        denyCode,
        reason: `Capability request rejected: ${primaryViolation.message}`,
        violations: intersection.violations,
        details: {
          violationCount: intersection.violations.length,
          primaryCode: primaryViolation.code,
        },
      };

      if (this.enableCache) this.cache.set(cacheKey, result);
      return result;
    }

    // 10. Generate Immutable Invocation Grant
    const now = context.timestamp ? new Date(context.timestamp).toISOString() : undefined;
    const grant = createInvocationGrant({
      invocationId: context.invocationId,
      toolId: context.toolId,
      toolVersion,
      workspaceId: context.workspaceId,
      envelopeId: envelope.envelopeId,
      policyVersion: this.policyVersion,
      capabilities: intersection.grantCapabilities,
      actor: context.actor ?? this.defaultActor,
      reason: context.reason ?? "Policy evaluation granted within workspace envelope",
      ttlMs: this.grantTtlMs,
      issuedAt: now,
    });

    const result: PolicyEvaluationResult = {
      allowed: true,
      grant,
      effectiveCapabilities: intersection.grantCapabilities,
    };

    if (this.enableCache) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Computes a deterministic cache key for policy evaluation.
   */
  private computeCacheKey(
    envelope: CapabilityEnvelope,
    requested: CapabilityManifest,
    context: InvocationContext,
    workspaceRoot: string,
  ): string {
    const envDigest = sha256(canonicalJson(envelope));
    const reqDigest = sha256(canonicalJson(requested));
    return `${context.workspaceId}:${context.toolId}:${context.toolVersion}:${reqDigest}:${envDigest}:${workspaceRoot}`;
  }
}
