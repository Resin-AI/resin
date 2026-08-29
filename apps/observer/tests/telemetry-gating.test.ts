import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrajectoryCaptureCoordinator } from "../src/analytics/capture-coordinator.js";
import {
  RecoveryAwareDaemonSupervisor,
  TelemetryCaptureController,
  createTelemetryReloadHandler,
  loadTelemetrySafeDaemonConfig,
  readCloudTelemetryConsent,
  resolveDeviceTelemetryEnabled,
} from "../src/bin/daemon.js";
import type { CloudObservationClient } from "../src/cloud-runtime.js";
import { type ConfigRecoveryWarning, DaemonConfigSchema, loadDaemonConfig } from "../src/config.js";
import { IpcClient } from "../src/ipc/client.js";
import { IpcServer } from "../src/ipc/server.js";
import { createInMemoryIpcPair } from "../src/ipc/transport.js";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleLifecycleState,
} from "../src/lifecycle.js";
import type { NormalizationPipeline } from "../src/normalization/pipeline.js";
import { resolvePaths } from "../src/paths.js";
import type { ObserverCoordinator } from "../src/tailing/coordinator.js";
import {
  type RemoteTelemetryConsentSnapshot,
  TrajectoryCaptureRuntimeModule,
} from "../src/trajectory-capture-module.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createModuleContext(logger = createLogger()): ModuleContext {
  const config = DaemonConfigSchema.parse({});
  return {
    config,
    paths: resolvePaths({ home: os.tmpdir() }),
    logger,
    getModule: () => undefined,
  };
}

function createCaptureDoubles() {
  const unsubscribe = vi.fn();
  const observer = {
    registerAdapter: vi.fn(),
    onRecords: vi.fn(() => unsubscribe),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getAdapters: vi.fn(() => []),
    getDiagnostics: vi.fn(() => ({})),
    getTailer: vi.fn(() => ({
      getCursorManager: vi.fn(),
    })),
  } as unknown as ObserverCoordinator;
  const capture = {
    handleRecords: vi.fn(async (_session, _records, ack: () => Promise<void>) => ack()),
    setTelemetryEnabled: vi.fn(),
    getActiveSessionCount: vi.fn(() => 0),
    getFinalizedSessionCount: vi.fn(() => 0),
    getUnattributedSessionCount: vi.fn(() => 0),
    getGenericSessionCount: vi.fn(() => 0),
    getDiagnostics: vi.fn(() => ({})),
  } as unknown as TrajectoryCaptureCoordinator;
  return { observer, capture, unsubscribe };
}

function createRuntimeModule(telemetryEnabled: unknown) {
  const doubles = createCaptureDoubles();
  const module = new TrajectoryCaptureRuntimeModule({
    telemetryEnabled: telemetryEnabled as boolean,
    observerCoordinator: doubles.observer,
    captureCoordinator: doubles.capture,
    adapters: [],
    decoders: [],
    logger: createLogger(),
  });
  return { module, ...doubles };
}

