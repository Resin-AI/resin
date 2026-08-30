import { randomUUID } from "node:crypto";
import type { NormalizedSessionEvent, ProviderReportedUsage } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  MixedTrajectoryIdentityError,
  TrajectoryAlreadyFinalizedError,
  type TrajectoryAttributionContextInput,
  TrajectoryEmitter,
  TrajectoryObservationSchema,
  TrajectoryValidationError,
  aggregateTrajectoryEvents,
  computeTrajectoryObservationDigest,
  createTrajectoryEmitter,
} from "../../src/index.js";

function createValidContext(
  overrides: Partial<TrajectoryAttributionContextInput> = {},
): TrajectoryAttributionContextInput {
  return {
    accountId: "acc_alpha_01",
    workspaceId: "ws_alpha_01",
    ownerUserId: "usr_alice_01",
    projectId: "prj_eval_01",
    candidateId: "cand_v2_fast",
    toolId: "00000000-0000-0000-0000-000000000001",
    toolVersion: "1.2.0",
    workloadId: "wl_refactor_pipeline",
    trajectoryId: `traj_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    runtimeVersion: "1.0.0",
    role: "candidate",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    accountingVersion: "claude-code-v1",
    catalogExposureTokens: 250,
    isEquivalent: true,
    status: "success",
    ...overrides,
  };
}

function createMockEvent(
  overrides: Partial<Extract<NormalizedSessionEvent, { type: "message" }>> = {},
): NormalizedSessionEvent {
  const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const baseEvent: Extract<NormalizedSessionEvent, { type: "message" }> = {
    eventId,
    sessionId: "01J5XYZ7890ABCDEFGHJKMNPQR",
    timestamp: "2026-08-27T12:00:00.000Z",
    schemaVersion: "1.0.0",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Standard assistant output" }],
  };
  return Object.assign(baseEvent, overrides);
}

describe("TrajectoryEmitter: Authoritative Outer Trajectory Aggregation", () => {
  describe("1. Component Sums & Usage Aggregation", () => {
    it("aggregates non-null provider usage components across multiple events accurately", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const event1 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 1000,
          outputTokens: 200,
          reasoningTokens: 50,
          cachedInputTokens: 300,
          totalTokens: 1200,
          costMicroUsd: 4500,
          durationMs: 1200,
        },
      });

      const event2 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 500,
          outputTokens: 100,
          reasoningTokens: 25,
          cachedInputTokens: 100,
          totalTokens: 600,
          costMicroUsd: 2250,
          durationMs: 800,
        },
      });

      expect(emitter.ingest(event1)).toBe(true);
      expect(emitter.ingest(event2)).toBe(true);
      expect(emitter.getEventCount()).toBe(2);

      const observation = emitter.finalize();

      expect(observation.usage).toEqual({
        availability: "complete",
        inputTokens: 1500,
        outputTokens: 300,
        reasoningTokens: 75,
        cachedInputTokens: 400,
        totalTokens: 1800,
        costMicroUsd: 6750,
        durationMs: 2000,
      });

      // Verify schema conformance
      expect(() => TrajectoryObservationSchema.parse(observation)).not.toThrow();
    });

    it("leaves absent usage components as null without converting them to zero", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      // Neither event reports reasoningTokens or costMicroUsd
      const event1 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 800,
          outputTokens: 150,
          reasoningTokens: null,
          cachedInputTokens: null,
          totalTokens: 950,
          costMicroUsd: null,
          durationMs: 500,
        },
      });

      const event2 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 200,
          outputTokens: 50,
          totalTokens: 250,
        },
      });

      emitter.ingestBatch([event1, event2]);
      const observation = emitter.finalize();

      expect(observation.usage.availability).toBe("complete");
      expect(observation.usage.inputTokens).toBe(1000);
      expect(observation.usage.outputTokens).toBe(200);
      expect(observation.usage.totalTokens).toBe(1200);
      expect(observation.usage.durationMs).toBe(500);

      // Absent metrics MUST remain null, never converted to 0
      expect(observation.usage.reasoningTokens).toBeNull();
      expect(observation.usage.cachedInputTokens).toBeNull();
      expect(observation.usage.costMicroUsd).toBeNull();
    });

    it("marks availability as partial when any event reports partial usage or misses totalTokens", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const event1 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "partial",
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: null,
        },
      });

      const event2 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 300,
          outputTokens: 50,
          totalTokens: 350,
        },
      });

      emitter.ingestBatch([event1, event2]);
      const observation = emitter.finalize();

      expect(observation.usage.availability).toBe("partial");
      expect(observation.usage.inputTokens).toBe(800);
      expect(observation.usage.outputTokens).toBe(150);
      expect(observation.usage.totalTokens).toBe(350);
    });
  });

  describe("2. Missing Usage Unavailable Semantics", () => {
    it("reports availability as unavailable with null components when no events contain usage", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const nonUsageEvent = createMockEvent({
        type: "tool_call",
        toolName: "read_file",
        input: { path: "/workspace/config.json" },
      });
      emitter.ingest(nonUsageEvent);
      const observation = emitter.finalize();

      expect(observation.usage).toEqual({
        availability: "unavailable",
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cachedInputTokens: null,
        totalTokens: null,
        costMicroUsd: null,
        durationMs: null,
      });

      expect(() => TrajectoryObservationSchema.parse(observation)).not.toThrow();
    });

    it("reports availability as unavailable when all usage records are explicitly unavailable", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const event1 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "unavailable",
        },
      });

      emitter.ingest(event1);
      const observation = emitter.finalize();

      expect(observation.usage.availability).toBe("unavailable");
      expect(observation.usage.inputTokens).toBeNull();
      expect(observation.usage.outputTokens).toBeNull();
      expect(observation.usage.totalTokens).toBeNull();
      expect(observation.usage.costMicroUsd).toBeNull();
    });
  });

  describe("3. Mixed Identity Rejection", () => {
    it("throws MixedTrajectoryIdentityError when events have different providers", () => {
      const emitter = createTrajectoryEmitter(
        createValidContext({ provider: undefined, accountingVersion: "v1" }),
      );

      const event1 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "v1",
          availability: "complete",
          totalTokens: 100,
        },
      });

      const event2 = createMockEvent({
        providerUsage: {
          provider: "openai",
          model: "gpt-4o",
          accountingVersion: "v1",
          availability: "complete",
          totalTokens: 100,
        },
      });

      emitter.ingest(event1);
      expect(() => emitter.ingest(event2)).toThrow(MixedTrajectoryIdentityError);
    });

    it("throws MixedTrajectoryIdentityError when events have different models", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const event = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-opus",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          totalTokens: 100,
        },
      });

      expect(() => emitter.ingest(event)).toThrow(MixedTrajectoryIdentityError);
    });

    it("throws MixedTrajectoryIdentityError when events have conflicting accounting versions", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const event = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v2",
          availability: "complete",
          totalTokens: 100,
        },
      });

      expect(() => emitter.ingest(event)).toThrow(MixedTrajectoryIdentityError);
    });

    it("throws TrajectoryValidationError when provider and model are missing from context and events", () => {
      const emitter = createTrajectoryEmitter(
        createValidContext({ provider: undefined, model: undefined }),
      );

      expect(() => emitter.finalize()).toThrow(TrajectoryValidationError);
    });
  });

  describe("4. Duplicate Event Deduplication", () => {
    it("ignores duplicate event IDs and does not double-count usage", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const event = createMockEvent({
        eventId: "evt_duplicate_target_01",
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
          costMicroUsd: 1500,
        },
      });

      expect(emitter.ingest(event)).toBe(true);
      // Ingest same event ID a second and third time
      expect(emitter.ingest(event)).toBe(false);
      expect(emitter.ingest(event)).toBe(false);

      expect(emitter.getEventCount()).toBe(1);

      const observation = emitter.finalize();
      expect(observation.usage.totalTokens).toBe(600);
      expect(observation.usage.costMicroUsd).toBe(1500);
    });
  });

  describe("5. No-Invocation Catalog Exposure", () => {
    it("supplies catalog exposure tokens even when zero events are ingested", () => {
      const context = createValidContext({
        catalogExposureTokens: 1250,
      });

      const emitter = createTrajectoryEmitter(context);
      expect(emitter.getEventCount()).toBe(0);

      const observation = emitter.finalize();

      expect(observation.catalogExposureTokens).toBe(1250);
      expect(observation.usage.availability).toBe("unavailable");
      expect(observation.canonicalPayload?.catalogExposureTokens).toBe(1250);
      expect(() => TrajectoryObservationSchema.parse(observation)).not.toThrow();
    });
  });

  describe("6. Failure & Equivalence Context", () => {
    it("records failure status and equivalence boolean accurately", () => {
      const context = createValidContext({
        status: "failure",
        isEquivalent: false,
      });

      const emitter = createTrajectoryEmitter(context);
      const observation = emitter.finalize();

      expect(observation.status).toBe("failure");
      expect(observation.isEquivalent).toBe(false);
    });

    it("automatically sets status to failure on session crash lifecycle event", () => {
      const emitter = createTrajectoryEmitter(createValidContext());
      const crashEvent = createMockEvent({
        type: "session_lifecycle",
        lifecycleType: "crash",
        exitReason: "fatal_uncaught_panic",
      });

      emitter.ingest(crashEvent);
      expect(emitter.isFinalized()).toBe(true);
      const observation = emitter.getObservation();
      expect(observation).not.toBeNull();
      expect(observation?.status).toBe("failure");
    });

    it("automatically finalizes and maps timeout exitReason on session end", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const endEvent = createMockEvent({
        type: "session_lifecycle",
        lifecycleType: "end",
        exitReason: "timeout",
      });
      emitter.ingest(endEvent);

      expect(emitter.isFinalized()).toBe(true);
      const observation = emitter.getObservation();
      expect(observation?.status).toBe("timeout");
    });
  });

  describe("7. Nested Attribution & Child Trajectories", () => {
    it("preserves parentTrajectoryId on child trajectory observation", () => {
      const parentId = "traj_parent_main_orchestrator";
      const context = createValidContext({
        trajectoryId: "traj_child_subagent_worker",
        parentTrajectoryId: parentId,
      });

      const emitter = createTrajectoryEmitter(context);
      const observation = emitter.finalize();

      expect(observation.parentTrajectoryId).toBe(parentId);
      expect(observation.canonicalPayload?.parentTrajectoryId).toBe(parentId);
    });

    it("sets parentTrajectoryId to null when omitted for outer trajectories", () => {
      const context = createValidContext({
        parentTrajectoryId: null,
      });

      const emitter = createTrajectoryEmitter(context);
      const observation = emitter.finalize();

      expect(observation.parentTrajectoryId).toBeNull();
      expect(observation.canonicalPayload?.parentTrajectoryId).toBeNull();
    });
  });

  describe("8. Terminal Finalization Constraints", () => {
    it("throws TrajectoryAlreadyFinalizedError when ingesting events after finalization", () => {
      const emitter = createTrajectoryEmitter(createValidContext());
      emitter.finalize();

      const event = createMockEvent();
      expect(() => emitter.ingest(event)).toThrow(TrajectoryAlreadyFinalizedError);
      expect(() => emitter.ingestBatch([event])).toThrow(TrajectoryAlreadyFinalizedError);
    });

    it("throws TrajectoryAlreadyFinalizedError when calling finalize more than once", () => {
      const emitter = createTrajectoryEmitter(createValidContext());
      emitter.finalize();

      expect(() => emitter.finalize()).toThrow(TrajectoryAlreadyFinalizedError);
    });

    it("aggregates batch and finalizes via aggregateTrajectoryEvents helper", () => {
      const events = [
        createMockEvent({
          providerUsage: {
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            accountingVersion: "claude-code-v1",
            availability: "complete",
            inputTokens: 300,
            outputTokens: 50,
            totalTokens: 350,
          },
        }),
      ];

      const obs = aggregateTrajectoryEvents(events, createValidContext());
      expect(obs.usage.totalTokens).toBe(350);
      expect(obs.usage.availability).toBe("complete");
    });
  });

  describe("9. Privacy & Prompt Exclusion", () => {
    it("strictly excludes user prompts, source code, commands, and transcript content from observation", () => {
      const emitter = createTrajectoryEmitter(createValidContext());

      const sensitiveUserPrompt = "SECRET_USER_PROMPT_DO_NOT_LEAK_API_KEY_12345";
      const sensitiveCommand = "cat /etc/shadow && rm -rf /tmp/secrets";
      const sensitiveSourceCode = "export const SUPER_SECRET_TOKEN = 'sk-live-99999';";

      const event1 = createMockEvent({
        type: "message",
        role: "user",
        content: [{ type: "text", text: sensitiveUserPrompt }],
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      });

      const event2 = createMockEvent({
        type: "tool_call",
        toolName: "bash",
        input: { command: sensitiveCommand, code: sensitiveSourceCode },
      });
      emitter.ingestBatch([event1, event2]);
      const observation = emitter.finalize();

      const observationString = JSON.stringify(observation);

      expect(observationString).not.toContain(sensitiveUserPrompt);
      expect(observationString).not.toContain(sensitiveCommand);
      expect(observationString).not.toContain(sensitiveSourceCode);
      expect(observationString).not.toContain("SUPER_SECRET_TOKEN");

      // Verify canonical digest matches computed canonical payload
      const expectedDigest = computeTrajectoryObservationDigest(observation);
      expect(observation.digest).toBe(expectedDigest);
    });
    it("ensures accountingVersion survives in canonicalPayload, metadata, and digest changes when accountingVersion changes", () => {
      const baseContext = createValidContext({ accountingVersion: "claude-code-v1" });
      const emitter1 = createTrajectoryEmitter(baseContext);

      const event1 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v1",
          availability: "complete",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      });

      emitter1.ingest(event1);
      const obs1 = emitter1.finalize({ observedAt: "2026-08-27T12:00:00.000Z" });

      expect(obs1.canonicalPayload?.accountingVersion).toBe("claude-code-v1");
      expect(obs1.metadata?.accountingVersion).toBe("claude-code-v1");
      // SAFETY: Checks absence of accountingVersion on observation record.
      expect((obs1 as { accountingVersion?: unknown }).accountingVersion).toBeUndefined();

      const emitter2 = createTrajectoryEmitter({
        ...baseContext,
        accountingVersion: "claude-code-v2",
      });

      const event2 = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "claude-code-v2",
          availability: "complete",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      });

      emitter2.ingest(event2);
      const obs2 = emitter2.finalize({ observedAt: "2026-08-27T12:00:00.000Z" });

      expect(obs2.canonicalPayload?.accountingVersion).toBe("claude-code-v2");
      expect(obs2.metadata?.accountingVersion).toBe("claude-code-v2");

      // Verify digest changes when accountingVersion changes
      expect(obs1.digest).not.toBe(obs2.digest);
      expect(obs1.digest).toBe(computeTrajectoryObservationDigest(obs1));
      expect(obs2.digest).toBe(computeTrajectoryObservationDigest(obs2));
    });

    it("rejects context accountingVersion conflicting with event usage", () => {
      const emitter = createTrajectoryEmitter(
        createValidContext({ accountingVersion: "expected-v1" }),
      );

      const conflictingEvent = createMockEvent({
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "event-v2",
          availability: "complete",
          totalTokens: 100,
        },
      });

      expect(() => emitter.ingest(conflictingEvent)).toThrow(MixedTrajectoryIdentityError);
    });

    it("does not leak arbitrary context metadata into canonicalPayload", () => {
      const emitter = createTrajectoryEmitter(
        createValidContext({
          metadata: {
            customField: "custom-value",
            internalDebugNote: "do-not-leak",
          },
        }),
      );

      const observation = emitter.finalize();
      expect(observation.metadata?.customField).toBe("custom-value");
      expect(observation.canonicalPayload?.customField).toBeUndefined();
      expect(observation.canonicalPayload?.internalDebugNote).toBeUndefined();
      expect(observation.canonicalPayload?.accountingVersion).toBe("claude-code-v1");
      expect(observation.metadata?.accountingVersion).toBe("claude-code-v1");
    });
  });
});
