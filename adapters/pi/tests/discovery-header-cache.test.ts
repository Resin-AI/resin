import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PiHeaderCache, scanPiTranscripts } from "../src/discovery.js";

const io = vi.hoisted(() => ({ opens: 0 }));

// Counts transcript opens: each is a header read the scan could not answer from its cache.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    io.opens += 1;
    return actual.open(...args);
  }) as typeof actual.open;
  const mocked = { ...actual, open };
  return { ...mocked, default: mocked };
});

let dir: string;

const header = (id: string, cwd: string) =>
  `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-09-01T00:00:00Z" })}\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-pi-header-cache-"));
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(dir, `t${i}.jsonl`), header(`s${i}`, "/work/a"));
  }
  io.opens = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Pi transcript scan header cache", () => {
  it("reads each header once, and again only when the path names a new file", async () => {
    const roots = [{ dir, source: "extra" as const }];
    const cache: PiHeaderCache = new Map();

    const first = await scanPiTranscripts(roots, cache);
    expect(first).toHaveLength(30);
    expect(io.opens).toBe(30);

    io.opens = 0;
    const second = await scanPiTranscripts(roots, cache);
    expect(second.map((t) => t.header)).toEqual(first.map((t) => t.header));
    expect(io.opens).toBe(0);

    // Replacing the file (new inode) is a different transcript: its header is read again.
    const replaced = path.join(dir, "t3.jsonl");
    fs.writeFileSync(`${replaced}.tmp`, header("s3-new", "/work/b"));
    fs.renameSync(`${replaced}.tmp`, replaced);
    io.opens = 0;
    const third = await scanPiTranscripts(roots, cache);
    expect(io.opens).toBe(1);
    expect(third.find((t) => t.transcriptPath === replaced)?.header).toMatchObject({
      id: "s3-new",
      cwd: "/work/b",
    });
  });
});
