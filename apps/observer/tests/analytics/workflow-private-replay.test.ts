import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  FilePrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import {
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const origin = { workspaceId: "ws-private-replay" };
const secret = "private-source-that-must-not-leave-the-host";

async function capture(
  store: FilePrivateValueStore,
  sessionId: string,
  recorder = new WorkflowCallRecorder({ privateValues: store }),
  access = origin,
) {
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: {
      customSecrets: [secret],
      maxStringLength: 32,
      homeDir: "/home/source",
      repoRoot: "/home/source/project",
    },
  });
  const parameters = [
    { path: `/home/source/project/${sessionId}-first.csv`, cwd: "/home/source/project/a" },
    { path: `/home/source/project/${sessionId}-second.csv`, cwd: "/home/source/project/b" },
  ];
  const answers = [
    `order_id,product\n${secret}\n${sessionId}-first,widget\n`,
    `order_id,product\n${secret}\n${sessionId}-second,gizmo\n`,
  ];
  const rows = [
    { type: "tool_call", callId: "first", toolName: "read", parameters: parameters[0] },
    {
      type: "tool_result",
      callId: "first",
      toolName: "read",
      result: answers[0],
      isError: false,
      executionDurationMs: 1,
    },
    { type: "message", role: "user", content: "Repeat with the other file" },
    { type: "tool_call", callId: "second", toolName: "read", parameters: parameters[1] },
    {
      type: "tool_result",
      callId: "second",
      toolName: "read",
      result: answers[1],
      isError: false,
      executionDurationMs: 1,
    },
  ];
  const events: NormalizedSessionEvent[] = [];
  const normalized: NormalizedSessionEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const result = await pipeline.processIntermediateEvent(
      {
        ...row,
        sessionId,
        timestamp: "2026-09-19T00:00:00.000Z",
        causalRef: { causalSequence: index + 1, parentId: null },
      },
      { ...access, sessionId },
    );
    if (result.status !== "success") throw new Error(result.errorReason);
    normalized.push(result.event);
    events.push(projectEventToMetadataOnly(recorder.observe(result.event, access)));
  }
  return { events, normalized, parameters, answers };
}

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "resin-private-replay-"));
  directories.push(directory);
  return { directory, store: new FilePrivateValueStore(directory) };
}

describe("exact local values across the real normalization boundary", () => {
  it("reconstructs final demonstration values before masks, aliases, and truncation", async () => {
    const { directory, store } = temporaryStore();
    const captured = await capture(store, "session-recovery");
    expect(JSON.stringify(captured.normalized)).not.toContain(secret);
    expect(JSON.stringify(captured.events)).not.toContain(secret);
    expect(JSON.stringify(captured.events)).not.toContain(captured.answers[1]);
    const recipe = recordCallsFromEvents("wf-recovery", captured.events.slice(0, 2), {
      supportingEvents: captured.events.slice(2),
    })!;
    const reopened = new FilePrivateValueStore(directory);
    const input = recipe.workflow.heldOut!.inputs.find((entry) => entry.argument === "path")!;
    const observation = recipe.workflow.heldOut!.observed[0]!;
    expect(resolvePrivateReference(reopened, input.reference)).toBe(captured.parameters[1]!.path);
    expect(resolvePrivateReference(reopened, observation.reference)).toBe(captured.answers[1]);
    expect(reopened.origin(input.reference)).toEqual(origin);
    const firstCarrier = readWorkflowCallCarrier(captured.events[0]!.metadata?.workflowCall)!;
    const cwd = firstCarrier.origins.cwd!;
    if (cwd.type !== "private") throw new Error("Expected a local cwd reference");
    expect(resolvePrivateReference(reopened, cwd.reference)).toBe(captured.parameters[0]!.cwd);
  });

  it("uses one paired cloud owner across different local project workspaces", async () => {
    const { store } = temporaryStore();
    const cloudOwner = { workspaceId: "ws-cloud-owner" };
    const recorder = new WorkflowCallRecorder({
      privateValues: store,
      privateValueOwnerWorkspaceId: cloudOwner.workspaceId,
    });
    const first = await capture(store, "session-project-a", recorder, {
      workspaceId: "project-a",
    });
    const second = await capture(store, "session-project-b", recorder, {
      workspaceId: "project-b",
    });

    for (const captured of [first, second]) {
      const carrier = readWorkflowCallCarrier(captured.events[0]!.metadata?.workflowCall)!;
      const pathOrigin = carrier.origins.path;
      if (pathOrigin?.type !== "private") throw new Error("Expected a private path reference");
      expect(store.origin(pathOrigin.reference)).toEqual(cloudOwner);
    }
  });

  it("does not reinterpret original text that merely looks like a redaction marker", async () => {
    const { store } = temporaryStore();
    const pipeline = new NormalizationPipeline({
      redactionConfig: { scanContent: false, sensitiveEnvVars: [] },
    });
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const original = {
      nested: ["literal [REDACTED_SECRET:example]", 7, false, null],
      payload: { value: "ordinary JSON", reference: "also data" },
    };
    const result = await pipeline.processIntermediateEvent(
      {
        sessionId: "session-literal",
        type: "tool_call",
        toolName: "unfamiliar",
        callId: "call-literal",
        parameters: original,
        timestamp: "2026-09-19T00:00:00.000Z",
        causalRef: { causalSequence: 1, parentId: null },
      },
      origin,
    );
    if (result.status !== "success") throw new Error(result.errorReason);
    const observed = recorder.observe(result.event, origin);
    const carrier = readWorkflowCallCarrier(observed.metadata?.workflowCall)!;
    expect(carrier.inputs).toEqual([]);
    const payload = carrier.origins.payload!;
    if (payload.type !== "object")
      throw new Error("Native object was interpreted as a Resin envelope");
    expect(Object.keys(payload.entries)).toEqual(["value", "reference"]);
    const nested = carrier.origins.nested!;
    if (nested.type !== "array") throw new Error("Expected an array");
    expect(
      nested.items.map((item) => {
        if (item.type !== "private") throw new Error("Expected a private leaf");
        return resolvePrivateReference(store, item.reference);
      }),
    ).toEqual(original.nested);
  });

  it("keeps references stable across sessions, fresh instances, and clear/restart", async () => {
    const { directory, store } = temporaryStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const first = await capture(store, "session-a", recorder);
    const recipe = recordCallsFromEvents("wf-a", first.events.slice(0, 2), {
      supportingEvents: first.events.slice(2),
    })!;
    const input = recipe.workflow.heldOut!.inputs.find((entry) => entry.argument === "path")!;
    const output = recipe.workflow.heldOut!.observed[0]!;
    await capture(new FilePrivateValueStore(directory), "session-b");
    recorder.clear();
    const replayed = await capture(store, "session-a", recorder);
    expect(
      replayed.events.map(
        (entry) => entry.metadata?.workflowCall ?? entry.metadata?.workflowResult,
      ),
    ).toEqual(
      first.events.map((entry) => entry.metadata?.workflowCall ?? entry.metadata?.workflowResult),
    );
    const reopened = new FilePrivateValueStore(directory);
    expect(resolvePrivateReference(reopened, input.reference)).toBe(first.parameters[1]!.path);
    expect(resolvePrivateReference(reopened, output.reference)).toBe(first.answers[1]);
    expect(input.reference).not.toBe(output.reference);
  });
});
