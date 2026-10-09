import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ErrorReporterLike,
  type EventProperties,
  getErrorReporter,
} from "./error-reporting/facade.js";

/**
 * The learned-tool discovery funnel: how often agents search Resin, see tools, read a schema, are
 * offered a tool for a command they ran or a prompt they were given, call one, or ask for a tool
 * that is not offered in their repository. Counts only, per UTC day: never a query, a command, a
 * prompt, a tool name or an argument.
 *
 * Every process that serves discovery (the MCP gateway, the `resin suggest` hook) keeps its own
 * counts for the day and writes them to its own shard, `<stateDir>/discovery-funnel/<day>.<pid>.<token>.json`,
 * so concurrent processes never contend for one file. Readers sum the shards. Once a day has ended,
 * one process claims it (an exclusive `<day>.sent` marker) and sends its totals as one
 * `discovery_funnel_daily` usage event through the process-wide error reporter, which applies the
 * usual consent and opt-out rules. A day that ends while reporting is opted out is marked skipped
 * and never sent later.
 *
 * This module imports only Node built-ins and the dependency-free reporting facade, so short-lived
 * hook processes can load it cheaply. Nothing here throws or writes to standard output.
 */

/** What a process records. `tools_listed` counts tools, the rest count occurrences. */
export type DiscoveryFunnelEvent =
  | "search"
  | "search_with_results"
  | "tools_listed"
  | "schema_read"
  | "suggestion_shown"
  | "prompt_suggestion_shown"
  | "invocation_succeeded"
  | "invocation_failed"
  | "unavailable_here";

/** The reported and displayed count names, one per {@link DiscoveryFunnelEvent}. */
export type DiscoveryFunnelCounter =
  | "searches"
  | "searches_with_results"
  | "tools_listed"
  | "schema_reads"
  | "suggestions_shown"
  | "prompt_suggestions_shown"
  | "invocations_succeeded"
  | "invocations_failed"
  | "unavailable_here";

export type DiscoveryFunnelCounts = Record<DiscoveryFunnelCounter, number>;

export const DISCOVERY_FUNNEL_COUNTER_FOR_EVENT: Readonly<
  Record<DiscoveryFunnelEvent, DiscoveryFunnelCounter>
> = {
  search: "searches",
  search_with_results: "searches_with_results",
  tools_listed: "tools_listed",
  schema_read: "schema_reads",
  suggestion_shown: "suggestions_shown",
  prompt_suggestion_shown: "prompt_suggestions_shown",
  invocation_succeeded: "invocations_succeeded",
  invocation_failed: "invocations_failed",
  unavailable_here: "unavailable_here",
};

export const DISCOVERY_FUNNEL_COUNTERS: readonly DiscoveryFunnelCounter[] = [
  "searches",
  "searches_with_results",
  "tools_listed",
  "schema_reads",
  "suggestions_shown",
  "prompt_suggestions_shown",
  "invocations_succeeded",
  "invocations_failed",
  "unavailable_here",
];

/** The usage event that carries one finished day's totals. */
export const DISCOVERY_FUNNEL_EVENT = "discovery_funnel_daily";
export const DISCOVERY_FUNNEL_DIRECTORY = "discovery-funnel";
/** A process writes its counts this long after the last change (and synchronously at exit). */
export const DISCOVERY_FUNNEL_FLUSH_DELAY_MS = 2_000;
/** A day is reported this long after it ends, so late writes from running processes land first. */
export const DISCOVERY_FUNNEL_REPORT_GRACE_MS = 60 * 60_000;
/** Days older than this are never sent: they ended while no process was there to report them. */
export const DISCOVERY_FUNNEL_REPORT_WINDOW_DAYS = 7;
/** Shards and markers are deleted once their day is this old. */
export const DISCOVERY_FUNNEL_RETENTION_DAYS = 30;
/** How often a long-lived process looks for finished days to report. */
const REPORT_CHECK_INTERVAL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHARD_PATTERN = /^(\d{4}-\d{2}-\d{2})\.\d+\.[0-9a-f]+\.json$/;
const MARKER_PATTERN = /^(\d{4}-\d{2}-\d{2})\.sent$/;
/** Generous bound per counter per shard; a corrupt shard can never inflate the totals. */
const MAX_COUNT = 1_000_000_000;

export function emptyDiscoveryFunnelCounts(): DiscoveryFunnelCounts {
  return {
    searches: 0,
    searches_with_results: 0,
    tools_listed: 0,
    schema_reads: 0,
    suggestions_shown: 0,
    prompt_suggestions_shown: 0,
    invocations_succeeded: 0,
    invocations_failed: 0,
    unavailable_here: 0,
  };
}

