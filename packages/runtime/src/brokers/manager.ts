import {
  type CanonicalJsonRecord,
  type CanonicalJsonValue,
  type SecretCapability,
  type SecretReference,
  SecretReferenceSchema,
} from "@resin/contracts";
import type { SecretManager } from "@resin/crypto";
import { z } from "zod";
import {
  type ApprovedEffectBoundaries,
  EffectMonitor,
  type EffectRequest,
  type ExternalActionAuthorizationRecord,
  ExternalActionAuthorizationRecordSchema,
  type ExternalActionAuthorizationVerifier,
  type InvocationRegistrationParams,
  type InvocationResultSummary,
  type InvocationSessionState,
  type InvocationValidationResult,
  type MonitorRecord,
  type MonitorValue,
  type QuarantineRecord,
  type RequalificationEvent,
  type VerifiedQualificationToken,
  computePayloadDigest,
  effectRequestToRecord,
  isVerifiedQualificationToken,
} from "../monitor/index.js";
import type { BrokerRequestHandlerFn } from "../worker/sdk.js";
import {
  type BrokerAuditEmitter,
  type BrokerAuditSummary,
  type BrokerAuditValue,
  defaultBrokerAuditEmitter,
  sanitizeAuditSummary,
} from "./audit.js";
import {
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";
import { CommandBroker, type CommandExecuteResult } from "./cmd-broker.js";
import { type FileStatResult, FilesystemBroker, type ReadFileResult } from "./fs-broker.js";
import { type NetRequestParams, type NetResponseResult, NetworkBroker } from "./net-broker.js";
import {
  BrokerSecretRequestPayloadSchema,
  type BrokerSecretResult,
  SecretBroker,
} from "./secret-broker.js";

export type BrokerRequestPayloadValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | SecretReference
  | ExternalActionAuthorizationRecord
  | readonly BrokerRequestPayloadValue[]
  | BrokerRequestPayloadValue[]
  | { [key: string]: BrokerRequestPayloadValue | undefined };

export interface BrokerRequestPayload {
  [key: string]: BrokerRequestPayloadValue | undefined;
}

export interface ExternalActionResult {
  success: boolean;
  actionType: string;
  target: string;
  payloadDigest?: string;
  executedAt: string;
  invocationId?: string;
}

export type BrokerExecutionResult =
  | { content: string | Buffer; bytesRead: number }
  | { bytesWritten: number }
  | { success: boolean }
  | ReadFileResult
  | { exists: boolean }
  | FileStatResult
  | NetResponseResult
  | CommandExecuteResult
  | BrokerSecretResult
  | ExternalActionResult
  | Record<string, string | number | boolean | null | undefined>
  | string[]
  | boolean
  | null
  // biome-ignore lint/suspicious/noConfusingVoidType: Filesystem actions resolve without a result value.
  | void
  | undefined;

function toMonitorValue(val: BrokerRequestPayloadValue | undefined): MonitorValue | undefined {
  if (val === undefined || val === null) return val;
  if (
    String(val) === val ||
    Number.isFinite(val) ||
    val === true ||
    val === false ||
    val instanceof Uint8Array
  ) {
    return val;
  }
  if (Array.isArray(val)) {
    const arr: MonitorValue[] = [];
    for (const item of val) {
      const converted = toMonitorValue(item);
      if (converted !== undefined) {
        arr.push(converted);
      }
    }
    return arr;
  }
  const obj: { [key: string]: MonitorValue | undefined } = {};
  for (const [k, v] of Object.entries(val)) {
    obj[k] = toMonitorValue(v);
  }
  return obj;
}

type BrokerGuardValue = MonitorValue | BrokerRequestPayloadValue | null | undefined;

function isString(val: BrokerGuardValue): val is string {
  return z.string().safeParse(val).success;
}

function isNumber(val: BrokerGuardValue): val is number {
  return z.number().finite().safeParse(val).success;
}

function isBoolean(val: BrokerGuardValue): val is boolean {
  return z.boolean().safeParse(val).success;
}

function isMonitorRecord(val: MonitorValue | null | undefined): val is MonitorRecord {
  return (
    val !== null &&
    !Array.isArray(val) &&
    !(val instanceof Uint8Array) &&
    Object.prototype.toString.call(val) === "[object Object]"
  );
}

function toAuditSummary(record: MonitorRecord | undefined | null): BrokerAuditSummary {
  if (!record || Array.isArray(record)) return {};
  const summary: BrokerAuditSummary = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (isString(v) || isNumber(v) || isBoolean(v) || v === null) {
      summary[k] = v;
    } else if (Array.isArray(v)) {
      const arr: BrokerAuditValue[] = [];
      for (const item of v) {
        if (item === undefined) continue;
        if (isString(item) || isNumber(item) || isBoolean(item) || item === null) {
          arr.push(item);
        }
      }
      summary[k] = arr;
    } else if (isMonitorRecord(v)) {
      summary[k] = toAuditSummary(v);
    }
  }
  return summary;
}

