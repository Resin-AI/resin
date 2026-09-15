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
      parameterValueSha256: {
        arg1: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    };
    expect(isDeterministicCommandSequence(suiteLune)).toBe(true);
  });

  it("validates stylua --check with one or more path parameters", () => {
    const singlePath: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "stylua",
          argv: [{ literal: "--check" }, { parameter: "arg0", role: "path" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(singlePath)).toBe(true);

    const multiPath: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "stylua",
          argv: [
            { literal: "--check" },
            { parameter: "arg0", role: "path" },
            { parameter: "arg1", role: "path" },
          ],
        },
      ],
    };
    expect(isDeterministicCommandSequence(multiPath)).toBe(true);
    const parsed = parseDeterministicCommandSequence(multiPath);
    expect(parsed.steps[0]?.executable).toBe("stylua");
    expect(parsed.steps[0]?.argv).toHaveLength(3);
  });

  it("validates selene with one or more path parameters and optional --allow-warnings", () => {
    const bareSingle: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "selene",
          argv: [{ parameter: "arg0", role: "path" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(bareSingle)).toBe(true);

    const bareMulti: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "selene",
          argv: [
            { parameter: "arg0", role: "path" },
            { parameter: "arg1", role: "path" },
          ],
        },
      ],
    };
    expect(isDeterministicCommandSequence(bareMulti)).toBe(true);

    const warningsMulti: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "selene",
          argv: [
            { literal: "--allow-warnings" },
            { parameter: "arg0", role: "path" },
            { parameter: "arg1", role: "path" },
          ],
        },
      ],
    };
    expect(isDeterministicCommandSequence(warningsMulti)).toBe(true);
  });

  it("validates PhysicsSnap compound workflows with stylua, selene, and lune", () => {
    const styluaWorkflow: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "stylua",
          argv: [
            { literal: "--check" },
            { parameter: "arg0", role: "path" },
            { parameter: "arg1", role: "path" },
          ],
        },
        {
          id: "step1",
          executable: "lune",
          argv: [{ literal: "run" }, { parameter: "arg2", role: "path" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(styluaWorkflow)).toBe(true);
    const digest1 = canonicalDeterministicCommandSequenceDigest(styluaWorkflow);
    expect(digest1).toMatch(/^[a-f0-9]{64}$/);

    const seleneWorkflow: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "selene",
          argv: [
            { parameter: "arg0", role: "path" },
            { parameter: "arg1", role: "path" },
          ],
        },
        {
          id: "step1",
          executable: "lune",
          argv: [{ literal: "run" }, { parameter: "arg2", role: "path" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(seleneWorkflow)).toBe(true);
    const digest2 = canonicalDeterministicCommandSequenceDigest(seleneWorkflow);
    expect(digest2).toMatch(/^[a-f0-9]{64}$/);

    const seleneWarningsWorkflow: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "selene",
          argv: [
            { literal: "--allow-warnings" },
            { parameter: "arg0", role: "path" },
            { parameter: "arg1", role: "path" },
          ],
        },
        {
          id: "step1",
          executable: "lune",
          argv: [{ literal: "run" }, { parameter: "arg2", role: "path" }],
        },
      ],
    };
    expect(isDeterministicCommandSequence(seleneWarningsWorkflow)).toBe(true);
    const digest3 = canonicalDeterministicCommandSequenceDigest(seleneWarningsWorkflow);
    expect(digest3).toMatch(/^[a-f0-9]{64}$/);
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
      parameterValueSha256: {
        arg2: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
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

  it("accepts arbitrary portable executables and command-specific argument shapes", () => {
    const arbitraryWorkflow = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "rojo",
          argv: [
            { literal: "build" },
            { parameter: "arg0", role: "path" },
            { literal: "--output" },
            { parameter: "arg1", role: "path" },
          ],
        },
        {
          id: "step1",
          executable: "cargo-nextest",
          argv: [{ literal: "run" }, { literal: "--workspace" }],
        },
        {
          id: "step2",
          executable: "git",
          argv: [{ literal: "rev-parse" }, { literal: "HEAD" }],
        },
      ],
    };

    expect(isDeterministicCommandSequence(arbitraryWorkflow)).toBe(true);
  });

  it("accepts evidence-derived commitments only for string parameters", () => {
    const committed = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "custom-checker",
          argv: [
            { parameter: "arg0", role: "string" },
            { parameter: "arg1", role: "path" },
          ],
        },
      ],
      parameterValueSha256: {
        arg0: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    };

    expect(isDeterministicCommandSequence(committed)).toBe(true);
    expect(
      isDeterministicCommandSequence({
        ...committed,
        parameterValueSha256: {
          arg1: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      }),
    ).toBe(false);
    expect(
      isDeterministicCommandSequence({
        ...committed,
        parameterValueSha256: { arg0: "not-a-sha256-digest" },
      }),
    ).toBe(false);
    expect(
      isDeterministicCommandSequence({
        ...committed,
        parameterValueSha256: undefined,
      }),
    ).toBe(false);
  });

  it("accepts privacy-safe parameters embedded in --flag=value argv tokens", () => {
    const sequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "pytest",
          argv: [{ prefix: "--junitxml=", parameter: "arg0", role: "path" }],
        },
      ],
    };

    expect(isDeterministicCommandSequence(sequence)).toBe(true);
    expect(parseDeterministicCommandSequence(sequence).steps[0]?.argv[0]).toEqual({
      prefix: "--junitxml=",
      parameter: "arg0",
      role: "path",
    });
  });

  it("accepts commands without arguments", () => {
    const noArgCommands = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        { id: "step0", executable: "pwd", argv: [] },
        { id: "step1", executable: "make", argv: [] },
      ],
    };

    expect(isDeterministicCommandSequence(noArgCommands)).toBe(true);
  });

  it("rejects malformed executable names and shell-bearing literal arguments", () => {
    for (const executable of ["../rojo", "/usr/bin/rojo", "rojo build", "-rojo"]) {
      expect(
        isDeterministicCommandSequence({
          schemaVersion: 1,
          kind: "command-sequence",
          control: "and-then",
          steps: [{ id: "step0", executable, argv: [] }],
        }),
      ).toBe(false);
    }

    for (const literal of ["two words", "foo;bar", "$(whoami)", "a|b"]) {
      expect(
        isDeterministicCommandSequence({
          schemaVersion: 1,
          kind: "command-sequence",
          control: "and-then",
          steps: [{ id: "step0", executable: "custom-check", argv: [{ literal }] }],
        }),
      ).toBe(false);
    }

    for (const prefix of ["junitxml=", "--bad value=", "--unsafe;="]) {
      expect(
        isDeterministicCommandSequence({
          schemaVersion: 1,
          kind: "command-sequence",
          control: "and-then",
          steps: [
            {
              id: "step0",
              executable: "pytest",
              argv: [{ prefix, parameter: "arg0", role: "path" }],
            },
          ],
        }),
      ).toBe(false);
    }
  });

  it("rejects shells, identity-hiding launchers, and stateful builtins", () => {
    for (const executable of [
      "bash",
      "PwSh.exe",
      "env",
      "sudo",
      "nice",
      "timeout",
      "awk",
      "gawk.exe",
      "sed",
      "setsid",
      "stdbuf",
      "busybox",
      "xargs",
      "chroot",
      "cd",
      "pushd",
      "export",
      "source",
    ]) {
      expect(
        isDeterministicCommandSequence({
          schemaVersion: 1,
          kind: "command-sequence",
          control: "and-then",
          steps: [{ id: "step0", executable, argv: [] }],
        }),
      ).toBe(false);
    }
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
