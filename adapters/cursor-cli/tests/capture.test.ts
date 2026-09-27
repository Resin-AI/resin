import * as fs from "node:fs";
import path from "node:path";
import {
  type RawHarnessRecord,
  UNKNOWN_HARNESS_VERSION,
  classifyHarnessVersion,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  CURSOR_TARGET_VERSION,
  CursorHarnessAdapter,
  CursorRecordDecoder,
  CursorSessionEventSource,
  cursorProjectSlug,
  inspectCursorHookPayload,
  normalizeCursorVersion,
  probeCursorInstallation,
  resolveCursorProjectsDir,
} from "../src/index.js";
import { conversationPayloads, installedHook, tempHome } from "./helpers.js";
import { materializeRecordedHomes } from "./qualification-fixtures.js";

async function capture(home: string, payloads: Record<string, unknown>[]): Promise<void> {
  const run = await installedHook(home);
  for (const payload of payloads) run(payload);
}

async function readAll(
  adapter: CursorHarnessAdapter,
  sessionId: string,
): Promise<RawHarnessRecord[]> {
  for (const workspace of await adapter.listWorkspaces()) {
    const session = (await adapter.listSessions(workspace)).find((s) => s.sessionId === sessionId);
    if (session) return (await adapter.openEventSource(session)).readNext(1000);
  }
  throw new Error(`session ${sessionId} not found`);
}

