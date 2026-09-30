import { readCodexCommandMetadata } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { CodexSessionDecoder } from "../src/decoder.js";

const at = (ms: number) => new Date(ms).toISOString();
const base = Date.parse("2026-09-24T12:00:00Z");
function call(id: string, script: string, time: number, workdir = "/repo") {
  return {
    type: "response_item",
    timestamp: at(time),
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: id,
      input: `const r = await tools.exec_command({cmd:${JSON.stringify(script)},workdir:${JSON.stringify(workdir)}}); text(r.output);`,
      internal_chat_message_metadata_passthrough: { create_time: (time - 10) / 1000 },
    },
  };
}
function reply(id: string, time: number, status = "completed", output = "ok") {
  return {
    type: "response_item",
    timestamp: at(time),
    payload: {
      type: "custom_tool_call_output",
      call_id: id,
      output: [
        {
          type: "input_text",
          text: `Script ${status === "running" ? "running with cell ID test" : status}\nWall time 0.1 seconds\nOutput:\n`,
        },
        { type: "input_text", text: output },
      ],
    },
  };
}
function command(
  id: string,
  script: string,
  started: number,
  time: number,
  cwd = "file:///repo",
  exit = 0,
) {
  return {
    type: "event_msg",
    timestamp: at(time),
    payload: {
      type: "item_completed",
      started_at_ms: started,
      item: {
        type: "CommandExecution",
        id,
        command: ["/bin/bash", "-lc", script],
        cwd,
        status: exit === 0 ? "completed" : "failed",
        exit_code: exit,
        stdout: "ok",
        stderr: "",
      },
    },
  };
}

