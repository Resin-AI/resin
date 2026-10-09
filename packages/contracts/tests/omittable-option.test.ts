import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  OMITTABLE_OPTION_CAPABILITY,
  RECORDED_WORKFLOW_SCHEMA_VERSION,
  applyProgramTokenValues,
  omittableOptionProblem,
  omittableOptionSite,
  tokenizeProgram,
  validateRecordedWorkflow,
} from "../src/index.js";

// Tokens: gh(0) pr(1) merge(2) 18(3) --squash(4) --subject(5) "Fix: parser"(6) --delete-branch(7)
const MERGE = 'gh pr merge 18 --squash --subject "Fix: parser" --delete-branch';

/** What `sh` hands the command: each argument it received, one per `<…>`. */
function run(command: string): string {
  const result = spawnSync(
    "sh",
    ["-c", `gh() { printf '<%s>' "$@"; }; tool() { printf '<%s>' "$@"; }; ${command}`],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return result.stdout;
}

function render(
  source: string,
  run: { option: number; token: number; span?: { start: number; end: number } } | undefined,
  values: Map<number, string> = new Map(),
  spans: Array<{ token: number; span: { start: number; end: number }; value: string }> = [],
): string {
  return applyProgramTokenValues(
    source,
    tokenizeProgram("shell", source),
    values,
    "shell",
    undefined,
    spans,
    undefined,
    run === undefined ? [] : [run],
  );
}

describe("omittable option sites", () => {
  it("names the option word of a separate, attached and field value", () => {
    expect(OMITTABLE_OPTION_CAPABILITY).toBe("omittable-option-v1");
    expect(omittableOptionSite(MERGE, { token: 6 })).toEqual({ option: 5 });
    expect(omittableOptionSite("git commit -q -m 'first line'", { token: 4 })).toEqual({
      option: 3,
    });
    // `--subject=` is [0, 10) of the attached token.
    expect(
      omittableOptionSite("tool run --subject=Release --dry-run", {
        token: 2,
        span: { start: 10, end: 17 },
      }),
    ).toEqual({ option: 2 });
    // `title=` is [0, 6) of the field token.
    expect(
      omittableOptionSite('gh api repos/o/r/pulls -f title="A b" -f body=x', {
        token: 4,
        span: { start: 6, end: 9 },
      }),
    ).toEqual({ option: 3 });
    // An option and its value may follow the run: `--body B` is one option.
    expect(
      omittableOptionSite('gh pr merge 18 --squash --subject S --body "B b"', { token: 6 }),
    ).toEqual({ option: 5 });
  });

  it.each([
    ["an operand follows the option", "git commit -m msg file.txt", { token: 3 }],
    ["the option comes after --", "tool run -- -m msg", { token: 4 }],
    ["the value looks like an option", "tool run -m -x", { token: 3 }],
    ["the option word is the command", "-m msg", { token: 1 }],
    ["the token before is no option", "tool run msg", { token: 2 }],
    [
      "the hole binds part of the value",
      "tool run --subject=Release",
      {
        token: 2,
        span: { start: 10, end: 13 },
      },
    ],
    [
      "the attached prefix is quoted",
      'tool run "--subject=Release"',
      {
        token: 2,
        span: { start: 10, end: 17 },
      },
    ],
    [
      "the field key is quoted",
      "tool api -f 'title=A b'",
      { token: 3, span: { start: 6, end: 9 } },
    ],
    ["the value is a code string", "python3 -c 'print(1)'", { token: 2 }],
    ["the value is an embedded token", MERGE, { token: 6, embedded: 0 }],
    ["the address is a word list", MERGE, { token: 6, through: 7 }],
    ["an operand follows an option's value", "tool -a x -b y z", { token: 2 }],
  ])("refuses a site when %s", (_, source, address) => {
    expect(omittableOptionSite(source, address)).toBeUndefined();
  });

  it("explains why a hole cannot be omitted", () => {
    const tokens = tokenizeProgram("shell", "git commit -m msg file.txt");
    expect(
      omittableOptionProblem("git commit -m msg file.txt", tokens, { token: 3, option: 2 }),
    ).toMatch(/operand follows/);
    expect(
      omittableOptionProblem(MERGE, tokenizeProgram("shell", MERGE), { token: 6, option: 4 }),
    ).toMatch(/hole's own token or the token right before it/);
  });
});

describe("rendering an omitted option", () => {
  it("runs the command with the value, and without the option when it is omitted", () => {
    const supplied = render(MERGE, undefined, new Map([[6, "Release 2.0; $(id)"]]));
    expect(supplied).toBe(
      'gh pr merge 18 --squash --subject "Release 2.0; \\$(id)" --delete-branch',
    );
    expect(run(supplied)).toBe(
      "<pr><merge><18><--squash><--subject><Release 2.0; $(id)><--delete-branch>",
    );
    const omitted = render(MERGE, { option: 5, token: 6 });
    expect(omitted).toBe("gh pr merge 18 --squash --delete-branch");
    expect(run(omitted)).toBe("<pr><merge><18><--squash><--delete-branch>");
  });

  it("removes an attached option and a field the same way, keeping the rest byte for byte", () => {
    const attached = "tool run --subject=Release  --dry-run && tool done";
    const subject = { option: 2, token: 2, span: { start: 10, end: 17 } };
    expect(render(attached, subject)).toBe("tool run  --dry-run && tool done");
    expect(run(render(attached, subject))).toBe("<run><--dry-run><done>");
    expect(
      run(
        render(attached, undefined, new Map(), [
          { token: 2, span: { start: 10, end: 17 }, value: "v 2" },
        ]),
      ),
    ).toBe("<run><--subject=v 2><--dry-run><done>");
    const field = 'tool api repos/o/r/pulls -f title="A b" -f body=x';
    expect(run(render(field, { option: 3, token: 4, span: { start: 6, end: 9 } }))).toBe(
      "<api><repos/o/r/pulls><-f><body=x>",
    );
  });

  it("refuses to remove a run the recorded text does not hold as an option", () => {
    expect(() => render("git commit -m msg file.txt", { option: 2, token: 3 })).toThrow(
      /cannot be removed/,
    );
    expect(() => render(MERGE, { option: 5, token: 6 }, new Map([[6, "x"]]))).toThrow(/overlap/);
    expect(() =>
      applyProgramTokenValues(
        "x = '1'",
        tokenizeProgram("python", "x = '1'"),
        new Map(),
        "python",
        undefined,
        undefined,
        undefined,
        [{ option: 1, token: 2 }],
      ),
    ).toThrow(/only a shell program/);
  });
});

/** A one-step plan running `source`, with `holes` on its program template. */
function plan(
  source: string,
  holes: unknown[],
  inputs: unknown[] = [{ name: "merge_subject", type: "string", omitOptionWhenAbsent: true }],
  extra: Record<string, unknown> = {},
) {
  return {
    schemaVersion: RECORDED_WORKFLOW_SCHEMA_VERSION,
    workflowId: "wf",
    inputs,
    steps: [
      {
        id: "merge",
        callId: "call-merge",
        callable: {
          runtime: "resin-process",
          name: "bash",
          program: { kind: "shell", source, argument: "command" },
        },
        arguments: [
          {
            name: "command",
            source: {
              kind: "template",
              template: {
                type: "program",
                language: "shell",
                source: { type: "literal", value: source },
                holes,
                ...extra,
              },
            },
          },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "default" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}

const SUBJECT_HOLE = { token: 6, option: 5, binding: { type: "input", name: "merge_subject" } };

describe("validating an omittable option input", () => {
  it("accepts an option value hole bound to an omittable input", () => {
    expect(validateRecordedWorkflow(plan(MERGE, [SUBJECT_HOLE])).errors).toEqual([]);
    expect(
      validateRecordedWorkflow(
        plan("tool run --subject=Release --dry-run", [
          { ...SUBJECT_HOLE, token: 2, option: 2, span: { start: 10, end: 17 } },
        ]),
      ).errors,
    ).toEqual([]);
  });

  it.each([
    [
      "the input has a default",
      plan(
        MERGE,
        [SUBJECT_HOLE],
        [{ name: "merge_subject", type: "string", omitOptionWhenAbsent: true, default: "x" }],
      ),
      /cannot also have a default/,
    ],
    [
      "the input is a boolean",
      plan(
        MERGE,
        [SUBJECT_HOLE],
        [{ name: "merge_subject", type: "boolean", omitOptionWhenAbsent: true }],
      ),
      /string or number/,
    ],
    [
      "the hole names no option",
      plan(MERGE, [{ ...SUBJECT_HOLE, option: undefined }]),
      /without naming its option/,
    ],
    [
      "the option is not the word before",
      plan(MERGE, [{ ...SUBJECT_HOLE, option: 4 }]),
      /not an omittable option/,
    ],
    [
      "an operand follows",
      plan("git commit -m msg file.txt", [{ ...SUBJECT_HOLE, token: 3, option: 2 }]),
      /operand follows/,
    ],
    [
      "the input is plain",
      plan(MERGE, [SUBJECT_HOLE], [{ name: "merge_subject", type: "string" }]),
      /must bind an omittable option input/,
    ],
    [
      "another hole sits on the option word",
      plan(
        MERGE,
        [SUBJECT_HOLE, { token: 5, binding: { type: "input", name: "flag" } }],
        [
          { name: "merge_subject", type: "string", omitOptionWhenAbsent: true },
          { name: "flag", type: "string" },
        ],
      ),
      /option run holds another hole/,
    ],
    [
      "a protected token sits in the run",
      plan(MERGE, [SUBJECT_HOLE], undefined, {
        protectedTokens: [5],
      }),
      /option run holds a protected token/,
    ],
  ])("refuses a plan when %s", (_, workflow, error) => {
    const result = validateRecordedWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(error);
  });

  it("refuses an omittable input read anywhere but an option value hole", () => {
    const workflow = plan(MERGE, [SUBJECT_HOLE]);
    workflow.steps[0]!.arguments.push({
      name: "label",
      source: { kind: "input", name: "merge_subject" } as never,
    });
    expect(validateRecordedWorkflow(workflow).errors.join("\n")).toMatch(
      /reads omittable option input merge_subject outside an option value hole/,
    );
  });

  it("accepts an omittable option proposal only at a top-level token of a string or number input", () => {
    const withCandidate = (path: unknown[], proposed: Record<string, unknown>) =>
      validateRecordedWorkflow({
        ...plan(MERGE, [], []),
        candidates: [
          {
            stepId: "merge",
            argument: "command",
            path,
            proposed: { kind: "input", name: "merge_subject", type: "string", ...proposed },
            reason: "varies-across-executions",
            missing: "a held-out run",
          },
        ],
      });
    expect(withCandidate(["tokens", 6], { omitOptionWhenAbsent: true }).errors).toEqual([]);
    expect(
      withCandidate(["tokens", 6], { omitOptionWhenAbsent: true, recordedDefault: true }).valid,
    ).toBe(false);
    expect(withCandidate(["tokens", 6], { omitOptionWhenAbsent: true, type: "array" }).valid).toBe(
      false,
    );
    expect(withCandidate(["tokens", 6, "embedded", 0], { omitOptionWhenAbsent: true }).valid).toBe(
      false,
    );
  });
});
