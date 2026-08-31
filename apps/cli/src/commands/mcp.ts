import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LocalDatabaseConnection } from "@resin/db";
import { McpStdioShim, type McpStdioShimOptions, type ShimStatus } from "@resin/gateway";
import { z } from "zod";

const PackageJsonSchema = z.object({
  version: z.string().min(1),
});

function resolveVersion(): string {
  const candidates = [
    new URL("../../../../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = PackageJsonSchema.safeParse(
        JSON.parse(fs.readFileSync(fileURLToPath(candidate), "utf8")),
      );
      if (parsed.success) {
        return parsed.data.version;
      }
    } catch {
      // Continue to the next enclosing package candidate.
    }
  }
  return "0.1.0";
}

const VERSION = process.env.RESIN_RELEASE_VERSION ?? resolveVersion();

export interface McpCommandFlags {
  standaloneMode: boolean;
  standaloneFallback: boolean;
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h" || arg === "help") {
      showHelp = true;
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
Resin MCP (v${VERSION})

Usage:
  resin mcp [options]

Options:
  -s, --standalone       Run the in-process MCP gateway (default)
  --no-standalone        Require a daemon socket connection
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
}

export async function mcpCommand(args: string[], options: McpCommandOptions = {}): Promise<number> {
  const parsedArgs = parseMcpArgs(args);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (parsedArgs.showHelp) {
    printMcpHelp(stdout);
    return 0;
  }

  const shimOptions: McpStdioShimOptions = {
    standaloneFallback: parsedArgs.standaloneFallback,
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

  try {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    shutdownRegistered = true;

    const status = await shim.start();
    if (status && typeof status === "object" && "mode" in status && status.mode === "failed") {
      return 1;
    }
    if (
      status &&
      typeof status === "object" &&
      "mode" in status &&
      status.mode === "standalone_inprocess"
    ) {
      const stdinStream = (options.stdin ?? process.stdin) as NodeJS.ReadableStream;
      await new Promise<void>((resolve) => {
        stdinStream.on("end", resolve);
        stdinStream.on("close", resolve);
        if ("resume" in stdinStream && typeof stdinStream.resume === "function") {
          stdinStream.resume();
        }
      });
    }
    return 0;
  } catch (err) {
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
