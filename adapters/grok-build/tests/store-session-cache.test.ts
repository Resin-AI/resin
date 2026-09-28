import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GrokSessionCache, listGrokSessions, readGrokSubagentParents } from "../src/store.js";

const io = vi.hoisted(() => ({ reads: [] as string[] }));

// Records every summary.json / meta.json read and subagents/ listing a scan performs.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((...args: Parameters<typeof actual.readFile>) => {
    io.reads.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  const readdir = ((...args: Parameters<typeof actual.readdir>) => {
    if (String(args[0]).endsWith("subagents")) io.reads.push(String(args[0]));
    return actual.readdir(...(args as [string]));
  }) as typeof actual.readdir;
  const mocked = { ...actual, readFile, readdir };
  return { ...mocked, default: mocked };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
});

function writeSession(projectDir: string, id: string, child?: string) {
  const dir = path.join(projectDir, id);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ info: { id, cwd: "/work" }, session_kind: "main" }),
  );
  nodeFs.writeFileSync(path.join(dir, "updates.jsonl"), "{}\n");
  if (child) {
    nodeFs.mkdirSync(path.join(dir, "subagents", child), { recursive: true });
    nodeFs.writeFileSync(
      path.join(dir, "subagents", child, "meta.json"),
      JSON.stringify({ child_session_id: child, parent_session_id: id }),
    );
  }
  return dir;
}

// The daemon rescans every 10 s; unchanged sessions must not be re-read on every scan.
describe("Grok session cache", () => {
  it("re-reads only sessions whose updates changed, with unchanged results", async () => {
    const projectDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "grok-session-cache-"));
    dirs.push(projectDir);
    for (let i = 0; i < 10; i++) writeSession(projectDir, `s${i}`, i === 2 ? "child-2" : undefined);
    const cache: GrokSessionCache = new Map();
    const scan = async () => {
      io.reads.length = 0;
      const entries = await listGrokSessions(projectDir, "/work", cache);
      const parents = await readGrokSubagentParents(entries, cache);
      return { entries, parents, reads: [...io.reads] };
    };

    const first = await scan();
    expect(first.reads.filter((p) => p.endsWith("summary.json"))).toHaveLength(10);
    expect(first.parents.get("child-2")).toBe("s2");

    const second = await scan();
    expect(second.reads).toEqual([]);
    expect(second.entries).toEqual(first.entries);
    expect(second.parents).toEqual(first.parents);

    const s5 = path.join(projectDir, "s5");
    nodeFs.writeFileSync(
      path.join(s5, "summary.json"),
      JSON.stringify({ info: { id: "s5", cwd: "/work" }, session_kind: "subagent" }),
    );
    nodeFs.appendFileSync(path.join(s5, "updates.jsonl"), "{}\n");
    const third = await scan();
    expect(third.reads).toEqual([path.join(s5, "summary.json"), path.join(s5, "subagents")]);
    expect(third.entries.find((e) => e.sessionId === "s5")?.summary?.sessionKind).toBe("subagent");
  });
});
