import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkflowArgument,
  WorkflowJsonValue,
  WorkflowRecordedProgram,
  WorkflowStep,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type McpToolConnection, connectMcpServer } from "../../src/workflow/mcp-connection.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import { createProgramAdapter } from "../../src/workflow/program-adapter.js";
import { runRecordedProgram } from "../../src/workflow/program-runner.js";
import {
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
} from "../../src/workflow/runtime-families.js";
import { createToolProtocolAdapter } from "../../src/workflow/tool-protocol-adapter.js";

const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "resin-adapters-"));
  workspaces.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A step as the observer records one: the callable it was reached through, and nothing else. */
function recordedStep(options: {
  id: string;
  runtime: string;
  name: string;
  program?: WorkflowRecordedProgram;
  connection?: string;
  arguments?: WorkflowArgument[];
}): WorkflowStep {
  return {
    id: options.id,
    callId: `call-${options.id}`,
    callable: {
      runtime: options.runtime,
      name: options.name,
      ...(options.connection === undefined ? {} : { connection: options.connection }),
      ...(options.program === undefined ? {} : { program: options.program }),
    },
    arguments: options.arguments ?? [],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
  };
}

function literalArgument(name: string, value: WorkflowJsonValue): WorkflowArgument {
  return { name, source: { kind: "literal", value } };
}

/** The failure message of a call that must not succeed. */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the call was expected to fail, and it did not");
}

/**
 * The observer stamps `callable.runtime` with the family names; a package consumer can only read
 * them from the observer's built module. A static import cannot be used here: this cross-check must
 * not take the runtime's own tests down when the observer app is not built to a revision that
 * declares the vocabulary.
 */
async function readObserverModule(): Promise<object | undefined> {
  try {
    return await import("@resin/observer");
  } catch {
    return undefined;
  }
}

/**
 * A minimal MCP server: line-delimited JSON-RPC over stdio, which is what `connectMcpServer` has to
 * speak. It answers the handshake, lists one tool, echoes the arguments it was given — reporting
 * whether the initialized notification had arrived — refuses one tool, and errors on the rest.
 */
const STDIO_MCP_SERVER = `
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, terminal: false });
let initialized = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (message.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] } });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params.name === "fail") {
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "refused by the tool" }] } });
      return;
    }
    if (message.params.name === "broken") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "the tool blew up" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ initialized, called: message.params.name, args: message.params.arguments }) }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
});
`;

describe("recorded program adapters", () => {
  it("runs a recorded shell program whole: its pipe, its operator and its redirect all happen", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProcessAdapter({ cwd: workspace });

    const value = await adapter.call({
      step: recordedStep({
        id: "compose",
        runtime: RESIN_PROCESS_RUNTIME,
        name: "compose-report",
        program: {
          kind: "shell",
          source: "printf 'beta\\nalpha\\n' | sort -r && echo done > redirect.txt",
        },
      }),
      arguments: {},
    });

    // The pipe decided the order; the `&&` branch wrote the redirect file.
    expect(value).toBe("beta\nalpha");
    expect(await readFile(join(workspace, "redirect.txt"), "utf8")).toBe("done\n");
  });

  it("refuses a program that failed, naming the step, the exit code and the stderr", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProcessAdapter({ cwd: workspace });

    const message = await failureOf(() =>
      adapter.call({
        step: recordedStep({
          id: "explode",
          runtime: RESIN_PROCESS_RUNTIME,
          name: "explode",
          program: { kind: "shell", source: "printf 'boom' >&2; exit 7" },
        }),
        arguments: {},
      }),
    );

    expect(message).toContain("step 'explode'");
    expect(message).toContain("exited with code 7");
    expect(message).toContain("boom");
  });

  it("runs a recorded python program and turns its JSON answer into a structured value", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProgramAdapter({ cwd: workspace });

    const value = await adapter.call({
      step: recordedStep({
        id: "count",
        runtime: RESIN_PROGRAM_RUNTIME,
        name: "count-words",
        program: {
          kind: "python",
          source: "import json\nprint(json.dumps({'count': 3, 'label': 'ok'}))",
        },
      }),
      arguments: {},
    });

    expect(value).toEqual({ count: 3, label: "ok" });
  });

  it("runs the program text the recorded argument carried, and the source when it carries none", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProcessAdapter({ cwd: workspace });
    const step = recordedStep({
      id: "resolve",
      runtime: RESIN_PROCESS_RUNTIME,
      name: "run-command",
      program: { kind: "shell", source: "echo from-source", argument: "command" },
      arguments: [literalArgument("command", "echo from-argument")],
    });

    expect(await adapter.call({ step, arguments: { command: "echo from-argument" } })).toBe(
      "from-argument",
    );
    expect(await adapter.call({ step, arguments: {} })).toBe("from-source");
  });

  it("kills a program that outlives its time budget instead of waiting for it", async () => {
    const workspace = await makeWorkspace();

    const message = await failureOf(() =>
      runRecordedProgram({ kind: "shell", source: "sleep 30" }, { cwd: workspace, timeoutMs: 300 }),
    );

    expect(message).toContain("300ms");
  });

  it("keeps a head-and-tail window of a program's output and marks what it dropped", async () => {
    const workspace = await makeWorkspace();

    const run = await runRecordedProgram(
      {
        kind: "shell",
        source: "printf 'aaaaaaaaaa'; printf 'bbbbbbbbbb'; printf 'cccccccccc'",
      },
      { cwd: workspace, maxOutputBytes: 12 },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("aaaaaacccccc");
    expect(run.stderr).toContain("stdout truncated");
  });
});

