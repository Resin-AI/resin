import {
  type SecretCapability,
  type SecretMediationMode,
  type SecretMetadataRecord,
  type SecretReference,
  SecretReferenceSchema,
  createSecretReference,
  isSecretReference,
  validateSecretReferenceScope,
} from "@resin/contracts";
import {
  type MediationMode,
  SecretManager,
  type SecretMetadata,
  type SecretRedactor,
  type SetSecretOptions,
} from "@resin/crypto";
import { z } from "zod";
import type { BrokerAuditValue } from "./audit.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  type BrokerErrorCode,
  BrokerSecurityError,
} from "./base.js";

export interface SecretReferenceOptions {
  modes?: SecretMediationMode[];
  expiresAt?: string;
  toolId?: string;
  accountId?: string;
  installationId?: string;
  metadata?: SecretMetadataRecord;
}

export type BrokerSecretResult =
  | SecretReference
  | SecretReference[]
  | { secret: string | null }
  | { mediated: string }
  | null
  | boolean;

export type BrokerSecretRequestPayloadValue =
  | string
  | number
  | boolean
  | null
  | SecretReference
  | readonly BrokerSecretRequestPayloadValue[]
  | BrokerSecretRequestPayloadValue[]
  | { [key: string]: BrokerSecretRequestPayloadValue | undefined };

export interface BrokerSecretRequestPayload {
  [key: string]: BrokerSecretRequestPayloadValue | undefined;
}
export type BrokerSecretRequestPayloadInputValue =
  | string
  | number
  | boolean
  | null
  | z.input<typeof SecretReferenceSchema>
  | BrokerSecretRequestPayloadInputValue[]
  | { [key: string]: BrokerSecretRequestPayloadInputValue | undefined };

export interface BrokerSecretRequestPayloadInput {
  [key: string]: BrokerSecretRequestPayloadInputValue | undefined;
}

export const BrokerSecretRequestPayloadValueSchema: z.ZodType<
  BrokerSecretRequestPayloadValue,
  z.ZodTypeDef,
  BrokerSecretRequestPayloadInputValue
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    SecretReferenceSchema,
    z.array(BrokerSecretRequestPayloadValueSchema),
    z.record(BrokerSecretRequestPayloadValueSchema),
  ]),
);

export const BrokerSecretRequestPayloadSchema: z.ZodType<
  BrokerSecretRequestPayload,
  z.ZodTypeDef,
  BrokerSecretRequestPayloadInput
> = z.record(BrokerSecretRequestPayloadValueSchema);

function isBrokerContext(val: BrokerContext | string | undefined): val is BrokerContext {
  return Object.prototype.toString.call(val) === "[object Object]";
}

/**
 * Options for initializing SecretBroker.
 */
export interface SecretBrokerOptions extends BaseCapabilityBrokerOptions {
  secretManager?: SecretManager;
  secrets?: Record<string, string> | SecretManager;
  vaultPath?: string;
  passphrase?: string;
}

/**
 * Capability broker for named-secret management and non-disclosure capability mediation.
 * Mediates secrets for network templates (Authorization headers, query params) and command
 * execution (stdin/env) without exposing raw secret values to generated workers.
 */
export class SecretBroker extends BaseCapabilityBroker {
  readonly serviceName = "secret" as const;
  readonly manager: SecretManager;
  private readonly references = new Map<string, SecretReference>();

  constructor(options: SecretBrokerOptions = {}) {
    super(options);

    if (options.secretManager) {
      this.manager = options.secretManager;
    } else if (options.secrets instanceof SecretManager) {
      this.manager = options.secrets;
    } else {
      this.manager = new SecretManager({
        vaultPath: options.vaultPath,
        passphrase: options.passphrase,
      });

      if (options.secrets && options.secrets !== null && !Array.isArray(options.secrets)) {
        for (const [name, value] of Object.entries(options.secrets)) {
          this.manager.addSecret(name, value).catch(() => {});
        }
      }
    }
  }

  /**
   * Helper to verify that a secret name/alias is authorized by the grant capability envelope.
   */
  private isSecretAuthorized(nameOrAlias: string, secretCap: SecretCapability): boolean {
    const allowedNames = secretCap.allowedSecretNames ?? [];
    const allowedPrefixes = secretCap.allowedPrefixes ?? [];

    if (allowedNames.includes(nameOrAlias)) {
      return true;
    }

    return allowedPrefixes.some((prefix) => nameOrAlias.startsWith(prefix));
  }

