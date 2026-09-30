import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_VERIFIED_MIN_EVENTS,
  HARNESS_VERIFIED_MIN_SESSIONS,
  type HarnessVersionStats,
} from "@resin/observer";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DaemonStatusSummary,
  collectStatus,
  describeHarnessVersion,
  formatStatusForTerminal,
} from "../src/commands/status.js";
import type { LocalStateReader, ServedCatalogReading } from "../src/service/local-state-reader.js";

let home: string;
let fakeOmp: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-status-evidence-"));
  fakeOmp = path.join(home, "omp");
  await fs.writeFile(fakeOmp, "#!/bin/sh\necho 18.4.0\n", { mode: 0o755 });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(home, { recursive: true, force: true });
});

function reader(
  catalog: ServedCatalogReading,
  stats: (harnessId: string, version: string) => HarnessVersionStats | null = () => null,
): LocalStateReader & { close: Mock } {
  return {
    servedCatalog: async () => catalog,
    harnessVersionStats: stats,
    close: vi.fn(),
  };
}

const unavailable: ServedCatalogReading = {
  available: false,
  reason: "no_snapshot",
  workspaceId: "ws-1",
};

function collect(stateReader: LocalStateReader): Promise<DaemonStatusSummary> {
  return collectStatus({
    home,
    cwd: home,
    stateReader,
    // A PATH with no harness on it, so only the fake OMP counts as installed.
    env: { HOME: home, OMP_BIN: fakeOmp, PATH: path.join(home, "bin"), RESIN_NO_SERVICE: "1" },
  });
}

function stats(overrides: Partial<HarnessVersionStats>): HarnessVersionStats {
  return {
    harnessId: "omp",
    harnessVersion: "18.4.0",
    eventsDecoded: 0,
    eventsUnknownPassthrough: 0,
    eventsUnexpectedPassthrough: 0,
    eventsDeadLettered: 0,
    toolCalls: 0,
    toolResultsPaired: 0,
    toolResultsOrphan: 0,
    toolCallsUnpaired: 0,
    sessionsOk: 0,
    sessionsFailed: 0,
    unexpectedTypes: {},
    firstSeenAt: "2026-09-29T12:00:00.000Z",
    updatedAt: "2026-09-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("status custom tools", () => {
  it("counts the tools of the catalog the gateway served, not a hard-coded zero", async () => {
    const summary = await collect(
      reader({
        available: true,
        workspaceId: "ws-1",
        customToolsCount: 3,
        asOf: "2026-09-29T18:53:31.779Z",
      }),
    );
    expect(summary.tools.activeCustomToolsCount).toBe(3);
    expect(summary.tools.customToolsCatalog).toEqual({
      status: "available",
      workspaceId: "ws-1",
      asOf: "2026-09-29T18:53:31.779Z",
      reason: null,
    });
    expect(formatStatusForTerminal(summary, { verbose: true })).toContain(
      "Custom Tools:   3 (catalog as of 2026-09-29T18:53:31.779Z)",
    );
  });

  it("reports a legitimately empty served catalog as 0", async () => {
    const summary = await collect(
      reader({
        available: true,
        workspaceId: "ws-1",
        customToolsCount: 0,
        asOf: "2026-09-29T00:00:00Z",
      }),
    );
    expect(summary.tools.activeCustomToolsCount).toBe(0);
  });

  it("reports an unreadable catalog as unknown, never 0", async () => {
    const summary = await collect(reader(unavailable));
    expect(summary.tools.activeCustomToolsCount).toBeNull();
    expect(summary.tools.customToolsCatalog).toEqual({
      status: "unavailable",
      workspaceId: "ws-1",
      asOf: null,
      reason: "no_snapshot",
    });
    const output = formatStatusForTerminal(summary, { verbose: true });
    expect(output).toContain("Custom Tools:   unknown (no catalog served for this workspace yet)");
    expect(JSON.parse(JSON.stringify(summary)).tools.activeCustomToolsCount).toBeNull();
  });

  it("leaves an injected state reader open for its owner", async () => {
    const injected = reader(unavailable);
    await collect(injected);
    expect(injected.close).not.toHaveBeenCalled();
  });
});