describe("tool protocol adapter", () => {
  it("re-makes a recorded call through the connection the record names", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connection: McpToolConnection = {
      name: "docs",
      listTools: async () => [],
      callTool: async (name, args) => {
        seen.push({ name, args });
        return { tool: name };
      },
      close: async () => {},
    };
    const adapter = createToolProtocolAdapter({ connections: { docs: connection } });
    const step = recordedStep({
      id: "search",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "search_docs",
      connection: "docs",
      arguments: [literalArgument("query", "resin")],
    });

    expect(await adapter.call({ step, arguments: { query: "resin" } })).toEqual({
      tool: "search_docs",
    });
    expect(seen).toEqual([{ name: "search_docs", args: { query: "resin" } }]);
  });

  it("uses the host dispatcher when the record names no connection", async () => {
    const adapter = createToolProtocolAdapter({
      dispatch: async (request) => ({ served: request.name, step: request.stepId }),
    });
    const step = recordedStep({
      id: "list",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "list_issues",
    });

    expect(await adapter.call({ step, arguments: {} })).toEqual({
      served: "list_issues",
      step: "list",
    });
  });

  it("dials a recorded connection on demand, and fails the step when the dial fails", async () => {
    const dialed: string[] = [];
    const step = recordedStep({
      id: "search",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "search_docs",
      connection: "docs",
    });
    const adapter = createToolProtocolAdapter({
      openConnection: async (name) => {
        dialed.push(name);
        return name === "docs"
          ? {
              name,
              listTools: async () => [],
              callTool: async (tool) => ({ tool }),
              close: async () => {},
            }
          : undefined;
      },
    });

    expect(await adapter.call({ step, arguments: { query: "resin" } })).toEqual({
      tool: "search_docs",
    });
    expect(dialed).toEqual(["docs"]);

    // A dialer that has nothing to hand out is not a connection: the host's dispatcher still gets
    // the call.
    const dispatched = createToolProtocolAdapter({
      openConnection: async () => undefined,
      dispatch: async (request) => ({ served: request.name }),
    });
    expect(await dispatched.call({ step, arguments: { query: "resin" } })).toEqual({
      served: "search_docs",
    });

    const failing = createToolProtocolAdapter({
      openConnection: async () => {
        throw new Error("no credentials for connection 'docs'");
      },
      dispatch: async () => ({ served: "should not be reached" }),
    });
    const message = await failureOf(() => failing.call({ step, arguments: { query: "resin" } }));
    expect(message).toContain("no credentials for connection 'docs'");
  });

  it("refuses a call it cannot reach, and an error result, instead of answering", async () => {
    const step = recordedStep({
      id: "search",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "search_docs",
      connection: "docs",
    });

    const unreachable = await failureOf(() =>
      createToolProtocolAdapter({}).call({ step, arguments: { query: "resin" } }),
    );
    expect(unreachable).toContain("step 'search'");
    expect(unreachable).toContain("search_docs");
    expect(unreachable).toContain("connection 'docs'");
    expect(unreachable).toContain("no tool dispatcher");

    const unnamed = recordedStep({
      id: "list",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "list_issues",
    });
    const withoutConnection = await failureOf(() =>
      createToolProtocolAdapter({}).call({ step: unnamed, arguments: {} }),
    );
    expect(withoutConnection).toContain("step 'list'");
    expect(withoutConnection).toContain("names no connection");

    const erroring = await failureOf(() =>
      createToolProtocolAdapter({ dispatch: async () => ({ isError: true, content: [] }) }).call({
        step: unnamed,
        arguments: {},
      }),
    );
    expect(erroring).toContain("error result");
  });
});

