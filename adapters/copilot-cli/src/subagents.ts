import * as fs from "node:fs/promises";

/**
 * Copilot writes a subagent's whole run into its parent's `session-state/<id>/events.jsonl`: each
 * of its events carries the subagent's top-level `agentId`, framed by `subagent.started` /
 * `subagent.completed` / `subagent.failed` lines that carry the same `agentId` plus the `task`
 * tool call (`data.toolCallId`) that spawned it. There is no separate file or session id, so the
 * adapter exposes every subagent as its own linked session over that shared file and routes each
 * line to exactly one session, the one that owns it.
 */

const READ_CHUNK_BYTES = 1024 * 1024;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A line can belong to a subagent only when it names an `agentId` (cheap pre-parse check). */
export function mayCarryAgentId(line: string): boolean {
  return line.includes('"agentId"');
}

/**
 * Decides which agent owns each event line: `undefined` is the main agent, a string is a
 * subagent's `agentId`. Lines must be fed in file order so a subagent's spawning tool call is
 * known when its `subagent.started` line arrives.
 *
 * - An agent's own events belong to it.
 * - A subagent's lifecycle lines (`started`/`completed`/`failed`) belong to its spawner, the agent
 *   that ran the `task` tool call: the main agent, or the subagent whose tool call it was.
 */
export class CopilotAgentRouter {
  /** `toolCallId` -> the subagent that ran it (calls of the main agent are not recorded). */
  private readonly toolRunners = new Map<string, string>();
  /** Subagent id -> the subagent that spawned it (`undefined` when the main agent did). */
  private readonly spawners = new Map<string, string | undefined>();

  route(record: Record<string, unknown>): string | undefined {
    const agentId = asString(record.agentId);
    const data = asRecord(record.data);
    switch (record.type) {
      case "tool.execution_start": {
        const toolCallId = asString(data?.toolCallId);
        if (agentId && toolCallId) this.toolRunners.set(toolCallId, agentId);
        return agentId;
      }
      case "subagent.started": {
        const toolCallId = asString(data?.toolCallId);
        const spawner = toolCallId ? this.toolRunners.get(toolCallId) : undefined;
        if (agentId) this.spawners.set(agentId, spawner);
        return spawner;
      }
      case "subagent.completed":
      case "subagent.failed":
        return agentId ? this.spawners.get(agentId) : undefined;
      default:
        return agentId;
    }
  }
}

/**
 * Feeds every complete line of `filePath` from byte `from` to `to` (default: end of file) to
 * `onLine` and returns the offset just past the last complete line consumed.
 */
async function forEachCompleteLine(
  filePath: string,
  from: number,
  to: number | undefined,
  onLine: (line: string) => void,
): Promise<number> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return from;
  try {
    const end = Math.min(to ?? Number.POSITIVE_INFINITY, (await handle.stat()).size);
    let consumed = from;
    let position = from;
    let pending = Buffer.alloc(0);
    while (position < end) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, end - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline = pending.indexOf(0x0a);
      while (newline !== -1) {
        onLine(pending.subarray(0, newline).toString("utf8"));
        consumed += newline + 1;
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(0x0a);
      }
    }
    return consumed;
  } finally {
    await handle.close();
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Teaches a fresh router everything before `offset`, for a source that resumes mid-file. */
export async function primeCopilotAgentRouter(
  router: CopilotAgentRouter,
  filePath: string,
  offset: number,
): Promise<void> {
  await forEachCompleteLine(filePath, 0, offset, (line) => {
    if (!mayCarryAgentId(line)) return;
    const record = parseLine(line);
    if (record) router.route(record);
  });
}

/** One subagent run found in a parent's `events.jsonl`. */
export interface CopilotSubagent {
  readonly agentId: string;
  /** The subagent that spawned this one; absent when the main agent did. */
  readonly parentAgentId?: string;
  /** The `task` tool call that started it. */
  readonly toolCallId?: string;
  /** Agent type (`explore`, `task`, …): `data.agentType`, else `data.agentName`. */
  readonly agentType?: string;
  readonly agentDisplayName?: string;
  readonly agentDescription?: string;
  readonly model?: string;
  readonly startedAt?: string;
  readonly lastEventAt?: string;
  /** Absent while the subagent is still running. */
  readonly outcome?: "completed" | "failed";
}

interface SubagentScan {
  offset: number;
  router: CopilotAgentRouter;
  agents: Map<string, CopilotSubagent>;
}

/** Incremental scans keyed by events file: an appended log is read from where it was left. */
const scans = new Map<string, SubagentScan>();

/**
 * Subagent runs recorded in a Copilot `events.jsonl`, in start order. Rescans only the bytes
 * appended since the previous call for the same file.
 */
export async function listCopilotSubagents(eventsPath: string): Promise<CopilotSubagent[]> {
  const size = await fs
    .stat(eventsPath)
    .then((stat) => stat.size)
    .catch(() => null);
  if (size === null) return [];
  let scan = scans.get(eventsPath);
  if (!scan || size < scan.offset) {
    scan = { offset: 0, router: new CopilotAgentRouter(), agents: new Map() };
    scans.set(eventsPath, scan);
  }
  const state = scan;
  state.offset = await forEachCompleteLine(eventsPath, state.offset, undefined, (line) => {
    if (!mayCarryAgentId(line)) return;
    const record = parseLine(line);
    if (!record) return;
    const spawner = state.router.route(record);
    const agentId = asString(record.agentId);
    if (!agentId) return;
    const timestamp = asString(record.timestamp);
    const data = asRecord(record.data);
    const known = state.agents.get(agentId);
    switch (record.type) {
      case "subagent.started":
        state.agents.set(agentId, {
          ...known,
          agentId,
          ...(spawner ? { parentAgentId: spawner } : {}),
          ...optional("toolCallId", asString(data?.toolCallId)),
          ...optional("agentType", asString(data?.agentType) ?? asString(data?.agentName)),
          ...optional("agentDisplayName", asString(data?.agentDisplayName)),
          ...optional("agentDescription", asString(data?.agentDescription)),
          ...optional("model", asString(data?.model)),
          ...optional("startedAt", timestamp),
          ...optional("lastEventAt", timestamp),
        });
        return;
      case "subagent.completed":
      case "subagent.failed":
        if (known) {
          state.agents.set(agentId, {
            ...known,
            outcome: record.type === "subagent.completed" ? "completed" : "failed",
            ...optional("lastEventAt", timestamp),
          });
        }
        return;
      default:
        // Events of a subagent whose start line is missing are not attributable to a session.
        if (known && timestamp) state.agents.set(agentId, { ...known, lastEventAt: timestamp });
    }
  });
  return [...state.agents.values()];
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}
