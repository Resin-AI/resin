import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessSession } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCopilotVersion, parseCopilotWorkspaceYaml } from "../src/discovery.js";
import { CopilotSessionEventSource } from "../src/source.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-source-"));
  file = path.join(dir, "events.jsonl");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const session = (): HarnessSession => ({
  sessionId: "s1",
  workspaceId: "ws",
  harnessId: "copilot-cli",
  transcriptPath: file,
  status: "active",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
  metadata: {},
});

const line = (id: string, type: string) =>
  `${JSON.stringify({ type, id, timestamp: "2026-09-26T00:00:00.000Z", data: { text: "é" } })}\n`;

describe("CopilotSessionEventSource", () => {
  it("tails appended events, holding back a partial last line", async () => {
    await fs.writeFile(file, line("a", "session.start") + line("b", "user.message").slice(0, 20));
    const source = new CopilotSessionEventSource(session());
    expect((await source.readNext()).map((r) => r.recordId)).toEqual(["a"]);
    expect(await source.readNext()).toEqual([]);

    await fs.writeFile(file, line("a", "session.start") + line("b", "user.message"));
    const next = await source.readNext();
    expect(next.map((r) => [r.recordId, r.sequenceNumber])).toEqual([["b", 2]]);
    expect(next[0]!.cursor.offset).toBe(Buffer.byteLength(await fs.readFile(file, "utf8")));
  });

  it("resumes from a checkpointed cursor without replaying records", async () => {
    await fs.writeFile(file, line("a", "session.start") + line("b", "user.message"));
    const first = new CopilotSessionEventSource(session());
    const [a] = await first.readNext(1);
    await fs.appendFile(file, line("c", "session.shutdown"));

    const resumed = new CopilotSessionEventSource(session(), a!.cursor);
    expect((await resumed.readNext()).map((r) => [r.recordId, r.sequenceNumber])).toEqual([
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("detects truncation and restarts from the new file", async () => {
    await fs.writeFile(file, line("a", "session.start") + line("b", "user.message"));
    const source = new CopilotSessionEventSource(session());
    await source.readNext();
    await fs.writeFile(file, line("z", "session.start"));
    expect(await source.detectRotation()).toBe(true);
    expect((await source.readNext()).map((r) => r.recordId)).toEqual(["z"]);
  });
});

describe("Copilot discovery parsing", () => {
  it("reads the version printed by `copilot --version`", () => {
    expect(parseCopilotVersion("GitHub Copilot CLI 1.0.88.\nRun 'copilot update'")).toBe("1.0.88");
    expect(parseCopilotVersion("something else")).toBeNull();
  });

  it("reads single-quoted workspace.yaml scalars", () => {
    expect(
      parseCopilotWorkspaceYaml(
        "id: x\ncwd: /w/p\nname: 'it''s: done'\ncreated_at: 2026-09-26T00:00:00Z\n",
      ),
    ).toMatchObject({
      id: "x",
      cwd: "/w/p",
      name: "it's: done",
      createdAt: "2026-09-26T00:00:00Z",
    });
  });
});
