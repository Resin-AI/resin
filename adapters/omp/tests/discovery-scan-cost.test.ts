import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmpHarnessAdapter } from "../src/adapter.js";

const io = vi.hoisted(() => ({ touched: [] as Array<{ op: string; path: string }> }));

// Records every path the discovery scan stats, resolves, or opens.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const track =
    <A extends unknown[], R>(op: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      io.touched.push({ op, path: String(args[0]) });
      return fn(...args);
    };
  const mocked = {
    ...actual,
    stat: track("stat", actual.stat),
    realpath: track("realpath", actual.realpath),
    open: track("open", actual.open),
  };
  return { ...mocked, default: mocked };
});

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-scan-cost-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The daemon rescans every 10 s with activeOnly: false; a long-lived OMP home holds tens of
// thousands of finished transcripts. Most scans must not touch them at all, yet new sessions must
// be found on the next scan and resumed ones within the re-check window.
describe("OMP discovery scan cost", () => {
  it("leaves settled transcripts alone between re-checks while finding new and resumed sessions", async () => {
    const ompHome = path.join(tmpDir, ".omp");
    const wsPath = path.join(tmpDir, "app");
    fs.mkdirSync(wsPath, { recursive: true });
    const sessionsDir = path.join(ompHome, "agent", "sessions", "-app");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const dayAgo = new Date(Date.now() - 86_400_000);
    const header = (id: string, at: Date) =>
      `${JSON.stringify({ type: "session", version: 3, id, cwd: wsPath, timestamp: at.toISOString() })}\n`;
    const exit = (at: Date) =>
      `${JSON.stringify({ type: "custom", customType: "session_exit", id: "exit", timestamp: at.toISOString(), data: { reason: "dispose", kind: "normal", recordedAt: at.toISOString() } })}\n`;

    const settledPaths: string[] = [];
    for (let i = 0; i < 40; i++) {
      const filePath = path.join(sessionsDir, `settled-${i}.jsonl`);
      fs.writeFileSync(filePath, header(`settled-${i}`, dayAgo) + exit(dayAgo));
      fs.utimesSync(filePath, dayAgo, dayAgo);
      settledPaths.push(filePath);
    }
    fs.utimesSync(sessionsDir, dayAgo, dayAgo);

    const adapter = new OmpHarnessAdapter({ ompHome, cwd: tmpDir, activeOnly: false });
    const scan = async () => {
      io.touched.length = 0;
      await adapter.listWorkspaces();
      return new Map(adapter.catalog?.getAllSessions().map((s) => [s.sessionId, s]));
    };
    const settledTouches = (op: string) =>
      io.touched.filter((t) => t.op === op && settledPaths.includes(t.path)).length;

    // The first scan is a full sweep: every transcript is opened and resolved.
    expect((await scan()).size).toBe(40);
    expect(settledTouches("open")).toBeGreaterThanOrEqual(40);
    expect(settledTouches("realpath")).toBeGreaterThanOrEqual(40);

    // The next scan does not touch settled transcripts, yet a new session file is found at once.
    fs.writeFileSync(path.join(sessionsDir, "fresh.jsonl"), header("fresh", new Date()));
    const second = await scan();
    expect(second.has("fresh")).toBe(true);
    expect(second.size).toBe(41);
    expect(settledTouches("open") + settledTouches("realpath") + settledTouches("stat")).toBe(0);

    // A resumed settled session is re-inspected within the slow cadence (six scans).
    const sizeBefore = Number(second.get("settled-7")?.metadata?.fileSize);
    fs.appendFileSync(settledPaths[7], header("settled-7", new Date()));
    for (let i = 0; i < 4; i++) await scan();
    expect(Number((await scan()).get("settled-7")?.metadata?.fileSize)).toBeGreaterThan(sizeBefore);
  });
});
