import { describe, expect, it } from "vitest";
import {
  type DeterministicCommandSequence,
  DeterministicCommandSequenceSchema,
  canonicalDeterministicCommandSequenceDigest,
  isDeterministicCommandSequence,
  parseDeterministicCommandSequence,
  safeParseDeterministicCommandSequence,
} from "../src/index.js";

describe("DeterministicCommandSequenceSchema", () => {
  it("validates a minimal single git status step", () => {
    const sequence: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "status" }],
        },
      ],
    };

    expect(isDeterministicCommandSequence(sequence)).toBe(true);
    const parsed = parseDeterministicCommandSequence(sequence);
    expect(parsed.steps[0]?.executable).toBe("git");
    expect(parsed.steps[0]?.argv[0]).toEqual({ literal: "status" });
  });

  it("validates git status with --short and --porcelain flags", () => {
    const shortSeq: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "status" }, { literal: "--short" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(shortSeq)).toBe(true);

    const porcelainSeq: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "status" }, { literal: "--porcelain" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(porcelainSeq)).toBe(true);
  });

  it("validates git diff with allowed flags", () => {
    for (const flag of ["--stat", "--name-only", "--name-status"] as const) {
      const seq: DeterministicCommandSequence = {
        schemaVersion: 1,
        kind: "command-sequence",
        control: "and-then",
        steps: [
          {
            id: "step0",
            executable: "git",
            argv: [{ literal: "diff" }, { literal: flag }],
          },
        ],
      };
      expect(isDeterministicCommandSequence(seq)).toBe(true);
    }
  });

  it("validates git log with --oneline and optional -n NUMBER in both orders", () => {
    const onelineFirst: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [
            { literal: "log" },
            { literal: "--oneline" },
            { literal: "-n" },
            { parameter: "arg0", role: "number" },
          ],
        },
      ],
    };
    expect(isDeterministicCommandSequence(onelineFirst)).toBe(true);

    const limitFirst: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [
            { literal: "log" },
            { literal: "-n" },
            { parameter: "arg0", role: "number" },
            { literal: "--oneline" },
          ],
        },
      ],
    };
    expect(isDeterministicCommandSequence(limitFirst)).toBe(true);
  });

  it("validates lune run with path parameter and optional suite parameter", () => {
    const basicLune: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "lune",
          argv: [{ literal: "run" }, { parameter: "arg0", role: "path" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(basicLune)).toBe(true);

    const suiteLune: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "lune",
          argv: [
            { literal: "run" },
            { parameter: "arg0", role: "path" },
            { literal: "--suite" },
            { parameter: "arg1", role: "string" },
          ],
        },
      ],
    };
    expect(isDeterministicCommandSequence(suiteLune)).toBe(true);
  });

  it("validates compound sequence with positional sequential parameter names across steps", () => {
    const compound: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "status" }],
        },
        {
          id: "step1",
          executable: "git",
          argv: [
            { literal: "log" },
            { literal: "-n" },
            { parameter: "arg0", role: "number" },
            { literal: "--oneline" },
          ],
        },
        {
          id: "step2",
          executable: "lune",
          argv: [
            { literal: "run" },
            { parameter: "arg1", role: "path" },
            { literal: "--suite" },
            { parameter: "arg2", role: "string" },
          ],
        },
        {
          id: "step3",
          executable: "lune",
          argv: [{ literal: "run" }, { parameter: "arg3", role: "path" }],
        },
      ],
    };

    expect(isDeterministicCommandSequence(compound)).toBe(true);
    const digest = canonicalDeterministicCommandSequenceDigest(compound);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate or non-sequential parameter identifiers", () => {
    const duplicateParams = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "lune",
          argv: [{ literal: "run" }, { parameter: "arg0", role: "path" }],
        },
        {
          id: "step1",
          executable: "lune",
          argv: [
            { literal: "run" },
            { parameter: "arg0", role: "path" }, // Reused arg0 instead of arg1
          ],
        },
      ],
    };

    const res = safeParseDeterministicCommandSequence(duplicateParams);
    expect(res.success).toBe(false);
  });

  it("rejects non-sequential step IDs", () => {
    const wrongStepId = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step1", // Expected step0
          executable: "git",
          argv: [{ literal: "status" }],
        },
      ],
    };

    const res = safeParseDeterministicCommandSequence(wrongStepId);
    expect(res.success).toBe(false);
  });

  it("rejects git log without --oneline", () => {
    const missingOneline = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "log" }, { literal: "-n" }, { parameter: "arg0", role: "number" }],
        },
      ],
    };

    const res = safeParseDeterministicCommandSequence(missingOneline);
    expect(res.success).toBe(false);
  });

  it("rejects unknown executables or subcommands", () => {
    const unknownExe = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "curl",
          argv: [{ literal: "http://example.com" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(unknownExe)).toBe(false);

    const unknownGitSub = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "commit" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(unknownGitSub)).toBe(false);
  });

  it("rejects unknown properties on strict objects", () => {
    const extraKey = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      cwd: "/repo", // Unknown key
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "status" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(extraKey)).toBe(false);
  });

  it("rejects sequences exceeding step limits", () => {
    const nineSteps = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: Array.from({ length: 9 }, (_, i) => ({
        id: `step${i}`,
        executable: "git",
        argv: [{ literal: "status" }],
      })),
    };
    expect(isDeterministicCommandSequence(nineSteps)).toBe(false);
  });

  it("rejects hostile accessors without invoking getters", () => {
    let getterInvoked = false;
    const hostile = {
      get schemaVersion() {
        getterInvoked = true;
        return 1;
      },
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "status" }],
        },
      ],
    };

    const result = safeParseDeterministicCommandSequence(hostile);
    expect(result.success).toBe(false);
    expect(getterInvoked).toBe(false);
    expect(isDeterministicCommandSequence(hostile)).toBe(false);
    expect(() => parseDeterministicCommandSequence(hostile)).toThrow();
    expect(getterInvoked).toBe(false);
  });

  it("rejects objects with forbidden prototype keys or custom prototypes", () => {
    const protoPolluted = Object.create(null);
    Object.defineProperty(protoPolluted, "__proto__", {
      value: { malicious: true },
      enumerable: true,
      configurable: true,
    });
    protoPolluted.schemaVersion = 1;
    protoPolluted.kind = "command-sequence";
    protoPolluted.control = "and-then";
    protoPolluted.steps = [
      {
        id: "step0",
        executable: "git",
        argv: [{ literal: "status" }],
      },
    ];

    expect(isDeterministicCommandSequence(protoPolluted)).toBe(false);
    expect(safeParseDeterministicCommandSequence(protoPolluted).success).toBe(false);

    class CustomSequence {
      schemaVersion = 1;
      kind = "command-sequence";
      control = "and-then";
      steps = [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "status" }],
        },
      ];
    }
    const customInstance = new CustomSequence();
    expect(isDeterministicCommandSequence(customInstance)).toBe(false);
    expect(safeParseDeterministicCommandSequence(customInstance).success).toBe(false);
  });
});
