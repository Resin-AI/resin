import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) {
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

/** Executes a recorded builtin through OMP's public builtin registry in its Bun runtime. */
export async function invokeOmpNativeTool(
  request: OmpNativeToolRequest,
): Promise<OmpNativeToolResult> {
  const host = fileURLToPath(new URL("./native-tool-host.js", import.meta.url));
  return await new Promise<OmpNativeToolResult>((resolve, reject) => {
    const child = spawn("bun", [host], {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: request.signal,
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
