import { describe, expect, it } from "vitest";
import {
  applyProgramTokenValues,
  bindProgramToken,
  demonstratedProgramTokenList,
  programTokenListAt,
  programTokenListShift,
  programTokenPath,
  tokenizeProgram,
} from "../src/program-tokens.js";
import {
  type WorkflowValueTemplate,
  validateRecordedWorkflow,
  workflowListInputProblem,
} from "../src/recorded-workflow.js";

// Tokens: python tests/runtests.py basic fixtures force_insert_update serializers --parallel=1
const DJANGO =
  "python tests/runtests.py basic fixtures force_insert_update serializers --parallel=1";
const LABELS = { token: 2, through: 5 };
const SYMPY = "python bin/test sympy/a/tests/test_x.py";
const PATHS = { token: 2, through: 2 };

const recorded = (value: string): WorkflowValueTemplate => ({ type: "literal", value });
const input = (name: string): WorkflowValueTemplate => ({ type: "input", name });

/** The words a shell text's tokens `from`..end-`fromEnd` read as, after re-tokenizing it. */
function words(source: string, from: number, fromEnd = 0): Array<string | undefined> {
  const tokens = tokenizeProgram("shell", source);
  return tokens.slice(from, tokens.length - fromEnd).map((token) => token.value as string);
}

function render(items: readonly string[], optionItems?: boolean): string {
  return applyProgramTokenValues(
    DJANGO,
    tokenizeProgram("shell", DJANGO),
    new Map(),
    "shell",
    undefined,
    undefined,
    [{ ...LABELS, items, ...(optionItems === undefined ? {} : { optionItems }) }],
  );
}

describe("word-list addresses", () => {
  it("reads a run of words as a list address and nothing malformed as one", () => {
    expect(programTokenPath(["tokens", 2, "through", 5])).toEqual({ token: 2, through: 5 });
    expect(programTokenPath(["tokens", 2, "through", 2])).toEqual({ token: 2, through: 2 });
    expect(programTokenPath(["tokens", 5, "through", 2])).toBeUndefined();
    expect(programTokenPath(["tokens", 2, "through", 5, "span", 0, 1])).toBeUndefined();
    expect(programTokenListAt(DJANGO, LABELS)).toEqual([
      "basic",
      "fixtures",
      "force_insert_update",
      "serializers",
    ]);
  });
});

describe("binding a word list", () => {
  it("lifts the recorded run into one list hole", () => {
    expect(
      bindProgramToken(recorded(DJANGO), "shell", 2, input("labels"), undefined, undefined, 5),
    ).toEqual({
      type: "program",
      language: "shell",
      source: recorded(DJANGO),
      holes: [{ token: 2, through: 5, binding: input("labels") }],
    });
  });

  it("refuses a second list, and any other hole inside the run", () => {
    const listed = bindProgramToken(
      recorded(DJANGO),
      "shell",
      2,
      input("labels"),
      undefined,
      undefined,
      5,
    );
    expect(() =>
      bindProgramToken(listed, "shell", 6, input("more"), undefined, undefined, 6),
    ).toThrow("at most one word list");
    expect(() => bindProgramToken(listed, "shell", 3, input("label"))).toThrow(
      "part of a word list",
    );
    const single = bindProgramToken(recorded(DJANGO), "shell", 3, input("label"));
    expect(() =>
      bindProgramToken(single, "shell", 2, input("labels"), undefined, undefined, 5),
    ).toThrow("inside the word list's run");
  });

  it("refuses a run that crosses an operator or starts at a redirection target", () => {
    // Tokens: pytest a.py && pytest b.py
    expect(() =>
      bindProgramToken(
        recorded("pytest a.py && pytest b.py"),
        "shell",
        1,
        input("files"),
        undefined,
        undefined,
        4,
      ),
    ).toThrow("not a run of words");
    // Tokens: pytest a.py > out.txt — a second word after `>` would become an operand.
    expect(() =>
      bindProgramToken(
        recorded("pytest a.py > out.txt"),
        "shell",
        3,
        input("files"),
        undefined,
        undefined,
        3,
      ),
    ).toThrow("not a run of words");
  });
});

describe("rendering a word list", () => {
  it("runs the django plan on one label or on the four it recorded", () => {
    expect(render(["aggregation"])).toBe("python tests/runtests.py aggregation --parallel=1");
    expect(render(["basic", "fixtures", "force_insert_update", "serializers"])).toBe(DJANGO);
  });

  it("renders each item as exactly one word, whatever shell syntax it carries", () => {
    const items = ["a; rm -rf ~ $(id)", "*.py", "x y", "it's"];
    const rendered = render(items);
    // Re-read by the shell tokenizer: the command and its trailing option are unchanged, and each
    // item is one string or word token between them with the item as its value.
    const tokens = tokenizeProgram("shell", rendered);
    expect(tokens).toHaveLength(2 + items.length + 1);
    expect(words(rendered, 2, 1)).toEqual(items);
    expect(tokens.slice(2, -1).every((token) => token.kind !== "operator")).toBe(true);
    expect(tokens.at(-1)!.raw).toBe("--parallel=1");
  });

  it("refuses an option-like or empty item unless the recording passed options there", () => {
    expect(() => render(["--pdb"])).toThrow("looks like an option");
    expect(() => render([""])).toThrow("non-empty string");
    expect(render(["--pdb"], true)).toBe("python tests/runtests.py --pdb --parallel=1");
    expect(workflowListInputProblem("labels", { minItems: 1 }, ["--pdb"])).toContain(
      "looks like an option",
    );
    expect(
      workflowListInputProblem("labels", { minItems: 1, optionItems: true }, ["--pdb"]),
    ).toBeUndefined();
    expect(workflowListInputProblem("labels", { minItems: 1 }, [])).toContain("at least 1");
    expect(workflowListInputProblem("labels", { minItems: 0 }, [])).toBeUndefined();
  });
});

