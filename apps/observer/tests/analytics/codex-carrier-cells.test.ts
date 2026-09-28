/**
 * A Codex code-mode cell that only reads the tool list and runs `tools.exec_command` is transport:
 * the recorded job is the native commands it ran, never the cell's JavaScript. Shapes follow Codex
 * 0.153 on native Windows (`shell:"powershell"` command options, a tool-listing preamble in its own
 * cell or in the command's cell) and Linux code mode.
 */
import { CodexRecordDecoder } from "@resin/adapter-codex";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-codex-carrier-cells";
const BASE = Date.parse("2026-09-28T22:09:50.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const WINDOWS_DIR = "C:\\Users\\user\\codex-job";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

type Line = { timestamp: string; type: string; payload: Record<string, unknown> };

const LIST_TOOLS = `text(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"));\n`;
const FIND_TOOLS = `const wanted = ["mcp__a__bundle","mcp__a__run"].map(name => ALL_TOOLS.find(tool => tool.name === name)).filter(Boolean);\ntext(wanted);\n`;

function sum(region: string): string {
  return `Import-Csv sales.csv | Where-Object region -eq '${region}' | Measure-Object -Property amount -Sum | Select-Object -ExpandProperty Sum`;
}

function runCommand(cmd: string, shell?: string, workdir = WINDOWS_DIR): string {
  const options = `cmd:${JSON.stringify(cmd)},${shell === undefined ? "" : `shell:${JSON.stringify(shell)},`}workdir:${JSON.stringify(workdir)},yield_time_ms:10000,max_output_tokens:1000`;
  return `const r = await tools.exec_command({${options}});\ntext(r.output);\n`;
}

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
      internal_chat_message_metadata_passthrough: { turn_id: "turn", create_time: time / 1000 },
    },
  };
}

function reply(callId: string, printed: string[], time: number): Line {
  return {
    timestamp: at(time),
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [
        { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
        ...printed.map((text) => ({ type: "input_text", text })),
      ],
    },
  };
}

function command(id: string, argv: string[], cwd: string, stdout: string, started: number): Line {
  return {
    timestamp: at(started + 5),
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "thread",
      turn_id: "turn",
      item: {
        type: "CommandExecution",
        id,
        command: argv,
        cwd,
        source: "unified_exec_startup",
        status: "completed",
        stdout,
        stderr: "",
        aggregated_output: stdout,
        exit_code: 0,
        duration: { secs: 0, nanos: 4_000_000 },
      },
      started_at_ms: started,
      completed_at_ms: started + 5,
    },
  };
}

function powershell(id: string, cmd: string, started: number): Line {
  return command(
    id,
    [POWERSHELL, "-Command", cmd],
    "file:///C:/Users/user/codex-job",
    "17\r\n",
    started,
  );
}

async function steps(sessionId: string, cwd: string, lines: Line[]) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const native: Line[] = [
    {
      timestamp: at(BASE - 5_000),
      type: "session_meta",
      payload: { id: sessionId, cwd, cli_version: "0.153.4" },
    },
    {
      timestamp: at(BASE - 5_000),
      type: "turn_context",
      payload: { turn_id: "turn", cwd, model: "gpt-6-sol" },
    },
    {
      timestamp: at(BASE - 4_000),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Sum the region's sales amounts." }],
      },
    },
    ...lines,
  ];
  const observed = [];
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
  const recipe = recordCallsFromEvents(
    sessionId,
    observed.map((event) => projectEventToMetadataOnly(event)),
  );
  if (recipe === undefined) throw new Error("expected a recording");
  return recipe.workflow.steps.map((step) => ({
    callId: step.callId,
    runtime: step.callable.runtime,
    name: step.callable.name,
    dialect: step.callable.program?.kind === "shell" ? step.callable.program.dialect : undefined,
    arguments: step.arguments.map((argument) => argument.name).sort(),
  }));
}

const POWERSHELL_STEP = (callId: string) => ({
  callId,
  runtime: "resin-process",
  name: "command_exec",
  dialect: "powershell",
  arguments: ["cmd", "resinCodexShellProfile", "workdir"],
});

describe("Codex code-mode carrier cells", () => {
  it('records a Windows tool-listing cell then a `shell:"powershell"` command cell as the command alone', async () => {
    expect(
      await steps("codex-windows-split", WINDOWS_DIR, [
        cell("call_list", FIND_TOOLS + LIST_TOOLS, BASE),
        reply("call_list", ["[]", ""], BASE + 50),
        cell("call_run", runCommand(sum("apac"), "powershell"), BASE + 1_000),
        powershell("exec-apac", sum("apac"), BASE + 1_100),
        reply("call_run", ["17\r\n"], BASE + 1_200),
      ]),
    ).toEqual([POWERSHELL_STEP("exec-apac")]);
  });

  it("records one Windows cell that lists tools and runs its command as the command alone", async () => {
    expect(
      await steps("codex-windows-combined", WINDOWS_DIR, [
        cell("call_both", LIST_TOOLS + runCommand(sum("emea"), "powershell"), BASE),
        powershell("exec-emea", sum("emea"), BASE + 100),
        reply("call_both", ["", "17\r\n"], BASE + 300),
      ]),
    ).toEqual([POWERSHELL_STEP("exec-emea")]);
  });

  it("records a Windows single-command cell without `shell` as its PowerShell command, not bash", async () => {
    expect(
      await steps("codex-windows-no-shell", WINDOWS_DIR, [
        cell("call_run", runCommand(sum("emea")), BASE),
        powershell("exec-emea", sum("emea"), BASE + 100),
        reply("call_run", ["17\r\n"], BASE + 300),
      ]),
    ).toEqual([POWERSHELL_STEP("exec-emea")]);
  });

  it("records a Linux tool-listing cell's command alone and keeps the audited single-command cell", async () => {
    const script = "wc -l sales.csv";
    const bash = (id: string, started: number) =>
      command(id, ["/bin/bash", "-lc", script], "file:///app", "5 sales.csv\n", started);
    expect(
      await steps("codex-linux-combined", "/app", [
        cell("call_both", LIST_TOOLS + runCommand(script, undefined, "/app"), BASE),
        bash("exec-first", BASE + 100),
        reply("call_both", ["", "5 sales.csv\n"], BASE + 300),
        cell("call_single", runCommand(script, undefined, "/app"), BASE + 1_000),
        bash("exec-second", BASE + 1_100),
        reply("call_single", ["5 sales.csv\n"], BASE + 1_200),
      ]),
    ).toEqual([
      {
        callId: "exec-first",
        runtime: "resin-process",
        name: "command_exec",
        dialect: "bash",
        arguments: ["cmd", "resinCodexShellProfile", "workdir"],
      },
      {
        callId: "call_single",
        runtime: "resin-process",
        name: "exec",
        dialect: "bash",
        arguments: ["cmd", "raw", "resinCodexShellProfile", "workdir"],
      },
    ]);
  });

  it("still records a cell that calls another harness tool as its own step", async () => {
    const recorded = await steps("codex-mcp-cell", "/app", [
      cell(
        "call_mcp",
        `${LIST_TOOLS}text(await tools.mcp__fixture__word_count({text:"a b"}));\n`,
        BASE,
      ),
      reply("call_mcp", ["", "2"], BASE + 300),
    ]);
    expect(recorded.map((step) => [step.callId, step.name])).toEqual([["call_mcp", "exec"]]);
  });
});
