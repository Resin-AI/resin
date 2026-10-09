/**
 * Prompt-time suggestions: when the user submits a prompt, before the agent starts work, a compact
 * block naming this repository's learned tools (name, one-line purpose, a ready call), those
 * relevant to the prompt first. The first prompt of a harness session gets the whole block; later
 * prompts only the tools relevant to them, and nothing when none is.
 *
 * Relevance is scored on this machine from the prompt's words against each tool's name, purpose
 * and command words in the local index. The prompt text is never sent anywhere, never logged and
 * never stored: the only state kept is a hash of the session id and when its block was shown.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type CommandSuggestPathOptions,
  type SuggestTool,
  commandSuggestDisabledPath,
  commandSuggestIndexPath,
  readRepositoryTools,
  resolveCommandSuggestDir,
  writePrivateFileAtomic,
} from "./index-file.js";
import { type SuggestHarness, callExample, invokeHow } from "./render.js";
import { type RepositoryIdentityResolver, repositoryIdentity } from "./repository-identity.js";
import { suggestionsDisabledByEnv } from "./suggest.js";

export interface PromptSuggestRequest {
  readonly prompt: string;
  /** The session's working directory. */
  readonly cwd: string;
  readonly harness: SuggestHarness;
  /** The harness session, so the full block is shown once per session. */
  readonly sessionId?: string;
}

export interface PromptSuggestOptions extends CommandSuggestPathOptions {
  readonly repositoryIdentity?: RepositoryIdentityResolver;
  readonly now?: Date;
}

export interface PromptSuggestion {
  /** The block the agent is shown. */
  readonly text: string;
  /** Names of the tools listed, in order. */
  readonly tools: readonly string[];
  /** Whether this is the session's full block (every tool) or only the prompt's relevant ones. */
  readonly full: boolean;
}

/** Most tools one block lists. */
export const MAX_PROMPT_TOOLS = 8;
/** Longest block, in characters. */
export const MAX_PROMPT_BLOCK_CHARS = 800;
/** Longest prompt scored; the rest is ignored. */
const MAX_PROMPT_CHARS = 20_000;
/** Longest purpose shown per tool. */
const PURPOSE_CHARS = 90;
/** Sessions whose full block is remembered, most recent first. */
const MAX_TRACKED_SESSIONS = 200;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Words that say nothing about which tool fits. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "the and for with that this from into onto your you our are was were will would could should " +
    "can cannot please make sure then than them they what when where which while who why how " +
    "all any some each every not but also just only use using used run runs running ran tool " +
    "tools learned resin want need let lets have has had been being its it's there here about " +
    "again more most very really now new get got give see look like one two out off over under " +
    "after before same other first last next file files code fix fixes"
  ).split(" "),
);

/** A word reduced to a comparable stem: lowercase, a plural or verb ending dropped. */
function stem(word: string): string {
  const lower = word.toLowerCase();
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (lower.endsWith(suffix) && lower.length - suffix.length >= 3) {
      return lower.slice(0, -suffix.length);
    }
  }
  return lower;
}

/** The distinct meaningful stems of a text. */
export function wordStems(text: string): Set<string> {
  const stems = new Set<string>();
  for (const word of text.split(/[^A-Za-z0-9]+/u)) {
    if (word.length < 3 || STOPWORDS.has(word.toLowerCase())) continue;
    const stemmed = stem(word);
    if (!STOPWORDS.has(stemmed)) stems.add(stemmed);
  }
  return stems;
}

/**
 * How relevant `tool` is to a prompt's stems: two points per stem in its name or the commands it
 * runs, one per stem only in its purpose. Zero or one point is not relevant.
 */
export function promptRelevance(promptStems: ReadonlySet<string>, tool: SuggestTool): number {
  const strong = wordStems(
    [tool.name, ...tool.commands, ...(tool.steps ?? []).flatMap((step) => step.commands)].join(" "),
  );
  const weak = wordStems(tool.purpose ?? "");
  let score = 0;
  for (const word of promptStems) {
    if (strong.has(word)) score += 2;
    else if (weak.has(word)) score += 1;
  }
  return score;
}

/** Minimum relevance for a tool to count as relevant to a prompt. */
export const PROMPT_RELEVANCE_THRESHOLD = 2;

interface Ranked {
  readonly tool: SuggestTool;
  readonly score: number;
}

/** Tools ordered by relevance to the prompt, then by name. */
export function rankForPrompt(prompt: string, tools: readonly SuggestTool[]): Ranked[] {
  const stems = wordStems(prompt.slice(0, MAX_PROMPT_CHARS));
  return tools
    .map((tool) => ({ tool, score: promptRelevance(stems, tool) }))
    .sort((a, b) =>
      a.score !== b.score
        ? b.score - a.score
        : a.tool.name < b.tool.name
          ? -1
          : a.tool.name > b.tool.name
            ? 1
            : 0,
    );
}

