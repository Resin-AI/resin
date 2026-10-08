import path from "node:path";
import {
  type HarnessInstallContext,
  type HarnessInstallExtension,
  type ManagedBlockResult,
  type ResinMcpLaunch,
  readHostPathEnv,
  resolveResinSuggestLaunch,
} from "@resin/harness-contracts";
import { z } from "zod";

/** Claude Code's hook event Resin registers for, and the tool it matches. */
export const CLAUDE_COMMAND_SUGGEST_EVENT = "PreToolUse";
export const CLAUDE_COMMAND_SUGGEST_MATCHER = "Bash";
/** Seconds Claude Code waits for the hook; `resin suggest` answers in well under one. */
export const CLAUDE_COMMAND_SUGGEST_TIMEOUT_SECONDS = 5;

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `<home>/.claude/settings.json` (user settings). */
export function resolveClaudeSettingsPath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(
    readHostPathEnv(env, "CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude"),
    "settings.json",
  );
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The shell command Claude Code runs for the hook. */
export function renderClaudeCommandSuggestCommand(
  launch: ResinMcpLaunch,
  platform: NodeJS.Platform = process.platform,
): string {
  const word = (value: string) =>
    /^[A-Za-z0-9_-]+$/u.test(value) ? value : shellQuote(value, platform);
  return [shellQuote(launch.command, platform), ...launch.args.map(word)].join(" ");
}

/**
 * Resin's hook commands, whichever Resin home or launcher they name: a `resin`/`resin.mjs` entry
 * run as `suggest --harness claude-code`.
 */
const RESIN_SUGGEST_COMMAND = /resin(?:\.mjs)?['"]?\s+suggest\s+--harness\s+claude-code\s*$/u;

/** User settings: only `hooks` is read; every other key is carried through unchanged. */
const ClaudeSettingsSchema = z.object({ hooks: z.record(z.unknown()).optional() }).passthrough();
type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;
/** One matcher group of a hook event. */
const HookGroupSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(z.unknown()) })
  .passthrough();
type HookGroup = z.infer<typeof HookGroupSchema>;
const HookCommandSchema = z.object({ command: z.string() }).passthrough();

/** The hook's command when it is one of Resin's suggestion hooks. */
function resinHookCommand(hook: unknown): string | undefined {
  const parsed = HookCommandSchema.safeParse(hook);
  return parsed.success && RESIN_SUGGEST_COMMAND.test(parsed.data.command)
    ? parsed.data.command
    : undefined;
}

