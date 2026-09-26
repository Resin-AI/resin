import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderPiResinExtension } from "../src/extension.js";

// A stdio MCP server whose catalog changes when `learn` is called, like Resin's gateway after
// it learns a tool: the new tool is added, `old` is dropped, and list_changed is sent.
const SERVER = `
import { createInterface } from "node:readline";
let tools = [
  { name: "learn", description: "Learn a tool", inputSchema: { type: "object", properties: {} } },
  { name: "old", description: "Old tool", inputSchema: { type: "object", properties: {} } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "t", version: "1" } } });
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  if (msg.method === "tools/call" && msg.params.name === "learn") {
    tools = [tools[0], { name: "greet.v2", description: "Greets", inputSchema: { type: "object", properties: { who: { type: "string" } } } }];
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "learned" }] } });
  }
  if (msg.method === "tools/call" && msg.params.name === "greet.v2") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "no greeting for " + msg.params.arguments.who }] } });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
});
`;

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: unknown[] }>;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  let active: string[] = ["read", "bash"];
  let activeChanged = Promise.withResolvers<void>();
  const notices: string[] = [];
  return {
    tools,
    notices,
    get active() {
      return active;
    },
    /** Resolves on the next setActiveTools call (the bridge's reaction to list_changed). */
    nextActiveChange: () => activeChanged.promise,
    api: {
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool);
        if (!active.includes(tool.name)) active = [...active, tool.name];
      },
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
        activeChanged.resolve();
        activeChanged = Promise.withResolvers<void>();
      },
      on: (event: string, handler: Handler) => handlers.set(event, handler),
    },
    emit: (event: string) =>
      handlers.get(event)?.(
        { type: event },
        { cwd: os.tmpdir(), ui: { notify: (message: string) => notices.push(message) } },
      ),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-bridge-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function loadBridge(serverScript: string) {
  const serverPath = path.join(dir, "server.mjs");
  await fsp.writeFile(serverPath, serverScript);
  const extensionPath = path.join(dir, "resin.mjs");
  await fsp.writeFile(
    extensionPath,
    renderPiResinExtension({ name: "resin", command: process.execPath, args: [serverPath] }),
  );
  const module: { default: (pi: unknown) => void } = await import(pathToFileURL(extensionPath).href);
  const pi = fakePi();
  module.default(pi.api);
  return pi;
}

describe("Resin Pi bridge extension", () => {
  it("follows list_changed: registers learned tools and deactivates dropped ones", async () => {
    const pi = await loadBridge(SERVER);
    await pi.emit("session_start");
    expect(pi.active).toEqual(["read", "bash", "mcp__resin__learn", "mcp__resin__old"]);

    const refreshed = pi.nextActiveChange();
    const learned = await pi.tools.get("mcp__resin__learn")!.execute("c1", {});
    expect(learned.content).toEqual([{ type: "text", text: "learned" }]);
    await refreshed;
    expect(pi.active).toEqual(["read", "bash", "mcp__resin__learn", "mcp__resin__greet_v2"]);
    expect(pi.tools.get("mcp__resin__greet_v2")!.parameters).toEqual({
      type: "object",
      properties: { who: { type: "string" } },
    });

    // MCP tool errors surface as thrown errors, which Pi records as isError results.
    await expect(
      pi.tools.get("mcp__resin__greet_v2")!.execute("c2", { who: "bob" }),
    ).rejects.toThrow("no greeting for bob");
    await pi.emit("session_shutdown");
    expect(pi.notices).toEqual([]);
  });

  it("warns instead of failing the session when the gateway cannot start", async () => {
    const pi = await loadBridge("process.exit(3);\n");
    await pi.emit("session_start");
    expect(pi.tools.size).toBe(0);
    expect(pi.notices).toEqual([expect.stringMatching(/^Resin MCP bridge unavailable: /)]);
  });
});
