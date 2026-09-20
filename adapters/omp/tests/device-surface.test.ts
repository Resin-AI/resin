/**
 * OMP's device surface: a callable is reached by writing JSON to `xd://mcp__<server>_<tool>`.
 *
 * The two halves of that path are not recoverable from the path alone — the tool's own name may
 * contain underscores — so the mapping is resolved against the server names the harness itself is
 * configured with, longest name first. These tests pin that resolution, the capture that follows
 * from it, and the calls it must leave unresolved rather than guess.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  IntermediateSessionEvent,
  IntermediateToolCallEvent,
  IntermediateToolDiscoveryEvent,
  IntermediateToolResultEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { OmpRecordDecoder } from "../src/decoder.js";
import { readConfiguredOmpServers, resolveOmpDeviceSurfaceCall } from "../src/device-surface.js";

const SERVERS = ["alpha", "alpha_beta"];

function record(sequence: number, payload: unknown): RawHarnessRecord {
  const timestamp = "2026-09-18T10:00:00.000Z";
  return {
    recordId: `rec_${sequence}`,
    sessionId: "session_device_surface",
    harnessId: "omp",
    sequenceNumber: sequence,
    timestamp,
    recordType: "transcript_line",
    rawPayload: payload,
    cursor: { offset: sequence * 10, line: sequence, sequence, timestamp },
    metadata: {},
  };
}

/** The start marker OMP writes before the assistant record of the same call. */
function startMarker(callId: string, devicePath: string): unknown {
  return {
    type: "custom",
    customType: "tool_execution_start",
    data: { toolCallId: callId, toolName: "write", args: { path: devicePath } },
  };
}

/** The assistant record, which carries the invocation's own arguments. */
function assistantWrite(callId: string, devicePath: string, argumentsJson: string): unknown {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: callId,
          name: "write",
          arguments: { path: devicePath, content: argumentsJson, i: "invoke" },
        },
      ],
    },
  };
}

/** The start marker for a call that reaches a no-argument callable by reading its device path. */
function readMarker(callId: string, devicePath: string): unknown {
  return {
    type: "custom",
    customType: "tool_execution_start",
    data: { toolCallId: callId, toolName: "read", args: { path: devicePath } },
  };
}

/** The assistant record for a read, which carries the path and nothing else. */
function assistantRead(callId: string, devicePath: string): unknown {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: devicePath } }],
    },
  };
}

/** The result of a read, reported under the transport's own name. */
function readResult(callId: string, text: string): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      content: [{ type: "text", text }],
    },
  };
}

function toolResult(callId: string, text: string): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "write",
      content: [{ type: "text", text }],
    },
  };
}

/** Everything the decoder produced for the given records, flattened and typed by kind. */
function decodeAll(payloads: unknown[], servers: readonly string[] = SERVERS) {
  const decoder = new OmpRecordDecoder({ deviceSurfaceServers: () => servers });
  const events: IntermediateSessionEvent[] = [];
  payloads.forEach((payload, index) => {
    const decoded = decoder.decode(record(index + 1, payload), {
      sessionId: "session_device_surface",
      harnessId: "omp",
    });
    if (decoded === null) return;
    events.push(...(Array.isArray(decoded) ? decoded : [decoded]));
  });
  return {
    events,
    calls: events.filter((event): event is IntermediateToolCallEvent => event.type === "tool_call"),
    discoveries: events.filter(
      (event): event is IntermediateToolDiscoveryEvent => event.type === "tool_discovery",
    ),
    results: events.filter(
      (event): event is IntermediateToolResultEvent => event.type === "tool_result",
    ),
  };
}

describe("resolving a device path against the harness's own servers", () => {
  it("gives the longest configured server name its own tools, and keeps underscore names whole", () => {
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__alpha_run", SERVERS)).toEqual({
      connection: "alpha",
      tool: "run",
    });
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__alpha_beta_run", SERVERS)).toEqual({
      connection: "alpha_beta",
      tool: "run",
    });
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__alpha_deep_tool_name", SERVERS)).toEqual({
      connection: "alpha",
      tool: "deep_tool_name",
    });
  });

  it("resolves a server whose configured name contains dashes as the path spells it", () => {
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__alpha_beta_run", ["alpha-beta"])).toEqual({
      connection: "alpha-beta",
      tool: "run",
    });
  });

  it("leaves a path unresolved when no configured server owns it", () => {
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__other_run", SERVERS)).toBeUndefined();
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__alpha", SERVERS)).toBeUndefined();
    expect(resolveOmpDeviceSurfaceCall("mcp__alpha_run", SERVERS)).toBeUndefined();
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__alpha_run", [])).toBeUndefined();
  });

  it("leaves a path unresolved when two configured names own it equally", () => {
    expect(resolveOmpDeviceSurfaceCall("xd://mcp__a_b_run", ["a_b", "a-b"])).toBeUndefined();
  });
});