describe("discovery", () => {
  it("binds sessions to the recorded cwd, links subagents, and reports uncaptured transcripts", async () => {
    const home = tempHome();
    const workspace = "/work/demo project";
    await capture(home, [
      ...conversationPayloads({ conversationId: "parent-1", workspace, subagentId: "child-1" }),
      // The subagent's own payloads omit workspace_roots: it inherits the parent's root.
      {
        conversation_id: "child-1",
        hook_event_name: "stop",
        status: "completed",
        workspace_roots: [],
      },
    ]);
    const transcripts = path.join(
      resolveCursorProjectsDir(home),
      cursorProjectSlug(workspace),
      "agent-transcripts",
    );
    fs.mkdirSync(path.join(transcripts, "parent-1", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(transcripts, "parent-1", "parent-1.jsonl"), "{}\n");
    fs.writeFileSync(path.join(transcripts, "parent-1", "subagents", "child-1.jsonl"), "{}\n");
    fs.mkdirSync(path.join(transcripts, "old-2"), { recursive: true });
    fs.writeFileSync(path.join(transcripts, "old-2", "old-2.jsonl"), "{}\n");
    fs.writeFileSync(path.join(transcripts, "parent-1", "subagents", "child-9.jsonl"), "{}\n");

    const adapter = new CursorHarnessAdapter({ home, env: {} });
    const workspaces = await adapter.listWorkspaces();
    expect(workspaces.map((w) => w.rootPath)).toEqual([workspace]);
    const sessions = await adapter.listSessions(workspaces[0]!);
    const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
    expect(Object.keys(byId).sort()).toEqual(["child-1", "parent-1"]);
    expect(byId["parent-1"]!.status).toBe("completed");
    expect(byId["child-1"]!.metadata).toMatchObject({
      parentSessionId: "parent-1",
      isSubagent: true,
      cwd: workspace,
    });

    const uncaptured = await adapter.listUncapturedSessions();
    expect(uncaptured.map((u) => [u.conversationId, u.parentConversationId, u.reason])).toEqual([
      ["old-2", null, "no-hook-capture"],
      ["child-9", "parent-1", "no-hook-capture"],
    ]);
  });
});

describe("event source", () => {
  it("resumes from its cursor and leaves a partial trailing line for later", async () => {
    const home = tempHome();
    await capture(
      home,
      conversationPayloads({ conversationId: "c1", workspace: "/w" }).slice(0, 3),
    );
    const adapter = new CursorHarnessAdapter({ home, env: {} });
    const [workspace] = await adapter.listWorkspaces();
    const [session] = await adapter.listSessions(workspace!);
    const source = new CursorSessionEventSource(session!);
    expect((await source.readNext(2)).map((r) => r.sequenceNumber)).toEqual([1, 2]);
    const cursor = source.getCursor();

    fs.appendFileSync(session!.transcriptPath, '{"hook_event_name":"stop"');
    const resumed = new CursorSessionEventSource(session!, cursor);
    const rest = await resumed.readNext();
    expect(rest.map((r) => r.sequenceNumber)).toEqual([3]);
    expect(await resumed.readNext()).toEqual([]);
    fs.appendFileSync(session!.transcriptPath, ',"status":"completed","conversation_id":"c1"}\n');
    expect((await resumed.readNext()).map((r) => r.sequenceNumber)).toEqual([4]);
  });
});

describe("decoder", () => {
  it("decodes recorded cursor-agent hooks without drift, with one identity per tool call", async () => {
    const home = tempHome();
    await materializeRecordedHomes(CURSOR_TARGET_VERSION, () => home);
    const adapter = new CursorHarnessAdapter({ home, env: {} });
    const decoder = new CursorRecordDecoder();
    const decode = async (id: string) =>
      (await readAll(adapter, id)).flatMap((record) => decoder.decode(record) ?? []);

    // Headless run: failed shell, edit reported as Read + Write sharing one tool_use_id, MCP call.
    const headless = await decode("a4624dd3-4991-4bb6-ba65-cf699d7609f9");
    const calls = headless.filter((e) => e.type === "tool_call");
    expect(calls.map((c) => c.toolName)).toEqual([
      "Read",
      "Shell",
      "Read",
      "Read",
      "MCP:echo",
      "Write",
      "Write",
    ]);
    expect(new Set(calls.map((c) => c.callId)).size).toBe(calls.length);
    for (const id of calls.map((c) => c.callId)) expect(id).toMatch(/^[\w-][\w.:-]{0,127}$/);
    expect(headless.find((e) => e.type === "tool_result" && e.toolName === "Shell")).toMatchObject({
      isError: true,
      error: "wc: README.md: No such file or directory",
    });
    expect(
      headless.filter((e) => e.type === "file_edit").map((e) => [e.filePath, e.operation]),
    ).toEqual([
      ["/workspace/project/notes.txt", "create"],
      ["/workspace/project/hello.py", "patch"],
    ]);

    // Interactive run with /compact: usage from `stop`, counted once per turn.
    const interactive = await decode("1e94d25f-abf7-4a83-9810-9fed67a25942");
    expect(interactive.find((e) => e.type === "compaction")).toMatchObject({
      triggerReason: "manual",
      tokensBefore: 9753,
    });
    const usage = interactive.flatMap((e) => (e.providerUsage ? [e.providerUsage] : []));
    expect(usage).toEqual([
      expect.objectContaining({ inputTokens: 9559, outputTokens: 194, cachedInputTokens: 9344 }),
    ]);
    expect(interactive.at(-1)).toMatchObject({ type: "session_lifecycle", lifecycleType: "end" });

    for (const workspace of await adapter.listWorkspaces()) {
      for (const session of await adapter.listSessions(workspace)) {
        await decode(session.sessionId);
      }
    }
    expect(decoder.driftIssues).toEqual([]);
  });

  it("reports drift instead of guessing at unknown events or changed fields", () => {
    const decoder = new CursorRecordDecoder();
    const record = (rawPayload: unknown, n: number): RawHarnessRecord => ({
      recordId: `r${n}`,
      sessionId: "s",
      harnessId: "cursor-cli",
      sequenceNumber: n,
      timestamp: "2026-09-26T00:00:00.000Z",
      recordType: "custom",
      rawPayload,
      cursor: { offset: 0, line: 1, sequence: n, timestamp: "2026-09-26T00:00:00.000Z" },
      metadata: {},
    });
    const base = {
      resin_received_at: "2026-09-26T00:00:00.000Z",
      workspace_roots: ["/w"],
      conversation_id: "s",
    };
    expect(decoder.decode(record({ ...base, hook_event_name: "afterTabFileEdit" }, 1))).toBeNull();
    expect(
      decoder.decode(
        record({ ...base, hook_event_name: "postToolUse", tool_name: "Shell", toolUseId: "x" }, 2),
      ),
    ).toBeNull();
    expect(
      decoder.decode(
        record({ ...base, hook_event_name: "stop", status: "completed", extra: 1 }, 3),
      ),
    ).toMatchObject([{ type: "session_lifecycle", lifecycleType: "end", exitReason: "completed" }]);
    expect(
      decoder.driftIssues.map((issue) => [issue.recordId, issue.kind, issue.field ?? issue.event]),
    ).toEqual([
      ["r1", "unknown_event", "afterTabFileEdit"],
      ["r2", "missing_field", "tool_use_id"],
    ]);
    expect(
      inspectCursorHookPayload({
        ...base,
        hook_event_name: "afterFileEdit",
        file_path: "a",
        edits: "x",
      }),
    ).toEqual([expect.objectContaining({ kind: "wrong_type", field: "edits" })]);
  });
});

describe("version pinning", () => {
  it("normalizes cursor-agent's date version and classifies it", () => {
    expect(normalizeCursorVersion("2026.09.26-dd393fe\n")).toBe("2026.9.26-dd393fe");
    const classify = (raw: string) =>
      classifyHarnessVersion(normalizeCursorVersion(raw), [CURSOR_TARGET_VERSION]);
    expect(classify("2026.09.26-dd393fe")).toBe("tested");
    expect(classify("2026.10.02-abc1234")).toBe("untested");
    expect(classify("garbage")).toBe("unknown");
  });
});

describe("cursor-agent installation probe", () => {
  it("reads the version from the versioned install directory without running the binary", async () => {
    const home = await tempHome();
    const versionDir = path.join(
      home,
      ".local",
      "share",
      "cursor-agent",
      "versions",
      "2026.09.26-dd393fe",
    );
    const bin = path.join(home, "bin");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.mkdirSync(bin);
    // A binary that fails if executed proves the probe read the layout instead.
    fs.writeFileSync(path.join(versionDir, "cursor-agent"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.symlinkSync(path.join(versionDir, "cursor-agent"), path.join(bin, "cursor-agent"));
    const installation = await probeCursorInstallation({ home, env: { PATH: bin } });
    expect(installation).toMatchObject({
      version: "2026.9.26-dd393fe",
      executablePath: path.join(bin, "cursor-agent"),
      metadata: { rawVersion: "2026.09.26-dd393fe" },
    });

    fs.rmSync(path.join(bin, "cursor-agent"));
    fs.writeFileSync(path.join(bin, "cursor-agent"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await probeCursorInstallation({ home, env: { PATH: bin } })).toMatchObject({
      version: UNKNOWN_HARNESS_VERSION,
      metadata: { rawVersion: null },
    });
  });
});
