import { decodeCodexTranscript } from "@resin/adapter-codex";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { tokenizeProgram } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import type { WorkflowCallCarrier } from "../../src/analytics/workflow-carrier.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";
import type { RedactionConfig } from "../../src/normalization/redaction.js";

const SESSION = "session-native-program-source-projection";
const WORKSPACE = "workspace-native-program-source-projection";
const SECRET = "safe-credential";

type Transcript = Parameters<typeof decodeCodexTranscript>[0];

function execCall(callId: string, source: string) {
  return {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: callId,
      name: "exec",
      input: source,
    },
  };
}

async function capture(
  transcript: Transcript,
  redactionConfig: RedactionConfig = {},
  sessionId = SESSION,
) {
  const decoded = decodeCodexTranscript(transcript, { sessionId });
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { ...redactionConfig, sensitiveEnvVars: [] },
  });
  const normalized: NormalizedSessionEvent[] = [];
  for (const event of decoded) {
    const outcome = await pipeline.processIntermediateEvent(event, {
      sessionId,
      harnessId: "codex-cli",
      workspaceId: WORKSPACE,
    });
    if (outcome.status === "success" && !outcome.isDuplicate) normalized.push(outcome.event);
  }

  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const observed = normalized.map((event) => recorder.observe(event, { workspaceId: WORKSPACE }));
  const metadataOnly = observed.map((event) => projectEventToMetadataOnly(event));
  return { decoded, normalized, observed, metadataOnly, store };
}

function callAndCarrier(events: readonly NormalizedSessionEvent[], callId: string) {
  const event = events.find((entry) => entry.type === "tool_call" && entry.callId === callId);
  if (event?.type !== "tool_call") throw new Error(`expected recorded call ${callId}`);
  const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
  if (carrier === undefined) throw new Error(`expected a workflow carrier for ${callId}`);
  return { event, carrier };
}

function programOrigin(carrier: WorkflowCallCarrier) {
  const origin = carrier.origins.raw;
  if (origin?.type !== "program") throw new Error("expected a projected program argument");
  return origin;
}

function privateOrigin(carrier: WorkflowCallCarrier) {
  const origin = carrier.origins.raw;
  if (origin?.type !== "private") {
    throw new Error("expected the original source to remain private");
  }
  return origin;
}

