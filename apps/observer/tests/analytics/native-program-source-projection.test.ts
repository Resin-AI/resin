import { CodexRecordDecoder, decodeCodexTranscript } from "@resin/adapter-codex";
import { OmpRecordDecoder } from "@resin/adapter-omp";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { applyProgramTokenValues, tokenizeProgram } from "@resin/contracts";
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
      // Unparseable source is not even a standalone program; either way no source view is published.
      expect(carrier.program?.source ?? "").toBe("");
      expect(resolvePrivateReference(captured.store, origin.reference)).toBe(entry.source);
      expect(JSON.stringify(captured.metadataOnly)).not.toContain(entry.source);
      expect(JSON.stringify(captured.metadataOnly)).not.toContain(entry.secret);
    }
  });

  it("projects a native Codex shell command with its credential protected and its original kept local", async () => {
    const sessionId = "codex-native-shell-projection";
    const secret = "sk-live-abc123XYZ";
    const command = `curl -H 'Authorization: Bearer ${secret}' https://x/y --out data/a.json`;
    const store = new InMemoryPrivateValueStore();
    const pipeline = new NormalizationPipeline({
      privateValueStore: store,
      redactionConfig: { customSecrets: [secret], sensitiveEnvVars: [] },
    });
    pipeline.registerDecoder(new CodexRecordDecoder());
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const timestamp = "2026-09-23T12:00:00.000Z";
    const native = [
      { type: "session_meta", payload: { session_id: sessionId, id: sessionId, cwd: "/work" } },
      { type: "turn_context", payload: { turn_id: "turn", cwd: "/work", model: "gpt-6-sol" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "download https://x/y into data/a.json" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "exec-shell-projection",
            command: ["/bin/bash", "-lc", command],
            cwd: "file:///work",
            status: "completed",
            stdout: "ok\n",
            stderr: "",
            exit_code: 0,
            duration: { secs: 0, nanos: 5_000_000 },
          },
          started_at_ms: 1_000,
          completed_at_ms: 1_005,
        },
      },
    ];
    const observed: NormalizedSessionEvent[] = [];
    for (const [index, entry] of native.entries()) {
      const ordinal = index + 1;
      for (const result of await pipeline.processRecord(
        {
          recordId: `rec_${sessionId}_${ordinal}`,
          sessionId,
          harnessId: "codex-cli",
          sequenceNumber: ordinal,
          recordType: "transcript_line",
          timestamp,
          rawPayload: JSON.stringify({ timestamp, ordinal, ...entry }),
          cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
          metadata: {},
        },
        { sessionId, harnessId: "codex-cli", workspaceId: WORKSPACE },
      )) {
        if (result.status !== "success" || result.isDuplicate) continue;
        observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
      }
    }
    const commandEvent = observed.find((entry) => entry.type === "command_exec");
    const carrier = readWorkflowCallCarrier(
      commandEvent?.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY],
    );
    if (carrier === undefined) throw new Error("expected a native command carrier");
    const origin = carrier.origins.cmd;
    if (origin?.type !== "program" || origin.source.type !== "literal") {
      throw new Error("expected a projected shell program origin");
    }
    const scrubbed = origin.source.value;
    if (typeof scrubbed !== "string") throw new Error("expected literal scrubbed source");
    expect(origin.language).toBe("shell");
    expect(scrubbed).not.toContain(secret);
    const sourceTokens = tokenizeProgram("shell", command);
    const secretIndex = sourceTokens.findIndex((token) => token.raw.includes(secret));
    expect(origin.protectedTokens).toEqual([secretIndex]);
    expect(tokenizeProgram("shell", scrubbed).map((token) => token.raw)).toEqual(
      sourceTokens.map((token, index) =>
        index === secretIndex ? tokenizeProgram("shell", scrubbed)[index]!.raw : token.raw,
      ),
    );
    if (origin.sourceReference === undefined) throw new Error("expected a source reference");
    expect(resolvePrivateReference(store, origin.sourceReference)).toBe(command);
    expect(carrier.program?.source).toBe(scrubbed);

    // Deterministic candidates keep addressing the original command's token positions.
    const outIndex = sourceTokens.findIndex((token) => token.raw === "data/a.json");
    const candidateTokens = (carrier.candidates ?? []).flatMap((candidate) =>
      candidate.argument === "cmd" && candidate.path[0] === "tokens" ? [candidate.path[1]] : [],
    );
    expect(candidateTokens).toContain(outIndex);
    // A redacted token is never proposed as a binding hole.
    expect(candidateTokens).not.toContain(secretIndex);

    const publicEvents = observed.map((entry) => projectEventToMetadataOnly(entry));
    expect(JSON.stringify(publicEvents)).not.toContain(secret);
    const recipe = recordCallsFromEvents(sessionId, publicEvents);
    const argument = recipe?.workflow.steps[0]?.arguments.find((entry) => entry.name === "cmd");
    const template = argument?.source.kind === "template" ? argument.source.template : undefined;
    if (template?.type !== "program") throw new Error("expected a shell program template");
    expect(template.sourceReference).toBe(origin.sourceReference);
    expect(template.protectedTokens).toEqual([secretIndex]);
    expect(JSON.stringify(recipe?.workflow)).not.toContain(secret);
  });

  it("keeps a bash tool's command private unless the OMP decoder proved its interface", async () => {
    const sessionId = "unproven-bash-stays-private";
    const command = "tar -czf out/alpha-release.tgz projects/alpha-release";
    const store = new InMemoryPrivateValueStore();
    const pipeline = new NormalizationPipeline({
      privateValueStore: store,
      redactionConfig: { sensitiveEnvVars: [] },
    });
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const origin = { sessionId, harnessId: "claude-code", workspaceId: WORKSPACE };
    const result = await pipeline.processIntermediateEvent(
      {
        sessionId,
        type: "tool_call",
        toolName: "bash",
        callId: "unproven-bash-call",
        parameters: { command },
        timestamp: "2026-09-23T12:00:00.000Z",
        causalRef: { causalSequence: 1, parentId: null },
      },
      origin,
    );
    if (result.status !== "success") throw new Error(result.errorReason);
    const observed = recorder.observe(result.event, { workspaceId: WORKSPACE });
    const carrier = readWorkflowCallCarrier(observed.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (carrier === undefined) throw new Error("expected a workflow carrier");
    const commandOrigin = carrier.origins.command;
    if (commandOrigin?.type !== "private") throw new Error("expected the command to stay private");
    expect(resolvePrivateReference(store, commandOrigin.reference)).toBe(command);
    expect(JSON.stringify(projectEventToMetadataOnly(observed))).not.toContain("alpha-release");
  });

  it("projects an OMP bash command with its credential protected, other arguments private, and bound tokens rendering against the original", async () => {
    const sessionId = "omp-bash-shell-projection";
    const secret = "sk-live-abc123XYZ";
    const command = `curl -H 'Authorization: Bearer ${secret}' https://x/y --out data/a.json`;
    const cwd = "/home/someone/private-project";
    const env = { API_TOKEN: "env-only-value" };
    const store = new InMemoryPrivateValueStore();
    const pipeline = new NormalizationPipeline({
      privateValueStore: store,
      redactionConfig: { customSecrets: [secret], sensitiveEnvVars: [] },
    });
    pipeline.registerDecoder(new OmpRecordDecoder());
    const timestamp = "2026-09-23T12:00:00.000Z";
    const results = await pipeline.processRecord(
      {
        recordId: `rec_${sessionId}`,
        sessionId,
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp,
        rawPayload: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "omp-bash-call",
                name: "bash",
                arguments: { command, cwd, env, timeout: 30, i: "Downloading data" },
              },
            ],
          },
        }),
        cursor: { offset: 1, line: 1, sequence: 1, timestamp },
        metadata: {},
      },
      { sessionId, harnessId: "omp", workspaceId: WORKSPACE },
    );
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const observed = results.flatMap((result) =>
      result.status === "success" && !result.isDuplicate
        ? [recorder.observe(result.event, { workspaceId: WORKSPACE })]
        : [],
    );
    const { carrier } = callAndCarrier(observed, "omp-bash-call");
    const origin = carrier.origins.command;
    if (origin?.type !== "program" || origin.source.type !== "literal") {
      throw new Error("expected a projected shell program origin");
    }
    const scrubbed = origin.source.value;
    if (typeof scrubbed !== "string") throw new Error("expected literal scrubbed source");
    expect(origin.language).toBe("shell");
    expect(scrubbed).not.toContain(secret);
    const sourceTokens = tokenizeProgram("shell", command);
    const secretIndex = sourceTokens.findIndex((token) => token.raw.includes(secret));
    expect(origin.protectedTokens).toEqual([secretIndex]);
    if (origin.sourceReference === undefined) throw new Error("expected a source reference");
    expect(resolvePrivateReference(store, origin.sourceReference)).toBe(command);
    expect(carrier.program?.source).toBe(scrubbed);
    for (const argument of ["cwd", "timeout", "i"]) {
      expect(carrier.origins[argument]?.type).toBe("private");
    }
    expect(JSON.stringify(carrier.origins.env)).not.toContain("env-only-value");

    const publicEvents = observed.map((entry) => projectEventToMetadataOnly(entry));
    const published = JSON.stringify(publicEvents);
    expect(published).not.toContain(secret);
    expect(published).not.toContain("private-project");
    expect(published).not.toContain("env-only-value");
    const recipe = recordCallsFromEvents(sessionId, publicEvents);
    const argument = recipe?.workflow.steps[0]?.arguments.find((entry) => entry.name === "command");
    const template = argument?.source.kind === "template" ? argument.source.template : undefined;
    if (template?.type !== "program") throw new Error("expected a shell program template");
    expect(template.sourceReference).toBe(origin.sourceReference);
    expect(template.protectedTokens).toEqual([secretIndex]);
    expect(JSON.stringify(recipe?.workflow)).not.toContain(secret);

    // A bound token renders against the local original, so the credential survives execution.
    const outIndex = sourceTokens.findIndex((token) => token.raw === "data/a.json");
    const rendered = applyProgramTokenValues(
      resolvePrivateReference(store, origin.sourceReference) as string,
      sourceTokens,
      new Map([[outIndex, "data/b.json"]]),
      "shell",
    );
    expect(rendered).toBe(
      `curl -H 'Authorization: Bearer ${secret}' https://x/y --out data/b.json`,
    );
  });
});
