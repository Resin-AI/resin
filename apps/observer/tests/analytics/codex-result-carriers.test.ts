/**
 * Codex code-mode cells that run one `tools.exec_command` and print its output are recorded with a
 * call carrier and a result carrier whose baseline is the command's full stdout, whatever came
 * before them in the session and whichever of the cell reply and the command item arrives first.
 */
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowResultCarrier,
} from "../../src/analytics/workflow-carrier.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-codex-result-carriers";
const BASE = Date.parse("2026-09-26T03:24:30.000Z");
const at = (ms: number) => new Date(ms).toISOString();

type Line = { timestamp: string; type: string; payload: Record<string, unknown> };

function cell(callId: string, input: string, time: number): Line {
  return {
    timestamp: at(time),
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name: "exec",
      input,
      internal_chat_message_metadata_passthrough: { create_time: (time - 2_000) / 1000 },
    },
  };
}

function single(cmd: string, options: string): string {
  return `const r=await tools.exec_command({cmd:${JSON.stringify(cmd)},"workdir":"/app"${options}});text(r.output);\n`;
}

function reply(callId: string, printed: string, time: number, status = "completed"): Line {
  return {
    timestamp: at(time),
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [
        { type: "input_text", text: `Script ${status}\nWall time 0.4 seconds\nOutput:\n` },
        { type: "input_text", text: printed },
      ],
    },
  };
}

function command(id: string, cmd: string, stdout: string, started: number, exit = 0): Line {
  return {
    timestamp: at(started + 50),
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        id,
        command: ["/bin/bash", "-lc", cmd],
        cwd: "file:///app",
        status: exit === 0 ? "completed" : "failed",
        stdout,
        stderr: "",
        aggregated_output: stdout,
        exit_code: exit,
        duration: { secs: 0, nanos: 50_000_000 },
      },
      started_at_ms: started,
      completed_at_ms: started + 50,
    },
  };
}

/** Several commands run in one cell, all awaited, as the DABstep session's second cell does. */
const SURVEY = `const cmds=["cat a.md","cat b.md"];
const r=await Promise.allSettled(cmds.map(cmd=>tools.exec_command({cmd,workdir:"/app",max_output_tokens:5000})));
r.forEach((x,i)=>text(\`\${cmds[i]}\\n\${x.status==="fulfilled"?x.value.output:String(x.reason)}\`));
`;

function surveyLines(survey = SURVEY, status = "completed"): Line[] {
  return [
    cell("call_survey", survey, BASE),
    command("exec-a", "cat a.md", "alpha\n", BASE + 100),
    command("exec-b", "cat b.md", "beta\n", BASE + 110),
    reply("call_survey", "cat a.md\nalpha\ncat b.md\nbeta\n", BASE + 300, status),
  ];
}