function parseExternalAuth(
  val: BrokerRequestPayloadValue | undefined,
): ExternalActionAuthorizationRecord | undefined {
  const result = ExternalActionAuthorizationRecordSchema.safeParse(val);
  return result.success ? result.data : undefined;
}

function parseHeaders(
  val: BrokerRequestPayloadValue | undefined,
): Record<string, string | SecretReference> | undefined {
  if (val !== null && val !== undefined && !Array.isArray(val) && !(val instanceof Uint8Array)) {
    const result: Record<string, string | SecretReference> = {};
    for (const [k, v] of Object.entries(val)) {
      const parsedRef = SecretReferenceSchema.safeParse(v);
      if (parsedRef.success) {
        result[k] = parsedRef.data;
      } else if (String(v) === v) {
        result[k] = v;
      }
    }
    return result;
  }
  return undefined;
}

function parseSecretReferences(
  val: BrokerRequestPayloadValue | undefined,
): Record<string, SecretReference> | undefined {
  if (val !== null && val !== undefined && !Array.isArray(val) && !(val instanceof Uint8Array)) {
    const result: Record<string, SecretReference> = {};
    for (const [k, v] of Object.entries(val)) {
      const parsed = SecretReferenceSchema.safeParse(v);
      if (parsed.success) {
        result[k] = parsed.data;
      }
    }
    return result;
  }
  return undefined;
}

function parseEnvMap(
  val: BrokerRequestPayloadValue | undefined,
): Record<string, string | SecretReference> | undefined {
  if (val !== null && val !== undefined && !Array.isArray(val) && !(val instanceof Uint8Array)) {
    const result: Record<string, string | SecretReference> = {};
    for (const [k, v] of Object.entries(val)) {
      const parsed = SecretReferenceSchema.safeParse(v);
      if (parsed.success) {
        result[k] = parsed.data;
      } else if (String(v) === v) {
        result[k] = v;
      }
    }
    return result;
  }
  return undefined;
}

const BrokerAuthSchema = z.union([
  SecretReferenceSchema,
  z
    .object({
      bearer: z.union([z.string(), SecretReferenceSchema]),
    })
    .strict(),
]);

function parseAuth(val: BrokerRequestPayloadValue | undefined): NetRequestParams["auth"] {
  const parsedAuth = BrokerAuthSchema.safeParse(val);
  return parsedAuth.success ? parsedAuth.data : undefined;
}

export interface CapabilityBrokerManagerOptions extends BaseCapabilityBrokerOptions {
  fsBroker?: FilesystemBroker;
  netBroker?: NetworkBroker;
  cmdBroker?: CommandBroker;
  secretBroker?: SecretBroker;
  secretManager?: SecretManager;
  secrets?: SecretBroker | Record<string, string> | SecretManager;
  vaultPath?: string;
  passphrase?: string;
  effectMonitor?: EffectMonitor;
  onQuarantine?: (record: QuarantineRecord) => void | Promise<void>;
  onRequalificationNeeded?: (event: RequalificationEvent) => void | Promise<void>;
  token?: VerifiedQualificationToken;
  qualificationToken?: VerifiedQualificationToken;
  defaultBoundaries?: VerifiedQualificationToken | ApprovedEffectBoundaries;
  allowUnverifiedBoundaries?: boolean;
  development?: boolean;
  authorizationVerifier?: ExternalActionAuthorizationVerifier;
  strict?: boolean;
}