  /**
   * Creates an opaque, non-disclosing secret reference for an authorized secret.
   * Can be safely passed to generated workers and tools.
   */
  createSecretReference(
    name: string,
    context?: BrokerContext,
    options: SecretReferenceOptions = {},
  ): SecretReference {
    if (context?.grant) {
      const grant = this.validateGrant(context);
      const secretCap: SecretCapability = grant.capabilities.secrets ?? {};
      if (!this.isSecretAuthorized(name, secretCap)) {
        throw new BrokerSecurityError(
          "SECRET_NOT_AUTHORIZED",
          `Secret '${name}' is not authorized by capability grant`,
          { secretName: name },
        );
      }
    }

    const workspaceId = context?.workspaceId ?? context?.grant?.workspaceId ?? "default";
    const ref = createSecretReference({
      name,
      workspaceId,
      toolId: options.toolId ?? context?.toolId ?? context?.grant?.toolId,
      accountId: options.accountId ?? context?.accountId,
      installationId: options.installationId ?? context?.installationId,
      grantId: context?.grant?.grantId,
      permittedModes: options.modes,
      expiresAt: options.expiresAt,
      metadata: options.metadata,
    });

    this.references.set(ref.ref, ref);
    return ref;
  }

  /**
   * Resolves a SecretReference or template string into plaintext in trusted broker memory.
   * Enforces grant authorization, workspace scoping, tool scoping, expiration, and mediation modes.
   */
  async resolveSecretReference(
    refOrName: SecretReference | string,
    context: BrokerContext,
    mode: MediationMode,
  ): Promise<string> {
    if (String(refOrName) === refOrName) {
      // Check if it's a template like {{secret:NAME}}
      const templateMatch = refOrName.match(/^\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}$/);
      if (templateMatch) {
        return this.authorizeSecretAccess(templateMatch[1], context, mode);
      }

      // Check if it's a known reference handle
      const registeredRef = this.references.get(refOrName);
      if (registeredRef) {
        return this.resolveSecretReference(registeredRef, context, mode);
      }

      return this.authorizeSecretAccess(refOrName, context, mode);
    }

    const parsedRef = SecretReferenceSchema.safeParse(refOrName);
    if (!parsedRef.success) {
      throw new BrokerSecurityError(
        "INVALID_SECRET_REFERENCE",
        "Provided object is not a valid SecretReference",
      );
    }
    const secretRef = parsedRef.data;

    // 1. Validate scope (workspace, tool, account, installation, grant, expiry)
    const scopeResult = validateSecretReferenceScope(secretRef, {
      workspaceId: context.workspaceId ?? context.grant?.workspaceId,
      toolId: context.toolId ?? context.grant?.toolId,
      accountId: context.accountId,
      installationId: context.installationId,
      grantId: context.grant?.grantId,
      currentTimestamp: context.currentTimestamp,
    });

    if (!scopeResult.valid) {
      // SAFETY: Scope failure code maps to BrokerErrorCode.
      const code = (scopeResult.code as BrokerErrorCode) ?? "SECRET_SCOPE_MISMATCH";
      throw new BrokerSecurityError(code, scopeResult.reason ?? "Secret scope mismatch", {
        referenceName: secretRef.name,
        referenceWorkspace: secretRef.workspaceId,
      });
    }

