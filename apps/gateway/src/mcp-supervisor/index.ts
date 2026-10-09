/**
 * `@resin/gateway/mcp-supervisor`: the process that owns a harness's `resin mcp` stdio and switches
 * the session to a newly activated release. Loads only node builtins; see ./protocol.ts for the
 * versioned contract with the releases it runs.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isHotSwapDisabled,
  isReleaseRunnable,
  isSupervisedGateway,
  locateInstalledLauncher,
  pollIntervalFromEnv,
  readActiveRelease,
  removeSupervisorRegistration,
} from "./protocol.js";
import { McpSupervisor } from "./supervisor.js";

export {
  type ChildLaunch,
  DEFAULT_POLL_INTERVAL_MS,
  type InstalledRelease,
  MCP_HOTSWAP_ENV,
  MCP_HOTSWAP_POLL_ENV,
  MCP_SUPERVISOR_ENV,
  MCP_SUPERVISOR_POINTER_FORMAT,
  MCP_SUPERVISOR_PROTOCOL,
  type SupervisorRegistration,
  childLaunch,
  isHotSwapDisabled,
  isReleaseRunnable,
  isSupervisedGateway,
  locateInstalledLauncher,
  parseSupervisorRegistration,
  readActiveRelease,
  releaseEntryPath,
  supervisorRegistryDir,
} from "./protocol.js";
export {
  McpSupervisor,
  type McpSupervisorEvent,
  type McpSupervisorOptions,
  type SpawnGateway,
} from "./supervisor.js";

const HELP_ARGS: ReadonlySet<string> = new Set(["--help", "-h", "help"]);

export interface RunMcpSupervisorOptions {
  /** The launcher's own location (`import.meta.url` or a path); decides the Resin home. */
  readonly entry: string;
  /** Arguments after `mcp`. */
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: { write: (chunk: string) => unknown };
}

/**
 * Runs `resin mcp` under a supervisor when it can switch releases: the launcher sits in the
 * installed layout, the caller is not itself a supervised gateway, and `RESIN_MCP_HOTSWAP` does
 * not turn it off. Resolves with the exit code once the session is over, or with undefined
 * (before touching stdio) when the launcher should run the gateway in process instead.
 */
export async function runMcpSupervisor(
  options: RunMcpSupervisorOptions,
): Promise<number | undefined> {
  const env = options.env ?? process.env;
  if (isHotSwapDisabled(env) || isSupervisedGateway(env)) return undefined;
  if (options.args.some((arg) => HELP_ARGS.has(arg))) return undefined;
  const entryPath = options.entry.startsWith("file:")
    ? fileURLToPath(options.entry)
    : options.entry;
  const located = locateInstalledLauncher(entryPath);
  if (located === null) return undefined;

  const active = readActiveRelease(located.resinHome);
  const initialRelease =
    active !== null && isReleaseRunnable(located.resinHome, active) ? active : located.release;
  const supervisor = new McpSupervisor({
    resinHome: located.resinHome,
    initialRelease,
    supervisorRelease: located.release,
    args: options.args,
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    env,
    pollIntervalMs: pollIntervalFromEnv(env),
    registrationPid: process.pid,
  });
  const onSignal = (): void => supervisor.stop();
  // A process exiting without the session ending (an uncaught error) leaves no stale record.
  const onExit = (): void => removeSupervisorRegistration(located.resinHome, process.pid);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.once("exit", onExit);
  try {
    supervisor.start();
    return await supervisor.closed();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
  }
}