describe("status harness version evidence", () => {
  const cleanStats = stats({
    sessionsOk: HARNESS_VERIFIED_MIN_SESSIONS,
    eventsDecoded: HARNESS_VERIFIED_MIN_EVENTS,
  });

  it("looks stats up by the installed harness version and reports verified sessions", async () => {
    const lookup = vi.fn((_harnessId: string, _version: string) => cleanStats);
    const summary = await collect(reader(unavailable, lookup));
    const omp = summary.harnesses.find((harness) => harness.id === "omp");
    expect(lookup).toHaveBeenCalledWith("omp", "18.4.0");
    expect(omp).toMatchObject({
      installed: true,
      version: "18.4.0",
      // 18.4.0 has no recorded fixtures, so the fixture list alone would call it untested.
      versionStatus: "untested",
      versionEvidence: {
        kind: "verified",
        sessions: HARNESS_VERIFIED_MIN_SESSIONS,
        events: HARNESS_VERIFIED_MIN_EVENTS,
      },
      versionLabel: `verified on ${HARNESS_VERIFIED_MIN_SESSIONS} local sessions`,
    });
    expect(formatStatusForTerminal(summary, { verbose: true })).toContain(
      `Installed 18.4.0, verified on ${HARNESS_VERIFIED_MIN_SESSIONS} local sessions`,
    );
    expect(formatStatusForTerminal(summary)).toContain(
      `Oh My Pi 18.4.0 (verified on ${HARNESS_VERIFIED_MIN_SESSIONS} local sessions)`,
    );
  });

  it("reports decode problems with what is wrong", async () => {
    const summary = await collect(
      reader(unavailable, () =>
        stats({
          ...cleanStats,
          sessionsFailed: HARNESS_VERIFIED_MIN_SESSIONS,
        }),
      ),
    );
    const omp = summary.harnesses.find((harness) => harness.id === "omp");
    expect(omp?.versionEvidence.kind).toBe("problems");
    expect(omp?.versionLabel).toBe(
      `decode problems: ${HARNESS_VERIFIED_MIN_SESSIONS} of ${HARNESS_VERIFIED_MIN_SESSIONS * 2} sessions failed to decode`,
    );
    expect(formatStatusForTerminal(summary)).toContain(
      `Oh My Pi 18.4.0 (decode problems: ${HARNESS_VERIFIED_MIN_SESSIONS} of ${HARNESS_VERIFIED_MIN_SESSIONS * 2} sessions failed to decode)`,
    );
  });

  it.each([
    ["no stats", null],
    ["too few sessions to judge", stats({ sessionsOk: 1, eventsDecoded: 10 })],
  ])("falls back to the fixture label with %s", async (_name, fallbackStats) => {
    const summary = await collect(reader(unavailable, () => fallbackStats));
    const omp = summary.harnesses.find((harness) => harness.id === "omp");
    expect(omp?.versionStatus).toBe("untested");
    expect(omp?.versionLabel).toBe("untested");
    expect(formatStatusForTerminal(summary, { verbose: true })).toContain(
      "Installed 18.4.0, untested",
    );
    expect(formatStatusForTerminal(summary)).toContain("Oh My Pi 18.4.0 (untested)");
  });

  it("does not consult stats for harnesses that are not installed", async () => {
    const lookup = vi.fn((_harnessId: string, _version: string) => cleanStats);
    const summary = await collect(reader(unavailable, lookup));
    const notInstalled = summary.harnesses.filter((harness) => !harness.installed);
    expect(notInstalled.length).toBeGreaterThan(0);
    for (const harness of notInstalled) {
      expect(harness.versionEvidence).toEqual({ kind: "none" });
      expect(lookup).not.toHaveBeenCalledWith(harness.id, expect.anything());
    }
  });
});

describe("describeHarnessVersion", () => {
  it("prefers evidence and otherwise falls back to the fixture classification", () => {
    expect(
      describeHarnessVersion("untested", { kind: "verified", sessions: 12, events: 900 }),
    ).toBe("verified on 12 local sessions");
    expect(
      describeHarnessVersion("tested", {
        kind: "problems",
        sessions: 4,
        events: 80,
        problems: ["a", "b"],
      }),
    ).toBe("decode problems: a; b");
    expect(describeHarnessVersion("tested", { kind: "none" })).toBe("tested");
    expect(
      describeHarnessVersion("untested", { kind: "insufficient", sessions: 1, events: 3 }),
    ).toBe("untested");
    expect(describeHarnessVersion("unknown", { kind: "none" })).toBe("unknown");
  });
});
