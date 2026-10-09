/**
 * The versioned contract between a `resin mcp` supervisor and the releases it runs.
 *
 * A supervisor stays loaded for a whole harness session while releases come and go beneath it, so
 * a gateway released later must keep working under it. Everything a supervisor relies on is
 * fixed here and only ever extended:
 *
 * - **Pointer (format 1).** The active release is `<RESIN_HOME>/current`, a symlink (a directory
 *   junction on Windows) to `<RESIN_HOME>/versions/v<version>`, or else the `current-version`
 *   file holding `<version>`. The installer writes both; see `switchActiveVersion`.
 * - **Child launch (protocol 1).** `<node> <RESIN_HOME>/versions/v<version>/bin/resin mcp <args>`
 *   with the harness's arguments, working directory and environment, plus
 *   `RESIN_MCP_SUPERVISOR=1`. The child speaks MCP over newline-delimited JSON-RPC on its stdio,
 *   exactly as it would to a harness, and exits when its stdin closes.
 * - **Registration (schema 1).** `<RESIN_HOME>/run/mcp-supervisors/<pid>.json` names the
 *   supervisor and the gateway processes it runs, so `resin status` can tell that they switch
 *   releases on their own.
 *
 * A release that changes how it runs its gateway must still honour protocol 1 when it sees
 * `RESIN_MCP_SUPERVISOR=1`. Only node builtins are imported here and in the supervisor: it is
 * loaded once from the release the harness started and must not need that release again.
 */
import fs from "node:fs";
import path from "node:path";

/** The child launch protocol this supervisor speaks; passed to children as `RESIN_MCP_SUPERVISOR`. */
export const MCP_SUPERVISOR_PROTOCOL = 1;
/** The active-release pointer format this supervisor reads. */
export const MCP_SUPERVISOR_POINTER_FORMAT = 1;
/** Set (to the protocol version) in a supervised gateway's environment. */
export const MCP_SUPERVISOR_ENV = "RESIN_MCP_SUPERVISOR";
/** `0`/`false`/`off`/`no` runs `resin mcp` in process, without a supervisor. */
export const MCP_HOTSWAP_ENV = "RESIN_MCP_HOTSWAP";
/** How often the supervisor reads the active-release pointer, in milliseconds. */
export const MCP_HOTSWAP_POLL_ENV = "RESIN_MCP_HOTSWAP_POLL_MS";
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

const RELEASE_DIRECTORY = /^v[0-9A-Za-z][0-9A-Za-z.+-]*$/u;
const OFF_VALUES: ReadonlySet<string> = new Set(["0", "false", "off", "no"]);

/** Whether `env` turns release switching off for `resin mcp`. */
export function isHotSwapDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[MCP_HOTSWAP_ENV]?.trim().toLowerCase();
  return value !== undefined && OFF_VALUES.has(value);
}

/** Whether this process is a gateway a supervisor started. */
export function isSupervisedGateway(env: NodeJS.ProcessEnv): boolean {
  const value = env[MCP_SUPERVISOR_ENV]?.trim();
  return value !== undefined && value !== "";
}

/** The poll interval from `env`, or the default; 0 turns polling off. */
export function pollIntervalFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[MCP_HOTSWAP_POLL_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_POLL_INTERVAL_MS;
}

/** An installed release: its directory name under `versions` (`v1.2.3`) and its version. */
export interface InstalledRelease {
  readonly directory: string;
  readonly version: string;
}

function releaseFromDirectory(directory: string): InstalledRelease | null {
  if (!RELEASE_DIRECTORY.test(directory) || directory.includes("..")) return null;
  return { directory, version: directory.slice(1) };
}

/**
 * The Resin home and release a launcher at `entryPath` belongs to, when it sits in the installed
 * layout `<home>/versions/v<version>/bin/<entry>`. Null for a source checkout or package-manager
 * install: there is no pointer to follow there.
 */
export function locateInstalledLauncher(
  entryPath: string,
): { readonly resinHome: string; readonly release: InstalledRelease } | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(entryPath);
  } catch {
    return null;
  }
  const binDir = path.dirname(resolved);
  const releaseDir = path.dirname(binDir);
  const versionsDir = path.dirname(releaseDir);
  if (path.basename(binDir) !== "bin" || path.basename(versionsDir) !== "versions") return null;
  const release = releaseFromDirectory(path.basename(releaseDir));
  if (release === null) return null;
  return { resinHome: path.dirname(versionsDir), release };
}

/** `<home>/versions/<directory>/bin/resin`, the entry a supervised child runs. */
export function releaseEntryPath(resinHome: string, release: InstalledRelease): string {
  return path.join(resinHome, "versions", release.directory, "bin", "resin");
}

