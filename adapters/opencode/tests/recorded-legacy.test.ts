import type { IntermediateSessionEvent } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  OpencodeHarnessAdapter,
  OpencodeLegacyStore,
  OpencodeRecordDecoder,
  openOpencodeStore,
} from "../src/index.js";
import { LEGACY_STORAGE, drain } from "./helpers.js";

const MAIN = "ses_f200c3ab2ffe4yDbUHYTTAhaRF";
const CHILD = "ses_f200c0ab8ffezEyenGnxw5g0Yn";

describe("OpenCode 1.1.65 recorded legacy JSON storage", () => {
  const store = new OpencodeLegacyStore(LEGACY_STORAGE);
  const adapter = new OpencodeHarnessAdapter({
    store,
    now: () => Date.parse("2030-01-01T00:00:00Z"),
  });
  const decoder = new OpencodeRecordDecoder({ mcpServers: ["echo"] });

  async function decodeSession(sessionId: string): Promise<IntermediateSessionEvent[]> {
    const [workspace] = await adapter.listWorkspaces();
    const session = (await adapter.listSessions(workspace!)).find(
      (s) => s.sessionId === sessionId,
    )!;
    const records = await drain(await adapter.openEventSource(session));
    return records.flatMap((record) => decoder.decode(record));
  }

  it("is the store used when no SQLite database exists", () => {
    expect(
      openOpencodeStore({ dbPath: "/nonexistent/opencode.db", legacyStorageDir: LEGACY_STORAGE })
        ?.kind,
    ).toBe("legacy-json");
  });

  it("lists both sessions with the subagent linked to its parent", async () => {
    const [workspace] = await adapter.listWorkspaces();
    const sessions = await adapter.listSessions(workspace!);
    expect(sessions.map((s) => [s.sessionId, s.metadata.parentSessionId])).toEqual([
      [MAIN, undefined],
      [CHILD, MAIN],
    ]);
  });

  it("decodes tool calls, results, usage, and the subagent spawn", async () => {
    const events = await decodeSession(MAIN);
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((c) => c.toolName)).toEqual([
      "bash",
      "read",
      "edit",
      "write",
      "echo_echo",
      "task",
    ]);
    expect(calls.find((c) => c.toolName === "echo_echo")!.connection).toBe("echo");
    expect(events.filter((e) => e.type === "tool_result").every((r) => r.isError === false)).toBe(
      true,
    );
    expect(events.some((e) => e.type === "command_exec")).toBe(false);
    expect(events.filter((e) => e.type === "file_edit").map((e) => e.operation)).toEqual([
      "update",
      "create",
    ]);
    expect(
      events
        .filter((e) => e.type === "subagent_lifecycle")
        .map((e) => [e.lifecycleType, e.subagentId]),
    ).toEqual([
      ["spawn", CHILD],
      ["settle", CHILD],
    ]);
    const usage = events
      .filter((e) => e.type === "message" && e.role === "assistant")
      .map((e) => e.providerUsage);
    expect(usage).toHaveLength(7);
    expect(usage[0]).toMatchObject({
      provider: "github-copilot",
      model: "gpt-4.1",
      totalTokens: 14017,
    });
  });

  it("decodes the subagent session", async () => {
    const events = await decodeSession(CHILD);
    expect(events[1]).toMatchObject({
      type: "subagent_lifecycle",
      subagentId: CHILD,
      parentId: MAIN,
    });
    expect(events.filter((e) => e.type === "tool_call").map((c) => c.toolName)).toEqual([
      "glob",
      "read",
    ]);
  });

  it("lists the subagent session as an agent session linked to its parent, named from its title", async () => {
    const [workspace] = await adapter.listWorkspaces();
    const sessions = await adapter.listSessions(workspace!);
    const byId = new Map(sessions.map((s) => [s.sessionId, s.metadata]));
    expect(byId.get(MAIN)).toMatchObject({ sessionKind: "user" });
    expect(byId.get(MAIN)?.parentSessionId).toBeUndefined();
    expect(byId.get(CHILD)).toMatchObject({
      sessionKind: "agent",
      parentSessionId: MAIN,
      agentName: "general",
    });
  });

  it("records the child's calls once: the parent only has the task call, the child only its own", async () => {
    const parent = (await decodeSession(MAIN)).filter((e) => e.type === "tool_call");
    const child = (await decodeSession(CHILD)).filter((e) => e.type === "tool_call");
    expect(parent.some((c) => c.toolName === "task")).toBe(true);
    expect(child.some((c) => c.toolName === "task")).toBe(false);
    const parentIds = new Set(parent.map((c) => c.toolCallId));
    for (const call of child) expect(parentIds.has(call.toolCallId)).toBe(false);
    // The parent's `task` result embeds the child's answer as text only, never as tool calls.
    expect(parent.filter((c) => c.toolName === "glob")).toHaveLength(0);
  });
});
