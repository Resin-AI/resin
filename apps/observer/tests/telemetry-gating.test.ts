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
  const observer = mockObserverCoordinator({
    registerAdapter: vi.fn(),
    onRecords: vi.fn(() => unsubscribe),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getAdapters: vi.fn(() => []),
    getDiagnostics: vi.fn(() => ({})),
    getTailer: vi.fn(() => ({
      getCursorManager: vi.fn(),
    })),
  });
  const capture = mockCaptureCoordinator({
    handleRecords: vi.fn(async (_session, _records, ack: () => Promise<void>) => ack()),
    setTelemetryEnabled: vi.fn(),
    getActiveSessionCount: vi.fn(() => 0),
    getFinalizedSessionCount: vi.fn(() => 0),
    getUnattributedSessionCount: vi.fn(() => 0),
    getGenericSessionCount: vi.fn(() => 0),
    getDiagnostics: vi.fn(() => ({})),
  });
  return { observer, capture, unsubscribe };
}

function createRuntimeModule<T>(telemetryEnabled: T) {
  const doubles = createCaptureDoubles();
  const module = new TrajectoryCaptureRuntimeModule({
    telemetryEnabled: Boolean(telemetryEnabled),
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
  };
}

function createUploadingCaptureDoubles() {
  const processBatch = vi.fn(async (records: RawHarnessRecord[]) =>
    records.map((record) => ({
      status: "success",
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
  const pipeline = mockPipeline({
    processBatch,
    commitCloudAcknowledgedEvents,
  });
  const sendObservationBatch = vi.fn(async () => undefined);
  const observationClient = mockCloudObservationClient({
    sendObservationBatch,
    sendTrajectoryObservationBatch: vi.fn(async () => undefined),
  });
  return mockRawRecord({
    pipeline,
    observationClient,
    processBatch,
    sendObservationBatch,
  });
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

async function createLiveFixture(initialTelemetryEnabled?: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-telemetry-gating-"));
  temporaryDirectories.push(home);
  const logger = createLogger();
  const config = DaemonConfigSchema.parse(
    initialTelemetryEnabled !== undefined ? { telemetryEnabled: initialTelemetryEnabled } : {},
  );
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
  it("automatically registers and starts trajectory capture when startup config has telemetryEnabled omitted (default-on) and cloud consent is affirmative", async () => {
    const logger = createLogger();
    const config = DaemonConfigSchema.parse({});
    const supervisor = new RecoveryAwareDaemonSupervisor({
      config,
      paths: resolvePaths({ home: os.tmpdir() }),
      logger,
      enableSignalHandlers: false,
    });
    supervisor.registerModule(createPersistentModule("cloud-runtime").module);
    const { module, observer } = createRuntimeModule(true);
    const controller = new TelemetryCaptureController({
      supervisor,
      captureModule: module,
      logger,
      deviceEnabled: undefined,
      getCloudConsentEnabled: () => true,
    });

    controller.prepareForStartup();

    expect(supervisor.getModule("trajectory-capture")).toBe(module);
    expect(controller.getStatus()).toMatchObject({
      deviceEnabled: true,
      cloudConsentEnabled: true,
      effectiveEnabled: true,
      captureActive: false,
    });

    await supervisor.start();
    expect(observer.start).toHaveBeenCalledOnce();
    expect(controller.getStatus().captureActive).toBe(true);
    await supervisor.stop({ reason: "test cleanup" });
  });

  it("does not register or start capture when device telemetry is enabled but cloud consent is missing or absent", async () => {
    const logger = createLogger();
    const config = DaemonConfigSchema.parse({});
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
      getCloudConsentEnabled: () => undefined,
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
    const credentialStore: Parameters<typeof readCloudTelemetryConsent>[0]["credentialStore"] = {
      getRequestIdentity: vi.fn(async () => ({
        cloudUrl: "https://cloud.example.test",
        accessToken: "access-token",
      })),
    };
    const fetchImpl: typeof fetch = vi.fn(
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
    );
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

  it("resolves device telemetry enabled correctly across boolean, missing, and invalid types", () => {
    expect(resolveDeviceTelemetryEnabled(undefined)).toBe(true);
    expect(resolveDeviceTelemetryEnabled(true)).toBe(true);
    expect(resolveDeviceTelemetryEnabled(false)).toBe(false);

    expect(resolveDeviceTelemetryEnabled(undefined, true)).toBe(false);
    expect(resolveDeviceTelemetryEnabled(true, true)).toBe(false);
    expect(resolveDeviceTelemetryEnabled(false, true)).toBe(false);

    expect(resolveDeviceTelemetryEnabled("true")).toBe(false);
    expect(resolveDeviceTelemetryEnabled("false")).toBe(false);
    expect(resolveDeviceTelemetryEnabled(null)).toBe(false);
    expect(resolveDeviceTelemetryEnabled({})).toBe(false);
    expect(resolveDeviceTelemetryEnabled(0)).toBe(false);
  });

  it("handles reload from default-on config to explicit false and re-enable", async () => {
    const fixture = await createLiveFixture(undefined);
    try {
      expect(fixture.supervisor.getModule("trajectory-capture")).toBe(fixture.captureModule);
      expect(fixture.doubles.observer.start).toHaveBeenCalledOnce();
      expect(fixture.captureController.getStatus()).toMatchObject({
        deviceEnabled: true,
        cloudConsentEnabled: true,
        effectiveEnabled: true,
        captureActive: true,
      });

      const disabled = await fixture.client.reloadConfig({ telemetryEnabled: false });
      expect(disabled.success).toBe(true);
      expect(fixture.supervisor.getModule("trajectory-capture")).toBe(fixture.captureModule);
      expect(fixture.doubles.observer.stop).toHaveBeenCalled();
      expect(fixture.captureController.getStatus()).toMatchObject({
        deviceEnabled: false,
        effectiveEnabled: false,
        captureActive: false,
      });

      const reEnabled = await fixture.client.reloadConfig({ telemetryEnabled: true });
      expect(reEnabled.success).toBe(true);
      expect(fixture.supervisor.getModule("trajectory-capture")).toBe(fixture.captureModule);
      expect(fixture.captureController.getStatus()).toMatchObject({
        deviceEnabled: true,
        effectiveEnabled: true,
        captureActive: true,
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it("reports the packaged release version instead of a persisted config version", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-release-version-"));
    temporaryDirectories.push(home);
    const configPath = path.join(home, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ version: "0.1.0" }), { mode: 0o600 });

    const loaded = loadTelemetrySafeDaemonConfig({
      configPath,
      version: "1.0.19",
      env: {},
    });

    expect(loaded.warning).toBeUndefined();
    expect(loaded.config.version).toBe("1.0.19");
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
      version: "1.0.19",
      env: {},
      now: () => 123,
    });
    expect(invalidRecovery.config.version).toBe("1.0.19");
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
      version: "1.0.19",
      env: {},
    });
    expect(unreadableRecovery.config.version).toBe("1.0.19");
    expect(unreadableRecovery.config.telemetryEnabled).toBe(false);
    expect(unreadableRecovery.warning?.message).toContain("local-only mode");
  });

  it("makes zero normalization and telemetry network calls while disabled", async () => {
    const processBatch = vi.fn();
    const commitCloudAcknowledgedEvents = vi.fn();
    const pipeline = mockPipeline({
      processBatch,
      commitCloudAcknowledgedEvents,
    });
    const sendTrajectoryObservationBatch = vi.fn();
    const sendObservationBatch = vi.fn();
    const observationClient = mockCloudObservationClient({
      sendTrajectoryObservationBatch,
      sendObservationBatch,
    });
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient,
      isTelemetryEnabled: () => false,
    });
    const ack = vi.fn(async () => undefined);
    const session = mockHarnessSession({
      sessionId: "disabled-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

    await coordinator.handleRecords(session, [mockRawRecord()], ack);

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
    const pipeline = mockPipeline({
      processBatch,
      commitCloudAcknowledgedEvents: vi.fn(),
    });
    const sendObservationBatch = vi.fn();
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockCloudObservationClient({
        sendObservationBatch,
        sendTrajectoryObservationBatch: vi.fn(),
      }),
    });
    const ack = vi.fn(async () => undefined);
    const session = mockHarnessSession({
      sessionId: "in-flight-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

    const handling = coordinator.handleRecords(session, [mockRawRecord()], ack);
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
    const pipeline = mockPipeline({
      processBatch,
      commitCloudAcknowledgedEvents: vi.fn(),
    });
    const observationClient = mockCloudObservationClient({
      sendObservationBatch,
      sendTrajectoryObservationBatch: vi.fn(),
    });

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

    const session = mockHarnessSession({
      sessionId: "privacy-cutoff-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });
    const optedOutRecord = mockRawRecord({
      timestamp: new Date(2_000).toISOString(),
    });
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
    const restartIntervalRecord = mockRawRecord({
      timestamp: new Date(3_500).toISOString(),
    });
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
    const session = mockHarnessSession({
      sessionId: "remote-transition-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

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
    await module.getCaptureCoordinator().waitForIdle();
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
    const session = mockHarnessSession({
      sessionId: "remote-history-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

    remoteConsent = {
      metadataTelemetryEnabled: false,
      updatedAt,
    };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_000, 1)],
      vi.fn(async () => undefined),
    );
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
  it("recovers remote telemetry authorization after an unparsable consent snapshot", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-remote-unparsable-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    let nowMs = 1_000;
    const updatedAt = new Date(1_000).toISOString();
    const validConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt,
    };
    let currentConsent: unknown = validConsent;
    const logger = createLogger();
    const doubles = createUploadingCaptureDoubles();
    const module = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      logger,
      telemetryEnabled: true,
      remoteTelemetryConsent: validConsent,
      refreshRemoteTelemetryConsent: async () => currentConsent as RemoteTelemetryConsentSnapshot,
      privacyCheckpointPath,
      now: () => nowMs,
    });
    const session = mockHarnessSession({
      sessionId: "unparsable-recovery-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

    // Step 1: Unparsable snapshot arrives
    nowMs = 1_500;
    currentConsent = { invalidField: true };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 1_500, 1)],
      vi.fn(async () => undefined),
    );

    expect(doubles.processBatch).not.toHaveBeenCalled();
    expect(doubles.sendObservationBatch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteHistoryAvailable: false,
    });
    expect(logger.warn).toHaveBeenCalledWith("telemetry paused until consent is re-verified");

    // Another unparsable snapshot does not emit warn again
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 1_600, 2)],
      vi.fn(async () => undefined),
    );
    expect(logger.warn).toHaveBeenCalledOnce();

    // Step 2: Same valid snapshot arrives again at nowMs = 2_000
    nowMs = 2_000;
    currentConsent = validConsent;
    // Record before recovery (1_800 < 2_000) stays ineligible
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 1_800, 3)],
      vi.fn(async () => undefined),
    );
    expect(doubles.processBatch).not.toHaveBeenCalled();

    // Record after recovery (2_500 > 2_000) is authorized
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_500, 4)],
      vi.fn(async () => undefined),
    );
    await module.getCaptureCoordinator().waitForIdle();
    expect(doubles.processBatch).toHaveBeenCalledOnce();
    expect(doubles.sendObservationBatch).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteConsent: validConsent,
      remoteConsentCutoffMs: 2_000,
      remoteHistoryAvailable: true,
    });
    expect(logger.info).toHaveBeenCalledWith("telemetry resumed after consent is re-verified");
  });

  it("recovers remote telemetry authorization after an updatedAt regression", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-remote-regression-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    let nowMs = 2_000;
    const validConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(2_000).toISOString(),
    };
    let currentConsent: RemoteTelemetryConsentSnapshot = validConsent;
    const logger = createLogger();
    const doubles = createUploadingCaptureDoubles();
    const module = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      logger,
      telemetryEnabled: true,
      remoteTelemetryConsent: validConsent,
      refreshRemoteTelemetryConsent: async () => currentConsent,
      privacyCheckpointPath,
      now: () => nowMs,
    });
    const session = mockHarnessSession({
      sessionId: "regression-recovery-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

    // Step 1: updatedAt regression (1_000 < 2_000)
    nowMs = 2_500;
    currentConsent = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(1_000).toISOString(),
    };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_600, 1)],
      vi.fn(async () => undefined),
    );

    expect(doubles.processBatch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteHistoryAvailable: false,
    });
    expect(logger.warn).toHaveBeenCalledWith("telemetry paused until consent is re-verified");

    // Step 2: Later, same snapshot arrives again at nowMs = 3_000 -> recovers
    nowMs = 3_000;
    currentConsent = validConsent;
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 2_800, 2)],
      vi.fn(async () => undefined),
    );
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteConsent: validConsent,
      remoteConsentCutoffMs: 3_000,
      remoteHistoryAvailable: true,
    });
    expect(logger.info).toHaveBeenCalledWith("telemetry resumed after consent is re-verified");

    // Subsequent records after recovery cutoff (3_500 > 3_000) are authorized
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 3_500, 3)],
      vi.fn(async () => undefined),
    );
    await module.getCaptureCoordinator().waitForIdle();
    expect(doubles.processBatch).toHaveBeenCalledOnce();
    expect(doubles.sendObservationBatch).toHaveBeenCalledOnce();
  });

  it("advances cutoff as before when a newer updatedAt arrives after history was unavailable", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-remote-newer-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    let nowMs = 1_000;
    const initialConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(1_000).toISOString(),
    };
    let currentConsent: unknown = initialConsent;
    const logger = createLogger();
    const doubles = createUploadingCaptureDoubles();
    const module = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      logger,
      telemetryEnabled: true,
      remoteTelemetryConsent: initialConsent,
      refreshRemoteTelemetryConsent: async () => currentConsent as RemoteTelemetryConsentSnapshot,
      privacyCheckpointPath,
      now: () => nowMs,
    });
    const session = mockHarnessSession({
      sessionId: "newer-recovery-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

    // Make history unavailable with an unparsable snapshot
    nowMs = 1_500;
    currentConsent = { invalid: true };
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 1_500, 1)],
      vi.fn(async () => undefined),
    );
    expect(logger.warn).toHaveBeenCalledWith("telemetry paused until consent is re-verified");

    // Later snapshot with newer updatedAt: 4_000 (> nowMs 2_000 and > 1_000)
    nowMs = 2_000;
    const newerConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(4_000).toISOString(),
    };
    currentConsent = newerConsent;

    // Record at 3_500 is before cutoff 4_000 -> not authorized
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 3_500, 2)],
      vi.fn(async () => undefined),
    );
    expect(doubles.processBatch).not.toHaveBeenCalled();

    // Record at 4_500 is after cutoff 4_000 -> authorized
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 4_500, 3)],
      vi.fn(async () => undefined),
    );
    await module.getCaptureCoordinator().waitForIdle();
    expect(doubles.processBatch).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"))).toMatchObject({
      version: 2,
      remoteConsent: newerConsent,
      remoteConsentCutoffMs: 4_000,
      remoteHistoryAvailable: true,
    });
    expect(logger.info).toHaveBeenCalledWith("telemetry resumed after consent is re-verified");
  });

  it("recovers on first reconcile from a persisted checkpoint with remoteHistoryAvailable false", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-remote-checkpoint-recovery-"));
    temporaryDirectories.push(home);
    const privacyCheckpointPath = path.join(home, "telemetry-privacy-checkpoint.json");
    const storedConsent: RemoteTelemetryConsentSnapshot = {
      metadataTelemetryEnabled: true,
      updatedAt: new Date(1_000).toISOString(),
    };
    fs.writeFileSync(
      privacyCheckpointPath,
      JSON.stringify({
        version: 2,
        cutoffMs: 1_000,
        telemetryEnabled: true,
        remoteConsent: storedConsent,
        remoteConsentCutoffMs: 1_000,
        remoteHistoryAvailable: false,
      }),
    );

    const nowMs = 2_500;
    const logger = createLogger();
    const doubles = createUploadingCaptureDoubles();
    const module = new TrajectoryCaptureRuntimeModule({
      observerCoordinator: createCaptureDoubles().observer,
      normalizationPipeline: doubles.pipeline,
      observationClient: doubles.observationClient,
      adapters: [],
      decoders: [],
      logger,
      telemetryEnabled: true,
      remoteTelemetryConsent: storedConsent,
      refreshRemoteTelemetryConsent: async () => storedConsent,
      privacyCheckpointPath,
      now: () => nowMs,
    });
    const session = mockHarnessSession({
      sessionId: "checkpoint-recovery-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

    // Checkpoint should recover immediately on first reconcile (in constructor)
    // Cutoff should advance to nowMs (2_500)
    const checkpointAfterInit = JSON.parse(fs.readFileSync(privacyCheckpointPath, "utf8"));
    expect(checkpointAfterInit).toMatchObject({
      version: 2,
      remoteConsent: storedConsent,
      remoteConsentCutoffMs: 2_500,
      remoteHistoryAvailable: true,
    });
    expect(logger.info).toHaveBeenCalledWith("telemetry resumed after consent is re-verified");

    // Records after nowMs (3_000 > 2_500) are authorized
    await module.getCaptureCoordinator().handleRecords(
      session,
      [createTimestampedRecord(session.sessionId, 3_000, 1)],
      vi.fn(async () => undefined),
    );
    await module.getCaptureCoordinator().waitForIdle();
    expect(doubles.processBatch).toHaveBeenCalledOnce();
    expect(doubles.sendObservationBatch).toHaveBeenCalledOnce();
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
    const session = mockHarnessSession({
      sessionId: "remote-restart-session",
      workspaceId: "workspace",
      harnessId: "omp",
      status: "active",
    });

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

  it("enables and disables capture over tokenless local reload while local MCP stays ready", async () => {
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
function mockObserverCoordinator(obj: Partial<ObserverCoordinator>): ObserverCoordinator {
  // SAFETY: Test mock conforms to ObserverCoordinator contract for test execution.
  return obj as ObserverCoordinator;
}

function mockCaptureCoordinator(
  obj: Partial<TrajectoryCaptureCoordinator>,
): TrajectoryCaptureCoordinator {
  // SAFETY: Test mock conforms to TrajectoryCaptureCoordinator contract for test execution.
  return obj as TrajectoryCaptureCoordinator;
}

function mockPipeline(obj: Partial<NormalizationPipeline>): NormalizationPipeline {
  // SAFETY: Test mock conforms to NormalizationPipeline contract for test execution.
  return obj as NormalizationPipeline;
}

function mockCloudObservationClient(obj: Partial<CloudObservationClient>): CloudObservationClient {
  // SAFETY: Test mock conforms to CloudObservationClient contract for test execution.
  return obj as CloudObservationClient;
}

function mockHarnessSession(obj: Partial<HarnessSession> = {}): HarnessSession {
  const timestamp = new Date().toISOString();
  return {
    sessionId: "sess_test_1",
    workspaceId: "ws_test_1",
    harnessId: "omp",
    transcriptPath: "/tmp/sess_test_1.jsonl",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
    ...obj,
  };
}

function mockRawRecord(obj: Partial<RawHarnessRecord> = {}): RawHarnessRecord {
  const timestamp = new Date().toISOString();
  return {
    recordId: "rec_1",
    sessionId: "sess_test_1",
    harnessId: "omp",
    sequenceNumber: 1,
    timestamp,
    recordType: "transcript_line",
    rawPayload: {},
    cursor: { offset: 0, line: 1, sequence: 1, timestamp },
    metadata: {},
    ...obj,
  };
}