function parseSettings(content: string | null, filePath: string): ClaudeSettings {
  if (content === null || content.trim().length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`Claude Code settings ${filePath} is not valid JSON; refusing to rewrite it`, {
      cause: error,
    });
  }
  const parsed = ClaudeSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Claude Code settings ${filePath} has an unexpected shape; refusing to rewrite it`,
    );
  }
  // SAFETY: validated above; the raw object is kept so the user's key order survives a rewrite.
  return raw as ClaudeSettings;
}

/**
 * The settings document with Resin's PreToolUse Bash hook present exactly once (`install`) or with
 * every Resin suggestion hook removed. Every other setting, hook and matcher group is preserved in
 * order; a group left empty by the removal is dropped, as is a `hooks` object left empty.
 */
export function editClaudeSettingsDocument(
  doc: ClaudeSettings,
  command: string,
  install: boolean,
): ClaudeSettings {
  const hooks: Record<string, unknown> = { ...doc.hooks };
  const existing = hooks[CLAUDE_COMMAND_SUGGEST_EVENT];
  // A non-array value is not a shape Resin understands; leave it for the user.
  if (existing !== undefined && !Array.isArray(existing)) {
    if (install) {
      throw new Error(
        `Claude Code settings hooks.${CLAUDE_COMMAND_SUGGEST_EVENT} is not a list; refusing to rewrite it`,
      );
    }
    return doc;
  }
  const groups: unknown[] = [];
  for (const group of existing ?? []) {
    const parsed = HookGroupSchema.safeParse(group);
    if (!parsed.success) {
      groups.push(group);
      continue;
    }
    const kept = parsed.data.hooks.filter((hook) => resinHookCommand(hook) === undefined);
    if (kept.length === parsed.data.hooks.length) groups.push(group);
    // SAFETY: validated above; spreading the original keeps the group's key order.
    else if (kept.length > 0) groups.push({ ...(group as HookGroup), hooks: kept });
  }
  if (install) {
    groups.push({
      matcher: CLAUDE_COMMAND_SUGGEST_MATCHER,
      hooks: [{ type: "command", command, timeout: CLAUDE_COMMAND_SUGGEST_TIMEOUT_SECONDS }],
    });
  }
  if (groups.length > 0) hooks[CLAUDE_COMMAND_SUGGEST_EVENT] = groups;
  else delete hooks[CLAUDE_COMMAND_SUGGEST_EVENT];
  const next: ClaudeSettings = { ...doc, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

function expectedCommand(context: Pick<HarnessInstallContext, "home" | "env">): string {
  return renderClaudeCommandSuggestCommand(
    resolveResinSuggestLaunch(context.home, context.env, "claude-code"),
  );
}

/** Backup written next to settings before Resin changes them. */
export function claudeSettingsBackupPath(settingsPath: string, now: number = Date.now()): string {
  return `${settingsPath}.resin-backup.${now}.bak`;
}

async function syncSettings(
  context: HarnessInstallContext,
  install: boolean,
): Promise<ManagedBlockResult> {
  const settingsPath = resolveClaudeSettingsPath(context.home, context.env);
  const current = await context.fsBridge.readFile(settingsPath);
  if (current === null && !install) return { path: settingsPath, action: "unchanged" };
  const doc = parseSettings(current, settingsPath);
  const next = editClaudeSettingsDocument(doc, expectedCommand(context), install);
  if (JSON.stringify(next) === JSON.stringify(doc) && current !== null) {
    return { path: settingsPath, action: "unchanged" };
  }
  const action = current === null ? "created" : install ? "updated" : "removed";
  // Settings that held nothing but Resin's hook go away with it, so uninstall leaves no file (and
  // no directory) Resin created behind.
  if (!install && Object.keys(next).length === 0) {
    if (context.dryRun !== true) await context.fsBridge.unlink(settingsPath);
    return { path: settingsPath, action };
  }
  if (context.dryRun !== true) {
    if (current !== null) {
      // Settings can hold credentials (`env`, `apiKeyHelper`); the backup is private.
      await context.fsBridge.writeFile(claudeSettingsBackupPath(settingsPath), current, {
        mode: 0o600,
      });
    } else {
      await context.fsBridge.mkdirp(path.dirname(settingsPath));
    }
    await context.fsBridge.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { path: settingsPath, action };
}

/** Registers `resin suggest --harness claude-code` as a PreToolUse hook for Bash. */
export async function installClaudeCommandSuggest(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  return [await syncSettings(context, true)];
}

/** Removes Resin's suggestion hook; every other setting stays as it was. */
export async function uninstallClaudeCommandSuggest(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  return [await syncSettings(context, false)];
}

/** True when settings run this Resin's suggestion hook for Bash exactly once. */
export async function verifyClaudeCommandSuggest(
  context: Omit<HarnessInstallContext, "dryRun">,
): Promise<boolean> {
  const settingsPath = resolveClaudeSettingsPath(context.home, context.env);
  let doc: ClaudeSettings;
  try {
    doc = parseSettings(await context.fsBridge.readFile(settingsPath), settingsPath);
  } catch {
    return false;
  }
  const command = expectedCommand(context);
  const groups = doc.hooks?.[CLAUDE_COMMAND_SUGGEST_EVENT];
  if (!Array.isArray(groups)) return false;
  let found = 0;
  for (const group of groups) {
    const parsed = HookGroupSchema.safeParse(group);
    if (!parsed.success) continue;
    for (const hook of parsed.data.hooks) {
      const hookCommand = resinHookCommand(hook);
      if (hookCommand === undefined) continue;
      if (parsed.data.matcher !== CLAUDE_COMMAND_SUGGEST_MATCHER || hookCommand !== command) {
        return false;
      }
      found += 1;
    }
  }
  return found === 1;
}

/** Resin's Claude Code hook that suggests learned tools as the agent is about to run a command. */
export const claudeCommandSuggestExtension: HarnessInstallExtension = {
  name: "command suggestions",
  install: installClaudeCommandSuggest,
  uninstall: uninstallClaudeCommandSuggest,
  verify: verifyClaudeCommandSuggest,
  /** The file a foreign rewrite of which should trigger repair (see harness health). */
  watchPaths: (home: string, env: NodeJS.ProcessEnv): readonly string[] => [
    resolveClaudeSettingsPath(home, env),
  ],
};