    // 2. Validate permitted mediation modes
    if (secretRef.permittedModes && !secretRef.permittedModes.some((m) => m === mode)) {
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Mediation mode '${mode}' is not permitted for secret reference '${secretRef.name}' (permitted: ${secretRef.permittedModes.join(", ")})`,
        {
          secretName: secretRef.name,
          requestedMode: mode,
          permittedModes: secretRef.permittedModes,
        },
      );
    }

    // 3. Authorize and retrieve value host-side
    return this.authorizeSecretAccess(secretRef.name, context, mode);
  }

  /**
   * Resolves a secret value for a specific mediation mode after verifying grant authorization.
   */
  async authorizeSecretAccess(
    secretNameOrAlias: string,
    context: BrokerContext,
    mode: MediationMode,
  ): Promise<string> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const secretCap: SecretCapability = grant.capabilities.secrets ?? {};

    if (!this.isSecretAuthorized(secretNameOrAlias, secretCap)) {
      this.recordAudit(
        "authorizeSecret",
        context,
        "denied",
        {
          secretName: secretNameOrAlias,
          mode,
          reason: "NOT_AUTHORIZED",
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "SECRET_NOT_AUTHORIZED",
            message: `Secret '${secretNameOrAlias}' is not authorized by capability grant`,
          },
        },
      );
      throw new BrokerSecurityError(
        "SECRET_NOT_AUTHORIZED",
        `Secret '${secretNameOrAlias}' is not authorized by capability grant`,
        { secretName: secretNameOrAlias },
      );
    }

    const workspaceId = context.workspaceId ?? grant.workspaceId;

    try {
      const secretValue = await this.manager.getSecretForMediation(
        secretNameOrAlias,
        mode,
        workspaceId,
      );

      this.recordAudit(
        "mediateSecret",
        context,
        "allowed",
        {
          secretName: secretNameOrAlias,
          mode,
        },
        { durationMs: Date.now() - startTime },
      );

      return secretValue;
    } catch (err) {
      this.recordAudit(
        "mediateSecret",
        context,
        "error",
        {
          secretName: secretNameOrAlias,
          mode,
          error: err instanceof Error ? err.message : String(err),
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "SECRET_NOT_FOUND",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      );
      throw new BrokerSecurityError(
        "SECRET_NOT_FOUND",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Mediates network headers by replacing secret references and template placeholders.
   */
  async mediateHeaders(
    headers: Record<string, string | SecretReference>,
    context: BrokerContext,
  ): Promise<Record<string, string>> {
    if (!headers || headers === null || Array.isArray(headers)) {
      return {};
    }

    const mediatedHeaders: Record<string, string> = {};
    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;

    for (const [key, value] of Object.entries(headers)) {
      const parsedRef = SecretReferenceSchema.safeParse(value);
      if (parsedRef.success) {
        // Direct SecretReference passed as header value
        const isAuthHeader = key.toLowerCase() === "authorization";
        const mode = isAuthHeader ? "bearer_token" : "header_template";
        const secretVal = await this.resolveSecretReference(parsedRef.data, context, mode);
        mediatedHeaders[key] = isAuthHeader ? `Bearer ${secretVal}` : secretVal;
        continue;
      }

      if (String(value) !== value) {
        mediatedHeaders[key] = String(value ?? "");
        continue;
      }

      // Check for Bearer <ref> or Bearer {{secret:...}}
      const bearerRefMatch = value.match(/^Bearer\s+(sec_ref_[A-Za-z0-9_]+)$/i);
      if (bearerRefMatch) {
        const secretVal = await this.resolveSecretReference(
          bearerRefMatch[1],
          context,
          "bearer_token",
        );
        mediatedHeaders[key] = `Bearer ${secretVal}`;
        continue;
      }

      // String header with potential placeholders
      let resolvedHeader = value;
      const matches = Array.from(value.matchAll(placeholderRegex));

      for (const match of matches) {
        const secretName = match[1];
        const isBearerAuth =
          key.toLowerCase() === "authorization" && value.toLowerCase().startsWith("bearer ");
        const mode = isBearerAuth ? "bearer_token" : "header_template";
        const secretValue = await this.authorizeSecretAccess(secretName, context, mode);
        resolvedHeader = resolvedHeader.replace(match[0], secretValue);
      }

      mediatedHeaders[key] = resolvedHeader;
    }

    return mediatedHeaders;
  }

  /**
   * Mediates an Authorization bearer token header directly.
   */
  async mediateBearerToken(
    secretNameOrRef: string | SecretReference,
    context: BrokerContext,
  ): Promise<{ headerName: string; headerValue: string }> {
    const token = await this.resolveSecretReference(secretNameOrRef, context, "bearer_token");
    return {
      headerName: "Authorization",
      headerValue: `Bearer ${token}`,
    };
  }

  /**
   * Mediates a URL by substituting query parameter placeholders with resolved secrets.
   */
  async mediateUrl(
    url: string,
    context: BrokerContext,
    secretReferences?: Record<string, SecretReference>,
  ): Promise<string> {
    if (!url || String(url) !== url) {
      return url;
    }

    let mediatedUrl = url;
    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;
    const matches = Array.from(url.matchAll(placeholderRegex));

    for (const match of matches) {
      const secretName = match[1];
      const secretValue = await this.authorizeSecretAccess(secretName, context, "query_template");
      mediatedUrl = mediatedUrl.replace(match[0], encodeURIComponent(secretValue));
    }

    // Substitute explicit secret references in query params if provided
    if (secretReferences && secretReferences !== null && !Array.isArray(secretReferences)) {
      for (const [paramName, secretRef] of Object.entries(secretReferences)) {
        const secretValue = await this.resolveSecretReference(secretRef, context, "query_template");
        const encodedVal = encodeURIComponent(secretValue);
        // Replace or append param
        const paramRegex = new RegExp(`([?&])${paramName}=([^&#]*)`, "g");
        if (paramRegex.test(mediatedUrl)) {
          mediatedUrl = mediatedUrl.replace(paramRegex, `$1${paramName}=${encodedVal}`);
        } else {
          const separator = mediatedUrl.includes("?") ? "&" : "?";
          mediatedUrl = `${mediatedUrl}${separator}${paramName}=${encodedVal}`;
        }
      }
    }

    return mediatedUrl;
  }

