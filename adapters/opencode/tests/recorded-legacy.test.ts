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
    expect(events.find((e) => e.type === "command_exec")).toMatchObject({
      command: "node greet.js",
      exitCode: 0,
    });
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
});
