import {
  type CanonicalJsonRecord,
  type CanonicalJsonValue,
  type OpaqueSecretRef,
  type SecretMediationMode,
  type SecretMetadataRecord,
  type SecretReference,
  createOpaqueSecretRef,
  createSecretReference,
  formatSecretTemplate,
  isSecretReference,
} from "@resin/contracts";
import type { WorkerMessageType } from "./protocol.js";

// Re-export secret reference types and helpers for tool authors
export {
  type SecretReference,
  type OpaqueSecretRef,
  type SecretMediationMode,
  type SecretMetadataRecord,
  createSecretReference,
  createOpaqueSecretRef,
  isSecretReference,
  formatSecretTemplate,
};

/**
 * Brokered file system client interface.
 */
export interface FsBrokerClient {
  readFile(
    filePath: string,
    encoding?: "utf-8" | "base64" | "buffer",
  ): Promise<string | Uint8Array>;
  writeFile(filePath: string, content: string | Uint8Array): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  listDir(dirPath?: string): Promise<string[]>;
  stat(
    targetPath: string,
  ): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtime: string }>;
  removeFile(filePath: string): Promise<void>;
}

/**
 * Brokered HTTP fetch response wrapper.
 */
export interface BrokeredFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  ok?: boolean;
  url?: string;
  redirected?: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  bytes?(): Promise<Uint8Array>;
}

/**
 * Brokered network client interface.
 */
export interface NetBrokerClient {
  fetch(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string | SecretReference>;
      body?: string;
      auth?: SecretReference | { bearer: SecretReference | string };
      secretReferences?: Record<string, SecretReference>;
      timeoutMs?: number;
      redirect?: "follow" | "error" | "manual";
      maxRedirects?: number;
    },
  ): Promise<BrokeredFetchResponse>;
}

/**
 * Brokered command execution client interface.
 */
export interface CmdBrokerClient {
  exec(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | SecretReference>;
      stdin?: string | SecretReference;
      timeoutMs?: number;
      maxOutputSizeBytes?: number;
      secretEnv?: Record<string, SecretReference | string>;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Brokered secret and credential client interface.
 * Exposes non-disclosing secret references and template builders.
 */
export interface SecretBrokerClient {
  /**
   * Creates an opaque, non-disclosing secret reference for use with net/cmd brokers.
   */
  createReference(
    name: string,
    options?: {
      modes?: SecretMediationMode[];
      workspaceId?: string;
      toolId?: string;
      expiresAt?: string;
      metadata?: SecretMetadataRecord;
    },
  ): SecretReference;

  /**
   * Creates a bearer token reference.
   */
  bearerToken(nameOrRef: string | SecretReference): SecretReference;

  /**
   * Formats a query parameter or header template placeholder.
   */
  template(nameOrRef: string | SecretReference): string;

  /**
   * Helper to build an opaque environment variable secret reference.
   */
  envSecret?(nameOrRef: string | SecretReference): SecretReference;

  /**
   * Helper to build an opaque command stdin secret reference.
   */
  stdinSecret?(nameOrRef: string | SecretReference): SecretReference;
}

/**
 * Helper to build an opaque Bearer Authorization secret reference.
 */
function isSecretRefObject(val: string | SecretReference): val is SecretReference {
  return Object.prototype.toString.call(val) !== "[object String]";
}

export function bearerToken(nameOrRef: string | SecretReference): SecretReference {
  if (isSecretRefObject(nameOrRef)) {
    return nameOrRef;
  }
  return createSecretReference({
    name: nameOrRef,
    permittedModes: ["bearer_token", "header_template"],
  });
}

/**
 * Helper to build an opaque URL query parameter secret template string.
 */
export function querySecret(nameOrRef: string | SecretReference): string {
  return formatSecretTemplate(nameOrRef);
}

/**
 * Helper to build an opaque command stdin secret reference.
 */
export function stdinSecret(nameOrRef: string | SecretReference): SecretReference {
  if (isSecretRefObject(nameOrRef)) {
    return nameOrRef;
  }
  return createSecretReference({
    name: nameOrRef,
    permittedModes: ["command_stdin"],
  });
}

/**
 * Helper to build an opaque environment variable secret reference.
 */
export function envSecret(nameOrRef: string | SecretReference): SecretReference {
  if (isSecretRefObject(nameOrRef)) {
    return nameOrRef;
  }
  return createSecretReference({
    name: nameOrRef,
    permittedModes: ["command_env"],
  });
}

/**
 * Unified tool broker client interface.
 */
export interface ToolBrokerClient {
  fs: FsBrokerClient;
  net: NetBrokerClient;
  cmd: CmdBrokerClient;
  secret: SecretBrokerClient;
}

/**
 * Tool logger interface.
 */
export interface ToolLogger {
  debug(message: string, data?: CanonicalJsonValue): Promise<void>;
  info(message: string, data?: CanonicalJsonValue): Promise<void>;
  warn(message: string, data?: CanonicalJsonValue): Promise<void>;
  error(message: string, data?: CanonicalJsonValue): Promise<void>;
}

/**
 * Execution context passed to generated tool entrypoints.
 */
export interface ToolContext<TInput = unknown> {
  readonly input: TInput;
  readonly invocationId: string;
  readonly workspaceRoot: string;
  readonly scratchDir: string;
  readonly metadata?: CanonicalJsonRecord;
  readonly progress: (percent: number, message?: string, stage?: string) => Promise<void>;
  readonly log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: CanonicalJsonValue,
  ) => Promise<void>;
  readonly logger: ToolLogger;
  readonly broker: ToolBrokerClient;
  readonly fs: FsBrokerClient;
  readonly net: NetBrokerClient;
  readonly cmd: CmdBrokerClient;
  readonly secret: SecretBrokerClient;
}

/**
 * Tool entrypoint function signature.
 */
export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  context: ToolContext<TInput>,
) => Promise<TOutput> | TOutput;

