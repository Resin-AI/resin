import type { SecretCapability, SecretReference } from "@resin/contracts";
import type { SecretManager } from "@resin/crypto";
import {
  type ApprovedEffectBoundaries,
  EffectMonitor,
  type EffectRequest,
  type ExternalActionAuthorizationRecord,
  type ExternalActionAuthorizationVerifier,
  type InvocationRegistrationParams,
  type InvocationResultSummary,
  type InvocationSessionState,
  type InvocationValidationResult,
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
  defaultBrokerAuditEmitter,
  sanitizeAuditSummary,
} from "./audit.js";
import {
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";
import { CommandBroker } from "./cmd-broker.js";
import { FilesystemBroker } from "./fs-broker.js";
import { type NetRequestParams, NetworkBroker } from "./net-broker.js";
import { SecretBroker } from "./secret-broker.js";

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
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
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
            effect: sanitizeAuditSummary(effectRequestToRecord(effectRequest)),
          },
        );
      }
    }

    let result: unknown;
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
      payload?: unknown;
      payloadDigest?: string;
      authorization?: ExternalActionAuthorizationRecord;
    },
    context: BrokerContext,
  ): Promise<unknown> {
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
    payload: Record<string, unknown>,
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
              isCreate: payload.isCreate as boolean | undefined,
              isModify: payload.isModify as boolean | undefined,
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
        return {
          type: "network_request",
          url: String(payload.url ?? ""),
          method: String(payload.method ?? "GET"),
          payload: payload.body ?? payload.payload,
          body: payload.body ?? payload.payload,
          payloadDigest: payload.payloadDigest as string | undefined,
          authorization: (payload.authorization ?? payload.externalAuthorization) as
            | ExternalActionAuthorizationRecord
            | undefined,
        };
      }
      case "cmd": {
        return {
          type: "process_spawn",
          command: String(payload.command ?? ""),
          args: Array.isArray(payload.args) ? (payload.args as string[]) : [],
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
          payload: payload.payload,
          payloadDigest: payload.payloadDigest as string | undefined,
          authorization: payload.authorization as ExternalActionAuthorizationRecord | undefined,
        };
      }
      default:
        return null;
    }
  }

  private async handleExternalActionRequest(
    action: string,
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    const actionType = String(payload.actionType ?? action);
    const target = String(payload.target ?? "");
    return {
      success: true,
      actionType,
      target,
      payloadDigest:
        payload.payloadDigest ??
        (payload.payload ? computePayloadDigest(payload.payload) : undefined),
      executedAt: new Date().toISOString(),
      invocationId: context.invocationId,
    };
  }
  createRequestHandler(context: BrokerContext): BrokerRequestHandlerFn {
    return async (
      service: "fs" | "net" | "cmd" | "secret",
      action: string,
      payload: Record<string, unknown> = {},
    ) => {
      const enrichedContext: BrokerContext = {
        ...context,
        secretBroker: this.secret,
        isWorker: true,
        source: "worker",
      };
      return this.handleRequest(service, action, payload, enrichedContext);
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
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    switch (action) {
      case "readFile":
        return this.fs.readFile(
          {
            path: String(payload.path ?? ""),
            encoding: payload.encoding as "utf-8" | "base64" | "buffer" | undefined,
          },
          context,
        );
      case "writeFile":
        return this.fs.writeFile(
          {
            path: String(payload.path ?? ""),
            content: payload.content as string | Uint8Array,
            encoding: payload.encoding as "utf-8" | "base64" | undefined,
            atomic: payload.atomic as boolean | undefined,
          },
          context,
        );
      case "appendFile":
        return this.fs.appendFile(
          {
            path: String(payload.path ?? ""),
            content: payload.content as string | Uint8Array,
            encoding: payload.encoding as "utf-8" | "base64" | undefined,
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
            recursive: payload.recursive as boolean | undefined,
          },
          context,
        );
      case "createDirectory":
      case "mkdir":
        return this.fs.createDirectory(
          {
            path: String(payload.path ?? ""),
            recursive: payload.recursive as boolean | undefined,
          },
          context,
        );
      case "listDirectory":
      case "listDir":
        return this.fs.listDirectory(
          {
            path: payload.path !== undefined ? String(payload.path) : undefined,
            recursive: payload.recursive as boolean | undefined,
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
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    switch (action) {
      case "fetch":
      case "request": {
        return this.net.request(
          {
            url: String(payload.url ?? ""),
            method: payload.method as string | undefined,
            headers: payload.headers as Record<string, string> | undefined,
            body: payload.body as string | Uint8Array | undefined,
            auth: payload.auth as NetRequestParams["auth"],
            secretReferences: payload.secretReferences as NetRequestParams["secretReferences"],
            timeoutMs: payload.timeoutMs as number | undefined,
            redirect: payload.redirect as "follow" | "error" | "manual" | undefined,
            maxRedirects: payload.maxRedirects as number | undefined,
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
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    switch (action) {
      case "execute":
      case "exec": {
        let secretEnv: Record<string, string> | undefined;
        let stdin = payload.stdin as string | undefined;
        if (payload.env) {
          secretEnv = await this.secret.mediateCommandEnv(
            payload.env as Record<string, string>,
            context,
          );
        } else if (context.grant?.capabilities?.secrets?.injectAsEnv) {
          secretEnv = await this.secret.mediateCommandEnv({}, context);
        }

        if (stdin) {
          stdin = await this.secret.mediateCommandStdin(stdin, context);
        }

        return this.cmd.execute(
          {
            command: payload.command as string | undefined,
            executable: payload.executable as string | undefined,
            args: payload.args as string[] | undefined,
            cwd: payload.cwd as string | undefined,
            env: payload.env as Record<string, string | SecretReference> | undefined,
            secretEnv,
            stdin,
            timeoutMs: payload.timeoutMs as number | undefined,
            maxOutputSizeBytes: payload.maxOutputSizeBytes as number | undefined,
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
    payload: Record<string, unknown>,
    context: BrokerContext,
  ): Promise<unknown> {
    const workerContext: BrokerContext = {
      ...context,
      isWorker: true,
      source: "worker",
    };
    return this.secret.handleRequest(action, payload, workerContext);
  }
}
