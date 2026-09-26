import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type HarnessSession, UNKNOWN_HARNESS_VERSION } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCopilotWorkspaceYaml, probeCopilotInstallation } from "../src/discovery.js";
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
  it("resolves the version from the npm package owning the PATH executable, without running it", async () => {
    const pkgDir = path.join(dir, "lib", "node_modules", "@github", "copilot");
    const binDir = path.join(dir, "bin");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.mkdir(binDir);
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@github/copilot", version: "1.0.88" }),
    );
    // Running this loader would fail the probe; only its location is read.
    await fs.writeFile(path.join(pkgDir, "npm-loader.js"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await fs.symlink(path.join(pkgDir, "npm-loader.js"), path.join(binDir, "copilot"));
    const home = path.join(dir, "home");

    const installation = await probeCopilotInstallation({ home, env: { PATH: binDir } });
    expect(installation).toMatchObject({
      version: "1.0.88",
      executablePath: path.join(binDir, "copilot"),
      status: "ready",
    });
    expect(await fs.stat(home).catch(() => null)).toBeNull();

    await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "other" }));
    expect(await probeCopilotInstallation({ home, env: { PATH: binDir } })).toMatchObject({
      version: UNKNOWN_HARNESS_VERSION,
      status: "ready",
    });
    expect(await probeCopilotInstallation({ home, env: { PATH: "" } })).toBeNull();
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
