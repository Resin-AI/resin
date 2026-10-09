import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LISTING_FOOTPRINT_RECORDS_DIRNAME,
  type ListingFootprint,
  type ListingFootprintRecord,
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  RESIN_LISTING_FOOTPRINT_METADATA_KEY,
  readListingFootprint,
} from "@resin/contracts";
import type {
  HarnessRecordDecoder,
  HarnessSession,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrajectoryCaptureCoordinator } from "../../src/analytics/capture-coordinator.js";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { CloudObservationClient } from "../../src/cloud-runtime.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const HARNESS = "omp";
const PROMPT_AT = "2026-10-09T12:00:00.000Z";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resin-listing-footprint-"));
  temporaryDirectories.push(directory);
  return directory;
}

function footprint(overrides: Partial<ListingFootprint> = {}): ListingFootprint {
  return {
    version: 1,
    tokenMethod: "utf8_div4_v1",
    instructionsTokens: 120,
    toolsTokens: 380,
    totalTokens: 500,
    toolCount: 3,
    toolIds: ["tool_alpha", "tool_beta"],
    capped: false,
    ...overrides,
  };
}

function record(
  cwd: string,
  overrides: Partial<ListingFootprintRecord> = {},
): ListingFootprintRecord {
  return {
    version: 1,
    harnessId: HARNESS,
    cwd,
    pid: 4242,
    startedAt: "2026-10-09T11:00:00.000Z",
    surfaces: [{ servedAt: "2026-10-09T11:00:01.000Z", footprint: footprint() }],
    ...overrides,
  };
}

/** A state dir holding the given records, laid out as the gateway writes them. */
function stateWith(records: readonly ListingFootprintRecord[]): string {
  const directory = path.join(temporaryDirectory(), LISTING_FOOTPRINT_RECORDS_DIRNAME);
  fs.mkdirSync(directory, { recursive: true });
  for (const [index, entry] of records.entries()) {
    fs.writeFileSync(
      path.join(directory, `${entry.pid}-${index}.json`),
      JSON.stringify(entry),
      "utf8",
    );
  }
  return directory;
}

/** Decodes `{ role, content, timestamp }` lines into message events. */
const messageDecoder: HarnessRecordDecoder = {
  harnessId: HARNESS,
  decoderVersion: "test",
  canDecode: () => true,
  decode: (raw) => {
    const line = JSON.parse(String(raw.rawPayload)) as {
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    return {
      type: "message",
      sessionId: raw.sessionId,
      timestamp: line.timestamp,
      role: line.role,
      content: line.content,
      causalRef: { causalSequence: raw.sequenceNumber },
    };
  },
};

function message(
  sessionId: string,
  sequenceNumber: number,
  role: "user" | "assistant",
  timestamp = PROMPT_AT,
): RawHarnessRecord {
  return {
    recordId: `${sessionId}_record_${sequenceNumber}`,
    sessionId,
    harnessId: HARNESS,
    sequenceNumber,
    timestamp,
    recordType: "message",
    rawPayload: JSON.stringify({ role, content: `${role} text ${sequenceNumber}`, timestamp }),
    cursor: {
      offset: sequenceNumber * 100,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  };
}

function sessionOf(sessionId: string, harnessId = HARNESS): HarnessSession {
  return {
    sessionId,
    workspaceId: "ws_listing_footprint",
    harnessId,
    transcriptPath: `/synthetic/transcripts/${sessionId}.jsonl`,
    status: "active",
    createdAt: PROMPT_AT,
    updatedAt: PROMPT_AT,
    metadata: {},
  };
}

/** A first-prompt marker file in a fresh state dir; it does not exist yet. */
function markersFile(): string {
  return path.join(temporaryDirectory(), "listing-footprint-first-prompts.json");
}

/**
 * Captures the records through one coordinator (one observer process) and returns the uploaded
 * events and payloads. Markers go to a fresh file unless one is given.
 */
async function capture(input: {
  recordsDir: string;
  sessionDirectory: string;
  batches: ReadonlyArray<{ session: HarnessSession; records: RawHarnessRecord[] }>;
  markersPath?: string;
}) {
  const pipeline = new NormalizationPipeline();
  pipeline.registerDecoder(messageDecoder);
  const uploaded: NormalizedSessionEvent[] = [];
  const payloads: string[] = [];
  // SAFETY: the fake implements the only cloud method used by this unattributed coordinator.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  client.sendObservationBatch = vi.fn(async (batch) => {
    payloads.push(JSON.stringify(batch));
    uploaded.push(...batch.observations.map((event) => NormalizedSessionEventSchema.parse(event)));
    return {
      batchId: batch.batchId,
      status: "accepted",
      acceptedCount: batch.observations.length,
      rejectedCount: 0,
      errors: [],
    };
  });
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: client,
    coalesceDwellMs: 0,
    resolveSessionWorkingDirectory: () => input.sessionDirectory,
    listingFootprintRecordsDir: input.recordsDir,
    listingFootprintFirstPromptsPath: input.markersPath ?? markersFile(),
  });
  try {
    for (const batch of input.batches) {
      await coordinator.handleRecords(batch.session, batch.records, vi.fn());
    }
  } finally {
    coordinator.dispose();
  }
  return { uploaded, payloads: payloads.join("\n") };
}

