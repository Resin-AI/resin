import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  type SupervisorRegistration,
  parseSupervisorRegistration,
  supervisorRegistryDir,
} from "@resin/gateway/mcp-supervisor";
import { z } from "zod";
import { getActiveVersion } from "../installer/asset-downloader.js";
import { compareSemver } from "../installer/channel-verifier.js";

/**
 * Harness-owned `resin mcp` processes are not part of the resident service, so an
 * update cannot restart them. Each gateway records the version it runs so status
 * can tell the user which harnesses still need a restart.
 */
const GatewayRegistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    pid: z.number().int().positive(),
    version: z.string().min(1).max(64),
    startedAt: z.string().min(1).max(64),
  })
  .strict();

export type GatewayRegistration = z.infer<typeof GatewayRegistrationSchema>;

const MAX_REGISTRATIONS = 256;

export function resolveGatewayRegistryDir(resinHome: string): string {
  return path.join(resinHome, "run", "mcp-gateways");
}

/** Records this gateway process; returns an idempotent synchronous unregister. */
export function registerRunningGateway(options: {
  readonly resinHome: string;
  readonly version: string;
  readonly pid?: number;
  readonly now?: () => number;
}): () => void {
  const pid = options.pid ?? process.pid;
  const directory = resolveGatewayRegistryDir(options.resinHome);
  const filePath = path.join(directory, `${pid}.json`);
  fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registration: GatewayRegistration = GatewayRegistrationSchema.parse({
    schemaVersion: 1,
    pid,
    version: options.version.replace(/^v/u, ""),
    startedAt: new Date((options.now ?? Date.now)()).toISOString(),
  });
  fsSync.writeFileSync(filePath, `${JSON.stringify(registration)}\n`, { mode: 0o600 });
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    try {
      fsSync.rmSync(filePath, { force: true });
    } catch {
      // A stale registration is pruned by the next reader.
    }
  };
}

/** How often a gateway re-reads the active version pointer for its release notice. */
export const RELEASE_NOTICE_CHECK_INTERVAL_MS = 60_000;

/**
 * The tool-result notice a long-lived unsupervised gateway gives once a newer release is active.
 * A gateway running in process (a session started before the MCP supervisor shipped, or with
 * `RESIN_MCP_HOTSWAP=0`) cannot swap in the new code itself: Node has no in-place exec. So it tells
 * the agent instead. Supervised gateways are switched by their supervisor and give no notice.
 * Reads the `current` pointer at most once per interval; never throws.
 */
