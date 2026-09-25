import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
} from "@resin/contracts";
import {
  InMemoryPrivateValueStore,
  type RecordableEvent,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
  resolvePrivateReference,
} from "@resin/observer";
import {
  RuntimeAdapterRegistry,
  type ToolProtocolDispatchRequest,
  applyAcceptedBindings,
  compileRecordedWorkflow,
  createProcessAdapter,
  createToolProtocolAdapter,
  instantiateRecordedWorkflow,
} from "@resin/runtime";
import { expect, it } from "vitest";
import { createLocalWorkflowValidator } from "../../src/proxy/workflow-validation.js";

it("validates a selected release workflow from its full repeat and uses a fresh identifier inside the program", async () => {
  const owner = "slice-reuse-owner";
  const authorDir = mkdtempSync(path.join(tmpdir(), "resin-slice-author-"));
  const consumerDir = mkdtempSync(path.join(tmpdir(), "resin-slice-consumer-"));
  try {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const events: NormalizedSessionEvent[] = [];
    let sequence = 0;
    const emit = (fields: Record<string, unknown>) =>
      events.push(
        projectEventToMetadataOnly(
          recorder.observe(
            NormalizedSessionEventSchema.parse({
              schemaVersion: "1.0.0",
              sessionId: "release-slice-session",
              eventId: `event-${sequence}`,
              timestamp: "2026-09-20T00:00:00.000Z",
              causalRef: { causalSequence: sequence++ },
              redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
              ...fields,
            }),
            { workspaceId: owner },
          ),
        ),
      );
    emit({
      type: "tool_discovery",
      source: "mcp",
      tools: [
        { name: "inspect", provider: "job-server" },
        { name: "produce", provider: "job-server" },
        { name: "seal", provider: "job-server" },
      ],
    });
    const makeResult = (
      name: string,
      args: Record<string, WorkflowJsonValue>,
    ): WorkflowJsonValue => {
      if (name === "inspect") return "inspection-complete";
      if (name === "produce") return { id: `release-for-${args.project}` };
      if (name === "seal") return { sealed: args.release };
      throw new Error(`unexpected tool: ${name}`);
    };
    const pair = (
      callId: string,
      name: string,
      args: Record<string, WorkflowJsonValue>,
      value: WorkflowJsonValue,
    ) => {
      emit({ type: "tool_call", callId, toolName: name, parameters: args });
      emit({
        type: "tool_result",
        callId,
        toolName: name,
        result: value,
        isError: false,
        executionDurationMs: 1,
      });
    };
    for (const [round, project] of ["alpha-project", "beta-project"].entries()) {
      emit({ type: "message", role: "user", content: "Produce and seal the release" });
      pair(`inspect-${round}`, "inspect", { root: "unchanged" }, makeResult("inspect", {}));
      const release = makeResult("produce", { project }) as { id: string };
      pair(`produce-${round}`, "produce", { project }, release);
      const command = `mkdir -p release && printf '%s\\n' '${release.id}' > release/README.txt && cat release/README.txt`;
      const printed = execFileSync("/bin/sh", ["-c", command], {
        cwd: authorDir,
        encoding: "utf8",
      });
      pair(`program-${round}`, "bash", { command }, printed);
      pair(
        `seal-${round}`,
        "seal",
        { release: release.id },
        makeResult("seal", { release: release.id }),
      );
    }
    const wanted = new Set(["produce-0", "program-0", "seal-0"]);
    const selected = events.filter(
      (event) =>
        (event.type === "tool_call" || event.type === "tool_result") && wanted.has(event.callId),
    );
    const recorded = recordCallsFromEvents("release-slice", selected as RecordableEvent[], {
      supportingEvents: events as RecordableEvent[],
    })!.workflow;
    const input: WorkflowBindingCandidate = {
      stepId: "step0",
      argument: "project",
      path: [],
      proposed: { kind: "input", name: "produce_project", type: "string" },
      reason: "declared-by-the-callable",
      missing: "the caller must confirm that project is a supplied input",
    };
    const plan = { ...recorded, candidates: [...(recorded.candidates ?? []), input] };
    expect(plan.steps.map((step) => step.callId)).toEqual([...wanted]);
    const seen: ToolProtocolDispatchRequest[] = [];
    const dispatch = async (request: ToolProtocolDispatchRequest) => {
      seen.push(request);
      return makeResult(request.name, request.arguments);
    };
    const answer = await createLocalWorkflowValidator({
      workspaceId: owner,
      privateValues: store,
      dispatch,
    })(plan);
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification).toMatchObject({
      status: "verified",
      reproduced: ["step0", "step1", "step2"],
      missed: [],
    });
    const accepted = answer.verdicts
      .filter((verdict) => verdict.confirmed)
      .map(
        (verdict) =>
          plan.candidates!.find(
            (candidate) =>
              candidate.stepId === verdict.candidate.stepId &&
              candidate.argument === verdict.candidate.argument &&
              JSON.stringify(candidate.path) === JSON.stringify(verdict.candidate.path),
          )!,
      );
    const promoted = applyAcceptedBindings(plan, accepted);
    const artifact = compileRecordedWorkflow(promoted);
    expect(artifact.inputSchema.required).toEqual(["produce_project"]);
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: consumerDir }));
    adapters.register(createToolProtocolAdapter({ dispatch }));
    const callable = instantiateRecordedWorkflow(artifact, {
      adapters,
      access: { workspaceId: owner },
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as WorkflowJsonValue,
    });
    seen.length = 0;
    for (const project of ["gamma-project", "delta-project"]) {
      const result = await callable.invoke({ produce_project: project });
      expect(result.status, result.error).toBe("completed");
      expect(result.result).toEqual({ sealed: `release-for-${project}` });
      expect(readFileSync(path.join(consumerDir, "release/README.txt"), "utf8")).toBe(
        `release-for-${project}\n`,
      );
    }
    expect(seen.map((request) => request.name)).toEqual(["produce", "seal", "produce", "seal"]);
    expect(readFileSync(path.join(authorDir, "release/README.txt"), "utf8")).toBe(
      "release-for-beta-project\n",
    );
  } finally {
    rmSync(authorDir, { recursive: true, force: true });
    rmSync(consumerDir, { recursive: true, force: true });
  }
});