/** The UTC calendar day of `nowMs` as `YYYY-MM-DD`. */
export function discoveryFunnelDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function addCounts(target: DiscoveryFunnelCounts, source: DiscoveryFunnelCounts): void {
  for (const counter of DISCOVERY_FUNNEL_COUNTERS) {
    target[counter] = Math.min(Number.MAX_SAFE_INTEGER, target[counter] + source[counter]);
  }
}

function isEmpty(counts: DiscoveryFunnelCounts): boolean {
  return DISCOVERY_FUNNEL_COUNTERS.every((counter) => counts[counter] === 0);
}

/** Parses a shard's counts; anything malformed reads as nothing. */
function parseShardCounts(raw: string): DiscoveryFunnelCounts | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("counts" in parsed)) return undefined;
  const source = parsed.counts;
  if (typeof source !== "object" || source === null) return undefined;
  const counts = emptyDiscoveryFunnelCounts();
  for (const counter of DISCOVERY_FUNNEL_COUNTERS) {
    const value: unknown = Reflect.get(source, counter);
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
    counts[counter] = Math.min(value, MAX_COUNT);
  }
  return counts;
}

/**
 * The event properties for one day: the day and integer counts, nothing else. Exported so tests
 * (and reviewers) can see exactly what leaves the device.
 */
export function discoveryFunnelEventProperties(
  day: string,
  counts: DiscoveryFunnelCounts,
): EventProperties {
  const properties: Record<string, number | string> = { day };
  for (const counter of DISCOVERY_FUNNEL_COUNTERS) properties[counter] = counts[counter];
  return properties;
}

function normalizeCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The Resin state directory, resolved like `resolvePaths` (`RESIN_STATE_DIR`, else
 * `<RESIN_HOME or ~/.resin>/state`) without loading the paths module.
 */
export function resolveDiscoveryFunnelStateDir(
  options: { resinHome?: string; stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  const explicitState =
    normalizeCandidate(options.stateDir) ?? normalizeCandidate(env.RESIN_STATE_DIR);
  if (explicitState !== undefined) return path.resolve(explicitState);
  const userHome =
    normalizeCandidate(env.HOME) ?? normalizeCandidate(env.USERPROFILE) ?? os.homedir();
  const resinHome =
    normalizeCandidate(options.resinHome) ??
    normalizeCandidate(env.RESIN_HOME) ??
    path.join(userHome, ".resin");
  return path.join(path.resolve(resinHome), "state");
}

export interface DiscoveryFunnelDayTotals {
  readonly day: string;
  readonly counts: DiscoveryFunnelCounts;
}

export interface DiscoveryFunnelSummary {
  /** Most recent first; only days with at least one count. */
  readonly days: readonly DiscoveryFunnelDayTotals[];
  /** The sum of `days`. */
  readonly totals: DiscoveryFunnelCounts;
  /** The first day of the window (UTC). */
  readonly since: string;
}

/**
 * Sums the recorded shards for the last `days` UTC days (today included). Never throws; a missing
 * or unreadable directory reads as no activity.
 */
export function readDiscoveryFunnelSummary(
  stateDir: string,
  options: { nowMs?: number; days?: number } = {},
): DiscoveryFunnelSummary {
  const nowMs = options.nowMs ?? Date.now();
  const windowDays = Math.max(1, Math.floor(options.days ?? 7));
  const since = discoveryFunnelDay(nowMs - (windowDays - 1) * DAY_MS);
  const byDay = sumShardsByDay(path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY));
  const totals = emptyDiscoveryFunnelCounts();
  const days: DiscoveryFunnelDayTotals[] = [];
  for (const [day, counts] of byDay) {
    if (day < since || isEmpty(counts)) continue;
    days.push({ day, counts });
    addCounts(totals, counts);
  }
  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return { days, totals, since };
}

function listDirectory(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function sumShardsByDay(directory: string, onlyDay?: string): Map<string, DiscoveryFunnelCounts> {
  const byDay = new Map<string, DiscoveryFunnelCounts>();
  for (const name of listDirectory(directory)) {
    const day = SHARD_PATTERN.exec(name)?.[1];
    if (day === undefined || (onlyDay !== undefined && day !== onlyDay)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(directory, name), "utf8");
    } catch {
      continue;
    }
    const counts = parseShardCounts(raw);
    if (counts === undefined) continue;
    const total = byDay.get(day) ?? emptyDiscoveryFunnelCounts();
    addCounts(total, counts);
    byDay.set(day, total);
  }
  return byDay;
}