export function createActivatedReleaseNotice(options: {
  readonly resinHome: string;
  readonly runningVersion: string;
  readonly readActiveVersion?: (resinHome: string) => string | null;
  readonly clock?: () => number;
  readonly intervalMs?: number;
}): () => string | undefined {
  const readActive = options.readActiveVersion ?? getActiveVersion;
  const clock = options.clock ?? Date.now;
  const intervalMs = options.intervalMs ?? RELEASE_NOTICE_CHECK_INTERVAL_MS;
  const running = options.runningVersion.replace(/^v/u, "");
  let checkedAtMs: number | undefined;
  let notice: string | undefined;
  return () => {
    const nowMs = clock();
    if (checkedAtMs !== undefined && nowMs - checkedAtMs < intervalMs) return notice;
    checkedAtMs = nowMs;
    try {
      const active = readActive(options.resinHome)?.replace(/^v/u, "");
      notice =
        active && compareSemver(active, running) > 0
          ? `Resin v${active} was activated, but this Resin MCP server still runs v${running}. Restart this session to use v${active}.`
          : undefined;
    } catch {
      notice = undefined;
    }
    return notice;
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Linux exposes process start times in USER_HZ ticks, fixed at 100 for the userspace ABI. */
const PROC_CLOCK_TICKS_PER_SECOND = 100;

/**
 * Slack between a process's start time and its registration's `startedAt`: boot time is
 * whole seconds and the wall clock may step, so only a clearly later start proves PID reuse.
 */
const PID_REUSE_TOLERANCE_MS = 5_000;

/**
 * The process's start time in epoch ms from `/proc`, or null where it cannot be read (no
 * `/proc`, the process exited, or an unexpected format).
 */
async function readProcessStartTimeMs(procRoot: string, pid: number): Promise<number | null> {
  try {
    const bootLine = (await fs.readFile(path.join(procRoot, "stat"), "utf8"))
      .split("\n")
      .find((line) => line.startsWith("btime "));
    const bootTimeSeconds = Number(bootLine?.slice("btime ".length).trim());
    const stat = await fs.readFile(path.join(procRoot, String(pid), "stat"), "utf8");
    // Fields after the parenthesized command name start at field 3 (state); starttime is 22.
    const startTicks = Number(
      stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u)[19],
    );
    if (!Number.isFinite(bootTimeSeconds) || !Number.isFinite(startTicks) || bootTimeSeconds <= 0) {
      return null;
    }
    return bootTimeSeconds * 1000 + (startTicks * 1000) / PROC_CLOCK_TICKS_PER_SECOND;
  } catch {
    return null;
  }
}

/**
 * Whether the live process holding a registration's PID started after the gateway registered,
 * i.e. the gateway died without unregistering (SIGKILL, OOM) and the PID was reused.
 */
async function isReusedPid(
  registration: { readonly pid: number; readonly startedAt: string },
  procRoot: string,
): Promise<boolean> {
  const registeredAtMs = Date.parse(registration.startedAt);
  if (!Number.isFinite(registeredAtMs)) return false;
  const startedAtMs = await readProcessStartTimeMs(procRoot, registration.pid);
  return startedAtMs !== null && startedAtMs > registeredAtMs + PID_REUSE_TOLERANCE_MS;
}

/**
 * Lists live gateways, pruning registrations whose process has exited or whose PID now belongs
 * to a process started after the registration (checked through `/proc` where available).
 */
export async function listRunningGateways(options: {
  readonly resinHome: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly procRoot?: string;
}): Promise<GatewayRegistration[]> {
  const directory = resolveGatewayRegistryDir(options.resinHome);
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => /^\d+\.json$/u.test(name));
  } catch {
    return [];
  }
  const isAlive = options.isAlive ?? isProcessAlive;
  const procRoot = options.procRoot ?? "/proc";
  const live: GatewayRegistration[] = [];
  for (const name of names.slice(0, MAX_REGISTRATIONS)) {
    const filePath = path.join(directory, name);
    try {
      const parsed = GatewayRegistrationSchema.safeParse(
        JSON.parse(await fs.readFile(filePath, "utf8")),
      );
      if (
        parsed.success &&
        isAlive(parsed.data.pid) &&
        !(await isReusedPid(parsed.data, procRoot))
      ) {
        live.push(parsed.data);
        continue;
      }
    } catch {
      // Unreadable registrations are treated as stale.
    }
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
  return live;
}

/**
 * Lists live `resin mcp` supervisors (`run/mcp-supervisors`, written by
 * `@resin/gateway/mcp-supervisor`), pruning records of exited or reused PIDs like
 * {@link listRunningGateways}. A supervisor switches its session to a newly activated release on
 * its own, so neither it nor the gateways it runs need a restart.
 */
export async function listRunningSupervisors(options: {
  readonly resinHome: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly procRoot?: string;
}): Promise<SupervisorRegistration[]> {
  const directory = supervisorRegistryDir(options.resinHome);
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => /^\d+\.json$/u.test(name));
  } catch {
    return [];
  }
  const isAlive = options.isAlive ?? isProcessAlive;
  const procRoot = options.procRoot ?? "/proc";
  const live: SupervisorRegistration[] = [];
  for (const name of names.slice(0, MAX_REGISTRATIONS)) {
    const filePath = path.join(directory, name);
    try {
      const parsed = parseSupervisorRegistration(JSON.parse(await fs.readFile(filePath, "utf8")));
      if (
        parsed !== null &&
        `${parsed.pid}.json` === name &&
        isAlive(parsed.pid) &&
        !(await isReusedPid(parsed, procRoot))
      ) {
        live.push(parsed);
        continue;
      }
    } catch {
      // Unreadable registrations are treated as stale.
    }
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
  return live;
}

/** PIDs that switch releases on their own: live supervisors and the gateways they run. */
export function switchableGatewayPids(supervisors: readonly SupervisorRegistration[]): Set<number> {
  const pids = new Set<number>();
  for (const supervisor of supervisors) {
    pids.add(supervisor.pid);
    for (const childPid of supervisor.childPids) pids.add(childPid);
  }
  return pids;
}

const RESIN_ENTRY_BASENAME = /^resin(?:\.m?js)?$/u;