function createTimestampedRecord(
  sessionId: string,
  timestampMs: number,
  sequenceNumber: number,
): RawHarnessRecord {
  const timestamp = new Date(timestampMs).toISOString();
  return {
    recordId: `record_${sequenceNumber}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber,
    timestamp,
    recordType: "prompt",
    rawPayload: {},
    cursor: {
      offset: sequenceNumber,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  } as RawHarnessRecord;
}

function createUploadingCaptureDoubles() {
  const processBatch = vi.fn(async (records: RawHarnessRecord[]) =>
    records.map((record) => ({
      status: "success" as const,
      isDuplicate: false,
      event: {
        eventId: `event_${record.sessionId}_${record.sequenceNumber}`,
        schemaVersion: "1.0.0",
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        causalRef: {
          causalSequence: record.sequenceNumber,
          turnIndex: 0,
          stepIndex: 0,
        },
        redaction: {
          isRedacted: false,
          redactedFields: [],
          redactionStrategy: "none",
          scrubbedPatterns: [],
        },
        type: "message",
        role: "user",
        content: "metadata-only test payload",
      },
    })),
  );
  const commitCloudAcknowledgedEvents = vi.fn(async () => undefined);
  const pipeline = {
    processBatch,
    commitCloudAcknowledgedEvents,
  } as unknown as NormalizationPipeline;
  const sendObservationBatch = vi.fn(async () => undefined);
  const observationClient = {
    sendObservationBatch,
    sendTrajectoryObservationBatch: vi.fn(async () => undefined),
  } as unknown as CloudObservationClient;
  return {
    pipeline,
    observationClient,
    processBatch,
    sendObservationBatch,
  };
}

function createPersistentModule(id: string) {
  let state: ModuleLifecycleState = "uninitialized";
  const start = vi.fn(async () => {
    state = "ready";
  });
  const stop = vi.fn(async () => {
    state = "stopped";
  });
  const module: DaemonModule = {
    id,
    name: id,
    dependencies: [],
    start,
    stop,
    getState: () => state,
  };
  return { module, start, stop };
}

async function createLiveFixture(initialTelemetryEnabled: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-telemetry-gating-"));
  temporaryDirectories.push(home);
  const logger = createLogger();
  const config = DaemonConfigSchema.parse({ telemetryEnabled: initialTelemetryEnabled });
  const supervisor = new RecoveryAwareDaemonSupervisor({
    config,
    paths: resolvePaths({ home }),
    logger,
    enableSignalHandlers: false,
  });
  const cloud = createPersistentModule("cloud-runtime");
  const localMcp = createPersistentModule("local-mcp-runtime");
  supervisor.registerModule(cloud.module);
  supervisor.registerModule(localMcp.module);

  const doubles = createCaptureDoubles();
  const captureModule = new TrajectoryCaptureRuntimeModule({
    telemetryEnabled: initialTelemetryEnabled,
    observerCoordinator: doubles.observer,
    captureCoordinator: doubles.capture,
    adapters: [],
    decoders: [],
    logger,
  });
  const captureController = new TelemetryCaptureController({
    supervisor,
    captureModule,
    logger,
    deviceEnabled: initialTelemetryEnabled,
    getCloudConsentEnabled: () => true,
  });
  captureController.prepareForStartup();
  supervisor.setTelemetryStatusProvider(() => captureController.getStatus());
  await supervisor.start();

  const reloadConfig = createTelemetryReloadHandler({
    supervisor,
    captureController,
    loadConfig: () => ({ config: supervisor.getConfig() }),
    logger,
  });
  const server = new IpcServer({
    supervisor,
    authToken: "telemetry-test-token",
    socketPath: "",
    tokenFilePath: "",
    logger,
    reloadConfig,
  });
  await server.start();
  const { serverTransport, clientTransport } = createInMemoryIpcPair();
  server.attachTransport(serverTransport);
  const client = new IpcClient({
    transport: clientTransport,
    authToken: "telemetry-test-token",
  });

  const cleanup = async () => {
    await client.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await supervisor.stop({ reason: "telemetry gating test cleanup" }).catch(() => undefined);
  };

  return {
    supervisor,
    captureController,
    captureModule,
    localMcp,
    doubles,
    server,
    client,
    reloadConfig,
    cleanup,
  };
}

describe("observer telemetry gating", () => {
  it("does not register or start trajectory tailing when startup config is false", async () => {
    const logger = createLogger();
    const config = DaemonConfigSchema.parse({ telemetryEnabled: false });
    const supervisor = new RecoveryAwareDaemonSupervisor({
      config,
      paths: resolvePaths({ home: os.tmpdir() }),
      logger,
      enableSignalHandlers: false,
    });
    const { module, observer } = createRuntimeModule(false);
    const controller = new TelemetryCaptureController({
      supervisor,
      captureModule: module,
      logger,
      deviceEnabled: false,
      getCloudConsentEnabled: () => true,
    });

    controller.prepareForStartup();
    await module.start(createModuleContext(logger));

    expect(supervisor.getModule("trajectory-capture")).toBeUndefined();
    expect(observer.onRecords).not.toHaveBeenCalled();
    expect(observer.start).not.toHaveBeenCalled();
    expect(controller.getStatus()).toMatchObject({
      deviceEnabled: false,
      cloudConsentEnabled: true,
      effectiveEnabled: false,
      captureActive: false,
    });
  });

  it("requires affirmative account consent and treats an absent consent source as unknown", () => {
    const logger = createLogger();
    const config = DaemonConfigSchema.parse({ telemetryEnabled: true });
    const supervisor = new RecoveryAwareDaemonSupervisor({
      config,
      paths: resolvePaths({ home: os.tmpdir() }),
      logger,
      enableSignalHandlers: false,
    });
    const { module, observer } = createRuntimeModule(true);
    const controller = new TelemetryCaptureController({
      supervisor,
      captureModule: module,
      logger,
      deviceEnabled: true,
    });

    controller.prepareForStartup();

    expect(supervisor.getModule("trajectory-capture")).toBeUndefined();
    expect(observer.start).not.toHaveBeenCalled();
    expect(controller.getStatus()).toMatchObject({
      deviceEnabled: true,
      cloudConsentEnabled: null,
      effectiveEnabled: false,
      captureActive: false,
    });
  });

  it("preserves the authoritative cloud privacy transition timestamp", async () => {
    const updatedAt = "2026-08-28T12:34:56.789Z";
    const credentialStore = {
      getRequestIdentity: vi.fn(async () => ({
        cloudUrl: "https://cloud.example.test",
        accessToken: "access-token",
      })),
    } as unknown as Parameters<typeof readCloudTelemetryConsent>[0]["credentialStore"];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            metadataTelemetryEnabled: true,
            updatedAt,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    await expect(readCloudTelemetryConsent({ credentialStore, fetchImpl })).resolves.toEqual({
      metadataTelemetryEnabled: true,
      updatedAt,
    });
  });

  it("treats false and invalid telemetry environment values as disabled", () => {
    const explicitFalse = loadDaemonConfig({
      env: { RESIN_TELEMETRY_ENABLED: "false" },
    });
    const invalid = loadDaemonConfig({
      env: { RESIN_TELEMETRY_ENABLED: "not-a-boolean" },
    });

    expect(explicitFalse.telemetryEnabled).toBe(false);
    expect(invalid.telemetryEnabled).toBe(false);
    expect(resolveDeviceTelemetryEnabled(explicitFalse.telemetryEnabled)).toBe(false);
    expect(resolveDeviceTelemetryEnabled(invalid.telemetryEnabled)).toBe(false);
  });

  it("fails closed for malformed or schema-invalid config without starting a tailer", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-invalid-telemetry-"));
    temporaryDirectories.push(home);
    const malformedPath = path.join(home, "malformed.json");
    fs.writeFileSync(malformedPath, "{ definitely-not-json", { mode: 0o600 });
    const invalidSchemaPath = path.join(home, "invalid-schema.json");
    fs.writeFileSync(invalidSchemaPath, JSON.stringify({ telemetryEnabled: "yes" }), {
      mode: 0o600,
    });
    let warning: ConfigRecoveryWarning | undefined;
    const recovered = loadDaemonConfig({
      configPath: malformedPath,
      env: {},
      onWarning: (nextWarning) => {
        warning = nextWarning;
      },
    });
    const effective = resolveDeviceTelemetryEnabled(recovered.telemetryEnabled, Boolean(warning));
    const { module, observer } = createRuntimeModule(effective);

    await module.start(createModuleContext());

    expect(warning?.category).toBe("MALFORMED_CONFIG");
    expect(effective).toBe(false);
    expect(observer.onRecords).not.toHaveBeenCalled();
    expect(observer.start).not.toHaveBeenCalled();

    const invalidRecovery = loadTelemetrySafeDaemonConfig({
      configPath: invalidSchemaPath,
      env: {},
      now: () => 123,
    });
    expect(invalidRecovery.config.telemetryEnabled).toBe(false);
    expect(invalidRecovery.warning).toMatchObject({
      category: "MALFORMED_CONFIG",
      detectedAt: 123,
    });
    expect(invalidRecovery.warning?.message).not.toContain("yes");

    const unreadablePath = path.join(home, "unreadable-config");
    fs.mkdirSync(unreadablePath);
    const unreadableRecovery = loadTelemetrySafeDaemonConfig({
      configPath: unreadablePath,
      env: {},
    });
    expect(unreadableRecovery.config.telemetryEnabled).toBe(false);
    expect(unreadableRecovery.warning?.message).toContain("local-only mode");
  });

  it("makes zero normalization and telemetry network calls while disabled", async () => {
    const processBatch = vi.fn();
    const commitCloudAcknowledgedEvents = vi.fn();
    const pipeline = {
      processBatch,
      commitCloudAcknowledgedEvents,
    } as unknown as NormalizationPipeline;
    const sendTrajectoryObservationBatch = vi.fn();
    const sendObservationBatch = vi.fn();
    const observationClient = {
      sendTrajectoryObservationBatch,
      sendObservationBatch,
    } as unknown as CloudObservationClient;
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient,
      isTelemetryEnabled: () => false,
    });
    const ack = vi.fn(async () => undefined);
    const session = {
      sessionId: "disabled-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    } as HarnessSession;

    await coordinator.handleRecords(session, [{} as RawHarnessRecord], ack);

    expect(ack).toHaveBeenCalledOnce();
    expect(processBatch).not.toHaveBeenCalled();
    expect(commitCloudAcknowledgedEvents).not.toHaveBeenCalled();
    expect(sendTrajectoryObservationBatch).not.toHaveBeenCalled();
    expect(sendObservationBatch).not.toHaveBeenCalled();
  });

  it("closes the emitter boundary before an in-flight batch can make a network call", async () => {
    const pipelineStarted = Promise.withResolvers<void>();
    const releasePipeline = Promise.withResolvers<unknown[]>();
    const processBatch = vi.fn(async () => {
      pipelineStarted.resolve();
      return releasePipeline.promise;
    });
    const pipeline = {
      processBatch,
      commitCloudAcknowledgedEvents: vi.fn(),
    } as unknown as NormalizationPipeline;
    const sendObservationBatch = vi.fn();
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: {
        sendObservationBatch,
        sendTrajectoryObservationBatch: vi.fn(),
      } as unknown as CloudObservationClient,
    });
    const ack = vi.fn(async () => undefined);
    const session = {
      sessionId: "in-flight-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    } as HarnessSession;

    const handling = coordinator.handleRecords(session, [{} as RawHarnessRecord], ack);
    await pipelineStarted.promise;
    coordinator.setTelemetryEnabled(false);
    releasePipeline.resolve([{ status: "success", isDuplicate: false, event: {} }]);
    await handling;

    expect(sendObservationBatch).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("never backfills records from an opt-out interval, including after restart", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-privacy-cutoff-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    let nowMs = 1_000;
    const processBatch = vi.fn();
    const sendObservationBatch = vi.fn();
    const pipeline = {
      processBatch,
      commitCloudAcknowledgedEvents: vi.fn(),
    } as unknown as NormalizationPipeline;
    const observationClient = {
      sendObservationBatch,
      sendTrajectoryObservationBatch: vi.fn(),
    } as unknown as CloudObservationClient;

    const firstModule = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: pipeline,
      observationClient,
      adapters: [],
      decoders: [],
      telemetryEnabled: false,
      privacyCheckpointPath,
      now: () => nowMs,
    });
    nowMs = 3_000;
    expect(firstModule.setTelemetryEnabled(true)).toBe(true);

    const session = {
      sessionId: "privacy-cutoff-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    } as HarnessSession;
    const optedOutRecord = {
      timestamp: new Date(2_000).toISOString(),
    } as RawHarnessRecord;
    const firstAck = vi.fn(async () => undefined);
    await firstModule.getCaptureCoordinator().handleRecords(session, [optedOutRecord], firstAck);

    expect(firstAck).toHaveBeenCalledOnce();
    expect(processBatch).not.toHaveBeenCalled();
    expect(sendObservationBatch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      cutoffMs: 3_000,
      telemetryEnabled: true,
    });

    nowMs = 4_000;
    const restartedModule = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: pipeline,
      observationClient,
      adapters: [],
      decoders: [],
      telemetryEnabled: true,
      privacyCheckpointPath,
      now: () => nowMs,
    });
    const restartIntervalRecord = {
      timestamp: new Date(3_500).toISOString(),
    } as RawHarnessRecord;
    const restartAck = vi.fn(async () => undefined);
    await restartedModule
      .getCaptureCoordinator()
      .handleRecords(session, [restartIntervalRecord], restartAck);

    expect(restartAck).toHaveBeenCalledOnce();
    expect(processBatch).not.toHaveBeenCalled();
    expect(sendObservationBatch).not.toHaveBeenCalled();
  });

  it("rejects delayed records from a remote true-false-true consent interval", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-remote-consent-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    const firstEnabledAt = new Date(1_000).toISOString();
    let remoteConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt: firstEnabledAt,
    };
    const doubles = createUploadingCaptureDoubles();
    const module = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      telemetryEnabled: true,
      remoteTelemetryConsent: remoteConsent,
      refreshRemoteTelemetryConsent: async () => remoteConsent,
      privacyCheckpointPath,
      now: () => 1_000,
    });
    const session = {
      sessionId: "remote-transition-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    } as HarnessSession;

    remoteConsent = {
      metadataTelemetryEnabled: false,
      updatedAt: new Date(2_000).toISOString(),
    };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_500, 1)],
      vi.fn(async () => undefined),
    );

    remoteConsent = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(3_000).toISOString(),
    };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_500, 2)],
      vi.fn(async () => undefined),
    );

    expect(doubles.processBatch).not.toHaveBeenCalled();
    expect(doubles.sendObservationBatch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteConsent,
      remoteConsentCutoffMs: 3_000,
      remoteHistoryAvailable: true,
    });

    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 3_500, 3)],
      vi.fn(async () => undefined),
    );
    expect(doubles.processBatch).toHaveBeenCalledOnce();
    expect(doubles.sendObservationBatch).toHaveBeenCalledOnce();
  });

  it("fails closed when remote transition history is inconsistent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-remote-history-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    const updatedAt = new Date(1_000).toISOString();
    let remoteConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt,
    };
    const doubles = createUploadingCaptureDoubles();
    const module = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      telemetryEnabled: true,
      remoteTelemetryConsent: remoteConsent,
      refreshRemoteTelemetryConsent: async () => remoteConsent,
      privacyCheckpointPath,
      now: () => 1_000,
    });
    const session = {
      sessionId: "remote-history-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    } as HarnessSession;

    remoteConsent = {
      metadataTelemetryEnabled: false,
      updatedAt,
    };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_000, 1)],
      vi.fn(async () => undefined),
    );
    remoteConsent = {
      metadataTelemetryEnabled: true,
      updatedAt,
    };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_500, 2)],
      vi.fn(async () => undefined),
    );

    expect(doubles.processBatch).not.toHaveBeenCalled();
    expect(doubles.sendObservationBatch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteHistoryAvailable: false,
    });
  });

  it("keeps a remote opt-out cutoff across restart before delayed delivery", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-remote-restart-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    let remoteConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(1_000).toISOString(),
    };
    const doubles = createUploadingCaptureDoubles();
    const firstModule = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      telemetryEnabled: true,
      remoteTelemetryConsent: remoteConsent,
      refreshRemoteTelemetryConsent: async () => remoteConsent,
      privacyCheckpointPath,
      now: () => 1_000,
    });
    const session = {
      sessionId: "remote-restart-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    } as HarnessSession;

    remoteConsent = {
      metadataTelemetryEnabled: false,
      updatedAt: new Date(2_000).toISOString(),
    };
    await firstModule.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_500, 1)],
      vi.fn(async () => undefined),
    );

    remoteConsent = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(3_000).toISOString(),
    };
    const restartedModule = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      telemetryEnabled: true,
      remoteTelemetryConsent: remoteConsent,
      refreshRemoteTelemetryConsent: async () => remoteConsent,
      privacyCheckpointPath,
      now: () => 1_500,
    });
    const restartAck = vi.fn(async () => undefined);
    await restartedModule
      .getCaptureCoordinator()
      .handleRecords(session, [createTimestampedRecord(session.sessionId, 2_500, 2)], restartAck);

    expect(restartAck).toHaveBeenCalledOnce();
    expect(doubles.processBatch).not.toHaveBeenCalled();
    expect(doubles.sendObservationBatch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteConsent,
      remoteConsentCutoffMs: 3_000,
      remoteHistoryAvailable: true,
    });
  });

  it("enables and disables capture over authenticated reload while local MCP stays ready", async () => {
    const fixture = await createLiveFixture(false);
    try {
      expect(fixture.supervisor.getModule("trajectory-capture")).toBeUndefined();
      expect(fixture.doubles.observer.start).not.toHaveBeenCalled();

      const enabled = await fixture.client.reloadConfig({ telemetryEnabled: true });
      expect(enabled.success).toBe(true);
      expect(fixture.supervisor.getModule("trajectory-capture")).toBe(fixture.captureModule);
      expect(fixture.doubles.observer.start).toHaveBeenCalledOnce();
      expect((await fixture.client.getHealth()).telemetry).toMatchObject({
        deviceEnabled: true,
        cloudConsentEnabled: true,
        effectiveEnabled: true,
        captureActive: true,
        failClosed: false,
      });
      expect(fixture.supervisor.getModuleStatus("trajectory-capture")).toMatchObject([
        { id: "trajectory-capture", state: "ready" },
      ]);

      const { serverTransport, clientTransport } = createInMemoryIpcPair();
      fixture.server.attachTransport(serverTransport);
      const unauthorizedClient = new IpcClient({
        transport: clientTransport,
        authToken: "wrong-token",
      });
      await expect(unauthorizedClient.reloadConfig({ telemetryEnabled: false })).rejects.toThrow(
        /Unauthorized/,
      );
      expect(fixture.captureModule.isTelemetryEnabled()).toBe(true);
      await unauthorizedClient.close();

      const disabled = await fixture.client.reloadConfig({ telemetryEnabled: false });
      expect(disabled.success).toBe(true);
      expect(fixture.doubles.unsubscribe).toHaveBeenCalled();
      expect(fixture.doubles.observer.stop).toHaveBeenCalledOnce();
      expect((await fixture.client.getHealth()).telemetry).toMatchObject({
        deviceEnabled: false,
        effectiveEnabled: false,
        captureActive: false,
      });
      expect(fixture.supervisor.getModuleStatus("trajectory-capture")).toMatchObject([
        { id: "trajectory-capture", state: "stopped" },
      ]);
      expect(fixture.localMcp.module.getState()).toBe("ready");
      expect(fixture.localMcp.stop).not.toHaveBeenCalled();
      await expect(fixture.client.ping("mcp-continuity")).resolves.toMatchObject({
        pong: true,
        nonce: "mcp-continuity",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes concurrent reloads so the last accepted write wins", async () => {
    const fixture = await createLiveFixture(true);
    try {
      const releaseReload = Promise.withResolvers<void>();
      const originalReload = fixture.supervisor.reloadConfig.bind(fixture.supervisor);
      const reloadSpy = vi
        .spyOn(fixture.supervisor, "reloadConfig")
        .mockImplementation(async (update) => {
          await releaseReload.promise;
          return originalReload(update);
        });

      const first = fixture.client.reloadConfig({ telemetryEnabled: false });
      const second = fixture.client.reloadConfig({ telemetryEnabled: true });
      await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledOnce());

      expect(fixture.captureModule.isTelemetryEnabled()).toBe(false);
      releaseReload.resolve();

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(reloadSpy).toHaveBeenCalledTimes(2);
      expect(fixture.supervisor.getConfig().telemetryEnabled).toBe(true);
      expect(fixture.captureController.getStatus()).toMatchObject({
        effectiveEnabled: true,
        captureActive: true,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not drop a disable queued behind an in-flight enable", async () => {
    const fixture = await createLiveFixture(false);
    try {
      const releaseReload = Promise.withResolvers<void>();
      const originalReload = fixture.supervisor.reloadConfig.bind(fixture.supervisor);
      const reloadSpy = vi
        .spyOn(fixture.supervisor, "reloadConfig")
        .mockImplementation(async (update) => {
          await releaseReload.promise;
          return originalReload(update);
        });

      const enable = fixture.client.reloadConfig({ telemetryEnabled: true });
      const disable = fixture.client.reloadConfig({ telemetryEnabled: false });
      await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledOnce());
      releaseReload.resolve();

      const [enableResult, disableResult] = await Promise.all([enable, disable]);
      expect(enableResult.success).toBe(true);
      expect(disableResult.success).toBe(true);
      expect(reloadSpy).toHaveBeenCalledTimes(2);
      expect(fixture.supervisor.getConfig().telemetryEnabled).toBe(false);
      expect(fixture.captureController.getStatus()).toMatchObject({
        effectiveEnabled: false,
        captureActive: false,
      });
      expect(fixture.localMcp.module.getState()).toBe("ready");
    } finally {
      await fixture.cleanup();
    }
  });
});