export interface LegacyToolDefinition<TInput = unknown, TOutput = unknown> {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  handler: (input: TInput, context: ToolContext<TInput>) => Promise<TOutput> | TOutput;
}

/**
 * Defines the canonical generated-tool ABI. New tools export a context-first
 * handler. Legacy descriptor objects are adapted at definition time so the
 * Deno bootstrap always receives one callable default export.
 */
function isToolHandlerFunction<TInput, TOutput>(
  value: ToolHandler<TInput, TOutput> | LegacyToolDefinition<TInput, TOutput>,
): value is ToolHandler<TInput, TOutput> {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Function]" || tag === "[object AsyncFunction]";
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  handlerOrDefinition: ToolHandler<TInput, TOutput> | LegacyToolDefinition<TInput, TOutput>,
): ToolHandler<TInput, TOutput> {
  if (isToolHandlerFunction(handlerOrDefinition)) {
    return handlerOrDefinition;
  }
  if (
    !handlerOrDefinition ||
    Object.prototype.toString.call(handlerOrDefinition.handler) !== "[object Function]"
  ) {
    throw new TypeError("defineTool requires a callable handler");
  }
  return (context: ToolContext<TInput>) => handlerOrDefinition.handler(context.input, context);
}

export type BrokerRequestHandlerFn = (
  service: "fs" | "net" | "cmd" | "secret",
  action: string,
  payload?: CanonicalJsonRecord,
) => Promise<CanonicalJsonValue>;

/**
 * Concrete implementation of ToolBrokerClient backed by a request handler function.
 */
export class DefaultToolBrokerClient implements ToolBrokerClient {
  constructor(private readonly handler: BrokerRequestHandlerFn) {}

  private async request<T = CanonicalJsonValue>(
    service: "fs" | "net" | "cmd" | "secret",
    action: string,
    payload: CanonicalJsonRecord = {},
  ): Promise<T> {
    // SAFETY: Broker handler returns payload compatible with expected T.
    return (await this.handler(service, action, payload)) as T;
  }

