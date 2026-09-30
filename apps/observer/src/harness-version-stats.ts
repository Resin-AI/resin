import os from "node:os";
import type { LocalDatabaseConnection } from "@resin/db";
import {
  type ConfigFsBridge,
  type HarnessDefinition,
  type HarnessSession,
  UNKNOWN_HARNESS_VERSION,
  defaultFsBridge,
} from "@resin/harness-contracts";
import type { Logger } from "./lifecycle.js";
import type { PipelineProcessResult } from "./normalization/pipeline.js";

/**
 * Local, per-harness-version decode evidence.
 *
 * `testedVersions` are exact recorded-fixture lists, so every auto-updated harness looks
 * "untested" even when Resin decodes its sessions perfectly. The recorder below counts, per
 * (harness id, harness version), how the live capture path decodes real local sessions, so
 * `resin status` can qualify a version from evidence instead of only from fixtures.
 *
 * The recorder is deliberately cheap on the capture hot path: `record` only bumps in-memory
 * counters on a per-session accumulator. Aggregation into SQLite happens in `flush`, on a timer
 * and at shutdown, one UPSERT per session that changed. Nothing ever re-scans events.
 */

/** Aggregate counters, one row per (harness id, harness version). */
export const HARNESS_VERSION_STATS_TABLE = "harness_version_stats";
/** One row per counted session; makes session counting idempotent across daemon restarts. */
export const HARNESS_VERSION_SESSIONS_TABLE = "harness_version_sessions";

