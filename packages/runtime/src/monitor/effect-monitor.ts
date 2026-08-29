import { createHash, randomUUID } from "node:crypto";
import {
  type ConsequentialAction,
  type ObservedEffectProfile,
  type QualificationArtifactBundle,
  canonicalJson,
} from "@resin/contracts";
import { z } from "zod";
import {
  type BrokerAuditEmitter,
  type BrokerAuditEvent,
  defaultBrokerAuditEmitter,
  redactUrl,
  sanitizeAuditSummary,
} from "../brokers/audit.js";
import { type BrokerContext, type BrokerErrorCode, BrokerSecurityError } from "../brokers/base.js";
import {
  type VerifiedQualificationData,
  type VerifiedQualificationToken,
  createVerifiedQualificationToken,
  getVerifiedQualificationData,
  isVerifiedQualificationToken,
  registerVerifiedHostObject,
} from "./token.js";

export type { VerifiedQualificationToken };

/**
 * Zod schema for external action explicit authorization records.
 * Binds tool, version, actionType, target, payloadDigest, approver, and expiry.
 */
export const ExternalActionAuthorizationRecordSchema = z
  .object({
    toolId: z.string().optional(),
    tool: z.string().optional(),
    toolVersion: z.string().optional(),
    version: z.string().optional(),
    actionType: z.string().min(1, "actionType cannot be empty"),
    target: z.string().min(1, "target cannot be empty"),
    payloadDigest: z.string().min(1, "payloadDigest cannot be empty"),
    approver: z.string().min(1, "approver cannot be empty"),
    expiresAt: z.string().optional(),
    expiry: z.union([z.string(), z.number()]).optional(),
    keyId: z.string().min(1, "keyId cannot be empty"),
    signature: z.string().min(1, "signature cannot be empty"),
    algorithm: z.string().optional(),
  })
  .strict()
  .refine(
    (data) =>
      Boolean(data.toolId || data.tool) &&
      Boolean(data.toolVersion || data.version) &&
      (data.expiresAt !== undefined || data.expiry !== undefined) &&
      Boolean(data.keyId && data.keyId.trim().length > 0) &&
      Boolean(data.signature && data.signature.trim().length > 0),
    {
      message:
        "Authorization record must contain tool/toolId, version/toolVersion, expiresAt/expiry, nonempty keyId, and nonempty signature",
    },
  );

export type ExternalActionAuthorizationRecord = z.infer<
  typeof ExternalActionAuthorizationRecordSchema
>;

/**
 * Verifier function for validating cryptographic signatures on external action authorization records.
 */
export type ExternalActionAuthorizationVerifier = (params: {
  keyId: string;
  signature: string;
  signingPayload: string;
  record: ExternalActionAuthorizationRecord;
}) => boolean;

/**
 * Quarantine record details generated when boundary mismatch occurs.
 */
export interface EffectQuarantineRecord {
  quarantineId: string;
  toolId?: string;
  toolVersion?: string;
  invocationId?: string;
  reason: string;
  violationType:
    | "file_read"
    | "file_write"
    | "file_create"
    | "file_modify"
    | "file_delete"
    | "process_spawn"
    | "network_access"
    | "credential_access"
    | "external_action"
    | "resource_limit"
    | "source_drift"
    | "dependency_drift"
    | "effect_drift"
    | "policy_violation";
  effect?: Record<string, unknown>;
  timestamp: string;
  details?: Record<string, unknown>;
}

export type QuarantineRecord = EffectQuarantineRecord;

/**
 * Event payload emitted when source/dependency/effect drift triggers requalification.
 */
export interface RequalificationEvent {
  toolId: string;
  toolVersion?: string;
  reason: "source_drift" | "dependency_drift" | "effect_drift" | string;
  expectedDigest?: string;
  actualDigest?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Approved boundary definitions derived from signed qualification runs.
 */
export interface ApprovedEffectBoundaries {
  toolId?: string;
  toolVersion?: string;
  sourceDigest?: string;
  dependencies?:
    | Record<string, string>
    | readonly string[]
    | string[]
    | Readonly<Record<string, string>>;
  filesRead: {
    observation: "complete" | "unknown";
    paths: Set<string>;
  };
  filesCreated: {
    observation: "complete" | "unknown";
    paths: Set<string>;
  };
  filesModified: {
    observation: "complete" | "unknown";
    paths: Set<string>;
  };
  filesDeleted: {
    observation: "complete" | "unknown";
    paths: Set<string>;
  };
  processTree: {
    observation: "complete" | "unknown";
    spawnedProcesses: Set<string>;
  };
  network: {
    observation: "complete" | "unknown";
    destinations: Set<string>;
    methods: Set<string>;
  };
  environmentVariables: {
    observation: "complete" | "unknown";
    names: Set<string>;
  };
  credentials: {
    observation: "complete" | "unknown";
    names: Set<string>;
  };
  dependencyChanges: {
    observation: "complete" | "unknown";
    changes: Set<string>;
  };
  artifacts: {
    observation: "complete" | "unknown";
    items: Array<{ name: string; digest: string }>;
  };
  validationChecks: {
    observation: "complete" | "unknown";
    checks: Array<{ checkId: string; name: string; passed: boolean; details?: string }>;
  };
  resourceEnvelope?: {
    observation: "complete" | "unknown";
    maxMemoryBytes?: number;
    cpuTimeMs?: number;
    wallDurationMs?: number;
  };
  consequentialActions: {
    observation: "complete" | "unknown";
    actions: ConsequentialAction[];
  };
  externalAuthorizations?:
    | readonly ExternalActionAuthorizationRecord[]
    | ExternalActionAuthorizationRecord[];
}

export type EffectType =
  | "file_read"
  | "file_write"
  | "file_create"
  | "file_modify"
  | "file_delete"
  | "file_rename"
  | "process_spawn"
  | "network_request"
  | "credential_access"
  | "external_action";

export interface EffectRequest {
  type: EffectType;
  path?: string;
  oldPath?: string;
  newPath?: string;
  command?: string;
  args?: string[];
  url?: string;
  method?: string;
  name?: string;
  referenceId?: string;
  actionType?: string;
  target?: string;
  payload?: unknown;
  payloadDigest?: string;
  authorization?: ExternalActionAuthorizationRecord;
  isCreate?: boolean;
  isModify?: boolean;
  size?: number;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Serializes an EffectRequest to a standard Record<string, unknown>.
 */
export function effectRequestToRecord(effect: EffectRequest): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: effect.type,
  };
  if (effect.path !== undefined) record.path = effect.path;
  if (effect.oldPath !== undefined) record.oldPath = effect.oldPath;
  if (effect.newPath !== undefined) record.newPath = effect.newPath;
  if (effect.command !== undefined) record.command = effect.command;
  if (effect.args !== undefined) record.args = effect.args;
  if (effect.url !== undefined) record.url = effect.url;
  if (effect.method !== undefined) record.method = effect.method;
  if (effect.name !== undefined) record.name = effect.name;
  if (effect.referenceId !== undefined) record.referenceId = effect.referenceId;
  if (effect.actionType !== undefined) record.actionType = effect.actionType;
  if (effect.target !== undefined) record.target = effect.target;
  if (effect.payload !== undefined) record.payload = effect.payload;
  if (effect.payloadDigest !== undefined) record.payloadDigest = effect.payloadDigest;
  if (effect.authorization !== undefined) record.authorization = effect.authorization;
  if (effect.isCreate !== undefined) record.isCreate = effect.isCreate;
  if (effect.isModify !== undefined) record.isModify = effect.isModify;
  if (effect.size !== undefined) record.size = effect.size;
  if (effect.details !== undefined) record.details = effect.details;

  for (const [key, value] of Object.entries(effect)) {
    if (value !== undefined && !(key in record)) {
      record[key] = value;
    }
  }
  return record;
}

export interface EffectCheckResult {
  allowed: boolean;
  reason?: string;
  violationType?: QuarantineRecord["violationType"];
  requiresRequalification?: boolean;
  driftReason?: string;
  details?: Record<string, unknown>;
}

export interface InvocationRegistrationParams {
  invocationId: string;
  toolId: string;
  toolVersion?: string;
  token?: VerifiedQualificationToken;
  qualificationToken?: VerifiedQualificationToken;
  boundaries?:
    | VerifiedQualificationToken
    | ApprovedEffectBoundaries
    | QualificationArtifactBundle
    | ObservedEffectProfile
    | Record<string, unknown>;
  externalAuthorizations?:
    | readonly ExternalActionAuthorizationRecord[]
    | ExternalActionAuthorizationRecord[];
  authorizationVerifier?: ExternalActionAuthorizationVerifier;
  sourceDigest?: string;
  actualSourceDigest?: string;
  dependencies?:
    | Record<string, string>
    | readonly string[]
    | string[]
    | Readonly<Record<string, string>>;
  actualDependencies?:
    | Record<string, string>
    | readonly string[]
    | string[]
    | Readonly<Record<string, string>>;
  workspaceRoot?: string;
  scratchDir?: string;
}