describe("stock Codex command reconciliation", () => {
  it("associates an ordinary command without altering native argv or authored output", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const start = decoder.decodeRecord(call("c1", "printf ok", base, "/repo"))[0]!;
    const native = decoder.decodeRecord(command("n1", "printf ok", base + 20, base + 40))[0]!;
    const result = decoder.decodeRecord(reply("c1", base + 80))[0]!;
    expect(start.type).toBe("tool_call");
    if (start.type === "tool_call")
      expect(start.parameters).toMatchObject({ cmd: "printf ok", workdir: "/repo" });
    expect(native.type).toBe("command_exec");
    if (native.type === "command_exec")
      expect([native.command, ...native.args]).toEqual(["/bin/bash", "-lc", "printf ok"]);
    expect(readCodexCommandMetadata(native.metadata)).toMatchObject({
      kind: "command",
      nativeId: "n1",
      startedAtMs: base + 20,
    });
    expect(readCodexCommandMetadata(result.metadata)).toMatchObject({
      kind: "result",
      association: {
        callId: "c1",
        nativeCommandId: "n1",
        callStartedAtMs: base,
        callCompletedAtMs: base + 80,
      },
    });
    if (result.type === "tool_result")
      expect(result.result).toEqual([{ type: "input_text", text: "ok" }]);
  });

  it("uses source-observed session cwd when code-mode omits workdir", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    decoder.decodeRecord({
      type: "session_meta",
      timestamp: at(base - 100),
      payload: { cwd: "/old", id: "s" },
    });
    decoder.decodeRecord({
      type: "turn_context",
      timestamp: at(base - 50),
      payload: { cwd: "/repo" },
    });
    const root = call("implicit", "echo ok", base);
    root.payload.input = root.payload.input.replace(',workdir:"/repo"', "");
    const callEvent = decoder.decodeRecord(root)[0]!;
    if (callEvent.type === "tool_call") {
      expect(callEvent.parameters).toMatchObject({ cmd: "echo ok", workdir: "/repo" });
      expect(callEvent.parameters.raw).toBe(root.payload.input);
    }
    decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30));
    const result = decoder.decodeRecord(reply("implicit", base + 40))[0]!;
    expect(readCodexCommandMetadata(result.metadata)).toMatchObject({
      association: { callId: "implicit", nativeCommandId: "n1" },
    });
    const unknown = new CodexSessionDecoder({ sessionId: "unknown" });
    unknown.decodeRecord(root);
    unknown.decodeRecord(command("n1", "echo ok", base + 20, base + 30));
    expect(
      readCodexCommandMetadata(unknown.decodeRecord(reply("implicit", base + 40))[0]!.metadata),
    ).not.toHaveProperty("association");
  });

  it("attaches late completion to the command and preserves independent failure", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    decoder.decodeRecord(call("c1", "false", base));
    const result = decoder.decodeRecord(reply("c1", base + 100, "failed", "error"))[0]!;
    expect(readCodexCommandMetadata(result.metadata)).toMatchObject({
      kind: "result",
      status: "failed",
    });
    const native = decoder.decodeRecord(
      command("n1", "false", base + 20, base + 120, "file:///repo", 7),
    )[0]!;
    expect(readCodexCommandMetadata(native.metadata)).toMatchObject({
      kind: "command",
      association: { callId: "c1", nativeCommandId: "n1" },
    });
    if (native.type === "command_exec") expect(native.exitCode).toBe(7);
  });

  it("rejects mismatched script/cwd and overlapping or yielded wrappers", () => {
    for (const [script, cwd] of [
      ["other", "file:///repo"],
      ["echo ok", "file:///other"],
    ]) {
      const decoder = new CodexSessionDecoder({ sessionId: "s" });
      decoder.decodeRecord(call("c1", "echo ok", base));
      const native = decoder.decodeRecord(command("n1", script!, base + 20, base + 40, cwd!))[0]!;
      expect(readCodexCommandMetadata(native.metadata)).toMatchObject({
        kind: "command",
        nativeId: "n1",
      });
      expect(readCodexCommandMetadata(native.metadata)).not.toHaveProperty("association");
    }
    const concurrent = new CodexSessionDecoder({ sessionId: "s" });
    concurrent.decodeRecord(call("c1", "echo ok", base));
    concurrent.decodeRecord(call("c2", "echo ok", base + 1));
    expect(
      readCodexCommandMetadata(
        concurrent.decodeRecord(command("n1", "echo ok", base + 20, base + 40))[0]!.metadata,
      ),
    ).not.toHaveProperty("association");
    const yielded = new CodexSessionDecoder({ sessionId: "s" });
    yielded.decodeRecord(call("c1", "echo ok", base));
    yielded.decodeRecord(reply("c1", base + 10, "running"));
    expect(
      readCodexCommandMetadata(
        yielded.decodeRecord(command("n1", "echo ok", base + 5, base + 20))[0]!.metadata,
      ),
    ).not.toHaveProperty("association");
  });

  it("rejects two native starts in one root interval in either completion order", () => {
    for (const order of ["first", "second"] as const) {
      const decoder = new CodexSessionDecoder({ sessionId: "s" });
      decoder.decodeRecord(call("c1", "echo ok", base));
      const first = command("n1", "echo ok", base + 10, base + 20);
      const second = command("n2", "echo ok", base + 30, base + 40);
      const children = order === "first" ? [first, second] : [second, first];
      const events = children.map((child) => decoder.decodeRecord(child)[0]!);
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "command_exec")).toBe(true);
      const result = decoder.decodeRecord(reply("c1", base + 100))[0]!;
      expect(readCodexCommandMetadata(result.metadata)).toMatchObject({ kind: "result" });
      expect(readCodexCommandMetadata(result.metadata)).not.toHaveProperty("association");
    }
  });

  it("keeps identical empty commands distinct and never invents a rejected command", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    decoder.decodeRecord(call("c1", "", base));
    const first = decoder.decodeRecord(command("n1", "", base + 20, base + 30))[0]!;
    decoder.decodeRecord(reply("c1", base + 40));
    decoder.decodeRecord(call("c2", "", base + 50));
    const second = decoder.decodeRecord(command("n2", "", base + 70, base + 80))[0]!;
    const result = decoder.decodeRecord(reply("c2", base + 90))[0]!;
    expect(readCodexCommandMetadata(first.metadata)).toMatchObject({ nativeId: "n1" });
    expect(readCodexCommandMetadata(second.metadata)).toMatchObject({ nativeId: "n2" });
    expect(readCodexCommandMetadata(result.metadata)).toMatchObject({
      association: { callId: "c2", nativeCommandId: "n2" },
    });
    const rejected = decoder.decodeRecord(call("rejected", "bad", base + 100));
    const failed = decoder.decodeRecord(reply("rejected", base + 110, "failed"));
    expect([...rejected, ...failed].filter((event) => event.type === "command_exec")).toEqual([]);
    expect(readCodexCommandMetadata(failed[0]!.metadata)).not.toHaveProperty("association");
  });
  it("does not borrow a delayed command from unsupported background code mode", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const unsupported = call("background", "echo ok", base);
    unsupported.payload.input =
      "tools.exec_command({cmd:'echo ok',workdir:'/repo'}); text('done');";
    decoder.decodeRecord(unsupported);
    decoder.decodeRecord(reply("background", base + 5));
    decoder.decodeRecord(call("later", "echo ok", base + 10));
    const native = decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30))[0]!;
    expect(readCodexCommandMetadata(native.metadata)).not.toHaveProperty("association");
  });

  it("rejects dynamic code-mode command calls rather than borrowing a later wrapper", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const dynamic = call("dynamic", "echo ok", base);
    dynamic.payload.input =
      "const method = 'exec_command'; tools[method]({cmd:'echo ok',workdir:'/repo'});";
    decoder.decodeRecord(dynamic);
    decoder.decodeRecord(reply("dynamic", base + 5));
    decoder.decodeRecord(call("later", "echo ok", base + 10));
    decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30));
    expect(
      readCodexCommandMetadata(decoder.decodeRecord(reply("later", base + 40))[0]!.metadata),
    ).not.toHaveProperty("association");
  });

  it("fails closed for aliased or dynamic JavaScript before a later matching wrapper", () => {
    for (const source of [
      "const t = tools; t.exec_command({cmd:'echo ok',workdir:'/repo'});",
      "const {exec_command} = tools; exec_command({cmd:'echo ok',workdir:'/repo'});",
      "eval('tools.exec_command({cmd:\"echo ok\"})');",
    ]) {
      const decoder = new CodexSessionDecoder({ sessionId: "s" });
      const unsafe = call("unsafe", "echo ok", base);
      unsafe.payload.input = source;
      decoder.decodeRecord(unsafe);
      decoder.decodeRecord(reply("unsafe", base + 5));
      decoder.decodeRecord(call("later", "echo ok", base + 10));
      const native = decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30))[0]!;
      expect(readCodexCommandMetadata(native.metadata)).not.toHaveProperty("association");
      expect(
        readCodexCommandMetadata(decoder.decodeRecord(reply("later", base + 40))[0]!.metadata),
      ).not.toHaveProperty("association");
    }
  });

  it("trusts a later wrapper only once an awaited multi-command cell has completed", () => {
    const settled =
      "const cmds=['cat a','cat b'];\nconst r=await Promise.allSettled(cmds.map(cmd=>tools.exec_command({cmd,workdir:'/repo'})));\nr.forEach((x,i)=>text(String(x.status)));";
    const associated = (source: string, replyBeforeLater: boolean) => {
      const decoder = new CodexSessionDecoder({ sessionId: "s" });
      const survey = call("survey", "ignored", base);
      survey.payload.input = source;
      decoder.decodeRecord(survey);
      if (replyBeforeLater) decoder.decodeRecord(reply("survey", base + 5));
      decoder.decodeRecord(call("later", "echo ok", base + 10));
      decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30));
      if (!replyBeforeLater) decoder.decodeRecord(reply("survey", base + 35));
      return readCodexCommandMetadata(decoder.decodeRecord(reply("later", base + 40))[0]!.metadata);
    };
    expect(associated(settled, true)).toMatchObject({
      association: { callId: "later", nativeCommandId: "n1" },
    });
    // Still running when the later command started: its commands could be that command.
    expect(associated(settled, false)).not.toHaveProperty("association");
    // Cell sources (never executed): each could start a command after the cell completes.
    for (const unproven of [
      settled.replace("cmd=>tools.exec_command", "cmd=>setTimeout(()=>tools.exec_command"),
      settled.replace("cmds.map", "({map:(f)=>[f('x')]}).map"),
      settled.replace("const cmds=['cat a','cat b'];", "const cmds=['cat a'];cmds.map=(f)=>[];"),
      settled.replace("Promise.allSettled", "Promise.race"),
      `const t=tools;\n${settled}`,
    ])
      expect(associated(unproven, true)).not.toHaveProperty("association");
  });

  it("trusts a later wrapper after a completed uncaught Promise.all cell, not a caught one", () => {
    const pooled =
      "const [info, r] = await Promise.all([Promise.resolve(ALL_TOOLS.map(t => t.name).join('\\n')), tools.exec_command({cmd:'cat a',workdir:'/repo'})]);\ntext(info);\ntext(r.output);";
    const associated = (source: string) => {
      const decoder = new CodexSessionDecoder({ sessionId: "s" });
      const survey = call("survey", "ignored", base);
      survey.payload.input = source;
      decoder.decodeRecord(survey);
      decoder.decodeRecord(reply("survey", base + 5));
      decoder.decodeRecord(call("later", "echo ok", base + 10));
      decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30));
      return readCodexCommandMetadata(decoder.decodeRecord(reply("later", base + 40))[0]!.metadata);
    };
    expect(associated(pooled)).toMatchObject({
      association: { callId: "later", nativeCommandId: "n1" },
    });
    // A caught rejection completes the cell while the other commands may still be running.
    for (const unproven of [
      `try {\n${pooled}\n} catch (e) { text(String(e)); }`,
      pooled.replace(
        "tools.exec_command({cmd:'cat a',workdir:'/repo'})",
        "Promise.resolve(tools.exec_command({cmd:'cat a'}))",
      ),
    ])
      expect(associated(unproven)).not.toHaveProperty("association");
  });

  it("does not treat quoted apply-patch source as a concurrent command", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const patch = call("patch", "ignored", base);
    patch.payload.input =
      "const patch = 'tools.exec_command({cmd:\"fake\"})'; text(await tools.apply_patch(patch));";
    decoder.decodeRecord(patch);
    decoder.decodeRecord(reply("patch", base + 5));
    decoder.decodeRecord(call("later", "echo ok", base + 10));
    decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30));
    const result = decoder.decodeRecord(reply("later", base + 40))[0]!;
    expect(readCodexCommandMetadata(result.metadata)).toMatchObject({
      association: { callId: "later", nativeCommandId: "n1" },
    });
  });

  it("retains a failed CodeMode reply even when its JavaScript is unsupported", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const unsupported = call("bad", "ignored", base);
    unsupported.payload.input = "throw new Error('failed before command');";
    decoder.decodeRecord(unsupported);
    const raw = reply("bad", base + 10, "failed", "Error: failed before command");
    const result = decoder.decodeRecord(raw)[0]!;
    expect(result.type).toBe("tool_result");
    if (result.type === "tool_result") {
      expect(result.isError).toBe(true);
    }
    expect(readCodexCommandMetadata(result.metadata)).toBeUndefined();
    const direct = new CodexSessionDecoder({ sessionId: "direct" });
    direct.decodeRecord({
      type: "response_item",
      timestamp: at(base),
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "direct",
        arguments: '{"cmd":"echo Script failed"}',
      },
    });
    const directResult = direct.decodeRecord({
      type: "response_item",
      timestamp: at(base + 10),
      payload: {
        type: "function_call_output",
        call_id: "direct",
        output: "Script failed\\nFinal output:\\n",
      },
    })[0]!;
    if (directResult.type === "tool_result") expect(directResult.isError).toBe(false);
  });
});