const HARNESS_VERSION_STATS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${HARNESS_VERSION_STATS_TABLE} (
  harness_id TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  events_decoded INTEGER NOT NULL DEFAULT 0,
  events_unknown_passthrough INTEGER NOT NULL DEFAULT 0,
  events_unexpected_passthrough INTEGER NOT NULL DEFAULT 0,
  events_dead_lettered INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_results_paired INTEGER NOT NULL DEFAULT 0,
  tool_results_orphan INTEGER NOT NULL DEFAULT 0,
  tool_calls_unpaired INTEGER NOT NULL DEFAULT 0,
  sessions_ok INTEGER NOT NULL DEFAULT 0,
  sessions_failed INTEGER NOT NULL DEFAULT 0,
  unexpected_types_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (harness_id, harness_version)
);
CREATE TABLE IF NOT EXISTS ${HARNESS_VERSION_SESSIONS_TABLE} (
  session_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------------------------
// Thresholds. `classifyHarnessVersionEvidence` is the only consumer.
// ---------------------------------------------------------------------------------------------

/** Cleanly decoded sessions needed before a version is reported as verified. */
export const HARNESS_VERIFIED_MIN_SESSIONS = 5;
/** Decoded events needed before a version is reported as verified. */
export const HARNESS_VERIFIED_MIN_EVENTS = 100;

/** Decoded events needed before the unexpected-passthrough ratio can flag a problem. */
export const HARNESS_PROBLEM_MIN_EVENTS = 50;
/**
 * More than this share of decoded events being unrecognized record types is a decode problem.
 * Healthy versions already pass some records through that the recorded fixtures do not contain;
 * measured on real local sessions that baseline is 10-12% (Claude Code 12%, Codex 10%, OMP 10%),
 * while a version whose record format drifted loses the bulk of its events to passthrough.
 */
export const HARNESS_UNEXPECTED_PASSTHROUGH_MAX_RATIO = 0.25;

/** Tool interactions (calls plus orphan results) needed before pairing can flag a problem. */
export const HARNESS_PROBLEM_MIN_TOOL_INTERACTIONS = 10;
/** More than this share of tool interactions lacking their call or result is a decode problem. */
export const HARNESS_UNPAIRED_TOOL_MAX_RATIO = 0.1;

/** Sessions needed before the failed-session ratio can flag a problem. */
export const HARNESS_PROBLEM_MIN_SESSIONS = 3;
/** More than this share of sessions dead-lettering records is a decode problem. */
export const HARNESS_FAILED_SESSION_MAX_RATIO = 0.2;

/** How often accumulated counters are written to the state store. */
export const HARNESS_STATS_FLUSH_INTERVAL_MS = 30_000;
/** A session untouched this long is dropped from memory; its still-open tool calls count as unpaired. */
export const HARNESS_STATS_SESSION_IDLE_MS = 30 * 60_000;
/** How long an installed-version probe answer is trusted. */
export const HARNESS_INSTALLED_VERSION_TTL_MS = 10 * 60_000;
/** Distinct unexpected record types kept per version, for the "what" of a decode problem. */
export const HARNESS_STATS_MAX_UNEXPECTED_TYPES = 10;

/**
 * Raw record types each adapter deliberately passes through as `unknown_passthrough`. Anything
 * else surfacing as passthrough is a record the decoder no longer understands. The recorded
 * fixture qualification test asserts fixtures surface nothing outside this list.
 */
export const EXPECTED_PASSTHROUGH_RECORD_TYPES: Readonly<Record<string, readonly string[]>> = {
  // Transcript bookkeeping: hook/file attachments, prompt-queue and resume markers, mode
  // switches and hook summaries. None is a prompt, answer or tool step.
  "claude-code": ["attachment", "queue-operation", "atis-latch", "last-prompt", "mode", "system"],
  // Per-model-call usage the next assistant message did not claim.
  "muse-code": ["muse.model_completed"],
  // Session configuration changes and harness-injected reminders that are not user prompts.
  omp: [
    "title",
    "model_change",
    "thinking_level_change",
    "service_tier_change",
    "credential_pin",
    "custom_message",
  ],
  pi: ["model_change", "thinking_level_change", "context_edit", "session_info", "usage"],
};

// ---------------------------------------------------------------------------------------------
// Stored rows and classification (shared by the daemon writer and `resin status` reader)
// ---------------------------------------------------------------------------------------------

export interface HarnessVersionStats {
  harnessId: string;
  harnessVersion: string;
  eventsDecoded: number;
  eventsUnknownPassthrough: number;
  eventsUnexpectedPassthrough: number;
  eventsDeadLettered: number;
  toolCalls: number;
  toolResultsPaired: number;
  toolResultsOrphan: number;
  toolCallsUnpaired: number;
  sessionsOk: number;
  sessionsFailed: number;
  /** Unrecognized raw record types and how often each surfaced. */
  unexpectedTypes: Record<string, number>;
  firstSeenAt: string;
  updatedAt: string;
}

export type HarnessVersionEvidence =
  /** Clean decode on enough local sessions. */
  | { kind: "verified"; sessions: number; events: number }
  /** Decode ratios are high; `problems` says which. */
  | { kind: "problems"; sessions: number; events: number; problems: string[] }
  /** Some stats, but too few to verify or condemn the version. */
  | { kind: "insufficient"; sessions: number; events: number }
  /** No stats for this version. */
  | { kind: "none" };

interface StatsRow {
  harness_id: string;
  harness_version: string;
  events_decoded: number;
  events_unknown_passthrough: number;
  events_unexpected_passthrough: number;
  events_dead_lettered: number;
  tool_calls: number;
  tool_results_paired: number;
  tool_results_orphan: number;
  tool_calls_unpaired: number;
  sessions_ok: number;
  sessions_failed: number;
  unexpected_types_json: string;
  first_seen_at: string;
  updated_at: string;
}

function parseUnexpectedTypes(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function toStats(row: StatsRow): HarnessVersionStats {
  return {
    harnessId: row.harness_id,
    harnessVersion: row.harness_version,
    eventsDecoded: Number(row.events_decoded),
    eventsUnknownPassthrough: Number(row.events_unknown_passthrough),
    eventsUnexpectedPassthrough: Number(row.events_unexpected_passthrough),
    eventsDeadLettered: Number(row.events_dead_lettered),
    toolCalls: Number(row.tool_calls),
    toolResultsPaired: Number(row.tool_results_paired),
    toolResultsOrphan: Number(row.tool_results_orphan),
    toolCallsUnpaired: Number(row.tool_calls_unpaired),
    sessionsOk: Number(row.sessions_ok),
    sessionsFailed: Number(row.sessions_failed),
    unexpectedTypes: parseUnexpectedTypes(row.unexpected_types_json),
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads the stats of one harness version. Null when the version has no row or the store has no
 * stats table yet (a daemon that predates this feature, or one that has decoded nothing).
 */
export function readHarnessVersionStats(
  conn: Pick<LocalDatabaseConnection, "get">,
  harnessId: string,
  harnessVersion: string,
): HarnessVersionStats | null {
  try {
    const row = conn.get<StatsRow>(
      `SELECT * FROM ${HARNESS_VERSION_STATS_TABLE} WHERE harness_id = ? AND harness_version = ?`,
      [harnessId, harnessVersion],
    );
    return row ? toStats(row) : null;
  } catch {
    return null;
  }
}

/**
 * Turns a version's counters into a verdict. A version is only condemned once there is enough
 * volume for a ratio to mean something, and only verified once it has decoded enough sessions
 * and events without tripping any problem threshold.
 */
export function classifyHarnessVersionEvidence(
  stats: HarnessVersionStats | null | undefined,
): HarnessVersionEvidence {
  if (!stats) return { kind: "none" };
  const sessions = stats.sessionsOk + stats.sessionsFailed;
  const events = stats.eventsDecoded;
  if (sessions === 0 && events === 0 && stats.eventsDeadLettered === 0) return { kind: "none" };

  const problems: string[] = [];

  if (
    events >= HARNESS_PROBLEM_MIN_EVENTS &&
    stats.eventsUnexpectedPassthrough / events > HARNESS_UNEXPECTED_PASSTHROUGH_MAX_RATIO
  ) {
    const top = Object.entries(stats.unexpectedTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, count]) => `${type} x${count}`);
    const pct = (stats.eventsUnexpectedPassthrough / events) * 100;
    const shown = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
    const what = top.length > 0 ? ` (${top.join(", ")})` : "";
    problems.push(`${shown}% of events are unrecognized records${what}`);
  }

  const interactions = stats.toolCalls + stats.toolResultsOrphan;
  const unpaired = stats.toolCallsUnpaired + stats.toolResultsOrphan;
  if (
    interactions >= HARNESS_PROBLEM_MIN_TOOL_INTERACTIONS &&
    unpaired / interactions > HARNESS_UNPAIRED_TOOL_MAX_RATIO
  ) {
    problems.push(`${unpaired} of ${interactions} tool calls are unpaired with their result`);
  }

  if (
    sessions >= HARNESS_PROBLEM_MIN_SESSIONS &&
    stats.sessionsFailed / sessions > HARNESS_FAILED_SESSION_MAX_RATIO
  ) {
    problems.push(`${stats.sessionsFailed} of ${sessions} sessions failed to decode`);
  }

  if (problems.length > 0) return { kind: "problems", sessions, events, problems };
  if (stats.sessionsOk >= HARNESS_VERIFIED_MIN_SESSIONS && events >= HARNESS_VERIFIED_MIN_EVENTS) {
    return { kind: "verified", sessions: stats.sessionsOk, events };
  }
  return { kind: "insufficient", sessions, events };
}

// ---------------------------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------------------------

interface Counters {
  decoded: number;
  unknown: number;
  unexpected: number;
  deadLettered: number;
  toolCalls: number;
  paired: number;
  orphan: number;
  unpaired: number;
}

function emptyCounters(): Counters {
  return {
    decoded: 0,
    unknown: 0,
    unexpected: 0,
    deadLettered: 0,
    toolCalls: 0,
    paired: 0,
    orphan: 0,
    unpaired: 0,
  };
}

interface SessionAccumulator {
  harnessId: string;
  /** Pinned once counted; null until the version is resolved. */
  version: string | null;
  failed: boolean;
  openCalls: Set<string>;
  counters: Counters;
  unexpectedTypes: Map<string, number>;
  dirty: boolean;
  lastSeenMs: number;
}

/** Resolves the harness version a session ran under; null when it cannot be established. */
export type HarnessVersionResolver = (harnessId: string) => Promise<string | null>;

export interface HarnessVersionStatsRecorderOptions {
  /** The daemon's shared state connection. Without it nothing is persisted or recorded. */
  conn: Pick<LocalDatabaseConnection, "run" | "get" | "exec">;
  resolveVersion: HarnessVersionResolver;
  logger?: Logger;
  now?: () => number;
  flushIntervalMs?: number;
  sessionIdleMs?: number;
}

function metadataVersion(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.harnessVersion;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Counts, per session, how the normalization pipeline decoded its records and periodically folds
 * the counters into the per-version stats table.
 */
export class HarnessVersionStatsRecorder {
  private readonly conn: HarnessVersionStatsRecorderOptions["conn"];
  private readonly resolveVersion: HarnessVersionResolver;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;
  private readonly sessionIdleMs: number;
  private readonly sessions = new Map<string, SessionAccumulator>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private schemaReady = false;

  constructor(options: HarnessVersionStatsRecorderOptions) {
    this.conn = options.conn;
    this.resolveVersion = options.resolveVersion;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.flushIntervalMs = options.flushIntervalMs ?? HARNESS_STATS_FLUSH_INTERVAL_MS;
    this.sessionIdleMs = options.sessionIdleMs ?? HARNESS_STATS_SESSION_IDLE_MS;
  }

  /**
   * Accounts one pipeline batch. Synchronous and allocation-light: it only touches the session's
   * in-memory accumulator. Duplicates (redelivered records) are not counted twice.
   */
  record(session: HarnessSession, results: readonly PipelineProcessResult[]): void {
    if (results.length === 0) return;
    let acc = this.sessions.get(session.sessionId);
    if (!acc) {
      acc = {
        harnessId: session.harnessId,
        version: null,
        failed: false,
        openCalls: new Set(),
        counters: emptyCounters(),
        unexpectedTypes: new Map(),
        dirty: false,
        lastSeenMs: 0,
      };
      this.sessions.set(session.sessionId, acc);
    }
    const c = acc.counters;
    for (const result of results) {
      if (result.status === "dead_letter") {
        c.deadLettered += 1;
        acc.failed = true;
        continue;
      }
      if (result.isDuplicate) continue;
      const event = result.event;
      c.decoded += 1;
      if (event.type === "unknown_passthrough") {
        c.unknown += 1;
        if (!EXPECTED_PASSTHROUGH_RECORD_TYPES[acc.harnessId]?.includes(event.rawEventType)) {
          c.unexpected += 1;
          acc.unexpectedTypes.set(
            event.rawEventType,
            (acc.unexpectedTypes.get(event.rawEventType) ?? 0) + 1,
          );
        }
      } else if (event.type === "tool_call") {
        c.toolCalls += 1;
        acc.openCalls.add(event.callId);
      } else if (event.type === "tool_result") {
        if (acc.openCalls.delete(event.callId)) c.paired += 1;
        else c.orphan += 1;
      }
    }
    if (acc.version === null) acc.version = metadataVersion(session.metadata);
    acc.dirty = true;
    acc.lastSeenMs = this.now();
  }

  /** Starts periodic flushing. The timer never keeps the daemon alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  /** Stops periodic flushing and persists what is pending. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  /** Folds pending counters into the state store. Never throws; failed writes are retried. */
  flush(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.flushNow()).catch(() => undefined);
    return this.inFlight;
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.conn.exec(HARNESS_VERSION_STATS_SCHEMA_SQL);
    this.schemaReady = true;
  }

  private async flushNow(): Promise<void> {
    try {
      this.ensureSchema();
    } catch (error) {
      this.logger?.warn("Harness version stats store unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const nowMs = this.now();
    const evict: string[] = [];
    for (const [sessionId, acc] of this.sessions) {
      if (acc.dirty || nowMs - acc.lastSeenMs <= this.sessionIdleMs) continue;
      // An idle session is over: calls that never got a result are unpaired for good.
      acc.counters.unpaired += acc.openCalls.size;
      acc.openCalls.clear();
      acc.dirty = acc.counters.unpaired > 0;
      evict.push(sessionId);
    }
    for (const [sessionId, acc] of this.sessions) {
      if (!acc.dirty) continue;
      try {
        await this.persistSession(sessionId, acc);
      } catch (error) {
        this.logger?.warn("Harness version stats write failed; will retry", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const sessionId of evict) {
      const acc = this.sessions.get(sessionId);
      if (acc && !acc.dirty) this.sessions.delete(sessionId);
    }
  }

  private async persistSession(sessionId: string, acc: SessionAccumulator): Promise<void> {
    let version = acc.version;
    if (version === null) {
      version = await this.resolveVersion(acc.harnessId).catch(() => null);
      version = version?.trim() || UNKNOWN_HARNESS_VERSION;
    }
    const nowIso = new Date(this.now()).toISOString();
    let sessionsOk = 0;
    let sessionsFailed = 0;

    const existing = this.conn.get<{ harness_version: string; failed: number }>(
      `SELECT harness_version, failed FROM ${HARNESS_VERSION_SESSIONS_TABLE} WHERE session_id = ?`,
      [sessionId],
    );
    if (existing === null) {
      this.conn.run(
        `INSERT OR IGNORE INTO ${HARNESS_VERSION_SESSIONS_TABLE}
           (session_id, harness_id, harness_version, failed, first_seen_at) VALUES (?, ?, ?, ?, ?)`,
        [sessionId, acc.harnessId, version, acc.failed ? 1 : 0, nowIso],
      );
      if (acc.failed) sessionsFailed = 1;
      else sessionsOk = 1;
    } else {
      // A session stays under the version it was first counted with, across daemon restarts.
      version = existing.harness_version;
      if (acc.failed && Number(existing.failed) === 0) {
        this.conn.run(
          `UPDATE ${HARNESS_VERSION_SESSIONS_TABLE} SET failed = 1 WHERE session_id = ?`,
          [sessionId],
        );
        sessionsOk = -1;
        sessionsFailed = 1;
      }
    }

    const previous = this.conn.get<{ unexpected_types_json: string }>(
      `SELECT unexpected_types_json FROM ${HARNESS_VERSION_STATS_TABLE}
         WHERE harness_id = ? AND harness_version = ?`,
      [acc.harnessId, version],
    );
    const unexpectedTypes = parseUnexpectedTypes(previous?.unexpected_types_json);
    for (const [type, count] of acc.unexpectedTypes) {
      unexpectedTypes[type] = (unexpectedTypes[type] ?? 0) + count;
    }
    const capped = Object.fromEntries(
      Object.entries(unexpectedTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, HARNESS_STATS_MAX_UNEXPECTED_TYPES),
    );

    const c = acc.counters;
    this.conn.run(
      `INSERT INTO ${HARNESS_VERSION_STATS_TABLE} (
         harness_id, harness_version, events_decoded, events_unknown_passthrough,
         events_unexpected_passthrough, events_dead_lettered, tool_calls, tool_results_paired,
         tool_results_orphan, tool_calls_unpaired, sessions_ok, sessions_failed,
         unexpected_types_json, first_seen_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_id, harness_version) DO UPDATE SET
         events_decoded = events_decoded + excluded.events_decoded,
         events_unknown_passthrough = events_unknown_passthrough + excluded.events_unknown_passthrough,
         events_unexpected_passthrough =
           events_unexpected_passthrough + excluded.events_unexpected_passthrough,
         events_dead_lettered = events_dead_lettered + excluded.events_dead_lettered,
         tool_calls = tool_calls + excluded.tool_calls,
         tool_results_paired = tool_results_paired + excluded.tool_results_paired,
         tool_results_orphan = tool_results_orphan + excluded.tool_results_orphan,
         tool_calls_unpaired = tool_calls_unpaired + excluded.tool_calls_unpaired,
         sessions_ok = sessions_ok + excluded.sessions_ok,
         sessions_failed = sessions_failed + excluded.sessions_failed,
         unexpected_types_json = excluded.unexpected_types_json,
         updated_at = excluded.updated_at`,
      [
        acc.harnessId,
        version,
        c.decoded,
        c.unknown,
        c.unexpected,
        c.deadLettered,
        c.toolCalls,
        c.paired,
        c.orphan,
        c.unpaired,
        sessionsOk,
        sessionsFailed,
        JSON.stringify(capped),
        nowIso,
        nowIso,
      ],
    );

    // Only after both writes landed: a failed write leaves the counters to be retried.
    acc.version = version;
    acc.counters = emptyCounters();
    acc.unexpectedTypes = new Map();
    acc.dirty = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Installed-version resolution
// ---------------------------------------------------------------------------------------------

export interface InstalledVersionResolverOptions {
  definitions: readonly HarnessDefinition[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  fsBridge?: ConfigFsBridge;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Resolves a harness's version from the installed harness (the same probe `resin status` uses),
 * cached per harness so the probe, which may run the harness's `--version`, stays off the capture
 * path. It only applies to sessions whose adapter reports no `metadata.harnessVersion` of its own.
 */
export function createInstalledVersionResolver(
  options: InstalledVersionResolverOptions,
): HarnessVersionResolver {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const ttlMs = options.ttlMs ?? HARNESS_INSTALLED_VERSION_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { version: string | null; at: number }>();
  const probes = new Map<string, Promise<string | null>>();

  const probe = async (harnessId: string): Promise<string | null> => {
    const definition = options.definitions.find((candidate) => candidate.id === harnessId);
    if (!definition) return null;
    try {
      const installation = await definition.probeInstallation({
        targetPath: definition.mcpConfig.resolvePath(home, env),
        home,
        env,
        fsBridge,
      });
      const version = installation?.version?.trim();
      return version && version !== UNKNOWN_HARNESS_VERSION ? version : null;
    } catch {
      return null;
    }
  };

  return async (harnessId) => {
    const cached = cache.get(harnessId);
    if (cached && now() - cached.at < ttlMs) return cached.version;
    let pending = probes.get(harnessId);
    if (!pending) {
      pending = probe(harnessId).then((version) => {
        cache.set(harnessId, { version, at: now() });
        probes.delete(harnessId);
        return version;
      });
      probes.set(harnessId, pending);
    }
    return pending;
  };
}
