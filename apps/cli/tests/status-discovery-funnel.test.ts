import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { DiscoveryFunnelStore } from "@resin/observer/discovery-funnel";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectStatus,
  formatDiscoveryFunnelLines,
  formatStatusForTerminal,
} from "../src/commands/status.js";

const emptyFs: ConfigFsBridge = {
  readFile: async () => null,
  writeFile: async () => undefined,
  exists: async () => false,
  mkdirp: async () => undefined,
  copyFile: async () => undefined,
  unlink: async () => undefined,
};

const NOW = Date.parse("2026-10-06T15:00:00.000Z");

describe("discovery funnel in `resin status --verbose`", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("shows searches through to calls from the locally recorded counts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-status-funnel-"));
    roots.push(home);
    const stateDir = path.join(home, ".resin", "state");
    let now = Date.parse("2026-10-05T10:00:00.000Z");
    const store = new DiscoveryFunnelStore({ stateDir, now: () => now, flushOnExit: false });
    store.record("search");
    store.record("search");
    store.record("search_with_results");
    store.record("schema_read");
    store.record("invocation_succeeded");
    store.flush({ report: false });
    now = NOW;
    store.record("suggestion_shown");
    store.record("prompt_suggestion_shown");
    store.record("tools_listed", 3);
    store.record("invocation_failed");
    store.flush({ report: false });
    store.dispose();

    const summary = await collectStatus({
      home,
      fsBridge: emptyFs,
      env: { HOME: home },
      now: () => NOW,
    });
    expect(summary.discoveryFunnel?.totals).toEqual({
      searches: 2,
      searches_with_results: 1,
      tools_listed: 3,
      schema_reads: 1,
      suggestions_shown: 1,
      prompt_suggestions_shown: 1,
      invocations_succeeded: 1,
      invocations_failed: 1,
      unavailable_here: 0,
    });
    expect(JSON.parse(JSON.stringify(summary)).discoveryFunnel.days).toHaveLength(2);

    const verbose = formatStatusForTerminal(summary, { verbose: true });
    expect(verbose).toContain("[Learned Tool Discovery] (since 2026-09-30, UTC)");
    expect(verbose).toContain("Searches:       2 (1 with results)");
    expect(verbose).toContain("Calls:          1 succeeded, 1 failed");
    expect(verbose).toContain("2026-10-06: 0 searches -> 0 schema reads -> 1 calls; 2 suggestions");
    expect(verbose).toContain("Suggestions:    1 after commands, 1 at prompts");
    expect(verbose).toContain("2026-10-05: 2 searches -> 1 schema reads -> 1 calls; 0 suggestions");
    expect(formatStatusForTerminal(summary)).not.toContain("Learned Tool Discovery");
  });

  it("says when nothing was recorded, and survives an unreadable record", async () => {
    expect(
      formatDiscoveryFunnelLines({
        days: [],
        totals: {
          searches: 0,
          searches_with_results: 0,
          tools_listed: 0,
          schema_reads: 0,
          suggestions_shown: 0,
          prompt_suggestions_shown: 0,
          invocations_succeeded: 0,
          invocations_failed: 0,
          unavailable_here: 0,
        },
        since: "2026-09-30",
      }),
    ).toEqual([
      "[Learned Tool Discovery] (since 2026-09-30, UTC)",
      "  No searches, suggestions or learned-tool calls recorded yet",
    ]);
    const summary = await collectStatus({
      home: path.resolve("/home/testuser"),
      fsBridge: emptyFs,
      readDiscoveryFunnel: () => {
        throw new Error("unreadable");
      },
    });
    expect(summary.discoveryFunnel).toBeUndefined();
    expect(formatStatusForTerminal(summary, { verbose: true })).toContain(
      "[Learned Tool Discovery] (since unknown, UTC)\n  Unavailable",
    );
  });
});