describe("polled long-running Codex commands", () => {
  // Shapes from a recorded Codex 0.156.1 tesseract batch: the cell yields after `yield_time_ms` with
  // the command still running, later cells poll its session, and the native `CommandExecution`
  // (whose `process_id` is the session ID) completes during the last poll.
  const script =
    "python - <<'PY'\nimport subprocess\nprint(subprocess.run(['tesseract','a.png','stdout']))\nPY";
  const running = (session: number) =>
    JSON.stringify({ chunk_id: "d48946", wall_time_seconds: 30, session_id: session, output: "" });
  function stdin(id: string, session: number, chars: string, time: number) {
    const cell = call(id, "ignored", time);
    cell.payload.input = `const r=await tools.write_stdin({session_id:${session},chars:${JSON.stringify(chars)},yield_time_ms:30000,max_output_tokens:18000});text(r)\n`;
    return cell;
  }
  function exited(session: string, started: number, time: number, exit = 0) {
    const event = command("n1", script, started, time, "file:///repo", exit);
    return {
      ...event,
      payload: {
        ...event.payload,
        item: { ...event.payload.item, process_id: session, stdout: "page one\npage two\n" },
      },
    };
  }
  function start(decoder: CodexSessionDecoder, print: "text(r)" | "text(r.output)") {
    const origin = call("origin", script, base);
    origin.payload.input = origin.payload.input.replace("text(r.output);", `${print};`);
    decoder.decodeRecord(origin);
    return decoder.decodeRecord(reply("origin", base + 30_000, "completed", running(9824)))[0]!;
  }

  it("links the command's completion, seen only while polling, to the cell that started it", () => {
    for (const print of ["text(r)", "text(r.output)"] as const) {
      const decoder = new CodexSessionDecoder({ sessionId: "s" });
      const result = start(decoder, print);
      expect(readCodexCommandMetadata(result.metadata)).toMatchObject({
        kind: "result",
        status: "completed",
      });
      for (const [index, time] of [base + 31_000, base + 62_000].entries()) {
        decoder.decodeRecord(stdin(`poll${index}`, 9824, "", time));
        decoder.decodeRecord(reply(`poll${index}`, time + 30_000, "completed", running(9824)));
      }
      decoder.decodeRecord(stdin("last", 9824, "", base + 93_000));
      const native = decoder.decodeRecord(exited("9824", base + 20, base + 110_000))[0]!;
      decoder.decodeRecord(reply("last", base + 110_100, "completed", "{}"));
      expect(readCodexCommandMetadata(native.metadata)).toMatchObject({
        kind: "command",
        nativeId: "n1",
        association: {
          callId: "origin",
          nativeCommandId: "n1",
          startedAtMs: base + 20,
          callCompletedAtMs: base + 30_000,
        },
      });
      expect(native).toMatchObject({ exitCode: 0, stdout: "page one\npage two\n" });
    }
  });

  it("keeps a command that received input, or completed during another session's poll, unlinked", () => {
    for (const [session, chars] of [
      [9824, "\u0003"],
      [9824, "y\n"],
      [4012, ""],
    ] as const) {
      const decoder = new CodexSessionDecoder({ sessionId: "s" });
      start(decoder, "text(r)");
      if (chars !== "") {
        decoder.decodeRecord(stdin("input", session, chars, base + 31_000));
        decoder.decodeRecord(reply("input", base + 31_500, "completed", running(9824)));
      }
      decoder.decodeRecord(stdin("poll", chars === "" ? session : 9824, "", base + 32_000));
      const native = decoder.decodeRecord(exited("9824", base + 20, base + 40_000, 130))[0]!;
      expect(native.type).toBe("command_exec");
      expect(readCodexCommandMetadata(native.metadata)).not.toHaveProperty("association");
    }
  });

  it("leaves a command that never reports an exit unresolved", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const events = [start(decoder, "text(r)")];
    decoder.decodeRecord(stdin("poll", 9824, "", base + 31_000));
    events.push(...decoder.decodeRecord(reply("poll", base + 61_000, "completed", running(9824))));
    expect(events.filter((event) => event.type === "command_exec")).toEqual([]);
    expect(readCodexCommandMetadata(events[0]!.metadata)).not.toHaveProperty("association");
  });
});

