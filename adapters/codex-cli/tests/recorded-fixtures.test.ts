import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NormalizedSessionEventSchema } from "@resin/contracts";
import type { NormalizedSessionEvent } from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHarnessAdapter } from "../src/adapter.js";
import { decodeCodexTranscript } from "../src/decoder.js";
import { CODEX_TESTED_VERSIONS } from "../src/discovery.js";

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "recorded");

async function recorded(version: string, scenario: string): Promise<string> {
  return fs.readFile(path.join(RECORDED, version, `${scenario}.jsonl`), "utf8");
}

async function decode(version: string, scenario: string): Promise<NormalizedSessionEvent[]> {
  const events = decodeCodexTranscript(await recorded(version, scenario));
  for (const event of events) NormalizedSessionEventSchema.parse(event);
  return events;
}

function ofType<T extends NormalizedSessionEvent["type"]>(
  events: NormalizedSessionEvent[],
  type: T,
): Extract<NormalizedSessionEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<NormalizedSessionEvent, { type: T }> => event.type === type,
  );
}

function sessionMeta(jsonl: string): Record<string, unknown> {
  const line = jsonl.split("\n").find((l) => l.includes('"type":"session_meta"'));
  return (JSON.parse(line!) as { payload: Record<string, unknown> }).payload;
}

const SCENARIOS = ["tools", "subagent-parent", "subagent-child", "compaction", "aborted-turn"];

describe.each(CODEX_TESTED_VERSIONS)("recorded Codex %s rollouts", (version) => {
  it.each(SCENARIOS)("decodes %s with every record understood", async (scenario) => {
    const events = await decode(version, scenario);
    expect(ofType(events, "unknown_passthrough")).toEqual([]);
    expect(events[0]).toMatchObject({ type: "session_lifecycle", lifecycleType: "start" });
  });

  it("captures shell, code-mode cells, apply_patch, MCP, Resin invoke_tool, and token usage", async () => {
    const events = await decode(version, "tools");

    const commands = ofType(events, "command_exec").map((event) => event.args.join(" "));
    expect(commands).toEqual(expect.arrayContaining(["-lc python3 greet.py"]));
    expect(commands.some((command) => command.includes("README.md"))).toBe(true);

    // Every model tool call is a code-mode `exec` cell; nested tools run inside it.
    const cells = ofType(events, "tool_call").filter((event) => event.toolName === "exec");
    expect(cells.length).toBeGreaterThan(3);

    const edited = ofType(events, "file_edit").map((event) => path.basename(event.filePath));
    expect(edited).toEqual(expect.arrayContaining(["greet.py", "NOTES.md"]));

    const mcpCalls = ofType(events, "tool_call").filter((event) => event.connection !== undefined);
    expect(mcpCalls.map((event) => [event.connection, event.toolName])).toEqual([
      ["fixture", "word_count"],
      ["resin", "invoke_tool"],
    ]);
    expect(mcpCalls[1]?.parameters).toMatchObject({ toolId: "fixture-nonexistent" });
    const results = ofType(events, "tool_result");
    const wordCount = results.find((event) => event.callId === mcpCalls[0]?.callId);
    expect(wordCount).toMatchObject({ result: "3", isError: false });
    const invoke = results.find((event) => event.callId === mcpCalls[1]?.callId);
    expect(invoke?.isError).toBe(true);
    expect(String(invoke?.result)).toContain("fixture-nonexistent");

    const usage = events.flatMap((event) => (event.providerUsage ? [event.providerUsage] : []));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((entry) => (entry.inputTokens ?? 0) > 0)).toBe(true);
  });

  it("captures compaction boundaries", async () => {
    const compactions = ofType(await decode(version, "compaction"), "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions.every((event) => event.triggerReason === "context_limit")).toBe(true);
    expect(compactions.every((event) => event.tokensBefore > 0)).toBe(true);
  });

  it("ends an interrupted turn with the running cell and command left incomplete", async () => {
    const events = await decode(version, "aborted-turn");
    expect(ofType(events, "session_lifecycle").at(-1)).toMatchObject({
      lifecycleType: "crash",
      exitReason: "interrupted",
    });
    const cell = ofType(events, "tool_call").find((event) =>
      JSON.stringify(event.parameters).includes("sleep 60"),
    );
    expect(cell).toBeDefined();
    expect(ofType(events, "tool_result").some((event) => event.callId === cell?.callId)).toBe(
      false,
    );
    const sleep = ofType(events, "command_exec").find((event) =>
      event.args.includes("sleep 60 && echo finished"),
    );
    expect(sleep?.exitCode).not.toBe(0);
  });

  it("links a spawned subagent to the child rollout that ran it", async () => {
    const parentJsonl = await recorded(version, "subagent-parent");
    const childJsonl = await recorded(version, "subagent-child");
    const parentId = sessionMeta(parentJsonl).id;
    const childMeta = sessionMeta(childJsonl);

    const lifecycle = ofType(await decode(version, "subagent-parent"), "subagent_lifecycle");
    expect(lifecycle.map((event) => event.lifecycleType)).toEqual(["spawn", "settle"]);
    expect(lifecycle.every((event) => event.subagentId === childMeta.id)).toBe(true);
    expect(lifecycle.every((event) => event.parentId === parentId)).toBe(true);
    expect(childMeta.parent_thread_id).toBe(parentId);
  });
});

