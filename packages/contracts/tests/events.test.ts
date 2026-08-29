import { describe, expect, it } from "vitest";
import {
  validBranchForkEvent,
  validCommandExecEvent,
  validCompactionEvent,
  validErrorEvent,
  validFileEditEvent,
  validMessageEvent,
  validModelReasoningEvent,
  validSessionLifecycleEvent,
  validSubagentLifecycleEvent,
  validToolCallEvent,
  validToolDiscoveryEvent,
  validToolResultEvent,
  validUnknownPassthroughEvent,
} from "../fixtures/index.js";
import {
  NormalizedBranchForkEventSchema,
  NormalizedCommandExecEventSchema,
  NormalizedCompactionEventSchema,
  NormalizedErrorEventSchema,
  NormalizedFileEditEventSchema,
  NormalizedMessageEventSchema,
  NormalizedModelReasoningEventSchema,
  NormalizedSessionEventSchema,
  NormalizedSessionLifecycleEventSchema,
  NormalizedSubagentLifecycleEventSchema,
  NormalizedToolCallEventSchema,
  NormalizedToolDiscoveryEventSchema,
  NormalizedToolResultEventSchema,
  NormalizedUnknownPassthroughEventSchema,
  ProviderReportedUsageSchema,
  ProviderUsageAvailabilitySchema,
} from "../src/events.js";
describe("NormalizedSessionEvents", () => {
  const allEvents = [
    { name: "message", fixture: validMessageEvent, schema: NormalizedMessageEventSchema },
    {
      name: "model_reasoning",
      fixture: validModelReasoningEvent,
      schema: NormalizedModelReasoningEventSchema,
    },
    {
      name: "tool_discovery",
      fixture: validToolDiscoveryEvent,
      schema: NormalizedToolDiscoveryEventSchema,
    },
    { name: "tool_call", fixture: validToolCallEvent, schema: NormalizedToolCallEventSchema },
    {
      name: "tool_result",
      fixture: validToolResultEvent,
      schema: NormalizedToolResultEventSchema,
    },
    {
      name: "command_exec",
      fixture: validCommandExecEvent,
      schema: NormalizedCommandExecEventSchema,
    },
    { name: "file_edit", fixture: validFileEditEvent, schema: NormalizedFileEditEventSchema },
    { name: "error", fixture: validErrorEvent, schema: NormalizedErrorEventSchema },
    {
      name: "compaction",
      fixture: validCompactionEvent,
      schema: NormalizedCompactionEventSchema,
    },
    {
      name: "branch_fork",
      fixture: validBranchForkEvent,
      schema: NormalizedBranchForkEventSchema,
    },
    {
      name: "subagent_lifecycle",
      fixture: validSubagentLifecycleEvent,
      schema: NormalizedSubagentLifecycleEventSchema,
    },
    {
      name: "session_lifecycle",
      fixture: validSessionLifecycleEvent,
      schema: NormalizedSessionLifecycleEventSchema,
    },
    {
      name: "unknown_passthrough",
      fixture: validUnknownPassthroughEvent,
      schema: NormalizedUnknownPassthroughEventSchema,
    },
  ];

  describe("Union Schema Parsing", () => {
    it.each(allEvents)(
      "parses valid $name event through NormalizedSessionEventSchema",
      ({ fixture }) => {
        const parsed = NormalizedSessionEventSchema.parse(fixture);
        expect(parsed.type).toBe(fixture.type);
        expect(parsed.eventId).toBe(fixture.eventId);
      },
    );

    it.each(allEvents)(
      "parses valid $name event through specific schema",
      ({ fixture, schema }) => {
        const parsed = schema.parse(fixture);
        expect(parsed.type).toBe(fixture.type);
      },
    );
  });

  describe("Validation & Rejection", () => {
    it("rejects unknown event type in union schema", () => {
      const invalid = {
        ...validMessageEvent,
        type: "unknown_future_unsupported_type",
      };
      expect(() => NormalizedSessionEventSchema.parse(invalid)).toThrow();
    });

    it("rejects message with invalid role", () => {
      const invalid = {
        ...validMessageEvent,
        role: "admin_override",
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });

    it("rejects event missing causal sequence", () => {
      const invalid = {
        ...validMessageEvent,
        causalRef: { parentId: "evt_001" }, // missing causalSequence
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });

    it("rejects event with negative causal sequence", () => {
      const invalid = {
        ...validMessageEvent,
        causalRef: { causalSequence: -5 },
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });

    it("rejects invalid timestamps", () => {
      const invalid = {
        ...validMessageEvent,
        timestamp: "not-a-valid-iso-date",
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });
  });

  describe("Unknown Passthrough Forward Compatibility", () => {
    it("safely preserves raw payload for forward compatibility", () => {
      const customEvent = {
        ...validUnknownPassthroughEvent,
        rawEventType: "experimental_agent_checkpoint",
        rawPayload: {
          checkpointId: "chk_99",
          memoryVector: [0.12, 0.45, -0.88],
          nestedConfig: { enabled: true, tags: ["v2"] },
        },
      };

      const parsed = NormalizedSessionEventSchema.parse(customEvent);
      expect(parsed.type).toBe("unknown_passthrough");
      if (parsed.type === "unknown_passthrough") {
        expect(parsed.rawEventType).toBe("experimental_agent_checkpoint");
        expect(parsed.rawPayload.checkpointId).toBe("chk_99");
      }
    });
  });

  describe("ProviderReportedUsageSchema", () => {
    it("parses valid complete usage with all components populated", () => {
      const validComplete = {
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        accountingVersion: "1.0.0",
        availability: "complete" as const,
        inputTokens: 1500,
        outputTokens: 500,
        reasoningTokens: 200,
        cachedInputTokens: 800,
        totalTokens: 2000,
        costMicroUsd: 15000,
        durationMs: 1250,
      };

      const parsed = ProviderReportedUsageSchema.parse(validComplete);
      expect(parsed).toEqual(validComplete);
    });

    it("parses complete usage with only required fields and totalTokens, keeping optional components absent", () => {
      const minimalComplete = {
        provider: "openai",
        accountingVersion: "1.0.0",
        availability: "complete" as const,
        totalTokens: 1200,
      };

      const parsed = ProviderReportedUsageSchema.parse(minimalComplete);
      expect(parsed.provider).toBe("openai");
      expect(parsed.accountingVersion).toBe("1.0.0");
      expect(parsed.availability).toBe("complete");
      expect(parsed.totalTokens).toBe(1200);
      expect(parsed.model).toBeUndefined();
      expect(parsed.inputTokens).toBeUndefined();
      expect(parsed.outputTokens).toBeUndefined();
      expect(parsed.reasoningTokens).toBeUndefined();
      expect(parsed.cachedInputTokens).toBeUndefined();
      expect(parsed.costMicroUsd).toBeUndefined();
      expect(parsed.durationMs).toBeUndefined();
    });

    it("allows explicit null for optional components in complete usage", () => {
      const completeWithNulls = {
        provider: "anthropic",
        model: null,
        accountingVersion: "1.0.0",
        availability: "complete" as const,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: null,
        cachedInputTokens: null,
        totalTokens: 150,
        costMicroUsd: null,
        durationMs: null,
      };

      const parsed = ProviderReportedUsageSchema.parse(completeWithNulls);
      expect(parsed.totalTokens).toBe(150);
      expect(parsed.reasoningTokens).toBeNull();
      expect(parsed.cachedInputTokens).toBeNull();
    });

    it("rejects complete usage when totalTokens is missing or null", () => {
      const missingTotal = {
        provider: "anthropic",
        accountingVersion: "1.0.0",
        availability: "complete",
        inputTokens: 1000,
        outputTokens: 200,
      };
      expect(() => ProviderReportedUsageSchema.parse(missingTotal)).toThrow(
        /Complete provider usage requires totalTokens/,
      );

      const nullTotal = {
        provider: "anthropic",
        accountingVersion: "1.0.0",
        availability: "complete",
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: null,
      };
      expect(() => ProviderReportedUsageSchema.parse(nullTotal)).toThrow(
        /Complete provider usage requires totalTokens/,
      );
    });

    it("parses valid partial usage without requiring totalTokens", () => {
      const partialWithoutTotal = {
        provider: "gemini",
        model: "gemini-2.5-flash",
        accountingVersion: "1.0.0",
        availability: "partial" as const,
        inputTokens: 300,
        outputTokens: 120,
      };

      const parsed = ProviderReportedUsageSchema.parse(partialWithoutTotal);
      expect(parsed.availability).toBe("partial");
      expect(parsed.inputTokens).toBe(300);
      expect(parsed.outputTokens).toBe(120);
      expect(parsed.totalTokens).toBeUndefined();
    });

    it("parses valid unavailable usage when metrics are absent or null", () => {
      const unavailableAbsent = {
        provider: "local-stub",
        accountingVersion: "1.0.0",
        availability: "unavailable" as const,
      };

      const parsedAbsent = ProviderReportedUsageSchema.parse(unavailableAbsent);
      expect(parsedAbsent.availability).toBe("unavailable");
      expect(parsedAbsent.totalTokens).toBeUndefined();
      expect(parsedAbsent.inputTokens).toBeUndefined();

      const unavailableNulls = {
        provider: "local-stub",
        accountingVersion: "1.0.0",
        availability: "unavailable" as const,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cachedInputTokens: null,
        totalTokens: null,
        costMicroUsd: null,
        durationMs: null,
      };

      const parsedNulls = ProviderReportedUsageSchema.parse(unavailableNulls);
      expect(parsedNulls.availability).toBe("unavailable");
    });

    it("rejects unavailable usage when metric fields are populated with values", () => {
      expect(() =>
        ProviderReportedUsageSchema.parse({
          provider: "local-stub",
          accountingVersion: "1.0.0",
          availability: "unavailable",
          inputTokens: 100,
        }),
      ).toThrow(/Unavailable provider usage cannot specify inputTokens/);

      expect(() =>
        ProviderReportedUsageSchema.parse({
          provider: "local-stub",
          accountingVersion: "1.0.0",
          availability: "unavailable",
          totalTokens: 0,
        }),
      ).toThrow(/Unavailable provider usage cannot specify totalTokens/);

      expect(() =>
        ProviderReportedUsageSchema.parse({
          provider: "local-stub",
          accountingVersion: "1.0.0",
          availability: "unavailable",
          costMicroUsd: 50,
        }),
      ).toThrow(/Unavailable provider usage cannot specify costMicroUsd/);

      expect(() =>
        ProviderReportedUsageSchema.parse({
          provider: "local-stub",
          accountingVersion: "1.0.0",
          availability: "unavailable",
          durationMs: 200,
        }),
      ).toThrow(/Unavailable provider usage cannot specify durationMs/);
    });

    it("rejects unexpected or synthetic fields via strict schema", () => {
      const withSyntheticField = {
        provider: "openai",
        accountingVersion: "1.0.0",
        availability: "complete",
        totalTokens: 500,
        syntheticTokens: 250,
      };
      expect(() => ProviderReportedUsageSchema.parse(withSyntheticField)).toThrow();

      const withInferredCost = {
        provider: "openai",
        accountingVersion: "1.0.0",
        availability: "partial",
        estimatedUsd: 0.05,
      };
      expect(() => ProviderReportedUsageSchema.parse(withInferredCost)).toThrow();
    });

    it("rejects negative or non-integer token metrics", () => {
      expect(() =>
        ProviderReportedUsageSchema.parse({
          provider: "openai",
          accountingVersion: "1.0.0",
          availability: "complete",
          totalTokens: -10,
        }),
      ).toThrow();

      expect(() =>
        ProviderReportedUsageSchema.parse({
          provider: "openai",
          accountingVersion: "1.0.0",
          availability: "complete",
          totalTokens: 100.5,
        }),
      ).toThrow();
    });
  });

  describe("NormalizedSessionEvent with providerUsage", () => {
    it("parses normalized message event with valid complete providerUsage", () => {
      const eventWithUsage = {
        ...validMessageEvent,
        providerUsage: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          accountingVersion: "1.0.0",
          availability: "complete" as const,
          inputTokens: 1200,
          outputTokens: 400,
          totalTokens: 1600,
          costMicroUsd: 12000,
          durationMs: 850,
        },
      };

      const parsed = NormalizedSessionEventSchema.parse(eventWithUsage);
      expect(parsed.providerUsage).toBeDefined();
      expect(parsed.providerUsage?.provider).toBe("anthropic");
      expect(parsed.providerUsage?.totalTokens).toBe(1600);
      expect(parsed.providerUsage?.availability).toBe("complete");
    });

    it("parses normalized reasoning event with valid partial providerUsage", () => {
      const reasoningWithUsage = {
        ...validModelReasoningEvent,
        providerUsage: {
          provider: "deepseek",
          accountingVersion: "1.0.0",
          availability: "partial" as const,
          reasoningTokens: 800,
        },
      };

      const parsed = NormalizedModelReasoningEventSchema.parse(reasoningWithUsage);
      expect(parsed.providerUsage?.provider).toBe("deepseek");
      expect(parsed.providerUsage?.reasoningTokens).toBe(800);
      expect(parsed.providerUsage?.totalTokens).toBeUndefined();
    });

    it("parses normalized tool event with valid unavailable providerUsage", () => {
      const toolWithUnavailableUsage = {
        ...validToolCallEvent,
        providerUsage: {
          provider: "custom-runtime",
          accountingVersion: "1.0.0",
          availability: "unavailable" as const,
        },
      };

      const parsed = NormalizedToolCallEventSchema.parse(toolWithUnavailableUsage);
      expect(parsed.providerUsage?.availability).toBe("unavailable");
      expect(parsed.providerUsage?.totalTokens).toBeUndefined();
    });

    it("preserves backward compatibility for events without providerUsage", () => {
      const parsed = NormalizedSessionEventSchema.parse(validMessageEvent);
      expect(parsed.providerUsage).toBeUndefined();
    });

    it("rejects normalized event with invalid providerUsage", () => {
      const eventWithInvalidUsage = {
        ...validMessageEvent,
        providerUsage: {
          provider: "anthropic",
          accountingVersion: "1.0.0",
          availability: "complete", // missing totalTokens
        },
      };
      expect(() => NormalizedSessionEventSchema.parse(eventWithInvalidUsage)).toThrow();
    });
  });
});
