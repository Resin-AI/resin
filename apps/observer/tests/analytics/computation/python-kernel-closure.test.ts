/**
 * Persistent Python kernel closure across cells (synthetic sources only): a cell that only writes
 * into containers it built, or that mutates earlier objects in place, must not make the recorder
 * forget helpers and bindings it cannot affect; opaque effects still invalidate everything.
 */

import type { NormalizedSessionEvent, WorkflowPythonState } from "@resin/contracts";
import { NormalizedSessionEventSchema } from "@resin/contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { createComputationEvidenceRecorder } from "../../../src/analytics/computation/recorder.js";
import { InMemoryPrivateValueStore } from "../../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../../src/analytics/workflow-call-recorder.js";

const SESSION = "session-python-kernel-closure";

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: SESSION,
    timestamp: "2026-09-18T10:00:00.000Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}

/** A native OMP Python Eval cell. */
function cell(sequence: number, code: string): NormalizedSessionEvent {
  return event({
    eventId: `evt_call_${sequence}`,
    type: "tool_call",
    callId: `call_${sequence}`,
    toolName: "eval",
    parameters: { language: "py", code },
    causalRef: { causalSequence: sequence, parentId: null, turnIndex: 0, stepIndex: 0 },
    metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "python-eval" },
  });
}

function done(sequence: number, isError = false): NormalizedSessionEvent {
  return event({
    eventId: `evt_result_${sequence}`,
    type: "tool_result",
    callId: `call_${sequence}`,
    toolName: "eval",
    result: isError ? "Traceback: boom" : "ok",
    isError,
    executionDurationMs: 12,
    causalRef: { causalSequence: sequence, parentId: null, turnIndex: 0, stepIndex: 0 },
  });
}

/** Run cells in order; `failed` cells end with an error result. Returns each cell's state decision. */
function run(
  cells: readonly string[],
  failed: ReadonlySet<number> = new Set(),
): (WorkflowPythonState | undefined)[] {
  const workflow = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() });
  const computation = createComputationEvidenceRecorder();
  const observe = (entry: NormalizedSessionEvent) =>
    computation.observe(workflow.observe(entry, { workspaceId: "ws_closure" }));
  return cells.map((code, index) => {
    const observed = observe(cell(index + 1, code));
    observe(done(index + 1, failed.has(index + 1)));
    return readWorkflowCallCarrier(observed.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])?.program
      ?.pythonState;
  });
}

/** The cell numbers (1-based) a closed decision replays first, or "unresolved". */
function setupOf(state: WorkflowPythonState | undefined): number[] | "unresolved" {
  if (state?.status !== "closed") return "unresolved";
  return state.setup.map((entry) => Number(entry.callId.replace("call_", "")));
}

const HELPER = [
  "import json, re",
  "cfg = {'host': 'https://example.invalid', 'project': '7'}",
  "def fetch(q):",
  "    return {'results': [[q, 'web', 1], [q, 'api', 2]]}",
].join("\n");

describe("Python kernel closure across cells", () => {
  it("keeps an earlier helper resolvable after a cell builds nested defaultdict state", () => {
    const states = run([
      HELPER,
      "r = fetch('select 1')\nrecent = r['results']",
      [
        "r = fetch('select 2')",
        "from collections import defaultdict",
        "days = defaultdict(dict)",
        "for day, src, n in r['results']: days[day][src] = n",
        "for d in sorted(days): print(d, days[d])",
      ].join("\n"),
      "for q, src, n in recent: print(json.dumps([q, src, n]))",
      "r = fetch('select 3')\nprint(len(r['results']))",
    ]);
    expect(states.map(setupOf)).toEqual([[], [1], [1], [1, 2], [1]]);
  });

  it("replays an in-place mutation for later readers of the mutated binding only", () => {
    const states = run([
      HELPER,
      "rows = [1, 2]",
      "rows.append(3)",
      "print(len(rows))",
      "print(fetch('x'))",
    ]);
    expect(setupOf(states[2])).toEqual([2]);
    expect(setupOf(states[3])).toEqual([2, 3]);
    // The helper shares nothing with `rows`, so its readers do not replay the mutation.
    expect(setupOf(states[4])).toEqual([1]);
  });

  it("versions every binding that may share the mutated objects", () => {
    const states = run([
      "records = [{'k': 1}, {'k': 2}]",
      "mine = [r for r in records if r['k'] > 1]",
      "for r in records: r['k'] = r['k'] * 10",
      "print(mine)",
    ]);
    // `mine` holds the same dicts, so reading it must replay the mutation after both earlier cells.
    expect(setupOf(states[3])).toEqual([1, 2, 3]);
  });

  it("keeps a read-modify-write cell replayable for later readers", () => {
    const states = run(["total = 0", "total += 5", "print(total)"]);
    expect(setupOf(states[1])).toEqual([1]);
    expect(setupOf(states[2])).toEqual([1, 2]);
  });

  it("still forgets everything after a cell with opaque effects", () => {
    const states = run([HELPER, "mystery()", "print(fetch('x'))"]);
    expect(setupOf(states[1])).toBe("unresolved");
    expect(setupOf(states[2])).toBe("unresolved");
  });

  it("forgets only what a failed mutating cell could have changed", () => {
    const states = run(
      [HELPER, "rows = [1]", "rows.append(fetch('x'))", "print(rows)", "print(fetch('y'))"],
      new Set([3]),
    );
    expect(setupOf(states[3])).toBe("unresolved");
    expect(setupOf(states[4])).toEqual([1]);
  });

  it("forgets the bindings of a failed cell but keeps unrelated helpers", () => {
    const states = run(
      [HELPER, "value = fetch('x')['results'][9]", "print(value)", "print(fetch('y'))"],
      new Set([2]),
    );
    expect(setupOf(states[2])).toBe("unresolved");
    expect(setupOf(states[3])).toEqual([1]);
  });
});
