import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OmpHarnessAdapter, OmpRecordDecoder } from "@resin/adapter-omp";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
} from "../../src/index.js";
import type { JsonObject } from "../../src/normalization/redaction.js";
import {
  ObserverCoordinator,
  SourceCursorManager,
  TranscriptTailer,
} from "../../src/tailing/index.js";

function submissionBarrier() {
  return {
    entered: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
  };
}

function commandTurn(callId: string, timestamp: string, isError: boolean): JsonObject[] {
  return [
    {
      type: "message",
      id: `${callId}-prompt`,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "PRIVATE_PROMPT: run the command" }],
      },
    },
    {
      type: "custom",
      customType: "tool_execution_start",
      id: `${callId}-start`,
      timestamp,
      data: {
        toolCallId: callId,
        toolName: "bash",
        args: { command: "printf PRIVATE_COMMAND_OUTPUT" },
      },
    },
    {
      type: "message",
      id: `${callId}-result`,
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "bash",
        content: [{ type: "text", text: "PRIVATE_COMMAND_OUTPUT" }],
        isError,
        details: { exitCode: isError ? 1 : 0 },
      },
    },
    {
      type: "message",
      id: `${callId}-completion`,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "PRIVATE_COMPLETION: command finished" }],
        stopReason: "stop",
      },
    },
  ];
}

