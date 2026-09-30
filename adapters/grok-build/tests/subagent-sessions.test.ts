import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokHarnessAdapter } from "../src/adapter.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface SessionSpec {
  readonly id: string;
  readonly cwd: string;
  readonly kind: "headless" | "subagent";
  readonly agentName?: string;
  /** `subagents/<child>/meta.json` files this session's directory holds. */
  readonly children?: ReadonlyArray<{ id: string; type: string; description: string }>;
}

async function writeSession(home: string, spec: SessionSpec): Promise<void> {
  const dir = path.join(home, ".grok", "sessions", encodeURIComponent(spec.cwd), spec.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "summary.json"),
    JSON.stringify({
      info: { id: spec.id, cwd: spec.cwd },
      session_kind: spec.kind,
      created_at: "2026-09-26T22:00:00Z",
      ...(spec.agentName ? { agent_name: spec.agentName } : {}),
    }),
  );
  await fs.writeFile(path.join(dir, "updates.jsonl"), "");
  for (const child of spec.children ?? []) {
    const metaDir = path.join(dir, "subagents", child.id);
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(
      path.join(metaDir, "meta.json"),
      JSON.stringify({
        subagent_id: child.id,
        parent_session_id: spec.id,
        child_session_id: child.id,
        subagent_type: child.type,
        description: child.description,
      }),
    );
  }
}

async function listAll(home: string) {
  const adapter = new GrokHarnessAdapter({ home, env: {} });
  const sessions = new Map<string, Record<string, unknown>>();
  for (const workspace of await adapter.listWorkspaces()) {
    for (const session of await adapter.listSessions(workspace)) {
      sessions.set(session.sessionId, session.metadata);
    }
  }
  return sessions;
}

describe("grok subagent sessions", () => {
  it("links a nested child to its immediate parent, not the root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-grok-nested-"));
    dirs.push(home);
    await writeSession(home, {
      id: "root",
      cwd: "/work",
      kind: "headless",
      children: [{ id: "child", type: "general", description: "outer" }],
    });
    await writeSession(home, {
      id: "child",
      cwd: "/work",
      kind: "subagent",
      agentName: "general",
      children: [{ id: "grandchild", type: "explore", description: "inner" }],
    });
    await writeSession(home, { id: "grandchild", cwd: "/work", kind: "subagent" });

    const sessions = await listAll(home);
    expect(sessions.get("root")).toMatchObject({ sessionKind: "user" });
    expect(sessions.get("root")?.parentSessionId).toBeUndefined();
    expect(sessions.get("child")).toMatchObject({
      sessionKind: "agent",
      parentSessionId: "root",
      agentName: "general",
      agentKind: "general",
    });
    // No `agent_name` in the grandchild's summary: the meta's subagent type names it.
    expect(sessions.get("grandchild")).toMatchObject({
      sessionKind: "agent",
      parentSessionId: "child",
      agentName: "explore",
      agentKind: "explore",
      agentId: "grandchild",
    });
  });

  it("links a child that lives under another cwd to the parent in its own project", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-grok-worktree-"));
    dirs.push(home);
    await writeSession(home, {
      id: "parent",
      cwd: "/work",
      kind: "headless",
      children: [{ id: "wt-child", type: "task", description: "in a worktree" }],
    });
    await writeSession(home, { id: "wt-child", cwd: "/work-worktree", kind: "subagent" });

    const sessions = await listAll(home);
    expect(sessions.get("wt-child")).toMatchObject({
      sessionKind: "agent",
      parentSessionId: "parent",
      agentKind: "task",
    });
  });
});