describe("reading the servers the harness is configured with", () => {
  it("reads the workspace config first and the OMP home config otherwise, and tolerates neither", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-device-surface-"));
    const ompHome = path.join(root, "omp-home");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, ".omp", "agent"), { recursive: true });
    fs.mkdirSync(path.join(ompHome, "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(ompHome, "agent", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: { command: "alpha-server" },
          shared: { command: "home-shared" },
          malformed: "not an entry",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspace, ".omp", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "workspace-shared" } } }),
      "utf8",
    );
    try {
      expect(
        readConfiguredOmpServers({ workspaceRoot: workspace, ompHome }).map((server) => [
          server.name,
          server.entry.command,
        ]),
      ).toEqual([
        ["alpha", "alpha-server"],
        // The workspace's own entry for a server the home config also declares is the one taken.
        ["shared", "workspace-shared"],
      ]);
      // A workspace with no config of its own reads the home config, and a config that is not one
      // contributes no servers at all.
      expect(readConfiguredOmpServers({ workspaceRoot: root, ompHome }).map((s) => s.name)).toEqual(
        ["alpha", "shared"],
      );
      expect(readConfiguredOmpServers({ ompHome: path.join(root, "missing") })).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("capturing a call made through the device surface", () => {
  it("records the tool the path reached, over the connection that owns it, with the invocation's arguments", () => {
    const { calls, discoveries, results } = decodeAll([
      startMarker("call_1", "xd://mcp__alpha_beta_run"),
      assistantWrite("call_1", "xd://mcp__alpha_beta_run", '{"query":"rows","limit":2}'),
      toolResult("call_1", '{"rows":[]}'),
    ]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // The middle name is the pointed case: a naive split of the path would produce `beta_run`.
    expect(call.toolName).toBe("run");
    expect(call.connection).toBe("alpha_beta");
    expect(call.parameters).toEqual({ query: "rows", limit: 2 });
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]!.tools).toEqual([{ name: "run", provider: "alpha_beta" }]);
    // The result belongs to the call's own identity, not to the transport that carried it.
    expect(results[0]!.toolName).toBe("run");
    expect(results[0]!.result).toEqual({ rows: [] });
  });

  it("keeps the tool's own name whole when it contains underscores", () => {
    const { calls, discoveries } = decodeAll([
      startMarker("call_2", "xd://mcp__alpha_deep_tool_name"),
      assistantWrite("call_2", "xd://mcp__alpha_deep_tool_name", "{}"),
    ]);

    expect(calls[0]!.toolName).toBe("deep_tool_name");
    expect(calls[0]!.connection).toBe("alpha");
    expect(discoveries[0]!.tools).toEqual([{ name: "deep_tool_name", provider: "alpha" }]);
  });

  it("records a callable that takes no arguments, reached by reading its device path", () => {
    const { calls, discoveries, results } = decodeAll([
      readMarker("call_5", "xd://mcp__alpha_beta_run"),
      assistantRead("call_5", "xd://mcp__alpha_beta_run"),
      readResult("call_5", '{"rows":[]}'),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("run");
    expect(calls[0]!.connection).toBe("alpha_beta");
    // The transport's envelope is not an argument of the callable it reached.
    expect(calls[0]!.parameters).toEqual({});
    expect(discoveries[0]!.tools).toEqual([{ name: "run", provider: "alpha_beta" }]);
    expect(results[0]!.toolName).toBe("run");
    expect(results[0]!.result).toEqual({ rows: [] });
  });

  it("leaves a path no configured server owns opaque, with no connection", () => {
    const { calls, discoveries } = decodeAll([
      startMarker("call_3", "xd://mcp__unconfigured_run"),
      assistantWrite("call_3", "xd://mcp__unconfigured_run", "{}"),
      toolResult("call_3", "{}"),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("write");
    expect(calls[0]!.connection).toBeUndefined();
    expect(calls[0]!.parameters).toEqual({ path: "xd://mcp__unconfigured_run" });
    expect(discoveries).toHaveLength(0);
  });

  it("does not treat a write to an ordinary file as a device-surface call", () => {
    const { calls } = decodeAll([
      startMarker("call_4", "/tmp/report.json"),
      assistantWrite("call_4", "/tmp/report.json", '{"rows":[]}'),
    ]);

    expect(calls[0]!.toolName).toBe("write");
    expect(calls[0]!.connection).toBeUndefined();
  });

  it("records an invocation whose start marker is absent, from the assistant record alone", () => {
    // With no record of its own to carry a discovery, the call still names the tool and the
    // connection its path resolved to; the connection is recorded on the call itself.
    const { calls, discoveries } = decodeAll([
      assistantWrite("call_6", "xd://mcp__alpha_run", '{"query":"rows"}'),
      toolResult("call_6", "{}"),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("run");
    expect(calls[0]!.connection).toBe("alpha");
    expect(calls[0]!.parameters).toEqual({ query: "rows" });
    expect(discoveries).toHaveLength(0);
  });

  it("records an invocation whose arguments never arrive, when its result does", () => {
    // A transcript can be cut short between the start marker and the assistant record; the call
    // that ran is still recorded, over the connection its path names.
    const { calls, discoveries, results } = decodeAll([
      startMarker("call_5", "xd://mcp__alpha_run"),
      toolResult("call_5", "{}"),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("run");
    expect(calls[0]!.connection).toBe("alpha");
    expect(discoveries[0]!.tools).toEqual([{ name: "run", provider: "alpha" }]);
    expect(results).toHaveLength(1);
  });

  it("preserves exact non-JSON text returned by a device-surface tool", () => {
    const { results } = decodeAll([
      startMarker("call_text", "xd://mcp__alpha_run"),
      assistantWrite("call_text", "xd://mcp__alpha_run", "{}"),
      toolResult("call_text", "  printed text\n"),
    ]);

    expect(results[0]!.result).toBe("  printed text\n");
  });
});
