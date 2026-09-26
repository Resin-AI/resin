/**
 * End to end: a real Codex service-config recording (apply_patch, ./build.sh, ./check.sh NAME) is
 * captured in a workspace, its offered inputs promoted, and the plan invoked there with new values:
 * the edit writes the new entry and the later steps see it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import { type NormalizedSessionEvent, validateRecordedWorkflow } from "@resin/contracts";
import {
  InMemoryPrivateValueStore,
  NormalizationPipeline,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
  resolvePrivateReference,
} from "@resin/observer";
import {
  RuntimeAdapterRegistry,
  applyAcceptedBindings,
  createProcessAdapter,
  executeRecordedWorkflow,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKSPACE = "workspace-codex-patch-replay";
const SERVICES = [
  "# Services routed by the edge proxy. Run ./build.sh after editing.",
  "services:",
  "  - name: accounts",
  "    port: 8070",
  "    path: /accounts",
  "  - name: catalog",
  "    port: 8071",
  "    path: /catalog",
  "  - name: orders",
  "    port: 8072",
  "    path: /orders",
  "",
  "# Proxy defaults; these are not services.",
  "timeout: 30",
  "",
].join("\n");
const DIFF =
  "@@ -11,2 +11,5 @@\n     path: /orders\n+  - name: media\n+    port: 8083\n+    path: /media\n \n";
const BUILD = `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
grep -E '^  - name: ' services.yaml | sed 's/^  - name: //' > dist/names
echo "built $(wc -l < dist/names | tr -d ' ') services"
`;
const CHECK = `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
grep -qx "$1" dist/names && echo OK
`;

function command(id: string, cmd: string, stdout: string, at: number, root: string) {
  return {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        id,
        command: ["/bin/bash", "-lc", cmd],
        cwd: `file://${root}`,
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

async function recordServiceConfig(store: InMemoryPrivateValueStore, root: string) {
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const sessionId = "codex-patch-replay";
  const timestamp = "2026-09-26T12:00:00.000Z";
  const native = [
    { type: "session_meta", payload: { session_id: sessionId, id: sessionId, cwd: root } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: root, model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Add the `media` service (port 8083, path /media) to the edge proxy.",
          },
        ],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "FileChange",
          id: "exec-patch",
          changes: {
            [`${root}/services.yaml`]: { type: "update", unified_diff: DIFF, move_path: null },
          },
          status: "completed",
          stdout: `Success. Updated the following files:\nM ${root}/services.yaml\n`,
          stderr: "",
        },
        started_at_ms: 2_000,
        completed_at_ms: 2_005,
      },
    },
    command("exec-build", "./build.sh", "built 4 services\n", 3_000, root),
    command("exec-check", "./check.sh media", "OK\n", 4_000, root),
  ];
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of native.entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${ordinal}`,
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
  const recipe = recordCallsFromEvents(
    sessionId,
    observed.map((entry) => projectEventToMetadataOnly(entry)),
  );
  if (recipe === undefined) throw new Error("expected a recording");
  return recipe.workflow;
}

describe("invoking a recorded Codex edit with new values", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "resin-codex-patch-"));
    fs.writeFileSync(path.join(workspace, "services.yaml"), SERVICES);
    fs.writeFileSync(path.join(workspace, "build.sh"), BUILD, { mode: 0o755 });
    fs.writeFileSync(path.join(workspace, "check.sh"), CHECK, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("writes the new entry, and the build and check steps run on it", async () => {
    const store = new InMemoryPrivateValueStore();
    const recorded = await recordServiceConfig(store, workspace);
    const plan = applyAcceptedBindings(
      recorded,
      (recorded.candidates ?? []).filter((candidate) => candidate.proposed.kind === "input"),
    );
    expect(validateRecordedWorkflow(plan).valid).toBe(true);
    expect(plan.inputs.map((input) => input.name).sort()).toEqual(["name", "port"]);

    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace }));
    const run = await executeRecordedWorkflow(plan, {
      inputs: { name: "search", port: "8084" },
      adapters,
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as never,
      access: { workspaceId: WORKSPACE },
    });
    expect(run.status, JSON.stringify(run.steps)).toBe("completed");
    expect(fs.readFileSync(path.join(workspace, "services.yaml"), "utf8")).toBe(
      SERVICES.replace(
        "    path: /orders\n",
        "    path: /orders\n  - name: search\n    port: 8084\n    path: /search\n",
      ),
    );
    expect(run.steps.map((step) => (step.status === "completed" ? step.result : step))).toEqual([
      "patched",
      "built 4 services\n",
      "OK\n",
    ]);
  });

  it("offers the same inputs wherever the project lives", async () => {
    const offers = new Set<string>();
    for (let index = 0; index < 200; index++) {
      const root = fs.mkdtempSync(path.join(workspace, "project-"));
      const recorded = await recordServiceConfig(new InMemoryPrivateValueStore(), root);
      offers.add(JSON.stringify(recorded.candidates ?? []));
    }
    expect(offers.size).toBe(1);
    expect(JSON.parse([...offers][0]!).length).toBeGreaterThan(0);
  });
});
