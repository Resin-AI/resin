import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatHarnessSessionsNotice,
  readHarnessSessionsStatus,
} from "../../src/commands/status.js";
import {
  type FindHarnessSessionsOptions,
  type ProcessTableEntry,
  classifyHarnessSession,
  findHarnessSessionsNeedingRestart,
  parsePsElapsedMs,
  parsePsProcessTable,
  readProcProcessTable,
} from "../../src/service/harness-sessions.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const HOUR_AGO = NOW - 3_600_000;
const RESIN_HOME = path.join(path.sep, "home", "dev", ".resin");
const RESIN_ENTRY = path.join(RESIN_HOME, "bin", "resin");

function proc(
  pid: number,
  ppid: number,
  args: string[],
  startedAtMs = HOUR_AGO,
): ProcessTableEntry {
  return { pid, ppid, args, startedAtMs };
}

function find(
  table: readonly ProcessTableEntry[],
  options: Partial<FindHarnessSessionsOptions> = {},
) {
  return findHarnessSessionsNeedingRestart(table, {
    harnesses: ["omp", "claude-code", "codex-cli", "pi"],
    gatewayVersions: new Map(),
    activeVersion: null,
    resinHome: RESIN_HOME,
    nowMs: NOW,
    ...options,
  });
}

describe("harness session classification", () => {
  it("recognizes session processes by program or install path", () => {
    expect(classifyHarnessSession(["omp", "--extension", "/x/status.ts"])).toBe("omp");
    expect(classifyHarnessSession(["/usr/local/bin/claude"])).toBe("claude-code");
    expect(
      classifyHarnessSession([
        "/usr/bin/node",
        "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        "--resume",
      ]),
    ).toBe("claude-code");
    expect(classifyHarnessSession(["C:\\Tools\\codex.exe"])).toBe("codex-cli");
  });

  it("does not count workers, MCP server modes, version probes or Resin itself", () => {
    expect(classifyHarnessSession(["/home/dev/.local/bin/omp", "__omp_worker_daemon_broker"])).toBe(
      null,
    );
    expect(classifyHarnessSession(["omp", "__omp_worker_text_predict"])).toBe(null);
    expect(classifyHarnessSession(["claude", "mcp", "serve"])).toBe(null);
    expect(classifyHarnessSession(["codex", "--version"])).toBe(null);
    expect(classifyHarnessSession(["node", RESIN_ENTRY, "mcp"])).toBe(null);
    expect(classifyHarnessSession(["python3", "/home/dev/.omp/agent/mcp-servers/x.py"])).toBe(null);
  });
});

