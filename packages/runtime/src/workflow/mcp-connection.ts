/**
 * A live MCP client: the Model Context Protocol reached over a stdio child process or over
 * streamable HTTP.
 *
 * A recorded call names the tool and the connection it was reached through; re-running it means
 * asking that server again, not replaying the text of an earlier answer. The client speaks the
 * revision the record was written against (`2024-11-05`), initializes before any tool call,
 * and bounds both the time a request may take and the number of requests that may be outstanding,
 * so an unreachable or stalling server fails a step instead of pinning a run.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { type Interface, createInterface } from "node:readline";
import type { WorkflowJsonValue } from "@resin/contracts";

export interface McpServerDescriptor {
  name: string;
  transport:
    | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { kind: "http"; url: string; headers?: Record<string, string> };
}

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolConnection {
  readonly name: string;
  listTools(): Promise<McpToolSummary[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowJsonValue>;
  close(): Promise<void>;
}

/** The protocol revision this client speaks: the one the recorded calls were made against. */
const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Hard cap on requests awaiting an answer; a server that stops answering cannot grow this map. */
const MAX_IN_FLIGHT_REQUESTS = 16;
const MAX_DIAGNOSTIC_CHARS = 4_096;
/** How long a stdio server gets to exit on its own before it is killed. */
const CLOSE_GRACE_MS = 2_000;

type JsonRpcParams = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: JsonRpcParams;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonRpcParams;
}

/**
 * One protocol exchange. It resolves with the response message and rejects when the transport
 * itself failed — a timeout, a closed connection, an HTTP status that is not an answer.
 */
interface McpTransport {
  exchange(
    request: JsonRpcRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  /** Sends a JSON-RPC notification: no id, and no response is expected. */
  notify(notification: JsonRpcNotification, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON-RPC error, as a message. The code is included when the server sent one. */
function describeFailure(error: unknown): string {
  if (!isPlainObject(error))
    return typeof error === "string" ? error : (JSON.stringify(error) ?? "");
  const message = typeof error.message === "string" ? error.message : "no message";
  const code =
    typeof error.code === "number" || typeof error.code === "string" ? error.code : undefined;
  return code === undefined ? message : `${message} (code ${code})`;
}

/** The first text content part of a tool result, if it has one. */
function readTextPart(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return undefined;
}

function parseToolText(text: string): WorkflowJsonValue {
  try {
    return JSON.parse(text) as WorkflowJsonValue;
  } catch {
    // Non-JSON tool output is an exact value; whitespace is observable.
    return text;
  }
}

function readToolResult(result: unknown, toolName: string): WorkflowJsonValue {
  const fields = isPlainObject(result) ? result : {};
  const text = readTextPart(fields.content);
  if (fields.isError === true) {
    const reported = text === undefined ? "" : `: ${text.slice(0, MAX_DIAGNOSTIC_CHARS)}`;
    throw new Error(`MCP tool '${toolName}' reported an error${reported}`);
  }
  if (text === undefined) {
    throw new Error(`MCP tool '${toolName}' returned no text content to read`);
  }
  return parseToolText(text);
}

function parseJsonObject(body: string, where: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`MCP server at ${where} answered with content that is not a JSON-RPC message`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`MCP server at ${where} answered with content that is not a JSON-RPC message`);
  }
  return parsed;
}

/** The response inside a streamable-HTTP event stream, matched by request id when it carries one. */
function readStreamMessage(
  body: string,
  expectedId: number,
  where: string,
): Record<string, unknown> {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A keep-alive or a partial event is not a response.
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    if (parsed.id === undefined || parsed.id === expectedId) return parsed;
  }
  throw new Error(`MCP server at ${where} streamed no response to this request`);
}

