import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  RESIN_COMMAND_SEQUENCE_METADATA_KEY,
} from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { AuthRecoveryError } from "../../src/auth-recovery.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
} from "../../src/index.js";

const timestamp = "2026-09-19T00:00:00.000Z";
const session: HarnessSession = {
  sessionId: "sess_checksum_capture",
  workspaceId: "ws_checksum_capture",
  harnessId: "omp",
  status: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: {},
};

function toolRecord(sequenceNumber: number, result: boolean): RawHarnessRecord {
  return {
    recordId: `checksum_record_${sequenceNumber}`,
    sessionId: session.sessionId,
    harnessId: "omp",
    sequenceNumber,
    timestamp,
    recordType: "custom",
    rawPayload: JSON.stringify({
      type: "custom",
      customType: result ? "tool_execution_end" : "tool_execution_start",
      data: {
        toolCallId: "checksum_call",
        toolName: "bash",
        ...(result
          ? { result: "PRIVATE_DIGEST", isError: false }
          : {
              args: {
                command: "sha256sum ./data/private.bin && sha512sum ./data/private.bin",
                cwd: ".",
              },
            }),
      },
    }),
    cursor: {
      offset: sequenceNumber * 100,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  };
}

function captureFixture(failSecondUpload?: Error) {
  const pipeline = new NormalizationPipeline();
  pipeline.registerDecoder(new OmpRecordDecoder());
  const batches: NormalizedSessionEvent[][] = [];
  const payloads: string[] = [];
  const localEvents: NormalizedSessionEvent[] = [];
  // SAFETY: the fake implements the only cloud method used by this unattributed coordinator.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  client.sendObservationBatch = vi.fn(async (input) => {
    batches.push(input.observations.map((event) => NormalizedSessionEventSchema.parse(event)));
    payloads.push(JSON.stringify(input));
    if (batches.length === 2 && failSecondUpload) throw failSecondUpload;
    return {
      batchId: input.batchId,
      status: "accepted",
      acceptedCount: input.observations.length,
      rejectedCount: 0,
      errors: [],
    };
  });
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: client,
    coalesceDwellMs: 0,
    onSessionEvents: (_session, events) => {
      localEvents.push(...events);
    },
  });
  return { coordinator, client, batches, localEvents, payloads };
}

describe("completed command sequence capture", () => {
  it("carries its own native call sequence and truthful root onto a separately uploaded success", async () => {
    const { coordinator, batches, localEvents } = captureFixture();
    const callAck = vi.fn(async () => {});
    const resultAck = vi.fn(async () => {});
    try {
      await coordinator.handleRecords(session, [toolRecord(1, false)], callAck);
      const call = batches[0]?.find((event) => event.type === "tool_call");
      const sequence = call?.metadata?.[RESIN_COMMAND_SEQUENCE_METADATA_KEY];
      expect(sequence).toMatchObject({ schemaVersion: 1, kind: "command-sequence" });
      expect(batches.flat().some((event) => event.type === "tool_result")).toBe(false);

      await coordinator.handleRecords(session, [toolRecord(2, true)], resultAck);
      const result = batches[1]?.find((event) => event.type === "tool_result");
      expect(result?.metadata?.[RESIN_COMMAND_SEQUENCE_METADATA_KEY]).toEqual(sequence);
      expect(result?.metadata?.cwd).toBe(".");
      expect(localEvents.find((event) => event.type === "tool_result")?.metadata).toEqual(
        result?.metadata,
      );
      expect(JSON.stringify(batches)).not.toContain("PRIVATE_DIGEST");
      expect(JSON.stringify(batches)).not.toContain("private.bin");
      expect(callAck).toHaveBeenCalledTimes(1);
      expect(resultAck).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.dispose();
    }
  });

  it.each(["buffered transport retry", "auth recovery replay"])(
    "preserves completion bytes on %s without extra cursor acknowledgments",
    async (mode) => {
      const failure =
        mode === "auth recovery replay"
          ? new AuthRecoveryError("FORBIDDEN")
          : new Error("fake transport failure");
      const { coordinator, batches, payloads, localEvents } = captureFixture(failure);
      const failedAck = vi.fn(async () => {});
      const recoveredAck = vi.fn(async () => {});
      try {
        await coordinator.handleRecords(session, [toolRecord(1, false)], async () => {});
        const resultRecord = toolRecord(2, true);
        await expect(coordinator.handleRecords(session, [resultRecord], failedAck)).rejects.toBe(
          failure,
        );
        expect(failedAck).not.toHaveBeenCalled();
        expect(batches[1]?.[0]?.metadata?.resinCommandSequence).toBeDefined();
        if (mode === "auth recovery replay") {
          await coordinator.handleRecords(session, [resultRecord], recoveredAck);
          expect(failedAck).not.toHaveBeenCalled();
          expect(recoveredAck).toHaveBeenCalledTimes(1);
        } else {
          await coordinator.flush();
          expect(failedAck).toHaveBeenCalledTimes(1);
          expect(recoveredAck).not.toHaveBeenCalled();
        }
        expect(payloads[2]).toBe(payloads[1]);
        expect(
          localEvents
            .filter((event) => event.type === "tool_result")
            .map((event) => event.metadata),
        ).toEqual([batches[1]?.[0]?.metadata, batches[2]?.[0]?.metadata]);
      } finally {
        coordinator.dispose();
      }
    },
  );

  it.each(["consent withdrawal", "cutoff advance", "capture stop", "dispose"])(
    "does not reuse pending provenance after %s",
    async (boundary) => {
      const { coordinator, batches } = captureFixture();
      try {
        await coordinator.handleRecords(session, [toolRecord(1, false)], async () => {});
        if (boundary === "consent withdrawal") {
          coordinator.setTelemetryEnabled(false);
          coordinator.setTelemetryEnabled(true);
        } else if (boundary === "cutoff advance") {
          coordinator.setPrivacyCutoff(Date.parse(timestamp));
        } else if (boundary === "capture stop") {
          coordinator.clearCommandSequenceEvidence();
        } else {
          coordinator.dispose();
        }
        const laterResult = { ...toolRecord(2, true), timestamp: "2026-09-19T00:00:01.000Z" };
        await coordinator.handleRecords(session, [laterResult], async () => {});
        const resultEvent = batches.flat().find((event) => event.type === "tool_result");
        expect(resultEvent?.metadata?.resinCommandSequence).toBeUndefined();
        expect(resultEvent?.metadata?.cwd).toBeUndefined();
        expect(resultEvent?.type).toBe("tool_result");
      } finally {
        coordinator.dispose();
      }
    },
  );

  it.each(["consent withdrawal", "cutoff advance", "consent cycle"])(
    "does not upload a completion after %s while the local sink is awaited",
    async (boundary) => {
      const { coordinator, batches } = captureFixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const ack = vi.fn(async () => {});
      try {
        await coordinator.handleRecords(session, [toolRecord(1, false)], async () => {});
        coordinator.setSessionEventSink(async () => {
          entered.resolve();
          await resume.promise;
        });
        const delivery = coordinator.handleRecords(session, [toolRecord(2, true)], ack);
        await entered.promise;
        if (boundary === "cutoff advance") {
          coordinator.setPrivacyCutoff(Date.parse(timestamp) + 1);
        } else {
          coordinator.setTelemetryEnabled(false);
          if (boundary === "consent cycle") coordinator.setTelemetryEnabled(true);
        }
        resume.resolve();
        await delivery;
        expect(batches).toHaveLength(1);
        expect(ack).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        coordinator.dispose();
      }
    },
  );
});
