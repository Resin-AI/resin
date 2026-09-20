/**
 * The connection a recorded callable was reached over is part of its identity.
 *
 * Two servers may expose the same short tool name — that is ordinary for MCP — so a step that
 * names a connection must be answered by that connection: never by a same-named callable of
 * another connection, never by the cloud route by bare name. These tests drive the production
 * composition with two real MCP servers, each of which records what it was asked to run.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  WORKFLOW_VALIDATION_SCHEMA_VERSION,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowValidationDecision,
  type WorkflowValidationRequest,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import {
  CloudCredentialStore,
  type CloudRequestIdentity,
  InMemoryPrivateValueStore,
} from "@resin/observer";
import {
  ArtifactCache,
  type McpServerDescriptor,
  type McpToolConnection,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  compileRecordedWorkflow,
  connectMcpServer,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { composedResultValue } from "../../src/meta/invoke-tool.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { createProductionProxyRuntime } from "../../src/proxy/runtime.js";
import {
  type WorkflowValidationTransport,
  WorkflowValidationWorker,
} from "../../src/proxy/validation-worker.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../../src/workspace-resolver.js";

const WORKSPACE_ID = "ws_tool_connection";
const DEVICE_ID = "dev_tool_connection";
const INSTALLATION_ID = "install_tool_connection";
const ACCOUNT_ID = "acct_tool_connection";
const ATTEMPT = "attempt-01";
const DECIDED_AT = "2026-09-18T12:00:00.000Z";

const IDENTITY: CloudRequestIdentity = {
  cloudUrl: "https://cloud.test",
  accessToken: "access-token-1",
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  deviceId: DEVICE_ID,
  installationId: INSTALLATION_ID,
  userId: "user_tool_connection",
};

/**
 * A minimal MCP server that answers the handshake, exposes `run` and `deep_tool_name`, and appends
 * every call it receives — the tool's own name and the arguments — to its own ledger file.
 */
