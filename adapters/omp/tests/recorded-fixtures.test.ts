import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderReportedUsageSchema } from "@resin/contracts";
import type { IntermediateSessionEvent, RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { OmpRecordDecoder } from "../src/decoder.js";
import {
  OMP_TESTED_VERSIONS,
  buildOmpDiscoveryCatalog,
  classifyTranscriptSessionKind,
} from "../src/discovery.js";
import { OmpSessionEventSource, getOmpProgramObservation } from "../src/source.js";

// Scrubbed sessions recorded with `omp -p` on the release named by the directory; see CAPTURE.md.
const RECORDED = path.join(__dirname, "fixtures", "recorded");

interface Recording {
  /** The main session: bash, reads, edit, write, an MCP call through the device surface, task, wait. */
  main: string;
  /** The `task` subagent the main session spawned. */
  agentName: string;
  /** An Eval whose display OMP truncated, with its full output spilled to `0.eval.log`. */
  evalSpill: string;
  /** A bash call aborted by `--max-time`. */
  aborted: string;
}

const RECORDINGS: Record<string, Recording> = {
  "18.3.2": {
    main: "2026-09-26T23-01-05-051Z_01a0dff3-639b-700f-bb45-3939a09bf46a",
    agentName: "HumanBlackbird",
    evalSpill: "2026-09-26T23-04-33-426Z_01a0dff6-9192-74b3-9bc2-e25cb0b7f7ab",
    aborted: "2026-09-26T23-04-49-530Z_01a0dff6-d07a-73d4-9e72-d5d7c7eeedff.jsonl",
  },
  "18.6.0": {
    main: "2026-10-04T09-32-09-996Z_01a10641-ad8b-71c3-9df4-4c46f26b9702",
    agentName: "FederalPython",
    evalSpill: "2026-10-04T09-31-03-015Z_01a10640-a7e7-74f3-8415-1b9e7d91c930",
    aborted: "2026-10-04T09-31-20-882Z_01a10640-edb2-74c0-a7bc-d6a71955670a.jsonl",
  },
  "18.6.1": {
    main: "2026-10-04T17-44-12-357Z_01a10804-2745-7541-a62f-379131b16485",
    agentName: "CompactTiglon",
    evalSpill: "2026-10-04T17-43-32-460Z_01a10803-8b6c-706b-9b10-7e45dca576e0",
    aborted: "2026-10-04T17-43-51-727Z_01a10803-d6af-7424-bcea-9d9aeadf5eeb.jsonl",
  },
};

interface Decoded {
  records: RawHarnessRecord[];
  events: IntermediateSessionEvent[];
}

/** The fields of a recorded session line the request-link test reads. */
interface SessionLine {
  type?: string;
  id?: string;
  message?: { role?: string; responseId?: string | null };
}

async function decode(version: string, relative: string): Promise<Decoded> {
  const transcriptPath = path.join(RECORDED, version, "sessions", relative);
  const source = new OmpSessionEventSource({
    sessionId: relative,
    workspaceId: "recorded",
    harnessId: "omp",
    transcriptPath,
    status: "completed",
    createdAt: "2026-09-26T23:00:00.000Z",
    updatedAt: "2026-09-26T23:00:00.000Z",
    metadata: {},
  });
  const records = await source.readNext(10_000);
  await source.close();
  const decoder = new OmpRecordDecoder({ deviceSurfaceServers: () => ["fixture-echo", "resin"] });
  return { records, events: records.flatMap((record) => [decoder.decode(record) ?? []].flat()) };
}

function toolEvents(events: IntermediateSessionEvent[], type: "tool_call" | "tool_result") {
  return events.flatMap((event) => (event.type === type ? [event] : []));
}

describe.each(OMP_TESTED_VERSIONS)("recorded OMP %s sessions", (version) => {
  const recording = RECORDINGS[version];
  if (!recording) throw new Error(`OMP ${version} is tested but has no recorded sessions`);
  const MAIN = recording.main;
  const SUBAGENT = `${MAIN}/${recording.agentName}.jsonl`;
  const EVAL_SPILL = recording.evalSpill;
  const ABORTED = recording.aborted;

  it("pairs every recorded tool call with its result", async () => {
    const root = path.join(RECORDED, version, "sessions");
    const transcripts = (await fsp.readdir(root, { recursive: true }))
      .map(String)
      .filter((file) => file.endsWith(".jsonl"));
    expect(transcripts).toHaveLength(4);
    let calls = 0;
    for (const transcript of transcripts) {
      const { events } = await decode(version, transcript);
      const resultIds = new Set(toolEvents(events, "tool_result").map((event) => event.callId));
      for (const call of toolEvents(events, "tool_call")) {
        expect(resultIds, `${transcript} ${call.toolName}`).toContain(call.callId);
        calls += 1;
      }
    }
    // The main session's `wait` only joined its subagent: harness bookkeeping, not a call.
    expect(calls).toBe(12);
  });

  it("records the built-in and MCP tools a headless session ran", async () => {
    const { events } = await decode(version, `${MAIN}.jsonl`);
    const calls = toolEvents(events, "tool_call");
    expect(calls.map((call) => call.toolName)).toEqual([
      "bash",
      "read",
      "read",
      "edit",
      "write",
      "shout",
      "task",
    ]);
    // The `wait` that only joined the subagent's background job is harness bookkeeping.
    expect(events.some((event) => JSON.stringify(event).includes('"toolName":"wait"'))).toBe(false);
    // The MCP call went through OMP's device surface; it is recorded as the tool it reached.
    const shout = calls.find((call) => call.toolName === "shout");
    expect(shout?.connection).toBe("fixture-echo");
    expect(shout?.parameters).toEqual({ text: "resin fixture" });
    // OMP 18.6.x writes the edit's and the task's start markers without arguments; each call is
    // recorded with the arguments its assistant record carries, not `{}`.
    const edit = calls.find((call) => call.toolName === "edit");
    expect(JSON.stringify(edit?.parameters)).toContain("Hi, ");
    const task = calls.find((call) => call.toolName === "task");
    expect(JSON.stringify(task?.parameters)).toContain("ls");
  });

  it("keeps a subagent transcript as its own agent session under the parent", async () => {
    const root = path.join(RECORDED, version, "sessions");
    expect(classifyTranscriptSessionKind(path.join(root, `${MAIN}.jsonl`))).toBe("user");
    expect(classifyTranscriptSessionKind(path.join(root, SUBAGENT))).toBe("agent");
    const { events } = await decode(version, SUBAGENT);
    expect(toolEvents(events, "tool_call").map((call) => call.toolName)).toEqual(["bash", "yield"]);
  });

  it("lists the subagent as a session linked to its parent, and counts each tool call once", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-recorded-link-"));
    try {
      const sessions = path.join(home, "agent", "sessions", "recorded-project");
      await fsp.mkdir(sessions, { recursive: true });
      await fsp.cp(path.join(RECORDED, version, "sessions"), sessions, { recursive: true });
      const catalog = await buildOmpDiscoveryCatalog({ ompHome: home, activeOnly: false });
      const all = catalog.getAllSessions();
      const parent = all.find((session) => session.transcriptPath.endsWith(`${MAIN}.jsonl`));
      const child = all.find((session) => session.transcriptPath.endsWith(SUBAGENT));
      expect(parent?.metadata.sessionKind).toBe("user");
      expect(parent?.metadata.parentSessionId).toBeUndefined();
      expect(child?.metadata).toMatchObject({
        sessionKind: "agent",
        parentSessionId: parent?.sessionId,
        agentName: recording.agentName,
      });
      expect(child?.sessionId).not.toBe(parent?.sessionId);

      // The parent's `task` call and the child's own calls are disjoint records.
      const parentCalls = toolEvents((await decode(version, `${MAIN}.jsonl`)).events, "tool_call");
      const childCalls = toolEvents((await decode(version, SUBAGENT)).events, "tool_call");
      const parentIds = new Set(parentCalls.map((call) => call.callId));
      expect(childCalls.length).toBeGreaterThan(0);
      for (const call of childCalls) expect(parentIds.has(call.callId)).toBe(false);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it("recovers the full output of an Eval whose display OMP truncated", async () => {
    const { records, events } = await decode(version, `${EVAL_SPILL}.jsonl`);
    const spilled = await fsp.readFile(
      path.join(RECORDED, version, "sessions", EVAL_SPILL, "0.eval.log"),
      "utf8",
    );
    const observations = records.flatMap((record) => getOmpProgramObservation(record) ?? []);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ result: spilled });
    const evalResult = toolEvents(events, "tool_result").find((event) => event.toolName === "eval");
    expect(evalResult?.callId).toBe(observations[0]?.callId);
  });

  it("records a command aborted by the session deadline as a failed result", async () => {
    const { events } = await decode(version, ABORTED);
    const [result] = toolEvents(events, "tool_result");
    expect(result?.toolName).toBe("bash");
    expect(result?.isError).toBe(true);
  });

  it("records each assistant response as one request and links its calls, results and task", async () => {
    const { events } = await decode(version, `${MAIN}.jsonl`);
    const transcript = path.join(RECORDED, version, "sessions", `${MAIN}.jsonl`);
    const lines: SessionLine[] = (await fsp.readFile(transcript, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const requestIds = lines
      .filter((line) => line.type === "message" && line.message?.role === "assistant")
      .map((line) => line.message?.responseId ?? line.id);
    const promptIds = lines
      .filter((line) => line.type === "message" && line.message?.role === "user")
      .map((line) => line.id);
    expect(promptIds).toHaveLength(1);

    const responses = events.flatMap((event) =>
      event.type === "message" && event.role === "assistant" ? [event] : [],
    );
    expect(responses.map((event) => event.providerUsage?.requestId)).toEqual(requestIds);
    for (const response of responses) {
      expect(response.providerUsage).toMatchObject({
        usageScope: "request",
        availability: "complete",
      });
      expect(ProviderReportedUsageSchema.safeParse(response.providerUsage).success).toBe(true);
      expect(response.metadata?.modelRequestId).toBe(response.providerUsage?.requestId);
    }
    const toolCalls = toolEvents(events, "tool_call");
    const toolResults = toolEvents(events, "tool_result");
    const callRequests = new Map(
      toolCalls.map((call) => [call.callId, call.metadata?.modelRequestId]),
    );
    for (const request of callRequests.values()) expect(requestIds).toContain(request);
    for (const result of toolResults) {
      if (callRequests.has(result.callId)) {
        expect(result.metadata?.modelRequestId).toBe(callRequests.get(result.callId));
      }
    }
    for (const event of [...responses, ...toolCalls, ...toolResults]) {
      expect(event.metadata?.taskId).toBe(promptIds[0]);
    }
  });
});
