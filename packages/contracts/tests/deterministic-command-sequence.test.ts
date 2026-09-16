import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_COMMAND_SEQUENCE_LIMITS,
  type DeterministicCommandSequence,
  DeterministicCommandSequenceSchema,
  canonicalDeterministicCommandSequenceDigest,
  isDeterministicCommandSequence,
  parseDeterministicCommandSequence,
  safeParseDeterministicCommandSequence,
  tryCanonicalDeterministicCommandSequenceDigest,
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

  it("accepts shared parameter identifiers across steps with identical role and prefix", () => {
    const sharedParams = {
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
            { parameter: "arg0", role: "path" }, // Reused arg0 with same role and prefix
          ],
        },
      ],
    };

    const res = safeParseDeterministicCommandSequence(sharedParams);
    expect(res.success).toBe(true);
    expect(isDeterministicCommandSequence(sharedParams)).toBe(true);
  });

  it("rejects non-sequential first appearances of parameter identifiers", () => {
    const nonSequential = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "lune",
          argv: [{ literal: "run" }, { parameter: "arg1", role: "path" }], // Expected arg0
        },
      ],
    };

    const res = safeParseDeterministicCommandSequence(nonSequential);
    expect(res.success).toBe(false);
    expect(res.success ? "" : res.error.issues.map((issue) => issue.message).join("; ")).toContain(
      "first appears at position 0: expected 'arg0'",
    );
  });

  it("accepts parameter identifier reuse across differing prefixes with one role", () => {
    const sharedAcrossPrefixes = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "lune",
          argv: [{ literal: "run" }, { prefix: "--input=", parameter: "arg0", role: "path" }],
        },
        {
          id: "step1",
          executable: "lune",
          argv: [{ literal: "run" }, { prefix: "--output=", parameter: "arg0", role: "path" }],
        },
      ],
    };

    const res = safeParseDeterministicCommandSequence(sharedAcrossPrefixes);
    expect(res.success).toBe(true);
    expect(isDeterministicCommandSequence(sharedAcrossPrefixes)).toBe(true);
    expect(tryCanonicalDeterministicCommandSequenceDigest(sharedAcrossPrefixes)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("canonicalizes shared-parameter linkage distinctly from an unlinked sequence", () => {
    const linked: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "lune",
          argv: [{ literal: "run" }, { prefix: "--input=", parameter: "arg0", role: "path" }],
        },
        {
          id: "step1",
          executable: "lune",
          argv: [{ literal: "run" }, { prefix: "--output=", parameter: "arg0", role: "path" }],
        },
      ],
    };
    // Same evidence with object keys written in a different insertion order must canonicalize equal.
    const linkedReordered: DeterministicCommandSequence = {
      control: "and-then",
      kind: "command-sequence",
      schemaVersion: 1,
      steps: [
        {
          executable: "lune",
          id: "step0",
          argv: [{ literal: "run" }, { role: "path", prefix: "--input=", parameter: "arg0" }],
        },
        {
          executable: "lune",
          id: "step1",
          argv: [{ literal: "run" }, { role: "path", parameter: "arg0", prefix: "--output=" }],
        },
      ],
    };
    const unlinked: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "lune",
          argv: [{ literal: "run" }, { prefix: "--input=", parameter: "arg0", role: "path" }],
        },
        {
          id: "step1",
          executable: "lune",
          argv: [{ literal: "run" }, { prefix: "--output=", parameter: "arg1", role: "path" }],
        },
      ],
    };

    const linkedDigest = canonicalDeterministicCommandSequenceDigest(linked);
    expect(linkedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalDeterministicCommandSequenceDigest(linkedReordered)).toBe(linkedDigest);
    expect(canonicalDeterministicCommandSequenceDigest(unlinked)).not.toBe(linkedDigest);

    expect(isDeterministicCommandSequence(linked)).toBe(true);
    expect(isDeterministicCommandSequence(linkedReordered)).toBe(true);
    expect(isDeterministicCommandSequence(unlinked)).toBe(true);
  });

  it("rejects parameter identifier reuse with conflicting role", () => {
    const conflictingRole = {
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
          argv: [{ literal: "run" }, { parameter: "arg0", role: "string" }],
        },
      ],
      parameterValueSha256: {
        arg0: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    };

    const resRole = safeParseDeterministicCommandSequence(conflictingRole);
    expect(resRole.success).toBe(false);
    expect(
      resRole.success ? "" : resRole.error.issues.map((issue) => issue.message).join("; "),
    ).toContain("conflicting role");
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

  it("accepts workflows longer than the former eight-step ceiling", () => {
    const twelveSteps = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: Array.from({ length: 12 }, (_, i) => ({
        id: `step${i}`,
        executable: "git",
        argv: [{ literal: "status" }],
      })),
    };
    expect(isDeterministicCommandSequence(twelveSteps)).toBe(true);
  });

  it("rejects sequences whose total argument count exceeds the evidence budget", () => {
    let parameterIndex = 0;
    const steps = Array.from({ length: 60 }, (_, i) => ({
      id: `step${i}`,
      executable: "stylua",
      argv: Array.from({ length: 5 }, () => ({
        parameter: `arg${parameterIndex++}`,
        role: "path",
      })),
    }));
    const oversized = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps,
    };
    const result = safeParseDeterministicCommandSequence(oversized);
    expect(result.success).toBe(false);
    expect(
      result.success ? "" : result.error.issues.map((issue) => issue.message).join("; "),
    ).toContain("evidence budget");
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
  it("validates and digests an 8x32 argument chain at the exact 256 argument budget", () => {
    const maxArgsPerStep = DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxArgs; // 32
    const stepCount = 8;
    // 8 steps x 32 args = exactly 256 arguments (maxSequenceArgs)
    const chain8x32: DeterministicCommandSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: Array.from({ length: stepCount }, (_, stepIndex) => ({
        id: `step${stepIndex}`,
        executable: `tool${stepIndex}`,
        argv: Array.from({ length: maxArgsPerStep }, (_, argIndex) => ({
          literal: `flag-${stepIndex}-${argIndex}`,
        })),
      })),
    };

    expect(isDeterministicCommandSequence(chain8x32)).toBe(true);
    const parsed = parseDeterministicCommandSequence(chain8x32);
    expect(parsed.steps).toHaveLength(8);
    const totalArgs = parsed.steps.reduce((acc, step) => acc + step.argv.length, 0);
    expect(totalArgs).toBe(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSequenceArgs);

    const digest = canonicalDeterministicCommandSequenceDigest(chain8x32);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(tryCanonicalDeterministicCommandSequenceDigest(chain8x32)).toBe(digest);
  });

  it("rejects a sequence exceeding the 256 argument budget by one argument", () => {
    // 8 steps x 32 args = 256 args; plus 1 step x 1 arg = 257 args
    const oversizedByOne = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        ...Array.from({ length: 8 }, (_, stepIndex) => ({
          id: `step${stepIndex}`,
          executable: `tool${stepIndex}`,
          argv: Array.from({ length: 32 }, (_, argIndex) => ({
            literal: `flag-${stepIndex}-${argIndex}`,
          })),
        })),
        {
          id: "step8",
          executable: "tool8",
          argv: [{ literal: "extra-arg" }],
        },
      ],
    };

    const result = safeParseDeterministicCommandSequence(oversizedByOne);
    expect(result.success).toBe(false);
    expect(
      result.success ? "" : result.error.issues.map((issue) => issue.message).join("; "),
    ).toContain(
      `Command sequence carries 257 arguments; the evidence budget allows at most ${DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSequenceArgs} across all steps`,
    );
  });

  it("fails explicitly without throw for 2500 zero-argument steps exceeding the structural node budget", () => {
    const zeroArg2500 = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: Array.from({ length: 2500 }, (_, i) => ({
        id: `step${i}`,
        executable: "git",
        argv: [],
      })),
    };

    expect(isDeterministicCommandSequence(zeroArg2500)).toBe(false);
    const res = safeParseDeterministicCommandSequence(zeroArg2500);
    expect(res.success).toBe(false);
    // Safe parse must fail explicitly without throwing
    expect(res.error).toBeDefined();
    // Fail-closed digest must return undefined without throwing
    expect(tryCanonicalDeterministicCommandSequenceDigest(zeroArg2500)).toBeUndefined();
    // parseDeterministicCommandSequence throws a ZodError, not an unhandled serializer Error
    expect(() => parseDeterministicCommandSequence(zeroArg2500)).toThrow();
  });

  it("validates sequence near node budget boundary and rejects sequence exceeding it", () => {
    // Each zero-arg step is 4 nodes; root is 5 nodes.
    // 2498 steps: 2498 * 4 + 5 = 9997 nodes <= 10,000 maxEvidenceNodes
    const boundaryValid = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: Array.from({ length: 2498 }, (_, i) => ({
        id: `step${i}`,
        executable: "git",
        argv: [],
      })),
    };
    expect(isDeterministicCommandSequence(boundaryValid)).toBe(true);
    expect(tryCanonicalDeterministicCommandSequenceDigest(boundaryValid)).toMatch(/^[a-f0-9]{64}$/);

    // 2501 steps: 2501 * 4 + 5 = 10,009 nodes > 10,000 maxEvidenceNodes
    const boundaryExceeded = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: Array.from({ length: 2501 }, (_, i) => ({
        id: `step${i}`,
        executable: "git",
        argv: [],
      })),
    };
    expect(isDeterministicCommandSequence(boundaryExceeded)).toBe(false);
    expect(safeParseDeterministicCommandSequence(boundaryExceeded).success).toBe(false);
    expect(tryCanonicalDeterministicCommandSequenceDigest(boundaryExceeded)).toBeUndefined();
  });

  it("tryCanonicalDeterministicCommandSequenceDigest handles hostile getters and oversized payloads fail-closed", () => {
    let getterInvoked = false;
    const hostile = {
      get schemaVersion() {
        getterInvoked = true;
        return 1;
      },
      kind: "command-sequence",
      control: "and-then",
      steps: [{ id: "step0", executable: "git", argv: [] }],
    };

    expect(tryCanonicalDeterministicCommandSequenceDigest(hostile)).toBeUndefined();
    expect(getterInvoked).toBe(false);

    const malformed = { notASequence: true };
    expect(tryCanonicalDeterministicCommandSequenceDigest(malformed)).toBeUndefined();
    expect(tryCanonicalDeterministicCommandSequenceDigest(null)).toBeUndefined();
    expect(tryCanonicalDeterministicCommandSequenceDigest(undefined)).toBeUndefined();
    expect(tryCanonicalDeterministicCommandSequenceDigest("plain string")).toBeUndefined();
  });

  it("fails closed without throwing when introspection traps throw", () => {
    const trapThrowing = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype trap");
        },
        ownKeys() {
          throw new Error("hostile ownKeys trap");
        },
        getOwnPropertyDescriptor() {
          throw new Error("hostile descriptor trap");
        },
      },
    );

    expect(isDeterministicCommandSequence(trapThrowing)).toBe(false);
    expect(safeParseDeterministicCommandSequence(trapThrowing).success).toBe(false);
    expect(tryCanonicalDeterministicCommandSequenceDigest(trapThrowing)).toBeUndefined();
    expect(() => parseDeterministicCommandSequence(trapThrowing)).toThrow();
  });

  it("rejects payloads nested beyond the pinned evidence depth without throwing", () => {
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 200; i++) {
      deep = { nested: deep };
    }
    const overDeep = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [{ id: "step0", executable: "git", argv: [deep] }],
    };

    expect(isDeterministicCommandSequence(overDeep)).toBe(false);
    expect(safeParseDeterministicCommandSequence(overDeep).success).toBe(false);
    expect(tryCanonicalDeterministicCommandSequenceDigest(overDeep)).toBeUndefined();
    expect(() => parseDeterministicCommandSequence(overDeep)).toThrow();
  });
});