  /**
   * Mediates a string payload for stdin command execution.
   */
  async mediateCommandStdin(
    templateOrRef: string | SecretReference,
    context: BrokerContext,
  ): Promise<string> {
    const parsedRef = SecretReferenceSchema.safeParse(templateOrRef);
    if (parsedRef.success) {
      return this.resolveSecretReference(parsedRef.data, context, "command_stdin");
    }

    if (!templateOrRef || String(templateOrRef) !== templateOrRef) {
      return "";
    }

    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;
    let mediated = templateOrRef;
    const matches = Array.from(templateOrRef.matchAll(placeholderRegex));

    if (matches.length > 0) {
      for (const match of matches) {
        const secretName = match[1];
        const secretValue = await this.authorizeSecretAccess(secretName, context, "command_stdin");
        mediated = mediated.replace(match[0], secretValue);
      }
      return mediated;
    }

    // Direct secret alias name or reference handle passed
    const registeredRef = this.references.get(templateOrRef);
    if (registeredRef) {
      return this.resolveSecretReference(registeredRef, context, "command_stdin");
    }

    return this.authorizeSecretAccess(templateOrRef, context, "command_stdin");
  }

  /**
   * Mediates environment variables for command execution.
   */
  async mediateCommandEnv(
    env: Record<string, string | SecretReference>,
    context: BrokerContext,
  ): Promise<Record<string, string>> {
    const mediatedEnv: Record<string, string> = {};
    const placeholderRegex = /\{\{(?:secret:)?([A-Za-z0-9_\-\.]+)\}\}/g;

    for (const [key, value] of Object.entries(env)) {
      const parsedRef = SecretReferenceSchema.safeParse(value);
      if (parsedRef.success) {
        const secretValue = await this.resolveSecretReference(
          parsedRef.data,
          context,
          "command_env",
        );
        mediatedEnv[key] = secretValue;
        continue;
      }

      if (String(value) !== value) {
        mediatedEnv[key] = String(value ?? "");
        continue;
      }

      let resolvedVal = value;
      const matches = Array.from(value.matchAll(placeholderRegex));

      for (const match of matches) {
        const secretName = match[1];
        const secretValue = await this.authorizeSecretAccess(secretName, context, "command_env");
        resolvedVal = resolvedVal.replace(match[0], secretValue);
      }

      mediatedEnv[key] = resolvedVal;
    }

    // Automatically inject permitted secrets into env if injectAsEnv is set on capability grant
    const grant = context.grant ? this.validateGrant(context) : undefined;
    const secretCap: SecretCapability = grant?.capabilities?.secrets ?? {
      allowedSecretNames: [],
      allowedPrefixes: [],
      denyDirectRead: true,
      injectAsEnv: true,
    };

    if (secretCap.injectAsEnv && secretCap.allowedSecretNames) {
      const workspaceId = context.workspaceId ?? grant?.workspaceId;
      for (const name of secretCap.allowedSecretNames) {
        if (mediatedEnv[name] === undefined) {
          try {
            const secretValue = await this.manager.getSecretForMediation(
              name,
              "command_env",
              workspaceId,
            );
            mediatedEnv[name] = secretValue;
          } catch {
            // Secret may not exist in store, ignore
          }
        }
      }
    }

    return mediatedEnv;
  }