function realpathOrSelf(filePath: string): string {
  try {
    return fsSync.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Finds live `resin mcp` processes of this Resin home that never registered (gateways started
 * by releases older than the registry). Scans `/proc/<pid>/cmdline` for a Resin entry point
 * inside `resinHome` followed by `mcp`; returns nothing where `/proc` is unavailable.
 */
export async function listUnregisteredGatewayPids(options: {
  readonly resinHome: string;
  readonly registeredPids: Iterable<number>;
  readonly procRoot?: string;
  readonly selfPid?: number;
}): Promise<number[]> {
  const procRoot = options.procRoot ?? "/proc";
  let entries: string[];
  try {
    entries = (await fs.readdir(procRoot)).filter((name) => /^\d+$/u.test(name));
  } catch {
    return [];
  }
  const resolvedHome = path.resolve(options.resinHome);
  const homePrefixes = [resolvedHome, realpathOrSelf(resolvedHome)].map(
    (home) => `${home}${path.sep}`,
  );
  const skip = new Set(options.registeredPids);
  skip.add(options.selfPid ?? process.pid);
  const pids: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (skip.has(pid)) continue;
    let args: string[];
    try {
      args = (await fs.readFile(path.join(procRoot, entry, "cmdline"), "utf8")).split("\0");
    } catch {
      continue;
    }
    const isGateway = args.some((arg, index) => {
      if (args[index + 1] !== "mcp" || !path.isAbsolute(arg)) return false;
      if (!RESIN_ENTRY_BASENAME.test(path.basename(arg))) return false;
      return [path.resolve(arg), realpathOrSelf(arg)].some((candidate) =>
        homePrefixes.some((prefix) => candidate.startsWith(prefix)),
      );
    });
    if (isGateway) pids.push(pid);
  }
  return pids.sort((left, right) => left - right);
}

/**
 * First release whose shared credential client takes over the refresh lock only after its holder
 * stops heartbeating and refreshes only on 401 (resin#294). Older gateways keep a 30 s lock
 * takeover and refresh on 403 too, so sharing `device-token.json` with them can replay a rotated
 * refresh token and get the whole device sign-in revoked.
 */
export const FIRST_HARDENED_CREDENTIAL_CLIENT_VERSION = "1.0.122";

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** A live gateway whose credential client predates the hardening; `version` null = unregistered. */
export interface CredentialUnsafeGateway {
  readonly pid: number;
  readonly version: string | null;
}

/**
 * Whether a registered gateway version predates the hardened credential client. Source builds
 * report the workspace version (0.x) and run current code, so only 1.x releases are compared.
 */
export function isCredentialUnsafeGatewayVersion(version: string): boolean {
  const normalized = version.replace(/^v/u, "");
  return (
    RELEASE_VERSION.test(normalized) &&
    compareSemver(normalized, "1.0.0") >= 0 &&
    compareSemver(normalized, FIRST_HARDENED_CREDENTIAL_CLIENT_VERSION) < 0
  );
}

/**
 * Selects the gateways that must restart before this device shares new credentials with them:
 * registered gateways older than the hardened client, plus every unregistered one (their release
 * predates the registry, so it predates the hardening too). Sorted by PID.
 */
export function selectCredentialUnsafeGateways(
  registered: readonly GatewayRegistration[],
  unregisteredPids: readonly number[],
): CredentialUnsafeGateway[] {
  return [
    ...registered
      .filter((gateway) => isCredentialUnsafeGatewayVersion(gateway.version))
      .map((gateway) => ({ pid: gateway.pid, version: gateway.version.replace(/^v/u, "") })),
    ...unregisteredPids.map((pid) => ({ pid, version: null })),
  ].sort((left, right) => left.pid - right.pid);
}

/** Lists live `resin mcp` gateways of this Resin home whose credential client predates #294. */
export async function listCredentialUnsafeGateways(options: {
  readonly resinHome: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly procRoot?: string;
}): Promise<CredentialUnsafeGateway[]> {
  const registered = await listRunningGateways(options);
  const supervisors = await listRunningSupervisors(options);
  const unregisteredPids = await listUnregisteredGatewayPids({
    resinHome: options.resinHome,
    // A supervisor runs no credential client of its own; the gateways it runs register.
    registeredPids: [
      ...registered.map((gateway) => gateway.pid),
      ...supervisors.map((supervisor) => supervisor.pid),
    ],
    procRoot: options.procRoot,
  });
  return selectCredentialUnsafeGateways(registered, unregisteredPids);
}

/** The user-facing explanation and remedy for credential-unsafe gateways, or null when none. */
export function formatCredentialUnsafeGateways(
  gateways: readonly CredentialUnsafeGateway[],
): string | null {
  if (gateways.length === 0) return null;
  const list = gateways
    .map(
      (gateway) =>
        `${gateway.pid} (${gateway.version ? `v${gateway.version}` : "unknown version"})`,
    )
    .join(", ");
  return `${gateways.length} running MCP gateway process(es) use a Resin credential client older than v${FIRST_HARDENED_CREDENTIAL_CLIENT_VERSION}: PID ${list}. Sharing this device's sign-in with them can replay a rotated refresh token and get the sign-in revoked. Restart the harness sessions that own these PIDs (exit and reopen them).`;
}
