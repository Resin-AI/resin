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

/** Claude Code's hook event Resin registers for command-time suggestions, and the tool it matches. */
export const CLAUDE_COMMAND_SUGGEST_EVENT = "PreToolUse";
export const CLAUDE_COMMAND_SUGGEST_MATCHER = "Bash";
/** Claude Code's hook event Resin registers for prompt-time suggestions (it takes no matcher). */
export const CLAUDE_PROMPT_SUGGEST_EVENT = "UserPromptSubmit";
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

/** `launch` (`… suggest --harness claude-code`) in prompt mode: `… suggest --prompt --harness …`. */
export function promptSuggestLaunch(launch: ResinMcpLaunch): ResinMcpLaunch {
  const at = launch.args.lastIndexOf("suggest");
  if (at < 0) return { command: launch.command, args: [...launch.args, "--prompt"] };
  return {
    command: launch.command,
    args: [...launch.args.slice(0, at + 1), "--prompt", ...launch.args.slice(at + 1)],
  };
}

/**
 * Resin's hook commands, whichever Resin home or launcher they name: a `resin`/`resin.mjs` entry
 * run as `suggest --harness claude-code` (command time) or `suggest --prompt --harness
 * claude-code` (prompt time).
 */
const RESIN_SUGGEST_COMMAND = /resin(?:\.mjs)?['"]?\s+suggest\s+--harness\s+claude-code\s*$/u;
const RESIN_PROMPT_SUGGEST_COMMAND =
  /resin(?:\.mjs)?['"]?\s+suggest\s+--prompt\s+--harness\s+claude-code\s*$/u;

/** User settings: only `hooks` is read; every other key is carried through unchanged. */
const ClaudeSettingsSchema = z.object({ hooks: z.record(z.unknown()).optional() }).passthrough();
type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;
/** One matcher group of a hook event. */
const HookGroupSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(z.unknown()) })
  .passthrough();
type HookGroup = z.infer<typeof HookGroupSchema>;
const HookCommandSchema = z.object({ command: z.string() }).passthrough();

/** One hook Resin registers: the event, its matcher (if any), and how Resin's command looks. */
interface ResinHookSpec {
  readonly event: string;
  readonly matcher?: string;
  readonly pattern: RegExp;
}

const COMMAND_HOOK: ResinHookSpec = {
  event: CLAUDE_COMMAND_SUGGEST_EVENT,
  matcher: CLAUDE_COMMAND_SUGGEST_MATCHER,
  pattern: RESIN_SUGGEST_COMMAND,
};
const PROMPT_HOOK: ResinHookSpec = {
  event: CLAUDE_PROMPT_SUGGEST_EVENT,
  pattern: RESIN_PROMPT_SUGGEST_COMMAND,
};

/** The commands Resin's hooks run. */
export interface ClaudeSuggestCommands {
  /** `… suggest --harness claude-code`, the PreToolUse Bash hook. */
  readonly command: string;
  /** `… suggest --prompt --harness claude-code`, the UserPromptSubmit hook. */
  readonly prompt: string;
}

