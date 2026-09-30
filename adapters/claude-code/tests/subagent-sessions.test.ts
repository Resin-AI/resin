/**
 * Subagent capture: each subagent is its own transcript, listed as its own agent session linked
 * to its parent, decoded under its own session id, and never counted twice.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntermediateSessionEvent } from "@resin/harness-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeHarnessAdapter } from "../src/adapter.js";
import { ClaudeRecordDecoder } from "../src/decoder.js";
import { detectClaudeWorkspaces } from "../src/discovery.js";

const RECORDED = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/recorded/2.1.283/projects/-workspace-project",
);
const MAIN = "9cdec615-753c-4707-b2f9-831595b73692";
const AGENT = "a83a4563dddcae8c8";
const SPAWN_CALL = "toolu_01XZcqwLKdzwvtkV4SCgu2d4";
const SUBAGENTS = `${MAIN}/subagents`;

function lines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function decodeRecords(
  records: Array<Record<string, unknown>>,
  sessionId: string,
): IntermediateSessionEvent[] {
  const decoder = new ClaudeRecordDecoder();
  return records.flatMap((rawPayload, index) =>
    decoder.decode({
      recordId: `r${index}`,
      sessionId,
      harnessId: "claude-code",
      sequenceNumber: index + 1,
      timestamp: "2026-09-26T00:00:00.000Z",
      recordType: "transcript_line",
      rawPayload,
      cursor: { offset: 0, line: index + 1, sequence: index + 1 },
      metadata: {},
    }),
  );
}

const callIds = (events: IntermediateSessionEvent[]) =>
  events.flatMap((event) => (event.type === "tool_call" ? [event.callId] : []));

describe("recorded Claude Code parent and subagent transcripts", () => {
  let home: string;
  const projectDir = () => path.join(home, ".claude/projects/-workspace-project");

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-claude-children-"));
    fs.cpSync(RECORDED, projectDir(), { recursive: true });
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  async function list() {
    const workspaces = await detectClaudeWorkspaces(home);
    const workspace = workspaces.find((entry) => entry.rootPath === "/workspace/project");
    expect(workspace).toBeDefined();
    return await new ClaudeHarnessAdapter().listSessions(workspace!);
  }

  it("lists the subagent as an agent session linked to its parent, and the parent as a user session", async () => {
    const sessions = await list();
    const parent = sessions.find((session) => session.sessionId === MAIN);
    const child = sessions.find((session) => session.sessionId === `agent-${AGENT}`);

    expect(parent?.metadata?.sessionKind).not.toBe("agent");
    expect(parent?.metadata?.parentSessionId).toBeUndefined();
    expect(child?.metadata).toMatchObject({
      sessionKind: "agent",
      parentSessionId: MAIN,
      agentId: AGENT,
      agentName: "general-purpose",
      agentKind: "general-purpose",
      agentDescription: "Read README.md and report first line",
      parentToolCallId: SPAWN_CALL,
    });
    expect(child?.sessionId).not.toBe(MAIN);
    expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(sessions.length);
    expect((await list()).map((session) => session.sessionId).sort()).toEqual(
      sessions.map((session) => session.sessionId).sort(),
    );
  });

  it("decodes each tool call in exactly one capture: the parent's Agent call, the child's own Read", () => {
    const parentEvents = decodeRecords(lines(path.join(projectDir(), `${MAIN}.jsonl`)), MAIN);
    const childEvents = decodeRecords(
      lines(path.join(projectDir(), SUBAGENTS, `agent-${AGENT}.jsonl`)),
      `agent-${AGENT}`,
    );
    const parentCalls = callIds(parentEvents);
    const childCalls = callIds(childEvents);

    expect(childCalls).toHaveLength(1);
    expect(parentCalls.filter((id) => childCalls.includes(id))).toEqual([]);
    const spawns = parentEvents.filter(
      (event) => event.type === "tool_call" && event.toolName === "Agent",
    );
    expect(spawns).toHaveLength(1);
    expect(
      childEvents.some((event) => event.type === "tool_call" && event.toolName === "Agent"),
    ).toBe(false);
    // The child's own transcript records the child's summary and tokens; the parent's launch
    // result carries neither.
    const childUsage = childEvents.filter(
      (event) => "providerUsage" in event && event.providerUsage,
    );
    expect(childUsage.length).toBeGreaterThan(0);
  });

  it("does not count the child's tokens or calls that a finished Agent result reports on the parent", () => {
    const parent = lines(path.join(projectDir(), `${MAIN}.jsonl`));
    const launch = parent.findIndex(
      (record) =>
        JSON.stringify(record).includes(`"tool_use_id":"${SPAWN_CALL}"`) && record.toolUseResult,
    );
    expect(launch).toBeGreaterThan(0);
    // A synchronous Agent call reports the child's totals in the parent's tool result.
    const finished = parent.map((record, index) =>
      index === launch
        ? {
            ...record,
            toolUseResult: {
              status: "completed",
              agentId: AGENT,
              totalTokens: 12345,
              totalToolUseCount: 1,
              totalDurationMs: 3000,
              usage: {
                input_tokens: 8,
                output_tokens: 52,
                cache_read_input_tokens: 11548,
                cache_creation_input_tokens: 647,
              },
            },
          }
        : record,
    );
    const before = decodeRecords(parent, MAIN);
    const after = decodeRecords(finished, MAIN);

    const usageOf = (events: IntermediateSessionEvent[]) =>
      events.flatMap((event) =>
        "providerUsage" in event && event.providerUsage ? [event.providerUsage] : [],
      );
    expect(usageOf(after)).toEqual(usageOf(before));
    expect(callIds(after)).toEqual(callIds(before));
  });

  it("links a subagent spawned by another subagent to that subagent, not the root session", async () => {
    const nested = "b1c2d3e4f5a6b7c80";
    const dir = path.join(projectDir(), SUBAGENTS, "workflows", "run1");
    fs.mkdirSync(dir, { recursive: true });
    const source = lines(path.join(projectDir(), SUBAGENTS, `agent-${AGENT}.jsonl`));
    const childCall = JSON.stringify(source).match(/"type":"tool_use","id":"(toolu_\w+)"/)?.[1];
    expect(childCall).toBeDefined();
    // The child's Read call spawned the nested subagent: depth 2, spawned by that tool call.
    fs.writeFileSync(
      path.join(dir, `agent-${nested}.jsonl`),
      `${source.map((record) => JSON.stringify({ ...record, agentId: nested })).join("\n")}\n`,
    );
    fs.writeFileSync(
      path.join(dir, `agent-${nested}.meta.json`),
      JSON.stringify({ agentType: "Explore", toolUseId: childCall, spawnDepth: 2 }),
    );

    const sessions = await list();
    expect(
      sessions.find((session) => session.sessionId === `agent-${nested}`)?.metadata,
    ).toMatchObject({
      sessionKind: "agent",
      parentSessionId: `agent-${AGENT}`,
      rootSessionId: MAIN,
      agentName: "Explore",
    });
    expect(
      sessions.find((session) => session.sessionId === `agent-${AGENT}`)?.metadata?.parentSessionId,
    ).toBe(MAIN);
  });
});
