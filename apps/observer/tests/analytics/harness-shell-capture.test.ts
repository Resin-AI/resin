/**
 * Real Cursor 2026.09.26 and GitHub Copilot 1.0.88 sessions of one job each, recorded twice with
 * other values: Cursor's manifest job (adapters/cursor-cli/tests/fixtures/recorded/
 * 2026.9.26-dd393fe, `2e052cec-…` and `7ee5e2f5-…`) and Copilot's changelog job
 * (adapters/copilot-cli/tests/fixtures/recorded/1.0.88/session-state, `1329e50b-…` and
 * `473e9fef-…`). Their built-in shell calls reach the cloud as scrubbed program views, so the two
 * runs name one job; the device keeps each call's exit status, which a split chain's segments need;
 * and the device finds a run recorded after it last listed its sessions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotRecordDecoder } from "@resin/adapter-copilot-cli";
import { CursorRecordDecoder, CursorSessionEventSource } from "@resin/adapter-cursor-cli";
import type { NormalizedSessionEvent, RawHarnessRecord } from "@resin/contracts";
import type { HarnessAdapter } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { createLocalCallIdentity } from "../../src/analytics/local-call-identity.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";
import { readWorkflowCallCarrier } from "../../src/analytics/workflow-carrier.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const ADAPTERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../adapters");
const CURSOR = path.join(ADAPTERS, "cursor-cli/tests/fixtures/recorded/2026.9.26-dd393fe");
const COPILOT = path.join(ADAPTERS, "copilot-cli/tests/fixtures/recorded/1.0.88/session-state");
const WORKSPACE = "workspace-harness-shell-capture";

async function cursorRecords(sessionId: string): Promise<RawHarnessRecord[]> {
  const source = new CursorSessionEventSource({
    sessionId,
    workspaceId: WORKSPACE,
    harnessId: "cursor-cli",
    transcriptPath: path.join(CURSOR, `${sessionId}.jsonl`),
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    metadata: {},
  });
  const records = await source.readNext(1000);
  await source.close();
  return records;
}

function copilotRecords(sessionId: string): RawHarnessRecord[] {
  return fs
    .readFileSync(path.join(COPILOT, sessionId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const payload = JSON.parse(line) as { timestamp: string };
      const timestamp = new Date(payload.timestamp).toISOString();
      return {
        recordId: `${sessionId}-line-${index + 1}`,
        sessionId,
        harnessId: "copilot-cli",
        sequenceNumber: index + 1,
        timestamp,
        recordType: "transcript_line",
        rawPayload: payload,
        cursor: { offset: index + 1, line: index + 1, sequence: index + 1, timestamp },
        metadata: {},
      } satisfies RawHarnessRecord;
    });
}

/** Records every session through one device's pipeline and recorder, as the daemon does. */
async function record(
  harnessId: "cursor-cli" | "copilot-cli",
  sessions: ReadonlyArray<{ sessionId: string; records: RawHarnessRecord[] }>,
) {
  const privateValues = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: privateValues });
  pipeline.registerDecoder(
    harnessId === "cursor-cli" ? new CursorRecordDecoder() : new CopilotRecordDecoder(),
  );
  const recorder = new WorkflowCallRecorder({
    privateValues,
    privateValueOwnerWorkspaceId: WORKSPACE,
  });
  const observed: NormalizedSessionEvent[] = [];
  for (const { sessionId, records } of sessions) {
    for (const raw of records) {
      for (const result of await pipeline.processRecord(raw, {
        sessionId,
        harnessId,
        workspaceId: WORKSPACE,
      })) {
        if (result.status !== "success" || result.isDuplicate) continue;
        observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
      }
    }
  }
  return { privateValues, observed };
}

/** Each shell call's shared program text (or origin kind when unshared) and argument names. */
function shellCalls(observed: readonly NormalizedSessionEvent[], toolName: string) {
  return observed.flatMap((event) => {
    if (event.type !== "tool_call" || event.toolName !== toolName) return [];
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    const origin = carrier?.origins?.command;
    return [
      {
        callId: event.callId,
        program:
          origin?.type === "program" && origin.source.type === "literal"
            ? origin.source.value
            : origin?.type,
        arguments: Object.keys(carrier?.origins ?? {}).sort(),
      },
    ];
  });
}

/** A harness adapter whose discovered sessions the test changes between lookups. */
function listing(sessions: string[]): HarnessAdapter {
  return {
    listWorkspaces: async () => [{ workspaceId: WORKSPACE, rootPath: "/workspace/project" }],
    listSessions: async () => sessions.map((sessionId) => ({ sessionId, workspaceId: WORKSPACE })),
  } as unknown as HarnessAdapter;
}

describe("harness shell capture", () => {
  it("shares Cursor's chained Shell commands as program views with their exit status", async () => {
    const first = "2e052cec-f4f1-4a05-b107-9816de38e581";
    const second = "7ee5e2f5-9efc-4f07-b192-7e296fba7b06";
    const { privateValues, observed } = await record("cursor-cli", [
      { sessionId: first, records: await cursorRecords(first) },
      { sessionId: second, records: await cursorRecords(second) },
    ]);
    const calls = shellCalls(observed, "Shell");
    expect(calls.slice(0, 2).map((call) => call.program)).toEqual([
      "find assets -name '*.png' -type f | sort | xargs -r sha256sum > manifest.txt && wc -l manifest.txt && cat manifest.txt",
      "find photos -name '*.jpg' -type f | sort | xargs -r sha256sum > photos-manifest.txt && wc -l photos-manifest.txt",
    ]);
    const local = createLocalCallIdentity({
      workspaceId: WORKSPACE,
      privateValues,
      adapters: [listing([first, second])],
    });
    const recorded = await local.lookup(calls[0]!.callId);
    expect(recorded).toMatchObject({ sessionId: first, exitCode: 0 });
  });

  it("shares Copilot's bash commands without the model's description label", async () => {
    const first = "1329e50b-7e40-44e1-9b12-6d0e57fb9e23";
    const second = "473e9fef-7357-405f-8f85-030de73251e5";
    const { privateValues, observed } = await record("copilot-cli", [
      { sessionId: first, records: copilotRecords(first) },
      { sessionId: second, records: copilotRecords(second) },
    ]);
    const calls = shellCalls(observed, "bash");
    expect(calls.map((call) => call.program)).toEqual([
      "git status --short -- CHANGES.md",
      "git log --oneline v0.1..HEAD > CHANGES.md && wc -l CHANGES.md",
      "git log --oneline HEAD~2..HEAD > NOTES.md && wc -l NOTES.md",
    ]);
    // `description` only labels the call; it is never part of what the step runs.
    for (const call of calls) expect(call.arguments).toEqual(["command"]);

    // The device listed its sessions before the second run began, then is asked about that run.
    const sessions = [first];
    const local = createLocalCallIdentity({
      workspaceId: WORKSPACE,
      privateValues,
      adapters: [listing(sessions)],
    });
    expect(await local.lookup(calls[1]!.callId)).toMatchObject({ sessionId: first, exitCode: 0 });
    sessions.push(second);
    expect(await local.lookup(calls[2]!.callId)).toMatchObject({ sessionId: second, exitCode: 0 });
  });
});
