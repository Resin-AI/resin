#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LocalDatabaseConnection } from "@resin/db";
import { z } from "zod";
import { McpStdioShim } from "../shim/stdio-bridge.js";

function resolveVersion(): string {
  const candidates = [
    new URL("../../../../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = z
        .object({ version: z.string().min(1) })
        .safeParse(JSON.parse(fs.readFileSync(fileURLToPath(candidate), "utf8")));
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

function printHelp(): void {
  const text = `
Resin MCP Shim (v${VERSION})

Usage:
  resin mcp [options]

Options:
  -s, --standalone       Enable standalone fallback (default)
  --no-standalone        Disable standalone fallback
  --enable-tool-search  Expose search_tools (disabled by default)
  -S, --socket <path>    Daemon socket path
  -C, --cwd <path>       Working directory
  -d, --db <path>        Database path for local state store
  -H, --harness <id>     Harness identifier
  -h, --help             Show command line help
`;
  process.stdout.write(text.trimStart());
}

function parseArgs(args: string[]) {
  let standaloneMode = false;
  let standaloneFallback = true;
  let socketPath: string | undefined;
  let cwd: string | undefined;
  let harnessId: string | undefined;
  let dbPath: string | undefined;
  let showHelp = false;
  let enableToolSearch = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--enable-tool-search") {
      enableToolSearch = true;
    } else if (arg === "--standalone" || arg === "-s") {
      standaloneMode = true;
      standaloneFallback = true;
    } else if (arg === "--no-standalone") {
      standaloneFallback = false;
    } else if ((arg === "--socket" || arg === "-S") && i + 1 < args.length) {
      socketPath = args[++i];
    } else if ((arg === "--cwd" || arg === "-C") && i + 1 < args.length) {
      cwd = args[++i];
    } else if ((arg === "--harness" || arg === "-H") && i + 1 < args.length) {
      harnessId = args[++i];
    } else if ((arg === "--db" || arg === "-d") && i + 1 < args.length) {
      dbPath = args[++i];
    }
  }

  return {
    standaloneMode,
    standaloneFallback,
    enableToolSearch,
    socketPath,
    cwd,
    harnessId,
    dbPath,
    showHelp,
  };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.showHelp) {
    printHelp();
    return;
  }
  const shim = new McpStdioShim({
    standaloneFallback: args.standaloneFallback,
    enableToolSearch: args.enableToolSearch,
    db: args.dbPath ? new LocalDatabaseConnection({ path: args.dbPath }) : undefined,
    socketPath: args.standaloneMode && !args.socketPath ? "" : args.socketPath,
    cwd: args.cwd,
    harnessId: args.harnessId,
    maxStartupAttempts: args.socketPath ? 1 : 0,
    startupTimeoutMs: args.socketPath ? 500 : 0,
  });

  const shutdown = async () => {
    await shim.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const status = await shim.start();
    if (status.mode === "failed") {
      process.exit(1);
    }
    if (status.mode === "standalone_inprocess") {
      await new Promise<void>((resolve) => {
        process.stdin.on("end", resolve);
        process.stdin.on("close", resolve);
        process.stdin.resume();
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal MCP Shim error: ${message}\n`);
    process.exit(1);
  }
}

const isDirectExecution =
  process.argv[1]?.endsWith("mcp-shim.js") ||
  process.argv[1]?.endsWith("mcp-shim.ts") ||
  process.argv[1]?.endsWith("mcp-shim.mjs");

if (isDirectExecution || process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    process.stderr.write(`Unhandled error: ${err}\n`);
    process.exit(1);
  });
}

export { main, parseArgs, printHelp, resolveVersion, VERSION };
