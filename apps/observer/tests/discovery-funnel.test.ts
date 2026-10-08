import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_FUNNEL_COUNTERS,
  DISCOVERY_FUNNEL_DIRECTORY,
  DISCOVERY_FUNNEL_EVENT,
  DiscoveryFunnelStore,
  discoveryFunnelEventProperties,
  emptyDiscoveryFunnelCounts,
  flushDiscoveryFunnel,
  readDiscoveryFunnelSummary,
  recordDiscoveryFunnelEvent,
  recordDiscoverySearch,
  resolveDiscoveryFunnelStateDir,
  setDiscoveryFunnelStore,
} from "../src/discovery-funnel.js";
import type { ErrorReporterLike, EventProperties } from "../src/error-reporting/facade.js";

const DAY_MS = 24 * 60 * 60_000;
const OCT_5_NOON = Date.parse("2026-10-05T12:00:00.000Z");

interface FakeReporter extends ErrorReporterLike {
  readonly events: { event: string; properties: EventProperties | undefined }[];
  configured: boolean;
  enabled: boolean;
}

function fakeReporter(configured = true, enabled = true): FakeReporter {
  const events: { event: string; properties: EventProperties | undefined }[] = [];
  const reporter: FakeReporter = {
    events,
    configured,
    enabled,
    surface: "gateway",
    isConfigured: () => reporter.configured,
    isEnabled: () => reporter.enabled,
    consent: () => ({
      enabled: reporter.enabled,
      reason: reporter.enabled ? "enabled" : "config_disabled",
    }),
    captureException: () => undefined,
    captureExceptionImmediate: async () => undefined,
    capture: (event, properties) => {
      events.push({ event, properties });
    },
    captureImmediate: async () => undefined,
    identifyCloudUser: () => undefined,
    submitFeedback: async () => false,
    flush: async () => undefined,
  };
  return reporter;
}

let stateDir: string;
const stores: DiscoveryFunnelStore[] = [];

