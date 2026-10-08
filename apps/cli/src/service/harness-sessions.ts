import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { HarnessId } from "@resin/contracts";

/**
 * Finds running harness sessions that cannot reach Resin: sessions whose process tree holds no
 * `resin mcp` gateway (started before Resin was registered, or while another installer had
 * dropped the registration), and sessions whose gateway runs an older Resin. Harnesses read
 * their MCP configuration once at session start, so the remedy for both is restarting the
 * session. Detection reads the local process table only; nothing leaves the machine.
 */

/** One process from the local process table. */
export interface ProcessTableEntry {
  readonly pid: number;
  readonly ppid: number;
  /** Command line; on macOS split on whitespace, so paths with spaces break apart. */
  readonly args: readonly string[];
  /** Start time in epoch ms; null where it cannot be read. */
  readonly startedAtMs: number | null;
}

/** Resolves the current user's processes, or null where this platform has no reader. */
export type ProcessTableReader = () => Promise<readonly ProcessTableEntry[] | null>;

export type HarnessSessionRestartReason = "missing" | "outdated";

export interface HarnessSessionNeedingRestart {
  readonly harnessId: HarnessId;
  readonly pid: number;
  /** `missing`: no Resin gateway in the session; `outdated`: its gateway runs an older Resin. */
  readonly reason: HarnessSessionRestartReason;
  /** The outdated gateway's version; null when missing or when the gateway never registered. */
  readonly version: string | null;
}

interface HarnessSessionMatcher {
  readonly harnessId: HarnessId;
  /** Executable or script basenames, without extension. */
  readonly programs: readonly string[];
  /** Install-path fragments of a script run by a JavaScript runtime. */
  readonly scriptPaths: readonly RegExp[];
  /** Processes of the harness that are not interactive sessions (workers, MCP server modes). */
  readonly auxiliary?: (args: readonly string[]) => boolean;
}

/**
 * How each harness's session process looks in the process table. Wrapper launchers (an npm
 * shim running the native binary) produce a parent and a child that both match; the child is
 * folded into the parent session.
 */
const HARNESS_SESSION_MATCHERS: readonly HarnessSessionMatcher[] = [
  {
    harnessId: "claude-code",
    programs: ["claude"],
    scriptPaths: [/[\\/]@anthropic-ai[\\/]claude-code[\\/]/u],
    auxiliary: (args) => args[1] === "mcp",
  },
  {
    harnessId: "codex-cli",
    programs: ["codex"],
    scriptPaths: [/[\\/]@openai[\\/]codex[\\/]/u],
    auxiliary: (args) => args[1] === "mcp" || args[1] === "mcp-server",
  },
  {
    harnessId: "omp",
    programs: ["omp"],
    scriptPaths: [/[\\/]@oh-my-pi[\\/]/u],
    // `omp __omp_worker_*` processes are workers of a session (brokers, evaluators, predictors).
    auxiliary: (args) => args.some((arg) => arg.startsWith("__omp_worker")),
  },
  { harnessId: "pi", programs: ["pi"], scriptPaths: [/[\\/]pi-coding-agent[\\/]/u] },
  {
    harnessId: "cursor-cli",
    programs: ["cursor-agent"],
    scriptPaths: [/[\\/]cursor-agent[\\/]versions[\\/]/u],
  },
  { harnessId: "grok-build", programs: ["grok"], scriptPaths: [] },
  { harnessId: "muse-code", programs: ["muse"], scriptPaths: [] },
  { harnessId: "opencode", programs: ["opencode"], scriptPaths: [/[\\/]opencode-ai[\\/]/u] },
  {
    harnessId: "copilot-cli",
    programs: ["copilot"],
    scriptPaths: [/[\\/]@github[\\/]copilot[\\/]/u],
  },
];

const SCRIPT_RUNTIMES = new Set(["node", "nodejs", "bun", "deno", "tsx"]);
const EXECUTABLE_EXTENSION = /\.(?:exe|cmd|bat|ps1|js|mjs|cjs|ts)$/iu;
const VERSION_OR_HELP_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h", "version"]);

/**
 * A session younger than this may not have started its MCP servers yet; it is not reported.
 */
export const HARNESS_SESSION_STARTUP_GRACE_MS = 30_000;

/** How deep below a session its `resin mcp` gateway may sit (shell and npm shims between). */
const MAX_GATEWAY_DEPTH = 4;

function programName(arg: string | undefined): string {
  if (arg === undefined) return "";
  return path.basename(arg.replaceAll("\\", "/")).replace(EXECUTABLE_EXTENSION, "").toLowerCase();
}

/** The script a JavaScript runtime runs (first non-flag argument), or undefined. */
function runtimeScript(args: readonly string[]): string | undefined {
  const runtime = programName(args[0]);
  if (!SCRIPT_RUNTIMES.has(runtime) && !/^node\d+$/u.test(runtime)) return undefined;
  return args.slice(1).find((arg) => !arg.startsWith("-"));
}