function shortPurpose(purpose: string | undefined): string {
  if (purpose === undefined) return "";
  return purpose.length > PURPOSE_CHARS
    ? `${purpose.slice(0, PURPOSE_CHARS - 1).trimEnd()}…`
    : purpose;
}

/**
 * The block for `tools` (already ordered), within {@link MAX_PROMPT_TOOLS} and
 * {@link MAX_PROMPT_BLOCK_CHARS}; undefined when not one tool fits.
 */
export function renderPromptBlock(
  tools: readonly SuggestTool[],
  harness: SuggestHarness,
  full: boolean,
  limit: number = MAX_PROMPT_BLOCK_CHARS,
): { text: string; tools: string[] } | undefined {
  const how = invokeHow(harness, "<call>");
  const header = full
    ? `Resin learned tools for this repository (to run one, ${how}):`
    : `Resin learned tools that may fit this prompt (to run one, ${how}):`;
  const lines: string[] = [];
  const shown: string[] = [];
  let length = header.length;
  for (const [index, tool] of tools.slice(0, MAX_PROMPT_TOOLS).entries()) {
    const purpose = shortPurpose(tool.purpose);
    const line = `- ${callExample(tool)}${purpose.length === 0 ? "" : ` — ${purpose}`}`;
    const left = tools.length - index - 1;
    // Room for this line and, if anything is left after it, the "+N more" note.
    const footer = left > 0 ? `\n(+${left} more; search_tools finds them)`.length : 0;
    if (length + 1 + line.length + footer > limit) break;
    lines.push(line);
    shown.push(tool.name);
    length += 1 + line.length;
  }
  if (lines.length === 0) return undefined;
  const more = tools.length - shown.length;
  const text = [
    header,
    ...lines,
    ...(more > 0 ? [`(+${more} more; search_tools finds them)`] : []),
  ].join("\n");
  return { text, tools: shown };
}

interface PromptSessionRecord {
  at: number;
}

function promptSessionsPath(dir: string): string {
  return path.join(dir, "prompt-sessions.json");
}

function readPromptSessions(dir: string): Record<string, PromptSessionRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(promptSessionsPath(dir), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const sessions: Record<string, PromptSessionRecord> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue;
    const at = "at" in value ? value.at : undefined;
    if (typeof at === "number") sessions[key] = { at };
  }
  return sessions;
}

/** Session ids are kept only as a hash. */
function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/** Whether the session was already shown its full block. */
function fullBlockShown(dir: string, sessionId: string, now: Date): boolean {
  const record = readPromptSessions(dir)[sessionKey(sessionId)];
  return record !== undefined && now.getTime() - record.at < SESSION_TTL_MS;
}

/** Records that the session was shown its full block. Best effort. */
function markFullBlockShown(dir: string, sessionId: string, now: Date): void {
  const sessions = readPromptSessions(dir);
  sessions[sessionKey(sessionId)] = { at: now.getTime() };
  const kept = Object.entries(sessions)
    .filter(([, value]) => now.getTime() - value.at < SESSION_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_TRACKED_SESSIONS);
  try {
    writePrivateFileAtomic(
      promptSessionsPath(dir),
      `${JSON.stringify(Object.fromEntries(kept))}\n`,
    );
  } catch {
    // An unwritable state directory only means the full block may be shown again.
  }
}

function exists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The block for one submitted prompt, or undefined. Never throws. */
export function suggestForPrompt(
  request: PromptSuggestRequest,
  options: PromptSuggestOptions = {},
): PromptSuggestion | undefined {
  try {
    const env = options.env ?? process.env;
    if (suggestionsDisabledByEnv(env) || request.cwd.length === 0) return undefined;
    const dir = resolveCommandSuggestDir(options);
    if (exists(commandSuggestDisabledPath(dir)) || !exists(commandSuggestIndexPath(dir))) {
      return undefined;
    }
    const identity = (options.repositoryIdentity ?? repositoryIdentity)(request.cwd);
    if (identity === undefined) return undefined;
    const tools = readRepositoryTools(dir, identity.id);
    if (tools === undefined || tools.length === 0) return undefined;
    const now = options.now ?? new Date();
    const sessionId =
      request.sessionId !== undefined && request.sessionId.length > 0
        ? request.sessionId
        : undefined;
    const full = sessionId === undefined || !fullBlockShown(dir, sessionId, now);
    const ranked = rankForPrompt(request.prompt, tools);
    const listed = full
      ? ranked.map((entry) => entry.tool)
      : ranked
          .filter((entry) => entry.score >= PROMPT_RELEVANCE_THRESHOLD)
          .map((entry) => entry.tool);
    const block = renderPromptBlock(listed, request.harness, full);
    if (block === undefined) return undefined;
    if (full && sessionId !== undefined) markFullBlockShown(dir, sessionId, now);
    return { text: block.text, tools: block.tools, full };
  } catch {
    return undefined;
  }
}