function jsonl(records: JsonObject[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("OMP discovery-to-cloud idle/resume capture", () => {
  it.each(["idle", "real exit"])(
    "uploads both successful commands once after %s without inventing ends or capturing historical peers",
    async (resumeAfter) => {
      vi.useFakeTimers();
      const startedAt = new Date("2026-09-20T12:00:00.000Z");
      vi.setSystemTime(startedAt);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-integration-"));
      const sessionId = "omp-resume-session";
      const historicalSessionId = "omp-historical-idle-session";
      const ompHome = path.join(tmpDir, ".omp");
      const workspacePath = path.join(tmpDir, "workspace");
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-resume-workspace");
      const transcriptPath = path.join(sessionsDir, "current.jsonl");
      const historicalPath = path.join(sessionsDir, "historical.jsonl");
      const cursorManager = new SourceCursorManager();
      const tailer = new TranscriptTailer({
        cursorManager,
        pendingStorageDirectory: null,
        defaultBackfillPolicy: { mode: "latest" },
      });
      const observer = new ObserverCoordinator({
        tailer,
        backfillPolicyForSession: (session) =>
          session.harnessId === "omp" ? { mode: "all" } : undefined,
      });
      const adapter = new OmpHarnessAdapter({ customHome: ompHome, activeOnly: false });
      observer.registerAdapter(adapter);

      const uploaded: NormalizedSessionEvent[] = [];
      let submission = submissionBarrier();
      let handled = Promise.withResolvers<void>();
      // Only the outbound cloud boundary is fake; discovery, source, tailer and capture are real.
      const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
      client.sendObservationBatch = vi.fn(
        async (input: { observations: NormalizedSessionEvent[] }) => {
          const pendingSubmission = submission;
          pendingSubmission.entered.resolve();
          await pendingSubmission.released.promise;
          uploaded.push(...input.observations);
          return {
            batchId: `batch_${uploaded.length}`,
            status: "accepted" as const,
            acceptedCount: input.observations.length,
            rejectedCount: 0,
            errors: [],
          };
        },
      );
      client.sendTrajectoryObservationBatch = vi.fn(async () => {
        throw new Error("Unattributed OMP sessions must use generic observations");
      });
      const pipeline = new NormalizationPipeline();
      pipeline.registerDecoder(new OmpRecordDecoder());
      const capture = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: client,
        attributionResolver: async () => null,
        isTelemetryEnabled: () => true,
        authorizeTelemetryEmission: async () => true,
        coalesceDwellMs: 0,
      });
      observer.onRecords(async (session, records, ack) => {
        const delivery = handled;
        try {
          await capture.handleRecords(session, records, ack);
          if (session.sessionId === sessionId && records.length > 0) delivery.resolve();
        } catch (error) {
          delivery.reject(error);
          throw error;
        }
      });

      const pollAndDrain = async () => {
        const summary = await observer.pollOnce();
        expect(summary.errors).toEqual([]);
        await Promise.all(tailer.getActiveSessions().map((id) => tailer.pumpSession(id)));
        await capture.flush();
        await capture.waitForIdle();
      };
      const expectHistoricalUntouched = async () => {
        expect(tailer.getActiveSessions()).not.toContain(historicalSessionId);
        expect(await cursorManager.getCursor(historicalSessionId)).toBeNull();
        expect(uploaded.filter((event) => event.sessionId === historicalSessionId)).toEqual([]);
      };

      try {
        await fs.mkdir(workspacePath, { recursive: true });
        await fs.mkdir(sessionsDir, { recursive: true });
        const header = (id: string, timestamp: string): JsonObject => ({
          type: "session",
          version: 3,
          id,
          cwd: workspacePath,
          timestamp,
        });
        let transcript = jsonl([
          header(sessionId, startedAt.toISOString()),
          ...commandTurn("call-failed", startedAt.toISOString(), true),
        ]);
        await fs.writeFile(transcriptPath, transcript);
        await fs.utimes(transcriptPath, startedAt, startedAt);
        const historicalTime = new Date(startedAt.getTime() - 24 * 60 * 60 * 1000);
        await fs.writeFile(
          historicalPath,
          jsonl([
            header(historicalSessionId, historicalTime.toISOString()),
            ...commandTurn("call-historical", historicalTime.toISOString(), false),
          ]),
        );
        await fs.utimes(historicalPath, historicalTime, historicalTime);

        await observer.start();
        await submission.entered.promise;
        expect(await cursorManager.getCursor(sessionId)).toBeNull();
        expect(uploaded).toEqual([]);
        submission.released.resolve();
        await handled.promise;
        await capture.flush(sessionId);
        await capture.waitForIdle();
        expect(await cursorManager.getCursor(sessionId)).toMatchObject({
          offset: Buffer.byteLength(transcript),
        });
        expect(uploaded.filter((event) => event.type === "tool_result")).toMatchObject([
          { sessionId, callId: "call-failed", toolName: "bash", isError: true },
        ]);

        // Move wall time without running periodic timers; each discovery poll is explicit.
        vi.setSystemTime(new Date(startedAt.getTime() + 61_000));
        await pollAndDrain();
        await pollAndDrain();
        await pollAndDrain();
        expect(
          uploaded.filter(
            (event) =>
              event.type === "session_lifecycle" &&
              (event.lifecycleType === "end" || event.lifecycleType === "crash"),
          ),
        ).toEqual([]);
        expect(tailer.getActiveSessions()).toContain(sessionId);
        await expectHistoricalUntouched();

        const exitTimestamp = new Date().toISOString();
        if (resumeAfter === "real exit") {
          const exit = jsonl([
            {
              type: "custom",
              customType: "session_exit",
              id: "real-exit-record",
              parentId: "call-failed-completion",
              timestamp: exitTimestamp,
              data: { reason: "dispose", kind: "normal", recordedAt: exitTimestamp },
            },
          ]);
          transcript += exit;
          await fs.appendFile(transcriptPath, exit);
          await fs.utimes(transcriptPath, new Date(exitTimestamp), new Date(exitTimestamp));
          await pollAndDrain();
          expect(tailer.getActiveSessions()).not.toContain(sessionId);
          expect(await cursorManager.getCursor(sessionId)).toMatchObject({
            offset: Buffer.byteLength(transcript),
          });
          await expectHistoricalUntouched();
        }
        vi.setSystemTime(new Date(startedAt.getTime() + 62_000));

        for (const callId of ["call-success-one", "call-success-two"]) {
          const previousCursor = await cursorManager.getCursor(sessionId);
          const appended = jsonl(commandTurn(callId, new Date().toISOString(), false));
          transcript += appended;
          await fs.appendFile(transcriptPath, appended);
          await fs.utimes(transcriptPath, new Date(), new Date());
          submission = submissionBarrier();
          handled = Promise.withResolvers<void>();
          const summary = await observer.pollOnce();
          expect(summary.errors).toEqual([]);
          await submission.entered.promise;
          expect(await cursorManager.getCursor(sessionId)).toEqual(previousCursor);
          expect(
            uploaded.filter((event) => event.type === "tool_result" && event.callId === callId),
          ).toEqual([]);
          submission.released.resolve();
          await handled.promise;
          await capture.flush(sessionId);
          await capture.waitForIdle();
          expect(await cursorManager.getCursor(sessionId)).toMatchObject({
            offset: Buffer.byteLength(transcript),
          });
          await pollAndDrain();
          await expectHistoricalUntouched();
        }

        await pollAndDrain();
        expect(
          uploaded
            .filter((event) => event.type === "tool_result")
            .map((event) => ({ callId: event.callId, isError: event.isError })),
        ).toEqual([
          { callId: "call-failed", isError: true },
          { callId: "call-success-one", isError: false },
          { callId: "call-success-two", isError: false },
        ]);
        expect(
          uploaded.filter(
            (event) =>
              event.type === "session_lifecycle" &&
              (event.lifecycleType === "end" || event.lifecycleType === "crash"),
          ),
        ).toMatchObject(
          resumeAfter === "real exit"
            ? [
                {
                  sessionId,
                  type: "session_lifecycle",
                  lifecycleType: "end",
                  timestamp: exitTimestamp,
                },
              ]
            : [],
        );
        expect(new Set(uploaded.map((event) => event.eventId)).size).toBe(uploaded.length);
        expect(uploaded.every((event) => event.sessionId === sessionId)).toBe(true);
        expect(client.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
        for (const event of uploaded) {
          expect(event.redaction.isRedacted).toBe(true);
          if (event.type === "message" || event.type === "tool_result") {
            expect(event.redaction.redactionStrategy).toBe("drop");
          }
        }
        const payload = JSON.stringify(uploaded);
        expect(payload).not.toContain("PRIVATE_PROMPT");
        expect(payload).not.toContain("PRIVATE_COMMAND_OUTPUT");
        expect(payload).not.toContain("PRIVATE_COMPLETION");
        await expectHistoricalUntouched();
      } finally {
        submission.released.resolve();
        await capture.waitForIdle();
        await observer.stop();
        capture.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
  );
});