/** The hook's command when it is one of Resin's hooks of `spec`'s kind. */
function resinHookCommand(hook: unknown, spec: ResinHookSpec): string | undefined {
  const parsed = HookCommandSchema.safeParse(hook);
  return parsed.success && spec.pattern.test(parsed.data.command) ? parsed.data.command : undefined;
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
 * `hooks` with Resin's hook of `spec`'s kind present exactly once (`install`, running `command`)
 * or removed. Every other hook and matcher group is kept in order; a group left empty by the
 * removal is dropped, as is an event left with no group. A value that is not a list is left alone
 * on removal and refused on install.
 */
function editHookEvent(
  hooks: Record<string, unknown>,
  spec: ResinHookSpec,
  command: string,
  install: boolean,
): void {
  const existing = hooks[spec.event];
  if (existing !== undefined && !Array.isArray(existing)) {
    if (install) {
      throw new Error(
        `Claude Code settings hooks.${spec.event} is not a list; refusing to rewrite it`,
      );
    }
    return;
  }
  const groups: unknown[] = [];
  for (const group of existing ?? []) {
    const parsed = HookGroupSchema.safeParse(group);
    if (!parsed.success) {
      groups.push(group);
      continue;
    }
    const kept = parsed.data.hooks.filter((hook) => resinHookCommand(hook, spec) === undefined);
    if (kept.length === parsed.data.hooks.length) groups.push(group);
    // SAFETY: validated above; spreading the original keeps the group's key order.
    else if (kept.length > 0) groups.push({ ...(group as HookGroup), hooks: kept });
  }
  if (install) {
    groups.push({
      ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
      hooks: [{ type: "command", command, timeout: CLAUDE_COMMAND_SUGGEST_TIMEOUT_SECONDS }],
    });
  }
  if (groups.length > 0) hooks[spec.event] = groups;
  else delete hooks[spec.event];
}

/**
 * The settings document with Resin's two hooks present exactly once each (`install`): the
 * PreToolUse Bash hook (command-time suggestions) and the UserPromptSubmit hook (prompt-time
 * suggestions); or with every Resin suggestion hook removed. Hooks are additive: every other
 * setting, hook and matcher group is preserved in order.
 */
export function editClaudeSettingsDocument(
  doc: ClaudeSettings,
  commands: ClaudeSuggestCommands,
  install: boolean,
): ClaudeSettings {
  const hooks: Record<string, unknown> = { ...doc.hooks };
  editHookEvent(hooks, COMMAND_HOOK, commands.command, install);
  editHookEvent(hooks, PROMPT_HOOK, commands.prompt, install);
  const next: ClaudeSettings = { ...doc, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

function expectedCommands(
  context: Pick<HarnessInstallContext, "home" | "env">,
): ClaudeSuggestCommands {
  const launch = resolveResinSuggestLaunch(context.home, context.env, "claude-code");
  return {
    command: renderClaudeCommandSuggestCommand(launch),
    prompt: renderClaudeCommandSuggestCommand(promptSuggestLaunch(launch)),
  };
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
  const next = editClaudeSettingsDocument(doc, expectedCommands(context), install);
  if (JSON.stringify(next) === JSON.stringify(doc) && current !== null) {
    return { path: settingsPath, action: "unchanged" };
  }
  const action = current === null ? "created" : install ? "updated" : "removed";
  // Settings that held nothing but Resin's hooks go away with them, so uninstall leaves no file
  // (and no directory) Resin created behind.
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

/**
 * Registers `resin suggest --harness claude-code` as a PreToolUse hook for Bash and
 * `resin suggest --prompt --harness claude-code` as a UserPromptSubmit hook.
 */
export async function installClaudeCommandSuggest(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  return [await syncSettings(context, true)];
}

/** Removes Resin's suggestion hooks; every other setting stays as it was. */
export async function uninstallClaudeCommandSuggest(
  context: HarnessInstallContext,
): Promise<ManagedBlockResult[]> {
  return [await syncSettings(context, false)];
}

/** Whether `doc` runs exactly one Resin hook of `spec`'s kind, this Resin's, under its matcher. */
function hasExactlyOne(doc: ClaudeSettings, spec: ResinHookSpec, command: string): boolean {
  const groups = doc.hooks?.[spec.event];
  if (!Array.isArray(groups)) return false;
  let found = 0;
  for (const group of groups) {
    const parsed = HookGroupSchema.safeParse(group);
    if (!parsed.success) continue;
    for (const hook of parsed.data.hooks) {
      const hookCommand = resinHookCommand(hook, spec);
      if (hookCommand === undefined) continue;
      if (parsed.data.matcher !== spec.matcher || hookCommand !== command) return false;
      found += 1;
    }
  }
  return found === 1;
}

/** True when settings run each of this Resin's suggestion hooks exactly once. */
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
  const commands = expectedCommands(context);
  return (
    hasExactlyOne(doc, COMMAND_HOOK, commands.command) &&
    hasExactlyOne(doc, PROMPT_HOOK, commands.prompt)
  );
}

/**
 * Resin's Claude Code hooks that suggest learned tools when the user submits a prompt and after
 * a command a learned tool is a close fit for.
 */
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