describe("MCP connections", () => {
  it("reaches a tool on a real stdio server through the recorded connection", async () => {
    const directory = await makeWorkspace();
    const serverPath = join(directory, "server.mjs");
    await writeFile(serverPath, STDIO_MCP_SERVER);
    const connection = await connectMcpServer({
      name: "docs",
      transport: { kind: "stdio", command: process.execPath, args: [serverPath] },
    });
    try {
      expect(await connection.listTools()).toEqual([
        { name: "echo", description: "echoes", inputSchema: { type: "object" } },
      ]);
      const adapter = createToolProtocolAdapter({ connections: { docs: connection } });
      const step = recordedStep({
        id: "search",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        name: "echo",
        connection: "docs",
      });
      // `initialized` is what the server saw: the handshake reached it before the tool call did.
      expect(await adapter.call({ step, arguments: { hello: "world" } })).toEqual({
        initialized: true,
        called: "echo",
        args: { hello: "world" },
      });
      await expect(connection.callTool("fail", {})).rejects.toThrow(/refused by the tool/);
      await expect(connection.callTool("broken", {})).rejects.toThrow(
        /the tool blew up \(code -32603\)/,
      );
    } finally {
      await connection.close();
    }
  });

  it("re-reads a tool over streamable HTTP, carrying the session the server handed out", async () => {
    const sessions: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        sessions.push(request.headers["mcp-session-id"] as string | undefined);
        const message = JSON.parse(body) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.method === "initialize") {
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "session-1",
          });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2024-11-05" },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        const result = {
          content: [{ type: "text", text: JSON.stringify({ method: message.method }) }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("the server has no port");
      const connection = await connectMcpServer({
        name: "http",
        transport: { kind: "http", url: `http://127.0.0.1:${address.port}/mcp` },
      });
      expect(await connection.callTool("anything", { a: 1 })).toEqual({ method: "tools/call" });
      await connection.close();
      // The handshake carried no session; everything after it carried the one the server handed out.
      expect(sessions).toEqual([undefined, "session-1", "session-1"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("runtime family names", () => {
  it("uses the runtime family names the observer stamps", async ({ skip }) => {
    expect([RESIN_PROCESS_RUNTIME, RESIN_PROGRAM_RUNTIME, RESIN_TOOL_PROTOCOL_RUNTIME]).toEqual([
      "resin-process",
      "resin-program",
      "resin-tool-protocol",
    ]);

    const names = [
      "RESIN_PROCESS_RUNTIME",
      "RESIN_PROGRAM_RUNTIME",
      "RESIN_TOOL_PROTOCOL_RUNTIME",
    ] as const;
    const expected = [
      RESIN_PROCESS_RUNTIME,
      RESIN_PROGRAM_RUNTIME,
      RESIN_TOOL_PROTOCOL_RUNTIME,
    ] as const;
    const observer = await readObserverModule();
    if (!observer || names.every((name) => typeof Reflect.get(observer, name) !== "string")) {
      skip("the built @resin/observer predates the runtime family vocabulary");
      return;
    }
    for (const [index, name] of names.entries()) {
      expect(Reflect.get(observer, name)).toBe(expected[index]);
    }
  });
});
