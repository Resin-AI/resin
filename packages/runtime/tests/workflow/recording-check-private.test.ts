/**
 * A recorded value that was redacted before upload is compared only with a value this device
 * supplies. A plan-supplied guess, or a derivation's output, at that position is refused before any
 * comparison, so the verdict is the same whether the guess was right or wrong.
 */
import type { WorkflowStep, WorkflowValueTemplate } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createRecordingCheckAdapter } from "../../src/workflow/recording-check.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/workflow/runtime-families.js";

const SECRET = "S3cretPw";
const COMMAND = `psql -p ${SECRET} inventory`;
const REDACTED_VIEW = "psql -p [REDACTED_CREDENTIAL:0123456789abcdef] inventory";

type ProgramTemplate = Extract<WorkflowValueTemplate, { type: "program" }>;

function step(template: Partial<ProgramTemplate>): WorkflowStep {
  return {
    id: "dump",
    callId: "dump",
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source: REDACTED_VIEW, argument: "command" },
    },
    arguments: [
      {
        name: "command",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "shell",
            source: { type: "literal", value: REDACTED_VIEW },
            holes: [],
            ...template,
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
  } as unknown as WorkflowStep;
}

/** Checks a plan step whose command resolves to `resolved` against the private recording. */
async function check(template: Partial<ProgramTemplate>, resolved = COMMAND): Promise<unknown> {
  const adapter = createRecordingCheckAdapter(
    RESIN_PROCESS_RUNTIME,
    new Map([
      [
        "dump",
        {
          callable: { name: "bash", program: { kind: "shell", argument: "command" } },
          arguments: { command: COMMAND },
          result: "dumped",
          hiddenDependencies: [],
          privatePositions: [{ argument: "command", path: ["tokens", 2] }],
        },
      ],
    ]),
  );
  return await adapter.call({ step: step(template), arguments: { command: resolved } });
}

async function verdict(run: Promise<unknown>): Promise<string> {
  try {
    return `verified:${String(await run)}`;
  } catch (error) {
    return `missed:${(error as Error).message}`;
  }
}

describe("a private recorded value", () => {
  it("answers an equality guess the same whether the guess is right or wrong", async () => {
    const guess = (value: string) =>
      check(
        { source: { type: "literal", value: COMMAND.replace(SECRET, value) } },
        COMMAND.replace(SECRET, value),
      );
    const right = await verdict(guess(SECRET));
    const wrong = await verdict(guess("hunter22"));
    expect(right).toMatch(/^missed:.*private recorded value/);
    expect(right).toBe(wrong);

    const holeGuess = (value: string) =>
      check(
        { holes: [{ token: 2, binding: { type: "literal", value } }] },
        COMMAND.replace(SECRET, value),
      );
    expect(await verdict(holeGuess(SECRET))).toBe(await verdict(holeGuess("hunter22")));
    expect(await verdict(holeGuess(SECRET))).toMatch(/private recorded value/);
  });

  it("never compares a derivation's output with it, so no bit of the output leaks", async () => {
    // The derivation printed either the secret or not: both outcomes read the same.
    const derived = (resolved: string) =>
      check(
        { holes: [{ token: 2, binding: { type: "result", stepId: "derive", path: [] } }] },
        resolved,
      );
    const bitOne = await verdict(derived(COMMAND));
    const bitZero = await verdict(derived(COMMAND.replace(SECRET, "x")));
    expect(bitOne).toMatch(/private recorded value/);
    expect(bitOne).toBe(bitZero);
  });

  it("verifies when the plan reads it from this device's store", async () => {
    await expect(check({ sourceReference: "private:v2:dump:command" })).resolves.toBe("dumped");
    await expect(
      check({
        holes: [{ token: 2, binding: { type: "private", reference: "private:v2:dump:secret" } }],
      }),
    ).resolves.toBe("dumped");
  });

  it("refuses an input the plan declares a default for, which is a literal by another name", async () => {
    const adapter = createRecordingCheckAdapter(
      RESIN_PROCESS_RUNTIME,
      new Map([
        [
          "dump",
          {
            callable: { name: "bash", program: { kind: "shell", argument: "command" } },
            arguments: { command: COMMAND },
            result: "dumped",
            hiddenDependencies: [],
            privatePositions: [{ argument: "command", path: ["tokens", 2] }],
          },
        ],
      ]),
      undefined,
      new Set(["password"]),
    );
    const planStep = step({
      holes: [{ token: 2, binding: { type: "input", name: "password" } }],
    });
    await expect(adapter.call({ step: planStep, arguments: { command: COMMAND } })).rejects.toThrow(
      /private recorded value/,
    );
  });
});
