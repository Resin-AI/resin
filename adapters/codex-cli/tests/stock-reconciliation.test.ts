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