function footprintsOf(events: readonly NormalizedSessionEvent[]) {
  return events
    .filter((event) => event.metadata?.[RESIN_LISTING_FOOTPRINT_METADATA_KEY] !== undefined)
    .map((event) => ({
      sessionId: event.sessionId,
      sequence: event.causalRef.causalSequence,
      footprint: readListingFootprint(event.metadata),
    }));
}

describe("listing footprint capture", () => {
  it("attaches the served footprint to the session's first user prompt only", async () => {
    const sessionDirectory = temporaryDirectory();
    const recordsDir = stateWith([record(sessionDirectory)]);
    const session = sessionOf("sess_footprint_first");
    const { uploaded, payloads } = await capture({
      recordsDir,
      sessionDirectory,
      batches: [
        {
          session,
          records: [
            message(session.sessionId, 1, "user"),
            message(session.sessionId, 2, "assistant"),
          ],
        },
        { session, records: [message(session.sessionId, 3, "user", "2026-10-09T12:05:00.000Z")] },
      ],
    });
    expect(footprintsOf(uploaded)).toEqual([
      { sessionId: session.sessionId, sequence: 1, footprint: footprint() },
    ]);
    // Nothing of the local record leaves: not its directory, process id or start time.
    expect(payloads).not.toContain(sessionDirectory);
    expect(payloads).not.toContain("4242");
    expect(payloads).not.toContain("2026-10-09T11:00:00.000Z");
  });

  it("uses the surface served by the time of the prompt", async () => {
    const sessionDirectory = temporaryDirectory();
    const later = footprint({ toolsTokens: 80, totalTokens: 200, toolCount: 1, toolIds: [] });
    const recordsDir = stateWith([
      record(sessionDirectory, {
        surfaces: [
          { servedAt: "2026-10-09T11:00:01.000Z", footprint: footprint() },
          { servedAt: "2026-10-09T11:30:00.000Z", footprint: later },
          { servedAt: "2026-10-09T12:30:00.000Z", footprint: footprint({ capped: true }) },
        ],
      }),
    ]);
    const session = sessionOf("sess_footprint_surface");
    const { uploaded } = await capture({
      recordsDir,
      sessionDirectory,
      batches: [{ session, records: [message(session.sessionId, 1, "user")] }],
    });
    expect(footprintsOf(uploaded).map((entry) => entry.footprint)).toEqual([later]);
  });

  it("is absent without a matching record", async () => {
    const sessionDirectory = temporaryDirectory();
    const otherDirectory = temporaryDirectory();
    const cases: Array<{ name: string; records: ListingFootprintRecord[]; harnessId?: string }> = [
      { name: "no record", records: [] },
      { name: "other harness", records: [record(sessionDirectory, { harnessId: "codex" })] },
      { name: "other directory", records: [record(otherDirectory)] },
      {
        name: "closed before the prompt",
        records: [record(sessionDirectory, { closedAt: "2026-10-09T11:59:59.000Z" })],
      },
      {
        name: "started after the prompt",
        records: [
          record(sessionDirectory, {
            startedAt: "2026-10-09T12:00:01.000Z",
            surfaces: [{ servedAt: "2026-10-09T12:00:02.000Z", footprint: footprint() }],
          }),
        ],
      },
      {
        name: "session of another harness",
        records: [record(sessionDirectory)],
        harnessId: "codex",
      },
    ];
    for (const entry of cases) {
      const session = sessionOf(`sess_absent_${cases.indexOf(entry)}`, entry.harnessId);
      const { uploaded } = await capture({
        recordsDir: stateWith(entry.records),
        sessionDirectory,
        batches: [{ session, records: [message(session.sessionId, 1, "user")] }],
      });
      expect({ name: entry.name, footprints: footprintsOf(uploaded) }).toEqual({
        name: entry.name,
        footprints: [],
      });
    }
  });

  it("is absent when concurrent candidates served different surfaces", async () => {
    const sessionDirectory = temporaryDirectory();
    const recordsDir = stateWith([
      record(sessionDirectory),
      record(sessionDirectory, {
        pid: 5151,
        surfaces: [
          { servedAt: "2026-10-09T11:10:00.000Z", footprint: footprint({ capped: true }) },
        ],
      }),
    ]);
    const session = sessionOf("sess_footprint_disagree");
    const { uploaded } = await capture({
      recordsDir,
      sessionDirectory,
      batches: [{ session, records: [message(session.sessionId, 1, "user")] }],
    });
    expect(footprintsOf(uploaded)).toEqual([]);
  });

  it("is attached when concurrent candidates served the same surface", async () => {
    const sessionDirectory = temporaryDirectory();
    const recordsDir = stateWith([
      record(sessionDirectory),
      record(sessionDirectory, {
        pid: 5151,
        startedAt: "2026-10-09T11:40:00.000Z",
        surfaces: [{ servedAt: "2026-10-09T11:40:01.000Z", footprint: footprint() }],
      }),
    ]);
    const session = sessionOf("sess_footprint_agree");
    const { uploaded } = await capture({
      recordsDir,
      sessionDirectory,
      batches: [{ session, records: [message(session.sessionId, 1, "user")] }],
    });
    expect(footprintsOf(uploaded).map((entry) => entry.footprint)).toEqual([footprint()]);
  });

  it("gives each session, subagent sessions included, its own first prompt", async () => {
    const sessionDirectory = temporaryDirectory();
    const recordsDir = stateWith([record(sessionDirectory)]);
    const parent = sessionOf("sess_footprint_parent");
    const child = sessionOf("sess_footprint_child");
    const { uploaded } = await capture({
      recordsDir,
      sessionDirectory,
      batches: [
        { session: parent, records: [message(parent.sessionId, 1, "user")] },
        {
          session: child,
          records: [message(child.sessionId, 1, "user"), message(child.sessionId, 2, "user")],
        },
      ],
    });
    const attached = footprintsOf(uploaded).map(({ sessionId, sequence }) => ({
      sessionId,
      sequence,
    }));
    expect(attached).toEqual([
      { sessionId: parent.sessionId, sequence: 1 },
      { sessionId: child.sessionId, sequence: 1 },
    ]);
  });

  it("is absent when the first-prompt marker cannot be written", async () => {
    const sessionDirectory = temporaryDirectory();
    const recordsDir = stateWith([record(sessionDirectory)]);
    // The marker file does not exist yet and its directory refuses new files.
    const readOnly = temporaryDirectory();
    fs.chmodSync(readOnly, 0o500);
    const session = sessionOf("sess_footprint_unwritable");
    try {
      const { uploaded } = await capture({
        recordsDir,
        sessionDirectory,
        markersPath: path.join(readOnly, "listing-footprint-first-prompts.json"),
        batches: [{ session, records: [message(session.sessionId, 1, "user")] }],
      });
      expect(uploaded.map((event) => event.causalRef.causalSequence)).toEqual([1]);
      expect(footprintsOf(uploaded)).toEqual([]);
    } finally {
      fs.chmodSync(readOnly, 0o700);
    }
  });

  it("keeps the first prompt across restarts: re-read attaches, later prompts never", async () => {
    const sessionDirectory = temporaryDirectory();
    const recordsDir = stateWith([record(sessionDirectory)]);
    const markersPath = markersFile();
    const session = sessionOf("sess_footprint_restart");

    const first = await capture({
      recordsDir,
      sessionDirectory,
      markersPath,
      batches: [{ session, records: [message(session.sessionId, 1, "user")] }],
    });
    expect(footprintsOf(first.uploaded).map((entry) => entry.sequence)).toEqual([1]);

    // A new process resumes the session at its next prompt.
    const resumed = await capture({
      recordsDir,
      sessionDirectory,
      markersPath,
      batches: [
        { session, records: [message(session.sessionId, 2, "user", "2026-10-09T12:10:00.000Z")] },
      ],
    });
    expect(resumed.uploaded.map((event) => event.causalRef.causalSequence)).toEqual([2]);
    expect(footprintsOf(resumed.uploaded)).toEqual([]);

    // Another new process re-reads the session from its start (e.g. an unacknowledged batch).
    const reread = await capture({
      recordsDir,
      sessionDirectory,
      markersPath,
      batches: [
        {
          session,
          records: [
            message(session.sessionId, 1, "user"),
            message(session.sessionId, 2, "user", "2026-10-09T12:10:00.000Z"),
          ],
        },
      ],
    });
    expect(footprintsOf(reread.uploaded)).toEqual([
      { sessionId: session.sessionId, sequence: 1, footprint: footprint() },
    ]);
  });

  it("moves the first prompt to an earlier one delivered out of order", async () => {
    const sessionDirectory = temporaryDirectory();
    const recordsDir = stateWith([record(sessionDirectory)]);
    const session = sessionOf("sess_footprint_out_of_order");
    const { uploaded } = await capture({
      recordsDir,
      sessionDirectory,
      batches: [
        { session, records: [message(session.sessionId, 3, "user")] },
        { session, records: [message(session.sessionId, 1, "user")] },
        { session, records: [message(session.sessionId, 4, "user")] },
      ],
    });
    expect(footprintsOf(uploaded).map((entry) => entry.sequence)).toEqual([3, 1]);
  });
});

