import http from "node:http";
import https from "node:https";

export interface TransportRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array | Blob;
  readonly signal?: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** A fetch-shaped sender. The global `fetch` satisfies it; tests supply fakes. */
export type ReportingTransport = (
  url: string,
  init: TransportRequest,
) => Promise<TransportResponse>;

/** A transport whose in-flight requests can be dropped once a caller's wait is over. */
export interface CancellableTransport extends ReportingTransport {
  /** Destroys every in-flight request (a pending TCP connect included). */
  cancelPending(): void;
}

export function isCancellableTransport(
  transport: ReportingTransport,
): transport is CancellableTransport {
  return "cancelPending" in transport && typeof transport.cancelPending === "function";
}

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

async function toBuffer(body: TransportRequest["body"]): Promise<Buffer | undefined> {
  if (body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(await body.arrayBuffer());
}

/**
 * Sends requests with `node:http(s)`. A slow or black-holed ingest host must never keep a
 * short-lived process (CLI, installer) alive: sockets are unref'd, every request is destroyed
 * after `timeoutMs`, and `cancelPending()` destroys in-flight requests at once. Destroying is what
 * matters: a pending TCP connect is an active libuv request that keeps the process alive even on
 * an unref'd socket, until the socket is closed.
 */
export function createUnrefTransport(timeoutMs: number = DEFAULT_TIMEOUT_MS): CancellableTransport {
  const pending = new Set<http.ClientRequest>();
  const send: ReportingTransport = async (url, init) => {
    const body = await toBuffer(init.body);
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    return new Promise<TransportResponse>((resolve, reject) => {
      const request = client.request(
        target,
        {
          method: init.method,
          headers: body ? { ...init.headers, "Content-Length": String(body.length) } : init.headers,
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: response.statusCode ?? 0,
              text: async () => text,
              json: async () => JSON.parse(text),
            });
          });
        },
      );
      pending.add(request);
      request.on("close", () => pending.delete(request));
      request.on("socket", (socket) => socket.unref());
      request.on("timeout", () => request.destroy(new Error("request timed out")));
      request.on("error", reject);
      const onAbort = () => request.destroy(new Error("request aborted"));
      init.signal?.addEventListener("abort", onAbort, { once: true });
      request.end(body);
    });
  };
  return Object.assign(send, {
    cancelPending: () => {
      for (const request of pending) request.destroy(new Error("request cancelled"));
      pending.clear();
    },
  });
}
