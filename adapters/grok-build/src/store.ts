import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeGrokCwd } from "./paths.js";

/**
 * On-disk Grok session store (grok-build `xai-grok-shell::session::storage::jsonl`):
 * `<GROK_HOME>/sessions/<percent-encoded cwd>/<session uuid>/` holding
 * - `updates.jsonl`: append-only ACP `session/update` + `_x.ai/session/update` stream shared by the
 *   TUI, headless (`grok -p`) and ACP (`grok agent stdio`). Resin captures this file. Rewinds only
 *   append a `rewind_marker`; compaction only appends markers.
 * - `chat_history.jsonl`: the model conversation, rewritten in place on compaction and rewind, so
 *   it is not tailable.
 * - `summary.json`: metadata (`session_kind`, `parent_session_id` for forks, model, timestamps).
 * - `subagents/<child id>/meta.json` in the parent: links subagent child sessions to the parent.
 */
export interface GrokSessionSummary {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly sessionKind?: string;
  readonly parentSessionId?: string;
  readonly forkedAt?: string;
  readonly modelId?: string;
  readonly agentName?: string;
}

export interface GrokSessionEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly updatesPath: string;
  readonly summary: GrokSessionSummary | null;
  readonly updatesMtime: Date;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function readGrokSessionSummary(
  sessionDir: string,
): Promise<GrokSessionSummary | null> {
  const raw = asRecord(await readJson(path.join(sessionDir, "summary.json")));
  const info = asRecord(raw?.info);
  const sessionId = asString(info?.id);
  const cwd = asString(info?.cwd);
  if (!raw || !sessionId || !cwd) return null;
  return {
    sessionId,
    cwd,
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.last_active_at) ?? asString(raw.updated_at),
    sessionKind: asString(raw.session_kind),
    parentSessionId: asString(raw.parent_session_id),
    forkedAt: asString(raw.forked_at),
    modelId: asString(raw.current_model_id),
    agentName: asString(raw.agent_name),
  };
}

/** Project directories under `sessions/`, keyed by the cwd they encode. */
export async function listGrokProjects(
  sessionsDir: string,
): Promise<Array<{ cwd: string; dir: string }>> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: Array<{ cwd: string; dir: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cwd = decodeGrokCwd(entry.name);
    if (cwd) projects.push({ cwd, dir: path.join(sessionsDir, entry.name) });
  }
  return projects.sort((a, b) => a.cwd.localeCompare(b.cwd));
}

export async function listGrokSessions(
  projectDir: string,
  cwd: string,
): Promise<GrokSessionEntry[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: GrokSessionEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(projectDir, entry.name);
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    let updatesMtime: Date;
    try {
      updatesMtime = (await fs.stat(updatesPath)).mtime;
    } catch {
      continue;
    }
    const summary = await readGrokSessionSummary(sessionDir);
    sessions.push({
      sessionId: summary?.sessionId ?? entry.name,
      cwd: summary?.cwd ?? cwd,
      sessionDir,
      updatesPath,
      summary,
      updatesMtime,
    });
  }
  return sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/**
 * Parent links of subagent child sessions, read from each parent's `subagents/<id>/meta.json`.
 * Child `summary.json` files do not name their parent.
 */
export async function readGrokSubagentParents(
  sessions: readonly GrokSessionEntry[],
): Promise<Map<string, string>> {
  const parents = new Map<string, string>();
  for (const session of sessions) {
    let children: string[];
    try {
      children = await fs.readdir(path.join(session.sessionDir, "subagents"));
    } catch {
      continue;
    }
    for (const child of children) {
      const meta = asRecord(
        await readJson(path.join(session.sessionDir, "subagents", child, "meta.json")),
      );
      const childSessionId = asString(meta?.child_session_id) ?? child;
      parents.set(childSessionId, asString(meta?.parent_session_id) ?? session.sessionId);
    }
  }
  return parents;
}

interface PromptTurn {
  readonly key: string | null;
  promptId: string | null;
  endOffset: number;
}

function parseUpdate(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(asRecord(asRecord(JSON.parse(line))?.params)?.update);
  } catch {
    return undefined;
  }
}

