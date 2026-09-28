/**
 * A recorded create → wait → smoke → promote job whose `create` prints a fresh random id. Checked
 * against its own recording, the printed-id bindings are confirmed and the promoted plan feeds each
 * invocation's own id to the later commands.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type RecordedWorkflow,
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
  applyAcceptedBindings,
  compileRecordedWorkflow,
  createProcessAdapter,
  instantiateRecordedWorkflow,
} from "@resin/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor } from "./recorded-sessions.js";

const owner = "extract-binding-owner";

const DEPLOYCTL = `#!/bin/sh
set -e
state=.deployments
case "$1" in
  create)
    id="\${DEPLOY_ID:-dep-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \\n')}"
    echo "$id" >> "$state"
    echo "created deployment $id"
    ;;
  wait|smoke|promote)
    for id; do :; done
    if ! grep -qx "$id" "$state" 2>/dev/null; then echo "unknown deployment $id" >&2; exit 1; fi
    case "$1" in
      wait) echo "deployment $id healthy" ;;
      smoke) echo "smoke ok" ;;
      promote) echo "promoted $id to production" ;;
    esac
    ;;
  *) exit 2 ;;
esac
`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  const script = path.join(directory, "deployctl");
  writeFileSync(script, DEPLOYCTL);
  chmodSync(script, 0o755);
  return directory;
}

/**
 * Runs the job for real in an author directory and records it as one execution. The recorded id is
 * fixed, so what a check decides never depends on which id a run happened to mint; invocations of
 * a promoted plan still mint fresh ones.
 */
function recordJob(
  store: InMemoryPrivateValueStore,
  recordedId = "dep-4f2a91",
): { plan: RecordedWorkflow; id: string } {
  const authorDir = workspace("resin-extract-author-");
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const events: NormalizedSessionEvent[] = [];
  let sequence = 0;
  const emit = (fields: Record<string, unknown>) =>
    events.push(
      projectEventToMetadataOnly(
        recorder.observe(
          NormalizedSessionEventSchema.parse({
            schemaVersion: "1.0.0",
            sessionId: "extract-session",
            eventId: `event-${sequence}`,
            timestamp: "2026-09-26T00:00:00.000Z",
            causalRef: { causalSequence: sequence++ },
            redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
            ...fields,
          }),
          { workspaceId: owner },
        ),
      ),
    );
  emit({
    type: "message",
    role: "user",
    content: "Deploy the worker app to staging, wait, smoke test /health and promote to production",
  });
  const run = (callId: string, command: string): string => {
    const printed = execFileSync("/bin/sh", ["-c", command], {
      cwd: authorDir,
      encoding: "utf8",
      env: { ...process.env, DEPLOY_ID: recordedId },
    });
    emit({ type: "tool_call", callId, toolName: "bash", parameters: { command } });
    emit({
      type: "tool_result",
      callId,
      toolName: "bash",
      result: printed,
      isError: false,
      executionDurationMs: 1,
    });
    return printed;
  };
  const created = run("create", "./deployctl create --app worker --env staging");
  const id = /dep-[0-9a-f]+/.exec(created)![0];
  run("wait", `./deployctl wait ${id}`);
  run("smoke", `./deployctl smoke --check /health ${id}`);
  run("promote", `./deployctl promote --to production ${id}`);
  const plan = recordCallsFromEvents("deploy-promote", events as RecordableEvent[])!.workflow;
  return { plan, id };
}

async function validate(plan: RecordedWorkflow, store: InMemoryPrivateValueStore) {
  return await createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, ["extract-session"]),
  })(plan);
}