describe("listing footprint projection", () => {
  const base = {
    eventId: "evt_listing_footprint",
    schemaVersion: "1.0.0",
    sessionId: "sess_listing_footprint_projection",
    timestamp: PROMPT_AT,
    causalRef: { causalSequence: 1 },
    content: "secret prompt text",
  };

  it("keeps a valid footprint on a user prompt and nothing from the local record", () => {
    const projected = projectEventToMetadataOnly({
      ...base,
      type: "message",
      role: "user",
      metadata: {
        [RESIN_LISTING_FOOTPRINT_METADATA_KEY]: footprint(),
        cwd: "/home/someone/repo",
        pid: 4242,
      },
    } as NormalizedSessionEvent);
    expect(readListingFootprint(projected.metadata)).toEqual(footprint());
    expect(projected.metadata?.pid).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("/home/someone/repo");
  });

  it("drops an invalid footprint", () => {
    for (const invalid of [
      { ...footprint(), totalTokens: 1 },
      { ...footprint(), cwd: "/home/someone/repo" },
      { ...footprint(), toolIds: ["tool_beta", "tool_alpha"] },
      "500",
    ]) {
      const projected = projectEventToMetadataOnly({
        ...base,
        type: "message",
        role: "user",
        metadata: { [RESIN_LISTING_FOOTPRINT_METADATA_KEY]: invalid },
      } as NormalizedSessionEvent);
      expect(projected.metadata?.[RESIN_LISTING_FOOTPRINT_METADATA_KEY]).toBeUndefined();
    }
  });

  it("drops a footprint on any event other than a user prompt", () => {
    const projected = projectEventToMetadataOnly({
      ...base,
      type: "message",
      role: "assistant",
      metadata: { [RESIN_LISTING_FOOTPRINT_METADATA_KEY]: footprint() },
    } as NormalizedSessionEvent);
    expect(projected.metadata?.[RESIN_LISTING_FOOTPRINT_METADATA_KEY]).toBeUndefined();
  });
});
