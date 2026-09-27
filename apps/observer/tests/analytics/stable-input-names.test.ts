/**
 * A value can first be offered as an input at an earlier call once a later call repeats it. The
 * recorder freezes each call's proposals when that call is recorded, so the name a proposal used
 * must still mean the same value when later calls are derived.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionDecoder } from "@resin/adapter-codex";
import { tokenizeProgram } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { FilePrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";

interface InputProposal {
  path: [string, number];
  proposed: { kind: string; name?: string };
}

/** A Codex 0.141 rollout: one instruction, then direct `exec_command` calls in order. */
function rollout(instruction: string, commands: string[]): string {
  const lines: unknown[] = [
    { type: "session_meta", payload: { id: "sess-names", cwd: "/work", cli_version: "0.141.0" } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: "/work", model: "gpt-5.5" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: instruction }],
      },
    },
  ];
  commands.forEach((cmd, index) => {
    lines.push(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: `call-${index}`,
          arguments: JSON.stringify({ cmd, workdir: "/work" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `call-${index}`,
          output: `Chunk ID: c${index}\nWall time: 0.0100 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\nok ${index}\n`,
        },
      },
    );
  });
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("input names across a growing recording", () => {
  it("never gives one input name to two different recorded values", () => {
    const commands = [
      // `f` appears once here, so it is not offered yet.
      "find backups -maxdepth 2 -type f -print",
      "./dbtool check inventory",
      "./dbtool dump --date 2025-06-01 inventory",
      // Now `f` is shared, so it is offered, including at the first call.
      "find backups -maxdepth 1 -type f -printf '%f\\n'",
      "find backups -maxdepth 1 -type f -name '*.sql' -print",
    ];
    const recorder = new WorkflowCallRecorder({
      privateValues: new FilePrivateValueStore(mkdtempSync(join(tmpdir(), "stable-names-"))),
    });
    const events = new CodexSessionDecoder().decodeTranscript(
      rollout("Back up the `inventory` database for 2025-06-01.", commands),
    );
    const valuesByName = new Map<string, Set<string>>();
    for (const event of events) {
      const observed = recorder.observe(event, { workspaceId: "ws-stable-names" });
      if (observed.type !== "tool_call") continue;
      const command = String((observed.parameters as { cmd?: unknown }).cmd);
      const tokens = tokenizeProgram("shell", command);
      // The carrier as recorded, before projection re-reads it.
      const carrier = observed.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY] as
        | { candidates?: InputProposal[] }
        | undefined;
      for (const candidate of carrier?.candidates ?? []) {
        if (candidate.proposed.kind !== "input" || candidate.path[0] !== "tokens") continue;
        if (candidate.proposed.name === undefined) continue;
        const value = String(tokens[Number(candidate.path[1])]?.value);
        const values = valuesByName.get(candidate.proposed.name) ?? new Set<string>();
        values.add(value);
        valuesByName.set(candidate.proposed.name, values);
      }
    }
    const inventoryName = [...valuesByName].find(([, values]) => values.has("inventory"))?.[0];
    const typeName = [...valuesByName].find(([, values]) => values.has("f"))?.[0];
    expect(inventoryName).toBeDefined();
    expect(typeName).toBeDefined();
    expect(inventoryName).not.toBe(typeName);
    for (const [name, values] of valuesByName)
      expect({ name, values: values.size }).toEqual({ name, values: 1 });
  });
});