function createStdioTransport(transport: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): McpTransport {
  const label = `MCP server '${transport.command}'`;
  const child: ChildProcess = spawn(transport.command, transport.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...transport.env },
    windowsHide: true,
  });
  const pending = new Map<
    number,
    {
      resolve: (message: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let failure: Error | undefined;
  let closer: (() => void) | undefined;
  let stderrText = "";

  const failEverything = (error: Error): void => {
    failure ??= error;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
    closer?.();
  };

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText = (stderrText + chunk.toString("utf8")).slice(-MAX_DIAGNOSTIC_CHARS);
  });
  child.on("error", (error: Error) => {
    failEverything(new Error(`${label} could not be started: ${error.message}`));
  });
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    const detail = stderrText.trim();
    const how = signal ? `signal ${signal}` : `code ${String(code)}`;
    failEverything(new Error(`${label} exited (${how})${detail.length > 0 ? `: ${detail}` : ""}`));
  });

  const lines: Interface = createInterface({ input: child.stdout!, terminal: false });
  lines.on("line", (line: string) => {
    const text = line.trim();
    if (text.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A banner printed to stdout is not a protocol message.
      return;
    }
    if (!isPlainObject(parsed)) return;
    const id = parsed.id;
    // Notifications, and server-initiated requests this client does not advertise support for.
    if (typeof id !== "number") return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(parsed);
  });

  const writeLine = (message: unknown): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error(`${label} cannot be written to: stdin is closed`));
        return;
      }
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(new Error(`${label} could not be written to: ${error.message}`));
          return;
        }
        resolve();
      });
    });

  return {
    async exchange(request, timeoutMs, signal) {
      if (failure) throw failure;
      if (signal?.aborted) throw new Error(`${label} request was cancelled`);
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
        const onAbort = (): void => {
          const entry = pending.get(request.id);
          if (!entry) return;
          pending.delete(request.id);
          clearTimeout(entry.timer);
          cleanup();
          entry.reject(new Error(`${label} request was cancelled`));
        };
        const timer = setTimeout(() => {
          pending.delete(request.id);
          cleanup();
          reject(new Error(`${label} did not answer '${request.method}' within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(request.id, {
          resolve: (response) => {
            cleanup();
            resolve(response);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
          timer,
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        writeLine(request).catch((error: Error) => {
          const entry = pending.get(request.id);
          if (!entry) return;
          pending.delete(request.id);
          clearTimeout(entry.timer);
          entry.reject(error);
        });
      });
    },
    async notify(notification) {
      if (failure) throw failure;
      await writeLine(notification);
    },
    async close() {
      failEverything(new Error(`${label} was closed`));
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const escalate = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, CLOSE_GRACE_MS);
        escalate.unref();
      }
    },
  };
}

function createHttpTransport(transport: {
  url: string;
  headers?: Record<string, string>;
}): McpTransport {
  // Streamable HTTP is stateful through a session id the server hands out while initializing.
  let sessionId: string | undefined;
  let closed = false;
  const headersFor = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...transport.headers,
  });

  return {
    async exchange(request, timeoutMs, signal) {
      if (closed) throw new Error(`MCP server at ${transport.url} is closed`);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await fetch(transport.url, {
          method: "POST",
          headers: headersFor(),
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const answeredSession = response.headers.get("mcp-session-id");
        if (answeredSession) sessionId = answeredSession;
        const body = await response.text();
        if (!response.ok) {
          const answered = body.slice(0, MAX_DIAGNOSTIC_CHARS);
          throw new Error(
            `MCP server at ${transport.url} answered ${response.status} ${response.statusText}: ${answered}`,
          );
        }
        const contentType = response.headers.get("content-type") ?? "";
        return contentType.includes("text/event-stream")
          ? readStreamMessage(body, request.id, transport.url)
          : parseJsonObject(body, transport.url);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(
            signal?.aborted
              ? `MCP server at ${transport.url} request was cancelled`
              : `MCP server at ${transport.url} did not answer '${request.method}' within ${timeoutMs}ms`,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
    async notify(notification, timeoutMs) {
      if (closed) throw new Error(`MCP server at ${transport.url} is closed`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(transport.url, {
          method: "POST",
          headers: headersFor(),
          body: JSON.stringify(notification),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `MCP server at ${transport.url} refused '${notification.method}': ` +
              `${response.status} ${response.statusText}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      closed = true;
    },
  };
}

class McpClient implements McpToolConnection {
  private inFlight = 0;
  private nextId = 1;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly transport: McpTransport,
  ) {}

  /** Speaks the handshake before any tool call: `initialize`, then the initialized notification. */
  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "resin-runtime", version: "0.1.0" },
    });
    await this.transport.notify(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  async listTools(): Promise<McpToolSummary[]> {
    const result = await this.request("tools/list", {});
    const listed = isPlainObject(result) && Array.isArray(result.tools) ? result.tools : [];
    const tools: McpToolSummary[] = [];
    for (const entry of listed) {
      if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0)
        continue;
      tools.push({
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(isPlainObject(entry.inputSchema) ? { inputSchema: entry.inputSchema } : {}),
      });
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowJsonValue> {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
    );
    return readToolResult(result, name);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.transport.close();
  }

  private async request(
    method: string,
    params: JsonRpcParams,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new Error(`MCP connection '${this.name}' is closed`);
    if (this.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      throw new Error(
        `MCP connection '${this.name}' already has ${this.inFlight} requests in flight ` +
          `(cap ${MAX_IN_FLIGHT_REQUESTS}); '${method}' was not sent`,
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    this.inFlight += 1;
    try {
      const response = await this.transport.exchange(
        { jsonrpc: "2.0", id, method, params },
        timeoutMs,
        signal,
      );
      if (response.error !== undefined) {
        throw new Error(
          `MCP '${method}' on '${this.name}' failed: ${describeFailure(response.error)}`,
        );
      }
      return response.result;
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** Connects, initializes and returns a live connection; a failed handshake closes the transport. */
export async function connectMcpServer(
  descriptor: McpServerDescriptor,
): Promise<McpToolConnection> {
  const transport =
    descriptor.transport.kind === "stdio"
      ? createStdioTransport(descriptor.transport)
      : createHttpTransport(descriptor.transport);
  const client = new McpClient(descriptor.name, transport);
  try {
    await client.initialize();
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}
