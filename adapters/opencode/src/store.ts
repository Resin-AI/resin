import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * OpenCode session info in its canonical JSON shape (the legacy `storage/session` file and the
 * `info` payload of `session.*` events). SQLite rows are converted to this shape.
 */
export interface OpencodeSessionInfo {
  id: string;
  projectID?: string;
  parentID?: string;
  directory: string;
  title?: string;
  version?: string;
  time: { created: number; updated: number; compacting?: number; archived?: number };
  [key: string]: unknown;
}

export interface OpencodeMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | string;
  time: { created: number; completed?: number };
  [key: string]: unknown;
}

export interface OpencodePart {
  id: string;
  messageID: string;
  sessionID: string;
  type: string;
  [key: string]: unknown;
}

export interface OpencodeMessageWithParts {
  info: OpencodeMessageInfo;
  parts: OpencodePart[];
}

export interface OpencodeSessionSnapshot {
  session: OpencodeSessionInfo;
  messages: OpencodeMessageWithParts[];
}

/** One row of the SQLite `event` log (OpenCode's append-only per-session sync log). */
export interface OpencodeStoredEvent {
  seq: number;
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export type OpencodeStoreKind = "sqlite" | "legacy-json";

/** Read-only view over one OpenCode storage backend. */
export interface OpencodeStore {
  readonly kind: OpencodeStoreKind;
  /** Database file or storage directory. */
  readonly location: string;
  listSessions(): OpencodeSessionInfo[];
  readSession(sessionId: string): OpencodeSessionSnapshot | null;
  /**
   * Events for one session with `seq > afterSeq`, oldest first, or `null` when this backend
   * has no event log (legacy tree, or a SQLite store predating it).
   */
  readEvents(sessionId: string, afterSeq: number): OpencodeStoredEvent[] | null;
}

function parseJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type Row = Record<string, unknown>;

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionFromRow(row: Row): OpencodeSessionInfo {
  const info: OpencodeSessionInfo = {
    id: String(row.id),
    slug: str(row.slug),
    projectID: str(row.project_id),
    workspaceID: str(row.workspace_id),
    parentID: str(row.parent_id),
    directory: String(row.directory ?? ""),
    title: str(row.title),
    version: str(row.version),
    agent: str(row.agent),
    model: row.model ? parseJsonObject(row.model) : undefined,
    cost: num(row.cost),
    tokens: {
      input: num(row.tokens_input) ?? 0,
      output: num(row.tokens_output) ?? 0,
      reasoning: num(row.tokens_reasoning) ?? 0,
      cache: { read: num(row.tokens_cache_read) ?? 0, write: num(row.tokens_cache_write) ?? 0 },
    },
    time: {
      created: num(row.time_created) ?? 0,
      updated: num(row.time_updated) ?? 0,
      compacting: num(row.time_compacting),
      archived: num(row.time_archived),
    },
  };
  for (const key of Object.keys(info)) {
    if (info[key] === undefined) delete info[key];
  }
  return info;
}

/**
 * Read-only access to OpenCode's SQLite store (1.2+), safe next to a live WAL writer.
 *
 * Every read opens the database with `readOnly`, runs its statements, and closes it, so Resin
 * never holds a write lock, never keeps a long-lived read snapshot that would pin the WAL
 * against checkpoints, and never runs recovery or schema changes. In WAL mode readers only
 * take a shared read mark in the `-shm` index; they never block OpenCode's writer.
 */
export class OpencodeSqliteStore implements OpencodeStore {
  readonly kind = "sqlite" as const;

  constructor(readonly location: string) {}

  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.location, { readOnly: true, timeout: 2000 });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  listSessions(): OpencodeSessionInfo[] {
    return this.withDb((db) =>
      (db.prepare("SELECT * FROM session ORDER BY time_created, id").all() as Row[]).map(
        sessionFromRow,
      ),
    );
  }