/** The harness whose interactive session `entry` is, or null. */
export function classifyHarnessSession(args: readonly string[]): HarnessId | null {
  if (args.length === 0) return null;
  const script = runtimeScript(args);
  // Arguments as the harness sees them: a runtime-launched script becomes argv[0].
  const harnessArgs = script === undefined ? args : args.slice(args.indexOf(script));
  if (harnessArgs.slice(1).some((arg) => VERSION_OR_HELP_FLAGS.has(arg))) return null;
  const program = programName(harnessArgs[0]);
  for (const matcher of HARNESS_SESSION_MATCHERS) {
    const byName = matcher.programs.includes(program);
    const byPath =
      script !== undefined && matcher.scriptPaths.some((pattern) => pattern.test(script));
    if (!byName && !byPath) continue;
    return matcher.auxiliary?.(harnessArgs) === true ? null : matcher.harnessId;
  }
  return null;
}

/** Whether `args` run a Resin MCP gateway: a `resin` entry point followed by `mcp`, or `resin-mcp`. */
export function isResinGatewayCommand(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    const name = programName(arg);
    return name === "resin-mcp" || (name === "resin" && args[index + 1] === "mcp");
  });
}

/** The gateway's Resin entry point (first `resin` argument), for home attribution. */
function gatewayEntryPoint(args: readonly string[]): string | undefined {
  return args.find((arg, index) => programName(arg) === "resin" && args[index + 1] === "mcp");
}

export interface FindHarnessSessionsOptions {
  /** Harnesses whose configuration currently registers Resin; other harnesses are ignored. */
  readonly harnesses: readonly HarnessId[];
  /** Live registered gateway versions by PID (see `listRunningGateways`). */
  readonly gatewayVersions: ReadonlyMap<number, string>;
  /** The active install's version; null for source builds, which skips the version check. */
  readonly activeVersion: string | null;
  /**
   * The Resin home gateways of this install run from. An unregistered gateway started from it
   * predates the gateway registry, so it is older; one from elsewhere (another Resin home or a
   * source checkout) is not judged.
   */
  readonly resinHome: string;
  readonly nowMs: number;
  readonly startupGraceMs?: number;
}

/**
 * Pure classification over a process table. A session is a process matching a harness that is
 * not itself a direct child of a session of the same harness (launcher shims, workers). Its
 * gateway is a `resin mcp` process up to {@link MAX_GATEWAY_DEPTH} levels below it, not inside
 * another session.
 */
export function findHarnessSessionsNeedingRestart(
  table: readonly ProcessTableEntry[],
  options: FindHarnessSessionsOptions,
): HarnessSessionNeedingRestart[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const harnessOf = new Map<number, HarnessId>();
  for (const entry of table) {
    const harnessId = classifyHarnessSession(entry.args);
    if (harnessId !== null) harnessOf.set(entry.pid, harnessId);
  }
  const isSessionRoot = (entry: ProcessTableEntry): boolean => {
    const harnessId = harnessOf.get(entry.pid);
    if (harnessId === undefined) return false;
    const parent = byPid.get(entry.ppid);
    return parent === undefined || harnessOf.get(parent.pid) !== harnessId;
  };

  const resinHome = path.resolve(options.resinHome);
  const homePrefixes = [resinHome, realpathOrSelf(resinHome)].map((home) => `${home}${path.sep}`);
  const gatewayVersion = (gateway: ProcessTableEntry): string | null | "unjudged" => {
    const registered = options.gatewayVersions.get(gateway.pid);
    if (registered !== undefined) return registered.replace(/^v/u, "");
    const entryPoint = gatewayEntryPoint(gateway.args);
    const inHome =
      entryPoint !== undefined &&
      path.isAbsolute(entryPoint) &&
      [path.resolve(entryPoint), realpathOrSelf(entryPoint)].some((candidate) =>
        homePrefixes.some((prefix) => candidate.startsWith(prefix)),
      );
    return inHome ? null : "unjudged";
  };

  const findGateways = (session: ProcessTableEntry): ProcessTableEntry[] => {
    const found: ProcessTableEntry[] = [];
    let frontier = children.get(session.pid) ?? [];
    for (let depth = 1; depth <= MAX_GATEWAY_DEPTH && frontier.length > 0; depth += 1) {
      const next: ProcessTableEntry[] = [];
      for (const entry of frontier) {
        if (isSessionRoot(entry)) continue;
        if (isResinGatewayCommand(entry.args)) {
          found.push(entry);
          continue;
        }
        next.push(...(children.get(entry.pid) ?? []));
      }
      frontier = next;
    }
    return found;
  };

  const graceMs = options.startupGraceMs ?? HARNESS_SESSION_STARTUP_GRACE_MS;
  const active = options.activeVersion?.replace(/^v/u, "") ?? null;
  const results: HarnessSessionNeedingRestart[] = [];
  for (const entry of table) {
    const harnessId = harnessOf.get(entry.pid);
    if (harnessId === undefined || !options.harnesses.includes(harnessId)) continue;
    if (!isSessionRoot(entry)) continue;
    if (entry.startedAtMs !== null && options.nowMs - entry.startedAtMs < graceMs) continue;
    const gateways = findGateways(entry);
    if (gateways.length === 0) {
      results.push({ harnessId, pid: entry.pid, reason: "missing", version: null });
      continue;
    }
    if (active === null) continue;
    const versions = gateways.map(gatewayVersion).filter((version) => version !== "unjudged");
    // A session is current when any of its gateways runs the active version.
    if (versions.length === 0 || versions.includes(active)) continue;
    const known = versions.find((version): version is string => version !== null);
    results.push({ harnessId, pid: entry.pid, reason: "outdated", version: known ?? null });
  }
  return results.sort((left, right) => left.pid - right.pid);
}

