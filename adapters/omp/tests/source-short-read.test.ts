import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessSession } from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpSessionEventSource } from "../src/source.js";

// The transcript shrinks between stat and read: stat still reports 64 more bytes than exist.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    const result = await actual.stat(...args);
    if (String(args[0]).endsWith("shrinking.jsonl"))
      Object.assign(result, { size: result.size + 64 });
    return result;
  }) as typeof actual.stat;
  const mocked = { ...actual, stat };
  return { ...mocked, default: mocked };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
});

describe("OmpSessionEventSource short reads", () => {
  it("stops at an incomplete last line when the file ends before its stat size", async () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "omp-short-read-"));
    dirs.push(dir);
    const transcriptPath = path.join(dir, "shrinking.jsonl");
    const complete = JSON.stringify({ type: "message", role: "user", content: "done" });
    nodeFs.writeFileSync(transcriptPath, `${complete}\n{"type":"message","role":"assi`);
    const session: HarnessSession = {
      sessionId: "session-short-read",
      workspaceId: "ws-1",
      harnessId: "omp",
      transcriptPath,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const source = new OmpSessionEventSource(session);
    const first = await source.readNext(10);
    expect(first.map((r) => r.rawPayload)).toEqual([complete]);
    expect(await source.readNext(10)).toEqual([]);
    await source.close();
  }, 5_000);
});