  readSession(sessionId: string): OpencodeSessionSnapshot | null {
    return this.withDb((db) => {
      const row = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) as
        | Row
        | undefined;
      if (!row) return null;
      const byMessage = new Map<string, OpencodePart[]>();
      const parts = db
        .prepare(
          "SELECT id, message_id, session_id, data FROM part WHERE session_id = ? ORDER BY id",
        )
        .all(sessionId) as Row[];
      for (const part of parts) {
        const messageId = String(part.message_id);
        const list = byMessage.get(messageId) ?? [];
        list.push({
          ...parseJsonObject(part.data),
          id: String(part.id),
          messageID: messageId,
          sessionID: sessionId,
        } as OpencodePart);
        byMessage.set(messageId, list);
      }
      const messages = (
        db
          .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY id")
          .all(sessionId) as Row[]
      ).map((message) => ({
        info: {
          ...parseJsonObject(message.data),
          id: String(message.id),
          sessionID: sessionId,
        } as OpencodeMessageInfo,
        parts: byMessage.get(String(message.id)) ?? [],
      }));
      return { session: sessionFromRow(row), messages };
    });
  }

  readEvents(sessionId: string, afterSeq: number): OpencodeStoredEvent[] | null {
    return this.withDb((db) => {
      const hasEvents = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event'")
        .get();
      if (!hasEvents) return null;
      return (
        db
          .prepare(
            "SELECT id, seq, type, data FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq",
          )
          .all(sessionId, afterSeq) as Row[]
      ).map((row) => ({
        id: String(row.id),
        seq: num(row.seq) ?? 0,
        type: String(row.type),
        data: parseJsonObject(row.data),
      }));
    });
  }
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const value = parseJsonObject(fs.readFileSync(file, "utf8"));
    return Object.keys(value).length > 0 ? value : null;
  } catch {
    return null;
  }
}

function listJsonFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Read-only access to the pre-1.2 JSON storage tree:
 * `storage/session/<projectID>/<sessionID>.json`, `storage/message/<sessionID>/<messageID>.json`,
 * `storage/part/<messageID>/<partID>.json`. Files are written whole; a half-written file fails
 * to parse and is skipped until the next read.
 */
export class OpencodeLegacyStore implements OpencodeStore {
  readonly kind = "legacy-json" as const;

  constructor(readonly location: string) {}

  listSessions(): OpencodeSessionInfo[] {
    const sessionRoot = path.join(this.location, "session");
    let projects: string[] = [];
    try {
      projects = fs
        .readdirSync(sessionRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const sessions: OpencodeSessionInfo[] = [];
    for (const project of projects) {
      for (const file of listJsonFiles(path.join(sessionRoot, project))) {
        const info = readJsonFile(file);
        if (info && typeof info.id === "string") {
          sessions.push(info as OpencodeSessionInfo);
        }
      }
    }
    return sessions.sort(
      (a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || a.id.localeCompare(b.id),
    );
  }

  readSession(sessionId: string): OpencodeSessionSnapshot | null {
    const session = this.listSessions().find((info) => info.id === sessionId);
    if (!session) return null;
    const messages: OpencodeMessageWithParts[] = [];
    for (const file of listJsonFiles(path.join(this.location, "message", sessionId))) {
      const info = readJsonFile(file);
      if (!info || typeof info.id !== "string") continue;
      const parts = listJsonFiles(path.join(this.location, "part", info.id))
        .map(readJsonFile)
        .filter(
          (part): part is Record<string, unknown> => part !== null && typeof part.id === "string",
        )
        .map((part) => part as OpencodePart);
      messages.push({ info: info as OpencodeMessageInfo, parts });
    }
    return { session, messages };
  }

  readEvents(): null {
    return null;
  }
}

/**
 * Opens the backend OpenCode is using: the SQLite store when it exists, otherwise the legacy
 * JSON tree, otherwise `null`.
 */
export function openOpencodeStore(options: {
  dbPath: string;
  legacyStorageDir: string;
}): OpencodeStore | null {
  if (fs.existsSync(options.dbPath)) {
    return new OpencodeSqliteStore(options.dbPath);
  }
  if (fs.existsSync(path.join(options.legacyStorageDir, "session"))) {
    return new OpencodeLegacyStore(options.legacyStorageDir);
  }
  return null;
}