  readonly fs: FsBrokerClient = {
    readFile: async (filePath: string, encoding: "utf-8" | "base64" | "buffer" = "utf-8") => {
      const res = await this.request<{ content: string | Uint8Array }>("fs", "readFile", {
        path: filePath,
        encoding,
      });
      return res.content;
    },
    writeFile: async (filePath: string, content: string | Uint8Array) => {
      const isString = Object.prototype.toString.call(content) === "[object String]";
      // SAFETY: Tag check confirms content is a string primitive.
      const payloadContent = isString
        ? (content as string)
        : Buffer.from(content).toString("base64");
      const encoding = isString ? "utf-8" : "base64";
      await this.request("fs", "writeFile", { path: filePath, content: payloadContent, encoding });
    },
    exists: async (filePath: string) => {
      const res = await this.request<{ exists: boolean }>("fs", "exists", { path: filePath });
      return res.exists;
    },
    listDir: async (dirPath = ".") => {
      const res = await this.request<{ entries: string[] }>("fs", "listDir", { path: dirPath });
      return res.entries;
    },
    stat: async (targetPath: string) => {
      return await this.request<{
        size: number;
        isFile: boolean;
        isDirectory: boolean;
        mtime: string;
      }>("fs", "stat", { path: targetPath });
    },
    removeFile: async (filePath: string) => {
      await this.request("fs", "removeFile", { path: filePath });
    },
  };

  readonly net: NetBrokerClient = {
    fetch: async (
      url: string,
      init?: {
        method?: string;
        headers?: Record<string, string | SecretReference>;
        body?: string;
        auth?: SecretReference | { bearer: SecretReference | string };
        secretReferences?: Record<string, SecretReference>;
        timeoutMs?: number;
        redirect?: "follow" | "error" | "manual";
        maxRedirects?: number;
      },
    ): Promise<BrokeredFetchResponse> => {
      const raw = await this.request<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
        bytesReceived: number;
        redirected: boolean;
        finalUrl: string;
      }>("net", "fetch", {
        url,
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        auth: init?.auth,
        secretReferences: init?.secretReferences,
        timeoutMs: init?.timeoutMs,
        redirect: init?.redirect,
        maxRedirects: init?.maxRedirects,
      });

      return {
        status: raw.status,
        statusText: raw.statusText,
        headers: raw.headers,
        ok: raw.status >= 200 && raw.status < 300,
        url: raw.finalUrl,
        redirected: raw.redirected,
        text: async () => raw.body,
        // SAFETY: Parsed JSON response body conforms to caller requested type T.
        json: async <T = CanonicalJsonValue>() => JSON.parse(raw.body) as T,
        arrayBuffer: async () => {
          const buf =
            globalThis.Buffer !== undefined
              ? globalThis.Buffer.from(raw.body, "utf-8")
              : new TextEncoder().encode(raw.body);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        bytes: async () => {
          return globalThis.Buffer !== undefined
            ? new Uint8Array(globalThis.Buffer.from(raw.body, "utf-8"))
            : new TextEncoder().encode(raw.body);
        },
      };
    },
  };

  readonly cmd: CmdBrokerClient = {
    exec: async (
      command: string,
      args: string[] = [],
      options: {
        cwd?: string;
        env?: Record<string, string | SecretReference>;
        stdin?: string | SecretReference;
        timeoutMs?: number;
        maxOutputSizeBytes?: number;
        secretEnv?: Record<string, SecretReference | string>;
      } = {},
    ) => {
      return await this.request<{ exitCode: number; stdout: string; stderr: string }>(
        "cmd",
        "exec",
        {
          command,
          args,
          ...options,
        },
      );
    },
  };

  readonly secret: SecretBrokerClient = {
    createReference: (
      name: string,
      options?: {
        modes?: SecretMediationMode[];
        workspaceId?: string;
        toolId?: string;
        expiresAt?: string;
        metadata?: SecretMetadataRecord;
      },
    ): SecretReference => {
      return createSecretReference({
        name,
        permittedModes: options?.modes,
        workspaceId: options?.workspaceId,
        toolId: options?.toolId,
        expiresAt: options?.expiresAt,
        metadata: options?.metadata,
      });
    },

    bearerToken: (nameOrRef: string | SecretReference): SecretReference => {
      return bearerToken(nameOrRef);
    },

    template: (nameOrRef: string | SecretReference): string => {
      return formatSecretTemplate(nameOrRef);
    },

    envSecret: (nameOrRef: string | SecretReference): SecretReference => {
      return envSecret(nameOrRef);
    },

    stdinSecret: (nameOrRef: string | SecretReference): SecretReference => {
      return stdinSecret(nameOrRef);
    },
  };
}

