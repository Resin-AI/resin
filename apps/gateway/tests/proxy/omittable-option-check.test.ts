/**
 * A recorded `gh pr merge … --subject "…"` whose subject the cloud offers as an omittable option
 * input from this one recording. The device's recording check confirms it with the recorded value
 * bound, and the promoted tool then runs with a caller's subject, or without `--subject` at all.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecordedWorkflow, WorkflowBindingCandidate } from "@resin/contracts";
import { InMemoryPrivateValueStore, resolvePrivateReference } from "@resin/observer";
import {
  RuntimeAdapterRegistry,
  applyAcceptedBindings,
  createProcessAdapter,
  executeRecordedWorkflow,
} from "@resin/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { posixShellAvailable, runPosixShell } from "./posix-shell.js";
import { localCallsFor, recordSession } from "./recorded-sessions.js";

const owner = "omittable-option-owner";
const SESSION = "omittable-option-session";
// Tokens: ./gh(0) pr(1) merge(2) 18(3) --squash(4) --subject(5) "Add parser (#18)"(6) --delete-branch(7)
const MERGE = './gh pr merge 18 --squash --subject "Add parser (#18)" --delete-branch';
const GH = `#!/bin/sh
printf '<%s>' "$@"
`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "resin-omittable-option-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "gh"), GH);
  chmodSync(path.join(directory, "gh"), 0o755);
  return directory;
}

/**
 * The recorded merge as the cloud sends it back: its program projected, the sanitized text the plan
 * carries (nothing was redacted, so the program itself) over its private original.
 */
function recordMerge(store: InMemoryPrivateValueStore, directory: string): RecordedWorkflow {
  const recorded = recordSession(
    store,
    { workspaceId: owner, sessionId: SESSION, workflowId: "merge" },
    [
      { user: "Squash-merge pull request 18" },
      {
        callId: "merge",
        toolName: "bash",
        parameters: { command: MERGE },
        result: runPosixShell(MERGE, { cwd: directory }),
      },
    ],
  );
  const step = recorded.steps[0]!;
  const source = step.arguments[0]!.source;
  if (source.kind !== "template" || source.template.type !== "private") {
    throw new Error("the recorder kept the command privately");
  }
  return {
    ...recorded,
    candidates: [],
    steps: [
      {
        ...step,
        callable: { ...step.callable, program: { ...step.callable.program!, source: MERGE } },
        arguments: [
          {
            name: "command",
            source: {
              kind: "template",
              template: {
                type: "program",
                language: "shell",
                source: { type: "literal", value: MERGE },
                sourceReference: source.template.reference,
                protectedTokens: [],
                holes: [],
              },
            },
          },
        ],
      },
    ],
  };
}

function proposal(plan: RecordedWorkflow, token: number): WorkflowBindingCandidate {
  return {
    stepId: plan.steps[0]!.id,
    argument: "command",
    path: ["tokens", token],
    proposed: { kind: "input", name: "subject", type: "string", omitOptionWhenAbsent: true },
    reason: "classified-source-value",
    missing: "one recording does not establish that this value varies",
  };
}

async function validate(plan: RecordedWorkflow, store: InMemoryPrivateValueStore) {
  return await createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, [SESSION]),
  })(plan);
}

describe.skipIf(!posixShellAvailable)("an omittable option offered from one recording", () => {
  it("is confirmed with the recorded value bound, and the tool runs with or without it", async () => {
    const store = new InMemoryPrivateValueStore();
    const directory = workspace();
    const plan = recordMerge(store, directory);
    const offered = proposal(plan, 6);

    const answer = await validate({ ...plan, candidates: [offered] }, store);

    expect(answer.verification?.status).toBe("verified");
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([true]);

    const promoted = applyAcceptedBindings({ ...plan, candidates: [offered] }, [offered]);
    expect(promoted.inputs).toEqual([
      { name: "subject", type: "string", omitOptionWhenAbsent: true },
    ]);
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: directory }));
    const run = async (inputs: Record<string, string>) =>
      await executeRecordedWorkflow(promoted, {
        inputs,
        adapters,
        access: { workspaceId: owner },
        resolvePrivate: (reference) => resolvePrivateReference(store, reference) as never,
      });
    const withSubject = await run({ subject: "Fix lexer (#21)" });
    expect(withSubject.error).toBeUndefined();
    expect(JSON.stringify(withSubject.result)).toContain(
      "<pr><merge><18><--squash><--subject><Fix lexer (#21)><--delete-branch>",
    );
    const withoutSubject = await run({});
    expect(withoutSubject.error).toBeUndefined();
    expect(JSON.stringify(withoutSubject.result)).toContain(
      "<pr><merge><18><--squash><--delete-branch>",
    );
  });

  it("is refused at a value that is no option's", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recordMerge(store, workspace());
    // `18` is an operand: removing it would change what the command does to which pull request.
    const offered = proposal(plan, 3);

    const answer = await validate({ ...plan, candidates: [offered] }, store);

    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([false]);
  });
});