describe("native program source projection", () => {
  it("publishes parseable redacted source while retaining the original and its protected token locally", async () => {
    const callId = "codex-safe-program-source";
    const source = `text("${SECRET}", 17);`;
    const captured = await capture([execCall(callId, source)], { customSecrets: [SECRET] });
    const { carrier } = callAndCarrier(captured.observed, callId);
    const origin = programOrigin(carrier);
    if (origin.source.type !== "literal" || typeof origin.source.value !== "string") {
      throw new Error("expected a literal sanitized source view");
    }
    const sanitized = origin.source.value;
    const sourceTokens = tokenizeProgram("javascript", source);
    const sanitizedTokens = tokenizeProgram("javascript", sanitized);
    expect(sanitizedTokens).toHaveLength(sourceTokens.length);
    const changedIndexes = sourceTokens.flatMap((token, index) =>
      token.raw === sanitizedTokens[index]?.raw ? [] : [index],
    );
    const secretIndex = sourceTokens.findIndex((token) => token.value === SECRET);
    const numericIndex = sourceTokens.findIndex(
      (token) => token.kind === "number" && token.value === 17,
    );
    const sourceReference = origin.sourceReference;

    expect(secretIndex).toBeGreaterThanOrEqual(0);
    expect(numericIndex).toBeGreaterThanOrEqual(0);
    expect(typeof sourceReference).toBe("string");
    if (sourceReference === undefined)
      throw new Error("expected a local original-source reference");
    expect(sanitized).not.toContain(SECRET);
    expect(origin.protectedTokens).toEqual(changedIndexes);
    expect(origin.protectedTokens).toContain(secretIndex);
    expect(sanitizedTokens[numericIndex]?.raw).toBe(sourceTokens[numericIndex]?.raw);
    expect(sanitizedTokens[numericIndex]?.value).toBe(17);
    expect(carrier.program?.source).toBe(sanitized);
    expect(resolvePrivateReference(captured.store, sourceReference)).toBe(source);

    const publicEvents = JSON.stringify(captured.metadataOnly);
    expect(publicEvents).not.toContain(SECRET);
    expect(publicEvents).not.toContain(source);
    const projectedCarrier = callAndCarrier(captured.metadataOnly, callId).carrier;
    const projectedOrigin = programOrigin(projectedCarrier);
    expect(projectedOrigin.sourceReference).toBe(sourceReference);
    expect(projectedOrigin.protectedTokens).toEqual(changedIndexes);

    const recipe = recordCallsFromEvents(SESSION, captured.metadataOnly);
    expect(recipe).toBeDefined();
    if (recipe === undefined) throw new Error("expected a workflow recipe");
    const step = recipe.workflow.steps.find((entry) => entry.callId === callId);
    const argument = step?.arguments.find((entry) => entry.name === "raw");
    const template = argument?.source.kind === "template" ? argument.source.template : undefined;
    if (template?.type !== "program" || template.source.type !== "literal") {
      throw new Error("expected the projected program template to survive recipe reconstruction");
    }
    expect(template.sourceReference).toBe(sourceReference);
    expect(template.protectedTokens).toEqual(changedIndexes);
    expect(template.source.value).toBe(sanitized);
    expect(step?.callable.program?.source).toBe(sanitized);
    expect(recipe.workflow.privateReferences).toContain(sourceReference);
    expect(JSON.stringify(recipe.workflow)).not.toContain(SECRET);
    expect(JSON.stringify(recipe.workflow)).not.toContain(source);
  });

  it("redacts escaped static credentials by scanning decoded JavaScript token values", async () => {
    const callId = "codex-escaped-program-source";
    const source = String.raw`const token = 17;
text("sa\x66e-credential", token);`;
    const captured = await capture([execCall(callId, source)], { customSecrets: [SECRET] });
    const { carrier } = callAndCarrier(captured.observed, callId);
    const origin = programOrigin(carrier);
    if (origin.source.type !== "literal" || typeof origin.source.value !== "string") {
      throw new Error("expected a literal sanitized source view");
    }
    const sanitizedTokens = tokenizeProgram("javascript", origin.source.value);
    const originalTokens = tokenizeProgram("javascript", source);
    const secretIndex = originalTokens.findIndex((token) => token.value === SECRET);
    const sourceReference = origin.sourceReference;

    expect(secretIndex).toBeGreaterThanOrEqual(0);
    expect(sourceReference).toBeTypeOf("string");
    if (sourceReference === undefined)
      throw new Error("expected a local original-source reference");
    expect(sanitizedTokens).toHaveLength(originalTokens.length);
    expect(origin.source.value).not.toContain(SECRET);
    expect(origin.protectedTokens).toContain(secretIndex);
    expect(sanitizedTokens.some((token) => token.kind === "number" && token.value === 17)).toBe(
      true,
    );
    expect(resolvePrivateReference(captured.store, sourceReference)).toBe(source);
    expect(JSON.stringify(captured.metadataOnly)).not.toContain(SECRET);
    expect(JSON.stringify(captured.metadataOnly)).not.toContain(source);
  });

  it("does not authorize source projection from decoder or redaction metadata alone", () => {
    const source = `text("${SECRET}", 17);`;
    const decoded = decodeCodexTranscript(
      [execCall("codex-untrusted-redaction-metadata", source)],
      {
        sessionId: SESSION,
      },
    );
    const decodedCall = decoded.find((entry) => entry.type === "tool_call");
    if (decodedCall?.type !== "tool_call") throw new Error("expected a decoded Codex exec call");
    const claimedRedaction = {
      ...decodedCall,
      redaction: {
        ...decodedCall.redaction,
        isRedacted: true,
        redactedFields: ["parameters"],
        scrubbedPatterns: ["custom_secret"],
      },
    };
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const observed = recorder.observe(claimedRedaction, { workspaceId: WORKSPACE });
    const { carrier } = callAndCarrier([observed], "codex-untrusted-redaction-metadata");
    const origin = privateOrigin(carrier);

    expect(carrier.program?.source).toBe("");
    expect(resolvePrivateReference(store, origin.reference)).toBe(source);
    const publicEvent = projectEventToMetadataOnly(observed);
    expect(JSON.stringify(publicEvent)).not.toContain(SECRET);
    expect(JSON.stringify(publicEvent)).not.toContain(source);
  });

  it("keeps program source private when scanning is disabled or redaction would truncate it", async () => {
    const callId = "codex-ineligible-program-source";
    const source = `text("${SECRET}", 17);`;
    const cases: RedactionConfig[] = [
      { customSecrets: [SECRET], scanContent: false },
      { customSecrets: [SECRET], maxStringLength: 12 },
    ];
    for (const redactionConfig of cases) {
      const captured = await capture([execCall(callId, source)], redactionConfig);
      const { carrier } = callAndCarrier(captured.observed, callId);
      const origin = privateOrigin(carrier);
      expect(carrier.program?.source ?? "").toBe("");
      expect(resolvePrivateReference(captured.store, origin.reference)).toBe(source);
      expect(JSON.stringify(captured.metadataOnly)).not.toContain(SECRET);
      expect(JSON.stringify(captured.metadataOnly)).not.toContain(source);
    }
  });

  it("refuses source projections that fail parsing or change the program's token structure", async () => {
    const malformedSource = `text("${SECRET}"`;
    const mergedTokenSecret = 'first");text("second';
    const tokenMergingSource = 'text("first");text("second");';
    const cases = [
      { callId: "codex-malformed-source", source: malformedSource, secret: SECRET },
      {
        callId: "codex-token-merging-source",
        source: tokenMergingSource,
        secret: mergedTokenSecret,
      },
    ];
    for (const entry of cases) {
      const captured = await capture([execCall(entry.callId, entry.source)], {
        customSecrets: [entry.secret],
      });
      const { carrier } = callAndCarrier(captured.observed, entry.callId);
      const origin = privateOrigin(carrier);
      expect(carrier.program?.source).toBe("");
      expect(resolvePrivateReference(captured.store, origin.reference)).toBe(entry.source);
      expect(JSON.stringify(captured.metadataOnly)).not.toContain(entry.source);
      expect(JSON.stringify(captured.metadataOnly)).not.toContain(entry.secret);
    }
  });
});
