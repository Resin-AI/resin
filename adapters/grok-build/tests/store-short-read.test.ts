import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isGrokTurnOpen } from "../src/store.js";

// The log shrinks between stat and read: the handle still reports 16 more bytes than exist.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
      const result = await stat(...statArgs);
      return Object.assign(result, { size: Number(result.size) + 16 });
    }) as typeof handle.stat;
    return handle;
  }) as typeof actual.open;
  const mocked = { ...actual, open };
  return { ...mocked, default: mocked };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
});

const update = (sessionUpdate: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: sessionUpdate } });

describe("isGrokTurnOpen short reads", () => {
  it("decides from the real last line, not bytes past the end of the file", async () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "grok-short-read-"));
    dirs.push(dir);
    const updatesPath = path.join(dir, "updates.jsonl");
    nodeFs.writeFileSync(
      updatesPath,
      `${update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "run it" },
        _meta: { promptIndex: 0 },
      })}\n${update({ sessionUpdate: "turn_completed", prompt_id: "p0" })}`,
    );
    expect(await isGrokTurnOpen(updatesPath)).toBe(false);
  });
});