describe("code-mode cells that cannot start a native command", () => {
  // Recorded Codex 0.156.1 shapes: image inspection cells and a failed `apply_patch` verification.
  const viewImage =
    'const r=await tools.view_image({path:"/workspace/data/IMG-9103.png",detail:"original"});image(r.image_url)\n';
  const viewImages =
    'const ids=["9041","9042"];for(const id of ids){const r=await tools.view_image({path:`/workspace/data/IMG-${id}.png`,detail:"original"});text(id);image(r.image_url,"original");}\n';
  const patch =
    'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /app/a.py\\n@@\\n-x\\n+y\\n*** End Patch\\n"))';
  function linksLaterWrapper(source: string, status: string, open = false) {
    const decoder = new CodexSessionDecoder({ sessionId: "s" });
    const cell = call("cell", "ignored", base);
    cell.payload.input = source;
    decoder.decodeRecord(cell);
    if (!open) decoder.decodeRecord(reply("cell", base + 5, status, "Script error"));
    decoder.decodeRecord(call("later", "echo ok", base + 10));
    decoder.decodeRecord(command("n1", "echo ok", base + 20, base + 30));
    return readCodexCommandMetadata(decoder.decodeRecord(reply("later", base + 40))[0]!.metadata);
  }

  it("still links later single-command cells after image and patch-only cells", () => {
    for (const [source, status, open] of [
      [viewImage, "completed", false],
      [viewImage, "completed", true],
      [viewImages, "completed", false],
      [patch, "failed", false],
    ] as const)
      expect(linksLaterWrapper(source, status, open)).toMatchObject({
        association: { callId: "later", nativeCommandId: "n1" },
      });
  });

  it("stays unsafe when the cell could start a command", () => {
    for (const source of [
      'text(await tools.exec_command({cmd:"rm -rf app/__pycache__",workdir:"/app"}));',
      `${viewImage}eval('tools.exec_command({cmd:"echo ok"})');`,
      'const t=tools;const r=await t.view_image({path:"/a.png"});image(r.image_url)',
    ])
      expect(linksLaterWrapper(source, "failed")).not.toHaveProperty("association");
  });
});
