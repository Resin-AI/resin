/**
 * Holes inside a shell program another shell runs from one quoted word (`ssh host '<program>'`,
 * `bash -c '<program>'`): the recording check confirms one against the demonstration's own recorded
 * call, and a value the device cannot render as data at both layers is never confirmed.
 */
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  embeddedPrograms,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import {
  type RecordedCall,
  createRecordingCheckAdapters,
} from "../../src/workflow/recording-check.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/workflow/runtime-families.js";

const ssh = (since: string, container: string) =>
  `ssh -o BatchMode=yes -o ConnectTimeout=10 host-a 'docker logs --timestamps --since ${since} ${container} 2>&1 | cut -c1-400'`;

function plan(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-remote-logs",
    inputs: [],
    privateReferences: [
      "private:recorded:command",
      "private:demo:command",
      "private:demo:result",
      "private:recorded:result",
    ],
    steps: [
      {
        id: "logs",
        callId: "call-logs",
        callable: {
          runtime: RESIN_PROCESS_RUNTIME,
          name: "bash",
          program: { kind: "shell", source: "", argument: "command" },
        },
        arguments: [
          { name: "command", source: { kind: "private", reference: "private:recorded:command" } },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
    baseline: {
      inputs: [{ stepId: "logs", argument: "command", reference: "private:recorded:command" }],
      observed: [{ stepId: "logs", reference: "private:recorded:result" }],
    },
    heldOut: {
      inputs: [{ stepId: "logs", argument: "command", reference: "private:demo:command" }],
      observed: [{ stepId: "logs", reference: "private:demo:result" }],
    },
  };
}

function candidate(source: string, raw: string, name: string): WorkflowBindingCandidate {
  const program = embeddedPrograms(source)[0]!;
  const index = program.tokens.findIndex((token) => token.raw === raw);
  if (index < 0) throw new Error(`no embedded token ${raw}`);
  return {
    stepId: "logs",
    argument: "command",
    path: ["tokens", program.anchor, "embedded", index],
    proposed: { kind: "input", name, type: "string" },
    reason: "native-data-argument",
    missing: "two recordings show this value varies",
  };
}

/** The held-out check: the plan, with the candidates bound, must resolve to the demonstration's call. */
async function confirm(
  recorded: string,
  demonstrated: string,
  candidates: WorkflowBindingCandidate[],
) {
  const privates: Record<string, WorkflowJsonValue> = {
    "private:recorded:command": recorded,
    "private:recorded:result": "recorded logs",
    "private:demo:command": demonstrated,
    "private:demo:result": "demonstrated logs",
  };
  const call = (command: string, result: string): RecordedCall => ({
    callable: { name: "bash", program: { kind: "shell", argument: "command" } },
    arguments: { command },
    result,
    hiddenDependencies: [],
  });
  const recordings = {
    baseline: new Map([["logs", call(recorded, "recorded logs")]]),
    "held-out": new Map([["logs", call(demonstrated, "demonstrated logs")]]),
  };
  const environment = await demonstrationEnvironment({
    plan: plan(),
    candidates,
    adapters: (label) =>
      createRecordingCheckAdapters({ recording: recordings[label as keyof typeof recordings] }),
    resolvePrivate: (reference) => privates[reference]!,
  });
  if (environment === undefined) return undefined;
  return await validateAndConfirmCandidates({ plan: plan(), candidates, environment });
}

describe("a hole inside a remote ssh program", () => {
  it("is confirmed against the demonstration's own call, and the plan carries it", async () => {
    const recorded = ssh("2026-01-01T07:30:00Z", "web-1");
    const demonstrated = ssh("2026-01-02T08:00:00Z", "web-2");
    const candidates = [
      candidate(recorded, "2026-01-01T07:30:00Z", "since"),
      candidate(recorded, "web-1", "container"),
    ];
    const decided = await confirm(recorded, demonstrated, candidates);

    expect(decided?.outcomes.map((outcome) => outcome.accepted)).toEqual([true, true]);
    expect(decided?.verification?.status).toBe("verified");
    expect(decided?.plan.inputs.map((input) => input.name).sort()).toEqual(["container", "since"]);
    const source = decided!.plan.steps[0]!.arguments[0]!.source;
    expect(source.kind === "template" && source.template.type === "program").toBe(true);
  });

  it("is never confirmed when the demonstration ran a value the remote shell could read as code", async () => {
    const quoted = (container: string) =>
      `ssh host-a 'docker logs --since 2026-01-01T07:30:00Z "${container}" 2>&1'`;
    const recorded = quoted("web-1");
    const pick = [candidate(recorded, '"web-1"', "container")];
    expect((await confirm(recorded, quoted("web-2"), pick))?.outcomes[0]?.accepted).toBe(true);
    // Each is one double-quoted word of the demonstration's remote program; rendered into a remote
    // program a shell the device cannot see parses, none is data in every shell.
    for (const value of [
      "web-2;id",
      "web-2&&id",
      "web-2|id",
      "a>b",
      "-oProxyCommand=id",
      "`id`",
      "$(id)",
    ]) {
      const decided = await confirm(recorded, quoted(value), pick);
      expect(decided?.outcomes[0]?.accepted ?? false, value).toBe(false);
    }
  });
});

describe("a hole inside a bash -c program", () => {
  it("is confirmed with a demonstrated value the inner shell reads as one quoted word", async () => {
    const program = (pattern: string) => `bash -c 'grep -c "${pattern}" /var/log/app.log'`;
    const recorded = program("alpha");
    const pick = [candidate(recorded, '"alpha"', "pattern")];
    // A local POSIX shell is known: separators and quotes in the value are data for it.
    expect((await confirm(recorded, program("beta; id && x"), pick))?.outcomes[0]?.accepted).toBe(
      true,
    );
    // An inner word recorded bare renders a value that needs quoting quoted, which a demonstration
    // that quoted it otherwise did not run: the shapes differ, and nothing is confirmed.
    const bare = "bash -c 'grep -c alpha /var/log/app.log'";
    expect(
      (await confirm(bare, program("beta; id"), [candidate(bare, "alpha", "pattern")]))?.outcomes[0]
        ?.accepted ?? false,
    ).toBe(false);
  });
});
