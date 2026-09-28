import path from "node:path";
import type {
  ConfigFsBridge,
  HarnessInstallContext,
  HarnessInstallExtension,
  ManagedBlockAction,
  ManagedBlockResult,
} from "@resin/harness-contracts";
import { isRecord } from "./guards.js";
import { resolveCursorHookScriptPath, resolveCursorHooksPath } from "./paths.js";

/**
 * Hook events Resin observes. All are observe-only: the script never prints a response, and
 * cursor-agent only blocks on an explicit `continue: false` / `permission: "deny"`, so Resin
 * never changes what the harness allows. `preToolUse`, `beforeShellExecution`,
 * `beforeMCPExecution` and `beforeReadFile` (permission gates) are deliberately absent, as are
 * `afterShellExecution`/`afterMCPExecution`, which duplicate `postToolUse`.
 */
export const CURSOR_CAPTURE_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "afterAgentThought",
  "afterAgentResponse",
  "postToolUse",
  "postToolUseFailure",
  "afterFileEdit",
  "preCompact",
  "subagentStart",
  "subagentStop",
  "stop",
] as const;

export const CURSOR_HOOK_TIMEOUT_SECONDS = 10;

/**
 * The capture hook. Reads one hook payload from stdin and appends it, stamped with
 * `resin_received_at` and without `user_email`, to
 * `<resin home>/capture/cursor-cli/<conversation_id>.jsonl`. One `appendFileSync` per
 * payload is a single O_APPEND write, so concurrent hooks never interleave lines. It prints
 * nothing and always exits 0: a capture failure never affects the Cursor session.
 */
export const CURSOR_HOOK_SCRIPT = `#!/usr/bin/env node
// Resin capture hook for Cursor CLI. Managed by Resin (\`resin init\` / \`resin uninstall\`); edits are overwritten.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const chunks = [];
try {
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    delete payload.user_email;
    const rawId = [payload.conversation_id, payload.session_id].find(
      (value) => typeof value === "string" && value.length > 0,
    );
    const fileId = (rawId ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
    const spool = join(dirname(fileURLToPath(import.meta.url)), "..", "capture", "cursor-cli");
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(spool, \`\${fileId}.jsonl\`),
      \`\${JSON.stringify({ resin_received_at: new Date().toISOString(), ...payload })}\\n\`,
      { mode: 0o600 },
    );
  }
} catch {
  // Capture is best effort; never fail the harness.
}
`;

/**
 * Shell-quotes a path for the hook command. cursor-agent runs hook commands through `sh` on POSIX
 * and through PowerShell on Windows, whose single-quoted strings escape `'` by doubling it.
 */
function shellQuote(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderCursorHookCommand(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `node ${shellQuote(scriptPath, platform)}`;
}

type JsonRecord = Record<string, unknown>;

/**
 * Resin's entries are recognized by the script basename, so moved Resin homes are cleaned too.
 * Either separator matches: the command embeds a host path, which uses backslashes on Windows.
 */
const RESIN_HOOK_SCRIPT_SUFFIX = /[\\/]\.resin[\\/]hooks[\\/]cursor-capture\.mjs/;

function isResinHookEntry(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    typeof entry.command === "string" &&
    RESIN_HOOK_SCRIPT_SUFFIX.test(entry.command)
  );
}

