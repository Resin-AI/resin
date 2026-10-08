import path from "node:path";
import {
  type ConfigFsBridge,
  type HarnessInstallContext,
  type HarnessInstallExtension,
  type ManagedBlockAction,
  type ManagedBlockResult,
  type ResinMcpLaunch,
  resolveResinSuggestLaunch,
} from "@resin/harness-contracts";
import { resolveOmpConfigHome } from "./instructions.js";

/** File name of Resin's OMP extension in `<OMP home>/agent/extensions`. */
export const OMP_COMMAND_SUGGEST_EXTENSION_FILENAME = "resin-command-suggest.ts";
/** First line of the extension; how Resin recognizes a file it owns. */
export const OMP_COMMAND_SUGGEST_EXTENSION_MARKER =
  "// @resin-managed-omp-extension command-suggest";
/** Longest the extension waits for `resin suggest` before letting the command run unannotated. */
export const OMP_COMMAND_SUGGEST_TIMEOUT_MS = 1_000;

/** OMP discovers native extensions in `<OMP home>/agent/extensions`. */
export function resolveOmpCommandSuggestExtensionPath(
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  return path.join(
    resolveOmpConfigHome(home, env),
    "agent",
    "extensions",
    OMP_COMMAND_SUGGEST_EXTENSION_FILENAME,
  );
}

/**
 * The extension OMP loads. On each `bash` tool call it asks `resin suggest --harness omp` whether a
 * learned tool in the command's repository already runs the command and, if one does, returns the
 * one-line suggestion as `additionalContext`, which OMP delivers to the model with the tool result.
 * It never blocks the call or changes its input, prints nothing, and gives up silently after
 * {@link OMP_COMMAND_SUGGEST_TIMEOUT_MS}. It imports only node builtins: Pi and OMP share the
 * extension API but publish its types under different package names.
 */
export function renderOmpCommandSuggestExtension(launch: ResinMcpLaunch): string {
  return `${OMP_COMMAND_SUGGEST_EXTENSION_MARKER}
// Resin command-time suggestions for OMP. Managed by Resin (\`resin init\` / \`resin uninstall\`);
// edits are overwritten. Turn suggestions off with \`resin suggest --disable\`.
import { spawn } from "node:child_process";
import * as path from "node:path";

const RESIN_COMMAND: string = ${JSON.stringify(launch.command)};
const RESIN_ARGS: string[] = ${JSON.stringify(launch.args)};
const TIMEOUT_MS = ${OMP_COMMAND_SUGGEST_TIMEOUT_MS};
const MAX_OUTPUT_BYTES = 64 * 1024;

function askResin(request: { command: string; cwd: string; sessionId?: string }): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(RESIN_COMMAND, RESIN_ARGS, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(undefined);
    }, TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text.length === 0) return finish(undefined);
        const parsed: unknown = JSON.parse(text);
        const line =
          parsed !== null && typeof parsed === "object" && "additionalContext" in parsed
            ? parsed.additionalContext
            : undefined;
        finish(typeof line === "string" && line.length > 0 ? line : undefined);
      } catch {
        finish(undefined);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}

function sessionIdOf(ctx: unknown): string | undefined {
  try {
    if (ctx === null || typeof ctx !== "object" || !("sessionManager" in ctx)) return undefined;
    const manager = ctx.sessionManager;
    if (manager === null || typeof manager !== "object" || !("getSessionId" in manager)) return undefined;
    const getSessionId = manager.getSessionId;
    const id = typeof getSessionId === "function" ? getSessionId.call(manager) : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export default function resinCommandSuggest(pi: { on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void }): void {
  pi.on("tool_call", async (event: unknown, ctx: unknown) => {
    try {
      if (event === null || typeof event !== "object") return undefined;
      if (!("toolName" in event) || event.toolName !== "bash" || !("input" in event)) return undefined;
      const input = event.input;
      if (input === null || typeof input !== "object" || !("command" in input)) return undefined;
      const command = input.command;
      if (typeof command !== "string" || command.trim().length === 0) return undefined;
      const base =
        ctx !== null && typeof ctx === "object" && "cwd" in ctx && typeof ctx.cwd === "string"
          ? ctx.cwd
          : process.cwd();
      const requested = "cwd" in input && typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : undefined;
      const cwd = requested === undefined ? base : path.resolve(base, requested);
      const sessionId = sessionIdOf(ctx);
      const line = await askResin({ command, cwd, ...(sessionId === undefined ? {} : { sessionId }) });
      return line === undefined ? undefined : { additionalContext: line };
    } catch {
      return undefined;
    }
  });
}
`;
}

async function writeOwned(
  fs: ConfigFsBridge,
  filePath: string,
  content: string | null,
  dryRun: boolean,
): Promise<ManagedBlockResult> {
  const current = await fs.readFile(filePath);
  let action: ManagedBlockAction;
  if (content === null) action = current === null ? "unchanged" : "removed";
  else if (current === content) action = "unchanged";
  else action = current === null ? "created" : "updated";
  if (!dryRun && action !== "unchanged") {
    if (content === null) {
      await fs.unlink(filePath);
    } else {
      await fs.mkdirp(path.dirname(filePath));
      await fs.writeFile(filePath, content);
    }
  }
  return { path: filePath, action };
}

function expectedExtension(context: Pick<HarnessInstallContext, "home" | "env">): string {
  return renderOmpCommandSuggestExtension(
    resolveResinSuggestLaunch(context.home, context.env, "omp"),
  );
}

/** Writes Resin's OMP extension; unchanged when it is already current. */
export async function installOmpCommandSuggest(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  const filePath = resolveOmpCommandSuggestExtensionPath(context.home, context.env);
  const current = await context.fsBridge.readFile(filePath);
  if (current !== null && !current.startsWith(OMP_COMMAND_SUGGEST_EXTENSION_MARKER)) {
    // A file of the same name Resin did not write is the user's; leave it alone.
    throw new Error(`${filePath} exists and is not managed by Resin; refusing to overwrite it`);
  }
  return [
    await writeOwned(
      context.fsBridge,
      filePath,
      expectedExtension(context),
      context.dryRun ?? false,
    ),
  ];
}

/** Removes Resin's OMP extension (only a file Resin wrote). */
export async function uninstallOmpCommandSuggest(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  const filePath = resolveOmpCommandSuggestExtensionPath(context.home, context.env);
  const current = await context.fsBridge.readFile(filePath);
  if (current === null || !current.startsWith(OMP_COMMAND_SUGGEST_EXTENSION_MARKER)) {
    return [{ path: filePath, action: "unchanged" }];
  }
  return [await writeOwned(context.fsBridge, filePath, null, context.dryRun ?? false)];
}

/** True when the installed extension is the one this Resin would write. */
export async function verifyOmpCommandSuggest(
  context: Omit<HarnessInstallContext, "dryRun">,
): Promise<boolean> {
  const filePath = resolveOmpCommandSuggestExtensionPath(context.home, context.env);
  return (await context.fsBridge.readFile(filePath)) === expectedExtension(context);
}

const extension = {
  name: "command suggestions",
  install: installOmpCommandSuggest,
  uninstall: uninstallOmpCommandSuggest,
  verify: verifyOmpCommandSuggest,
  /** The file a foreign rewrite of which should trigger repair (see harness health). */
  watchPaths: (home: string, env: NodeJS.ProcessEnv): readonly string[] => [
    resolveOmpCommandSuggestExtensionPath(home, env),
  ],
};

/** Resin's OMP extension that suggests learned tools as the agent is about to run a command. */
export const ompCommandSuggestExtension: HarnessInstallExtension = extension;
