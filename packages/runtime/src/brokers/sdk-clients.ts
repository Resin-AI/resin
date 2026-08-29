import {
  type SecretMediationMode,
  type SecretReference,
  createSecretReference,
  formatSecretTemplate,
} from "@resin/contracts";
import type { BrokerRequestHandlerFn, BrokeredFetchResponse } from "../worker/sdk.js";
import { bearerToken } from "../worker/sdk.js";
import type { CommandExecuteResult } from "./cmd-broker.js";
import type { FileStatResult, ReadFileResult } from "./fs-broker.js";
import type { NetResponseResult } from "./net-broker.js";

export type { BrokeredFetchResponse } from "../worker/sdk.js";

export interface FsWriteOptions {
  encoding?: "utf-8" | "base64";
  atomic?: boolean;
}

export interface NetRequestOptions {
  method?: string;
  headers?: Record<string, string | SecretReference>;
  body?: string;
  timeoutMs?: number;
  redirect?: "follow" | "error" | "manual";
  maxRedirects?: number;
  auth?: SecretReference | { bearer: SecretReference | string };
  secretReferences?: Record<string, SecretReference>;
}

export interface CommandExecuteOptions {
  cwd?: string;
  env?: Record<string, string | SecretReference>;
  stdin?: string | SecretReference;
  timeoutMs?: number;
  maxOutputSizeBytes?: number;
  secretEnv?: Record<string, SecretReference | string>;
}

/**
 * Client SDK for brokered filesystem operations.
 */
export class FsClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  async readFile(
    filePath: string,
    optionsOrEncoding:
      | "utf-8"
      | "base64"
      | "buffer"
      | { encoding?: "utf-8" | "base64" | "buffer" } = "utf-8",
  ): Promise<string | Uint8Array> {
    const encoding =
      typeof optionsOrEncoding === "string"
        ? optionsOrEncoding
        : (optionsOrEncoding.encoding ?? "utf-8");
    const rpcEncoding = encoding === "buffer" ? "base64" : encoding;
    const res = (await this.requestHandler("fs", "readFile", {
      path: filePath,
      encoding: rpcEncoding,
    })) as ReadFileResult;

    if (encoding === "buffer") {
      if (typeof res.content === "string") {
        return res.encoding === "base64"
          ? typeof Buffer !== "undefined"
            ? new Uint8Array(Buffer.from(res.content, "base64"))
            : Uint8Array.from(atob(res.content), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(res.content);
      }
      return res.content;
    }
    return res.content;
  }

  async readText(filePath: string, encoding: "utf-8" | "base64" = "utf-8"): Promise<string> {
    const res = await this.readFile(filePath, { encoding });
    return typeof res === "string" ? res : new TextDecoder().decode(res);
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    const res = await this.readFile(filePath, { encoding: "base64" });
    if (typeof res === "string") {
      return typeof Buffer !== "undefined"
        ? new Uint8Array(Buffer.from(res, "base64"))
        : Uint8Array.from(atob(res), (c) => c.charCodeAt(0));
    }
    return res;
  }

  async readBuffer(filePath: string): Promise<Buffer> {
    const bytes = await this.readBytes(filePath);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async writeFile(
    filePath: string,
    content: string | Uint8Array | Buffer,
    options: FsWriteOptions = {},
  ): Promise<void> {
    let serializedContent: string;
    let encoding: "utf-8" | "base64" = options.encoding ?? "utf-8";

    if (typeof content === "string") {
      serializedContent = content;
    } else if (content instanceof Uint8Array || Buffer.isBuffer(content)) {
      encoding = "base64";
      serializedContent = Buffer.from(content).toString("base64");
    } else {
      serializedContent = String(content);
    }

    await this.requestHandler("fs", "writeFile", {
      path: filePath,
      content: serializedContent,
      encoding,
      atomic: options.atomic,
    });
  }

  async appendFile(filePath: string, content: string | Uint8Array | Buffer): Promise<void> {
    let serializedContent: string;
    let encoding: "utf-8" | "base64" = "utf-8";

    if (typeof content === "string") {
      serializedContent = content;
    } else if (content instanceof Uint8Array || Buffer.isBuffer(content)) {
      encoding = "base64";
      serializedContent = Buffer.from(content).toString("base64");
    } else {
      serializedContent = String(content);
    }

    await this.requestHandler("fs", "appendFile", {
      path: filePath,
      content: serializedContent,
      encoding,
    });
  }

  async exists(filePath: string): Promise<boolean> {
    const res = (await this.requestHandler("fs", "exists", { path: filePath })) as {
      exists: boolean;
    };
    return res.exists;
  }

  async stat(targetPath: string): Promise<FileStatResult> {
    return (await this.requestHandler("fs", "stat", { path: targetPath })) as FileStatResult;
  }

  async list(dirPath = ".", options: { recursive?: boolean } = {}): Promise<string[]> {
    const res = await this.requestHandler("fs", "listDirectory", {
      path: dirPath,
      recursive: options.recursive,
    });
    if (Array.isArray(res)) {
      return res;
    }
    if (res && typeof res === "object" && "entries" in res && Array.isArray(res.entries)) {
      return res.entries;
    }
    return [];
  }

  async listDirectory(dirPath = ".", options: { recursive?: boolean } = {}): Promise<string[]> {
    return this.list(dirPath, options);
  }

  async listDir(dirPath = "."): Promise<string[]> {
    return this.list(dirPath);
  }

  async mkdir(dirPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.requestHandler("fs", "mkdir", { path: dirPath, recursive: options.recursive });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.requestHandler("fs", "rename", { oldPath, newPath });
  }

  async delete(filePath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.requestHandler("fs", "delete", { path: filePath, recursive: options.recursive });
  }

  async remove(filePath: string, options: { recursive?: boolean } = {}): Promise<void> {
    return this.delete(filePath, options);
  }
}

/**
 * Client SDK for brokered network operations.
 */
export class NetClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  async request(url: string, options: NetRequestOptions = {}): Promise<BrokeredFetchResponse> {
    const raw = (await this.requestHandler("net", "request", {
      url,
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      auth: options.auth,
      secretReferences: options.secretReferences,
      timeoutMs: options.timeoutMs,
      redirect: options.redirect,
      maxRedirects: options.maxRedirects,
    })) as NetResponseResult;

    return {
      status: raw.status,
      statusText: raw.statusText,
      headers: raw.headers,
      ok: raw.status >= 200 && raw.status < 300,
      url: raw.finalUrl,
      redirected: raw.redirected,
      text: async () => raw.body,
      json: async <T = unknown>() => JSON.parse(raw.body) as T,
      arrayBuffer: async () => {
        const buf =
          typeof Buffer !== "undefined"
            ? Buffer.from(raw.body, "utf-8")
            : new TextEncoder().encode(raw.body);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      bytes: async () => {
        return typeof Buffer !== "undefined"
          ? new Uint8Array(Buffer.from(raw.body, "utf-8"))
          : new TextEncoder().encode(raw.body);
      },
    };
  }

  async fetch(url: string, options: NetRequestOptions = {}): Promise<BrokeredFetchResponse> {
    return this.request(url, options);
  }

  async get(
    url: string,
    headers: Record<string, string | SecretReference> = {},
  ): Promise<BrokeredFetchResponse> {
    return this.request(url, { method: "GET", headers });
  }

  async post(
    url: string,
    body: string | Record<string, unknown>,
    headers: Record<string, string | SecretReference> = {},
  ): Promise<BrokeredFetchResponse> {
    const serializedBody = typeof body === "object" ? JSON.stringify(body) : body;
    const finalHeaders =
      typeof body === "object" && !headers["Content-Type"] && !headers["content-type"]
        ? { ...headers, "Content-Type": "application/json" }
        : headers;

    return this.request(url, { method: "POST", headers: finalHeaders, body: serializedBody });
  }

  async put(
    url: string,
    body: string | Record<string, unknown>,
    headers: Record<string, string | SecretReference> = {},
  ): Promise<BrokeredFetchResponse> {
    const serializedBody = typeof body === "object" ? JSON.stringify(body) : body;
    const finalHeaders =
      typeof body === "object" && !headers["Content-Type"] && !headers["content-type"]
        ? { ...headers, "Content-Type": "application/json" }
        : headers;

    return this.request(url, { method: "PUT", headers: finalHeaders, body: serializedBody });
  }

  async delete(
    url: string,
    headers: Record<string, string | SecretReference> = {},
  ): Promise<BrokeredFetchResponse> {
    return this.request(url, { method: "DELETE", headers });
  }
}

/**
 * Client SDK for brokered command execution.
 */
export class CommandClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  async execute(
    executable: string,
    args: string[] = [],
    options: CommandExecuteOptions = {},
  ): Promise<CommandExecuteResult> {
    return (await this.requestHandler("cmd", "execute", {
      executable,
      args,
      ...options,
    })) as CommandExecuteResult;
  }

  async exec(
    command: string,
    args: string[] = [],
    options: CommandExecuteOptions = {},
  ): Promise<CommandExecuteResult> {
    return this.execute(command, args, options);
  }
}