function realpathOrSelf(filePath: string): string {
  try {
    return fsSync.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/** Linux exposes process start times in USER_HZ ticks, fixed at 100 for the userspace ABI. */
const PROC_CLOCK_TICKS_PER_SECOND = 100;
const MAX_PROCESSES = 8_192;
const PS_TIMEOUT_MS = 2_000;

/**
 * Reads the current user's processes from `/proc` (Linux, WSL). Entries that vanish or cannot
 * be read mid-scan are skipped.
 */
export async function readProcProcessTable(
  options: { readonly procRoot?: string; readonly uid?: number } = {},
): Promise<ProcessTableEntry[] | null> {
  const procRoot = options.procRoot ?? "/proc";
  let names: string[];
  try {
    names = (await fs.readdir(procRoot)).filter((name) => /^\d+$/u.test(name));
  } catch {
    return null;
  }
  let bootTimeSeconds: number | null = null;
  try {
    const bootLine = (await fs.readFile(path.join(procRoot, "stat"), "utf8"))
      .split("\n")
      .find((line) => line.startsWith("btime "));
    const parsed = Number(bootLine?.slice("btime ".length).trim());
    bootTimeSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    bootTimeSeconds = null;
  }
  const uid = options.uid ?? process.getuid?.();
  const entries: ProcessTableEntry[] = [];
  for (const name of names.slice(0, MAX_PROCESSES)) {
    const directory = path.join(procRoot, name);
    try {
      if (uid !== undefined && (await fs.stat(directory)).uid !== uid) continue;
      const args = (await fs.readFile(path.join(directory, "cmdline"), "utf8"))
        .split("\0")
        .filter((arg, index, all) => !(arg === "" && index === all.length - 1));
      if (args.length === 0) continue;
      const stat = await fs.readFile(path.join(directory, "stat"), "utf8");
      // Fields after the parenthesized command name start at field 3 (state); ppid is field 4
      // and starttime field 22.
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
      const ppid = Number(fields[1]);
      const startTicks = Number(fields[19]);
      if (!Number.isSafeInteger(ppid)) continue;
      entries.push({
        pid: Number(name),
        ppid,
        args,
        startedAtMs:
          bootTimeSeconds !== null && Number.isFinite(startTicks)
            ? bootTimeSeconds * 1000 + (startTicks * 1000) / PROC_CLOCK_TICKS_PER_SECOND
            : null,
      });
    } catch {
      // The process exited mid-scan or is not readable.
    }
  }
  return entries;
}

/** Parses `ps` elapsed time `[[dd-]hh:]mm:ss` into milliseconds, or null. */
export function parsePsElapsedMs(value: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
    1000
  );
}

/**
 * Parses `ps -axww -o pid=,ppid=,uid=,etime=,command=` output (macOS, BSD). The command line is
 * split on whitespace: `ps` does not preserve argument boundaries.
 */
export function parsePsProcessTable(
  output: string,
  options: { readonly uid?: number; readonly nowMs: number },
): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of output.split("\n").slice(0, MAX_PROCESSES)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*)$/u.exec(line);
    if (!match) continue;
    const [, pid, ppid, uid, elapsed, command] = match;
    if (options.uid !== undefined && Number(uid) !== options.uid) continue;
    const elapsedMs = parsePsElapsedMs(elapsed ?? "");
    entries.push({
      pid: Number(pid),
      ppid: Number(ppid),
      args: (command ?? "").trim().split(/\s+/u),
      startedAtMs: elapsedMs === null ? null : options.nowMs - elapsedMs,
    });
  }
  return entries;
}

async function readPsProcessTable(nowMs: number): Promise<ProcessTableEntry[] | null> {
  const output = await new Promise<string | null>((resolve) => {
    execFile(
      "ps",
      ["-axww", "-o", "pid=,ppid=,uid=,etime=,command="],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
  return output === null ? null : parsePsProcessTable(output, { uid: process.getuid?.(), nowMs });
}

/**
 * The current user's process table for this platform: `/proc` on Linux and WSL, `ps` on macOS.
 * Native Windows has no reader (listing command lines needs WMI, too slow for `resin status`),
 * so sessions there are not checked.
 */
export function createProcessTableReader(
  options: { readonly platform?: NodeJS.Platform; readonly now?: () => number } = {},
): ProcessTableReader {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return () => readProcProcessTable();
  if (platform === "darwin") return () => readPsProcessTable((options.now ?? Date.now)());
  return async () => null;
}