describe("reading a demonstrated word list", () => {
  it("reads however many labels the demonstration ran in place of the recorded run", () => {
    const one = "python tests/runtests.py aggregation --parallel=1";
    expect(demonstratedProgramTokenList(DJANGO, one, LABELS)).toEqual(["aggregation"]);
    expect(programTokenListShift(DJANGO, one)).toBe(-3);
    // Recorded with one label, demonstrated with four.
    expect(demonstratedProgramTokenList(one, DJANGO, { token: 2, through: 2 })).toEqual([
      "basic",
      "fixtures",
      "force_insert_update",
      "serializers",
    ]);
    expect(
      demonstratedProgramTokenList(DJANGO, "python tests/runtests.py --parallel=1", LABELS),
    ).toEqual([]);
  });

  it("reads two sympy paths against one, and one against two", () => {
    const two = "python bin/test sympy/a/tests/test_x.py sympy/b/tests/test_y.py";
    expect(demonstratedProgramTokenList(SYMPY, two, PATHS)).toEqual([
      "sympy/a/tests/test_x.py",
      "sympy/b/tests/test_y.py",
    ]);
    expect(demonstratedProgramTokenList(two, SYMPY, { token: 2, through: 3 })).toEqual([
      "sympy/a/tests/test_x.py",
    ]);
    expect(
      demonstratedProgramTokenList("python -m pytest -q a.py b.py", "python -m pytest -q c.py", {
        token: 4,
        through: 5,
      }),
    ).toEqual(["c.py"]);
  });

  it("refuses a demonstration whose list would absorb an option or an operator", () => {
    const withOption = "python bin/test --pdb sympy/a/tests/test_x.py";
    expect(demonstratedProgramTokenList(SYMPY, withOption, PATHS)).toBeUndefined();
    expect(demonstratedProgramTokenList(SYMPY, withOption, PATHS, true)).toEqual([
      "--pdb",
      "sympy/a/tests/test_x.py",
    ]);
    expect(demonstratedProgramTokenList(SYMPY, `${SYMPY} && rm -rf build`, PATHS)).toBeUndefined();
    // Another trailing option pushes the recorded `--parallel=1` into the run, as an option item.
    expect(
      demonstratedProgramTokenList(
        DJANGO,
        "python tests/runtests.py basic --parallel=1 --keepdb",
        LABELS,
      ),
    ).toBeUndefined();
  });
});

describe("validating a plan with a word list", () => {
  function plan(
    holes: unknown[],
    inputs: unknown[] = [{ name: "labels", type: "array", list: { minItems: 1 } }],
  ): unknown {
    return {
      schemaVersion: 1,
      workflowId: "wf-django-tests",
      inputs,
      steps: [
        {
          id: "run",
          callId: "call-run",
          callable: {
            runtime: "process",
            name: "command_exec",
            program: { kind: "shell", source: DJANGO, argument: "cmd" },
          },
          arguments: [
            {
              name: "cmd",
              source: {
                kind: "template",
                template: { type: "program", language: "shell", source: recorded(DJANGO), holes },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
  }
  const labels = { token: 2, through: 5, binding: input("labels") };
  const errors = (value: unknown) => validateRecordedWorkflow(value).errors.join("\n");

  it("accepts a list hole bound to a list input", () => {
    expect(validateRecordedWorkflow(plan([labels])).errors).toEqual([]);
    expect(
      validateRecordedWorkflow(
        plan(
          [labels],
          [{ name: "labels", type: "array", recordedDefault: true, list: { minItems: 1 } }],
        ),
      ).errors,
    ).toEqual([]);
  });

  it("rejects a list hole on a non-list input, and a list input read by a token hole", () => {
    expect(errors(plan([labels], [{ name: "labels", type: "array" }]))).toContain(
      "word-list hole must bind a list input, not labels",
    );
    expect(errors(plan([labels, { token: 6, binding: input("labels") }]))).toContain(
      "reads list input labels outside a word-list hole",
    );
  });

  it("rejects two lists, a hole inside the run, and a list input that is not an array", () => {
    expect(
      errors(
        plan(
          [
            { token: 2, through: 3, binding: input("labels") },
            { token: 4, through: 5, binding: input("more") },
          ],
          [
            { name: "labels", type: "array", list: { minItems: 1 } },
            { name: "more", type: "array", list: { minItems: 1 } },
          ],
        ),
      ),
    ).toContain("takes more than one word list");
    expect(
      errors(
        plan(
          [labels, { token: 3, binding: input("label") }],
          [
            { name: "labels", type: "array", list: { minItems: 1 } },
            { name: "label", type: "string" },
          ],
        ),
      ),
    ).toContain("sits inside a word list");
    expect(
      errors(plan([labels], [{ name: "labels", type: "string", list: { minItems: 1 } }])),
    ).toContain("input labels list must be an array input");
  });
});
