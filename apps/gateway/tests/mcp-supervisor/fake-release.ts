/**
 * A fake installed Resin layout for supervisor tests: `versions/v<version>/bin/resin` entries that
 * speak MCP over stdio like a gateway, plus the `current` pointer the installer writes. Synthetic
 * only; the fake gateway logs every line it receives to `received.jsonl` in its release directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PassThrough } from "node:stream";

export type FakeGatewayMode = "ok" | "refuse-initialize" | "exit-on-initialize";

/**
 * The fake gateway. `tools/call`:
 * - `whoami` answers with its version, the initialize params it got, whether it saw
 *   `notifications/initialized`, its arguments, working directory and supervisor protocol.
 * - `slow` asks the client `roots/list` and answers once the client replied.
 * - `echo` answers at once; with `deferred: true` it waits for the same `roots/list` reply.
 * A `notifications/cancelled` for a pending `slow` call makes it exit without answering.
 */
function fakeGatewaySource(version: string, mode: FakeGatewayMode): string {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const VERSION = ${JSON.stringify(version)};
const MODE = ${JSON.stringify(mode)};
const log = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "received.jsonl");
let initParams = null;
let sawInitialized = false;
let nextServerId = 0;
let rootsRequestId = null;
const waiting = [];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const askRoots = () => {
  if (rootsRequestId !== null) return;
  rootsRequestId = nextServerId++;
  send({ id: rootsRequestId, method: "roots/list" });
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(line) {
  fs.appendFileSync(log, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (MODE === "exit-on-initialize") process.exit(3);
    if (MODE === "refuse-initialize") {
      send({ id: message.id, error: { code: -32600, message: "refused" } });
      return;
    }
    initParams = message.params;
    send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake-resin", version: VERSION },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    sawInitialized = true;
    return;
  }
  if (message.method === "notifications/cancelled") {
    if (waiting.some((entry) => entry.id === message.params.requestId)) process.exit(0);
    return;
  }
  if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: [{ name: "tool_" + VERSION.replaceAll(".", "_") }] } });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params.name;
    const args = message.params.arguments ?? {};
    if (name === "whoami") {
      send({
        id: message.id,
        result: text({
          version: VERSION,
          initParams,
          sawInitialized,
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          protocol: process.env.RESIN_MCP_SUPERVISOR ?? null,
        }),
      });
      return;
    }
    if (name === "slow" || (name === "echo" && args.deferred === true)) {
      waiting.push({ id: message.id });
      askRoots();
      return;
    }
    if (name === "echo") {
      send({ id: message.id, result: text({ version: VERSION }) });
      return;
    }
  }
  if ("id" in message && !("method" in message) && message.id === rootsRequestId) {
    rootsRequestId = null;
    for (const entry of waiting.splice(0)) {
      send({ id: entry.id, result: text({ version: VERSION, roots: message.result.roots }) });
    }
    return;
  }
  if ("id" in message && "method" in message) {
    send({ id: message.id, error: { code: -32601, message: "unknown method" } });
  }
}
`;
}

export interface FakeInstall {
  readonly root: string;
  readonly resinHome: string;
  install: (version: string, mode?: FakeGatewayMode) => void;
  activate: (version: string) => void;
  received: (version: string) => unknown[];
  receivedLines: (version: string) => string[];
  cleanup: () => void;
}

export function createFakeInstall(): FakeInstall {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-mcp-supervisor-"));
  const resinHome = path.join(root, ".resin");
  fs.mkdirSync(path.join(resinHome, "versions"), { recursive: true });
  const releaseDir = (version: string) => path.join(resinHome, "versions", `v${version}`);
  const receivedLines = (version: string): string[] => {
    try {
      return fs
        .readFileSync(path.join(releaseDir(version), "received.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "");
    } catch {
      return [];
    }
  };
  return {
    root,
    resinHome,
    install(version, mode = "ok") {
      const dir = releaseDir(version);
      fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        `${JSON.stringify({ name: "resin", version, type: "module" })}\n`,
      );
      fs.writeFileSync(path.join(dir, "bin", "resin"), fakeGatewaySource(version, mode), {
        mode: 0o755,
      });
    },
    activate(version) {
      const temp = path.join(resinHome, `.current.tmp-${version}`);
      fs.rmSync(temp, { force: true });
      fs.symlinkSync(releaseDir(version), temp, "dir");
      fs.renameSync(temp, path.join(resinHome, "current"));
    },
    received: (version) => receivedLines(version).map((line) => JSON.parse(line)),
    receivedLines,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type JsonMessage = Record<string, unknown>;

/** The harness side: writes lines to the supervisor's stdin and collects what it answers. */
export class FakeClient {
  readonly messages: JsonMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: JsonMessage) => boolean;
    resolve: (message: JsonMessage) => void;
  }> = [];
  private buffer = "";

  constructor(
    private readonly stdin: PassThrough,
    stdout: PassThrough,
  ) {
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim() !== "") this.receive(JSON.parse(line));
        index = this.buffer.indexOf("\n");
      }
    });
  }

  private receive(message: JsonMessage): void {
    this.messages.push(message);
    for (const waiter of this.waiters.slice()) {
      if (waiter.predicate(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }

  send(message: JsonMessage): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  waitFor(predicate: (message: JsonMessage) => boolean): Promise<JsonMessage> {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    const { promise, resolve } = Promise.withResolvers<JsonMessage>();
    this.waiters.push({ predicate, resolve });
    return promise;
  }

  response(id: string | number): Promise<JsonMessage> {
    return this.waitFor((message) => message.id === id && !("method" in message));
  }

  async request(id: string | number, method: string, params?: unknown): Promise<JsonMessage> {
    this.send({ id, method, ...(params === undefined ? {} : { params }) });
    return this.response(id);
  }

  responsesTo(id: string | number): JsonMessage[] {
    return this.messages.filter((message) => message.id === id && !("method" in message));
  }
}

/** The JSON payload of a fake `tools/call` result. */
export function callPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result;
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error(`not a tool result: ${JSON.stringify(response)}`);
  }
  const content = result.content;
  if (!Array.isArray(content)) throw new Error("tool result without content");
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || !("text" in first)) {
    throw new Error("tool result without text");
  }
  return JSON.parse(String(first.text));
}
