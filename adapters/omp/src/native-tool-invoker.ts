import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type HarnessCommandInvocation,
  findHostExecutable,
  harnessCommandInvocation,
  isWindowsBatchFile,
} from "@resin/harness-contracts";

export interface OmpNativeToolRequest {
  name: string;
  parameters: Record<string, unknown>;
  cwd: string;
  signal?: AbortSignal;
}

export interface OmpNativeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function parseResult(value: unknown): OmpNativeToolResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("content" in value) ||
    !Array.isArray(value.content)
  ) {
    throw new Error("OMP native tool host returned an invalid result");
  }
  const content: Array<{ type: "text"; text: string }> = [];
  for (const part of value.content) {
    if (
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      content.push({ type: "text", text: part.text });
    }
  }
  const isError = "isError" in value && value.isError === true;
  return { content, ...(isError ? { isError: true } : {}) };
}

/**
 * How to start Bun on `host`. On Windows `bun` is resolved through `PATHEXT`: an npm or pnpm
 * install puts only a `bun.cmd` shim on `PATH`, which Windows cannot spawn without `cmd.exe`, so
 * the `bun.exe` that shim launches (npm: `<prefix>\node_modules\bun\bin`, pnpm:
 * `node_modules\.bin\..\bun\bin`) is run directly when present.
 */
async function bunInvocation(host: string): Promise<HarnessCommandInvocation> {
  if (process.platform !== "win32") {
    return { file: "bun", args: [host], windowsVerbatimArguments: false };
  }
  const found = await findHostExecutable(["bun"]);
  if (!found) throw new Error("OMP native tools need Bun on PATH (OMP's runtime); none was found");
  // A relative PATH entry names a directory under this process's cwd, not the tool's.
  const bun = path.resolve(found);
  if (isWindowsBatchFile(bun)) {
    const dir = path.dirname(bun);
    for (const packaged of [
      path.join(dir, "node_modules", "bun", "bin", "bun.exe"),
      path.join(dir, "..", "bun", "bin", "bun.exe"),
    ]) {
      if (await isFile(packaged))
        return { file: packaged, args: [host], windowsVerbatimArguments: false };
    }
  }
  return harnessCommandInvocation(bun, [host]);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Executes a recorded builtin through OMP's public builtin registry in its Bun runtime. */
export async function invokeOmpNativeTool(
  request: OmpNativeToolRequest,
): Promise<OmpNativeToolResult> {
  const host = fileURLToPath(new URL("./native-tool-host.js", import.meta.url));
  const bun = await bunInvocation(host);
  return await new Promise<OmpNativeToolResult>((resolve, reject) => {
    const child = spawn(bun.file, bun.args, {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: request.signal,
      windowsHide: true,
      windowsVerbatimArguments: bun.windowsVerbatimArguments,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `OMP native tool host exited with status ${code ?? "unknown"}`,
          ),
        );
        return;
      }
      try {
        resolve(parseResult(JSON.parse(Buffer.concat(stdout).toString("utf8"))));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(
      JSON.stringify({ name: request.name, parameters: request.parameters, cwd: request.cwd }),
    );
  });
}
