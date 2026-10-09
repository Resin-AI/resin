import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { LocalDatabaseConnection } from "@resin/db";
import {
  McpStdioShim,
  type McpStdioShimOptions,
  type ShimCloseReason,
  type ShimStatus,
  shimExitCode,
} from "@resin/gateway";
import { isSupervisedGateway } from "@resin/gateway/mcp-supervisor";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { resolvePaths } from "@resin/observer";
import { getErrorReporter, reportHandledError } from "@resin/observer/error-reporting/core";
import type { McpServerDescriptor } from "@resin/runtime";
import { CLI_VERSION } from "../bin/version.js";
import { HARNESS_DEFINITIONS } from "../harness-runtime-registry.js";
import {
  createActivatedReleaseNotice,
  registerRunningGateway,
} from "../updates/gateway-registry.js";

export interface McpCommandFlags {
  standaloneMode: boolean;
  standaloneFallback: boolean;
  enableToolSearch: boolean;
  fullCatalog: boolean;
  socketPath?: string;
  cwd?: string;
  harnessId?: string;
  dbPath?: string;
  showHelp: boolean;
}

export function parseMcpArgs(args: string[]): McpCommandFlags {
  let standaloneMode = true;
  let standaloneFallback = true;
  let socketPath: string | undefined;
  let cwd: string | undefined;
  let harnessId: string | undefined;
  let dbPath: string | undefined;
  let showHelp = false;
  let enableToolSearch = false;
  let fullCatalog = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h" || arg === "help") {
      showHelp = true;
    } else if (arg === "--enable-tool-search") {
      enableToolSearch = true;
    } else if (arg === "--full-catalog") {
      fullCatalog = true;
    } else if (arg === "--search-listing") {
      // The default since search-only listing became standard; accepted for older registrations.
    } else if (arg === "--standalone" || arg === "-s") {
      standaloneMode = true;
      standaloneFallback = true;
    } else if (arg === "--no-standalone") {
      standaloneMode = false;
      standaloneFallback = false;
    } else if (arg === "--socket" || arg === "-S") {
      standaloneMode = false;
      if (i + 1 < args.length) {
        socketPath = args[++i];
      }
    } else if (arg?.startsWith("--socket=")) {
      standaloneMode = false;
      socketPath = arg.slice(9);
    } else if (arg?.startsWith("-S=")) {
      standaloneMode = false;
      socketPath = arg.slice(3);
    } else if (arg === "--cwd" || arg === "-C") {
      if (i + 1 < args.length) {
        cwd = args[++i];
      }
    } else if (arg?.startsWith("--cwd=")) {
      cwd = arg.slice(6);
    } else if (arg?.startsWith("-C=")) {
      cwd = arg.slice(3);
    } else if (arg === "--harness" || arg === "-H") {
      if (i + 1 < args.length) {
        harnessId = args[++i];
      }
    } else if (arg?.startsWith("--harness=")) {
      harnessId = arg.slice(10);
    } else if (arg?.startsWith("-H=")) {
      harnessId = arg.slice(3);
    } else if (arg === "--db" || arg === "-d") {
      if (i + 1 < args.length) {
        dbPath = args[++i];
      }
    } else if (arg?.startsWith("--db=")) {
      dbPath = arg.slice(5);
    } else if (arg?.startsWith("-d=")) {
      dbPath = arg.slice(3);
    }
  }

  return {
    standaloneMode,
    standaloneFallback,
    enableToolSearch,
    fullCatalog,
    socketPath,
    cwd,
    harnessId,
    dbPath,
    showHelp,
  };
}

export function printMcpHelp(
  outStream: { write: (chunk: string) => boolean | undefined } = process.stdout,
): void {
  const text = `
Resin MCP (v${CLI_VERSION})

Usage:
  resin mcp [options]

Options:
  -s, --standalone       Run the in-process MCP gateway (default)
  --no-standalone        Require a daemon socket connection
  --full-catalog        List every tool (learned tools included) instead of only invoke_tool,
                        this repository's learned tools within the listing cap, and
                        search_tools when some do not fit
  --enable-tool-search  With --full-catalog, also expose search_tools (disabled by default)
  --search-listing      No-op: the bounded listing is the default
  -S, --socket <path>    Daemon socket path
  -C, --cwd <path>       Working directory
  -d, --db <path>        Database path for local state store
  -H, --harness <id>     Harness identifier
  -h, --help             Show command line help
`;
  outStream.write(text.trimStart());
}