function makeStore(clock: { now: number }, reporter: ErrorReporterLike = fakeReporter()) {
  const store = new DiscoveryFunnelStore({
    stateDir,
    now: () => clock.now,
    reporter: () => reporter,
    flushOnExit: false,
  });
  stores.push(store);
  return store;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-funnel-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  setDiscoveryFunnelStore(undefined);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("discovery funnel counting", () => {
  it("counts each step per UTC day and sums the shards of concurrent processes", () => {
    const clock = { now: OCT_5_NOON };
    const gateway = makeStore(clock);
    const hook = makeStore(clock);

    gateway.record("search");
    gateway.record("search_with_results");
    gateway.record("search");
    gateway.record("tools_listed", 4);
    gateway.record("schema_read");
    gateway.record("invocation_succeeded");
    gateway.record("invocation_failed");
    gateway.record("unavailable_here");
    hook.record("suggestion_shown");
    hook.record("suggestion_shown");
    gateway.flush({ report: false });
    hook.flush({ report: false });

    const summary = readDiscoveryFunnelSummary(stateDir, { nowMs: clock.now });
    expect(summary.since).toBe("2026-09-29");
    expect(summary.days).toEqual([
      {
        day: "2026-10-05",
        counts: {
          searches: 2,
          searches_with_results: 1,
          tools_listed: 4,
          schema_reads: 1,
          suggestions_shown: 2,
          invocations_succeeded: 1,
          invocations_failed: 1,
          unavailable_here: 1,
        },
      },
    ]);
    expect(summary.totals).toEqual(summary.days[0]?.counts);
    // One shard per process per day.
    const shards = fs.readdirSync(path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY));
    expect(shards).toHaveLength(2);
  });

  it("rewrites a process's cumulative shard instead of double counting", () => {
    const clock = { now: OCT_5_NOON };
    const store = makeStore(clock);
    store.record("search");
    store.flush({ report: false });
    store.record("search");
    store.flush({ report: false });
    expect(readDiscoveryFunnelSummary(stateDir, { nowMs: clock.now }).totals.searches).toBe(2);
  });

  it("starts a new day at UTC midnight and keeps days apart", () => {
    const clock = { now: Date.parse("2026-10-05T23:59:59.000Z") };
    const store = makeStore(clock);
    store.record("schema_read");
    clock.now += 2_000;
    store.record("schema_read");
    store.record("schema_read");
    store.flush({ report: false });
    const summary = readDiscoveryFunnelSummary(stateDir, { nowMs: clock.now });
    expect(summary.days.map(({ day, counts }) => [day, counts.schema_reads])).toEqual([
      ["2026-10-06", 2],
      ["2026-10-05", 1],
    ]);
    expect(
      readDiscoveryFunnelSummary(stateDir, { nowMs: clock.now, days: 1 }).totals.schema_reads,
    ).toBe(2);
  });

  it("counts a search with results only when it found something", () => {
    const store = makeStore({ now: OCT_5_NOON });
    setDiscoveryFunnelStore(store);
    recordDiscoverySearch(0);
    recordDiscoverySearch(3);
    expect(store.pending()).toMatchObject({ searches: 2, searches_with_results: 1 });
  });

  it("ignores invalid counts and malformed shards", () => {
    const clock = { now: OCT_5_NOON };
    const store = makeStore(clock);
    store.record("tools_listed", -1);
    store.record("tools_listed", 1.5);
    store.record("tools_listed", Number.NaN);
    expect(store.pending()).toEqual(emptyDiscoveryFunnelCounts());
    const directory = path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "2026-10-05.1.ab.json"), "not json");
    fs.writeFileSync(
      path.join(directory, "2026-10-05.2.cd.json"),
      JSON.stringify({ counts: { searches: "many" } }),
    );
    fs.writeFileSync(path.join(directory, "notes.txt"), "ignored");
    expect(readDiscoveryFunnelSummary(stateDir, { nowMs: clock.now }).days).toEqual([]);
  });

  it("writes the pending counts when flushed by a short-lived process", () => {
    const store = makeStore({ now: OCT_5_NOON });
    setDiscoveryFunnelStore(store);
    recordDiscoveryFunnelEvent("suggestion_shown");
    flushDiscoveryFunnel();
    expect(
      readDiscoveryFunnelSummary(stateDir, { nowMs: OCT_5_NOON }).totals.suggestions_shown,
    ).toBe(1);
  });

  it("flushes on its own shortly after a change", () => {
    vi.useFakeTimers();
    try {
      const store = new DiscoveryFunnelStore({
        stateDir,
        now: () => OCT_5_NOON,
        reporter: () => fakeReporter(false),
        flushOnExit: false,
        flushDelayMs: 1_000,
      });
      stores.push(store);
      store.record("search");
      expect(readDiscoveryFunnelSummary(stateDir, { nowMs: OCT_5_NOON }).totals.searches).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(readDiscoveryFunnelSummary(stateDir, { nowMs: OCT_5_NOON }).totals.searches).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never counts into the default Resin home under a test runner", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-funnel-home-"));
    const previous = process.env.RESIN_HOME;
    process.env.RESIN_HOME = home;
    try {
      recordDiscoveryFunnelEvent("search");
      flushDiscoveryFunnel();
      expect(fs.existsSync(path.join(home, "state", DISCOVERY_FUNNEL_DIRECTORY))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RESIN_HOME;
      else process.env.RESIN_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves the state directory like resolvePaths", () => {
    expect(resolveDiscoveryFunnelStateDir({ env: { HOME: "/home/a" } })).toBe(
      path.resolve("/home/a/.resin/state"),
    );
    expect(resolveDiscoveryFunnelStateDir({ env: { HOME: "/home/a", RESIN_HOME: "/r" } })).toBe(
      path.resolve("/r/state"),
    );
    expect(
      resolveDiscoveryFunnelStateDir({ env: { RESIN_HOME: "/r", RESIN_STATE_DIR: "/s" } }),
    ).toBe(path.resolve("/s"));
    expect(resolveDiscoveryFunnelStateDir({ resinHome: "/x", env: { RESIN_HOME: "/r" } })).toBe(
      path.resolve("/x/state"),
    );
  });
});