/** `promptIndex` + text of a real (non slash-command) user prompt chunk, else null. */
function userPromptKey(update: Record<string, unknown>): string | null {
  if (update.sessionUpdate !== "user_message_chunk") return null;
  const meta = asRecord(update._meta);
  if (meta?.hostTurn === true) return null;
  const text = asString(asRecord(update.content)?.text) ?? "";
  return `${String(meta?.promptIndex ?? "")}\u0000${text}`;
}

/** Splits an updates.jsonl body into prompt turns with their end byte offsets. */
function splitTurns(content: string): PromptTurn[] {
  const turns: PromptTurn[] = [];
  const totalBytes = Buffer.byteLength(content, "utf8");
  let offset = 0;
  let current: PromptTurn | null = null;
  for (const line of content.split("\n")) {
    const lineEnd = offset + Buffer.byteLength(line, "utf8") + 1;
    offset = lineEnd;
    // A trailing line without a newline is still being written.
    if (lineEnd > totalBytes) break;
    const update = parseUpdate(line);
    if (!update) {
      if (current) current.endOffset = lineEnd;
      continue;
    }
    const key = userPromptKey(update);
    if (key !== null && (current === null || current.promptId !== null || current.key !== key)) {
      current = { key, promptId: null, endOffset: lineEnd };
      turns.push(current);
      continue;
    }
    if (current === null) {
      current = { key: null, promptId: null, endOffset: lineEnd };
      turns.push(current);
    }
    current.endOffset = lineEnd;
    if (update.sessionUpdate === "turn_completed") {
      current.promptId = asString(update.prompt_id) ?? null;
    }
  }
  return turns;
}

const TAIL_READ_BYTES = 64 * 1024;

/**
 * Whether the last prompt in an `updates.jsonl` is still running: a real user prompt appears after
 * the last `turn_completed`. A headless (`grok -p`) run need not appear in `active_sessions.json`,
 * so this is its live signal. Reads backwards from the end and stops at the first decisive line.
 */
export async function isGrokTurnOpen(updatesPath: string): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(updatesPath, "r");
  } catch {
    return false;
  }
  try {
    let end = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - TAIL_READ_BYTES);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      end = start;
      let block = Buffer.concat([chunk, carry]);
      let newline = block.lastIndexOf(0x0a, block.length - 1);
      // The first (partial) line of this block is completed by the next read.
      while (newline >= 0) {
        const decision = turnDecision(block.subarray(newline + 1).toString("utf8"));
        if (decision !== undefined) return decision;
        block = block.subarray(0, newline);
        newline = block.lastIndexOf(0x0a, block.length - 1);
      }
      carry = block;
    }
    return turnDecision(carry.toString("utf8")) ?? false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function turnDecision(line: string): boolean | undefined {
  if (!line.trim()) return undefined;
  const update = parseUpdate(line);
  if (!update) return undefined;
  if (update.sessionUpdate === "turn_completed") return false;
  return userPromptKey(update) !== null ? true : undefined;
}

/**
 * Byte offset where a forked session's own history starts in its `updates.jsonl`.
 *
 * `--fork-session` and `/fork` copy the parent's (rewind-filtered) update stream into the new
 * session before its first own prompt. Those copied turns were already captured from the parent,
 * so capture starts after the longest prefix of turns the parent also has: a completed turn
 * matches by `turn_completed.prompt_id`; an interrupted one by its prompt index and text.
 * A missing parent yields 0, so an orphaned fork is captured in full.
 */
export async function computeGrokForkPrefixOffset(
  forkUpdatesPath: string,
  parentUpdatesPath: string,
): Promise<number> {
  let parentContent: string;
  let forkContent: string;
  try {
    [parentContent, forkContent] = await Promise.all([
      fs.readFile(parentUpdatesPath, "utf8"),
      fs.readFile(forkUpdatesPath, "utf8"),
    ]);
  } catch {
    return 0;
  }
  const parentTurns = splitTurns(parentContent);
  const parentPromptIds = new Set(parentTurns.flatMap((turn) => turn.promptId ?? []));
  const parentKeys = new Set(parentTurns.flatMap((turn) => turn.key ?? []));
  let offset = 0;
  for (const turn of splitTurns(forkContent)) {
    const inherited =
      turn.promptId !== null
        ? parentPromptIds.has(turn.promptId)
        : turn.key !== null && parentKeys.has(turn.key);
    if (!inherited) break;
    offset = turn.endOffset;
  }
  return offset;
}