const SERVER_SCRIPT = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [serverName, ledgerPath] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin, terminal: false });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "run", description: "runs", inputSchema: { type: "object" } },
      { name: "deep_tool_name", description: "runs too", inputSchema: { type: "object" } },
    ] } });
    return;
  }
  if (message.method === "tools/call") {
    const called = { server: serverName, tool: message.params.name, args: message.params.arguments };
    appendFileSync(ledgerPath, JSON.stringify(called) + "\\n");
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(called) }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
});
`;

interface RecordedCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

const tempDirs: string[] = [];
const openedConnections: McpToolConnection[] = [];

afterEach(async () => {
  await Promise.all(openedConnections.splice(0).map((connection) => connection.close()));
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function workspaceOf(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `tool-connection-${prefix}-`));
  tempDirs.push(directory);
  return directory;
}

/** A real MCP server over stdio, with its own ledger of the calls it was asked to run. */
function serverAt(root: string, name: string): McpServerDescriptor {
  const scriptPath = path.join(root, `${name}-server.mjs`);
  fs.writeFileSync(scriptPath, SERVER_SCRIPT, "utf8");
  return {
    name,
    transport: {
      kind: "stdio",
      command: process.execPath,
      args: [scriptPath, name, path.join(root, `${name}-calls.jsonl`)],
    },
  };
}

function callsOf(root: string, name: string): RecordedCall[] {
  const ledger = path.join(root, `${name}-calls.jsonl`);
  if (!fs.existsSync(ledger)) return [];
  return fs
    .readFileSync(ledger, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedCall);
}

async function credentialStoreAt(root: string): Promise<CloudCredentialStore> {
  const store = new CloudCredentialStore({ tokenFilePath: path.join(root, "device-token.json") });
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      installationId: INSTALLATION_ID,
      userId: "user_tool_connection",
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["device:connect"],
    }),
  ).toString("base64url");
  await store.persist({
    cloudUrl: IDENTITY.cloudUrl,
    accessToken: `${header}.${body}.mock-signature`,
    refreshToken: "refresh-token-1",
    deviceId: DEVICE_ID,
    workspaceId: WORKSPACE_ID,
  });
  return store;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) throw new Error("the call answered with no text");
  return text;
}

describe("invoking a callable over the connection a record names", () => {
  it("tells two servers exposing the same tool name apart, through the production runtime", async () => {
    const root = workspaceOf("runtime");
    const descriptors: Record<string, McpServerDescriptor> = {
      alpha: serverAt(root, "alpha"),
      alpha_beta: serverAt(root, "alpha_beta"),
    };
    const runtime = await createProductionProxyRuntime({
      credentialStore: await credentialStoreAt(root),
      resinHome: path.join(root, "resin-home"),
      recordedWorkflowConnections: (name) => descriptors[name],
      fetchFn: async () => {
        throw new Error("this test must not reach the network");
      },
    });
    const router = runtime.router;
    expect(router).toBeDefined();
    const context = resolveWorkspaceContext({ cwd: root });
    const invoke = async (connection: string, name: string, parameters: JsonRpcParams) =>
      await router!.invoke({
        toolId: name,
        name,
        version: "",
        connection,
        parameters,
        context,
      });

    const alpha = await invoke("alpha", "run", { query: "rows" });
    const alphaBeta = await invoke("alpha_beta", "run", { query: "rows" });
    const deep = await invoke("alpha", "deep_tool_name", { query: "rows" });

    expect(JSON.parse(textOf(alpha))).toEqual({
      server: "alpha",
      tool: "run",
      args: { query: "rows" },
    });
    expect(JSON.parse(textOf(alphaBeta))).toEqual({
      server: "alpha_beta",
      tool: "run",
      args: { query: "rows" },
    });
    expect(JSON.parse(textOf(deep))).toEqual({
      server: "alpha",
      tool: "deep_tool_name",
      args: { query: "rows" },
    });
    // Each server was asked for exactly its own call: the same-named tool of the other server is
    // not what either call reached.
    expect(callsOf(root, "alpha")).toEqual([
      { server: "alpha", tool: "run", args: { query: "rows" } },
      { server: "alpha", tool: "deep_tool_name", args: { query: "rows" } },
    ]);
    expect(callsOf(root, "alpha_beta")).toEqual([
      { server: "alpha_beta", tool: "run", args: { query: "rows" } },
    ]);
  });

  it("fails a step whose connection cannot be dialed, rather than answering by bare name", async () => {
    const root = workspaceOf("unreachable");
    const fetched: string[] = [];
    const runtime = await createProductionProxyRuntime({
      credentialStore: await credentialStoreAt(root),
      resinHome: path.join(root, "resin-home"),
      recordedWorkflowConnections: (name) =>
        name === "alpha" ? serverAt(root, "alpha") : undefined,
      fetchFn: async (input) => {
        fetched.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
    const context = resolveWorkspaceContext({ cwd: root });

    await expect(
      runtime.router!.invoke({
        toolId: "run",
        name: "run",
        version: "",
        connection: "missing",
        parameters: {},
        context,
      }),
    ).rejects.toThrow(/connection 'missing'/);
    // The cloud route answers by bare name, and the bare name here is a tool that exists
    // elsewhere; neither is what the record reached.
    expect(fetched).toEqual([]);
  });
});

const tokenCandidate: WorkflowBindingCandidate = {
  stepId: "second",
  argument: "token",
  path: [],
  proposed: { kind: "input", name: "token", type: "string" },
  reason: "declared-by-the-callable",
  missing: "the recording never showed which caller-supplied value reached the call",
};

/**
 * A recording whose two steps both call `run`, each over its own connection, with a demonstration
 * on another token: the two replays the candidate is decided by run the whole plan twice.
 */
function twoConnectionPlan(secondConnection: string): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf_two_connections",
    inputs: [],
    privateReferences: ["private:replay:token", "private:replay:first", "private:replay:second"],
    candidates: [tokenCandidate],
    heldOut: {
      inputs: [{ stepId: "second", argument: "token", reference: "private:replay:token" }],
      observed: [
        { stepId: "first", reference: "private:replay:first" },
        { stepId: "second", reference: "private:replay:second" },
      ],
    },
    steps: [
      {
        id: "first",
        callId: "call_first",
        callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "run", connection: "alpha" },
        arguments: [
          {
            name: "query",
            source: { kind: "template", template: { type: "literal", value: "rows" } },
          },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "second",
        callId: "call_second",
        callable: {
          runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
          name: "run",
          connection: secondConnection,
        },
        arguments: [
          {
            name: "token",
            source: { kind: "template", template: { type: "literal", value: "recorded-token" } },
          },
        ],
        dependsOn: ["first"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}

/**
 * The demonstration the recording kept, and the values it produced: both are the user's own work
 * and stay in the local store, stamped with the workspace that recorded them.
 */
function replayStore(): InMemoryPrivateValueStore {
  const store = new InMemoryPrivateValueStore();
  const origin = { workspaceId: WORKSPACE_ID };
  store.set("private:replay:token", "held-token", origin);
  store.set(
    "private:replay:first",
    { server: "alpha", tool: "run", args: { query: "rows" } },
    origin,
  );
  store.set(
    "private:replay:second",
    { server: "alpha_beta", tool: "run", args: { token: "held-token" } },
    origin,
  );
  return store;
}

function requestFor(plan: RecordedWorkflow): WorkflowValidationRequest {
  return {
    schemaVersion: WORKFLOW_VALIDATION_SCHEMA_VERSION,
    requestId: "req-01",
    workspaceId: WORKSPACE_ID,
    deviceId: DEVICE_ID,
    attempt: ATTEMPT,
    planDigest: workflowValidationPlanDigest(plan),
    evidenceDigest: "evidence-digest-01",
    authorization: { envelopeId: "env-01", workspaceId: WORKSPACE_ID },
    createdAt: "2026-09-18T11:59:00.000Z",
    plan,
  };
}

/** The validator's router, composed the way the production runtime composes it. */
function dispatchOver(
  router: CloudInvocationRouter,
  context: WorkspaceContext,
  dispatched: string[],
) {
  return async (request: {
    name: string;
    arguments: Record<string, WorkflowJsonValue>;
    connection?: string;
    stepId: string;
  }): Promise<WorkflowJsonValue> => {
    dispatched.push(request.connection ?? request.name);
    const result = await router.invoke({
      toolId: request.name,
      name: request.name,
      version: "",
      ...(request.connection ? { connection: request.connection } : {}),
      parameters: request.arguments as JsonRpcParams,
      context,
    });
    if (result.isError) {
      throw new Error(textOf(result));
    }
    return composedResultValue(result);
  };
}

describe("executing a recorded plan over the connections it names", () => {
  it("runs each step's callable through that step's own server", async () => {
    const root = workspaceOf("executor");
    const descriptors: Record<string, McpServerDescriptor> = {
      alpha: serverAt(root, "alpha"),
      alpha_beta: serverAt(root, "alpha_beta"),
    };
    const artifactCache = new ArtifactCache({ cacheDir: path.join(root, "artifacts") });
    const plan = twoConnectionPlan("alpha_beta");
    const manifest = {
      id: "tool_two_connections",
      name: "wf_two_connections",
      version: "1.0.0",
      description: "a recording whose two steps call the same tool over different connections",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      runtime: {
        runtime: "recorded-workflow",
        memoryLimitMb: 64,
        timeoutMs: 10_000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 65_536,
      },
      capabilities: {},
      limits: {},
      scope: "workspace" as const,
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const manifestDigest = computeManifestDigest(manifest as never);
    const fullManifest = { ...manifest, digest: manifestDigest };
    const entrypoint = JSON.stringify(compileRecordedWorkflow(plan).plan);
    const { archive } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(fullManifest) },
      { path: "src/index.ts", content: entrypoint },
    ]);
    const artifactDigest = createHash("sha256").update(archive).digest("hex");
    const stagingDir = await artifactCache.createStagingDirectory(artifactDigest);
    fs.mkdirSync(path.join(stagingDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(fullManifest), "utf8");
    fs.writeFileSync(path.join(stagingDir, "src", "index.ts"), entrypoint, "utf8");
    await artifactCache.commitStagingDirectory(stagingDir, artifactDigest, {
      digest: artifactDigest,
      extractedAt: new Date().toISOString(),
      fileCount: 2,
      totalSizeBytes: archive.length,
      entrypoint: "src/index.ts",
      verified: true,
    });
    const runtime = await createProductionProxyRuntime({
      credentialStore: await credentialStoreAt(root),
      resinHome: path.join(root, "resin-home"),
      artifactCache,
      allowDevKeys: true,
      recordedWorkflowConnections: (name) => descriptors[name],
      fetchFn: async () => {
        throw new Error("this test must not reach the network");
      },
    });

    const result = await runtime.executor!.execute({
      entry: {
        toolId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        artifactDigest,
      },
      manifest: fullManifest as never,
      parameters: {},
      context: resolveWorkspaceContext({ cwd: root }),
    });

    expect(result.isError, textOf(result)).toBeUndefined();
    // Each step reached the server its own connection names, and its callable is the tool's own
    // name on that server: the same short name over two servers is not a collision here.
    expect(callsOf(root, "alpha")).toEqual([
      { server: "alpha", tool: "run", args: { query: "rows" } },
    ]);
    expect(callsOf(root, "alpha_beta")).toEqual([
      { server: "alpha_beta", tool: "run", args: { token: "recorded-token" } },
    ]);
  });
});

describe("replaying a plan over the connections it names", () => {
  it("reaches each step's own server, even though both steps call the same tool name", async () => {
    const root = workspaceOf("replay");
    const descriptors: Record<string, McpServerDescriptor> = {
      alpha: serverAt(root, "alpha"),
      alpha_beta: serverAt(root, "alpha_beta"),
    };
    const dial = async (name: string) => {
      const descriptor = descriptors[name];
      if (descriptor === undefined) return undefined;
      const connection = await connectMcpServer(descriptor);
      openedConnections.push(connection);
      return connection;
    };
    const router = new CloudInvocationRouter({
      mockService: {
        handleToolInvocation: async () => {
          throw new Error("a recorded callable must not be answered by the cloud route");
        },
      },
    });
    const dispatched: string[] = [];
    const context = resolveWorkspaceContext({ cwd: root });
    const plan = twoConnectionPlan("alpha_beta");
    let decision: WorkflowValidationDecision | undefined;
    const transport: WorkflowValidationTransport = {
      listPending: async () => [requestFor(plan)],
      submitDecision: async (submitted) => {
        decision = submitted;
        return { status: "recorded" };
      },
    };
    const worker = new WorkflowValidationWorker({
      client: transport,
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      privateValues: replayStore(),
      openConnection: dial,
      dispatch: dispatchOver(router, context, dispatched),
      now: () => new Date(DECIDED_AT),
    });

    const summary = await worker.runOnce();

    expect(summary.answered).toBe(1);
    expect(decision!.verdicts).toHaveLength(1);
    expect(decision!.verdicts[0]!.confirmed).toBe(true);
    // The replay dialed the connections itself: the host's bare-name routing was never consulted.
    expect(dispatched).toEqual([]);
    // Each step reached its own server, and only its own. A candidate is decided by a run with it
    // bound and a run with it reverted, and the confirmed plan runs once more: three runs of a
    // two-step plan, so each server saw three calls — its own step's, never the other's.
    expect(callsOf(root, "alpha")).toEqual([
      { server: "alpha", tool: "run", args: { query: "rows" } },
      { server: "alpha", tool: "run", args: { query: "rows" } },
      { server: "alpha", tool: "run", args: { query: "rows" } },
    ]);
    expect(callsOf(root, "alpha_beta")).toEqual([
      { server: "alpha_beta", tool: "run", args: { token: "held-token" } },
      { server: "alpha_beta", tool: "run", args: { token: "recorded-token" } },
      { server: "alpha_beta", tool: "run", args: { token: "held-token" } },
    ]);
  });

  it("fails the replay naming a connection that cannot be reached, without substituting a tool", async () => {
    const root = workspaceOf("replay-unreachable");
    const descriptors: Record<string, McpServerDescriptor> = { alpha: serverAt(root, "alpha") };
    const dial = async (name: string) => {
      const descriptor = descriptors[name];
      if (descriptor === undefined) return undefined;
      const connection = await connectMcpServer(descriptor);
      openedConnections.push(connection);
      return connection;
    };
    const router = new CloudInvocationRouter({
      mockService: {
        handleToolInvocation: async () => {
          throw new Error("a recorded callable must not be answered by the cloud route");
        },
      },
    });
    const dispatched: string[] = [];
    const context = resolveWorkspaceContext({ cwd: root });
    const plan = twoConnectionPlan("missing");
    let decision: WorkflowValidationDecision | undefined;
    const worker = new WorkflowValidationWorker({
      client: {
        listPending: async () => [requestFor(plan)],
        submitDecision: async (submitted) => {
          decision = submitted;
          return { status: "recorded" };
        },
      },
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      privateValues: replayStore(),
      openConnection: dial,
      dispatch: dispatchOver(router, context, dispatched),
      now: () => new Date(DECIDED_AT),
    });

    const summary = await worker.runOnce();

    expect(summary.answered).toBe(1);
    expect(decision!.accepted).toEqual([]);
    const reason = decision!.verdicts[0]!.reason ?? "";
    expect(reason).toContain("connection 'missing'");
    // The step was handed to the host's routing under its connection — which is what refuses it —
    // and no server was asked for a tool the record did not reach. Every attempt names the
    // connection; the bare name is never tried.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.every((attempt) => attempt === "missing")).toBe(true);
    // The reachable step ran (its server saw each attempt of the plan); the unreachable one never
    // reached a server, because no server owns that callable.
    expect(callsOf(root, "alpha").length).toBeGreaterThan(0);
  });
});