describe("extract bindings confirmed against the recording", () => {
  it("confirms the printed id bindings and the promoted plan runs with fresh ids", async () => {
    const store = new InMemoryPrivateValueStore();
    const { plan, id } = recordJob(store);
    expect(plan.heldOut).toBeUndefined();
    expect(plan.baseline).toBeDefined();
    const extracts = (plan.candidates ?? []).filter(
      (candidate) => candidate.proposed.kind === "extract",
    );
    expect(extracts.map((candidate) => candidate.stepId)).toEqual(["step1", "step2", "step3"]);
    // Neither output text nor the locator text is in the plan.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("created deployment");
    expect(serialized).not.toContain("healthy");

    const answer = await validate(plan, store);
    expect(answer.verification?.status).toBe("verified");
    const extractVerdicts = answer.verdicts.filter(
      (verdict) => verdict.candidate.proposed.kind === "extract",
    );
    expect(extractVerdicts.map((verdict) => [verdict.candidate.stepId, verdict.confirmed])).toEqual(
      [
        ["step1", true],
        ["step2", true],
        ["step3", true],
      ],
    );

    // The promoted plan feeds each invocation's own id to wait/smoke/promote.
    const promoted = applyAcceptedBindings(plan, extracts);
    const consumerDir = workspace("resin-extract-consumer-");
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: consumerDir }));
    const callable = instantiateRecordedWorkflow(compileRecordedWorkflow(promoted), {
      adapters,
      access: { workspaceId: owner },
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as WorkflowJsonValue,
    });
    const printed = new Set<string>();
    for (let round = 0; round < 2; round += 1) {
      const result = await callable.invoke({});
      expect(result.status, result.error).toBe("completed");
      const text = JSON.stringify(result.result);
      const fresh = /promoted (dep-[0-9a-f]+) to production/.exec(text)?.[1];
      expect(fresh).toBeDefined();
      printed.add(fresh!);
    }
    expect(printed.size).toBe(2);
    expect(printed.has(id)).toBe(false);
  });

  // An id of hex letters only reads like a word; it is still a value the create step printed.
  it.each(["dep-4f2a91", "dep-abcdef"])(
    "does not verify the closed plan without the bindings (hidden dependency on %s)",
    async (recordedId) => {
      const store = new InMemoryPrivateValueStore();
      const { plan } = recordJob(store, recordedId);
      const answer = await validate({ ...plan, candidates: [] }, store);
      expect(answer.verification?.status).not.toBe("verified");
    },
  );

  it.each(["dep-4f2a91", "dep-abcdef"])(
    "verifies the id read from the create step but not the same hole carrying the recorded id %s",
    async (recordedId) => {
      const store = new InMemoryPrivateValueStore();
      const { plan, id } = recordJob(store, recordedId);
      const extracts = (plan.candidates ?? []).filter(
        (candidate) => candidate.proposed.kind === "extract",
      );
      const bound = { ...applyAcceptedBindings(plan, extracts), candidates: [] };
      expect((await validate(bound, store)).verification?.status).toBe("verified");

      // The very same plan, its holes now binding the printed id as recorded literal text.
      const literal = JSON.parse(
        JSON.stringify(bound, (key, value) =>
          value !== null && typeof value === "object" && value.type === "extract"
            ? { type: "literal", value: id }
            : value,
        ),
      ) as RecordedWorkflow;
      const answer = await validate(literal, store);
      expect(answer.verification?.status).not.toBe("verified");
      expect(answer.verification?.missed.map((entry) => entry.stepId)).toContain("step1");
    },
  );

  it("does not verify a recorded default offered for the printed id", async () => {
    const store = new InMemoryPrivateValueStore();
    const { plan } = recordJob(store);
    const extracts = (plan.candidates ?? []).filter(
      (candidate) => candidate.proposed.kind === "extract",
    );
    const printed = extracts.find((candidate) => candidate.stepId === "step1")!;
    // The later steps read the id; the first offers it as an input defaulting to the recorded id.
    const offered: WorkflowBindingCandidate = {
      ...printed,
      proposed: { kind: "input", name: "id", type: "string", recordedDefault: true },
      reason: "classified-source-value",
    };
    const candidates = [offered, ...extracts.filter((candidate) => candidate !== printed)];
    const answer = await validate({ ...plan, candidates }, store);
    expect(answer.verification?.status).not.toBe("verified");
    const verdict = answer.verdicts.find((entry) => entry.candidate.proposed.kind === "input");
    expect(verdict?.confirmed).toBe(false);
  });

  it("refutes a locator that extracts some other printed value", async () => {
    const store = new InMemoryPrivateValueStore();
    const { plan } = recordJob(store);
    const wrong = "private:v2:value:wrong-locator";
    // `created ` is followed by `deployment`, a real run of the charset but not the id.
    store.set(wrong, JSON.stringify({ before: "created ", charset: ["lower", "digit", "-"] }), {
      workspaceId: owner,
    });
    const candidates = (plan.candidates ?? []).map((candidate) =>
      candidate.stepId === "step1" && candidate.proposed.kind === "extract"
        ? { ...candidate, proposed: { ...candidate.proposed, locator: wrong } }
        : candidate,
    );
    const answer = await validate(
      { ...plan, candidates, privateReferences: [...(plan.privateReferences ?? []), wrong] },
      store,
    );
    const verdict = answer.verdicts.find(
      (entry) => entry.candidate.stepId === "step1" && entry.candidate.proposed.kind === "extract",
    );
    expect(verdict?.confirmed).toBe(false);
  });
});
