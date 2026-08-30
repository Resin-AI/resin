import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeHarnessAdapter, ClaudeRecordDecoder } from "@resin/adapter-claude-code";
import { CodexHarnessAdapter, CodexRecordDecoder } from "@resin/adapter-codex";
import { OmpHarnessAdapter, OmpRecordDecoder } from "@resin/adapter-omp";
import { type LocalStateStore, createLocalStateStore } from "@resin/db";
import type {
  HarnessAdapter,
  HarnessRecordDecoder,
  HarnessSession,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudObservationClient,
  CloudRuntimeModule,
  type DaemonConfig,
  DaemonConfigSchema,
  type DaemonPaths,
  type Logger,
  type ModuleContext,
  NormalizationPipeline,
  ObserverCoordinator,
  type TrajectoryAttributionContextInput,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
  resolvePaths,
} from "../src/index.js";
import { SourceCursorManager } from "../src/tailing/cursor-manager.js";
import {
  TrajectoryCaptureRuntimeModule,
  resolveSessionAttribution,
} from "../src/trajectory-capture-module.js";

function mockCloudObservationClient(
  obj: Partial<CloudObservationClient> & {
    sendTrajectoryObservationBatch?: unknown;
    submitTrajectoryObservation?: unknown;
    sendObservationBatch?: unknown;
  },
): CloudObservationClient {
  // SAFETY: Test mock inherits CloudObservationClient prototype and assigns test doubles.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  return Object.assign(client, obj);
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockModuleContext(
  modules: Record<
    string,
    | DaemonModule
    | { readonly id?: string; readonly getObservationClient?: () => CloudObservationClient }
  > = {},
): ModuleContext {
  const config = DaemonConfigSchema.parse({});
  const paths = resolvePaths({ home: os.tmpdir() });
  return {
    config,
    paths,
    logger: createMockLogger(),
    getModule: <T>(id: string): T | undefined => {
      const mod = modules[id];
      if (mod === undefined) return undefined;
      // SAFETY: Test module registry returns registered mock module instance.
      return mod as T;
    },
  };
}

function createValidAttribution(
  overrides: Partial<TrajectoryAttributionContextInput> = {},
): Traribution {
  return {
    accountId: "acc-calibration-test",
    workspaceId: "ws-calibration-test",
    ownerUserId: "user-evaluator-1",
    projectId: "proj-calibration-audit",
    candidateId: "cand-model-v3",
    toolId: "tool-res-eval",
    toolVersion: "1.2.0",
    workloadId: "workload-eval-batch-7",
    trajectoryId: `traj-${randomUUID().slice(0, 8)}`,
    runtimeVersion: "0.1.0",
    role: "candidate",
    ...overrides,
  };
}

type Traribution = TrajectoryAttributionContextInput;

describe("TrajectoryCaptureRuntimeModule", () => {
  describe("resolveSessionAttribution", () => {
    it("returns undefined when session metadata is missing", () => {
      const session: HarnessSession = {
        sessionId: "sess-1",
        workspaceId: "ws-1",
        harnessId: "claude-code",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(resolveSessionAttribution(session)).toBeUndefined();
    });

    it("returns undefined when session metadata is empty", () => {
      const session: HarnessSession = {
        sessionId: "sess-2",
        workspaceId: "ws-1",
        harnessId: "codex-cli",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };
      expect(resolveSessionAttribution(session)).toBeUndefined();
    });

    it("returns undefined when resinTrajectoryAttribution is not an object", () => {
      const session: HarnessSession = {
        sessionId: "sess-3",
        workspaceId: "ws-1",
        harnessId: "omp",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: "invalid-string",
        },
      };
      expect(resolveSessionAttribution(session)).toBeUndefined();
    });

    it("returns parsed context when resinTrajectoryAttribution is valid with required fields", () => {
      const valid = createValidAttribution({
        accountId: "acc-42",
        workspaceId: "ws-42",
        trajectoryId: "traj-42",
      });
      const session: HarnessSession = {
        sessionId: "sess-4",
        workspaceId: "ws-42",
        harnessId: "claude-code",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: valid,
        },
      };

      const result = resolveSessionAttribution(session);
      expect(result).toBeDefined();
      expect(result?.accountId).toBe("acc-42");
      expect(result?.workspaceId).toBe("ws-42");
      expect(result?.trajectoryId).toBe("traj-42");
      expect(result?.role).toBe("candidate");
      expect(result?.status).toBe("success");
      expect(result?.isEquivalent).toBe(false);
      expect(result?.catalogExposureTokens).toBe(0);
    });

    it("returns parsed context when resinTrajectoryAttribution contains optional fields", () => {
      const valid = createValidAttribution({
        parentTrajectoryId: "parent-traj-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        accountingVersion: "v1",
        role: "baseline",
        status: "failure",
        isEquivalent: true,
        catalogExposureTokens: 1500,
        metadata: { env: "staging", benchmark: "humaneval" },
      });
      const session: HarnessSession = {
        sessionId: "sess-5",
        workspaceId: "ws-1",
        harnessId: "codex-cli",
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: valid,
        },
      };

      const result = resolveSessionAttribution(session);
      expect(result).toBeDefined();
      expect(result?.parentTrajectoryId).toBe("parent-traj-1");
      expect(result?.provider).toBe("anthropic");
      expect(result?.model).toBe("claude-3-5-sonnet-20241022");
      expect(result?.role).toBe("baseline");
      expect(result?.status).toBe("failure");
      expect(result?.isEquivalent).toBe(true);
      expect(result?.catalogExposureTokens).toBe(1500);
      expect(result?.metadata).toEqual({ env: "staging", benchmark: "humaneval" });
    });

    it("returns undefined when resinTrajectoryAttribution has missing required fields", () => {
      const missingWorkload: Partial<TrajectoryAttributionContextInput> = {
        accountId: "acc-1",
        workspaceId: "ws-1",
        ownerUserId: "user-1",
        projectId: "proj-1",
        candidateId: "cand-1",
        toolId: "tool-1",
        toolVersion: "1.0.0",
        // missing workloadId
        trajectoryId: "traj-1",
        runtimeVersion: "0.1.0",
        role: "candidate",
      };
      const session: HarnessSession = {
        sessionId: "sess-6",
        workspaceId: "ws-1",
        harnessId: "omp",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: missingWorkload,
        },
      };
      expect(resolveSessionAttribution(session)).toBeUndefined();
    });

    it("returns undefined when resinTrajectoryAttribution has unrecognized extra fields (strict schema)", () => {
      const withExtra = {
        ...createValidAttribution(),
        unauthorizedField: "hacker-payload",
      };
      const session: HarnessSession = {
        sessionId: "sess-7",
        workspaceId: "ws-1",
        harnessId: "claude-code",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: withExtra,
        },
      };
      expect(resolveSessionAttribution(session)).toBeUndefined();
    });

    it("returns undefined when resinTrajectoryAttribution has invalid field types or values", () => {
      const invalid = {
        ...createValidAttribution(),
        catalogExposureTokens: -10, // negative is invalid
      };
      const session: HarnessSession = {
        sessionId: "sess-8",
        workspaceId: "ws-1",
        harnessId: "codex-cli",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: invalid,
        },
      };
      expect(resolveSessionAttribution(session)).toBeUndefined();
    });
  });

  describe("Constructor & Default Registrations", () => {
    it("registers all three default adapters and decoders on construction", () => {
      const module = new TrajectoryCaptureRuntimeModule();

      expect(module.id).toBe("trajectory-capture");
      expect(module.critical).toBe(false);
      expect(module.dependencies).toContain("cloud-runtime");

      // Verify default adapters
      const adapters = module.getAdapters();
      expect(adapters.length).toBe(3);
      const adapterIds = adapters.map((a) => a.id);
      expect(adapterIds).toContain("claude-code");
      expect(adapterIds).toContain("codex-cli");
      expect(adapterIds).toContain("omp");

      // Verify coordinator has adapters registered
      const coordinatorAdapters = module.getObserverCoordinator().getAdapters();
      expect(coordinatorAdapters.length).toBe(3);

      // Verify default decoders
      const decoders = module.getDecoders();
      expect(decoders.length).toBe(3);
      const decoderHarnessIds = decoders.map((d) => d.harnessId);
      expect(decoderHarnessIds).toContain("claude-code");
      expect(decoderHarnessIds).toContain("codex-cli");
      expect(decoderHarnessIds).toContain("omp");
    });

    it("wires observerCoordinator.onRecords to captureCoordinator.handleRecords", async () => {
      const mockCoordinator = new ObserverCoordinator();
      const onRecordsSpy = vi.spyOn(mockCoordinator, "onRecords");

      const module = new TrajectoryCaptureRuntimeModule({
        observerCoordinator: mockCoordinator,
      });

      expect(onRecordsSpy).toHaveBeenCalledWith(module.getCaptureCoordinator().handleRecords);
    });

    it("supports constructor injection of custom adapters and decoders", () => {
      const customAdapter: HarnessAdapter = {
        id: "custom-harness",
        name: "Custom Harness",
        version: "1.0.0",
        capabilities: {
          discovery: { autoDiscover: false, searchPaths: [] },
          watch: { filePatterns: [] },
          injection: { supported: false },
          fidelity: "custom",
        },
        discoverWorkspaces: vi.fn().mockResolvedValue([]),
        discoverSessions: vi.fn().mockResolvedValue([]),
        createEventSource: vi.fn(),
      };

      const customDecoder: HarnessRecordDecoder = {
        harnessId: "custom-harness",
        decoderVersion: "1.0.0",
        decode: vi.fn().mockReturnValue([]),
      };

      const module = new TrajectoryCaptureRuntimeModule({
        adapters: [customAdapter],
        decoders: [customDecoder],
      });

      expect(module.getAdapters().map((a) => a.id)).toEqual(["custom-harness"]);
      expect(module.getDecoders().map((d) => d.harnessId)).toEqual(["custom-harness"]);
    });
  });

  describe("Lifecycle & Health Checks", () => {
    it("manages start and stop lifecycle cleanly", async () => {
      const module = new TrajectoryCaptureRuntimeModule();
      expect(module.getState()).toBe("uninitialized");

      const context = createMockModuleContext();
      await module.start(context);
      expect(module.getState()).toBe("ready");

      const health = await module.healthCheck();
      expect(health.status).toBe("ready");
      expect(health.details?.state).toBe("ready");
      expect(health.details?.adaptersCount).toBe(3);

      const diagnostics = await module.getDiagnostics();
      expect(diagnostics.id).toBe("trajectory-capture");
      expect(diagnostics.state).toBe("ready");

      await module.stop(context);
      expect(module.getState()).toBe("stopped");

      const stoppedHealth = await module.healthCheck();
      expect(stoppedHealth.status).toBe("offline");
    });

    it("is idempotent on redundant start and stop calls", async () => {
      const module = new TrajectoryCaptureRuntimeModule();
      const context = createMockModuleContext();

      await module.start(context);
      await module.start(context);
      expect(module.getState()).toBe("ready");

      await module.stop(context);
      await module.stop(context);
      expect(module.getState()).toBe("stopped");
    });
  });

  describe("Cloud Dependency & Observation Client Resolution", () => {
    it("resolves observation client dynamically from CloudRuntimeModule in start()", async () => {
      const mockObservationClient = new CloudObservationClient();
      const mockCloudModule = {
        id: "cloud-runtime",
        getObservationClient: vi.fn().mockReturnValue(mockObservationClient),
      };

      const module = new TrajectoryCaptureRuntimeModule();
      const context = createMockModuleContext({
        "cloud-runtime": mockCloudModule,
      });

      await module.start(context);
      expect(mockCloudModule.getObservationClient).toHaveBeenCalled();
      expect(module.getObservationClient()).toBe(mockObservationClient);
      await module.stop(context);
    });

    it("uses getObservationClient factory when injected in constructor", async () => {
      const mockObservationClient = new CloudObservationClient();
      const getObsClient = vi.fn().mockReturnValue(mockObservationClient);

      const module = new TrajectoryCaptureRuntimeModule({
        getObservationClient: getObsClient,
      });

      const client = module.getObservationClient();
      expect(client).toBe(mockObservationClient);
      expect(getObsClient).toHaveBeenCalled();
    });

    it("uses directly passed observationClient when provided", () => {
      const mockObservationClient = new CloudObservationClient();
      const module = new TrajectoryCaptureRuntimeModule({
        observationClient: mockObservationClient,
      });

      expect(module.getObservationClient()).toBe(mockObservationClient);
    });
  });

  describe("Attribution & Submission Filtering", () => {
    let mockSubmit: Mock;
    let mockSendObservationBatch: Mock;
    let mockClient: CloudObservationClient;

    beforeEach(() => {
      mockSubmit = vi.fn().mockResolvedValue({
        batchId: "batch-res-1",
        status: "accepted",
        persistedAt: new Date().toISOString(),
      });
      mockSendObservationBatch = vi.fn().mockResolvedValue({
        batchId: "batch-obs-1",
        status: "accepted",
        acceptedCount: 1,
        rejectedCount: 0,
        errors: [],
      });
      mockClient = mockCloudObservationClient({
        sendTrajectoryObservationBatch: mockSubmit,
        submitTrajectoryObservation: mockSubmit,
        sendObservationBatch: mockSendObservationBatch,
      });
    });

    it("processes and submits observation batch for ordinary sessions without attribution metadata", async () => {
      const module = new TrajectoryCaptureRuntimeModule({
        observationClient: mockClient,
        now: () => 1,
      });

      const captureCoordinator = module.getCaptureCoordinator();
      const ordinarySession: HarnessSession = {
        sessionId: "sess-ordinary-1",
        workspaceId: "ws-1",
        harnessId: "claude-code",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          someOtherKey: "unrelated-value",
        },
      };

      const rawRecord: RawHarnessRecord = {
        recordId: "rec-1",
        harnessId: "claude-code",
        sourcePath: "/tmp/claude.jsonl",
        rawPayload: JSON.stringify({
          type: "message",
          role: "user",
          content: "hello",
        }),
        timestamp: new Date().toISOString(),
      };

      const ack = vi.fn().mockResolvedValue(undefined);
      await captureCoordinator.handleRecords(ordinarySession, [rawRecord], ack);

      expect(ack).toHaveBeenCalled();
      expect(mockSubmit).not.toHaveBeenCalled();
      expect(mockSendObservationBatch).toHaveBeenCalledTimes(1);
      expect(captureCoordinator.isSessionUnattributed("sess-ordinary-1")).toBe(true);
    });

    it("processes and submits observation batch for malformed attribution metadata without trajectory submission", async () => {
      const module = new TrajectoryCaptureRuntimeModule({
        observationClient: mockClient,
        now: () => 1,
      });

      const captureCoordinator = module.getCaptureCoordinator();
      const malformedSession: HarnessSession = {
        sessionId: "sess-malformed-1",
        workspaceId: "ws-1",
        harnessId: "codex-cli",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: {
            accountId: 123, // invalid: should be string
          },
        },
      };

      const rawRecord: RawHarnessRecord = {
        recordId: "rec-2",
        harnessId: "codex-cli",
        sourcePath: "/tmp/codex.jsonl",
        rawPayload: JSON.stringify({
          type: "response_item",
          item: { type: "message", role: "assistant", content: [{ type: "text", text: "done" }] },
        }),
        timestamp: new Date().toISOString(),
      };

      const ack = vi.fn().mockResolvedValue(undefined);
      await captureCoordinator.handleRecords(malformedSession, [rawRecord], ack);

      expect(ack).toHaveBeenCalled();
      expect(mockSubmit).not.toHaveBeenCalled();
      expect(mockSendObservationBatch).toHaveBeenCalledTimes(1);
      expect(captureCoordinator.isSessionUnattributed("sess-malformed-1")).toBe(true);
    });

    it("processes and submits valid attributed calibration sessions when finalized", async () => {
      const validAttribution = createValidAttribution({
        accountId: "acc-target-1",
        workspaceId: "ws-target-1",
        trajectoryId: "traj-target-1",
        role: "candidate",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        accountingVersion: "claude-code-transcript-v1",
      });

      const module = new TrajectoryCaptureRuntimeModule({
        observationClient: mockClient,
        now: () => 1,
      });

      const captureCoordinator = module.getCaptureCoordinator();
      const session: HarnessSession = {
        sessionId: "sess-calib-1",
        workspaceId: "ws-target-1",
        harnessId: "claude-code",
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          resinTrajectoryAttribution: validAttribution,
        },
      };

      // Raw record that decodes to a valid event with completion
      const rawRecords: RawHarnessRecord[] = [
        {
          recordId: "rec-calib-1",
          harnessId: "claude-code",
          sourcePath: "/tmp/claude.jsonl",
          rawPayload: JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "text", text: "Evaluate tool" }],
            },
          }),
          timestamp: new Date().toISOString(),
        },
        {
          recordId: "rec-calib-2",
          harnessId: "claude-code",
          sourcePath: "/tmp/claude.jsonl",
          rawPayload: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Task completed successfully" }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 100,
                output_tokens: 50,
              },
            },
          }),
          timestamp: new Date().toISOString(),
        },
      ];

      const ack = vi.fn().mockResolvedValue(undefined);
      await captureCoordinator.handleRecords(session, rawRecords, ack);

      expect(ack).toHaveBeenCalled();
      expect(mockSubmit).toHaveBeenCalledTimes(1);

      // SAFETY: mockSubmit spy receives ObservationBatchRequest containing observations array.
      const submittedBatch = mockSubmit.mock.calls[0][0] as {
        observations: TrajectoryObservation[];
      };
      expect(submittedBatch.observations).toHaveLength(1);
      const submitted = submittedBatch.observations[0];
      expect(submitted.accountId).toBe("acc-target-1");
      expect(submitted.workspaceId).toBe("ws-target-1");
      expect(submitted.trajectoryId).toBe("traj-target-1");
      expect(submitted.role).toBe("candidate");
      expect(captureCoordinator.isSessionFinalized("sess-calib-1")).toBe(true);
    });
  });

  describe("Disk-backed StateStore & Module Restart Regression", () => {
    it("resumes tailing after full module recreation and does not replay acknowledged records", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "traj-restart-test-"));
      const stateDbPath = path.join(tmpDir, "state.db");
      const transcriptPath = path.join(tmpDir, "transcript.jsonl");

      try {
        const session: HarnessSession = {
          sessionId: "sess-restart-traj-1",
          workspaceId: "ws-restart-1",
          harnessId: "claude-code",
          transcriptPath,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Prepare records that arrive after the first observer has attached.
        const initialLines = [
          JSON.stringify({ type: "message", role: "user", content: "Pass 1 Message 1" }),
          JSON.stringify({ type: "message", role: "user", content: "Pass 1 Message 2" }),
          JSON.stringify({ type: "message", role: "user", content: "Pass 1 Message 3" }),
        ];
        fs.writeFileSync(transcriptPath, "");

        // Phase 1: First module run with persistent SQLite store
        const store1 = createLocalStateStore({ path: stateDbPath });
        await store1.initialize();
        const cursorManager1 = new SourceCursorManager({ store: store1 });

        let resolveBatch1: () => void;
        const pass1Promise = new Promise<void>((resolve) => {
          resolveBatch1 = resolve;
        });

        const pass1ReceivedObservations: unknown[] = [];
        const mockClient1 = mockCloudObservationClient({
          sendTrajectoryObservationBatch: vi.fn().mockResolvedValue({
            acceptedCount: 0,
            rejectedCount: 0,
            errors: [],
          }),
          submitTrajectoryObservation: vi.fn().mockResolvedValue({
            accepted: true,
          }),
          sendObservationBatch: vi
            .fn()
            .mockImplementation(async (batch: { observations: unknown[] }) => {
              pass1ReceivedObservations.push(...batch.observations);
              resolveBatch1();
              return {
                acceptedCount: batch.observations.length,
                rejectedCount: 0,
                errors: [],
              };
            }),
        });

        const module1 = new TrajectoryCaptureRuntimeModule({
          cursorManager: cursorManager1,
          observationClient: mockClient1,
          now: () => 1,
        });

        const context1 = createMockModuleContext();
        await module1.start(context1);

        // Attach session to module1's coordinator tailer
        await module1.getObserverCoordinator().getTailer().attachSession(session, undefined, {
          pollingIntervalMs: 10,
        });
        fs.appendFileSync(transcriptPath, `${initialLines.join("\n")}\n`);

        await pass1Promise;
        // Allow handling and acknowledgement to settle and stop module1 cleanly
        await module1.stop(context1);
        expect(pass1ReceivedObservations.length).toBeGreaterThanOrEqual(1);

        // Verify checkpoint committed in disk DB is at sequence 3
        const cursor1 = await cursorManager1.getCursor(session.sessionId);
        expect(cursor1).not.toBeNull();
        expect(cursor1?.sequence).toBe(3);
        store1.close();
        // Prepare records that arrive after the restarted observer has attached.
        const additionalLines = [
          JSON.stringify({ type: "message", role: "user", content: "Pass 2 Message 4" }),
          JSON.stringify({ type: "message", role: "user", content: "Pass 2 Message 5" }),
        ];

        // Phase 2: Complete recreation of process components from same state.db
        const store2 = createLocalStateStore({ path: stateDbPath });
        await store2.initialize();
        const cursorManager2 = new SourceCursorManager({ store: store2 });

        // Verify cursor survived complete restart on disk
        const recoveredCursor = await cursorManager2.getCursor(session.sessionId);
        expect(recoveredCursor?.sequence).toBe(3);

        let resolveBatch2: () => void;
        const pass2Promise = new Promise<void>((resolve) => {
          resolveBatch2 = resolve;
        });

        const pass2ReceivedObservations: unknown[] = [];
        const mockClient2 = mockCloudObservationClient({
          sendTrajectoryObservationBatch: vi.fn().mockResolvedValue({
            acceptedCount: 0,
            rejectedCount: 0,
            errors: [],
          }),
          submitTrajectoryObservation: vi.fn().mockResolvedValue({
            accepted: true,
          }),
          sendObservationBatch: vi
            .fn()
            .mockImplementation(async (batch: { observations: unknown[] }) => {
              pass2ReceivedObservations.push(...batch.observations);
              resolveBatch2();
              return {
                acceptedCount: batch.observations.length,
                rejectedCount: 0,
                errors: [],
              };
            }),
        });

        const module2 = new TrajectoryCaptureRuntimeModule({
          cursorManager: cursorManager2,
          observationClient: mockClient2,
          now: () => 1,
        });

        const context2 = createMockModuleContext();
        await module2.start(context2);

        await module2.getObserverCoordinator().getTailer().attachSession(session, undefined, {
          pollingIntervalMs: 10,
        });
        fs.appendFileSync(transcriptPath, `${additionalLines.join("\n")}\n`);
        await pass2Promise;
        await module2.stop(context2);

        // Only records appended after the restarted observer attaches may be submitted.
        expect(pass2ReceivedObservations).toHaveLength(additionalLines.length);
        // The privacy boundary skips history and begins a fresh local tailer sequence.
        const cursor2 = await cursorManager2.getCursor(session.sessionId);
        expect(cursor2?.sequence).toBe(additionalLines.length);
        store2.close();
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup error
        }
      }
    });
  });

  describe("OMP JSONL Ingestion & Local Storage Integration", () => {
    it("defaults to enabled when telemetryEnabled option is omitted on construction", async () => {
      const module = new TrajectoryCaptureRuntimeModule();
      expect(module.isTelemetryEnabled()).toBe(true);

      const context = createMockModuleContext();
      await module.start(context);
      expect(module.getState()).toBe("ready");
      await module.stop(context);
    });

    it("remains disabled when telemetryEnabled option is explicitly false", async () => {
      const module = new TrajectoryCaptureRuntimeModule({
        telemetryEnabled: false,
      });
      expect(module.isTelemetryEnabled()).toBe(false);

      const context = createMockModuleContext();
      await module.start(context);
      expect(module.getState()).toBe("stopped");
    });

    it("discovers, decodes, normalizes OMP JSONL transcript into local SQLite storage and acknowledges observation upload", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ingestion-test-"));
      const stateDbPath = path.join(tmpDir, "state.db");
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      let store: LocalStateStore | undefined;
      let module: TrajectoryCaptureRuntimeModule | undefined;
      let context: ModuleContext | undefined;

      try {
        store = createLocalStateStore({ path: stateDbPath });
        await store.initialize();

        const ompLines = [
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            harnessName: "omp",
            workspaceId: "ws-omp-integration-1",
            timestamp: "2026-08-17T10:00:00.000Z",
            sessionId: "sess-omp-integration-1",
          }),
          JSON.stringify({
            type: "message",
            role: "user",
            content: "Inspect repository and run qualification check",
            timestamp: "2026-08-17T10:00:01.000Z",
            sessionId: "sess-omp-integration-1",
          }),
          JSON.stringify({
            type: "model_reasoning",
            reasoningContent: "I will start by checking the codebase structure.",
            model: "gemini-3.7-flash",
            provider: "google",
            timestamp: "2026-08-17T10:00:02.000Z",
            sessionId: "sess-omp-integration-1",
          }),
          JSON.stringify({
            type: "tool_call",
            toolName: "read",
            callId: "call-101",
            parameters: { path: "src/index.ts" },
            timestamp: "2026-08-17T10:00:03.000Z",
            sessionId: "sess-omp-integration-1",
          }),
          JSON.stringify({
            type: "tool_result",
            toolName: "read",
            callId: "call-101",
            output: "export const version = '0.1.0';",
            timestamp: "2026-08-17T10:00:04.000Z",
            sessionId: "sess-omp-integration-1",
          }),
          JSON.stringify({
            type: "message",
            role: "assistant",
            content: "The version is 0.1.0 and checks passed.",
            timestamp: "2026-08-17T10:00:05.000Z",
            sessionId: "sess-omp-integration-1",
          }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "settle",
            role: "candidate",
            reason: "Completed qualification check",
            timestamp: "2026-08-17T10:00:06.000Z",
            sessionId: "sess-omp-integration-1",
          }),
        ];
        fs.writeFileSync(transcriptPath, "");

        const submittedBatches: Array<{
          batchId: string;
          observations: TrajectoryObservation[];
        }> = [];
        let uploadAcknowledged = false;

        const mockClient = mockCloudObservationClient({
          sendTrajectoryObservationBatch: vi.fn().mockImplementation(async (batch) => {
            submittedBatches.push(batch);
            uploadAcknowledged = true;
            return {
              acceptedCount: batch.observations.length,
              rejectedCount: 0,
              errors: [],
            };
          }),
          sendObservationBatch: vi.fn().mockImplementation(async (batch) => {
            submittedBatches.push(batch);
            uploadAcknowledged = true;
            return {
              acceptedCount: batch.observations.length,
              rejectedCount: 0,
              errors: [],
            };
          }),
          submitTrajectoryObservation: vi.fn().mockResolvedValue({ accepted: true }),
        });

        module = new TrajectoryCaptureRuntimeModule({
          store,
          observationClient: mockClient,
          now: () => 1,
        });

        context = createMockModuleContext();
        await module.start(context);

        const session: HarnessSession = {
          sessionId: "sess-omp-integration-1",
          workspaceId: "ws-omp-integration-1",
          harnessId: "omp",
          transcriptPath,
          status: "completed",
          createdAt: "2026-08-17T10:00:00.000Z",
          updatedAt: "2026-08-17T10:00:06.000Z",
          metadata: {
            resinTrajectoryAttribution: createValidAttribution({
              accountId: "acc-omp-integration-1",
              workspaceId: "ws-omp-integration-1",
              trajectoryId: "traj-omp-integration-1",
              provider: "google",
              model: "gemini-3.7-flash",
            }),
          },
        };

        fs.appendFileSync(transcriptPath, `${ompLines.join("\n")}\n`);
        const rawRecords: RawHarnessRecord[] = ompLines.map((rawPayload, index) => ({
          recordId: `omp-integration-${index + 1}`,
          harnessId: "omp",
          sourcePath: transcriptPath,
          rawPayload,
          timestamp: "2026-08-17T10:00:00.000Z",
        }));
        const cursorManager = module.getCursorManager();
        const ack = vi.fn(async () => {
          await cursorManager.commitCheckpoint(session.sessionId, {
            offset: fs.statSync(transcriptPath).size,
            line: ompLines.length,
            sequence: ompLines.length,
            timestamp: "2026-08-17T10:00:06.000Z",
          });
        });
        await module.getCaptureCoordinator().handleRecords(session, rawRecords, ack);
        await module.stop(context);

        expect(uploadAcknowledged).toBe(true);
        expect(submittedBatches.length).toBeGreaterThanOrEqual(1);

        const batch = submittedBatches[0];
        expect(batch.observations).toHaveLength(1);
        const observation = batch.observations[0];
        expect(observation.accountId).toBe("acc-omp-integration-1");
        expect(observation.workspaceId).toBe("ws-omp-integration-1");
        expect(observation.trajectoryId).toBe("traj-omp-integration-1");
        expect(observation.role).toBe("candidate");
        expect(observation.canonicalPayload).toBeDefined();

        const cursor = await cursorManager.getCursor(session.sessionId);
        expect(cursor).toBeDefined();
        expect(cursor?.sequence).toBe(ompLines.length);
        expect(cursor?.line).toBe(ompLines.length);
      } finally {
        if (module && context) {
          await module.stop(context).catch(() => undefined);
        }
        store?.close();
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup error
        }
      }
    });

    it("discovers, decodes, normalizes un-attributed OMP JSONL into generic observation upload and persists cursor", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-generic-test-"));
      const stateDbPath = path.join(tmpDir, "state.db");
      const transcriptPath = path.join(tmpDir, "session-generic.jsonl");

      try {
        const store = createLocalStateStore({ path: stateDbPath });
        await store.initialize();

        const ompLines = [
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            harnessName: "omp",
            workspaceId: "ws-omp-generic-1",
            timestamp: "2026-08-17T10:00:00.000Z",
            sessionId: "sess-omp-generic-1",
          }),
          JSON.stringify({
            type: "message",
            role: "user",
            content: "Check general repo status",
            timestamp: "2026-08-17T10:00:01.000Z",
            sessionId: "sess-omp-generic-1",
          }),
          JSON.stringify({
            type: "message",
            role: "assistant",
            content: "Everything is clean",
            timestamp: "2026-08-17T10:00:02.000Z",
            sessionId: "sess-omp-generic-1",
          }),
        ];
        fs.writeFileSync(transcriptPath, "");

        const submittedObservations: any[] = [];
        let uploadAcknowledged = false;

        const mockClient = mockCloudObservationClient({
          sendObservationBatch: vi.fn().mockImplementation(async (batch) => {
            submittedObservations.push(...batch.observations);
            uploadAcknowledged = true;
            return {
              acceptedCount: batch.observations.length,
              rejectedCount: 0,
              errors: [],
            };
          }),
        });

        const module = new TrajectoryCaptureRuntimeModule({
          store,
          observationClient: mockClient,
          now: () => 1,
        });

        const context = createMockModuleContext();
        await module.start(context);

        const session: HarnessSession = {
          sessionId: "sess-omp-generic-1",
          workspaceId: "ws-omp-generic-1",
          harnessId: "omp",
          transcriptPath,
          status: "active",
          createdAt: "2026-08-17T10:00:00.000Z",
          updatedAt: "2026-08-17T10:00:02.000Z",
          metadata: {},
        };

        const batchReceivedPromise = new Promise<void>((resolve) => {
          const original = mockClient.sendObservationBatch as Mock;
          mockClient.sendObservationBatch = vi.fn().mockImplementation(async (batch) => {
            const res = await original(batch);
            resolve();
            return res;
          });
        });

        await module.getObserverCoordinator().getTailer().attachSession(session, undefined, {
          pollingIntervalMs: 10,
        });
        fs.appendFileSync(transcriptPath, `${ompLines.join("\n")}\n`);
        await module.getObserverCoordinator().getTailer().pumpSession(session.sessionId);

        await batchReceivedPromise;
        await module.stop(context);

        expect(uploadAcknowledged).toBe(true);
        expect(submittedObservations.length).toBeGreaterThanOrEqual(1);

        const cursor = await module.getCursorManager().getCursor(session.sessionId);
        expect(cursor).toBeDefined();
        expect(cursor?.sequence).toBe(ompLines.length);
      } finally {
        try {
          await module.stop(context);
        } catch {
          // Ignore stop error
        }
        try {
          store.close();
        } catch {
          // Ignore close error
        }
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup error
        }
      }
    });
  });
});