/**
 * Unified manager for capability brokers in the resin runtime.
 * Dispatches RPC requests to the appropriate broker (fs, net, cmd, secret),
 * verifies invocation grants, tracks resource usage, and emits audit trails.
 */
export class CapabilityBrokerManager {
  readonly fs: FilesystemBroker;
  readonly net: NetworkBroker;
  readonly cmd: CommandBroker;
  readonly secret: SecretBroker;
  readonly auditEmitter: BrokerAuditEmitter;
  readonly effectMonitor: EffectMonitor;

  constructor(options: CapabilityBrokerManagerOptions = {}) {
    this.auditEmitter = options.auditEmitter ?? defaultBrokerAuditEmitter;
    const rawDefaults = options.defaultBoundaries ?? options.token ?? options.qualificationToken;
    if (
      rawDefaults !== undefined &&
      rawDefaults !== null &&
      !isVerifiedQualificationToken(rawDefaults) &&
      !options.allowUnverifiedBoundaries &&
      !options.development
    ) {
      throw new BrokerSecurityError(
        "POLICY_VIOLATION",
        "Arbitrary or fabricated default effect boundaries are rejected: defaultBoundaries must be derived exclusively from a verified qualification token created by ToolBundleLoader",
      );
    }
    this.effectMonitor =
      options.effectMonitor ??
      new EffectMonitor({
        auditEmitter: this.auditEmitter,
        onQuarantine: options.onQuarantine,
        onRequalificationNeeded: options.onRequalificationNeeded,
        defaultBoundaries: rawDefaults,
        allowUnverifiedBoundaries: options.allowUnverifiedBoundaries,
        development: options.development,
        authorizationVerifier: options.authorizationVerifier,
        strict: options.strict ?? !(options.development || options.allowUnverifiedBoundaries),
      });
    const baseOpts = { auditEmitter: this.auditEmitter, requireGrant: options.requireGrant };

    this.secret =
      options.secretBroker ??
      (options.secrets instanceof SecretBroker
        ? options.secrets
        : new SecretBroker({
            auditEmitter: this.auditEmitter,
            requireGrant: options.requireGrant,
            secrets: options.secrets,
            secretManager: options.secretManager,
            vaultPath: options.vaultPath,
            passphrase: options.passphrase,
          }));

    this.fs = options.fsBroker ?? new FilesystemBroker(baseOpts);
    this.net = options.netBroker ?? new NetworkBroker({ ...baseOpts, secretBroker: this.secret });
    this.cmd = options.cmdBroker ?? new CommandBroker({ ...baseOpts, secretBroker: this.secret });

    if (options.netBroker) {
      this.net.setSecretBroker(this.secret);
    }
    if (options.cmdBroker) {
      this.cmd.setSecretBroker(this.secret);
    }
  }
  get secretBroker(): SecretBroker {
    return this.secret;
  }

  /**
   * Dispatches an incoming broker request from a worker process to the corresponding capability broker.
   */
  async handleRequest(
    service: "fs" | "net" | "cmd" | "secret" | "external" | "consequential" | string,
    action: string,
    payload: BrokerRequestPayload,
    context: BrokerContext,
  ): Promise<BrokerExecutionResult> {
    const invocationId = context.invocationId || "";
    if (invocationId && this.effectMonitor.isInvocationRevoked(invocationId)) {
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Invocation '${invocationId}' has been revoked due to policy violation`,
        { code: "POLICY_VIOLATION", invocationId },
      );
    }

    const effectRequest = this.mapRequestToEffect(service, action, payload);
    if (effectRequest) {
      const check = this.effectMonitor.checkBeforeEffect(invocationId, effectRequest, context);
      if (!check.allowed) {
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          check.reason ??
            `Effect violates approved qualification boundaries: ${effectRequest.type}`,
          {
            code: "POLICY_VIOLATION",
            violationType: check.violationType,
            invocationId,
            effect: sanitizeAuditSummary(toAuditSummary(effectRequestToRecord(effectRequest))),
          },
        );
      }
    }

    let result: BrokerExecutionResult;
    switch (service) {
      case "fs":
        result = await this.handleFsRequest(action, payload, context);
        break;
      case "net":
        result = await this.handleNetRequest(action, payload, context);
        break;
      case "cmd":
        result = await this.handleCmdRequest(action, payload, context);
        break;
      case "secret":
        result = await this.handleSecretRequest(action, payload, context);
        break;
      case "external":
      case "consequential":
        result = await this.handleExternalActionRequest(action, payload, context);
        break;
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported broker service: '${service}'`,
        );
    }