export interface DiscoveryFunnelStoreOptions {
  readonly stateDir: string;
  readonly now?: () => number;
  /** Defaults to the process-wide reporter, read at report time. */
  readonly reporter?: () => ErrorReporterLike;
  readonly flushDelayMs?: number;
  /** Flush synchronously when the process exits (default true). */
  readonly flushOnExit?: boolean;
}

/** One process's counts, written to its own shards. */
export class DiscoveryFunnelStore {
  readonly directory: string;
  private readonly now: () => number;
  private readonly reporter: () => ErrorReporterLike;
  private readonly flushDelayMs: number;
  private readonly flushOnExit: boolean;
  private readonly token = randomBytes(6).toString("hex");
  private readonly counts = new Map<string, DiscoveryFunnelCounts>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private exitHookInstalled = false;
  private lastReportCheckMs: number | undefined;
  private readonly exitFlush = (): void => {
    this.flush({ report: false });
  };

  constructor(options: DiscoveryFunnelStoreOptions) {
    this.directory = path.join(options.stateDir, DISCOVERY_FUNNEL_DIRECTORY);
    this.now = options.now ?? Date.now;
    this.reporter = options.reporter ?? getErrorReporter;
    this.flushDelayMs = options.flushDelayMs ?? DISCOVERY_FUNNEL_FLUSH_DELAY_MS;
    this.flushOnExit = options.flushOnExit ?? true;
  }

  /** Adds `count` (default 1) to today's counter. Never throws. */
  record(event: DiscoveryFunnelEvent, count = 1): void {
    try {
      const counter = DISCOVERY_FUNNEL_COUNTER_FOR_EVENT[event];
      if (counter === undefined || !Number.isSafeInteger(count) || count <= 0) return;
      const day = discoveryFunnelDay(this.now());
      const counts = this.counts.get(day) ?? emptyDiscoveryFunnelCounts();
      counts[counter] = Math.min(MAX_COUNT, counts[counter] + count);
      this.counts.set(day, counts);
      this.dirty.add(day);
      this.scheduleFlush();
    } catch {
      // Counting never affects the program.
    }
  }

  /** This process's counts for `day` (today by default), written or not. */
  pending(day: string = discoveryFunnelDay(this.now())): DiscoveryFunnelCounts {
    return { ...(this.counts.get(day) ?? emptyDiscoveryFunnelCounts()) };
  }

