import { type CapabilityLimits, CapabilityManifestSchema } from "@resin/contracts";
import { type InvocationGrant, verifyInvocationGrant } from "../policy/grant.js";
import {
  type BrokerAuditEmitter,
  type BrokerAuditEvent,
  type BrokerAuditStatus,
  type BrokerAuditSummary,
  type BrokerAuditValue,
  defaultBrokerAuditEmitter,
} from "./audit.js";
import type { SecretBroker } from "./secret-broker.js";

/**
 * Standard broker security and operational error codes.
 */
export type BrokerErrorCode =
  | "GRANT_REQUIRED"
  | "GRANT_INVALID"
  | "GRANT_EXPIRED"
  | "INVOCATION_MISMATCH"
  | "TOOL_MISMATCH"
  | "WORKSPACE_MISMATCH"
  | "ENVELOPE_MISMATCH"
  | "BUDGET_EXCEEDED"
  | "CONCURRENCY_LIMIT"
  | "OPERATION_NOT_PERMITTED"
  | "POLICY_VIOLATION"
  | "EFFECT_MISMATCH"
  | "UNAUTHORIZED_EFFECT"
  | "QUARANTINED"
  | "REQUALIFICATION_REQUIRED"
  | "AUTHORIZATION_REQUIRED"
  // Filesystem
  | "PATH_TRAVERSAL"
  | "PATH_DENIED"
  | "OUTSIDE_ALLOWED_ROOT"
  | "SYMLINK_ESCAPE"
  | "HARDLINK_RESTRICTED"
  | "INVALID_PATH"
  | "MAX_FILE_SIZE_EXCEEDED"
  | "FILE_NOT_FOUND"
  | "READ_ONLY_ACCESS"
  | "HIDDEN_FILE_DENIED"
  // Network
  | "OUTBOUND_NETWORK_DISABLED"
  | "DISALLOWED_PROTOCOL"
  | "DISALLOWED_PORT"
  | "DISALLOWED_HOST"
  | "DISALLOWED_DOMAIN"
  | "BLOCKED_IP_RANGE"
  | "DNS_RESOLUTION_FAILED"
  | "TOO_MANY_REDIRECTS"
  | "RESPONSE_TOO_LARGE"
  | "NETWORK_ERROR"
  | "NETWORK_TIMEOUT"
  | "REQUEST_TIMEOUT"
  // Command
  | "COMMAND_EXECUTION_DISABLED"
  | "UNAUTHORIZED_BINARY"
  | "FORBIDDEN_PATTERN"
  | "FORBIDDEN_ARGUMENT_PATTERN"
  | "INTERPRETER_ESCAPE_DENIED"
  | "RESPONSE_FILE_DENIED"
  | "COMMAND_IDENTITY_VIOLATION"
  | "SHELL_EXECUTION_DENIED"
  | "WORKING_DIRECTORY_DENIED"
  | "DANGEROUS_ENV_VAR"
  | "UNAUTHORIZED_ENV_VAR"
  | "COMMAND_TIMEOUT"
  | "MAX_OUTPUT_EXCEEDED"
  | "PROCESS_SPAWN_FAILED"
  // Secrets / Mediation
  | "SECRET_NOT_FOUND"
  | "SECRET_NOT_AUTHORIZED"
  | "DIRECT_READ_DENIED"
  | "SECRET_SCOPE_MISMATCH"
  | "INVALID_SECRET_REFERENCE"
  | "MEDIATION_FAILED"
  | "SECRET_EXPIRED"
  | "GRANT_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "INSTALLATION_MISMATCH";

/**
 * Broker security error thrown when capability checks or budget constraints fail.
 */
export class BrokerSecurityError extends Error {
  readonly code: BrokerErrorCode;
  readonly details?: BrokerAuditSummary;

