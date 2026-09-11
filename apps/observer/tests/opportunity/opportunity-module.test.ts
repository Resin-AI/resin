import {
  type NormalizedSessionEvent,
  ProvenPatternDtoSchema,
  hashCanonicalContent,
} from "@resin/contracts";
import { createInMemoryStateStore, type LocalStateStore } from "@resin/db";
import type { HarnessSession } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SessionEventSink,
  TrajectoryCaptureCoordinator,
} from "../../src/analytics/capture-coordinator.js";
import type { ModuleContext } from "../../src/lifecycle.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";
import { OpportunityTrackingModule } from "../../src/opportunity-module.js";

const WORKSPACE_ID = "ws_opportunity_module";
const ACCOUNT_ID = "acct_opportunity_module";
const SYNTHESIS_COST_USD = 0.12;

const STEPS = ["tsc --noEmit", "vitest run", "biome check", "oxlint", "tsx scripts/build.ts"];

function buildWorkflowEvents(sessionId: string, timestampMs: number): NormalizedSessionEvent[] {
  return STEPS.map((step, index) => {
    const causalSequence = index + 1;
    const timestamp = new Date(timestampMs + index * 1_000).toISOString();
    return {
      schemaVersion: "1.0.0",
      eventId: `evt_${hashCanonicalContent({ sessionId, causalSequence }).slice(0, 24)}`,
      sessionId,
      timestamp,
      type: "command_exec",
      command: step,
      args: [],
      exitCode: 0,
      durationMs: 900,
      causalRef: { causalSequence },
      redaction: {
        isRedacted: true,
        redactedFields: [],
        redactionStrategy: "drop",
        scrubbedPatterns: [],
        redactedAt: timestamp,
      },
      metadata: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
      ...(index === STEPS.length - 1
        ? {
            providerUsage: {
              provider: "openai",
              accountingVersion: "1.0.0",
              availability: "complete",
              totalTokens: 5_000,
              costMicroUsd: 200_000,
              costProvenance: "source_reported",
              durationMs: 8_000,
            },
          }
        : {}),
    } as unknown as NormalizedSessionEvent;
  });
}

function buildTerminalEvent(sessionId: string, timestampMs: number): NormalizedSessionEvent {
  const causalSequence = STEPS.length + 1;
  const timestamp = new Date(timestampMs).toISOString();
  return {
    schemaVersion: "1.0.0",
    eventId: `evt_${hashCanonicalContent({ sessionId, causalSequence, terminal: true }).slice(0, 24)}`,
    sessionId,
    timestamp,
    type: "session_lifecycle",
    lifecycleType: "end",
    exitReason: "completed",
    causalRef: { causalSequence },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "drop",
      scrubbedPatterns: [],
      redactedAt: timestamp,
    },
    metadata: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
  } as unknown as NormalizedSessionEvent;
}

function buildHarnessSession(sessionId: string): HarnessSession {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: WORKSPACE_ID,
    harnessId: "omp",
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    status: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

describe("OpportunityTrackingModule", () => {
  let store: LocalStateStore;

  beforeEach(async () => {
    store = await createInMemoryStateStore();
  });

  afterEach(() => {
    store.close();
  });

  it("attaches to the capture stream and enqueues proven patterns into the local outbox", async () => {
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline: new NormalizationPipeline({}),
    });
    const sinkSpy = vi.spyOn(coordinator, "setSessionEventSink");
    const module = new OpportunityTrackingModule({
      store,
      synthesisCostUsd: SYNTHESIS_COST_USD,
    });
    const context = {
      config: { opportunityTracking: {} } as never,
      paths: {} as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getModule: <T,>(id: string) =>
        id === "trajectory-capture"
          ? ({ getCaptureCoordinator: () => coordinator } as unknown as T)
          : undefined,
    } as unknown as ModuleContext;

    await module.start(context);
    expect(module.getState()).toBe("ready");

    const sink = sinkSpy.mock.calls.at(-1)?.[0] as SessionEventSink | undefined;
    expect(sink).toBeTypeOf("function");

    const baseMs = Date.parse("2026-02-02T09:00:00.000Z");
    for (const [index, sessionId] of ["sess_mod_alpha", "sess_mod_bravo"].entries()) {
      const startedAt = baseMs + index * 60_000;
      const session = buildHarnessSession(sessionId);
      await sink?.(session, buildWorkflowEvents(sessionId, startedAt), {
        isTerminal: false,
        isAttributed: true,
      });
      await sink?.(
        session,
        [buildTerminalEvent(sessionId, startedAt + 6_000)],
        { isTerminal: true, isAttributed: true },
      );
    }

    const pending = await store.opportunities.listPendingPatterns();
    expect(pending).toHaveLength(1);
    const payload = ProvenPatternDtoSchema.parse(pending[0].payload);
    expect(payload.workspaceId).toBe(WORKSPACE_ID);
    expect(payload.localVerdicts.trigger.triggerType).toBe("normal_frequency");
    const diagnostics = await module.getDiagnostics();
    expect(diagnostics.patternsProven).toBe(1);

    await module.stop();
    expect(module.getState()).toBe("stopped");
    expect(coordinator.setSessionEventSink).toHaveBeenLastCalledWith(undefined);
  });

  it("registers as a dependent of cloud runtime and trajectory capture", () => {
    const module = new OpportunityTrackingModule({ store });
    expect(module.id).toBe("opportunity-tracking");
    expect(module.dependencies).toEqual(["cloud-runtime", "trajectory-capture"]);
  });

  it("stays detached when trajectory capture is unavailable", async () => {
    const module = new OpportunityTrackingModule({ store });
    const context = {
      config: {} as never,
      paths: {} as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getModule: () => undefined,
    } as unknown as ModuleContext;

    await module.start(context);
    expect(module.getState()).toBe("degraded");
    const health = await module.healthCheck();
    expect(health.details?.sinkAttached).toBe(false);
    await module.stop();
  });

  it("does not start when opportunity tracking is disabled", async () => {
    const module = new OpportunityTrackingModule({ store, enabled: false });
    const context = {
      config: {} as never,
      paths: {} as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getModule: () => undefined,
    } as unknown as ModuleContext;

    await module.start(context);
    expect(module.getState()).toBe("stopped");
  });
});