export interface CreateToolContextOptions<TInput = unknown> {
  input: TInput;
  invocationId: string;
  workspaceRoot: string;
  scratchDir?: string;
  metadata?: CanonicalJsonRecord;
  onProgress?: (percent: number, message?: string, stage?: string) => void | Promise<void>;
  onLog?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: CanonicalJsonValue,
  ) => void | Promise<void>;
  brokerHandler?: BrokerRequestHandlerFn;
  requestHandler?: BrokerRequestHandlerFn;
  onMessage?: (type: WorkerMessageType, payload: CanonicalJsonValue) => void;
}

/**
 * Creates a standard ToolContext object for executing a tool.
 */
export function createToolContext<TInput = unknown>(
  optionsOrInput: CreateToolContextOptions<TInput> | TInput,
  legacyOptions?: {
    invocationId: string;
    workspaceRoot: string;
    scratchDir?: string;
    requestHandler?: BrokerRequestHandlerFn;
    brokerHandler?: BrokerRequestHandlerFn;
    onProgress?: (percent: number, message?: string, stage?: string) => void | Promise<void>;
    onLog?: (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      data?: CanonicalJsonValue,
    ) => void | Promise<void>;
    onMessage?: (type: WorkerMessageType, payload: CanonicalJsonValue) => void;
  },
): ToolContext<TInput> {
  // SAFETY: Object tag check confirms optionsOrInput is an object for property checks.
  const isOptionsObject =
    legacyOptions === undefined &&
    Object.prototype.toString.call(optionsOrInput) === "[object Object]" &&
    "invocationId" in (optionsOrInput as object) &&
    "workspaceRoot" in (optionsOrInput as object);
  // SAFETY: isOptionsObject tag check and key presence verify options shape.
  const options: CreateToolContextOptions<TInput> = isOptionsObject
    ? (optionsOrInput as CreateToolContextOptions<TInput>)
    : {
        // SAFETY: Fallback branch treats optionsOrInput directly as TInput.
        input: optionsOrInput as TInput,
        invocationId: legacyOptions?.invocationId ?? "",
        workspaceRoot: legacyOptions?.workspaceRoot ?? process.cwd(),
        scratchDir: legacyOptions?.scratchDir,
        requestHandler: legacyOptions?.requestHandler ?? legacyOptions?.brokerHandler,
        onProgress: legacyOptions?.onProgress,
        onLog: legacyOptions?.onLog,
        onMessage: legacyOptions?.onMessage,
      };

  const handler =
    options.requestHandler ??
    options.brokerHandler ??
    (async () => {
      throw new Error("No broker handler configured for sandbox");
    });
  const brokerClient = new DefaultToolBrokerClient(handler);

  const progressFn = async (percent: number, message?: string, stage?: string) => {
    if (options.onProgress) {
      await options.onProgress(percent, message, stage);
    }
    options.onMessage?.("progress", { percent, message, stage });
  };

  const logFn = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: CanonicalJsonValue,
  ) => {
    if (options.onLog) {
      await options.onLog(level, message, data);
    }
    options.onMessage?.("log", { level, message, data });
  };

  const logger: ToolLogger = {
    debug: async (msg, data) => logFn("debug", msg, data),
    info: async (msg, data) => logFn("info", msg, data),
    warn: async (msg, data) => logFn("warn", msg, data),
    error: async (msg, data) => logFn("error", msg, data),
  };

  return {
    input: options.input,
    invocationId: options.invocationId,
    workspaceRoot: options.workspaceRoot,
    scratchDir: options.scratchDir ?? options.workspaceRoot,
    metadata: options.metadata,
    progress: progressFn,
    log: logFn,
    logger,
    broker: brokerClient,
    fs: brokerClient.fs,
    net: brokerClient.net,
    cmd: brokerClient.cmd,
    secret: brokerClient.secret,
  };
}