  constructor(code: BrokerErrorCode, message: string, details?: BrokerAuditSummary) {
    super(`[${code}] ${message}`);
    this.name = "BrokerSecurityError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type BrokerContextValue =
  | string
  | number
  | boolean
  | null
  | readonly BrokerContextValue[]
  | BrokerContextValue[]
  | { [key: string]: BrokerContextValue | undefined };

/**
 * Execution context passed to capability broker operations.
 */
export interface BrokerContext {
  invocationId: string;
  grant?: InvocationGrant;
  workspaceRoot?: string;
  scratchDir?: string;
  toolId?: string;
  toolVersion?: string;
  workspaceId?: string;
  envelopeId?: string;
  accountId?: string;
  installationId?: string;
  currentTimestamp?: number;
  isWorker?: boolean;
  source?: string;
  secretBroker?: SecretBroker;
  [key: string]: BrokerContextValue | InvocationGrant | SecretBroker | undefined;
}

/**
 * Options for configuring BaseCapabilityBroker.
 */
export interface BaseCapabilityBrokerOptions {
  auditEmitter?: BrokerAuditEmitter;
  requireGrant?: boolean;
}

/**
 * Tracks budget consumption per invocation.
 */
interface InvocationBudgetUsage {
  cumulativeOutputBytes: number;
  activeConcurrency: number;
}

/**
 * Abstract base class for capability brokers enforcing invocation grants,
 * resource limits, and audit event emission.
 */
export abstract class BaseCapabilityBroker {
  protected readonly auditEmitter: BrokerAuditEmitter;
  protected readonly requireGrant: boolean;
  private readonly invocationUsage = new Map<string, InvocationBudgetUsage>();

  constructor(options: BaseCapabilityBrokerOptions = {}) {
    this.auditEmitter = options.auditEmitter ?? defaultBrokerAuditEmitter;
    this.requireGrant = options.requireGrant ?? true;
  }

  /**
   * Abstract name of the service (e.g., 'fs', 'net', 'cmd').
   */
  abstract readonly serviceName: "fs" | "net" | "cmd" | "secret" | string;

  /**
   * Verifies the presence, cryptographic integrity, expiration, and binding
   * of the InvocationGrant attached to the execution context.
   */
  protected validateGrant(context: BrokerContext): InvocationGrant {
    const { grant, invocationId, toolId, toolVersion, workspaceId, envelopeId, currentTimestamp } =
      context;

    if (!grant) {
      if (this.requireGrant) {
        throw new BrokerSecurityError(
          "GRANT_REQUIRED",
          `Invocation grant is required for service '${this.serviceName}'`,
        );
      }
      // If grant is not required by broker config, return a minimal dummy grant
      return {
        grantId: "grant_default",
        invocationId,
        toolId: toolId ?? "tool_default",
        toolVersion: toolVersion ?? "1.0.0",
        workspaceId: workspaceId ?? "ws_default",
        envelopeId: envelopeId ?? "env_default",
        policyVersion: "1.0.0",
        capabilities: CapabilityManifestSchema.parse({}),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        actor: { type: "default", id: "default_actor" },
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      };
    }

    const verification = verifyInvocationGrant(grant, {
      expectedInvocationId: invocationId,
      expectedToolId: toolId,
      expectedToolVersion: toolVersion,
      expectedWorkspaceId: workspaceId,
      expectedEnvelopeId: envelopeId,
      currentTimestamp: currentTimestamp ?? Date.now(),
    });

    if (!verification.valid) {
      const codeMap = {
        SCHEMA_INVALID: "GRANT_INVALID",
        TAMPERED_DIGEST: "GRANT_INVALID",
        EXPIRED: "GRANT_EXPIRED",
        INVOCATION_MISMATCH: "INVOCATION_MISMATCH",
        TOOL_MISMATCH: "TOOL_MISMATCH",
        WORKSPACE_MISMATCH: "WORKSPACE_MISMATCH",
        ENVELOPE_MISMATCH: "ENVELOPE_MISMATCH",
      } as const satisfies Record<string, BrokerErrorCode>;
      const mappedCode = verification.errorCode
        ? (codeMap[verification.errorCode] ?? "GRANT_INVALID")
        : "GRANT_INVALID";
      throw new BrokerSecurityError(
        mappedCode,
        verification.message ?? "Grant verification failed",
      );
    }

    return grant;
  }

  /**
   * Tracks and enforces output bytes consumption against limits.maxOutputSizeBytes.
   */
  protected trackOutputBytes(
    invocationId: string,
    additionalBytes: number,
    limits?: CapabilityLimits,
  ): void {
    const maxBytes = limits?.maxOutputSizeBytes ?? 10485760; // default 10MB
    const usage = this.getOrCreateUsage(invocationId);
    usage.cumulativeOutputBytes += additionalBytes;

    if (usage.cumulativeOutputBytes > maxBytes) {
      throw new BrokerSecurityError(
        "BUDGET_EXCEEDED",
        `Output size limit exceeded: consumed ${usage.cumulativeOutputBytes} bytes, max allowed is ${maxBytes} bytes`,
        { consumedBytes: usage.cumulativeOutputBytes, maxBytes },
      );
    }
  }

  /**
   * Enforces max concurrent executions for the invocation.
   */
  protected acquireConcurrency(invocationId: string, limits?: CapabilityLimits): () => void {
    const maxConcurrent = limits?.maxConcurrentExecutions ?? 10;
    const usage = this.getOrCreateUsage(invocationId);

    if (usage.activeConcurrency >= maxConcurrent) {
      throw new BrokerSecurityError(
        "CONCURRENCY_LIMIT",
        `Concurrent operations limit exceeded: active ${usage.activeConcurrency}, max ${maxConcurrent}`,
        { active: usage.activeConcurrency, max: maxConcurrent },
      );
    }

    usage.activeConcurrency++;
    let released = false;

    return () => {
      if (!released) {
        released = true;
        usage.activeConcurrency = Math.max(0, usage.activeConcurrency - 1);
      }
    };
  }

  /**
   * Emits an audit event for an operation.
   */
  protected recordAudit(
    action: string,
    context: BrokerContext,
    status: BrokerAuditStatus,
    summary: BrokerAuditSummary,
    options: {
      error?: { code: string; message: string; details?: unknown };
      durationMs?: number;
    } = {},
  ): BrokerAuditEvent {
    return this.auditEmitter.emitAudit({
      service: this.serviceName,
      action,
      invocationId: context.invocationId,
      grantId: context.grant?.grantId,
      toolId: context.toolId ?? context.grant?.toolId,
      status,
      error: options.error,
      durationMs: options.durationMs,
      summary,
    });
  }

  /**
   * Gets or initializes usage stats for an invocation.
   */
  private getOrCreateUsage(invocationId: string): InvocationBudgetUsage {
    let usage = this.invocationUsage.get(invocationId);
    if (!usage) {
      usage = { cumulativeOutputBytes: 0, activeConcurrency: 0 };
      this.invocationUsage.set(invocationId, usage);
    }
    return usage;
  }

  /**
   * Resets budget tracking for a settled invocation.
   */
  cleanupInvocation(invocationId: string): void {
    this.invocationUsage.delete(invocationId);
  }
}