describe("recorded headless rollouts under discovery", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it.each(CODEX_TESTED_VERSIONS)(
    "discovers %s `codex exec` rollouts and binds multi-agent children to the parent's project",
    async (version) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-codex-recorded-"));
      roots.push(root);
      const project = path.join(root, "project");
      const sessions = path.join(root, "sessions", "2026", "09", "26");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(sessions, { recursive: true });
      const names: Record<string, string> = {};
      for (const scenario of SCENARIOS) {
        const jsonl = (await recorded(version, scenario)).replaceAll("/workspace/project", project);
        const id = String(sessionMeta(jsonl).id);
        names[scenario] = `rollout-2026-09-26T00-00-00-${id}`;
        await fs.writeFile(path.join(sessions, `${names[scenario]}.jsonl`), jsonl);
      }

      const adapter = new CodexHarnessAdapter({ customSessionRoot: path.join(root, "sessions") });
      const workspaces = await adapter.listWorkspaces();
      const workspace = workspaces.find((candidate) => candidate.rootPath === project);
      expect(workspace).toBeDefined();
      const listed = await adapter.listSessions(workspace!);
      expect(listed.map((session) => session.sessionId).sort()).toEqual(
        SCENARIOS.map((scenario) => `sess_${names[scenario]}`).sort(),
      );
      const child = listed.find(
        (session) => session.sessionId === `sess_${names["subagent-child"]}`,
      );
      const parent = listed.find(
        (session) => session.sessionId === `sess_${names["subagent-parent"]}`,
      );
      expect(child?.workspaceId).toBe(parent?.workspaceId);
      expect(child?.metadata?.parentThreadId).toBe(parent?.metadata?.threadId);
    },
  );
});

describe("Codex record drift", () => {
  const header = JSON.stringify({
    timestamp: "2026-09-26T00:00:00.000Z",
    type: "session_meta",
    payload: { id: "t1", session_id: "t1", cwd: "/workspace/project", cli_version: "0.157.1" },
  });
  const itemCompleted = (item: Record<string, unknown>) =>
    JSON.stringify({
      timestamp: "2026-09-26T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "item_completed", thread_id: "t1", turn_id: "u1", item },
    });

  it.each([
    [
      "an unknown top-level record type",
      JSON.stringify({
        timestamp: "2026-09-26T00:00:01.000Z",
        type: "future_record",
        payload: { x: 1 },
      }),
    ],
    ["an unknown completed item type", itemCompleted({ type: "FutureItem", id: "i1" })],
    [
      "an MCP call item missing its server",
      itemCompleted({ type: "McpToolCall", id: "i1", tool: "word_count" }),
    ],
    [
      "an unknown multi-agent tool",
      itemCompleted({
        type: "CollabAgentToolCall",
        id: "i1",
        tool: "fork_agent",
        receiver_thread_ids: ["t2"],
      }),
    ],
    [
      "an unknown extension kind",
      itemCompleted({ type: "Extension", kind: "browser.open", id: "i1" }),
    ],
  ])("surfaces %s as unknown_passthrough instead of dropping it", (_label, record) => {
    const events = decodeCodexTranscript(`${header}\n${record}\n`);
    expect(events.filter((event) => event.type === "unknown_passthrough")).toHaveLength(1);
  });
});
