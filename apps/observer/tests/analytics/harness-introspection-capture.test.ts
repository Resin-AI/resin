/**
 * A program that introspects Resin or the harness is never learned: the capture coordinator keeps
 * its call and result out of the recorders and the upload, while ordinary project work that merely
 * mentions "resin" in its data still learns. Genuine discovery survives only as accounting metadata.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import { CursorHarnessAdapter, CursorRecordDecoder } from "@resin/adapter-cursor-cli";
import { GrokHarnessAdapter, GrokRecordDecoder } from "@resin/adapter-grok-build";
import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  RESIN_TOOL_LINK_EVIDENCE_KEY,
} from "@resin/contracts";
import type { HarnessRecordDecoder, RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
} from "../../src/index.js";

/** The recorded program behind the published `list_resin_tools` (production, 2026-09-27). */
const RESIN_TOOL_LISTING = `node -e 'const ALL_TOOLS=[]; console.log(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"))'`;
const PROJECT_COMMAND = "./dbtool dump --date 2025-06-01 resin_orders";
const VERIFY_COMMAND = "./dbtool verify backups/resin_orders.sql";

function execCall(callId: string, cmd: string, output: string) {
  return [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: callId,
        arguments: JSON.stringify({ cmd, workdir: "/work" }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: `Chunk ID: ${callId}\nWall time: 0.0100 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\n${output}\n`,
      },
    },
  ];
}

async function capture(sessionId: string, native: readonly object[]) {
  const timestamp = "2026-09-27T12:00:00.000Z";
  return captureRecords(
    new CodexRecordDecoder(),
    { sessionId, harnessId: "codex-cli", timestamp },
    native.map((entry, index) => ({
      recordId: `rec_${index + 1}`,
      sessionId,
      harnessId: "codex-cli",
      sequenceNumber: index + 1,
      recordType: "transcript_line" as const,
      timestamp,
      rawPayload: JSON.stringify({ timestamp, ordinal: index + 1, ...entry }),
      cursor: { offset: index + 1, line: index + 1, sequence: index + 1, timestamp },
      metadata: {},
    })),
  );
}

async function captureRecords(
  decoder: HarnessRecordDecoder,
  session: { sessionId: string; harnessId: string; timestamp: string },
  records: RawHarnessRecord[],
  options: {
    attributed?: boolean;
    batchSize?: number;
    benchmarkId?: string;
    normalized?: NormalizedSessionEvent[];
    trajectories?: TrajectoryObservation[];
  } = {},
) {
  const { sessionId, harnessId, timestamp } = session;
  const pipeline = new NormalizationPipeline({
    redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(decoder);
  const submitted: NormalizedSessionEvent[] = [];
  const client = Object.assign(Object.create(CloudObservationClient.prototype), {
    sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
      submitted.push(...input.observations);
      return { batchId: "batch", acceptedCount: input.observations.length, rejectedCount: 0 };
    }),
    sendTrajectoryObservationBatch: vi.fn(
      async (input: { observations: TrajectoryObservation[] }) => {
        options.trajectories?.push(...input.observations);
        return { batchId: "trajectory", accepted: 1, rejected: 0, errors: [] };
      },
    ),
  }) as CloudObservationClient;
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: client,
    coalesceDwellMs: 0,
    attributionResolver: async () =>
      options.attributed
        ? {
            accountId: "acc_introspection",
            workspaceId: "ws_introspection",
            ownerUserId: "usr_introspection",
            projectId: "prj_introspection",
            candidateId: "cnd_introspection",
            toolId: "tool_introspection",
            toolVersion: "1.0.0",
            workloadId: "wrk_introspection",
            trajectoryId: sessionId,
            provider: "anthropic",
            model: "fixture-model",
            accountingVersion: "fixture-v1",
            runtimeVersion: "1.0.0",
            role: "candidate",
          }
        : null,
    onSessionEvents: (_session, events) => {
      if (options.attributed) submitted.push(...events);
    },
    onPipelineResults: (_session, results) => {
      for (const result of results) {
        if (result.event) options.normalized?.push(structuredClone(result.event));
      }
    },
  });
  const harnessSession = {
    sessionId,
    workspaceId: "ws_introspection",
    harnessId,
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    status: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: options.benchmarkId ? { benchmarkId: options.benchmarkId } : {},
  };
  const batchSize = options.batchSize ?? records.length;
  for (let offset = 0; offset < records.length; offset += batchSize) {
    await coordinator.handleRecords(
      harnessSession,
      records.slice(offset, offset + batchSize),
      async () => {},
    );
  }
  await coordinator.handleRecords({ ...harnessSession, status: "completed" }, [], async () => {});
  if (options.attributed) {
    expect(client.sendTrajectoryObservationBatch).toHaveBeenCalledTimes(1);
    expect(client.sendObservationBatch).not.toHaveBeenCalled();
  }
  coordinator.dispose();
  return submitted;
}