describe("findHarnessSessionsNeedingRestart", () => {
  it("reports an OMP session without a Resin gateway and skips its workers", () => {
    const table = [
      proc(100, 1, ["omp", "--extension", "/x/status.ts"]),
      proc(101, 100, ["python3", "/home/dev/.omp/agent/mcp-servers/inactive.py", "figbridge"]),
      proc(102, 100, ["/home/dev/.local/bin/omp", "__omp_worker_daemon_broker"]),
      proc(103, 102, ["/home/dev/.local/bin/omp", "__omp_worker_text_predict"]),
      // A worker whose session is gone is not a session either.
      proc(104, 1, ["/home/dev/.local/bin/omp", "__omp_worker_js_eval_process"]),
      proc(200, 1, ["omp", "--extension", "/x/status.ts"]),
      proc(201, 200, ["node", RESIN_ENTRY, "mcp"]),
    ];

    expect(find(table)).toEqual([{ harnessId: "omp", pid: 100, reason: "missing", version: null }]);
  });

  it("folds a launcher shim's native child into one session and finds the gateway below it", () => {
    const table = [
      proc(300, 1, ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"]),
      proc(301, 300, ["/usr/lib/node_modules/@openai/codex/vendor/x86_64/codex/codex"]),
      proc(302, 301, ["/bin/sh", "-c", `${RESIN_ENTRY} mcp`]),
      proc(303, 302, [RESIN_ENTRY, "mcp"]),
    ];

    expect(find(table)).toEqual([]);
  });

  it("treats a session started from another session's shell as its own session", () => {
    const table = [
      proc(400, 1, ["omp"]),
      proc(401, 400, ["node", RESIN_ENTRY, "mcp"]),
      proc(402, 400, ["/bin/bash", "-c", "omp -p hello"]),
      proc(403, 402, ["omp", "-p", "hello"]),
    ];

    expect(find(table)).toEqual([{ harnessId: "omp", pid: 403, reason: "missing", version: null }]);
  });

  it("reports sessions whose gateway runs an older Resin", () => {
    const table = [
      proc(500, 1, ["claude"]),
      proc(501, 500, ["node", RESIN_ENTRY, "mcp"]),
      proc(510, 1, ["claude"]),
      proc(511, 510, ["node", RESIN_ENTRY, "mcp"]),
      proc(520, 1, ["claude"]),
      proc(521, 520, ["node", RESIN_ENTRY, "mcp"]),
      // A gateway from a source checkout is not judged against the install.
      proc(530, 1, ["claude"]),
      proc(531, 530, ["node", "/src/resin/apps/cli/bin/resin.mjs", "mcp"]),
    ];

    expect(
      find(table, {
        activeVersion: "v1.2.0",
        gatewayVersions: new Map([
          [501, "1.2.0"],
          [511, "1.1.9"],
        ]),
      }),
    ).toEqual([
      { harnessId: "claude-code", pid: 510, reason: "outdated", version: "1.1.9" },
      // Unregistered gateways from this Resin home predate the registry.
      { harnessId: "claude-code", pid: 520, reason: "outdated", version: null },
    ]);
  });

  it("does not ask to restart a session whose gateway runs under an MCP supervisor", () => {
    const table = [
      // Supervised: the supervisor (701) never registers a version; its child gateway (702) is
      // still on the old release while the supervisor switches it.
      proc(700, 1, ["claude"]),
      proc(701, 700, ["node", RESIN_ENTRY, "mcp"]),
      proc(702, 701, ["node", path.join(RESIN_HOME, "versions", "v1.1.9", "bin", "resin"), "mcp"]),
      // Started before the supervisor shipped: an in-process gateway on the old release.
      proc(710, 1, ["claude"]),
      proc(711, 710, ["node", RESIN_ENTRY, "mcp"]),
    ];

    expect(
      find(table, {
        activeVersion: "1.2.0",
        gatewayVersions: new Map([
          [702, "1.1.9"],
          [711, "1.1.9"],
        ]),
        switchableGatewayPids: new Set([701, 702]),
      }),
    ).toEqual([{ harnessId: "claude-code", pid: 710, reason: "outdated", version: "1.1.9" }]);
  });

  it("skips sessions still starting and harnesses Resin is not registered with", () => {
    const table = [
      proc(600, 1, ["omp"], NOW - 5_000),
      proc(610, 1, ["opencode"]),
      proc(620, 1, ["pi"]),
    ];

    expect(find(table)).toEqual([{ harnessId: "pi", pid: 620, reason: "missing", version: null }]);
    expect(find(table, { harnesses: [] })).toEqual([]);
  });
});

describe("process table readers", () => {
  let procRoot: string;

  beforeEach(async () => {
    procRoot = await mkdtemp(path.join(os.tmpdir(), "resin-proc-"));
  });

  afterEach(async () => {
    await rm(procRoot, { recursive: true, force: true });
  });

  async function addProc(pid: number, ppid: number, args: string[], startTicks: number) {
    await mkdir(path.join(procRoot, String(pid)));
    await writeFile(path.join(procRoot, String(pid), "cmdline"), `${args.join("\0")}\0`);
    await writeFile(
      path.join(procRoot, String(pid), "stat"),
      `${pid} (${path.basename(args[0] ?? "")}) S ${ppid} ${pid} ${pid} 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 0 0`,
    );
  }

  it("reads pid, parent, arguments and start time from /proc", async () => {
    await writeFile(path.join(procRoot, "stat"), "cpu 1 2 3\nbtime 1790000000\n");
    await addProc(100, 1, ["omp", "--extension", "/x/a b.ts"], 12_345);
    await addProc(101, 100, ["node", RESIN_ENTRY, "mcp"], 12_400);
    await mkdir(path.join(procRoot, "self"));

    const table = await readProcProcessTable({ procRoot, uid: process.getuid?.() });

    expect(table).toEqual([
      { pid: 100, ppid: 1, args: ["omp", "--extension", "/x/a b.ts"], startedAtMs: 1790000123450 },
      { pid: 101, ppid: 100, args: ["node", RESIN_ENTRY, "mcp"], startedAtMs: 1790000124000 },
    ]);
  });

  it("returns null where /proc does not exist", async () => {
    expect(await readProcProcessTable({ procRoot: path.join(procRoot, "missing") })).toBe(null);
  });

  it("parses ps output for macOS, keeping only the current user's processes", () => {
    const output = [
      "  100     1   501       01:02:03 /opt/homebrew/bin/omp --resume",
      "  101   100   501          00:10 node /Users/dev/.resin/bin/resin mcp",
      "  102     1     0    2-00:00:00 /usr/sbin/syslogd",
      "",
    ].join("\n");

    expect(parsePsProcessTable(output, { uid: 501, nowMs: NOW })).toEqual([
      {
        pid: 100,
        ppid: 1,
        args: ["/opt/homebrew/bin/omp", "--resume"],
        startedAtMs: NOW - 3_723_000,
      },
      {
        pid: 101,
        ppid: 100,
        args: ["node", "/Users/dev/.resin/bin/resin", "mcp"],
        startedAtMs: NOW - 10_000,
      },
    ]);
    expect(parsePsElapsedMs("2-00:00:00")).toBe(172_800_000);
    expect(parsePsElapsedMs("garbage")).toBe(null);
  });
});

describe("status harness sessions", () => {
  it("names the sessions to restart per harness", async () => {
    const resinHome = await mkdtemp(path.join(os.tmpdir(), "resin-status-sessions-"));
    try {
      const status = await readHarnessSessionsStatus({
        resinHome,
        harnesses: ["omp"],
        nowMs: NOW,
        readProcessTable: async () => [
          proc(230229, 1, ["omp", "--extension", "/x/status.ts"]),
          proc(230476, 230229, ["/home/dev/.local/bin/omp", "__omp_worker_daemon_broker"]),
          proc(496326, 1, ["omp", "--resume", "/x/session.jsonl"]),
        ],
      });

      expect(status).toEqual({
        available: true,
        sessions: [
          { harnessId: "omp", name: "Oh My Pi", pid: 230229, reason: "missing", version: null },
          { harnessId: "omp", name: "Oh My Pi", pid: 496326, reason: "missing", version: null },
        ],
      });
      expect(formatHarnessSessionsNotice(status)).toBe(
        "2 Oh My Pi session(s) started without Resin (PIDs 230229, 496326); restart them to use Resin's tools.",
      );
    } finally {
      await rm(resinHome, { recursive: true, force: true });
    }
  });

  it("treats sessions with a live MCP supervisor as switchable", async () => {
    const resinHome = await mkdtemp(path.join(os.tmpdir(), "resin-status-supervised-"));
    try {
      await mkdir(path.join(resinHome, "versions", "v1.2.0"), { recursive: true });
      await symlink(path.join(resinHome, "versions", "v1.2.0"), path.join(resinHome, "current"));
      const entry = path.join(resinHome, "bin", "resin");
      await mkdir(path.join(resinHome, "run", "mcp-supervisors"), { recursive: true });
      await writeFile(
        path.join(resinHome, "run", "mcp-supervisors", "801.json"),
        JSON.stringify({
          schemaVersion: 1,
          pid: 801,
          protocol: 1,
          version: "1.1.9",
          activeVersion: "1.1.9",
          childPids: [802],
          startedAt: new Date(HOUR_AGO).toISOString(),
        }),
      );
      const status = await readHarnessSessionsStatus({
        resinHome,
        harnesses: ["omp"],
        nowMs: NOW,
        isAlive: () => true,
        procRoot: path.join(resinHome, "no-proc"),
        readProcessTable: async () => [
          proc(800, 1, ["omp"]),
          proc(801, 800, ["node", entry, "mcp"]),
          proc(802, 801, ["node", entry, "mcp"]),
          proc(810, 1, ["omp"]),
          proc(811, 810, ["node", entry, "mcp"]),
        ],
      });

      expect(status.sessions).toEqual([
        { harnessId: "omp", name: "Oh My Pi", pid: 810, reason: "outdated", version: null },
      ]);
      expect(formatHarnessSessionsNotice(status)).toBe(
        "1 Oh My Pi session(s) run an older Resin that cannot switch releases by itself (unknown version; PID 810); restart them to load the current version.",
      );
    } finally {
      await rm(resinHome, { recursive: true, force: true });
    }
  });

  it("reports the check as unavailable where the platform has no process table reader", async () => {
    const status = await readHarnessSessionsStatus({
      resinHome: RESIN_HOME,
      harnesses: ["claude-code"],
      nowMs: NOW,
      readProcessTable: async () => null,
    });

    expect(status).toEqual({ available: false, sessions: [] });
    expect(formatHarnessSessionsNotice(status)).toBe(null);
  });

  it("formats older-Resin sessions with their versions", () => {
    expect(
      formatHarnessSessionsNotice({
        available: true,
        sessions: [
          {
            harnessId: "claude-code",
            name: "Claude Code",
            pid: 7,
            reason: "outdated",
            version: "1.1.9",
          },
          {
            harnessId: "claude-code",
            name: "Claude Code",
            pid: 9,
            reason: "outdated",
            version: null,
          },
        ],
      }),
    ).toBe(
      "2 Claude Code session(s) run an older Resin that cannot switch releases by itself (unknown version, v1.1.9; PIDs 7, 9); restart them to load the current version.",
    );
  });
});
