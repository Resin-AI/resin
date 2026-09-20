/**
 * The identity a callable is recorded by: its own name, over the connection it was reached through.
 *
 * Two connections may expose the same short tool name — that is ordinary for MCP — so a session's
 * discovery is only meaningful per connection. What one server reported about `run` says nothing
 * about another server's `run`, and a report that carries less than an earlier one for the same
 * connection (a harness device surface names the connection and nothing else) must not drop what
 * was already established for it: the callable's own schema is what its arguments are proposed
 * against.
 */

import type { NormalizedSessionEvent } from "@resin/contracts";
import { NormalizedSessionEventSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";

const SESSION = "session-tool-connection";

const SCHEMA_ALPHA = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};
const SCHEMA_ALPHA_BETA = {
  type: "object",
  properties: { target: { type: "string" } },
  required: ["target"],
};

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: SESSION,
    timestamp: "2026-09-18T10:00:00.000Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}

function discovery(
  tools: Array<{ name: string; provider?: string; inputSchema?: unknown }>,
): NormalizedSessionEvent {
  return event({
    eventId: `evt_discovery_${tools.map((tool) => `${tool.name}-${tool.provider ?? "none"}`).join("_")}`,
    type: "tool_discovery",
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.provider === undefined ? {} : { provider: tool.provider }),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    })),
    source: "mcp",
    causalRef: { causalSequence: 0, parentId: null },
  });
}

function call(
  sequence: number,
  toolName: string,
  parameters: Record<string, unknown>,
  connection?: string,
): NormalizedSessionEvent {
  return event({
    eventId: `evt_call_${sequence}`,
    type: "tool_call",
    callId: `call_${sequence}`,
    toolName,
    parameters,
    ...(connection === undefined ? {} : { connection }),
    causalRef: { causalSequence: sequence, parentId: null, turnIndex: 0, stepIndex: 0 },
  });
}

/** Drives the recorder exactly as the capture coordinator does, in recorded order. */
function record(events: NormalizedSessionEvent[]) {
  const recorder = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() });
  return events.map((entry) => {
    const observed = recorder.observe(entry, { workspaceId: "ws_tool_connection" });
    return readWorkflowCallCarrier(observed.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
  });
}

describe("the connection a callable was recorded over", () => {
  it("tells two connections that expose the same name apart, each with its own schema", () => {
    const carriers = record([
      discovery([
        { name: "run", provider: "alpha", inputSchema: SCHEMA_ALPHA },
        { name: "run", provider: "alpha_beta", inputSchema: SCHEMA_ALPHA_BETA },
      ]),
      call(1, "run", { query: "rows" }, "alpha"),
      call(2, "run", { target: "rows" }, "alpha_beta"),
    ]);

    // The call that resolved its own connection is answered by what that connection reported: the
    // name's most recent report is another server's, and is not this callable's.
    expect(carriers[1]!.connection).toBe("alpha");
    expect(carriers[1]!.inputSchema).toEqual(SCHEMA_ALPHA);
    expect(carriers[2]!.connection).toBe("alpha_beta");
    expect(carriers[2]!.inputSchema).toEqual(SCHEMA_ALPHA_BETA);
  });

  it("keeps what a connection established when a later report for it carries less", () => {
    // A harness device surface announces the connection a path reached and nothing else; the schema
    // the same connection reported when its tools were listed is still what its callable accepts.
    const carriers = record([
      discovery([{ name: "run", provider: "alpha", inputSchema: SCHEMA_ALPHA }]),
      discovery([{ name: "run", provider: "alpha" }]),
      call(1, "run", { query: "rows" }, "alpha"),
    ]);

    expect(carriers[2]!.connection).toBe("alpha");
    expect(carriers[2]!.inputSchema).toEqual(SCHEMA_ALPHA);
  });

  it("takes the name's own report for a call that established no connection", () => {
    const carriers = record([
      discovery([
        { name: "run", provider: "alpha", inputSchema: SCHEMA_ALPHA },
        { name: "run", provider: "alpha_beta", inputSchema: SCHEMA_ALPHA_BETA },
      ]),
      call(1, "run", { query: "rows" }),
    ]);

    expect(carriers[1]!.connection).toBe("alpha_beta");
  });

  it("leaves a call with no connection when nothing reported one", () => {
    const carriers = record([call(1, "unheard_of", { query: "rows" })]);
    expect(carriers[0]!.connection).toBeUndefined();
  });
});
