/**
 * A Codex session that edits a file with apply_patch and then builds records the edit as a private
 * patch step before the build and check steps, with the values it added offered as inputs.
 */
import { CodexRecordDecoder } from "@resin/adapter-codex";
import { type NormalizedSessionEvent, tokenizeProgram } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-codex-patch-steps";
const DIFF =
  "@@ -11,2 +11,5 @@\n     path: /orders\n+  - name: media\n+    port: 8083\n+    path: /media\n \n";
const PATCH = `--- /app/services.yaml\n+++ /app/services.yaml\n${DIFF}`;

function command(id: string, cmd: string, stdout: string, at: number) {
  return {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        id,
        command: ["/bin/bash", "-lc", cmd],
        cwd: "file:///app",
        status: "completed",
        stdout,
        stderr: "",
        exit_code: 0,
        duration: { secs: 0, nanos: 5_000_000 },
      },
      started_at_ms: at,
      completed_at_ms: at + 5,
    },
  };
}

/** The real service-config sequence, through the real Codex decoder and normalization pipeline. */
async function recordServiceConfig(sessionId: string, diff = DIFF, customSecrets: string[] = []) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets, sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const timestamp = "2026-09-26T12:00:00.000Z";
  const patchCell = `text(await tools.apply_patch(${JSON.stringify(
    `*** Begin Patch\n*** Update File: /app/services.yaml\n@@\n   - name: orders\n${diff}*** End Patch`,
  )}));\n`;
  const native = [
    { type: "session_meta", payload: { session_id: sessionId, id: sessionId, cwd: "/app" } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: "/app", model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Add the `media` service (port 8083, path /media) to the edge proxy in /app.",
          },
        ],
      },
    },
    command("exec-read", "cat services.yaml", "services:\n  - name: orders\n", 1_000),
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call_patch", input: patchCell },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "FileChange",
          id: "exec-patch",
          changes: {
            "/app/services.yaml": { type: "update", unified_diff: diff, move_path: null },
          },
          status: "completed",
          stdout: "Success. Updated the following files:\nM /app/services.yaml\n",
          stderr: "",
        },
        started_at_ms: 2_000,
        completed_at_ms: 2_005,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_patch",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          { type: "input_text", text: "{}" },
        ],
      },
    },
    command("exec-build", "./build.sh", "built 4 services\n", 3_000),
    command("exec-check", "./check.sh media", "OK\n", 4_000),
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
  const projected = observed.map((entry) => projectEventToMetadataOnly(entry));
  const recipe = recordCallsFromEvents(sessionId, projected);
  if (recipe === undefined) throw new Error("expected a recording");
  return { store, projected, workflow: recipe.workflow };
}

describe("Codex patch steps", () => {
  it("records a private patch step before build and check, offering its added values", async () => {
    const { store, projected, workflow } = await recordServiceConfig("codex-patch-service-config");
    expect(workflow.steps.map((step) => step.callable.name)).toEqual([
      "command_exec",
      "apply_patch",
      "command_exec",
      "command_exec",
    ]);
    const patch = workflow.steps[1]!;
    expect(patch.callable).toEqual({
      runtime: "resin-process",
      name: "apply_patch",
      program: { kind: "patch", source: "", argument: "patch" },
    });
    const argument = patch.arguments.find((entry) => entry.name === "patch")!;
    expect(argument.source).toMatchObject({
      kind: "template",
      template: { type: "program", language: "patch", source: { type: "private" }, holes: [] },
    });
    // The private reference resolves locally to the exact recorded diff.
    if (argument.source.kind !== "template" || argument.source.template.type !== "program") return;
    const source = argument.source.template.source;
    if (source.type !== "private") return;
    expect(store.get(source.reference)).toBe(PATCH);

    // No text of the diff reaches the record or its cloud projection.
    for (const text of [JSON.stringify(workflow), JSON.stringify(projected)]) {
      // As a standalone token: random event ids and digests may contain these digits.
      expect(text).not.toMatch(/(?<![0-9A-Za-z])8083(?![0-9A-Za-z])/);
      expect(text).not.toContain("name: media");
      expect(text).not.toContain("path: /orders");
    }

    // The added values are inputs; `media` is the same input where ./check.sh uses it, and it
    // is also the part of `/media` a span hole follows.
    const tokens = tokenizeProgram("patch", PATCH);
    const offered = (workflow.candidates ?? []).flatMap((candidate) =>
      candidate.proposed.kind === "input" && candidate.stepId === patch.id
        ? [
            [
              tokens[candidate.path[1] as number]?.value,
              candidate.path.slice(2),
              candidate.proposed.name,
            ],
          ]
        : [],
    );
    expect(offered).toEqual([
      ["media", [], "name"],
      ["8083", [], "port"],
      ["/media", ["span", 1, 6], "name"],
    ]);
    const check = workflow.steps[3]!;
    expect(
      workflow.candidates?.find((candidate) => candidate.stepId === check.id)?.proposed,
    ).toEqual({ kind: "input", name: "name", type: "string", recordedDefault: true });
  });

  it("offers nothing inside a patch the redaction engine would change", async () => {
    const secret = "sk-live-patchSecret9QX";
    const { workflow } = await recordServiceConfig(
      "codex-patch-secret",
      DIFF.replace(" \n", `+    token: ${secret}\n \n`).replace("+11,5", "+11,6"),
      [secret],
    );
    const patch = workflow.steps.find((step) => step.callable.name === "apply_patch")!;
    expect(workflow.candidates?.filter((candidate) => candidate.stepId === patch.id)).toEqual([]);
    expect(JSON.stringify(workflow)).not.toContain(secret);
  });
});