/**
 * Client SDK for brokered secret references and mediation.
 */
export class SecretClient {
  constructor(private readonly requestHandler: BrokerRequestHandlerFn) {}

  /**
   * Creates an opaque secret reference.
   */
  createReference(
    name: string,
    options?: {
      modes?: SecretMediationMode[];
      workspaceId?: string;
      toolId?: string;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
    },
  ): SecretReference {
    return createSecretReference({
      name,
      permittedModes: options?.modes,
      workspaceId: options?.workspaceId,
      toolId: options?.toolId,
      expiresAt: options?.expiresAt,
      metadata: options?.metadata,
    });
  }

  /**
   * Creates a bearer token reference.
   */
  bearerToken(nameOrRef: string | SecretReference): SecretReference {
    return bearerToken(nameOrRef);
  }

  /**
   * Formats a query parameter or header template placeholder.
   */
  template(nameOrRef: string | SecretReference): string {
    return formatSecretTemplate(nameOrRef);
  }

  /**
   * Legacy getSecret method - fails closed for worker callers.
   */
  async getSecret(name: string): Promise<string | null> {
    const res = (await this.requestHandler("secret", "getSecret", { name })) as {
      secret: string | null;
    };
    return res.secret;
  }
}

/**
 * Creates the complete suite of SDK clients bound to a request handler function.
 */
export function createBrokerClients(requestHandler: BrokerRequestHandlerFn): {
  fs: FsClient;
  net: NetClient;
  cmd: CommandClient;
  secret: SecretClient;
} {
  return {
    fs: new FsClient(requestHandler),
    net: new NetClient(requestHandler),
    cmd: new CommandClient(requestHandler),
    secret: new SecretClient(requestHandler),
  };
}
