import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UNKNOWN_HARNESS_VERSION } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiHarnessAdapter } from "../src/adapter.js";
import { piWorkspaceId, probePiInstallation } from "../src/discovery.js";
import { encodePiSessionDirName } from "../src/paths.js";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded", "0.87.1");
const PARENT = "2026-09-26T22-58-17-527Z_01a0dff0-d537-7747-bfb8-d1f92fceb35d.jsonl";
const FORK = "2026-09-26T22-58-42-251Z_01a0dff1-35cb-7747-bfb8-d1fe2df1bed3.jsonl";

let home: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-discovery-home-"));
  projectA = path.join(home, "work", "a");
  projectB = path.join(home, "work", "b");
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

/** Writes a recorded fixture with its scrubbed cwd and parent path rebound to this machine. */
async function placeFixture(
  fixture: string,
  dir: string,
  fileName: string,
  cwd: string,
  parentPath?: string,
) {
  let content = await fsp.readFile(path.join(RECORDED, fixture), "utf8");
  const [header, ...rest] = content.split("\n");
  const parsed = JSON.parse(header!);
  parsed.cwd = cwd;
  if (parentPath) parsed.parentSession = parentPath;
  content = [JSON.stringify(parsed), ...rest].join("\n");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await fsp.writeFile(file, content);
  return file;
}

describe("PiHarnessAdapter discovery", () => {
  it("binds sessions to workspaces by header cwd across every session directory Pi may use", async () => {
    const agentDir = path.join(home, ".pi", "agent");
    const envDir = path.join(home, "env-sessions");
    const settingsDir = path.join(home, "settings-sessions");
    const flagDir = path.join(home, "flag-sessions");
    await fsp.mkdir(agentDir, { recursive: true });
    await fsp.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: settingsDir }),
    );

    const parent = await placeFixture(
      "rpc-branch-model-bash-abort-compaction.jsonl",
      path.join(agentDir, "sessions", encodePiSessionDirName(projectA)),
      PARENT,
      projectA,
    );
    await placeFixture("rpc-fork.jsonl", envDir, FORK, projectA, parent);
    // A file under B's default directory whose header says A: the header wins.
    await placeFixture(
      "tools-mcp-bridge.jsonl",
      path.join(agentDir, "sessions", encodePiSessionDirName(projectB)),
      "2026-09-26T22-57-28-061Z_01a0dff0-13fc-73c0-aa87-6a0848e6c5df.jsonl",
      projectA,
    );
    await placeFixture(
      "rpc-tree-rewind.jsonl",
      settingsDir,
      "2026-09-26T23-07-33-000Z_01a0dff9-50d6-73f5-9239-3c1f948f9a0f.jsonl",
      projectB,
    );
    await placeFixture(
      "resin-gateway-bridge.jsonl",
      flagDir,
      "2026-09-26T22-59-28-000Z_gateway.jsonl",
      projectB,
    );
    await fsp.writeFile(path.join(envDir, "notes.jsonl"), '{"not":"a pi session"}\n');

    const adapter = new PiHarnessAdapter({
      home,
      env: { HOME: home, PI_CODING_AGENT_SESSION_DIR: envDir },
      extraSessionDirs: [flagDir],
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    });
    const workspaces = await adapter.listWorkspaces();
    expect(workspaces.map((workspace) => workspace.rootPath).sort()).toEqual([projectA, projectB]);

    const a = workspaces.find((workspace) => workspace.rootPath === projectA)!;
    const sessionsA = await adapter.listSessions(a);
    expect(sessionsA.map((session) => session.sessionId).sort()).toEqual([
      "01a0dff0-13fc-73c0-aa87-6a0848e6c5df",
      "01a0dff0-d537-7747-bfb8-d1f92fceb35d",
      "01a0dff1-35cb-7747-bfb8-d1fe2df1bed3",
    ]);
    const fork = sessionsA.find((session) => session.sessionId.startsWith("01a0dff1"))!;
    expect(fork.metadata).toMatchObject({
      parentSessionId: "01a0dff0-d537-7747-bfb8-d1f92fceb35d",
      parentSessionPath: parent,
      sessionFormatVersion: 3,
    });
    expect(sessionsA.every((session) => session.status === "idle")).toBe(true);

    const b = workspaces.find((workspace) => workspace.rootPath === projectB)!;
    expect((await adapter.listSessions(b)).map((session) => session.transcriptPath).sort()).toEqual(
      [
        path.join(flagDir, "2026-09-26T22-59-28-000Z_gateway.jsonl"),
        path.join(
          settingsDir,
          "2026-09-26T23-07-33-000Z_01a0dff9-50d6-73f5-9239-3c1f948f9a0f.jsonl",
        ),
      ],
    );
  });

  it("resolves a project sessionDir relative to the workspace root", async () => {
    await fsp.mkdir(path.join(projectA, ".pi"), { recursive: true });
    await fsp.writeFile(
      path.join(projectA, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: ".pi/sessions" }),
    );
    await placeFixture(
      "rpc-tree-rewind.jsonl",
      path.join(projectA, ".pi", "sessions"),
      "2026-09-26T23-07-33-000Z_01a0dff9-50d6-73f5-9239-3c1f948f9a0f.jsonl",
      projectA,
    );
    const adapter = new PiHarnessAdapter({ home, env: { HOME: home } });
    const sessions = await adapter.listSessions({
      workspaceId: piWorkspaceId(projectA),
      rootPath: projectA,
      name: "a",
      harnessId: "pi",
      configPath: "unused",
      metadata: {},
    });
    expect(sessions.map((session) => session.sessionId)).toEqual([
      "01a0dff9-50d6-73f5-9239-3c1f948f9a0f",
    ]);
  });

  it("reports a session written within the last minute as active", async () => {
    const dir = path.join(home, ".pi", "agent", "sessions", encodePiSessionDirName(projectA));
    const file = await placeFixture(
      "rpc-tree-rewind.jsonl",
      dir,
      "2026-09-26T23-07-33-000Z_x.jsonl",
      projectA,
    );
    const { mtimeMs } = await fsp.stat(file);
    const adapter = new PiHarnessAdapter({
      home,
      env: { HOME: home },
      now: () => mtimeMs + 30_000,
    });
    const [workspace] = await adapter.listWorkspaces();
    expect((await adapter.resolveActiveSession(workspace!))?.transcriptPath).toBe(file);
  });
});