  /**
   * Writes this process's changed days, then (unless `report: false`) reports finished days at
   * most every ten minutes. Synchronous and total.
   */
  flush(options: { report?: boolean } = {}): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      if (this.dirty.size > 0) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        for (const day of this.dirty) {
          const counts = this.counts.get(day);
          if (counts !== undefined) this.writeShard(day, counts);
          this.dirty.delete(day);
        }
        // Earlier days are complete for this process; keep only today in memory.
        const today = discoveryFunnelDay(this.now());
        for (const day of this.counts.keys()) {
          if (day < today && !this.dirty.has(day)) this.counts.delete(day);
        }
      }
    } catch {
      // A failed write keeps the counts in memory for the next flush.
    }
    if (options.report === false) return;
    const nowMs = this.now();
    if (
      this.lastReportCheckMs !== undefined &&
      nowMs >= this.lastReportCheckMs &&
      nowMs - this.lastReportCheckMs < REPORT_CHECK_INTERVAL_MS
    ) {
      return;
    }
    this.lastReportCheckMs = nowMs;
    this.reportFinishedDays();
  }

  /**
   * Sends one `discovery_funnel_daily` event per finished, unclaimed day in the report window and
   * deletes shards past retention. Returns the days this call claimed. Never throws.
   */
  reportFinishedDays(): string[] {
    const claimed: string[] = [];
    try {
      const reporter = this.reporter();
      // An unconfigured reporter (tests, builds without a key) leaves the day for a process that
      // can send it; a configured one that is opted out marks it skipped.
      if (!reporter.isConfigured()) return claimed;
      const nowMs = this.now();
      const oldestReportable = discoveryFunnelDay(
        nowMs - DISCOVERY_FUNNEL_REPORT_WINDOW_DAYS * DAY_MS,
      );
      const names = listDirectory(this.directory);
      const markers = new Set<string>();
      const shardDays = new Set<string>();
      for (const name of names) {
        const marker = MARKER_PATTERN.exec(name)?.[1];
        if (marker !== undefined) markers.add(marker);
        const shard = SHARD_PATTERN.exec(name)?.[1];
        if (shard !== undefined) shardDays.add(shard);
      }
      for (const day of [...shardDays].sort()) {
        if (markers.has(day) || day < oldestReportable) continue;
        if (dayStartMs(day) + DAY_MS + DISCOVERY_FUNNEL_REPORT_GRACE_MS > nowMs) continue;
        const enabled = reporter.isEnabled();
        if (!this.claim(day, enabled ? "sent" : "skipped")) continue;
        claimed.push(day);
        if (!enabled) continue;
        const counts = sumShardsByDay(this.directory, day).get(day);
        if (counts === undefined || isEmpty(counts)) continue;
        reporter.capture(DISCOVERY_FUNNEL_EVENT, discoveryFunnelEventProperties(day, counts));
      }
      this.deleteExpired(names, nowMs);
    } catch {
      // Reporting never affects the program.
    }
    return claimed;
  }

  private claim(day: string, outcome: "sent" | "skipped"): boolean {
    if (!DAY_PATTERN.test(day)) return false;
    try {
      fs.writeFileSync(path.join(this.directory, `${day}.sent`), `${outcome}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch {
      return false;
    }
  }

  private deleteExpired(names: readonly string[], nowMs: number): void {
    const oldestKept = discoveryFunnelDay(nowMs - DISCOVERY_FUNNEL_RETENTION_DAYS * DAY_MS);
    for (const name of names) {
      const day = SHARD_PATTERN.exec(name)?.[1] ?? MARKER_PATTERN.exec(name)?.[1];
      if (day === undefined || day >= oldestKept) continue;
      try {
        fs.unlinkSync(path.join(this.directory, name));
      } catch {
        // Another process deleted it first.
      }
    }
  }

  private writeShard(day: string, counts: DiscoveryFunnelCounts): void {
    const target = path.join(this.directory, `${day}.${process.pid}.${this.token}.json`);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, day, counts })}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
  }

  private scheduleFlush(): void {
    if (this.flushOnExit && !this.exitHookInstalled) {
      this.exitHookInstalled = true;
      process.once("exit", this.exitFlush);
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), this.flushDelayMs);
    this.timer.unref?.();
  }

  /** Stops the timer and the exit hook without writing (tests and teardown). */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.exitHookInstalled) process.removeListener("exit", this.exitFlush);
    this.exitHookInstalled = false;
  }
}

const stores = new Map<string, DiscoveryFunnelStore>();
let overrideStore: DiscoveryFunnelStore | null | undefined;

function underTestRunner(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST || env.JEST_WORKER_ID || env.NODE_ENV === "test");
}

/**
 * Replaces the process-wide store (tests): a store receives every record, `null` drops them, and
 * `undefined` restores the default.
 */
export function setDiscoveryFunnelStore(store: DiscoveryFunnelStore | null | undefined): void {
  overrideStore = store;
}

function storeFor(options: { resinHome?: string; stateDir?: string }):
  | DiscoveryFunnelStore
  | undefined {
  if (overrideStore !== undefined) return overrideStore ?? undefined;
  const explicit = options.resinHome !== undefined || options.stateDir !== undefined;
  // Test runs never count into the developer's own Resin home by accident.
  if (!explicit && underTestRunner(process.env)) return undefined;
  const stateDir = resolveDiscoveryFunnelStateDir(options);
  let store = stores.get(stateDir);
  if (store === undefined) {
    store = new DiscoveryFunnelStore({ stateDir });
    stores.set(stateDir, store);
  }
  return store;
}

/**
 * Counts one funnel step for today in this process. `count` is for `tools_listed` (tools shown).
 * Never throws, never blocks: the count is written shortly after, and at process exit.
 */
export function recordDiscoveryFunnelEvent(
  event: DiscoveryFunnelEvent,
  options: { resinHome?: string; stateDir?: string; count?: number } = {},
): void {
  try {
    storeFor(options)?.record(event, options.count ?? 1);
  } catch {
    // Counting never affects the program.
  }
}

/** Counts one search and, when it found anything, one search with results. */
export function recordDiscoverySearch(
  resultCount: number,
  options: { resinHome?: string; stateDir?: string } = {},
): void {
  recordDiscoveryFunnelEvent("search", options);
  if (resultCount > 0) recordDiscoveryFunnelEvent("search_with_results", options);
}

/** Writes every store's pending counts now. Short-lived processes call it before they exit. */
export function flushDiscoveryFunnel(): void {
  try {
    if (overrideStore) overrideStore.flush({ report: false });
    for (const store of stores.values()) store.flush({ report: false });
  } catch {
    // Counting never affects the program.
  }
}
