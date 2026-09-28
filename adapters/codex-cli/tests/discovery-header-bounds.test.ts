import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverCodexTranscripts } from "../src/discovery.js";

// A header buffer holds whatever memory it was allocated over until the file fills it. This
// handle leaves a stale, well-formed session_meta line just past each read, as reused memory can.
const STALE = Buffer.from(
  `\n${JSON.stringify({ type: "session_meta", payload: { id: "stale", cwd: "/stale/workspace" } })}\n`,
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      const end = offset + result.bytesRead;
      if (Buffer.isBuffer(buffer) && end + STALE.length <= buffer.length) STALE.copy(buffer, end);
      return result;
    }) as typeof handle.read;
    return handle;
  }) as typeof actual.open;
  const mocked = { ...actual, open };
  return { ...mocked, default: mocked };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
});

describe("Codex header inspection", () => {
  it("binds a transcript only from bytes the file supplied", async () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "codex-header-bounds-"));
    dirs.push(root);
    // A first line longer than one read chunk keeps the header scan reading into its buffer.
    const record = {
      timestamp: "2026-09-23T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "real", base_instructions: "x".repeat(200 * 1024) },
    };
    nodeFs.writeFileSync(path.join(root, "long-header.jsonl"), `${JSON.stringify(record)}`);

    const [inspection] = await discoverCodexTranscripts(root);
    expect(inspection?.cwd).toBeNull();
    expect(inspection?.canonicalCwd).toBeNull();
    expect(inspection?.threadId).toBeUndefined();
  });
});
