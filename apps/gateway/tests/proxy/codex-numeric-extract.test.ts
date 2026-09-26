/**
 * End to end: a Codex data job prints a computed number (`total 12.9107 rounded 12.91`) and a later
 * command writes it (`printf '12.91' > /app/answer.txt`). The written number is offered as an
 * extract of the printed one, and the promoted plan writes the number the script computes on new data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import {
  type NormalizedSessionEvent,
  type RecordedWorkflow,
  parseExtractLocator,
  programTokenPath,
  tokenizeProgram,
  validateRecordedWorkflow,
} from "@resin/contracts";
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

const WORKSPACE = "workspace-codex-numeric-extract";
const REQUEST =
  "Sum the fees in /app/fees.txt, round to cents and write the answer to /app/answer.txt.";
const script = (format: string) =>
  [
    "python3 - <<'EOF'",
    "total = sum(float(line) for line in open('/app/fees.txt'))",
    `print(f"${format}")`,
    "EOF",
  ].join("\n");
const TOTAL_SCRIPT = script("total {total:.4f} rounded {total:.2f}");
const WRITE = "printf '12.91' > /app/answer.txt";

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

async function record(
  store: InMemoryPrivateValueStore,
  session: { request: string; source: string; printed: string },
): Promise<RecordedWorkflow> {
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const sessionId = "codex-numeric-extract";
  const timestamp = "2026-09-26T12:00:00.000Z";
  const native = [
    { type: "session_meta", payload: { session_id: sessionId, id: sessionId, cwd: "/app" } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: "/app", model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: session.request }],
      },
    },
    command("exec-total", session.source, session.printed, 1_000),
    command("exec-write", WRITE, "", 2_000),
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
  expect(validateRecordedWorkflow(recipe.workflow)).toEqual({ valid: true, errors: [] });
  return recipe.workflow;
}

/** The extract candidates, each with the token value it binds. */
function extracts(workflow: RecordedWorkflow) {
  const byStep = new Map(workflow.steps.map((step) => [step.id, step]));
  return (workflow.candidates ?? []).flatMap((candidate) => {
    if (candidate.proposed.kind !== "extract") return [];
    const source = byStep.get(candidate.stepId)!.callable.program!.source;
    const token = tokenizeProgram("shell", source)[programTokenPath(candidate.path)!.token]!;
    return [{ candidate, proposed: candidate.proposed, value: token.value }];
  });
}

describe("a computed number written by a later command", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "resin-numeric-extract-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("is offered as an extract of the printed number and replays with the new total", async () => {
    const store = new InMemoryPrivateValueStore();
    const recorded = await record(store, {
      request: REQUEST,
      source: TOTAL_SCRIPT,
      printed: "total 12.9107 rounded 12.91\n",
    });
    const offered = extracts(recorded);
    expect(offered.map((entry) => [entry.value, entry.proposed.stepId])).toEqual([
      ["12.91", recorded.steps[0]!.id],
    ]);
    const locator = parseExtractLocator(
      String(resolvePrivateReference(store, offered[0]!.proposed.locator)),
    );
    expect(locator?.before).toMatch(/[A-Za-z]/);

    const plan = applyAcceptedBindings(recorded, [offered[0]!.candidate]);
    fs.writeFileSync(path.join(workspace, "fees.txt"), "3.25\n1.1\n0.004\n");
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(
      createProcessAdapter({
        cwd: workspace,
        recordedWorkspaceRoot: "/app",
        isolateEnvironment: true,
      }),
    );
    const run = await executeRecordedWorkflow(plan, {
      inputs: {},
      adapters,
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as never,
      access: { workspaceId: WORKSPACE },
    });
    expect(run.status, JSON.stringify(run.steps)).toBe("completed");
    expect(fs.readFileSync(path.join(workspace, "answer.txt"), "utf8")).toBe("4.35");
  });

  it("is not offered when the request names it or only punctuation precedes it", async () => {
    const named = await record(new InMemoryPrivateValueStore(), {
      request: `${REQUEST} The expected answer is 12.91.`,
      source: TOTAL_SCRIPT,
      printed: "total 12.9107 rounded 12.91\n",
    });
    expect(extracts(named)).toEqual([]);

    const unnamed = await record(new InMemoryPrivateValueStore(), {
      request: REQUEST,
      source: script("{total:.4f} => {total:.2f}"),
      printed: "12.9107 => 12.91\n",
    });
    expect(extracts(unnamed)).toEqual([]);
  });
});
