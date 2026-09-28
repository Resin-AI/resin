import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodexInspectionCache, discoverCodexTranscripts } from "../src/discovery.js";

const io = vi.hoisted(() => ({ opened: [] as string[] }));

// Records every transcript a scan opens (an open is a header and tail read).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    io.opened.push(String(args[0]));
    return actual.open(...args);
  }) as typeof actual.open;
  const mocked = { ...actual, open };
  return { ...mocked, default: mocked };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
});

const rollout = (id: string, cwd: string) =>
  `${JSON.stringify({ timestamp: "2026-09-20T10:00:00.000Z", type: "session_meta", payload: { id, cwd } })}\n`;

// The daemon rescans every 10 s; settled rollouts must not be re-read on every scan.
describe("Codex discovery inspection cache", () => {
  it("re-reads only changed or recently active rollouts, with unchanged results", async () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "codex-inspection-cache-"));
    dirs.push(root);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const settled: string[] = [];
    for (let i = 0; i < 20; i++) {
      const filePath = path.join(root, `settled-${i}.jsonl`);
      nodeFs.writeFileSync(filePath, rollout(`settled-${i}`, "/work/a"));
      nodeFs.utimesSync(filePath, dayAgo, dayAgo);
      settled.push(filePath);
    }
    const recent = path.join(root, "recent.jsonl");
    nodeFs.writeFileSync(recent, rollout("recent", "/work/b"));

    const cache: CodexInspectionCache = new Map();
    const scan = async () => {
      io.opened.length = 0;
      return discoverCodexTranscripts(root, { cache });
    };

    const first = await scan();
    expect(io.opened).toHaveLength(21);

    const second = await scan();
    expect(io.opened).toEqual([recent]);
    expect(second).toEqual(first);

    nodeFs.appendFileSync(settled[3], rollout("settled-3", "/work/a"));
    nodeFs.utimesSync(settled[3], dayAgo, new Date(dayAgo.getTime() + 1000));
    await scan();
    expect(io.opened.sort()).toEqual([recent, settled[3]].sort());
  });
});
