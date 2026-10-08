/**
 * The per-command suggestion: given the shell command an agent is about to run and where, the one
 * line naming the learned tool in that repository that already runs it, or nothing. Reads only
 * local files (the index `resin mcp` keeps, an opt-out marker, per-session suppression state) and
 * spawns only `git` to identify the repository; never touches the network, never logs, and never
 * records the command text anywhere.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type CommandSuggestPathOptions,
  commandSuggestDisabledPath,
  commandSuggestIndexPath,
  readRepositoryTools,
  resolveCommandSuggestDir,
  writePrivateFileAtomic,
} from "./index-file.js";
import { matchCommand } from "./match.js";
import { type SuggestHarness, renderSuggestion } from "./render.js";
import { type RepositoryIdentityResolver, repositoryIdentity } from "./repository-identity.js";

export interface SuggestRequest {
  readonly command: string;
  /** Directory the command runs in. */
  readonly cwd: string;
  readonly harness: SuggestHarness;
  /** The harness session, so one tool is not suggested over and over in one session. */
  readonly sessionId?: string;
}

export interface SuggestOptions extends CommandSuggestPathOptions {
  readonly repositoryIdentity?: RepositoryIdentityResolver;
  readonly now?: Date;
}

export interface Suggestion {
  readonly line: string;
  readonly tool: string;
}

/** The same tool is suggested at most this many times per harness session. */
export const MAX_SUGGESTIONS_PER_TOOL_PER_SESSION = 2;
/** Sessions whose suppression state is kept, most recent first. */
const MAX_TRACKED_SESSIONS = 200;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/** `RESIN_COMMAND_SUGGEST=0|off|false|no` turns suggestions off for one process tree. */
export function suggestionsDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.RESIN_COMMAND_SUGGEST?.trim().toLowerCase();
  return value === "0" || value === "off" || value === "false" || value === "no";
}

function exists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

interface SessionRecord {
  at: number;
  tools: Record<string, number>;
}

function sessionsPath(dir: string): string {
  return path.join(dir, "sessions.json");
}

function readSessions(dir: string): Record<string, SessionRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionsPath(dir), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const sessions: Record<string, SessionRecord> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue;
    const at = "at" in value ? value.at : undefined;
    const tools = "tools" in value ? value.tools : undefined;
    if (typeof at !== "number" || typeof tools !== "object" || tools === null) continue;
    const counts: Record<string, number> = {};
    for (const [tool, count] of Object.entries(tools)) {
      if (typeof count === "number") counts[tool] = count;
    }
    sessions[key] = { at, tools: counts };
  }
  return sessions;
}

/** Session ids are kept only as a hash. */
function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/**
 * Whether `tool` may be suggested again in `sessionId`; when it may, the showing is counted.
 * Suppression state that cannot be read or written never blocks a suggestion.
 */
function admitInSession(dir: string, sessionId: string, tool: string, now: Date): boolean {
  const sessions = readSessions(dir);
  const key = sessionKey(sessionId);
  const record = sessions[key] ?? { at: now.getTime(), tools: {} };
  const shown = record.tools[tool] ?? 0;
  if (shown >= MAX_SUGGESTIONS_PER_TOOL_PER_SESSION) return false;
  record.tools[tool] = shown + 1;
  record.at = now.getTime();
  sessions[key] = record;
  const kept = Object.entries(sessions)
    .filter(([, value]) => now.getTime() - value.at < SESSION_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_TRACKED_SESSIONS);
  try {
    writePrivateFileAtomic(sessionsPath(dir), `${JSON.stringify(Object.fromEntries(kept))}\n`);
  } catch {
    // Best effort: an unwritable state directory only loses repeat suppression.
  }
  return true;
}

const LEADING_CD = /^\s*cd\s+(?:"([^"$`\\]+)"|'([^']+)'|([^\s;&|<>()$`'"\\~]+))\s*(?:&&|;)/u;

/**
 * Where a command runs: a leading `cd <dir> &&` (or `;`) moves it, so `cd ../other-repo && vitest`
 * is matched against the other repository's tools. A directory that does not exist, or one named
 * through an expansion, leaves `cwd` as it is.
 */
export function effectiveCommandDirectory(command: string, cwd: string): string {
  const match = LEADING_CD.exec(command);
  const target = match?.[1] ?? match?.[2] ?? match?.[3];
  if (target === undefined) return cwd;
  const resolved = path.resolve(cwd, target);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : cwd;
  } catch {
    return cwd;
  }
}

/** The suggestion for one command, or undefined. Never throws. */
export function suggestForCommand(
  request: SuggestRequest,
  options: SuggestOptions = {},
): Suggestion | undefined {
  try {
    const env = options.env ?? process.env;
    if (suggestionsDisabledByEnv(env)) return undefined;
    const command = request.command.trim();
    if (command.length === 0 || request.cwd.length === 0) return undefined;
    const dir = resolveCommandSuggestDir(options);
    // Both checks are a stat; they keep `git` from being spawned when nothing could match.
    if (exists(commandSuggestDisabledPath(dir)) || !exists(commandSuggestIndexPath(dir))) {
      return undefined;
    }
    const identity = (options.repositoryIdentity ?? repositoryIdentity)(
      effectiveCommandDirectory(command, request.cwd),
    );
    if (identity === undefined) return undefined;
    const tools = readRepositoryTools(dir, identity.id);
    if (tools === undefined || tools.length === 0) return undefined;
    const match = matchCommand(command, tools);
    if (match === undefined) return undefined;
    const now = options.now ?? new Date();
    if (
      request.sessionId !== undefined &&
      request.sessionId.length > 0 &&
      !admitInSession(dir, request.sessionId, match.tool.name, now)
    ) {
      return undefined;
    }
    return { line: renderSuggestion(match, request.harness), tool: match.tool.name };
  } catch {
    return undefined;
  }
}

/** Turns suggestions off (`enabled: false`) or back on for this Resin home. */
export function setCommandSuggestionsEnabled(
  enabled: boolean,
  options: CommandSuggestPathOptions = {},
): void {
  const marker = commandSuggestDisabledPath(resolveCommandSuggestDir(options));
  if (enabled) {
    fs.rmSync(marker, { force: true });
  } else {
    writePrivateFileAtomic(
      marker,
      "Resin command suggestions are off; run `resin suggest --enable` to turn them back on.\n",
    );
  }
}

/** Whether suggestions are on for this Resin home (the environment switch aside). */
export function commandSuggestionsEnabled(options: CommandSuggestPathOptions = {}): boolean {
  return !exists(commandSuggestDisabledPath(resolveCommandSuggestDir(options)));
}