function ompRecords(sessionId: string, native: readonly object[]): RawHarnessRecord[] {
  const timestamp = "2026-01-02T12:00:00.000Z";
  return native.map((entry, index) => ({
    recordId: `omp-record-${index}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber: index + 1,
    recordType: "transcript_line",
    timestamp,
    rawPayload: JSON.stringify({ timestamp, ...entry }),
    cursor: { offset: index + 1, line: index + 1, sequence: index + 1, timestamp },
    metadata: {},
  }));
}

describe("discovery accounting capture", () => {
  it.each(
    [false, true].flatMap((attributed) =>
      [false, true].flatMap((isError) =>
        ["search_tools", "get_tool_schema"].map((toolName) => ({ attributed, isError, toolName })),
      ),
    ),
  )(
    "retains $toolName accounting (attributed=$attributed, error=$isError), never learning",
    async ({ attributed, isError, toolName }) => {
      const sessionId = `omp-discovery-${toolName}-${attributed}-${isError}`;
      const secret = "SYNTHETIC_PRIVATE_DISCOVERY_DETAIL";
      const records = ompRecords(sessionId, [
        {
          id: "fixture-task",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Check the project." }],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            responseId: "request-before",
            provider: "anthropic",
            model: "fixture-model",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            content: [
              {
                type: "toolCall",
                id: "call-before",
                name: "bash",
                arguments: { command: PROJECT_COMMAND },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-before",
            toolName: "bash",
            content: [{ type: "text", text: "backup complete" }],
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            responseId: "request-discovery",
            provider: "anthropic",
            model: "fixture-model",
            stopReason: "toolUse",
            usage: { input: 5, output: 8, cacheRead: 30, cacheWrite: 7, totalTokens: 50 },
            content: [
              {
                type: "toolCall",
                id: "call-discovery",
                name: "write",
                arguments: {
                  path: `xd://mcp__resin_${toolName}`,
                  content: JSON.stringify(
                    toolName === "search_tools" ? { query: secret } : { name: secret },
                  ),
                },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-discovery",
            toolName: "write",
            content: [{ type: "text", text: secret }],
            isError,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            responseId: "request-introspection",
            provider: "anthropic",
            model: "fixture-model",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            content: [
              {
                type: "toolCall",
                id: "call-introspection",
                name: "bash",
                arguments: { command: RESIN_TOOL_LISTING },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-introspection",
            toolName: "bash",
            content: [{ type: "text", text: "mcp__resin__invoke_tool" }],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            responseId: "request-after",
            provider: "anthropic",
            model: "fixture-model",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            content: [
              {
                type: "toolCall",
                id: "call-after",
                name: "bash",
                arguments: { command: VERIFY_COMMAND },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-after",
            toolName: "bash",
            content: [{ type: "text", text: "verified" }],
            isError: false,
          },
        },
      ]);
      const normalized: NormalizedSessionEvent[] = [];
      const trajectories: TrajectoryObservation[] = [];
      const submitted = await captureRecords(
        new OmpRecordDecoder({ deviceSurfaceServers: () => ["resin"] }),
        { sessionId, harnessId: "omp", timestamp: records[0]!.timestamp },
        records,
        { attributed, benchmarkId: "native-discovery-1", batchSize: 1, normalized, trajectories },
      );
      const accounting = submitted.filter((event) => event.metadata?.resinAccountingOnly === true);
      expect(accounting.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
      expect(accounting[0]).toMatchObject({
        toolName,
        connection: "resin",
        callId: "call-discovery",
        metadata: {
          taskId: "fixture-task",
          modelRequestId: "request-discovery",
          benchmarkId: "native-discovery-1",
        },
      });
      expect(accounting[1]).toMatchObject({ toolName, callId: "call-discovery", isError });
      for (const event of accounting) {
        const original = normalized.find((entry) => entry.eventId === event.eventId);
        expect(original).toBeDefined();
        expect(event.causalRef).toEqual(original!.causalRef);
        expect(event.metadata?.modelRequestId).toBe(original!.metadata?.modelRequestId);
        expect(event.metadata?.taskId).toBe(original!.metadata?.taskId);
        expect(event.metadata?.benchmarkId).toBe("native-discovery-1");
        expect(event.metadata?.resinInvocationId).toBeUndefined();
        expect(event.metadata?.resinInvocationIds).toBeUndefined();
        expect(event.metadata?.resinTokenEstimateV1).toEqual(
          original!.metadata?.resinTokenEstimateV1,
        );
        expect(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]).toBeUndefined();
        expect(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]).toBeUndefined();
        expect(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]).toBeUndefined();
        expect(event.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]).toBeUndefined();
      }
      const usage = submitted.filter((event) => event.providerUsage !== undefined);
      expect(usage).toHaveLength(4);
      expect(
        usage.find((event) => event.providerUsage?.requestId === "request-discovery")
          ?.providerUsage,
      ).toMatchObject({
        requestId: "request-discovery",
        inputTokens: 5,
        outputTokens: 8,
        cachedInputTokens: 30,
        cacheWriteTokens: 7,
        totalTokens: 50,
      });
      if (attributed) {
        // Existing outer-trajectory aggregate: the full 50-token search plus three 2-token requests.
        // The normalized discovery records are retained locally, not uploaded a second time.
        expect(trajectories).toHaveLength(1);
        expect(trajectories[0]!.canonicalPayload?.usage).toMatchObject({
          inputTokens: 8,
          outputTokens: 11,
          cachedInputTokens: 30,
          cacheWriteTokens: 7,
          totalTokens: 56,
        });
      }
      expect(JSON.stringify(submitted)).not.toContain(secret);
      expect(callIdsOf(submitted)).not.toContain("call-introspection");
      expect(callIdsOf(submitted)).toEqual([
        "call-before",
        "call-before",
        "call-discovery",
        "call-discovery",
        "call-after",
        "call-after",
      ]);
      const before = carrierOf(submitted, "call-before");
      const after = carrierOf(submitted, "call-after");
      expect(before).toBeDefined();
      expect(after?.executionIndex).toBe(before?.executionIndex);
      expect(after?.executionPosition).toBe((before?.executionPosition ?? -1) + 1);
      expect(after?.dependsOnCallIds ?? []).not.toContain("call-discovery");
    },
  );

  it("recovers a resumed discovery result from its normalized identity, not its output", async () => {
    const sessionId = "omp-discovery-resumed";
    const records = ompRecords(sessionId, [
      { id: "resumed-task", type: "message", message: { role: "user", content: [] } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "resumed-search",
          toolName: "mcp__resin_search_tools",
          isError: true,
          content: [{ type: "text", text: "mcp__resin__invoke_tool unavailable" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "unidentified-result",
          toolName: "write",
          content: [{ type: "text", text: "mcp__resin__invoke_tool" }],
        },
      },
    ]);
    const submitted = await captureRecords(
      new OmpRecordDecoder(),
      { sessionId, harnessId: "omp", timestamp: records[0]!.timestamp },
      records,
    );
    expect(callIdsOf(submitted)).toEqual(["resumed-search"]);
    const result = submitted.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ isError: true, metadata: { resinAccountingOnly: true } });
    expect(result?.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]).toBeUndefined();
    expect(submitted.some((event) => event.providerUsage !== undefined)).toBe(false);
  });

  it("never lets an incoming accounting-only flag admit genuine harness introspection", async () => {
    const sessionId = "omp-marked-introspection";
    const records = ompRecords(sessionId, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "marked-introspection",
              name: "bash",
              arguments: { command: RESIN_TOOL_LISTING },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "marked-introspection",
          toolName: "bash",
          content: [{ type: "text", text: "mcp__resin__invoke_tool" }],
        },
      },
    ]);
    for (const record of records) record.metadata = { resinAccountingOnly: true };
    const normalized: NormalizedSessionEvent[] = [];
    const submitted = await captureRecords(
      new OmpRecordDecoder(),
      { sessionId, harnessId: "omp", timestamp: records[0]!.timestamp },
      records,
      { batchSize: 1, normalized },
    );
    expect(normalized.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(callIdsOf(submitted)).toEqual([]);
  });

  it("keeps a same-named tool on another known connection eligible for learning", async () => {
    const sessionId = "omp-other-discovery-connection";
    const records = ompRecords(sessionId, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "vendor-search",
              name: "write",
              arguments: { path: "xd://mcp__vendor_search_tools", content: '{"query":"project"}' },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "vendor-search",
          toolName: "write",
          content: [{ type: "text", text: "project results" }],
          isError: false,
        },
      },
    ]);
    const submitted = await captureRecords(
      new OmpRecordDecoder({ deviceSurfaceServers: () => ["resin", "vendor"] }),
      { sessionId, harnessId: "omp", timestamp: records[0]!.timestamp },
      records,
      { batchSize: 1 },
    );
    expect(callIdsOf(submitted)).toEqual(["vendor-search", "vendor-search"]);
    expect(submitted.every((event) => event.metadata?.resinAccountingOnly !== true)).toBe(true);
    const carrier = carrierOf(submitted, "vendor-search");
    expect(carrier).toBeDefined();
    expect(carrier?.connection).toBe("vendor");
  });
});