describe("discovery_funnel_daily usage event", () => {
  function recordDay(store: DiscoveryFunnelStore): void {
    store.record("search");
    store.record("search_with_results");
    store.record("schema_read");
    store.record("invocation_succeeded");
    store.flush({ report: false });
  }

  it("sends one event per finished day, after the grace period, from one process only", () => {
    const clock = { now: OCT_5_NOON };
    const reporterA = fakeReporter();
    const reporterB = fakeReporter();
    const a = makeStore(clock, reporterA);
    const b = makeStore(clock, reporterB);
    recordDay(a);
    recordDay(b);

    expect(a.reportFinishedDays()).toEqual([]);
    clock.now = Date.parse("2026-10-06T00:30:00.000Z");
    expect(a.reportFinishedDays()).toEqual([]);
    clock.now = Date.parse("2026-10-06T01:00:00.000Z");
    expect(a.reportFinishedDays()).toEqual(["2026-10-05"]);
    expect(b.reportFinishedDays()).toEqual([]);
    expect(a.reportFinishedDays()).toEqual([]);

    expect(reporterB.events).toEqual([]);
    expect(reporterA.events).toEqual([
      {
        event: DISCOVERY_FUNNEL_EVENT,
        properties: {
          day: "2026-10-05",
          searches: 2,
          searches_with_results: 2,
          tools_listed: 0,
          schema_reads: 2,
          suggestions_shown: 0,
          invocations_succeeded: 2,
          invocations_failed: 0,
          unavailable_here: 0,
        },
      },
    ]);
  });

  it("carries only the day and integer counts: no text fields", () => {
    const counts = emptyDiscoveryFunnelCounts();
    for (const [index, counter] of DISCOVERY_FUNNEL_COUNTERS.entries()) counts[counter] = index;
    const properties = discoveryFunnelEventProperties("2026-10-05", counts);
    expect(Object.keys(properties).sort()).toEqual(["day", ...DISCOVERY_FUNNEL_COUNTERS].sort());
    for (const [key, value] of Object.entries(properties)) {
      if (key === "day") expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      else expect(Number.isSafeInteger(value)).toBe(true);
    }

    // End to end: a shard carrying extra text never reaches the event.
    const directory = path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "2026-10-05.7.ef.json"),
      JSON.stringify({
        version: 1,
        day: "2026-10-05",
        query: "posthog errors last 24 hours",
        counts: { searches: 1, command: "npx vitest run", tool: "deploy_preview" },
      }),
    );
    const reporter = fakeReporter();
    const store = makeStore({ now: OCT_5_NOON + DAY_MS }, reporter);
    store.reportFinishedDays();
    expect(reporter.events).toHaveLength(1);
    const sent = reporter.events[0]?.properties ?? {};
    expect(Object.keys(sent).sort()).toEqual(["day", ...DISCOVERY_FUNNEL_COUNTERS].sort());
    expect(JSON.stringify(sent)).not.toMatch(/posthog|vitest|deploy_preview/);
  });

  it("marks a day skipped while reporting is opted out and never sends it later", () => {
    const clock = { now: OCT_5_NOON };
    const reporter = fakeReporter(true, false);
    const store = makeStore(clock, reporter);
    recordDay(store);
    clock.now += DAY_MS;
    expect(store.reportFinishedDays()).toEqual(["2026-10-05"]);
    expect(reporter.events).toEqual([]);
    expect(
      fs.readFileSync(path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY, "2026-10-05.sent"), "utf8"),
    ).toBe("skipped\n");
    reporter.enabled = true;
    expect(store.reportFinishedDays()).toEqual([]);
    expect(reporter.events).toEqual([]);
  });

  it("leaves days for another process when this one has no configured reporter", () => {
    const clock = { now: OCT_5_NOON };
    const unconfigured = fakeReporter(false, false);
    const store = makeStore(clock, unconfigured);
    recordDay(store);
    clock.now += DAY_MS;
    expect(store.reportFinishedDays()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY, "2026-10-05.sent"))).toBe(
      false,
    );
    const configured = fakeReporter();
    expect(makeStore(clock, configured).reportFinishedDays()).toEqual(["2026-10-05"]);
    expect(configured.events).toHaveLength(1);
  });

  it("never sends days older than the report window and deletes expired shards", () => {
    const clock = { now: OCT_5_NOON };
    const store = makeStore(clock);
    recordDay(store);
    clock.now += 10 * DAY_MS;
    const reporter = fakeReporter();
    const later = makeStore(clock, reporter);
    expect(later.reportFinishedDays()).toEqual([]);
    expect(reporter.events).toEqual([]);
    expect(fs.readdirSync(path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY))).toHaveLength(1);
    clock.now += 30 * DAY_MS;
    later.reportFinishedDays();
    expect(fs.readdirSync(path.join(stateDir, DISCOVERY_FUNNEL_DIRECTORY))).toEqual([]);
  });

  it("reports from a periodic flush at most every ten minutes", () => {
    const clock = { now: OCT_5_NOON };
    const reporter = fakeReporter();
    const store = makeStore(clock, reporter);
    recordDay(store);
    clock.now += DAY_MS;
    store.record("search");
    store.flush();
    expect(reporter.events).toHaveLength(1);
  });
});