export interface McpShimRunner {
  start: () => Promise<ShimStatus | { mode: string }>;
  stop: () => Promise<void>;
  /** Settles when a running shim stopped on its own; see `McpStdioShim.closed`. */
  closed?: () => Promise<ShimCloseReason>;
}

/**
 * The harness this gateway serves: the one `--harness` names, or, for a shim started without it,
 * whichever registered harness declares its servers.
 *
 * Harnesses register the gateway as plain `resin mcp` and do not identify themselves to the MCP
 * servers they spawn (OMP's `OMPCODE`/`CLAUDECODE` variables reach only its bash tool), so a bare
 * shim cannot tell its host apart. The recorded workflow's connections and its native tool steps
 * are both answered from this one harness, so a replay never mixes two harnesses' surfaces.
 */
export function servedHarnessDefinition(
  harnessId: string | undefined,
  definitions: readonly HarnessDefinition[] = HARNESS_DEFINITIONS,
): HarnessDefinition | undefined {
  return harnessId === undefined
    ? definitions.find((candidate) => candidate.resolveMcpServer !== undefined)
    : definitions.find((candidate) => candidate.id === harnessId);
}

/**
 * The protocol connections this host can dial, taken from the harness's own MCP configuration.
 *
 * A recorded callable that was reached over a server names that server; re-making the call means
 * asking that server, so the descriptor is the entry the harness itself runs. A name the
 * configuration does not declare — or one declared over a transport this host cannot speak — has no
 * descriptor, and the step that names it is refused rather than answered from somewhere else.
 */
function harnessMcpConnections(
  definition: HarnessDefinition | undefined,
  cwd: string | undefined,
): ((name: string) => McpServerDescriptor | undefined) | undefined {
  const resolveMcpServer = definition?.resolveMcpServer;
  if (resolveMcpServer === undefined) return undefined;
  const workspaceRoot = cwd ?? process.cwd();
  return (name) => resolveMcpServer(name, workspaceRoot);
}

/**
 * The Resin guidance block installed for a harness, exactly as its context file holds it (markers
 * included): part of what every request in that harness carries, so the gateway counts it in the
 * listing footprint it records. "" when the harness has no guidance or none is installed; undefined
 * when the file cannot be read, so the footprint stays unknown.
 */
export function installedGuidanceBlock(
  harnessId: string,
  home: string,
  env: NodeJS.ProcessEnv,
  definitions: readonly HarnessDefinition[] = HARNESS_DEFINITIONS,
): string | undefined {
  const guidance = definitions.find((definition) => definition.id === harnessId)?.guidance;
  if (guidance === undefined) return "";
  let content: string;
  try {
    content = fs.readFileSync(guidance.resolvePath(home, env), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
  }
  const start = content.indexOf(guidance.markers.start);
  const end = start === -1 ? -1 : content.indexOf(guidance.markers.end, start);
  return end === -1 ? "" : content.slice(start, end + guidance.markers.end.length);
}

export interface McpCommandOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?:
    | NodeJS.WritableStream
    | { isTTY?: boolean; write: (chunk: string) => boolean | undefined };
  stderr?: NodeJS.WritableStream | { write: (chunk: string) => boolean | undefined };
  home?: string;
  env?: NodeJS.ProcessEnv;
  shimFactory?: (options: McpStdioShimOptions) => McpShimRunner;
  /** Records the running gateway version so `resin status` can report stale gateways. */
  registerGateway?: (registration: { resinHome: string; version: string }) => () => void;
}