async function record(sessionId: string, lines: Line[]) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const native = [
    { timestamp: at(BASE - 5_000), type: "session_meta", payload: { id: sessionId, cwd: "/app" } },
    {
      timestamp: at(BASE - 5_000),
      type: "turn_context",
      payload: { turn_id: "turn", cwd: "/app", model: "gpt-6-sol" },
    },
    {
      timestamp: at(BASE - 4_000),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Compute the fee total from /app/data." }],
      },
    },
    ...lines,
  ];
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of native.entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${sessionId}_${ordinal}`,
        sessionId,
        harnessId: "codex-cli",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp: entry.timestamp,
        rawPayload: JSON.stringify(entry),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp: entry.timestamp },
        metadata: {},
      },
      { sessionId, harnessId: "codex-cli", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  const projected = observed.map((event) => projectEventToMetadataOnly(event));
  const recipe = recordCallsFromEvents(sessionId, projected);
  if (recipe === undefined) throw new Error("expected a recording");
  /** The wrapper's call carrier and every result carrier that belongs to it, by call id. */
  const carriers = (callId: string) => {
    const call = projected.filter(
      (event) =>
        event.type === "tool_call" &&
        event.callId === callId &&
        event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY] !== undefined,
    );
    const results = projected.flatMap((event) => {
      const carrier = readWorkflowResultCarrier(
        event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
      );
      const owner =
        event.type === "tool_result"
          ? event.callId
          : event.type === "command_exec"
            ? (event.metadata?.resinCodexCommandV1 as { association?: { callId?: string } })
                ?.association?.callId
            : undefined;
      return carrier !== undefined && owner === callId ? [carrier] : [];
    });
    return { call, results };
  };
  const step = (callId: string) => {
    const found = recipe.workflow.steps.find((entry) => entry.callId === callId);
    if (found === undefined) throw new Error(`no step for ${callId}`);
    return found;
  };
  return { store, carriers, step, workflow: recipe.workflow };
}

describe("Codex single-command result carriers", () => {
  it("records a truncated, yielding cell after an awaited multi-command cell with its full stdout", async () => {
    const stdout = `${"ID null 0 empty 0 unique 1000\n".repeat(400)}done\n`;
    const cmd = "python3 - <<'PY'\nprint('fees')\nPY";
    const { store, carriers, step } = await record("codex-carrier-truncated", [
      ...surveyLines(),
      cell(
        "call_fees",
        single(cmd, ',"yield_time_ms":30000,"max_output_tokens":400'),
        BASE + 1_000,
      ),
      command("exec-fees", cmd, stdout, BASE + 1_100),
      reply("call_fees", `${stdout.slice(0, 1_600)}…1200 tokens truncated…`, BASE + 1_400),
    ]);
    const { call, results } = carriers("call_fees");
    expect(call).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(store.get(results[0]!.baselineReference!)).toBe(stdout);
    expect(step("call_fees").observed).toEqual({
      outcome: "succeeded",
      output: { type: "string", hasContent: true },
    });
  });

  it("records an empty-output cell with an empty result", async () => {
    const cmd = "printf '12.91' > /app/answer.txt";
    const { store, carriers, step } = await record("codex-carrier-empty", [
      ...surveyLines(),
      cell("call_answer", single(cmd, ',"max_output_tokens":200'), BASE + 1_000),
      command("exec-answer", cmd, "", BASE + 1_100),
      reply("call_answer", "", BASE + 1_200),
    ]);
    const { call, results } = carriers("call_answer");
    expect(call).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(store.get(results[0]!.baselineReference!)).toBe("");
    expect(step("call_answer").observed).toEqual({
      outcome: "succeeded",
      output: { type: "string", hasContent: false },
    });
  });

  it("pairs a command that completes after its cell replied with that cell's step", async () => {
    const stdout = "payments 138236 fees 1000 target 34\n";
    const cmd = "python3 - <<'PY'\nprint('payments')\nPY";
    const { store, carriers, step, workflow } = await record("codex-carrier-late", [
      cell("call_slow", single(cmd, ',"max_output_tokens":3500'), BASE),
      reply("call_slow", "", BASE + 10_300),
      command("exec-slow", cmd, stdout, BASE + 800),
    ]);
    const { call, results } = carriers("call_slow");
    expect(call).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(store.get(results[0]!.baselineReference!)).toBe(stdout);
    expect(step("call_slow").observed).toEqual({
      outcome: "succeeded",
      output: { type: "string", hasContent: true },
    });
    // The command is the cell's step, not a second one.
    expect(workflow.steps).toHaveLength(1);
  });

  it("records a failed command as a failed step and keeps its output out of the baseline", async () => {
    const cmd = "python - <<'PY'\nprint(1)\nPY";
    const { carriers, step } = await record("codex-carrier-failed", [
      ...surveyLines(),
      cell("call_missing", single(cmd, ',"max_output_tokens":3500'), BASE + 1_000),
      command(
        "exec-missing",
        cmd,
        "/bin/bash: line 1: python: command not found\n",
        BASE + 1_100,
        127,
      ),
      reply("call_missing", "/bin/bash: line 1: python: command not found\n", BASE + 1_200),
    ]);
    expect(carriers("call_missing").results).toEqual([]);
    expect(step("call_missing").observed.outcome).toBe("failed");
  });

  for (const [name, survey, status] of [
    ["an earlier cell that failed", SURVEY, "failed"],
    [
      "an earlier cell whose commands may outlive it",
      SURVEY.replace("Promise.allSettled", "Promise.all"),
      "completed",
    ],
    [
      "an earlier cell that never awaits its commands",
      SURVEY.replace("await Promise.allSettled", "Promise.allSettled"),
      "completed",
    ],
  ] as const) {
    it(`withholds a later cell's result after ${name}`, async () => {
      const cmd = "cat c.md";
      const { carriers } = await record(`codex-carrier-${status}-${name.length}`, [
        ...surveyLines(survey, status),
        cell("call_later", single(cmd, ""), BASE + 1_000),
        command("exec-later", cmd, "gamma\n", BASE + 1_100),
        reply("call_later", "gamma\n", BASE + 1_200),
      ]);
      expect(carriers("call_later").results).toEqual([]);
    });
  }
});