describe("pi installation probe", () => {
  // POSIX npm links the bin to its package with a file symlink (needs privilege on Windows).
  it.skipIf(process.platform === "win32")(
    "reads the version from the npm package owning the executable without running it",
    async () => {
      const pkgDir = path.join(
        home,
        "prefix",
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      const bin = path.join(home, "prefix", "bin");
      await fsp.mkdir(path.join(pkgDir, "dist", "bundle"), { recursive: true });
      await fsp.mkdir(bin, { recursive: true });
      await fsp.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }),
      );
      // A CLI that fails if executed proves the probe read the package metadata instead.
      const cli = path.join(pkgDir, "dist", "bundle", "cli.js");
      await fsp.writeFile(cli, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      await fsp.symlink(cli, path.join(bin, "pi"));
      const probe = () =>
        probePiInstallation({ env: { PATH: bin }, configPath: "/c", homePath: "/h" });
      expect(await probe()).toMatchObject({
        version: "0.87.1",
        executablePath: path.join(bin, "pi"),
        status: "ready",
      });

      await fsp.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "other" }));
      expect(await probe()).toMatchObject({ version: UNKNOWN_HARNESS_VERSION, status: "unknown" });
    },
  );

  it("reads the version beside a Windows npm shim in the global prefix", async () => {
    const prefix = path.join(home, "npm");
    const pkgDir = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
    await fsp.mkdir(pkgDir, { recursive: true });
    await fsp.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }),
    );
    await fsp.writeFile(path.join(prefix, "pi.cmd"), "@exit /b 1\r\n");
    await fsp.writeFile(path.join(prefix, "pi"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(
      await probePiInstallation({ env: { PATH: prefix }, configPath: "/c", homePath: "/h" }),
    ).toMatchObject({
      version: "0.87.1",
      executablePath: path.join(prefix, "pi"),
      status: "ready",
    });
  });
});
