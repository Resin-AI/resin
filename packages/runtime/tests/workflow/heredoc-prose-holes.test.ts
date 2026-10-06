/**
 * Holes on heredoc prose — the literal body of a quoted-delimiter heredoc a command reads as data
 * (`git commit -F - <<'EOF'`, `--body "$(cat <<'EOF' … EOF\n)"`): the recording check confirms one
 * against the demonstration's own recorded call, and a body the device would not render back as
 * the same text in every shell is never confirmed.
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

const merge = (body: string) =>
  `gh pr merge 42 --squash --body "$(cat <<'EOF'\n${body}\nEOF\n)" 2>&1 | tail -n 3; gh pr view 42 --json state`;
const commit = (message: string) =>
  `git commit -q -F - <<'EOF'\n${message}\nEOF\ngit push origin feature-x`;

function plan(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-heredoc-prose",
    inputs: [],
    privateReferences: [
      "private:recorded:command",
      "private:demo:command",
      "private:demo:result",
      "private:recorded:result",
    ],
    steps: [
      {
        id: "ship",
        callId: "call-ship",
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
      inputs: [{ stepId: "ship", argument: "command", reference: "private:recorded:command" }],
      observed: [{ stepId: "ship", reference: "private:recorded:result" }],
    },
    heldOut: {
      inputs: [{ stepId: "ship", argument: "command", reference: "private:demo:command" }],
      observed: [{ stepId: "ship", reference: "private:demo:result" }],
    },
  };
}

/** The prose candidate: `["tokens", anchor, "embedded", 0]` of the one `text` program. */
function candidate(source: string, name: string): WorkflowBindingCandidate {
  const program = embeddedPrograms(source).find((each) => each.language === "text");
  if (program === undefined) throw new Error("no heredoc prose");
  expect(program.tokens[0]).toMatchObject({ kind: "string", quote: "heredoc", bindable: true });
  return {
    stepId: "ship",
    argument: "command",
    path: ["tokens", program.anchor, "embedded", 0],
    proposed: { kind: "input", name, type: "string" },
    reason: "native-data-argument",
    missing: "two recordings show this value varies",
  };
}

async function confirm(
  recorded: string,
  demonstrated: string,
  candidates: WorkflowBindingCandidate[],
) {
  const privates: Record<string, WorkflowJsonValue> = {
    "private:recorded:command": recorded,
    "private:recorded:result": "recorded output",
    "private:demo:command": demonstrated,
    "private:demo:result": "demonstrated output",
  };
  const call = (command: string, result: string): RecordedCall => ({
    callable: { name: "bash", program: { kind: "shell", argument: "command" } },
    arguments: { command },
    result,
    hiddenDependencies: [],
  });
  const recordings = {
    baseline: new Map([["ship", call(recorded, "recorded output")]]),
    "held-out": new Map([["ship", call(demonstrated, "demonstrated output")]]),
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

describe("a hole on heredoc prose", () => {
  it("is confirmed for a PR body inside $(cat <<'EOF' …), and the plan carries it", async () => {
    const recorded = merge("Reads quoted words.\n\nCloses #41.");
    const demonstrated = merge('Handles "nested" quotes, `code` and (parens).\n\n- $HOME stays');
    const decided = await confirm(recorded, demonstrated, [candidate(recorded, "body")]);

    expect(decided?.outcomes.map((outcome) => outcome.accepted)).toEqual([true]);
    expect(decided?.verification?.status).toBe("verified");
    expect(decided?.plan.inputs.map((input) => input.name)).toEqual(["body"]);
    const source = decided!.plan.steps[0]!.arguments[0]!.source;
    expect(source.kind === "template" && source.template.type === "program").toBe(true);
    if (source.kind === "template" && source.template.type === "program") {
      expect(source.template.holes).toMatchObject([{ embedded: 0 }]);
    }
  });

  it("is confirmed for a commit message fed to standard input", async () => {
    const recorded = commit("Fix the parser\n\nIt reads quotes.");
    const demonstrated = commit(
      "Teach the parser heredocs\n\nIt's careful: EOF ) and \\ stay text.",
    );
    const decided = await confirm(recorded, demonstrated, [candidate(recorded, "message")]);
    expect(decided?.outcomes[0]?.accepted).toBe(true);
    expect(decided?.verification?.status).toBe("verified");
  });

  it("is never confirmed when the demonstrated body is not text every shell reads back", async () => {
    const recorded = merge("Reads quoted words.");
    const pick = [candidate(recorded, "body")];
    // Each is a body bash 3.2 (macOS /bin/sh) scans past or into: a lone quote or parenthesis.
    for (const body of ["It's done.", "Fixes a) and b", "unpaired ` tick"]) {
      const decided = await confirm(recorded, merge(body), pick);
      expect(decided?.outcomes[0]?.accepted ?? false, body).toBe(false);
    }
  });
});
