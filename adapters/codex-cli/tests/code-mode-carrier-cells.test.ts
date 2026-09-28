/**
 * Codex code-mode cells that only read the tool list and run `tools.exec_command` are transport:
 * the native `CommandExecution` items are the calls. Shapes follow Codex 0.153 on native Windows
 * (`shell:"powershell"` in the command options, a tool-listing preamble the guidance asks for) and
 * the recorded Linux 0.157.1 tool-listing cell.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readCodexCommandMetadata } from "@resin/contracts";
import type { NormalizedSessionEvent } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { isNativeCommandCarrierCell } from "../src/code-command.js";
import { CodexSessionDecoder, decodeCodexTranscript } from "../src/decoder.js";

const at = (ms: number) => new Date(ms).toISOString();
const BASE = Date.parse("2026-09-28T22:09:50.000Z");
const WORKDIR = "C:\\Users\\user\\codex-job";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const LIST_TOOLS = `text(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"));\n`;
const FIND_TOOLS = `const wanted = ["mcp__a__bundle","mcp__a__run"].map(name => ALL_TOOLS.find(tool => tool.name === name)).filter(Boolean);\ntext(wanted);\n`;

function sum(region: string): string {
  return `Import-Csv sales.csv | Where-Object region -eq '${region}' | Measure-Object -Property amount -Sum | Select-Object -ExpandProperty Sum`;
}

function windowsCommandCell(cmd: string, shell = 'shell:"powershell",'): string {
  return `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)},${shell}workdir:${JSON.stringify(WORKDIR)},yield_time_ms:10000,max_output_tokens:1000});\ntext(r.output);\n`;
}

function cell(callId: string, input: string, time: number) {
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

function reply(callId: string, printed: string[], time: number) {
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

function powershell(id: string, cmd: string, stdout: string, started: number) {
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
        command: [POWERSHELL, "-Command", cmd],
        cwd: "file:///C:/Users/user/codex-job",
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

function session(lines: object[]): string {
  return [
    {
      timestamp: at(BASE - 1_000),
      type: "session_meta",
      payload: { id: "thread", cwd: WORKDIR, cli_version: "0.153.4", originator: "codex_exec" },
    },
    {
      timestamp: at(BASE - 900),
      type: "turn_context",
      payload: { turn_id: "turn", cwd: WORKDIR, model: "gpt-6-sol" },
    },
    ...lines,
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

function cellKinds(events: NormalizedSessionEvent[]) {
  return events.flatMap((event) =>
    event.type === "tool_call" && event.toolName === "exec"
      ? [[event.callId, readCodexCommandMetadata(event.metadata)?.kind]]
      : [],
  );
}

describe("Codex code-mode carrier cells", () => {
  it('marks a Windows tool-listing cell and a `shell:"powershell"` command cell as carriers', () => {
    const events = decodeCodexTranscript(
      session([
        cell("call_list", FIND_TOOLS + LIST_TOOLS, BASE),
        reply("call_list", ["[]", ""], BASE + 50),
        cell("call_run", windowsCommandCell(sum("apac")), BASE + 1_000),
        powershell("exec-apac", sum("apac"), "17\r\n", BASE + 1_100),
        reply("call_run", ["17\r\n"], BASE + 1_200),
      ]),
      { sessionId: "windows-split" },
    );
    expect(cellKinds(events)).toEqual([
      ["call_list", "carrier-call"],
      ["call_run", "carrier-call"],
    ]);
    // The native command stays its own, unassociated call; neither reply claims it.
    const command = events.find((event) => event.type === "command_exec");
    expect(readCodexCommandMetadata(command?.metadata)).toEqual({
      version: 1,
      kind: "command",
      nativeId: "exec-apac",
      startedAtMs: BASE + 1_100,
    });
    for (const event of events)
      if (event.type === "tool_result")
        expect(readCodexCommandMetadata(event.metadata)).toBe(undefined);
  });

  it("marks one Windows cell that lists tools and then runs its command as a carrier", () => {
    const combined = `${LIST_TOOLS}const result = await tools.exec_command({"cmd":${JSON.stringify(sum("emea"))},"shell":"powershell","workdir":${JSON.stringify(WORKDIR)},"yield_time_ms":10000});\ntext(result.output);\n`;
    const events = decodeCodexTranscript(
      session([
        cell("call_both", combined, BASE),
        powershell("exec-emea", sum("emea"), "17\r\n", BASE + 100),
        reply("call_both", ["", "17\r\n"], BASE + 300),
      ]),
      { sessionId: "windows-combined" },
    );
    expect(cellKinds(events)).toEqual([["call_both", "carrier-call"]]);
  });

  it("never audits a Windows session's single-command cell as a bash call, even without `shell`", () => {
    const events = decodeCodexTranscript(
      session([
        cell("call_run", windowsCommandCell(sum("emea"), ""), BASE),
        powershell("exec-emea", sum("emea"), "17\r\n", BASE + 100),
        reply("call_run", ["17\r\n"], BASE + 200),
      ]),
      { sessionId: "windows-no-shell" },
    );
    expect(cellKinds(events)).toEqual([["call_run", "carrier-call"]]);
    const call = events.find((event) => event.type === "tool_call");
    expect(call?.type === "tool_call" && call.parameters).toEqual({
      raw: windowsCommandCell(sum("emea"), ""),
    });
  });

  it("keeps the audited Linux single-command cell a call and marks the tool-listing cell a carrier", async () => {
    const recorded = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "recorded",
      "0.157.1",
      "tool-listing-cell.jsonl",
    );
    const events = decodeCodexTranscript(await fs.readFile(recorded, "utf8"));
    expect(cellKinds(events).map(([, kind]) => kind)).toEqual(["carrier-call", "call"]);
  });

  it("does not let a carrier cell block a later audited single-command cell", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const decode = (line: object) => decoder.decodeRecord(line as Record<string, never>);
    decode(cell("call_list", LIST_TOOLS, BASE));
    decode(reply("call_list", [""], BASE + 50));
    const single = `const r = await tools.exec_command({cmd:"printf ok",workdir:"/repo"});\ntext(r.output);\n`;
    const [call] = decode(cell("call_single", single, BASE + 1_000));
    expect(readCodexCommandMetadata(call?.metadata)?.kind).toBe("call");
  });

  describe("a native command item Codex recorded without its output", () => {
    const cmd = sum("apac");
    const outputs = (lines: object[]) =>
      decodeCodexTranscript(session(lines), { sessionId: "windows-race" }).flatMap((event) =>
        event.type === "command_exec" ? [event.stdout] : [],
      );
    const race = (input: string, printed: string[], status = "completed") => [
      cell("call_run", input, BASE),
      powershell("exec-apac", cmd, "", BASE + 100),
      {
        ...reply("call_run", printed, BASE + 200),
        ...(status === "completed"
          ? {}
          : {
              payload: {
                type: "custom_tool_call_output",
                call_id: "call_run",
                output: [
                  {
                    type: "input_text",
                    text: `Script ${status}\nWall time 0.2 seconds\nOutput:\n`,
                  },
                  ...printed.map((text) => ({ type: "input_text", text })),
                ],
              },
            }),
      },
    ];

    it("takes the output the carrier cell printed for it, before the cell's reply", () => {
      const events = decodeCodexTranscript(session(race(windowsCommandCell(cmd), ["18\r\n"])), {
        sessionId: "windows-race",
      });
      const order = events.flatMap((event) =>
        event.type === "command_exec" || event.type === "tool_result" ? [event.type] : [],
      );
      expect(order).toEqual(["command_exec", "tool_result"]);
      const command = events.find((event) => event.type === "command_exec");
      expect(command?.type === "command_exec" && command.stdout).toBe("18\r\n");
      expect(readCodexCommandMetadata(command?.metadata)).toEqual({
        version: 1,
        kind: "command",
        nativeId: "exec-apac",
        startedAtMs: BASE + 100,
      });
    });

    it("takes it with `login:false` and without `shell` too", () => {
      expect(
        outputs(race(windowsCommandCell(cmd, 'shell:"powershell",login:false,'), ["18\r\n"])),
      ).toEqual(["18\r\n"]);
      expect(outputs(race(windowsCommandCell(cmd, ""), ["18\r\n"]))).toEqual(["18\r\n"]);
    });

    it.each([
      [
        "a cell that prints more than the output",
        windowsCommandCell(cmd).replace("text(r.output);", "text(JSON.stringify(r));"),
        ['{"output":"18"}'],
        "completed",
      ],
      [
        "a truncated print",
        windowsCommandCell(cmd),
        ["Warning: truncated output (original token count: 9)\n1…5 tokens truncated…8"],
        "completed",
      ],
      ["a failed cell", windowsCommandCell(cmd), ["18\r\n"], "failed"],
      [
        "a cell that printed another command",
        windowsCommandCell(sum("emea")),
        ["17\r\n"],
        "completed",
      ],
      [
        "a cell that ran two commands",
        `${windowsCommandCell(cmd)}const s = await tools.exec_command({cmd:"dir"});\ntext(s.output);\n`,
        ["18\r\n", "x"],
        "completed",
      ],
    ])("leaves it empty for %s", (_label, input, printed, status) => {
      expect(outputs(race(input, printed, status))).toEqual([""]);
    });

    it("keeps a native item's own output", () => {
      expect(
        outputs([
          cell("call_run", windowsCommandCell(cmd), BASE),
          powershell("exec-apac", cmd, "18\r\n", BASE + 100),
          reply("call_run", ["something else"], BASE + 200),
        ]),
      ).toEqual(["18\r\n"]);
    });

    it("releases a held command unchanged when the transcript ends before the reply", () => {
      expect(outputs(race(windowsCommandCell(cmd), ["18\r\n"]).slice(0, 2))).toEqual([""]);
    });
  });

  it.each([
    ["pure JavaScript", 'text([10, 7].join("+"));\n'],
    ["a literal print", 'text("done");\n'],
    ["an MCP tool", `${LIST_TOOLS}text(await tools.mcp__fixture__word_count({text:"a b"}));\n`],
    [
      "a patch beside a command",
      'await tools.exec_command({cmd:"ls"});\ntext(await tools.apply_patch("*** Begin Patch\\n*** End Patch"));\n',
    ],
    ["an unawaited command", 'tools.exec_command({cmd:"sleep 5"});\ntext(ALL_TOOLS.length);\n'],
    ["a deferred command", 'setTimeout(() => tools.exec_command({cmd:"ls"}), 10);\n'],
    ["an aliased tools object", 'const t = tools;\nawait t.exec_command({cmd:"ls"});\n'],
    ["a computed tool name", 'await tools["exec_command"]({cmd:"ls"});\n'],
    [
      "a caught Promise.all",
      'try { await Promise.all([tools.exec_command({cmd:"a"}), tools.exec_command({cmd:"b"})]); } catch (e) { text(String(e)); }\n',
    ],
  ])("does not mark a cell with %s as a carrier", (_label, source) => {
    expect(isNativeCommandCarrierCell(source)).toBe(false);
  });

  it.each([
    ["the tool list alone", FIND_TOOLS + LIST_TOOLS],
    ["a Windows command", windowsCommandCell(sum("apac"))],
    [
      "commands settled together",
      'const cmds = ["cat a.md", "cat b.md"];\nconst r = await Promise.allSettled(cmds.map(cmd => tools.exec_command({cmd, workdir:"/app"})));\nr.forEach((x, i) => text(cmds[i]));\n',
    ],
  ])("marks a cell with %s as a carrier", (_label, source) => {
    expect(isNativeCommandCarrierCell(source)).toBe(true);
  });
});
