import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { nowIso } from "@resin/contracts/common";
import {
  type HarnessInstallation,
  type HarnessSession,
  UNKNOWN_HARNESS_VERSION,
} from "@resin/harness-contracts";

export const MUSE_HARNESS_ID = "muse-code";
export const MUSE_DISPLAY_NAME = "Muse Code";

/**
 * Exact `muse` versions qualified with the recorded fixtures under
 * `tests/fixtures/recorded/<version>/`.
 */
export const MUSE_TESTED_VERSIONS = ["1.4.0"] as const;

/** Sessions whose log changed this recently are reported as active. */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
/** Bytes read from the head of a log to find its workspace root. */
const HEAD_INSPECTION_BYTES = 256 * 1024;

type Env = NodeJS.ProcessEnv;

/** `$XDG_CONFIG_HOME/muse`, else `~/.config/muse` (the directory muse reports as `$CONFIG_DIR`). */
export function resolveMuseConfigDir(home: string, env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "muse") : path.join(home, ".config", "muse");
}

/** User settings file holding `mcp_servers`. */
export function resolveMuseSettingsPath(home: string, env: Env = process.env): string {
  return path.join(resolveMuseConfigDir(home, env), "settings.json");
}

/**
 * Machine-wide user rules file. Muse loads it into every session as
 * `<rules-file scope="user" path="$CONFIG_DIR/AGENTS.md">`, trusted workspace or not.
 */
export function resolveMuseUserRulesPath(home: string, env: Env = process.env): string {
  return path.join(resolveMuseConfigDir(home, env), "AGENTS.md");
}

/** `$XDG_DATA_HOME/muse/sessions`, else `~/.local/share/muse/sessions`. */
export function resolveMuseSessionRoot(home: string, env: Env = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg
    ? path.join(xdg, "muse", "sessions")
    : path.join(home, ".local", "share", "muse", "sessions");
}

/** Extracts `1.4.0` from `Muse Code 1.4.0 (1.4.0-R4161.1)` or `1.4.0-R4161.1`. */
export function parseMuseVersion(text: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(text);
  return match?.[1] ?? null;
}