function preamble(sessionId: string) {
  return [
    { type: "session_meta", payload: { id: sessionId, cwd: "/work", cli_version: "0.141.0" } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: "/work", model: "gpt-5.5" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Back up the resin_orders table." }],
      },
    },
  ];
}

const callIdsOf = (events: readonly NormalizedSessionEvent[]) =>
  events.flatMap((event) =>
    event.type === "tool_call" || event.type === "tool_result" ? [event.callId] : [],
  );

function carrierOf(events: readonly NormalizedSessionEvent[], callId: string) {
  const call = events.find((event) => event.type === "tool_call" && event.callId === callId);
  return readWorkflowCallCarrier(call?.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
}

describe("harness introspection capture", () => {
  it("drops a Resin tool listing between two project calls and keeps their workflow intact", async () => {
    const sessionId = "codex-harness-introspection";
    const submitted = await capture(sessionId, [
      ...preamble(sessionId),
      ...execCall("call-dump", PROJECT_COMMAND, "resin_orders -> backups/resin_orders.sql"),
      ...execCall("call-listing", RESIN_TOOL_LISTING, "mcp__resin__invoke_tool"),
      ...execCall("call-verify", VERIFY_COMMAND, "backups/resin_orders.sql: ok"),
    ]);

    expect(JSON.stringify(submitted)).not.toContain("mcp__resin__");
    expect(callIdsOf(submitted)).toEqual(["call-dump", "call-dump", "call-verify", "call-verify"]);
    const dump = carrierOf(submitted, "call-dump");
    const verify = carrierOf(submitted, "call-verify");
    expect(dump?.origins.cmd).toMatchObject({
      type: "program",
      source: { type: "literal", value: PROJECT_COMMAND },
    });
    expect(verify?.origins.cmd).toMatchObject({
      type: "program",
      source: { type: "literal", value: VERIFY_COMMAND },
    });
    // The surviving calls are consecutive steps of one execution, as if the listing never ran.
    expect(verify?.executionIndex).toBe(dump?.executionIndex);
    expect(verify?.executionPosition).toBe((dump?.executionPosition ?? -1) + 1);
    expect(verify?.dependsOnCallIds ?? []).not.toContain("call-listing");
  });

  it("drops a resumed result whose call it never saw when the output names Resin's tools", async () => {
    const sessionId = "codex-harness-introspection-resumed";
    const [, listingResult] = execCall(
      "call-listing",
      RESIN_TOOL_LISTING,
      "mcp__resin__invoke_tool",
    );
    const [, projectResult] = execCall("call-dump", PROJECT_COMMAND, "resin_orders -> ok");
    const submitted = await capture(sessionId, [
      ...preamble(sessionId),
      listingResult!,
      projectResult!,
    ]);
    expect(callIdsOf(submitted)).toEqual(["call-dump"]);
  });

  it("retains a recorded Cursor session's discovery for accounting without learning it", async () => {
    // cursor-agent 2026.09.26 headless run that listed Resin's catalog (`MCP:manage_tools`, no
    // server name in the hook) three times before its one shell call.
    const sessionId = "de81f9d2-44e6-4e1d-8fa1-520818103c30";
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-cursor-introspection-"));
    const spool = path.join(home, ".resin", "capture", "cursor-cli");
    fs.mkdirSync(spool, { recursive: true });
    fs.copyFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../adapters/cursor-cli/tests/fixtures/recorded/2026.9.26-dd393fe",
        `${sessionId}.jsonl`,
      ),
      path.join(spool, `${sessionId}.jsonl`),
    );
    const adapter = new CursorHarnessAdapter({ home, env: {} });
    const [workspace] = await adapter.listWorkspaces();
    const [session] = await adapter.listSessions(workspace!);
    const records = await (await adapter.openEventSource(session!)).readNext(1000);

    const submitted = await captureRecords(
      new CursorRecordDecoder(),
      { sessionId, harnessId: "cursor-cli", timestamp: "2026-09-28T03:21:20.464Z" },
      records,
    );
    const discoveryEvents = submitted.filter(
      (event) => event.metadata?.resinAccountingOnly === true,
    );
    expect(discoveryEvents.filter((event) => event.type === "tool_call")).toHaveLength(3);
    expect(discoveryEvents.filter((event) => event.type === "tool_result")).toHaveLength(3);
    for (const event of discoveryEvents) {
      expect(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]).toBeUndefined();
      expect(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]).toBeUndefined();
    }
    const learned = submitted.filter(
      (event) =>
        event.type === "tool_call" &&
        event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY] !== undefined,
    );
    expect(learned.map((event) => event.type === "tool_call" && event.toolName)).toEqual(["Shell"]);
  });

  it("retains a recorded Grok session's catalog searches only for accounting", async () => {
    // grok 1.0.13 headless code-stats run: Resin's guidance has it call its built-in `search_tool`
    // and `use_tool` → `resin__manage_tools` before its `run_terminal_command` work.
    const sessionId = "01a0e63f-2542-7502-8b1a-42dca17f7d77";
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-grok-introspection-"));
    fs.cpSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../adapters/grok-build/tests/fixtures/recorded/1.0.13/sessions",
        sessionId,
      ),
      path.join(home, ".grok", "sessions", encodeURIComponent("/workspace/project"), sessionId),
      { recursive: true },
    );
    const adapter = new GrokHarnessAdapter({ home, env: {} });
    const [workspace] = await adapter.listWorkspaces();
    const [session] = await adapter.listSessions(workspace!);
    const records = await (await adapter.openEventSource(session!)).readNext(1000);

    const submitted = await captureRecords(
      new GrokRecordDecoder(),
      { sessionId, harnessId: "grok-build", timestamp: "2026-09-28T04:21:34.000Z" },
      records,
    );
    const accountingCalls = submitted.filter(
      (event) => event.type === "tool_call" && event.metadata?.resinAccountingOnly === true,
    );
    expect(accountingCalls.length).toBeGreaterThan(0);
    for (const event of accountingCalls) {
      expect(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]).toBeUndefined();
    }
    const calls = submitted.flatMap((event) =>
      event.type === "tool_call" && event.metadata?.resinAccountingOnly !== true ? [event] : [],
    );
    expect(calls.map((call) => call.toolName)).toEqual([
      "list_dir",
      "run_terminal_command",
      "grep",
      "run_terminal_command",
      "run_terminal_command",
    ]);
  });
});