function stripLinkTarget(target: string): string {
  // Windows junction targets may carry the `\\?\` prefix and a trailing separator.
  return target.replace(/^\\\\\?\\/u, "").replace(/[\\/]+$/u, "");
}

/**
 * Reads the active release (pointer format 1). Never throws; null when no pointer names an
 * installed-layout release. A link that points outside `<home>/versions` is ignored, and the
 * result is always resolved inside `<home>/versions`.
 */
export function readActiveRelease(resinHome: string): InstalledRelease | null {
  try {
    const target = stripLinkTarget(fs.readlinkSync(path.join(resinHome, "current")));
    const resolved = path.resolve(resinHome, target);
    if (path.basename(path.dirname(resolved)).toLowerCase() === "versions") {
      const release = releaseFromDirectory(path.basename(resolved));
      if (release !== null) return release;
    }
  } catch {
    // No link (or not a link): fall back to the pointer file.
  }
  try {
    const version = fs
      .readFileSync(path.join(resinHome, "current-version"), "utf8")
      .trim()
      .replace(/^v/u, "");
    if (version !== "") return releaseFromDirectory(`v${version}`);
  } catch {
    // No pointer file either.
  }
  return null;
}

/** Whether `release` is installed with an entry a child can run. */
export function isReleaseRunnable(resinHome: string, release: InstalledRelease): boolean {
  try {
    return fs.statSync(releaseEntryPath(resinHome, release)).isFile();
  } catch {
    return false;
  }
}

/** The command a supervisor runs a release's gateway with (protocol 1). */
export interface ChildLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly release: InstalledRelease;
}

export function childLaunch(options: {
  readonly resinHome: string;
  readonly release: InstalledRelease;
  readonly nodePath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): ChildLaunch {
  return {
    command: options.nodePath,
    args: [releaseEntryPath(options.resinHome, options.release), "mcp", ...options.args],
    env: { ...options.env, [MCP_SUPERVISOR_ENV]: String(MCP_SUPERVISOR_PROTOCOL) },
    cwd: options.cwd,
    release: options.release,
  };
}

/** `<home>/run/mcp-supervisors`, beside the gateway registry (`run/mcp-gateways`). */
export function supervisorRegistryDir(resinHome: string): string {
  return path.join(resinHome, "run", "mcp-supervisors");
}

/** A live supervisor's registration (schema 1). */
export interface SupervisorRegistration {
  readonly schemaVersion: 1;
  readonly pid: number;
  /** The child launch protocol the supervisor speaks. */
  readonly protocol: number;
  /** The release the supervisor itself was loaded from. */
  readonly version: string;
  /** The release new requests go to. */
  readonly activeVersion: string;
  /** Every gateway process the supervisor runs: the active one and any still finishing. */
  readonly childPids: readonly number[];
  readonly startedAt: string;
}

const MAX_VERSION_LENGTH = 64;
const MAX_CHILD_PIDS = 16;

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_VERSION_LENGTH;
}

/** Validates a parsed registration file; null when it is not schema 1. */
export function parseSupervisorRegistration(value: unknown): SupervisorRegistration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = { ...value };
  const childPids = record.childPids;
  if (
    record.schemaVersion !== 1 ||
    !isPid(record.pid) ||
    typeof record.protocol !== "number" ||
    !Number.isInteger(record.protocol) ||
    record.protocol < 1 ||
    !isShortString(record.version) ||
    !isShortString(record.activeVersion) ||
    !isShortString(record.startedAt) ||
    !Array.isArray(childPids) ||
    childPids.length > MAX_CHILD_PIDS ||
    !childPids.every(isPid)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    pid: record.pid,
    protocol: record.protocol,
    version: record.version,
    activeVersion: record.activeVersion,
    childPids: [...childPids],
    startedAt: record.startedAt,
  };
}

/** Writes (atomically) or removes this supervisor's registration. Never throws. */
export function writeSupervisorRegistration(
  resinHome: string,
  registration: SupervisorRegistration,
): void {
  const directory = supervisorRegistryDir(resinHome);
  const filePath = path.join(directory, `${registration.pid}.json`);
  const temp = path.join(directory, `.${registration.pid}.json.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, `${JSON.stringify(registration)}\n`, { mode: 0o600 });
    fs.renameSync(temp, filePath);
  } catch {
    // Diagnostic only: a missing registration makes status advise a restart, nothing worse.
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Ignore.
    }
  }
}

export function removeSupervisorRegistration(resinHome: string, pid: number): void {
  try {
    fs.rmSync(path.join(supervisorRegistryDir(resinHome), `${pid}.json`), { force: true });
  } catch {
    // A stale registration is pruned by the next reader.
  }
}