export async function mcpCommand(args: string[], options: McpCommandOptions = {}): Promise<number> {
  const parsedArgs = parseMcpArgs(args);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (parsedArgs.showHelp) {
    printMcpHelp(stdout);
    return 0;
  }

  const servedHarness = servedHarnessDefinition(parsedArgs.harnessId);
  const nativeToolInvoker = servedHarness?.nativeToolInvoker;
  // The same Resin home the gateway's own state, the update engine and status resolve. Release
  // tracking is diagnostic only, so a home that cannot be resolved never blocks the gateway.
  let resinHome: string | undefined;
  try {
    resinHome = resolvePaths({ home: options.home, env: options.env ?? process.env }).homeDir;
  } catch {
    resinHome = undefined;
  }
  const shimOptions: McpStdioShimOptions = {
    standaloneFallback: parsedArgs.standaloneFallback,
    enableToolSearch: parsedArgs.enableToolSearch,
    fullCatalog: parsedArgs.fullCatalog,
    db: parsedArgs.dbPath ? new LocalDatabaseConnection({ path: parsedArgs.dbPath }) : undefined,
    socketPath: parsedArgs.standaloneMode && !parsedArgs.socketPath ? "" : parsedArgs.socketPath,
    cwd: parsedArgs.cwd,
    harnessId: parsedArgs.harnessId,
    maxStartupAttempts: parsedArgs.socketPath ? 1 : 0,
    startupTimeoutMs: parsedArgs.socketPath ? 500 : 0,
    stdin: (options.stdin ?? process.stdin) as NodeJS.ReadableStream,
    stdout: (options.stdout ?? process.stdout) as NodeJS.WritableStream,
    stderr: (options.stderr ?? process.stderr) as NodeJS.WritableStream,
    home: options.home,
    clientVersion: CLI_VERSION,
    recordedWorkflowConnections: harnessMcpConnections(servedHarness, parsedArgs.cwd),
    harnessGuidanceBlock: (harnessId) =>
      installedGuidanceBlock(harnessId, options.home ?? os.homedir(), options.env ?? process.env),
    ...(nativeToolInvoker === undefined ? {} : { recordedHarnessToolInvoker: nativeToolInvoker }),
    // A supervised gateway's session switches to a newly activated release on its own (see
    // `@resin/gateway/mcp-supervisor`), so only an unsupervised one tells the agent to restart.
    ...(resinHome === undefined || isSupervisedGateway(options.env ?? process.env)
      ? {}
      : {
          releaseNotice: createActivatedReleaseNotice({ resinHome, runningVersion: CLI_VERSION }),
        }),
  };

  const shim = options.shimFactory
    ? options.shimFactory(shimOptions)
    : new McpStdioShim(shimOptions);

  let shutdownRegistered = false;
  const shutdown = async () => {
    try {
      await shim.stop();
    } catch {
      // Ignore errors on shutdown
    }
    process.exit(0);
  };

  let unregisterGateway = (): void => undefined;
  if (resinHome !== undefined && (!process.env.VITEST || options.registerGateway)) {
    try {
      const register = options.registerGateway ?? registerRunningGateway;
      unregisterGateway = register({ resinHome, version: CLI_VERSION });
      process.once("exit", unregisterGateway);
    } catch {
      // Version tracking is diagnostic only and must never block the MCP gateway.
    }
  }

  try {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    shutdownRegistered = true;

    const status = await shim.start();
    if (status && typeof status === "object" && "mode" in status && status.mode === "failed") {
      unregisterGateway();
      getErrorReporter().capture("mcp_shim_start_failed");
      return 1;
    }
    if (
      status &&
      typeof status === "object" &&
      "mode" in status &&
      status.mode === "standalone_inprocess"
    ) {
      const stdinStream = (options.stdin ?? process.stdin) as NodeJS.ReadableStream;
      const { promise: stdinEnded, resolve } = Promise.withResolvers<ShimCloseReason>();
      const ended = () => resolve("harness_closed");
      stdinStream.once("end", ended);
      stdinStream.once("close", ended);
      if ("resume" in stdinStream && typeof stdinStream.resume === "function") {
        stdinStream.resume();
      }
      // The shim can also stop first: the harness closed stdout, or a stream failed.
      const reason = await Promise.race(shim.closed ? [stdinEnded, shim.closed()] : [stdinEnded]);
      stdinStream.off("end", ended);
      stdinStream.off("close", ended);
      await shim.stop().catch(() => {
        // The session is over either way, as on a signal.
      });
      return shimExitCode(reason);
    }
    if (shim.closed) {
      // Bridged to the daemon: the session lasts until the harness or the daemon hangs up.
      return shimExitCode(await shim.closed());
    }
    return 0;
  } catch (err) {
    unregisterGateway();
    reportHandledError(err, { failureClass: "mcp_shim_start" });
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Fatal MCP error: ${message}\n`);
    return 1;
  } finally {
    if (shutdownRegistered) {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
  }
}