function parseHooksDocument(content: string | null, filePath: string): JsonRecord {
  if (content === null || content.trim().length === 0) return { version: 1, hooks: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Cursor hooks config ${filePath} is not valid JSON; refusing to rewrite it`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || (parsed.hooks !== undefined && !isRecord(parsed.hooks))) {
    throw new Error(
      `Cursor hooks config ${filePath} has an unexpected shape; refusing to rewrite it`,
    );
  }
  return { ...parsed, hooks: { ...(parsed.hooks ?? {}) } };
}

/**
 * Returns the hooks document with Resin's entry present exactly once per capture event
 * (`install`) or with every Resin entry removed (`!install`). Other hooks are preserved in order.
 */
export function editCursorHooksDocument(
  doc: JsonRecord,
  command: string,
  install: boolean,
): JsonRecord {
  const hooks = { ...(doc.hooks as JsonRecord) };
  const captureEvents: readonly string[] = CURSOR_CAPTURE_HOOK_EVENTS;
  for (const event of new Set([...Object.keys(hooks), ...(install ? captureEvents : [])])) {
    const existing = hooks[event];
    // A non-array value is not a shape Resin understands; leave it for the user.
    if (existing !== undefined && !Array.isArray(existing)) continue;
    const entries = existing ?? [];
    const others = entries.filter((entry) => !isResinHookEntry(entry));
    const next =
      install && captureEvents.includes(event)
        ? [...others, { command, timeout: CURSOR_HOOK_TIMEOUT_SECONDS }]
        : others;
    if (next.length === 0 && entries.length > 0) delete hooks[event];
    else if (next.length > 0) hooks[event] = next;
  }
  return { ...doc, version: doc.version ?? 1, hooks };
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

async function syncHooksFile(
  context: HarnessInstallContext,
  install: boolean,
): Promise<ManagedBlockResult> {
  const hooksPath = resolveCursorHooksPath(context.home);
  const command = renderCursorHookCommand(resolveCursorHookScriptPath(context.home, context.env));
  const current = await context.fsBridge.readFile(hooksPath);
  if (!install && current === null) return { path: hooksPath, action: "unchanged" };
  const next = editCursorHooksDocument(parseHooksDocument(current, hooksPath), command, install);
  const emptied =
    !install && Object.keys(next.hooks as JsonRecord).length === 0 && Object.keys(next).length <= 2;
  const rendered = emptied ? null : `${JSON.stringify(next, null, 2)}\n`;
  if (
    current !== null &&
    rendered !== null &&
    JSON.stringify(JSON.parse(current)) === JSON.stringify(next)
  ) {
    return { path: hooksPath, action: "unchanged" };
  }
  return writeOwned(context.fsBridge, hooksPath, rendered, context.dryRun ?? false);
}

/** Installs the capture script and registers it for every capture event in `~/.cursor/hooks.json`. */
export async function installCursorCaptureHooks(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  const scriptPath = resolveCursorHookScriptPath(context.home, context.env);
  const script = await writeOwned(
    context.fsBridge,
    scriptPath,
    CURSOR_HOOK_SCRIPT,
    context.dryRun ?? false,
  );
  return [script, await syncHooksFile(context, true)];
}

/** Removes Resin's hook entries (other hooks untouched) and the capture script. Spooled captures stay. */
export async function uninstallCursorCaptureHooks(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  const hooks = await syncHooksFile(context, false);
  const scriptPath = resolveCursorHookScriptPath(context.home, context.env);
  return [hooks, await writeOwned(context.fsBridge, scriptPath, null, context.dryRun ?? false)];
}

/** True when the script is current and every capture event runs it exactly once. */
export async function verifyCursorCaptureHooks(
  context: Omit<HarnessInstallContext, "dryRun">,
): Promise<boolean> {
  const scriptPath = resolveCursorHookScriptPath(context.home, context.env);
  if ((await context.fsBridge.readFile(scriptPath)) !== CURSOR_HOOK_SCRIPT) return false;
  const hooksPath = resolveCursorHooksPath(context.home);
  let doc: JsonRecord;
  try {
    doc = parseHooksDocument(await context.fsBridge.readFile(hooksPath), hooksPath);
  } catch {
    return false;
  }
  const command = renderCursorHookCommand(scriptPath);
  const hooks = doc.hooks as JsonRecord;
  return CURSOR_CAPTURE_HOOK_EVENTS.every((event) => {
    const entries = hooks[event];
    return (
      Array.isArray(entries) &&
      entries.filter((entry) => isRecord(entry) && entry.command === command).length === 1
    );
  });
}

export const cursorCaptureHooksExtension: HarnessInstallExtension = {
  name: "Cursor capture hooks",
  install: installCursorCaptureHooks,
  uninstall: uninstallCursorCaptureHooks,
  verify: verifyCursorCaptureHooks,
};