  /**
   * Direct secret read - only permitted for direct host callers when denyDirectRead is explicitly false.
   * Generated workers are always denied direct secret reads.
   */
  async getSecret(secretName: string, context: BrokerContext): Promise<{ secret: string | null }> {
    const startTime = Date.now();

    // Worker contexts are strictly denied direct secret reads regardless of envelope configuration
    if (context.isWorker || context.source === "worker") {
      this.recordAudit(
        "getSecret",
        context,
        "denied",
        {
          secretName,
          reason: "DIRECT_READ_DENIED_FOR_WORKER",
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "DIRECT_READ_DENIED",
            message:
              "Direct reading of secrets is strictly prohibited from worker contexts. Use trusted broker mediation.",
          },
        },
      );
      throw new BrokerSecurityError(
        "DIRECT_READ_DENIED",
        "Direct reading of secrets is strictly prohibited from worker contexts. Use trusted broker mediation.",
      );
    }

    const grant = this.validateGrant(context);
    const secretCap: SecretCapability = grant.capabilities.secrets ?? {};

    if (!secretName) {
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", "Secret name must be specified");
    }

    // Direct read is denied by policy when denyDirectRead is true (default)
    if (secretCap.denyDirectRead !== false) {
      this.recordAudit(
        "getSecret",
        context,
        "denied",
        {
          secretName,
          reason: "DENY_DIRECT_READ",
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "OPERATION_NOT_PERMITTED",
            message: `Direct read of secret '${secretName}' is denied by policy`,
          },
        },
      );
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Direct read of secret '${secretName}' is denied by policy`,
      );
    }

    // Check if secret is authorized
    if (!this.isSecretAuthorized(secretName, secretCap)) {
      this.recordAudit(
        "getSecret",
        context,
        "denied",
        {
          secretName,
          reason: "NOT_AUTHORIZED",
        },
        {
          durationMs: Date.now() - startTime,
          error: {
            code: "OPERATION_NOT_PERMITTED",
            message: `Secret '${secretName}' is not authorized by capability grant`,
          },
        },
      );
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Secret '${secretName}' is not authorized by capability grant`,
      );
    }

    const workspaceId = context.workspaceId ?? grant.workspaceId;
    const val = await this.manager.getStore().getSecret(secretName, workspaceId);
    this.recordAudit(
      "getSecret",
      context,
      "allowed",
      { secretName },
      { durationMs: Date.now() - startTime },
    );

    return { secret: val };
  }

  /**
   * Adds or updates a secret (host-side management API).
   */
  async addSecret(
    name: string,
    value: string,
    options?: SetSecretOptions,
  ): Promise<SecretMetadata> {
    return this.manager.addSecret(name, value, options);
  }

  /**
   * Adds or updates a secret (host-side management API).
   */
  async setSecret(
    name: string,
    value: string,
    options?: SetSecretOptions,
  ): Promise<SecretMetadata> {
    return this.manager.addSecret(name, value, options);
  }

  /**
   * Rotates a secret to a new value (host-side management API).
   */
  async rotateSecret(
    name: string,
    newValue: string,
    workspaceId?: string,
  ): Promise<SecretMetadata> {
    return this.manager.rotateSecret(name, newValue, workspaceId);
  }

  /**
   * Lists non-sensitive secret metadata.
   */
  async listMetadata(contextOrWorkspaceId?: BrokerContext | string): Promise<SecretMetadata[]> {
    const workspaceId = isBrokerContext(contextOrWorkspaceId)
      ? contextOrWorkspaceId.workspaceId
      : contextOrWorkspaceId;
    return this.manager.listMetadata(workspaceId);
  }

  /**
   * Lists non-sensitive secret metadata.
   */
  async listSecrets(contextOrWorkspaceId?: BrokerContext | string): Promise<SecretMetadata[]> {
    return this.listMetadata(contextOrWorkspaceId);
  }
  /**
   * Deletes a secret.
   */
  async deleteSecret(name: string, workspaceId?: string): Promise<boolean> {
    return this.manager.deleteSecret(name, workspaceId);
  }

  /**
   * Returns secret redactor.
   */
  getRedactor(): SecretRedactor {
    return this.manager.getRedactor();
  }

  /**
   * Unified dispatcher for worker RPC requests.
   * Strictly enforces that worker contexts cannot perform direct-read operations.
   */
  async handleRequest(
    action: string,
    payload: BrokerSecretRequestPayload,
    context: BrokerContext,
  ): Promise<BrokerSecretResult> {
    // Flag this context as a worker call
    const workerContext: BrokerContext = { ...context, isWorker: true, source: "worker" };

    switch (action) {
      case "getSecret":
      case "read":
      case "resolve":
      case "resolveSecret":
      case "resolveReference":
      case "resolveSecretReference":
      case "raw":
      case "getRawSecret":
      case "getValue":
      case "getSecretValue": {
        const secretName = String(
          payload.name ?? payload.alias ?? payload.key ?? payload.ref ?? "",
        );
        this.recordAudit(
          "getSecret",
          workerContext,
          "denied",
          {
            action,
            secretName,
            reason: "DIRECT_READ_DENIED_FOR_WORKER",
          },
          {
            error: {
              code: "DIRECT_READ_DENIED",
              message:
                "Direct reading of secrets is strictly prohibited from worker contexts. Use trusted broker mediation.",
            },
          },
        );
        throw new BrokerSecurityError(
          "DIRECT_READ_DENIED",
          "Direct reading of secrets is strictly prohibited from worker contexts. Use trusted broker mediation.",
        );
      }

      case "add":
      case "addSecret":
      case "setSecret":
      case "rotate":
      case "rotateSecret":
      case "delete":
      case "deleteSecret":
      case "purge":
      case "purgeSecrets": {
        this.recordAudit(
          "adminSecretOperation",
          workerContext,
          "denied",
          {
            action,
            secretName: String(payload.name ?? payload.alias ?? payload.key ?? ""),
            reason: "ADMIN_SECRET_OPERATION_DENIED_FROM_WORKER",
          },
          {
            error: {
              code: "OPERATION_NOT_PERMITTED",
              message: `Administrative secret operation '${action}' is not permitted from worker RPC/IPC. Administrative secret management is isolated to authenticated host CLI/daemon control.`,
            },
          },
        );
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Administrative secret operation '${action}' is not permitted from worker RPC/IPC. Administrative secret management is isolated to authenticated host CLI/daemon control.`,
        );
      }

      case "createReference":
      case "createSecretReference": {
        const rawOptions =
          payload.options && payload.options !== null && !Array.isArray(payload.options)
            ? payload.options
            : {};
        // SAFETY: Options conforms to SecretReferenceOptions shape.
        const options = rawOptions as SecretReferenceOptions;
        const name = String(payload.name ?? "");
        return this.createSecretReference(name, workerContext, options);
      }

      case "listReferences": {
        const grant = this.validateGrant(workerContext);
        const secretCap: SecretCapability = grant.capabilities.secrets ?? {};
        const allowedNames = secretCap.allowedSecretNames ?? [];
        return allowedNames.map((name) => this.createSecretReference(name, workerContext));
      }

      case "mediateHeaders":
      case "mediateBearerToken":
      case "mediateUrl":
      case "mediateCommandStdin":
      case "mediateCommandEnv": {
        this.recordAudit(
          "workerMediationResponse",
          workerContext,
          "denied",
          { action, reason: "WORKER_MEDIATION_RESPONSE_DENIED" },
          {
            error: {
              code: "DIRECT_READ_DENIED",
              message:
                "Worker secret mediation must be consumed inside a trusted network or command broker.",
            },
          },
        );
        throw new BrokerSecurityError(
          "DIRECT_READ_DENIED",
          "Worker secret mediation must be consumed inside a trusted network or command broker.",
        );
      }
      default:
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Unsupported secret broker action: '${action}'`,
        );
    }
  }
}