export interface InvocationSessionState {
  invocationId: string;
  toolId: string;
  toolVersion?: string;
  boundaries: ApprovedEffectBoundaries;
  externalAuthorizations: ExternalActionAuthorizationRecord[];
  usedAuthorizations?: Set<string>;
  workspaceRoot?: string;
  scratchDir?: string;
  sourceDigest?: string;
  dependencies?:
    | Record<string, string>
    | readonly string[]
    | string[]
    | Readonly<Record<string, string>>;
  status: "active" | "revoked" | "completed" | "quarantined" | "drift_detected";
  revocationReason?: string;
  requalificationRequired: boolean;
  driftReasons: string[];
  startTime: number;
  observedEffects: {
    filesRead: Set<string>;
    filesCreated: Set<string>;
    filesModified: Set<string>;
    filesDeleted: Set<string>;
    spawnedProcesses: Set<string>;
    processTuples: Set<string>;
    networkDestinations: Set<string>;
    networkMethods: Set<string>;
    environmentVariables: Set<string>;
    credentials: Set<string>;
    dependencyChanges: Set<string>;
    artifacts: Array<{ name: string; digest: string }>;
    validationChecks: Array<{ checkId: string; name: string; passed: boolean; details?: string }>;
    consequentialActions: Array<{
      actionType: string;
      target: string;
      payloadDigest: string;
      approver?: string;
    }>;
    resourceEnvelope?: {
      maxMemoryBytes: number;
      cpuTimeMs: number;
      wallDurationMs: number;
    };
  };
}

export interface InvocationResultSummary {
  maxMemoryBytes?: number;
  cpuTimeMs?: number;
  wallDurationMs?: number;
  artifacts?: Array<{ name: string; digest: string }>;
  validationChecks?: Array<{ checkId: string; name: string; passed: boolean; details?: string }>;
  details?: Record<string, unknown>;
}

export interface InvocationValidationResult {
  success: boolean;
  violations?: string[];
  quarantineRecord?: QuarantineRecord;
  requalificationRequired?: boolean;
}

/**
 * Computes deterministic SHA-256 digest of arbitrary payload.
 */
export function computePayloadDigest(payload: unknown): string {
  if (typeof payload === "string") {
    return createHash("sha256").update(payload).digest("hex");
  }
  if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
    return createHash("sha256").update(payload).digest("hex");
  }
  const canonical = canonicalJson(payload ?? {});
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Normalizes file path relative to workspaceRoot or scratchDir.
 */
export function normalizeRelativePath(
  filePath: string,
  workspaceRoot?: string,
  scratchDir?: string,
): { relativePath: string; isScratch: boolean; isAbsolute: boolean } {
  let normalized = filePath.replace(/\\/g, "/").trim();

  // Check if inside scratchDir
  if (scratchDir) {
    const normScratch = scratchDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === normScratch || normalized.startsWith(`${normScratch}/`)) {
      const rel = normalized.slice(normScratch.length).replace(/^\/+/, "");
      return { relativePath: rel || ".", isScratch: true, isAbsolute: false };
    }
  }

  // Check if inside workspaceRoot
  if (workspaceRoot) {
    const normWorkspace = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === normWorkspace || normalized.startsWith(`${normWorkspace}/`)) {
      const rel = normalized.slice(normWorkspace.length).replace(/^\/+/, "");
      return { relativePath: rel || ".", isScratch: false, isAbsolute: false };
    }
  }

  // Remove leading ./
  normalized = normalized.replace(/^\.\//, "").replace(/\/+/g, "/");

  const isAbsolute = normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
  return { relativePath: normalized, isScratch: false, isAbsolute };
}

/**
 * Matches a process spawn against approved process boundary.
 */