export type MuseVersionExecutor = (executable: string, env: Env) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultVersionExecutor: MuseVersionExecutor = async (executable, env) => {
  // The launcher self-updates unless told not to; a probe must never download a release. It also
  // runs against a throwaway home so nothing is written into the user's.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "resin-muse-probe-"));
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], {
      env: {
        ...env,
        MUSE_NO_AUTO_UPDATE: "1",
        HOME: scratch,
        XDG_CONFIG_HOME: path.join(scratch, "config"),
        XDG_DATA_HOME: path.join(scratch, "data"),
        XDG_CACHE_HOME: path.join(scratch, "cache"),
        XDG_STATE_HOME: path.join(scratch, "state"),
      },
      timeout: 5_000,
    });
    return String(stdout);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
};

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds `muse` on PATH. */
export async function findMuseExecutable(env: Env = process.env): Promise<string | null> {
  const names = process.platform === "win32" ? ["muse.exe", "muse.cmd", "muse"] : ["muse"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Reads the installed version. The launcher records the active release in a `.muse-version`
 * file beside itself; reading it avoids running the launcher at all. Otherwise
 * `muse --version` runs with auto-update disabled.
 */
export async function readMuseVersion(
  executable: string,
  env: Env = process.env,
  executor: MuseVersionExecutor = defaultVersionExecutor,
): Promise<string> {
  try {
    const recorded = await fs.readFile(
      path.join(path.dirname(executable), ".muse-version"),
      "utf8",
    );
    const version = parseMuseVersion(recorded);
    if (version) return version;
  } catch {
    // No launcher version file: fall through to the binary.
  }
  try {
    return parseMuseVersion(await executor(executable, env)) ?? UNKNOWN_HARNESS_VERSION;
  } catch {
    return UNKNOWN_HARNESS_VERSION;
  }
}

export interface MuseProbeOptions {
  home?: string;
  env?: Env;
  executablePath?: string;
  executor?: MuseVersionExecutor;
}

/**
 * Detects a Muse Code install: the `muse` executable, or failing that its config directory.
 */
export async function probeMuseInstallation(
  options: MuseProbeOptions = {},
): Promise<HarnessInstallation | null> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const configDir = resolveMuseConfigDir(home, env);
  const executable =
    options.executablePath && (await isExecutableFile(options.executablePath))
      ? options.executablePath
      : await findMuseExecutable(env);
  const configExists = await fs
    .stat(configDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!executable && !configExists) return null;

  const version = executable
    ? await readMuseVersion(executable, env, options.executor)
    : UNKNOWN_HARNESS_VERSION;
  return {
    harnessId: MUSE_HARNESS_ID,
    displayName: MUSE_DISPLAY_NAME,
    version,
    ...(executable ? { executablePath: executable } : {}),
    configPath: resolveMuseSettingsPath(home, env),
    homePath: configDir,
    isInstalled: executable !== null,
    status: executable ? "ready" : "missing_executable",
    detectedAt: nowIso(),
    metadata: { sessionRoot: resolveMuseSessionRoot(home, env) },
  };
}

/** How a nested session log relates to its lead session. */
export type MuseChildKind = "subagent" | "observer";

export interface MuseSessionLog {
  /** Native session id (directory name). */
  sessionId: string;
  filePath: string;
  /** Workspace root recorded by the lead session, when found. */
  workspaceRoot: string | null;
  parentSessionId: string | null;
  childKind: MuseChildKind | null;
  /** Observer agent id (e.g. `verify-reminder`) or subagent id. */
  childAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
}

interface LeadSessionScan {
  workspaceRoot: string | null;
  children: Map<string, { kind: MuseChildKind; agentId: string | null }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Inner records of one log line: a plain record, or the children of a retained frame. */
export function expandMuseLogLine(line: unknown): Record<string, unknown>[] {
  const record = asRecord(line);
  if (!record) return [];
  if (typeof record.retained_frame === "string" && Array.isArray(record.children)) {
    const out: Record<string, unknown>[] = [];
    for (const child of record.children) {
      const json = asRecord(child)?.record_json;
      if (typeof json !== "string") continue;
      try {
        const parsed = asRecord(JSON.parse(json));
        if (parsed) out.push(parsed);
      } catch {
        // A malformed frame member is skipped; its siblings stay readable.
      }
    }
    return out;
  }
  return [record];
}

function workspaceRootOf(record: Record<string, unknown>): string | null {
  const payload = asRecord(record.payload);
  const root = asRecord(payload?.record)?.workspace_root;
  return typeof root === "string" && root.length > 0 ? root : null;
}

/**
 * Scans a lead session log for its workspace root and for the nested sessions it linked:
 * spawned subagents (`subagent.control.child_session_bound`) and background observers
 * (`memory_reminder_child_session_linked`). Only lines that can carry those facts are parsed.
 */
async function scanLeadSession(filePath: string): Promise<LeadSessionScan> {
  const scan: LeadSessionScan = { workspaceRoot: null, children: new Map() };
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      const wantsRoot = scan.workspaceRoot === null && bytes <= HEAD_INSPECTION_BYTES;
      const wantsChild =
        line.includes("child_session_bound") ||
        line.includes("memory_reminder_child_session_linked");
      if (!wantsRoot && !wantsChild) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      for (const record of expandMuseLogLine(parsed)) {
        if (scan.workspaceRoot === null) scan.workspaceRoot = workspaceRootOf(record);
        const payload = asRecord(record.payload);
        const bound = asRecord(payload?.record);
        if (record.payload_type === "subagent.control.child_session_bound" && bound) {
          const child = bound.child_session_id;
          if (typeof child === "string") {
            scan.children.set(child, {
              kind: "subagent",
              agentId: typeof bound.subagent_id === "string" ? bound.subagent_id : null,
            });
          }
        }
        const event = asRecord(payload?.event);
        if (event?.kind === "memory_reminder_child_session_linked") {
          const child = event.child_session_id;
          if (typeof child === "string") {
            scan.children.set(child, {
              kind: "observer",
              agentId: typeof event.reminder_agent_id === "string" ? event.reminder_agent_id : null,
            });
          }
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return scan;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function statLog(
  filePath: string,
): Promise<{ createdAt: string; updatedAt: string; sizeBytes: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return {
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Enumerates every session log under `<root>/YYYY/MM/DD/<session-id>/session.jsonl`, plus the
 * nested `subagent/<child-id>/session.jsonl` logs of spawned subagents and background observer
 * agents. Children inherit their lead session's workspace root.
 */
export async function discoverMuseSessionLogs(sessionRoot: string): Promise<MuseSessionLog[]> {
  const logs: MuseSessionLog[] = [];
  for (const year of (await listDirs(sessionRoot)).filter((name) => /^\d{4}$/.test(name))) {
    for (const month of await listDirs(path.join(sessionRoot, year))) {
      for (const day of await listDirs(path.join(sessionRoot, year, month))) {
        const dayDir = path.join(sessionRoot, year, month, day);
        for (const sessionId of await listDirs(dayDir)) {
          const sessionDir = path.join(dayDir, sessionId);
          const filePath = path.join(sessionDir, "session.jsonl");
          const stat = await statLog(filePath);
          if (!stat) continue;
          const scan = await scanLeadSession(filePath);
          logs.push({
            sessionId,
            filePath,
            workspaceRoot: scan.workspaceRoot,
            parentSessionId: null,
            childKind: null,
            childAgentId: null,
            ...stat,
          });
          for (const childId of await listDirs(path.join(sessionDir, "subagent"))) {
            const childPath = path.join(sessionDir, "subagent", childId, "session.jsonl");
            const childStat = await statLog(childPath);
            if (!childStat) continue;
            const link = scan.children.get(childId);
            logs.push({
              sessionId: childId,
              filePath: childPath,
              workspaceRoot: scan.workspaceRoot,
              parentSessionId: sessionId,
              // A nested log the lead never linked is still a child the lead started.
              childKind: link?.kind ?? "subagent",
              childAgentId: link?.agentId ?? null,
              ...childStat,
            });
          }
        }
      }
    }
  }
  return logs;
}

export function workspaceIdForMuseRoot(rootPath: string): string {
  const slug = rootPath
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-72);
  const digest = createHash("sha256").update(rootPath).digest("hex").slice(0, 12);
  return `ws_muse_${slug || "root"}_${digest}`;
}

export function sessionForMuseLog(
  log: MuseSessionLog,
  workspaceId: string,
  now: number = Date.now(),
): HarnessSession {
  const recent = now - Date.parse(log.updatedAt) < ACTIVE_WINDOW_MS;
  return {
    sessionId: log.sessionId,
    workspaceId,
    harnessId: MUSE_HARNESS_ID,
    transcriptPath: log.filePath,
    // Recent writes enable attachment; a quiet log stays idle because muse can resume it.
    status: recent ? "active" : "idle",
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
    metadata: {
      fileSizeBytes: log.sizeBytes,
      ...(log.workspaceRoot ? { cwd: log.workspaceRoot } : {}),
      ...(log.parentSessionId ? { parentSessionId: log.parentSessionId } : {}),
      ...(log.childKind ? { childKind: log.childKind } : {}),
      ...(log.childAgentId ? { childAgentId: log.childAgentId } : {}),
    },
  };
}
