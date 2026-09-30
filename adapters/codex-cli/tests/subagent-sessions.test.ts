/**
 * Multi-agent capture: a spawned child is its own rollout, listed as its own agent session linked
 * to the parent's session, decoded on its own, and never counted twice.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedSessionEvent } from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHarnessAdapter } from "../src/adapter.js";
import { decodeCodexTranscript } from "../src/decoder.js";
import { CODEX_TESTED_VERSIONS } from "../src/discovery.js";

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "recorded");

type Rollout = Array<{ type: string; payload: Record<string, unknown> }>;

async function rollout(version: string, scenario: string): Promise<Rollout> {
  const text = await fs.readFile(path.join(RECORDED, version, `${scenario}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Rollout[number]);
}

const jsonl = (records: Rollout): string => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

function ofType<T extends NormalizedSessionEvent["type"]>(
  events: NormalizedSessionEvent[],
  type: T,
): Extract<NormalizedSessionEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<NormalizedSessionEvent, { type: T }> => event.type === type,
  );
}

function toolCalls(records: Rollout, sessionId: string): string[] {
  return ofType(decodeCodexTranscript(jsonl(records), { sessionId }), "tool_call").map(
    (event) => `${event.toolName}:${JSON.stringify(event.parameters)}`,
  );
}

function usage(records: Rollout, sessionId: string): number {
  return decodeCodexTranscript(jsonl(records), { sessionId })
    .flatMap((event) => (event.providerUsage ? [event.providerUsage] : []))
    .reduce((sum, entry) => sum + (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0), 0);
}

describe.each(CODEX_TESTED_VERSIONS)("recorded Codex %s parent and child rollouts", (version) => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function install(files: Record<string, Rollout>): Promise<{
    adapter: CodexHarnessAdapter;
    project: string;
    names: Record<string, string>;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-codex-children-"));
    roots.push(root);
    const project = path.join(root, "project");
    const dir = path.join(root, "sessions", "2026", "09", "26");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(dir, { recursive: true });
    const names: Record<string, string> = {};
    for (const [key, records] of Object.entries(files)) {
      const text = jsonl(records).replaceAll("/workspace/project", project);
      const id = String(records[0]?.payload.id);
      names[key] = `sess_rollout-2026-09-26T00-00-00-${id}`;
      await fs.writeFile(path.join(dir, `${names[key]?.slice(5)}.jsonl`), text);
    }
    return {
      adapter: new CodexHarnessAdapter({ customSessionRoot: path.join(root, "sessions") }),
      project,
      names,
    };
  }

  async function sessionsOf(adapter: CodexHarnessAdapter, project: string) {
    const workspace = (await adapter.listWorkspaces()).find((w) => w.rootPath === project);
    expect(workspace).toBeDefined();
    return await adapter.listSessions(workspace!);
  }

  it("lists the child as an agent session linked to the parent's session id", async () => {
    const parent = await rollout(version, "subagent-parent");
    const child = await rollout(version, "subagent-child");
    const { adapter, project, names } = await install({ parent, child });

    const sessions = await sessionsOf(adapter, project);
    const listedParent = sessions.find((s) => s.sessionId === names.parent);
    const listedChild = sessions.find((s) => s.sessionId === names.child);

    expect(listedParent?.metadata?.sessionKind).not.toBe("agent");
    expect(listedParent?.metadata?.parentSessionId).toBeUndefined();
    const spawn = (
      (child[0]?.payload.source as Record<string, Record<string, Record<string, unknown>>>)
        .subagent as Record<string, Record<string, unknown>>
    ).thread_spawn;
    expect(listedChild?.metadata).toMatchObject({
      sessionKind: "agent",
      parentSessionId: names.parent,
      agentName: spawn?.agent_nickname,
      agentId: child[0]?.payload.id,
    });
    expect(listedChild?.sessionId).not.toBe(listedParent?.sessionId);
    // Stable across polls.
    const again = await sessionsOf(adapter, project);
    expect(again.map((s) => s.sessionId).sort()).toEqual(sessions.map((s) => s.sessionId).sort());
  });

  it("keeps the spawned child's tool calls and usage out of the parent's capture", async () => {
    const parent = await rollout(version, "subagent-parent");
    const child = await rollout(version, "subagent-child");
    const childId = String(child[0]?.payload.id);

    const parentCalls = toolCalls(parent, "parent");
    const childCalls = toolCalls(child, "child");
    expect(childCalls.length).toBeGreaterThan(0);
    expect(parentCalls.length).toBeGreaterThan(0);
    // The parent records the spawn as its own cell plus lifecycle events, never the child's cell.
    expect(parentCalls.filter((call) => childCalls.includes(call))).toEqual([]);
    const lifecycle = ofType(
      decodeCodexTranscript(jsonl(parent), { sessionId: "parent" }),
      "subagent_lifecycle",
    );
    expect(lifecycle.map((event) => event.subagentId)).toEqual([childId, childId]);
    expect(usage(child, "child")).toBeGreaterThan(0);
  });

  it("captures a forked child once: the history it replays from its parent is dropped", async () => {
    const parent = await rollout(version, "subagent-parent");
    const child = await rollout(version, "subagent-child");
    const parentId = String(parent[0]?.payload.id);
    const [ownMeta, ...ownRecords] = child;
    const forkMeta = {
      ...ownMeta!,
      payload: { ...ownMeta!.payload, forked_from_id: parentId },
    };
    // Real fork layout: own session_meta, the parent's whole history (its session_meta included),
    // then the fork's own turn.
    const forked: Rollout = [forkMeta, ...parent, ...ownRecords];

    const replayed = toolCalls(forked, "child");
    expect(replayed).toEqual(toolCalls(child, "child"));
    expect(replayed.some((call) => toolCalls(parent, "parent").includes(call))).toBe(false);
    expect(usage(forked, "child")).toBe(usage(child, "child"));
    expect(
      ofType(decodeCodexTranscript(jsonl(forked), { sessionId: "child" }), "subagent_lifecycle"),
    ).toEqual([]);
  });

  it("links a nested child to its immediate parent, not the root", async () => {
    const parent = await rollout(version, "subagent-parent");
    const child = await rollout(version, "subagent-child");
    const childId = String(child[0]?.payload.id);
    const rootId = String(parent[0]?.payload.id);
    // Any other unique thread id: only the parent link is under test.
    const grandId = `${childId.slice(0, -1)}0`;
    const grandchild: Rollout = child.map((record, index) =>
      index === 0
        ? {
            ...record,
            payload: {
              ...record.payload,
              id: grandId,
              session_id: rootId,
              parent_thread_id: childId,
              agent_nickname: "Kepler",
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: childId,
                    depth: 2,
                    agent_path: null,
                    agent_nickname: "Kepler",
                    agent_role: "explorer",
                  },
                },
              },
            },
          }
        : record,
    );
    const { adapter, project, names } = await install({ parent, child, grandchild });

    const sessions = await sessionsOf(adapter, project);
    const listedGrandchild = sessions.find((s) => s.sessionId === names.grandchild);
    expect(listedGrandchild?.metadata).toMatchObject({
      sessionKind: "agent",
      parentSessionId: names.child,
      agentName: "Kepler",
      agentKind: "explorer",
      agentDepth: 2,
    });
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(3);
  });
});