export function matchProcessSpawn(
  command: string,
  args: string[],
  spawnedProcesses: Set<string>,
): boolean {
  if (spawnedProcesses.has(command)) return true;

  const baseCommand = command.replace(/\\/g, "/").split("/").pop() ?? command;
  if (spawnedProcesses.has(baseCommand)) return true;

  const fullTuple = [command, ...args].join(" ");
  if (spawnedProcesses.has(fullTuple)) return true;

  const baseTuple = [baseCommand, ...args].join(" ");
  if (spawnedProcesses.has(baseTuple)) return true;

  const jsonTuple = JSON.stringify([command, ...args]);
  if (spawnedProcesses.has(jsonTuple)) return true;

  const baseJsonTuple = JSON.stringify([baseCommand, ...args]);
  if (spawnedProcesses.has(baseJsonTuple)) return true;

  // Wildcard check
  for (const approved of spawnedProcesses) {
    if (approved.endsWith("*")) {
      const prefix = approved.slice(0, -1).trim();
      if (
        command.startsWith(prefix) ||
        baseCommand.startsWith(prefix) ||
        fullTuple.startsWith(prefix) ||
        baseTuple.startsWith(prefix)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Matches network destination (host/IP/URL) against approved destination boundaries.
 */
export function matchNetworkDestination(rawUrl: string, destinations: Set<string>): boolean {
  if (destinations.has(rawUrl)) return true;

  try {
    const parsed = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    const host = parsed.hostname.toLowerCase();
    const hostWithPort = parsed.host.toLowerCase();
    const origin = parsed.origin.toLowerCase();

    if (destinations.has(host) || destinations.has(hostWithPort) || destinations.has(origin)) {
      return true;
    }

    for (const dest of destinations) {
      const lowerDest = dest.toLowerCase();
      if (lowerDest === host || lowerDest === hostWithPort || lowerDest === origin) {
        return true;
      }
      if (lowerDest.startsWith("*.")) {
        const domain = lowerDest.slice(2);
        if (host === domain || host.endsWith(`.${domain}`)) {
          return true;
        }
      }
    }

    return false;
  } catch {
    return destinations.has(rawUrl);
  }
}

/**
 * Helper to determine if a network request matches a declared consequential action.
 */
export function matchesConsequentialNetworkAction(
  url: string,
  method: string,
  action: ConsequentialAction,
): boolean {
  if (!action.requiresExplicitAuthorization) {
    return false;
  }
  const normMethod = method.toUpperCase();
  const target = action.target.trim();
  const actType = action.actionType.trim().toUpperCase();

  // If actionType is specific HTTP method, verify it matches
  const httpMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
  if (httpMethods.has(actType) && actType !== normMethod) {
    return false;
  }

  // Check target match against URL
  if (target === "*" || target.toLowerCase() === "network" || target.toLowerCase() === "all") {
    return true;
  }

  if (target === url) {
    return true;
  }

  try {
    const uAct = new URL(
      action.target.startsWith("http") ? action.target : `https://${action.target}`,
    );
    const uUrl = new URL(url.startsWith("http") ? url : `https://${url}`);

    const actPath = uAct.pathname.replace(/\/+$/, "") || "/";
    const urlPath = uUrl.pathname.replace(/\/+$/, "") || "/";

    if (uAct.host.toLowerCase() !== uUrl.host.toLowerCase()) {
      if (uAct.hostname.startsWith("*.")) {
        const domain = uAct.hostname.slice(2).toLowerCase();
        if (
          uUrl.hostname.toLowerCase() !== domain &&
          !uUrl.hostname.toLowerCase().endsWith(`.${domain}`)
        ) {
          return false;
        }
      } else {
        return false;
      }
    }

    // If target has a specific path (not root), check exact or sub-path match
    if (actPath !== "/") {
      return urlPath === actPath || urlPath.startsWith(`${actPath}/`);
    }

    return true;
  } catch {
    return url === target || url.startsWith(`${target}/`);
  }
}

/**
 * Computes canonical signing payload for an external action authorization record.
 */
export function computeExternalActionAuthorizationSigningPayload(
  record:
    | Omit<ExternalActionAuthorizationRecord, "signature">
    | ExternalActionAuthorizationRecord
    | Readonly<ExternalActionAuthorizationRecord>,
): string {
  const toolId = record.toolId ?? record.tool ?? "";
  const toolVersion = record.toolVersion ?? record.version ?? "";
  const expiryRaw = record.expiresAt ?? record.expiry;
  const normalizedExpiry =
    typeof expiryRaw === "number" ? new Date(expiryRaw).toISOString() : String(expiryRaw ?? "");

  const payloadToSign = {
    actionType: record.actionType,
    approver: record.approver,
    expiresAt: normalizedExpiry,
    keyId: record.keyId,
    payloadDigest: record.payloadDigest.replace(/^sha256:/i, "").toLowerCase(),
    target: record.target,
    toolId,
    toolVersion,
  };

  return canonicalJson(payloadToSign);
}

export interface ValidateExternalActionAuthorizationOptions {
  now?: number;
  verifier?: ExternalActionAuthorizationVerifier;
}

/**
 * Validates an external action against explicit separate authorization record.
 * Requires nonempty signature/keyId and an injected trusted authorization verifier.
 */
export function validateExternalActionAuthorization(
  record: ExternalActionAuthorizationRecord | Readonly<ExternalActionAuthorizationRecord>,
  action: {
    toolId: string;
    toolVersion?: string;
    actionType: string;
    target: string;
    payload?: unknown;
    payloadDigest?: string;
    method?: string;
  },
  options: ValidateExternalActionAuthorizationOptions = {},
): { valid: boolean; reason?: string } {
  if (!record.keyId || typeof record.keyId !== "string" || record.keyId.trim().length === 0) {
    return {
      valid: false,
      reason: "Authorization record missing required nonempty keyId",
    };
  }

  if (
    !record.signature ||
    typeof record.signature !== "string" ||
    record.signature.trim().length === 0
  ) {
    return {
      valid: false,
      reason: "Authorization record missing required nonempty cryptographic signature",
    };
  }

  const toolId = record.toolId ?? record.tool ?? "";
  const toolVersion = record.toolVersion ?? record.version ?? "";
  const expiryRaw = record.expiresAt ?? record.expiry;
  const expiryTime =
    typeof expiryRaw === "number"
      ? expiryRaw
      : typeof expiryRaw === "string"
        ? Date.parse(expiryRaw)
        : Number.NaN;

  if (toolId && action.toolId && toolId !== action.toolId) {
    return {
      valid: false,
      reason: `Authorization record toolId '${toolId}' does not match action toolId '${action.toolId}'`,
    };
  }

  if (toolVersion && action.toolVersion && toolVersion !== action.toolVersion) {
    return {
      valid: false,
      reason: `Authorization record toolVersion '${toolVersion}' does not match action toolVersion '${action.toolVersion}'`,
    };
  }

  const normRecordAction = record.actionType.trim().toLowerCase();
  const normActionType = action.actionType.trim().toLowerCase();
  const normMethod = action.method?.trim().toLowerCase();

  if (
    normRecordAction === "*" ||
    normRecordAction === "external_action" ||
    normRecordAction === "network_request"
  ) {
    if (normActionType !== normRecordAction) {
      return {
        valid: false,
        reason: `Generic or wildcard actionType '${record.actionType}' is not permitted: authorization must explicitly name the specific action`,
      };
    }
  }

  const actionTypeMatches =
    normRecordAction === normActionType ||
    (normMethod !== undefined && normRecordAction === normMethod);

  if (!actionTypeMatches) {
    return {
      valid: false,
      reason: `Authorization record actionType '${record.actionType}' does not match action actionType '${action.actionType}'`,
    };
  }

  const normRecordTarget = record.target.trim();
  const normActionTarget = action.target.trim();

  if (
    normRecordTarget === "*" ||
    normRecordTarget.toLowerCase() === "network" ||
    normRecordTarget.toLowerCase() === "all"
  ) {
    return {
      valid: false,
      reason: `Generic or wildcard target '${record.target}' is not permitted: authorization must explicitly specify the exact target`,
    };
  }

  let targetMatches = normRecordTarget === normActionTarget;

  if (!targetMatches && normActionTarget.length > 0) {
    try {
      const uRec = new URL(
        normRecordTarget.startsWith("http") ? normRecordTarget : `https://${normRecordTarget}`,
      );
      const uAct = new URL(
        normActionTarget.startsWith("http") ? normActionTarget : `https://${normActionTarget}`,
      );

      const recHost = uRec.host.toLowerCase();
      const actHost = uAct.host.toLowerCase();
      const recPath = uRec.pathname.replace(/\/+$/, "") || "/";
      const actPath = uAct.pathname.replace(/\/+$/, "") || "/";

      if (recHost === actHost) {
        targetMatches = recPath === actPath;
      }
    } catch {
      targetMatches = normRecordTarget === normActionTarget;
    }
  }

  if (!targetMatches) {
    return {
      valid: false,
      reason: `Authorization record target '${record.target}' does not match action target '${action.target}'`,
    };
  }

  // Finding 11: Always canonical-hash the actual payload and reject any supplied payloadDigest mismatch
  if (action.payload !== undefined) {
    const computedPayloadDigest = computePayloadDigest(action.payload);
    const normalizedComputed = computedPayloadDigest.replace(/^sha256:/i, "").toLowerCase();

    if (
      action.payloadDigest !== undefined &&
      action.payloadDigest !== null &&
      String(action.payloadDigest).trim().length > 0
    ) {
      const normalizedSupplied = String(action.payloadDigest)
        .replace(/^sha256:/i, "")
        .toLowerCase();
      if (normalizedSupplied !== normalizedComputed) {
        return {
          valid: false,
          reason: `Supplied payloadDigest '${action.payloadDigest}' does not match computed payload digest '${computedPayloadDigest}' for actual payload`,
        };
      }
    }

    const normalizedRecord = record.payloadDigest.replace(/^sha256:/i, "").toLowerCase();
    if (normalizedRecord !== normalizedComputed) {
      return {
        valid: false,
        reason: `Authorization record payloadDigest '${record.payloadDigest}' does not match computed payload digest '${computedPayloadDigest}' for actual payload`,
      };
    }
  } else if (action.payloadDigest !== undefined && action.payloadDigest !== null) {
    const normalizedSupplied = String(action.payloadDigest)
      .replace(/^sha256:/i, "")
      .toLowerCase();
    const normalizedRecord = record.payloadDigest.replace(/^sha256:/i, "").toLowerCase();
    if (normalizedSupplied !== normalizedRecord) {
      return {
        valid: false,
        reason: `Authorization record payloadDigest '${record.payloadDigest}' does not match supplied payload digest '${action.payloadDigest}'`,
      };
    }
  }

  if (
    !record.approver ||
    typeof record.approver !== "string" ||
    record.approver.trim().length === 0
  ) {
    return {
      valid: false,
      reason: "Authorization record approver cannot be empty",
    };
  }

  const now = options.now ?? Date.now();
  if (Number.isNaN(expiryTime) || expiryTime <= now) {
    return {
      valid: false,
      reason: `Authorization record expired at ${new Date(expiryTime).toISOString()} (current: ${new Date(now).toISOString()})`,
    };
  }

  if (!options.verifier) {
    return {
      valid: false,
      reason: "No trusted authorization verifier injected for signature verification",
    };
  }

  try {
    const signingPayload = computeExternalActionAuthorizationSigningPayload(record);
    const isValid = options.verifier({
      keyId: record.keyId,
      signature: record.signature,
      signingPayload,
      record,
    });

    if (!isValid) {
      return {
        valid: false,
        reason: `Cryptographic signature verification failed for keyId '${record.keyId}'`,
      };
    }
  } catch (err) {
    return {
      valid: false,
      reason: `Signature verification threw an error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { valid: true };
}

/**
 * Derives approved boundary sets and limits exclusively from a verified qualification token's signed runs.
 * Rejects arbitrary profile/boundaries objects.
 */
export function deriveApprovedBoundaries(input: unknown): ApprovedEffectBoundaries {
  const verifiedData = getVerifiedQualificationData(input);
  if (!verifiedData) {
    throw new BrokerSecurityError(
      "POLICY_VIOLATION",
      "Rejected unverified effect profile or boundaries: boundaries must be derived exclusively from a verified qualification token created by ToolBundleLoader",
    );
  }

  const filesReadPaths = new Set<string>();
  let filesReadObs: "complete" | "unknown" = "complete";

  const filesCreatedPaths = new Set<string>();
  let filesCreatedObs: "complete" | "unknown" = "complete";

  const filesModifiedPaths = new Set<string>();
  let filesModifiedObs: "complete" | "unknown" = "complete";

  const filesDeletedPaths = new Set<string>();
  let filesDeletedObs: "complete" | "unknown" = "complete";

  const spawnedProcesses = new Set<string>();
  let processTreeObs: "complete" | "unknown" = "complete";

  const destinations = new Set<string>();
  const networkMethods = new Set<string>();
  let networkObs: "complete" | "unknown" = "complete";

  const envVarNames = new Set<string>();
  let envVarsObs: "complete" | "unknown" = "complete";

  const credentialNames = new Set<string>();
  let credentialsObs: "complete" | "unknown" = "complete";

  const dependencyChanges = new Set<string>();
  let depChangesObs: "complete" | "unknown" = "complete";

  const artifacts: Array<{ name: string; digest: string }> = [];
  let artifactsObs: "complete" | "unknown" = "complete";

  const validationChecks: Array<{
    checkId: string;
    name: string;
    passed: boolean;
    details?: string;
  }> = [];
  let checksObs: "complete" | "unknown" = "complete";

  let maxMemoryBytes = 0;
  let cpuTimeMs = 0;
  let wallDurationMs = 0;

  const consequentialActions: ConsequentialAction[] = [];
  let consequentialObs: "complete" | "unknown" = "complete";

  const profilesToProcess: ObservedEffectProfile[] = [];
  for (const run of verifiedData.runs ?? []) {
    const rawRun = run as Record<string, unknown>;
    const p = (rawRun.observedEffects ?? rawRun.observedEffectProfile) as
      | ObservedEffectProfile
      | undefined;
    if (p) profilesToProcess.push(p);
  }
  if (verifiedData.effectProfile) {
    profilesToProcess.push(verifiedData.effectProfile);
  }

  for (const profile of profilesToProcess) {
    if (profile.filesRead) {
      if (profile.filesRead.observation === "unknown") filesReadObs = "unknown";
      for (const p of profile.filesRead.paths ?? []) filesReadPaths.add(p);
    }
    if (profile.filesCreated) {
      if (profile.filesCreated.observation === "unknown") filesCreatedObs = "unknown";
      for (const p of profile.filesCreated.paths ?? []) filesCreatedPaths.add(p);
    }
    if (profile.filesModified) {
      if (profile.filesModified.observation === "unknown") filesModifiedObs = "unknown";
      for (const p of profile.filesModified.paths ?? []) filesModifiedPaths.add(p);
    }
    if (profile.filesDeleted) {
      if (profile.filesDeleted.observation === "unknown") filesDeletedObs = "unknown";
      for (const p of profile.filesDeleted.paths ?? []) filesDeletedPaths.add(p);
    }
    if (profile.processTree) {
      if (profile.processTree.observation === "unknown") processTreeObs = "unknown";
      for (const proc of profile.processTree.spawnedProcesses ?? []) spawnedProcesses.add(proc);
    }
    if (profile.network) {
      if (profile.network.observation === "unknown") networkObs = "unknown";
      for (const dest of profile.network.destinations ?? []) destinations.add(dest);
      for (const m of profile.network.methods ?? []) networkMethods.add(m.toUpperCase());
    }
    if (profile.environmentVariables) {
      if (profile.environmentVariables.observation === "unknown") envVarsObs = "unknown";
      for (const envName of profile.environmentVariables.names ?? []) envVarNames.add(envName);
    }
    if (profile.credentials) {
      if (profile.credentials.observation === "unknown") credentialsObs = "unknown";
      for (const cred of profile.credentials.names ?? []) credentialNames.add(cred);
    }
    if (profile.dependencyChanges) {
      if (profile.dependencyChanges.observation === "unknown") depChangesObs = "unknown";
      for (const chg of profile.dependencyChanges.changes ?? []) dependencyChanges.add(chg);
    }
    if (profile.artifacts) {
      if (profile.artifacts.observation === "unknown") artifactsObs = "unknown";
      for (const art of profile.artifacts.items ?? []) {
        if (!artifacts.some((a) => a.name === art.name && a.digest === art.digest)) {
          artifacts.push({ name: art.name, digest: art.digest });
        }
      }
    }
    if (profile.validationChecks) {
      if (profile.validationChecks.observation === "unknown") checksObs = "unknown";
      for (const chk of profile.validationChecks.checks ?? []) {
        if (!validationChecks.some((c) => c.checkId === chk.checkId)) {
          validationChecks.push({ ...chk });
        }
      }
    }
    if (profile.resourceEnvelope) {
      maxMemoryBytes = Math.max(maxMemoryBytes, profile.resourceEnvelope.maxMemoryBytes ?? 0);
      cpuTimeMs = Math.max(cpuTimeMs, profile.resourceEnvelope.cpuTimeMs ?? 0);
      wallDurationMs = Math.max(wallDurationMs, profile.resourceEnvelope.wallDurationMs ?? 0);
    }
    if (profile.consequentialActions) {
      if (profile.consequentialActions.observation === "unknown") consequentialObs = "unknown";
      for (const action of profile.consequentialActions.actions ?? []) {
        if (
          !consequentialActions.some(
            (a) => a.actionType === action.actionType && a.target === action.target,
          )
        ) {
          consequentialActions.push(action);
        }
      }
    }
  }

  const rawBundle = verifiedData.rawBundle as Record<string, unknown> | undefined;
  const externalAuths: ExternalActionAuthorizationRecord[] = [];
  if (Array.isArray(rawBundle?.externalAuthorizations)) {
    externalAuths.push(
      ...(rawBundle.externalAuthorizations as ExternalActionAuthorizationRecord[]),
    );
  }

  return {
    toolId: verifiedData.toolId,
    toolVersion: verifiedData.toolVersion,
    sourceDigest: verifiedData.sourceDigest,
    dependencies: verifiedData.dependencies,
    filesRead: {
      observation: filesReadObs,
      paths: filesReadPaths,
    },
    filesCreated: {
      observation: filesCreatedObs,
      paths: filesCreatedPaths,
    },
    filesModified: {
      observation: filesModifiedObs,
      paths: filesModifiedPaths,
    },
    filesDeleted: {
      observation: filesDeletedObs,
      paths: filesDeletedPaths,
    },
    processTree: {
      observation: processTreeObs,
      spawnedProcesses,
    },
    network: {
      observation: networkObs,
      destinations,
      methods: networkMethods,
    },
    environmentVariables: {
      observation: envVarsObs,
      names: envVarNames,
    },
    credentials: {
      observation: credentialsObs,
      names: credentialNames,
    },
    dependencyChanges: {
      observation: depChangesObs,
      changes: dependencyChanges,
    },
    artifacts: {
      observation: artifactsObs,
      items: artifacts,
    },
    validationChecks: {
      observation: checksObs,
      checks: validationChecks,
    },
    resourceEnvelope: {
      observation: "complete",
      maxMemoryBytes: maxMemoryBytes > 0 ? maxMemoryBytes : undefined,
      cpuTimeMs: cpuTimeMs > 0 ? cpuTimeMs : undefined,
      wallDurationMs: wallDurationMs > 0 ? wallDurationMs : undefined,
    },
    consequentialActions: {
      observation: consequentialObs,
      actions: consequentialActions,
    },
    externalAuthorizations: externalAuths.length > 0 ? externalAuths : undefined,
  };
}

/**
 * Creates empty approved boundaries default.
 */
export function createEmptyApprovedBoundaries(
  toolId?: string,
  toolVersion?: string,
): ApprovedEffectBoundaries {
  return {
    toolId,
    toolVersion,
    filesRead: { observation: "unknown", paths: new Set() },
    filesCreated: { observation: "unknown", paths: new Set() },
    filesModified: { observation: "unknown", paths: new Set() },
    filesDeleted: { observation: "unknown", paths: new Set() },
    processTree: { observation: "unknown", spawnedProcesses: new Set() },
    network: { observation: "unknown", destinations: new Set(), methods: new Set() },
    environmentVariables: { observation: "unknown", names: new Set() },
    credentials: { observation: "unknown", names: new Set() },
    dependencyChanges: { observation: "unknown", changes: new Set() },
    artifacts: { observation: "unknown", items: [] },
    validationChecks: { observation: "unknown", checks: [] },
    resourceEnvelope: { observation: "unknown" },
    consequentialActions: { observation: "unknown", actions: [] },
  };
}

export interface EffectMonitorOptions {
  auditEmitter?: BrokerAuditEmitter;
  onQuarantine?: (record: QuarantineRecord) => void | Promise<void>;
  onRequalificationNeeded?: (event: RequalificationEvent) => void | Promise<void>;
  token?: VerifiedQualificationToken;
  qualificationToken?: VerifiedQualificationToken;
  defaultBoundaries?: VerifiedQualificationToken | ApprovedEffectBoundaries;
  allowUnverifiedBoundaries?: boolean;
  development?: boolean;
  strict?: boolean;
  authorizationVerifier?: ExternalActionAuthorizationVerifier;
}

/**
 * Per-invocation effect recorder and comparator deriving approved boundaries
 * from signed qualification runs, checking consequential side-effects, revoking
 * non-compliant invocations, emitting immutable audit trails, and managing quarantine.
 */
export class EffectMonitor {
  private readonly auditEmitter: BrokerAuditEmitter;
  private readonly onQuarantine?: (record: QuarantineRecord) => void | Promise<void>;
  private readonly onRequalificationNeeded?: (event: RequalificationEvent) => void | Promise<void>;
  private readonly sessions = new Map<string, InvocationSessionState>();
  private readonly defaultBoundaries?: ApprovedEffectBoundaries;
  private readonly strict: boolean;
  readonly authorizationVerifier?: ExternalActionAuthorizationVerifier;

  constructor(options: EffectMonitorOptions = {}) {
    this.auditEmitter = options.auditEmitter ?? defaultBrokerAuditEmitter;
    this.onQuarantine = options.onQuarantine;
    this.onRequalificationNeeded = options.onRequalificationNeeded;
    this.authorizationVerifier = options.authorizationVerifier;
    const rawDefaults = options.defaultBoundaries ?? options.token ?? options.qualificationToken;
    if (rawDefaults !== undefined && rawDefaults !== null) {
      if (isVerifiedQualificationToken(rawDefaults)) {
        this.defaultBoundaries = deriveApprovedBoundaries(rawDefaults);
      } else if (options.allowUnverifiedBoundaries || options.development) {
        this.defaultBoundaries = rawDefaults as ApprovedEffectBoundaries;
      } else {
        throw new BrokerSecurityError(
          "POLICY_VIOLATION",
          "Arbitrary or fabricated default effect boundaries are rejected: defaultBoundaries must be derived exclusively from a verified qualification token created by ToolBundleLoader",
        );
      }
    }
    this.strict = options.strict ?? !(options.development || options.allowUnverifiedBoundaries);
  }
  registerInvocation(params: InvocationRegistrationParams): InvocationSessionState {
    const rawBoundaries = params.token ?? params.qualificationToken ?? params.boundaries;
    let boundaries: ApprovedEffectBoundaries;

    if (rawBoundaries !== undefined) {
      if (!isVerifiedQualificationToken(rawBoundaries)) {
        throw new BrokerSecurityError(
          "POLICY_VIOLATION",
          "Arbitrary or fabricated effect boundaries/profiles are rejected; boundaries must be derived exclusively from a verified qualification token created by ToolBundleLoader",
        );
      }
      boundaries = deriveApprovedBoundaries(rawBoundaries);
    } else if (this.defaultBoundaries) {
      boundaries = this.defaultBoundaries;
    } else if (this.strict) {
      throw new BrokerSecurityError(
        "POLICY_VIOLATION",
        "Registration rejected: verified qualification token is required for invocation registration in production",
      );
    } else {
      boundaries = createEmptyApprovedBoundaries(params.toolId, params.toolVersion);
    }

    if (boundaries.toolId && params.toolId && boundaries.toolId !== params.toolId) {
      throw new BrokerSecurityError(
        "POLICY_VIOLATION",
        `Tool identity mismatch: supplied toolId '${params.toolId}' does not match verified qualification token toolId '${boundaries.toolId}'`,
      );
    }
    if (
      boundaries.toolVersion &&
      params.toolVersion &&
      boundaries.toolVersion !== params.toolVersion
    ) {
      throw new BrokerSecurityError(
        "POLICY_VIOLATION",
        `Tool version mismatch: supplied toolVersion '${params.toolVersion}' does not match verified qualification token toolVersion '${boundaries.toolVersion}'`,
      );
    }
    if (params.toolId && !boundaries.toolId) boundaries.toolId = params.toolId;
    if (params.toolVersion && !boundaries.toolVersion) boundaries.toolVersion = params.toolVersion;

    const validatedExternalAuths: ExternalActionAuthorizationRecord[] = [];
    const rawExternalAuths = [
      ...(boundaries.externalAuthorizations ?? []),
      ...(params.externalAuthorizations ?? []),
    ];

    for (const record of rawExternalAuths) {
      const parseResult = ExternalActionAuthorizationRecordSchema.safeParse(record);
      if (!parseResult.success) {
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Invalid external action authorization record: ${parseResult.error.message}`,
        );
      }

      const validatedRecord = parseResult.data;
      const effectiveVerifier = params.authorizationVerifier ?? this.authorizationVerifier;

      if (!effectiveVerifier) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_EFFECT",
          `External authorization record for action '${validatedRecord.actionType}' rejected: trusted authorization verifier is required before registration/use`,
        );
      }

      const validation = validateExternalActionAuthorization(
        validatedRecord,
        {
          toolId: params.toolId,
          toolVersion: params.toolVersion ?? boundaries.toolVersion,
          actionType: validatedRecord.actionType,
          target: validatedRecord.target,
          payloadDigest: validatedRecord.payloadDigest,
        },
        { verifier: effectiveVerifier },
      );

      if (!validation.valid) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_EFFECT",
          `External authorization record for action '${validatedRecord.actionType}' failed verification: ${validation.reason}`,
        );
      }

      validatedExternalAuths.push(validatedRecord);
    }

    const session: InvocationSessionState = {
      invocationId: params.invocationId,
      toolId: params.toolId,
      toolVersion: params.toolVersion ?? boundaries.toolVersion,
      boundaries,
      externalAuthorizations: validatedExternalAuths,
      usedAuthorizations: new Set(),
      workspaceRoot: params.workspaceRoot,
      scratchDir: params.scratchDir,
      sourceDigest: params.sourceDigest ?? boundaries.sourceDigest,
      dependencies: params.dependencies ?? boundaries.dependencies,
      status: "active",
      requalificationRequired: false,
      driftReasons: [],
      startTime: Date.now(),
      observedEffects: {
        filesRead: new Set(),
        filesCreated: new Set(),
        filesModified: new Set(),
        filesDeleted: new Set(),
        spawnedProcesses: new Set(),
        processTuples: new Set(),
        networkDestinations: new Set(),
        networkMethods: new Set(),
        environmentVariables: new Set(),
        credentials: new Set(),
        dependencyChanges: new Set(),
        artifacts: [],
        validationChecks: [],
        consequentialActions: [],
        resourceEnvelope: {
          maxMemoryBytes: 0,
          cpuTimeMs: 0,
          wallDurationMs: 0,
        },
      },
    };

    // Check Source Drift
    if (
      params.actualSourceDigest &&
      session.sourceDigest &&
      params.actualSourceDigest !== session.sourceDigest
    ) {
      session.requalificationRequired = true;
      session.status = "drift_detected";
      session.driftReasons.push("source_drift");
      this.quarantine({
        quarantineId: `quarantine_${Date.now()}_${randomUUID().slice(0, 8)}`,
        toolId: session.toolId,
        toolVersion: session.toolVersion,
        invocationId: session.invocationId,
        reason: `Source code digest drift detected: expected ${session.sourceDigest}, actual ${params.actualSourceDigest}`,
        violationType: "source_drift",
        timestamp: new Date().toISOString(),
        details: {
          invocationId: session.invocationId,
          expectedSourceDigest: session.sourceDigest,
          actualSourceDigest: params.actualSourceDigest,
        },
      });
      this.auditEmitter.emitAudit({
        service: "monitor",
        action: "register_invocation",
        invocationId: session.invocationId,
        toolId: session.toolId,
        toolVersion: session.toolVersion,
        status: "denied",
        summary: {
          service: "monitor",
          action: "register_invocation",
          violationType: "source_drift",
          reason: `Source code digest drift detected: expected ${session.sourceDigest}, actual ${params.actualSourceDigest}`,
        },
        error: {
          code: "DRIFT_DETECTED",
          message: "Source code digest drift detected",
          details: { violationType: "source_drift" },
        },
      });
      this.triggerRequalification({
        toolId: session.toolId,
        toolVersion: session.toolVersion,
        reason: "source_drift",
        expectedDigest: session.sourceDigest,
        actualDigest: params.actualSourceDigest,
        timestamp: new Date().toISOString(),
        details: {
          invocationId: session.invocationId,
          expectedSourceDigest: session.sourceDigest,
          actualSourceDigest: params.actualSourceDigest,
        },
      });
    }

    // Check Dependency Drift
    if (params.actualDependencies && session.dependencies) {
      const depDrift = this.checkDependencyDrift(session.dependencies, params.actualDependencies);
      if (depDrift) {
        session.requalificationRequired = true;
        session.status = "drift_detected";
        session.driftReasons.push("dependency_drift");
        this.quarantine({
          quarantineId: `quarantine_${Date.now()}_${randomUUID().slice(0, 8)}`,
          toolId: session.toolId,
          toolVersion: session.toolVersion,
          invocationId: session.invocationId,
          reason: `Dependency drift detected`,
          violationType: "dependency_drift",
          timestamp: new Date().toISOString(),
          details: {
            invocationId: session.invocationId,
            drift: depDrift,
          },
        });
        this.auditEmitter.emitAudit({
          service: "monitor",
          action: "register_invocation",
          invocationId: session.invocationId,
          toolId: session.toolId,
          toolVersion: session.toolVersion,
          status: "denied",
          summary: {
            service: "monitor",
            action: "register_invocation",
            violationType: "dependency_drift",
            reason: "Dependency drift detected",
          },
          error: {
            code: "DRIFT_DETECTED",
            message: "Dependency drift detected",
            details: { violationType: "dependency_drift" },
          },
        });
        this.triggerRequalification({
          toolId: session.toolId,
          toolVersion: session.toolVersion,
          reason: "dependency_drift",
          timestamp: new Date().toISOString(),
          details: {
            invocationId: session.invocationId,
            drift: depDrift,
          },
        });
      }
    }

    this.sessions.set(params.invocationId, session);
    return session;
  }

  /**
   * Unregisters an invocation session.
   */
  unregisterInvocation(invocationId: string): void {
    this.sessions.delete(invocationId);
  }

  /**
   * Gets an active invocation session.
   */
  getSession(invocationId: string): InvocationSessionState | undefined {
    return this.sessions.get(invocationId);
  }

  /**
   * Returns true if an invocation has been revoked or quarantined or has detected drift.
   */
  isInvocationRevoked(invocationId: string): boolean {
    const session = this.sessions.get(invocationId);
    return (
      session?.status === "revoked" ||
      session?.status === "quarantined" ||
      session?.status === "drift_detected"
    );
  }
  /**
   * Evaluates an effect request before it takes place.
   * If mismatched, revokes the invocation, emits an immutable audit event,
   * calls quarantine callback, and returns a policy violation.
   */
  checkBeforeEffect(
    invocationId: string,
    effect: EffectRequest,
    context?: BrokerContext,
  ): EffectCheckResult {
    const session = invocationId ? this.sessions.get(invocationId) : undefined;

    if (
      session &&
      (session.status === "revoked" ||
        session.status === "quarantined" ||
        session.status === "drift_detected")
    ) {
      const reason =
        session.status === "drift_detected"
          ? `Invocation '${invocationId}' has detected drift (${session.driftReasons.join(", ")}): execution is prohibited until requalified`
          : `Invocation '${invocationId}' has been revoked: ${session.revocationReason ?? "Policy violation"}`;
      return {
        allowed: false,
        reason,
        violationType:
          session.status === "drift_detected"
            ? session.driftReasons.includes("source_drift")
              ? "source_drift"
              : "dependency_drift"
            : "policy_violation",
        requiresRequalification: true,
      };
    }
    const boundaries = session?.boundaries ?? this.defaultBoundaries;
    if (!boundaries) {
      if (this.strict) {
        const reason = `Unregistered invocation '${invocationId || "unregistered"}': brokered effects are rejected without a verified registered qualification boundary`;
        return {
          allowed: false,
          reason,
          violationType: "policy_violation",
        };
      }
      return { allowed: true };
    }

    const workspaceRoot = session?.workspaceRoot ?? context?.workspaceRoot;
    const scratchDir = session?.scratchDir ?? context?.scratchDir;

    let checkResult: EffectCheckResult = { allowed: true };

    switch (effect.type) {
      case "file_read": {
        const rawPath = effect.path ?? "";
        const { relativePath, isScratch } = normalizeRelativePath(
          rawPath,
          workspaceRoot,
          scratchDir,
        );

        if (!isScratch && boundaries.filesRead.observation === "complete") {
          if (
            !boundaries.filesRead.paths.has(relativePath) &&
            !boundaries.filesRead.paths.has(rawPath)
          ) {
            checkResult = {
              allowed: false,
              reason: `Unobserved filesystem read: '${relativePath}' is not in approved boundaries`,
              violationType: "file_read",
            };
          }
        }
        break;
      }

      case "file_write":
      case "file_create":
      case "file_modify": {
        const rawPath = effect.path ?? "";
        const { relativePath, isScratch } = normalizeRelativePath(
          rawPath,
          workspaceRoot,
          scratchDir,
        );

        if (!isScratch) {
          const isCreate = effect.type === "file_create" || effect.isCreate;
          const isModify = effect.type === "file_modify" || effect.isModify;

          if (isCreate && boundaries.filesCreated.observation === "complete") {
            if (
              !boundaries.filesCreated.paths.has(relativePath) &&
              !boundaries.filesCreated.paths.has(rawPath)
            ) {
              checkResult = {
                allowed: false,
                reason: `Unobserved filesystem file creation: '${relativePath}' is not in approved boundaries`,
                violationType: "file_create",
              };
            }
          } else if (isModify && boundaries.filesModified.observation === "complete") {
            if (
              !boundaries.filesModified.paths.has(relativePath) &&
              !boundaries.filesModified.paths.has(rawPath)
            ) {
              checkResult = {
                allowed: false,
                reason: `Unobserved filesystem file modification: '${relativePath}' is not in approved boundaries`,
                violationType: "file_modify",
              };
            }
          } else if (
            boundaries.filesCreated.observation === "complete" &&
            boundaries.filesModified.observation === "complete"
          ) {
            const inCreated =
              boundaries.filesCreated.paths.has(relativePath) ||
              boundaries.filesCreated.paths.has(rawPath);
            const inModified =
              boundaries.filesModified.paths.has(relativePath) ||
              boundaries.filesModified.paths.has(rawPath);

            if (!inCreated && !inModified) {
              checkResult = {
                allowed: false,
                reason: `Unobserved filesystem write: '${relativePath}' is not in approved filesCreated or filesModified boundaries`,
                violationType: "file_write",
              };
            }
          }
        }
        break;
      }

      case "file_delete": {
        const rawPath = effect.path ?? "";
        const { relativePath, isScratch } = normalizeRelativePath(
          rawPath,
          workspaceRoot,
          scratchDir,
        );

        if (!isScratch && boundaries.filesDeleted.observation === "complete") {
          if (
            !boundaries.filesDeleted.paths.has(relativePath) &&
            !boundaries.filesDeleted.paths.has(rawPath)
          ) {
            checkResult = {
              allowed: false,
              reason: `Unobserved filesystem deletion: '${relativePath}' is not in approved filesDeleted boundaries`,
              violationType: "file_delete",
            };
          }
        }
        break;
      }

      case "file_rename": {
        const oldNorm = normalizeRelativePath(effect.oldPath ?? "", workspaceRoot, scratchDir);
        const newNorm = normalizeRelativePath(effect.newPath ?? "", workspaceRoot, scratchDir);

        if (!oldNorm.isScratch && boundaries.filesDeleted.observation === "complete") {
          if (
            !boundaries.filesDeleted.paths.has(oldNorm.relativePath) &&
            !boundaries.filesModified.paths.has(oldNorm.relativePath)
          ) {
            checkResult = {
              allowed: false,
              reason: `Unobserved filesystem rename source: '${oldNorm.relativePath}' is not approved for deletion/modification`,
              violationType: "file_modify",
            };
          }
        }

        if (
          checkResult.allowed &&
          !newNorm.isScratch &&
          boundaries.filesCreated.observation === "complete"
        ) {
          if (
            !boundaries.filesCreated.paths.has(newNorm.relativePath) &&
            !boundaries.filesModified.paths.has(newNorm.relativePath)
          ) {
            checkResult = {
              allowed: false,
              reason: `Unobserved filesystem rename destination: '${newNorm.relativePath}' is not approved for creation/modification`,
              violationType: "file_create",
            };
          }
        }
        break;
      }

      case "process_spawn": {
        const cmd = effect.command ?? "";
        const args = effect.args ?? [];

        if (boundaries.processTree.observation === "complete") {
          const matched = matchProcessSpawn(cmd, args, boundaries.processTree.spawnedProcesses);
          if (!matched) {
            checkResult = {
              allowed: false,
              reason: `Unobserved process execution: command '${cmd}' with args [${args.join(", ")}] is not in approved processTree`,
              violationType: "process_spawn",
            };
          }
        }
        break;
      }

      case "network_request": {
        const url = effect.url ?? "";
        const sanitizedUrl = redactUrl(url);
        const method = (effect.method ?? "GET").toUpperCase();

        if (boundaries.network.observation === "complete") {
          const destMatched = matchNetworkDestination(url, boundaries.network.destinations);
          const methodMatched =
            boundaries.network.methods.size === 0 || boundaries.network.methods.has(method);

          if (!destMatched) {
            checkResult = {
              allowed: false,
              reason: `Unobserved network destination: '${sanitizedUrl}' is not in approved network destinations`,
              violationType: "network_access",
            };
          } else if (!methodMatched) {
            checkResult = {
              allowed: false,
              reason: `Unobserved network HTTP method: '${method}' for '${sanitizedUrl}' is not in approved network methods`,
              violationType: "network_access",
            };
          }
        }

        // Finding 8: Route consequential network targets through external action authorization verifier
        if (checkResult.allowed && boundaries.consequentialActions.actions.length > 0) {
          const matchingConsequentialActions = boundaries.consequentialActions.actions.filter(
            (act) => matchesConsequentialNetworkAction(url, method, act),
          );

          if (matchingConsequentialActions.length > 0) {
            const toolId = session?.toolId ?? context?.toolId ?? boundaries.toolId ?? "";
            const toolVersion =
              session?.toolVersion ?? context?.toolVersion ?? boundaries.toolVersion ?? "";
            const matchedConsequential = matchingConsequentialActions[0];

            const authCandidates: ExternalActionAuthorizationRecord[] = [];
            if (effect.authorization) {
              authCandidates.push(effect.authorization);
            }
            if (session?.externalAuthorizations) {
              authCandidates.push(...session.externalAuthorizations);
            }
            if (boundaries.externalAuthorizations) {
              authCandidates.push(...boundaries.externalAuthorizations);
            }

            let isAuthorized = false;
            let lastFailureReason = "No matching authorization record found";
            let consumedKey: string | null = null;

            for (const candidate of authCandidates) {
              const effectiveVerifier = this.authorizationVerifier;
              if (!effectiveVerifier) {
                lastFailureReason =
                  "No trusted authorization verifier injected for consequential network authorization";
                continue;
              }

              const authKey = `${candidate.keyId}:${candidate.signature}:${candidate.payloadDigest}`;
              if (session?.usedAuthorizations?.has(authKey)) {
                lastFailureReason =
                  "Authorization record has already been consumed (single-use authorization)";
                continue;
              }

              const parseResult = ExternalActionAuthorizationRecordSchema.safeParse(candidate);
              if (!parseResult.success) {
                lastFailureReason = `Invalid external authorization record: ${parseResult.error.message}`;
                continue;
              }

              const authValidation = validateExternalActionAuthorization(
                parseResult.data,
                {
                  toolId,
                  toolVersion,
                  actionType: matchedConsequential.actionType,
                  target: url,
                  payload: effect.payload ?? effect.body ?? "",
                  payloadDigest: effect.payloadDigest,
                  method,
                },
                {
                  now: Date.now(),
                  verifier: effectiveVerifier,
                },
              );

              if (authValidation.valid) {
                isAuthorized = true;
                consumedKey = authKey;
                break;
              }
              lastFailureReason = authValidation.reason ?? lastFailureReason;
            }

            if (!isAuthorized) {
              checkResult = {
                allowed: false,
                reason: `Consequential network request to '${sanitizedUrl}' [${method}] denied: ${lastFailureReason}`,
                violationType: "external_action",
              };
            } else if (session && consumedKey) {
              session.usedAuthorizations = session.usedAuthorizations ?? new Set();
              session.usedAuthorizations.add(consumedKey);
            }
          }
        }
        break;
      }

      case "credential_access": {
        const credName = effect.name ?? effect.referenceId ?? "";

        if (boundaries.credentials.observation === "complete") {
          if (!boundaries.credentials.names.has(credName)) {
            checkResult = {
              allowed: false,
              reason: `Unobserved credential access: '${credName}' is not in approved credentials`,
              violationType: "credential_access",
            };
          }
        }
        break;
      }

      case "external_action": {
        const actionType = effect.actionType ?? "";
        const target = effect.target ?? "";
        const toolId = session?.toolId ?? context?.toolId ?? boundaries.toolId ?? "";
        const toolVersion =
          session?.toolVersion ?? context?.toolVersion ?? boundaries.toolVersion ?? "";

        // Consequential action check
        const authCandidates: ExternalActionAuthorizationRecord[] = [];
        if (effect.authorization) {
          authCandidates.push(effect.authorization);
        }
        if (session?.externalAuthorizations) {
          authCandidates.push(...session.externalAuthorizations);
        }
        if (boundaries.externalAuthorizations) {
          authCandidates.push(...boundaries.externalAuthorizations);
        }
        let isAuthorized = false;
        let lastFailureReason = "No matching authorization record found";
        let consumedKey: string | null = null;

        for (const candidate of authCandidates) {
          const effectiveVerifier = this.authorizationVerifier;
          if (!effectiveVerifier) {
            lastFailureReason =
              "No trusted authorization verifier injected for external action authorization";
            continue;
          }

          const authKey = `${candidate.keyId}:${candidate.signature}:${candidate.payloadDigest}`;
          if (session?.usedAuthorizations?.has(authKey)) {
            lastFailureReason =
              "Authorization record has already been consumed (single-use authorization)";
            continue;
          }

          const parseResult = ExternalActionAuthorizationRecordSchema.safeParse(candidate);
          if (!parseResult.success) {
            lastFailureReason = `Invalid external authorization record: ${parseResult.error.message}`;
            continue;
          }

          const authValidation = validateExternalActionAuthorization(
            parseResult.data,
            {
              toolId,
              toolVersion,
              actionType,
              target,
              payload: effect.payload ?? effect.body ?? "",
              payloadDigest: effect.payloadDigest,
            },
            {
              now: Date.now(),
              verifier: effectiveVerifier,
            },
          );

          if (authValidation.valid) {
            isAuthorized = true;
            consumedKey = authKey;
            break;
          }
          lastFailureReason = authValidation.reason ?? lastFailureReason;
        }

        if (!isAuthorized) {
          checkResult = {
            allowed: false,
            reason: `External action '${actionType}' targeting '${target}' denied: ${lastFailureReason}`,
            violationType: "external_action",
          };
        } else if (session && consumedKey) {
          session.usedAuthorizations = session.usedAuthorizations ?? new Set();
          session.usedAuthorizations.add(consumedKey);
        }
        break;
      }
    }

    if (!checkResult.allowed) {
      // Revoke invocation session
      this.revokeInvocation(invocationId, checkResult.reason!, {
        violationType: checkResult.violationType,
        effect: sanitizeAuditSummary(effectRequestToRecord(effect)),
      });

      // Emit immutable denied audit event
      const auditEvent: Omit<BrokerAuditEvent, "eventId" | "timestamp"> = {
        service: "monitor",
        action: effect.type,
        invocationId,
        toolId: session?.toolId ?? context?.toolId,
        toolVersion: session?.toolVersion ?? context?.toolVersion,
        status: "denied",
        error: {
          code: "POLICY_VIOLATION",
          message: checkResult.reason!,
          details: { violationType: checkResult.violationType },
        },
        summary: {
          service: "monitor",
          action: effect.type,
          violationType: checkResult.violationType,
          reason: checkResult.reason,
        },
        effect: sanitizeAuditSummary(effectRequestToRecord(effect)),
      };
      this.auditEmitter.emitAudit(auditEvent);

      // Trigger Quarantine Callback
      const quarantineRecord: QuarantineRecord = {
        quarantineId: `quarantine_${Date.now()}_${randomUUID().slice(0, 8)}`,
        toolId: session?.toolId ?? context?.toolId,
        toolVersion: session?.toolVersion ?? context?.toolVersion,
        invocationId,
        reason: checkResult.reason!,
        violationType: checkResult.violationType ?? "policy_violation",
        effect: sanitizeAuditSummary(effectRequestToRecord(effect)),
        timestamp: new Date().toISOString(),
        details: checkResult.details,
      };
      this.quarantine(quarantineRecord);

      // Trigger Requalification if effect drift occurred
      this.triggerRequalification({
        toolId: session?.toolId ?? context?.toolId ?? "unknown",
        toolVersion: session?.toolVersion ?? context?.toolVersion,
        reason: "effect_drift",
        timestamp: new Date().toISOString(),
        details: {
          invocationId,
          violationType: checkResult.violationType,
          reason: checkResult.reason,
        },
      });
    }

    return checkResult;
  }

  /**
   * Records an approved observed effect for an invocation.
   */
  recordObservedEffect(invocationId: string, effect: EffectRequest, context?: BrokerContext): void {
    const session = this.sessions.get(invocationId);
    if (!session) return;

    const workspaceRoot = session.workspaceRoot ?? context?.workspaceRoot;
    const scratchDir = session.scratchDir ?? context?.scratchDir;

    switch (effect.type) {
      case "file_read": {
        const { relativePath } = normalizeRelativePath(
          effect.path ?? "",
          workspaceRoot,
          scratchDir,
        );
        session.observedEffects.filesRead.add(relativePath);
        break;
      }
      case "file_write":
      case "file_create": {
        const { relativePath } = normalizeRelativePath(
          effect.path ?? "",
          workspaceRoot,
          scratchDir,
        );
        session.observedEffects.filesCreated.add(relativePath);
        break;
      }
      case "file_modify": {
        const { relativePath } = normalizeRelativePath(
          effect.path ?? "",
          workspaceRoot,
          scratchDir,
        );
        session.observedEffects.filesModified.add(relativePath);
        break;
      }
      case "file_delete": {
        const { relativePath } = normalizeRelativePath(
          effect.path ?? "",
          workspaceRoot,
          scratchDir,
        );
        session.observedEffects.filesDeleted.add(relativePath);
        break;
      }
      case "file_rename": {
        const oldNorm = normalizeRelativePath(effect.oldPath ?? "", workspaceRoot, scratchDir);
        const newNorm = normalizeRelativePath(effect.newPath ?? "", workspaceRoot, scratchDir);
        session.observedEffects.filesDeleted.add(oldNorm.relativePath);
        session.observedEffects.filesCreated.add(newNorm.relativePath);
        break;
      }
      case "process_spawn": {
        const cmd = effect.command ?? "";
        session.observedEffects.spawnedProcesses.add(cmd);
        if (effect.args && effect.args.length > 0) {
          session.observedEffects.processTuples.add([cmd, ...effect.args].join(" "));
        }
        break;
      }
      case "network_request": {
        const url = effect.url ?? "";
        const method = (effect.method ?? "GET").toUpperCase();
        try {
          const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
          session.observedEffects.networkDestinations.add(parsed.hostname);
        } catch {
          session.observedEffects.networkDestinations.add(url);
        }
        session.observedEffects.networkMethods.add(method);

        // If this was a consequential network action, also record under consequentialActions
        const matchingConsequentialActions = session.boundaries.consequentialActions.actions.filter(
          (act) => matchesConsequentialNetworkAction(url, method, act),
        );
        if (matchingConsequentialActions.length > 0) {
          session.observedEffects.consequentialActions.push({
            actionType: matchingConsequentialActions[0].actionType,
            target: url,
            payloadDigest:
              effect.payloadDigest ?? computePayloadDigest(effect.payload ?? effect.body ?? ""),
            approver: effect.authorization?.approver,
          });
        }
        break;
      }
      case "credential_access": {
        const credName = effect.name ?? effect.referenceId ?? "";
        if (credName) {
          session.observedEffects.credentials.add(credName);
        }
        break;
      }
      case "external_action": {
        session.observedEffects.consequentialActions.push({
          actionType: effect.actionType ?? "",
          target: effect.target ?? "",
          payloadDigest: effect.payloadDigest ?? computePayloadDigest(effect.payload),
          approver: effect.authorization?.approver,
        });
        break;
      }
    }
  }

  /**
   * Evaluates post-execution invocation results against approved boundaries and resource envelope.
   */
  checkResult(
    invocationId: string,
    resultSummary?: InvocationResultSummary,
  ): InvocationValidationResult {
    const session = this.sessions.get(invocationId);
    if (!session) {
      return { success: true };
    }

    if (
      session.status === "revoked" ||
      session.status === "quarantined" ||
      session.status === "drift_detected"
    ) {
      const reason =
        session.status === "drift_detected"
          ? `Invocation '${invocationId}' has detected drift (${session.driftReasons.join(", ")}): cannot complete successfully`
          : (session.revocationReason ?? "Invocation revoked due to policy violation");
      return {
        success: false,
        violations: [reason],
        requalificationRequired: true,
      };
    }

    const violations: string[] = [];
    const boundaries = session.boundaries;

    // Check resource envelope
    if (boundaries.resourceEnvelope && resultSummary) {
      const envelope = boundaries.resourceEnvelope;
      if (
        envelope.maxMemoryBytes !== undefined &&
        resultSummary.maxMemoryBytes !== undefined &&
        resultSummary.maxMemoryBytes > envelope.maxMemoryBytes
      ) {
        violations.push(
          `Memory limit exceeded: observed ${resultSummary.maxMemoryBytes} bytes, envelope limit ${envelope.maxMemoryBytes} bytes`,
        );
      }

      if (
        envelope.cpuTimeMs !== undefined &&
        resultSummary.cpuTimeMs !== undefined &&
        resultSummary.cpuTimeMs > envelope.cpuTimeMs
      ) {
        violations.push(
          `CPU time limit exceeded: observed ${resultSummary.cpuTimeMs} ms, envelope limit ${envelope.cpuTimeMs} ms`,
        );
      }

      if (
        envelope.wallDurationMs !== undefined &&
        resultSummary.wallDurationMs !== undefined &&
        resultSummary.wallDurationMs > envelope.wallDurationMs
      ) {
        violations.push(
          `Wall duration limit exceeded: observed ${resultSummary.wallDurationMs} ms, envelope limit ${envelope.wallDurationMs} ms`,
        );
      }
    }

    // Check validation checks
    if (boundaries.validationChecks.observation === "complete" && resultSummary?.validationChecks) {
      for (const check of resultSummary.validationChecks) {
        if (!check.passed) {
          violations.push(`Validation check '${check.name}' (${check.checkId}) failed`);
        }
      }
    }

    // Check artifacts
    if (boundaries.artifacts.observation === "complete" && boundaries.artifacts.items.length > 0) {
      const producedArtifacts = resultSummary?.artifacts ?? session.observedEffects.artifacts;
      const expectedMap = new Map(boundaries.artifacts.items.map((a) => [a.name, a.digest]));
      const producedMap = new Map(producedArtifacts.map((a) => [a.name, a.digest]));

      for (const [name, expectedDigest] of expectedMap.entries()) {
        if (!producedMap.has(name)) {
          violations.push(`Missing expected artifact '${name}'`);
        } else if (producedMap.get(name) !== expectedDigest) {
          violations.push(
            `Artifact '${name}' digest mismatch: expected ${expectedDigest}, got ${producedMap.get(name)}`,
          );
        }
      }

      for (const name of producedMap.keys()) {
        if (!expectedMap.has(name)) {
          violations.push(`Unexpected extra artifact '${name}' produced`);
        }
      }
    }

    if (violations.length > 0) {
      const combinedReason = violations.join("; ");
      this.revokeInvocation(invocationId, combinedReason, { resultSummary });
      const quarantineRecord: QuarantineRecord = {
        quarantineId: `quarantine_${Date.now()}_${randomUUID().slice(0, 8)}`,
        toolId: session.toolId,
        toolVersion: session.toolVersion,
        invocationId,
        reason: combinedReason,
        violationType: "resource_limit",
        timestamp: new Date().toISOString(),
        details: { violations, resultSummary },
      };
      this.quarantine(quarantineRecord);

      this.auditEmitter.emitAudit({
        service: "monitor",
        action: "result_check",
        invocationId,
        toolId: session.toolId,
        toolVersion: session.toolVersion,
        status: "denied",
        error: {
          code: "POLICY_VIOLATION",
          message: combinedReason,
          details: { violations },
        },
        summary: {
          violations,
        },
      });

      return {
        success: false,
        violations,
        quarantineRecord,
        requalificationRequired: session.requalificationRequired,
      };
    }

    session.status = "completed";
    return {
      success: true,
      requalificationRequired: session.requalificationRequired,
    };
  }

  /**
   * Revokes an invocation session and marks it as non-compliant.
   */
  revokeInvocation(invocationId: string, reason: string, details?: Record<string, unknown>): void {
    const session = this.sessions.get(invocationId);
    if (session) {
      session.status = "revoked";
      session.revocationReason = reason;
    }
  }

  /**
   * Invokes quarantine callback.
   */
  quarantine(record: QuarantineRecord): void {
    if (this.onQuarantine) {
      try {
        const res = this.onQuarantine(record);
        if (res instanceof Promise) {
          res.catch(() => {});
        }
      } catch {
        // Suppress unhandled callback errors
      }
    }
  }

  /**
   * Invokes requalification callback when drift is observed.
   */
  triggerRequalification(event: RequalificationEvent): void {
    if (this.onRequalificationNeeded) {
      try {
        const res = this.onRequalificationNeeded(event);
        if (res instanceof Promise) {
          res.catch(() => {});
        }
      } catch {
        // Suppress unhandled callback errors
      }
    }
  }

  private checkDependencyDrift(
    expected:
      | Readonly<Record<string, string>>
      | Record<string, string>
      | readonly string[]
      | string[],
    actual:
      | Readonly<Record<string, string>>
      | Record<string, string>
      | readonly string[]
      | string[],
  ): Record<string, unknown> | null {
    if (Array.isArray(expected) && Array.isArray(actual)) {
      const expSet = new Set<string>(expected);
      const actSet = new Set<string>(actual);
      const added = actual.filter((a) => !expSet.has(a));
      const removed = expected.filter((e) => !actSet.has(e));
      if (added.length > 0 || removed.length > 0) {
        return { added, removed };
      }
      return null;
    }

    if (
      typeof expected === "object" &&
      expected !== null &&
      !Array.isArray(expected) &&
      typeof actual === "object" &&
      actual !== null &&
      !Array.isArray(actual)
    ) {
      const expRecord = expected as Readonly<Record<string, string>>;
      const actRecord = actual as Readonly<Record<string, string>>;
      const diff: Record<string, { expected?: string; actual?: string }> = {};
      let hasDiff = false;
      for (const [k, v] of Object.entries(expRecord)) {
        if (actRecord[k] !== v) {
          diff[k] = { expected: v, actual: actRecord[k] };
          hasDiff = true;
        }
      }
      for (const [k, v] of Object.entries(actRecord)) {
        if (!(k in expRecord)) {
          diff[k] = { actual: v };
          hasDiff = true;
        }
      }
      return hasDiff ? diff : null;
    }

    return { typeMismatch: true };
  }
}