    if (effectRequest && context.invocationId) {
      this.effectMonitor.recordObservedEffect(context.invocationId, effectRequest, context);
    }

    return result;
  }

  /**
   * Registers an invocation and its qualification boundary profile with the monitor.
   */
  registerInvocation(params: InvocationRegistrationParams): InvocationSessionState {
    return this.effectMonitor.registerInvocation(params);
  }

  /**
   * Validates final invocation outputs, resource usage, and artifacts against qualification profile.
   */
  finalizeInvocation(
    invocationId: string,
    resultSummary?: InvocationResultSummary,
  ): InvocationValidationResult {
    return this.effectMonitor.checkResult(invocationId, resultSummary);
  }

  /**
   * Executes an authorized external consequential action.
   */
  async executeExternalAction(
    params: {
      actionType: string;
      target: string;
      payload?: BrokerRequestPayloadValue;
      payloadDigest?: string;
      authorization?: ExternalActionAuthorizationRecord;
    },
    context: BrokerContext,
  ): Promise<BrokerExecutionResult> {
    return this.handleRequest(
      "external",
      params.actionType,
      {
        actionType: params.actionType,
        target: params.target,
        payload: params.payload,
        payloadDigest: params.payloadDigest,
        authorization: params.authorization,
      },
      context,
    );
  }

  private mapRequestToEffect(
    service: string,
    action: string,
    payload: BrokerRequestPayload,
  ): EffectRequest | null {
    switch (service) {
      case "fs": {
        switch (action) {
          case "readFile":
          case "stat":
          case "exists":
          case "readDir":
          case "readdir":
          case "listDirectory":
          case "listDir":
            return { type: "file_read", path: String(payload.path ?? "") };
          case "writeFile":
            return {
              type: "file_write",
              path: String(payload.path ?? ""),
              isCreate:
                payload.isCreate === true ? true : payload.isCreate === false ? false : undefined,
              isModify:
                payload.isModify === true ? true : payload.isModify === false ? false : undefined,
            };
          case "appendFile":
            return { type: "file_modify", path: String(payload.path ?? ""), isModify: true };
          case "rename":
            return {
              type: "file_rename",
              oldPath: String(payload.oldPath ?? ""),
              newPath: String(payload.newPath ?? ""),
            };
          case "delete":
          case "removeFile":
            return { type: "file_delete", path: String(payload.path ?? "") };
          case "createDirectory":
          case "mkdir":
            return { type: "file_create", path: String(payload.path ?? ""), isCreate: true };
          default:
            return null;
        }
      }
      case "net": {
        const payloadVal = toMonitorValue(payload.body ?? payload.payload);
        return {
          type: "network_request",
          url: String(payload.url ?? ""),
          method: String(payload.method ?? "GET"),
          payload: payloadVal,
          body: payloadVal,
          payloadDigest:
            String(payload.payloadDigest) === payload.payloadDigest
              ? payload.payloadDigest
              : undefined,
          authorization:
            parseExternalAuth(payload.authorization) ??
            parseExternalAuth(payload.externalAuthorization),
        };
      }
      case "cmd": {
        return {
          type: "process_spawn",
          command: String(payload.command ?? ""),
          args: Array.isArray(payload.args)
            ? payload.args.filter((a): a is string => String(a) === a)
            : [],
        };
      }
      case "secret": {
        return {
          type: "credential_access",
          name: String(payload.name ?? payload.referenceId ?? ""),
          referenceId: payload.referenceId ? String(payload.referenceId) : undefined,
        };
      }
      case "external":
      case "consequential": {
        return {
          type: "external_action",
          actionType: String(payload.actionType ?? action),
          target: String(payload.target ?? ""),
          payload: toMonitorValue(payload.payload),
          payloadDigest:
            String(payload.payloadDigest) === payload.payloadDigest
              ? payload.payloadDigest
              : undefined,
          authorization: parseExternalAuth(payload.authorization),
        };
      }
      default:
        return null;
    }
  }

  private async handleExternalActionRequest(
    action: string,
    payload: BrokerRequestPayload,
    context: BrokerContext,
  ): Promise<ExternalActionResult> {
    const actionType = String(payload.actionType ?? action);
    const target = String(payload.target ?? "");
    const rawDigest = payload.payloadDigest;
    const payloadDigest =
      String(rawDigest) === rawDigest
        ? rawDigest
        : payload.payload !== undefined
          ? computePayloadDigest(toMonitorValue(payload.payload))
          : undefined;
    return {
      success: true,
      actionType,
      target,
      payloadDigest,
      executedAt: new Date().toISOString(),
      invocationId: context.invocationId,
    };
  }
  createRequestHandler(context: BrokerContext): BrokerRequestHandlerFn {
    return async (
      service: "fs" | "net" | "cmd" | "secret",
      action: string,
      payload?: CanonicalJsonRecord,
    ): Promise<CanonicalJsonValue> => {
      const enrichedContext: BrokerContext = {
        ...context,
        secretBroker: this.secret,
        isWorker: true,
        source: "worker",
      };
      // SAFETY: CanonicalJsonRecord payload conforms to BrokerRequestPayload structure.
      const brokerPayload = (payload ?? {}) as BrokerRequestPayload;
      const res = await this.handleRequest(service, action, brokerPayload, enrichedContext);
      if (res === undefined) {
        return null;
      }
      // SAFETY: BrokerExecutionResult conforms to CanonicalJsonValue.
      return res as CanonicalJsonValue;
    };
  }
  /**
   * Cleans up all per-invocation state across all brokers.
   */
  cleanupInvocation(invocationId: string): void {
    this.fs.cleanupInvocation(invocationId);
    this.net.cleanupInvocation(invocationId);
    this.cmd.cleanupInvocation(invocationId);
    this.secret.cleanupInvocation(invocationId);
  }

  private async handleFsRequest(
    action: string,
    payload: BrokerRequestPayload,
    context: BrokerContext,
  ): Promise<BrokerExecutionResult> {
    switch (action) {
      case "readFile":
        return this.fs.readFile(
          {
            path: String(payload.path ?? ""),
            encoding:
              payload.encoding === "utf-8" ||
              payload.encoding === "utf-8-strict" ||
              payload.encoding === "base64" ||
              payload.encoding === "buffer"
                ? payload.encoding
                : undefined,
          },
          context,
        );
      case "writeFile":
        return this.fs.writeFile(
          {
            path: String(payload.path ?? ""),
            content:
              payload.content instanceof Uint8Array
                ? payload.content
                : String(payload.content ?? ""),
            encoding:
              payload.encoding === "utf-8" || payload.encoding === "base64"
                ? payload.encoding
                : undefined,
            atomic: payload.atomic === true ? true : payload.atomic === false ? false : undefined,
          },
          context,
        );
      case "appendFile":
        return this.fs.appendFile(
          {
            path: String(payload.path ?? ""),
            content:
              payload.content instanceof Uint8Array
                ? payload.content
                : String(payload.content ?? ""),
            encoding:
              payload.encoding === "utf-8" || payload.encoding === "base64"
                ? payload.encoding
                : undefined,
          },
          context,
        );
      case "rename":
        return this.fs.rename(
          {
            oldPath: String(payload.oldPath ?? ""),
            newPath: String(payload.newPath ?? ""),
          },
          context,
        );
      case "delete":
      case "removeFile":
        return this.fs.delete(
          {
            path: String(payload.path ?? ""),
            recursive:
              payload.recursive === true ? true : payload.recursive === false ? false : undefined,
          },
          context,
        );
      case "createDirectory":
      case "mkdir":
        return this.fs.createDirectory(
          {
            path: String(payload.path ?? ""),
            recursive:
              payload.recursive === true ? true : payload.recursive === false ? false : undefined,
          },
          context,
        );
      case "listDirectory":
      case "listDir":
        return this.fs.listDirectory(
          {
            path: payload.path !== undefined ? String(payload.path) : undefined,
            recursive:
              payload.recursive === true ? true : payload.recursive === false ? false : undefined,
            maxEntries: payload.maxEntries === undefined ? undefined : Number(payload.maxEntries),
          },
          context,
        );
      case "exists":
        return this.fs.exists(
          {
            path: String(payload.path ?? ""),
          },
          context,
        );
      case "stat":
        return this.fs.stat(
          {
            path: String(payload.path ?? ""),
          },
          context,
        );
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported filesystem broker action: '${action}'`,
        );
    }
  }

  private async handleNetRequest(
    action: string,
    payload: BrokerRequestPayload,
    context: BrokerContext,
  ): Promise<BrokerExecutionResult> {
    switch (action) {
      case "fetch":
      case "request": {
        return this.net.request(
          {
            url: String(payload.url ?? ""),
            method: String(payload.method) === payload.method ? payload.method : undefined,
            headers: parseHeaders(payload.headers),
            body:
              payload.body instanceof Uint8Array
                ? payload.body
                : String(payload.body) === payload.body
                  ? payload.body
                  : undefined,
            auth: parseAuth(payload.auth),
            secretReferences: parseSecretReferences(payload.secretReferences),
            timeoutMs: Number.isFinite(payload.timeoutMs) ? Number(payload.timeoutMs) : undefined,
            redirect:
              payload.redirect === "follow" ||
              payload.redirect === "error" ||
              payload.redirect === "manual"
                ? payload.redirect
                : undefined,
            maxRedirects: Number.isFinite(payload.maxRedirects)
              ? Number(payload.maxRedirects)
              : undefined,
          },
          context,
        );
      }
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported network broker action: '${action}'`,
        );
    }
  }

  private async handleCmdRequest(
    action: string,
    payload: BrokerRequestPayload,
    context: BrokerContext,
  ): Promise<BrokerExecutionResult> {
    switch (action) {
      case "execute":
      case "exec": {
        let secretEnv: Record<string, string> | undefined;
        let stdin = String(payload.stdin) === payload.stdin ? payload.stdin : undefined;
        const cmdEnv = parseEnvMap(payload.env);
        if (cmdEnv) {
          secretEnv = await this.secret.mediateCommandEnv(cmdEnv, context);
        } else if (context.grant?.capabilities?.secrets?.injectAsEnv) {
          secretEnv = await this.secret.mediateCommandEnv({}, context);
        }

        if (stdin) {
          stdin = await this.secret.mediateCommandStdin(stdin, context);
        }

        return this.cmd.execute(
          {
            command: String(payload.command) === payload.command ? payload.command : undefined,
            executable:
              String(payload.executable) === payload.executable ? payload.executable : undefined,
            args: Array.isArray(payload.args)
              ? payload.args.filter((a): a is string => String(a) === a)
              : undefined,
            cwd: String(payload.cwd) === payload.cwd ? payload.cwd : undefined,
            env: cmdEnv,
            secretEnv,
            stdin,
            timeoutMs: Number.isFinite(payload.timeoutMs) ? Number(payload.timeoutMs) : undefined,
            readOnlyGit: payload.readOnlyGit === true,
            truncateOutput: payload.truncateOutput === true,
            maxOutputSizeBytes: Number.isFinite(payload.maxOutputSizeBytes)
              ? Number(payload.maxOutputSizeBytes)
              : undefined,
          },
          context,
        );
      }
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported command broker action: '${action}'`,
        );
    }
  }

  private async handleSecretRequest(
    action: string,
    payload: BrokerRequestPayload,
    context: BrokerContext,
  ): Promise<BrokerExecutionResult> {
    const workerContext: BrokerContext = {
      ...context,
      isWorker: true,
      source: "worker",
    };
    const secretPayload = BrokerSecretRequestPayloadSchema.parse(payload);
    return this.secret.handleRequest(action, secretPayload, workerContext);
  }
}
