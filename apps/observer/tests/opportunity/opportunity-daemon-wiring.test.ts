import type { NormalizedSessionEvent, ProvenPatternDto } from "@resin/contracts";
import { createInMemoryStateStore, type LocalStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SessionEventSink,
  TrajectoryCaptureCoordinator,
} from "../../src/analytics/capture-coordinator.js";
import {
  createCaptureDependentRegistration,
  TelemetryCaptureController,
} from "../../src/bin/daemon.js";
import type { DaemonModule, Logger, ModuleContext, ModuleLifecycleState } from "../../src/lifecycle.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";
import { OpportunityTrackingModule } from "../../src/opportunity-module.js";
import { DaemonSupervisor } from "../../src/supervisor.js";
import type { TrajectoryCaptureRuntimeModule } from "../../src/trajectory-capture-module.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Minimal daemon module used to stand in for cloud-runtime and trajectory-capture. */
class StubModule implements DaemonModule {
  readonly dependencies = [] as const;
  private state: ModuleLifecycleState = "uninitialized";
  startCount = 0;

  constructor(
    readonly id: string,
    readonly name: string,
  ) {}

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    this.state = "ready";
  }

  async stop(): Promise<void> {
    this.state = "stopped";
  }
}

class StubCaptureModule extends StubModule {
  constructor(
    private readonly coordinator: TrajectoryCaptureCoordinator,
    private readonly telemetry: { enabled: boolean } = { enabled: true },
  ) {
    super("trajectory-capture", "Stub Trajectory Capture");
  }

  getCaptureCoordinator(): TrajectoryCaptureCoordinator {
    return this.coordinator;
  }

  setTelemetryEnabled(enabled: boolean): boolean {
    this.telemetry.enabled = enabled;
    return true;
  }

  isTelemetryEnabled(): boolean {
    return this.telemetry.enabled;
  }
}

function buildSessionEvent(sessionId: string, sequence: number): NormalizedSessionEvent {
  return {
    schemaVersion: "1.0.0",
    eventId: `evt_${sessionId}_${sequence}`,
    sessionId,
    timestamp: new Date(Date.parse("2026-03-03T08:00:00.000Z") + sequence * 1_000).toISOString(),
    type: "command_exec",
    command: `step-${sequence}`,
    args: [],
    exitCode: 0,
    durationMs: 500,
    causalRef: { causalSequence: sequence },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "drop",
      scrubbedPatterns: [],
      redactedAt: "2026-03-03T08:00:00.000Z",
    },
    metadata: { accountId: "acct_wiring", workspaceId: "ws_wiring" },
  } as unknown as NormalizedSessionEvent;
}

describe("OpportunityTrackingModule daemon wiring", () => {
  let store: LocalStateStore;
  let coordinator: TrajectoryCaptureCoordinator;

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    coordinator = new TrajectoryCaptureCoordinator({ pipeline: new NormalizationPipeline({}) });
  });

  afterEach(() => {
    store.close();
  });

  function buildHarness(enabled = true) {
    const supervisor = new DaemonSupervisor({
      logger: silentLogger,
      enableSignalHandlers: false,
    });
    const cloudRuntime = new StubModule("cloud-runtime", "Stub Cloud Runtime");
    const captureModule = new StubCaptureModule(coordinator);
    supervisor.registerModule(cloudRuntime);
    const opportunityModule = new OpportunityTrackingModule({
      store,
      logger: silentLogger,
      enabled,
    });
    const controller = new TelemetryCaptureController({
      supervisor,
      captureModule: captureModule as unknown as TrajectoryCaptureRuntimeModule,
      logger: silentLogger,
      deviceEnabled: true,
      getCloudConsentEnabled: () => true,
      onCaptureRegistered: createCaptureDependentRegistration({
        supervisor,
        module: opportunityModule,
        captureModuleId: captureModule.id,
        enabled,
        logger: silentLogger,
      }),
    });
    return { supervisor, captureModule, opportunityModule, controller };
  }

  it("registers and starts opportunity tracking in capture dependency order", async () => {
    const { supervisor, opportunityModule, controller } = buildHarness();
    const sinkSpy = vi.spyOn(coordinator, "setSessionEventSink");

    controller.prepareForStartup();
    // Capture registers at startup, which is what registers its dependent module.
    expect(supervisor.getModule("trajectory-capture")).toBeDefined();
    expect(supervisor.getModule(opportunityModule.id)).toBe(opportunityModule);

    // Starting proves the declared capture dependency resolves in topological order.
    await supervisor.start();
    expect(opportunityModule.getState()).toBe("ready");
    expect(sinkSpy).toHaveBeenCalledWith(expect.any(Function));

    const sink = sinkSpy.mock.calls.at(-1)?.[0] as SessionEventSink | undefined;
    const session = {
      sessionId: "sess_wiring_a",
      workspaceId: "ws_wiring",
      harnessId: "omp",
      transcriptPath: "/tmp/sess_wiring_a.jsonl",
      status: "completed" as const,
      createdAt: "2026-03-03T08:00:00.000Z",
      updatedAt: "2026-03-03T08:00:09.000Z",
      metadata: {},
    };
    const events = [1, 2, 3].map((sequence) => buildSessionEvent("sess_wiring_a", sequence));
    await sink?.(session, events, { isTerminal: false, isAttributed: true });
    await sink?.(session, [], { isTerminal: true, isAttributed: true });

    await supervisor.stop({ reason: "test" });
    expect(coordinator.setSessionEventSink).toHaveBeenLastCalledWith(undefined);
  });

  it("follows a runtime telemetry re-enable without double registration", async () => {
    const { supervisor, opportunityModule, controller } = buildHarness();
    await supervisor.start();

    // Capture was never registered at startup, so opportunity tracking stayed out of the graph.
    expect(supervisor.getModule(opportunityModule.id)).toBeUndefined();

    await controller.setDeviceTelemetryEnabled(true, { failClosed: false });

    expect(supervisor.getModule(opportunityModule.id)).toBe(opportunityModule);
    expect(opportunityModule.getState()).toBe("ready");
    await controller.setDeviceTelemetryEnabled(true, { failClosed: false });
    expect(supervisor.getModule(opportunityModule.id)).toBe(opportunityModule);
    await supervisor.stop({ reason: "test" });
  });

  it("stays out of the module graph when opportunity tracking is disabled", async () => {
    const { supervisor, opportunityModule, controller } = buildHarness(false);
    controller.prepareForStartup();
    await supervisor.start();
    expect(supervisor.getModule(opportunityModule.id)).toBeUndefined();
    await supervisor.stop({ reason: "test" });
  });
});
