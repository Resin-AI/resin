import {
  DETERMINISTIC_COMMAND_SEQUENCE_LIMITS,
  type NormalizedCommandExecEvent,
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  RESIN_COMMAND_SEQUENCE_METADATA_KEY,
  nowIso,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  extractRawCommandStringFromEvent,
  isDeterministicCommandSequence,
  projectDeterministicCommandSequence,
  projectDeterministicCommandSequenceFromEvent,
} from "../../src/analytics/deterministic-command-sequence.js";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";

function createBaseHeaders(seq = 1) {
  return {
    eventId: `evt_${seq.toString().padStart(16, "0")}`,
    schemaVersion: "1.0.0",
    sessionId: "sess_test_deterministic_001",
    timestamp: nowIso(),
    causalRef: {
      causalSequence: seq,
      turnIndex: 0,
      stepIndex: seq,
      traceId: "trace_det_123",
      spanId: "span_det_456",
    },
    redaction: {
      isRedacted: false,
      redactedFields: [],
      redactionStrategy: "none" as const,
      scrubbedPatterns: [],
    },
  };
}

describe("projectDeterministicCommandSequence", () => {
  describe("supported standalone grammar", () => {
    it("projects git status variations", () => {
      const bare = projectDeterministicCommandSequence("git status");
      expect(bare).not.toBeNull();
      expect(bare?.steps).toHaveLength(1);
      expect(bare?.steps[0]?.executable).toBe("git");
      expect(bare?.steps[0]?.argv).toEqual([{ literal: "status" }]);

      const short = projectDeterministicCommandSequence("git status --short");
      expect(short?.steps[0]?.argv).toEqual([{ literal: "status" }, { literal: "--short" }]);

      const porcelain = projectDeterministicCommandSequence("git status --porcelain");
      expect(porcelain?.steps[0]?.argv).toEqual([
        { literal: "status" },
        { literal: "--porcelain" },
      ]);
    });

    it("projects git diff variations", () => {
      const bare = projectDeterministicCommandSequence("git diff");
      expect(bare?.steps[0]?.argv).toEqual([{ literal: "diff" }]);

      const stat = projectDeterministicCommandSequence("git diff --stat");
      expect(stat?.steps[0]?.argv).toEqual([{ literal: "diff" }, { literal: "--stat" }]);

      const nameOnly = projectDeterministicCommandSequence("git diff --name-only");
      expect(nameOnly?.steps[0]?.argv).toEqual([{ literal: "diff" }, { literal: "--name-only" }]);

      const nameStatus = projectDeterministicCommandSequence("git diff --name-status");
      expect(nameStatus?.steps[0]?.argv).toEqual([
        { literal: "diff" },
        { literal: "--name-status" },
      ]);
    });

    it("projects git log variations preserving option order", () => {
      const oneline = projectDeterministicCommandSequence("git log --oneline");
      expect(oneline?.steps[0]?.argv).toEqual([{ literal: "log" }, { literal: "--oneline" }]);

      const onelineLimit = projectDeterministicCommandSequence("git log --oneline -n 10");
      expect(onelineLimit?.steps[0]?.argv).toEqual([
        { literal: "log" },
        { literal: "--oneline" },
        { literal: "-n" },
        { parameter: "arg0", role: "number" },
      ]);

      const limitOneline = projectDeterministicCommandSequence("git log -n 5 --oneline");
      expect(limitOneline?.steps[0]?.argv).toEqual([
        { literal: "log" },
        { literal: "-n" },
        { parameter: "arg0", role: "number" },
        { literal: "--oneline" },
      ]);
    });

    it("projects lune run with path and optional suite", () => {
      const basic = projectDeterministicCommandSequence("lune run tests/test.luau");
      expect(basic?.steps[0]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg0", role: "path" },
      ]);

      const withSuite = projectDeterministicCommandSequence(
        "lune run tests/test.luau --suite unit",
      );
      expect(withSuite?.steps[0]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg0", role: "path" },
        { literal: "--suite" },
        { parameter: "arg1", role: "string" },
      ]);
    });

    it("projects stylua --check with one or more paths", () => {
      const single = projectDeterministicCommandSequence("stylua --check src/module.luau");
      expect(single).not.toBeNull();
      expect(single?.steps).toHaveLength(1);
      expect(single?.steps[0]?.executable).toBe("stylua");
      expect(single?.steps[0]?.argv).toEqual([
        { literal: "--check" },
        { parameter: "arg0", role: "path" },
      ]);

      const multi = projectDeterministicCommandSequence(
        "stylua --check src/first.luau src/second.luau",
      );
      expect(multi).not.toBeNull();
      expect(multi?.steps[0]?.argv).toEqual([
        { literal: "--check" },
        { parameter: "arg0", role: "path" },
        { parameter: "arg1", role: "path" },
      ]);
    });

    it("projects selene with one or more paths and optional --allow-warnings", () => {
      const bareSingle = projectDeterministicCommandSequence("selene src/module.luau");
      expect(bareSingle).not.toBeNull();
      expect(bareSingle?.steps[0]?.executable).toBe("selene");
      expect(bareSingle?.steps[0]?.argv).toEqual([{ parameter: "arg0", role: "path" }]);

      const bareMulti = projectDeterministicCommandSequence(
        "selene src/first.luau src/second.luau",
      );
      expect(bareMulti?.steps[0]?.argv).toEqual([
        { parameter: "arg0", role: "path" },
        { parameter: "arg1", role: "path" },
      ]);

      const withWarnings = projectDeterministicCommandSequence(
        "selene --allow-warnings src/first.luau src/second.luau",
      );
      expect(withWarnings?.steps[0]?.argv).toEqual([
        { literal: "--allow-warnings" },
        { parameter: "arg0", role: "path" },
        { parameter: "arg1", role: "path" },
      ]);
    });

    it("matches the schema argv boundary for variadic stylua and selene commands", () => {
      const maxArgs = DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxArgs;
      const paths = Array.from({ length: maxArgs + 1 }, (_, index) => `src/file-${index}.luau`);

      expect(
        projectDeterministicCommandSequence(
          `stylua --check ${paths.slice(0, maxArgs - 1).join(" ")}`,
        ),
      ).not.toBeNull();
      expect(
        projectDeterministicCommandSequence(`stylua --check ${paths.slice(0, maxArgs).join(" ")}`),
      ).toBeNull();

      expect(
        projectDeterministicCommandSequence(`selene ${paths.slice(0, maxArgs).join(" ")}`),
      ).not.toBeNull();
      expect(
        projectDeterministicCommandSequence(`selene ${paths.slice(0, maxArgs + 1).join(" ")}`),
      ).toBeNull();

      expect(
        projectDeterministicCommandSequence(
          `selene --allow-warnings ${paths.slice(0, maxArgs - 1).join(" ")}`,
        ),
      ).not.toBeNull();
      expect(
        projectDeterministicCommandSequence(
          `selene --allow-warnings ${paths.slice(0, maxArgs).join(" ")}`,
        ),
      ).toBeNull();
    });
  });

  describe("compound sequences", () => {
    it("projects git status && git log -n <value> --oneline", () => {
      const compound = projectDeterministicCommandSequence("git status && git log -n 15 --oneline");
      expect(compound).not.toBeNull();
      expect(compound?.steps).toHaveLength(2);
      expect(compound?.steps[0]?.id).toBe("step0");
      expect(compound?.steps[0]?.executable).toBe("git");
      expect(compound?.steps[0]?.argv).toEqual([{ literal: "status" }]);

      expect(compound?.steps[1]?.id).toBe("step1");
      expect(compound?.steps[1]?.executable).toBe("git");
      expect(compound?.steps[1]?.argv).toEqual([
        { literal: "log" },
        { literal: "-n" },
        { parameter: "arg0", role: "number" },
        { literal: "--oneline" },
      ]);
    });

    it("projects lune run <value> && lune run <value> with unique positional parameter names", () => {
      const compound = projectDeterministicCommandSequence(
        "lune run scripts/build.luau && lune run scripts/test.luau",
      );
      expect(compound).not.toBeNull();
      expect(compound?.steps).toHaveLength(2);
      expect(compound?.steps[0]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg0", role: "path" },
      ]);
      expect(compound?.steps[1]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg1", role: "path" },
      ]);
    });

    it("handles shell quotes around arguments without executing them", () => {
      const quoted = projectDeterministicCommandSequence(
        'git status "--short" && lune run "tests/suite.luau" --suite \'core\'',
      );
      expect(quoted).not.toBeNull();
      expect(quoted?.steps).toHaveLength(2);
      expect(quoted?.steps[0]?.argv).toEqual([
        { literal: "status" },
        { parameter: "arg0", role: "string" },
      ]);
      expect(quoted?.steps[1]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg1", role: "string" },
        { literal: "--suite" },
        { parameter: "arg2", role: "string" },
      ]);
    });

    it("projects PhysicsSnap workflow: stylua --check <two files> && lune run scripts/test-platformer-motor.luau", () => {
      const compound = projectDeterministicCommandSequence(
        "stylua --check src/motor.luau src/platformer.luau && lune run scripts/test-platformer-motor.luau",
      );
      expect(compound).not.toBeNull();
      expect(compound?.steps).toHaveLength(2);

      expect(compound?.steps[0]?.id).toBe("step0");
      expect(compound?.steps[0]?.executable).toBe("stylua");
      expect(compound?.steps[0]?.argv).toEqual([
        { literal: "--check" },
        { parameter: "arg0", role: "path" },
        { parameter: "arg1", role: "path" },
      ]);

      expect(compound?.steps[1]?.id).toBe("step1");
      expect(compound?.steps[1]?.executable).toBe("lune");
      expect(compound?.steps[1]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg2", role: "path" },
      ]);
    });

    it("projects PhysicsSnap workflow: selene <two files> && lune run scripts/build.luau", () => {
      const compound = projectDeterministicCommandSequence(
        "selene src/motor.luau src/platformer.luau && lune run scripts/build.luau",
      );
      expect(compound).not.toBeNull();
      expect(compound?.steps).toHaveLength(2);

      expect(compound?.steps[0]?.id).toBe("step0");
      expect(compound?.steps[0]?.executable).toBe("selene");
      expect(compound?.steps[0]?.argv).toEqual([
        { parameter: "arg0", role: "path" },
        { parameter: "arg1", role: "path" },
      ]);

      expect(compound?.steps[1]?.id).toBe("step1");
      expect(compound?.steps[1]?.executable).toBe("lune");
      expect(compound?.steps[1]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg2", role: "path" },
      ]);
    });

    it("projects selene with --allow-warnings and compound lune run", () => {
      const compound = projectDeterministicCommandSequence(
        "selene --allow-warnings src/motor.luau src/platformer.luau && lune run scripts/build.luau",
      );
      expect(compound).not.toBeNull();
      expect(compound?.steps).toHaveLength(2);

      expect(compound?.steps[0]?.id).toBe("step0");
      expect(compound?.steps[0]?.executable).toBe("selene");
      expect(compound?.steps[0]?.argv).toEqual([
        { literal: "--allow-warnings" },
        { parameter: "arg0", role: "path" },
        { parameter: "arg1", role: "path" },
      ]);

      expect(compound?.steps[1]?.id).toBe("step1");
      expect(compound?.steps[1]?.executable).toBe("lune");
      expect(compound?.steps[1]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg2", role: "path" },
      ]);
    });
  });

  describe("privacy boundaries", () => {
    it("produces identical canonical evidence for differing private values", () => {
      const seq1 = projectDeterministicCommandSequence("lune run secret/path/foo.luau");
      const seq2 = projectDeterministicCommandSequence("lune run other/user/bar.luau");
      expect(seq1).toEqual(seq2);

      const log1 = projectDeterministicCommandSequence("git log --oneline -n 5");
      const log2 = projectDeterministicCommandSequence("git log --oneline -n 500");
      expect(log1).toEqual(log2);
    });

    it("never retains private parameter values in the evidence", () => {
      const seq = projectDeterministicCommandSequence(
        "lune run customer/sensitive_data/test.luau --suite confidential_suite",
      );
      const json = JSON.stringify(seq);
      expect(json).not.toContain("customer");
      expect(json).not.toContain("sensitive_data");
      expect(json).not.toContain("confidential_suite");
    });

    it("never retains stylua or selene private parameter values in the evidence", () => {
      const styluaSeq = projectDeterministicCommandSequence(
        "stylua --check internal/confidential/code.luau private/secret.luau",
      );
      const styluaJson = JSON.stringify(styluaSeq);
      expect(styluaJson).not.toContain("internal");
      expect(styluaJson).not.toContain("confidential");
      expect(styluaJson).not.toContain("secret");

      const seleneSeq = projectDeterministicCommandSequence(
        "selene --allow-warnings sensitive/vault/keys.luau",
      );
      const seleneJson = JSON.stringify(seleneSeq);
      expect(seleneJson).not.toContain("sensitive");

      expect(seleneJson).not.toContain("vault");
      expect(seleneJson).not.toContain("keys");
    });
    it("retains only Lune's structural run verb and redacts other positional words", () => {
      const sequence = projectDeterministicCommandSequence(
        "lune customer-secret && lune run scripts/test.luau",
      );
      const json = JSON.stringify(sequence);

      expect(sequence?.steps[0]?.argv).toEqual([{ parameter: "arg0", role: "string" }]);
      expect(sequence?.steps[1]?.argv).toEqual([
        { literal: "run" },
        { parameter: "arg1", role: "path" },
      ]);
      expect(json).not.toContain("customer-secret");
    });
  });

  describe("shell-free safety boundary", () => {
    it("rejects shell expansions and variables", () => {
      expect(projectDeterministicCommandSequence("git status && echo $SECRET")).toBeNull();
      expect(projectDeterministicCommandSequence("git log --oneline -n $NUM")).toBeNull();
      expect(projectDeterministicCommandSequence("git status `whoami`")).toBeNull();
    });

    it("rejects redirection, pipes, semicolons, and newlines", () => {
      expect(projectDeterministicCommandSequence("git status > file.txt")).toBeNull();
      expect(projectDeterministicCommandSequence("git status 2>&1")).toBeNull();
      expect(projectDeterministicCommandSequence("git status | cat")).toBeNull();
      expect(projectDeterministicCommandSequence("git status || git diff")).toBeNull();
      expect(projectDeterministicCommandSequence("git status ; git diff")).toBeNull();
      expect(projectDeterministicCommandSequence("git status\ngit diff")).toBeNull();
    });

    it("rejects environment assignments and malformed quotes", () => {
      expect(projectDeterministicCommandSequence("NODE_ENV=production git status")).toBeNull();
      expect(projectDeterministicCommandSequence("git status && FOO=1 git diff")).toBeNull();
      expect(projectDeterministicCommandSequence('git status "unclosed')).toBeNull();
      expect(projectDeterministicCommandSequence("lune run 'unclosed")).toBeNull();
      expect(projectDeterministicCommandSequence("git st'at'us")).toBeNull();
    });

    it("rejects direct shells, nested launchers, and stateful builtins", () => {
      for (const command of [
        "bash -c whoami && pwd",
        "env sh script.sh && pwd",
        "sudo bash -c whoami && pwd",
        "nice sh script.sh && pwd",
        "timeout 10 sh script.sh && pwd",
        "setsid sh script.sh && pwd",
        "stdbuf -oL sh script.sh && pwd",
        "busybox sh script.sh && pwd",
        "awk length input.txt && pwd",
        "sed -n 1p input.txt && pwd",
        "time sh script.sh && pwd",
        "nohup sh script.sh && pwd",
        "exec sh script.sh && pwd",
        "cd subdir && pwd",
      ]) {
        expect(projectDeterministicCommandSequence(command)).toBeNull();
      }
    });

    it("rejects trailing, leading, or empty stages", () => {
      expect(projectDeterministicCommandSequence("git status &&")).toBeNull();
      expect(projectDeterministicCommandSequence("git status &&   ")).toBeNull();
      expect(projectDeterministicCommandSequence("git status && git diff &&")).toBeNull();
      expect(projectDeterministicCommandSequence("git status && && git diff")).toBeNull();
      expect(projectDeterministicCommandSequence("&& git status")).toBeNull();
    });

    it("rejects empty quoted argv values that cannot be replayed", () => {
      expect(projectDeterministicCommandSequence('lune run ""')).toBeNull();
      expect(projectDeterministicCommandSequence("lune run ''")).toBeNull();
      expect(projectDeterministicCommandSequence('git status ""')).toBeNull();
    });
  });

  describe("open command projection", () => {
    it("projects arbitrary executables without an executable allowlist", () => {
      const sequence = projectDeterministicCommandSequence(
        "rojo build default.project.json --output dist/game.rbxlx && cargo nextest run --workspace && custom-check verify src/game.ts",
      );

      expect(sequence?.steps.map((step) => step.executable)).toEqual([
        "rojo",
        "cargo",
        "custom-check",
      ]);
      expect(sequence?.steps[0]?.argv).toEqual([
        { literal: "build" },
        { parameter: "arg0", role: "path" },
        { literal: "--output" },
        { parameter: "arg1", role: "path" },
      ]);
      expect(sequence?.steps[1]?.argv).toEqual([
        { literal: "nextest" },
        { parameter: "arg2", role: "string" },
        { literal: "--workspace" },
      ]);
      expect(sequence?.steps[2]?.argv).toEqual([
        { parameter: "arg3", role: "string" },
        { parameter: "arg4", role: "path" },
      ]);

      const json = JSON.stringify(sequence);
      expect(json).not.toContain("default.project.json");
      expect(json).not.toContain("dist/game.rbxlx");
      expect(json).not.toContain("src/game.ts");
    });

    it("projects arbitrary subcommands, flags, numeric values, and no-argument commands", () => {
      expect(projectDeterministicCommandSequence("git push origin main")).not.toBeNull();
      expect(projectDeterministicCommandSequence("git status -v")).not.toBeNull();
      expect(projectDeterministicCommandSequence("curl https://api.example.com")).not.toBeNull();
      expect(projectDeterministicCommandSequence("stylua src/motor.luau")).not.toBeNull();
      expect(projectDeterministicCommandSequence("selene --quiet src/foo.luau")).not.toBeNull();
      expect(projectDeterministicCommandSequence("git log --oneline -n -5")).not.toBeNull();
      expect(projectDeterministicCommandSequence("selene && pwd")).not.toBeNull();
    });

    it("preserves exact bare executable identity and rejects qualified paths", () => {
      const sequence = projectDeterministicCommandSequence(
        "MyTool.exe verify src/input.ts && check.py",
      );

      expect(sequence?.steps.map((step) => step.executable)).toEqual(["MyTool.exe", "check.py"]);
      expect(projectDeterministicCommandSequence("./gradlew test && pwd")).toBeNull();
    });

    it("projects --flag=value as one argv token with an embedded typed parameter", () => {
      const sequence = projectDeterministicCommandSequence(
        "pytest --junitxml=reports/results.xml && pwd",
      );

      expect(sequence?.steps[0]?.argv).toEqual([
        { prefix: "--junitxml=", parameter: "arg0", role: "path" },
      ]);
      expect(sequence?.steps[1]).toEqual({
        id: "step1",
        executable: "pwd",
        argv: [],
      });
      expect(JSON.stringify(sequence)).not.toContain("reports/results.xml");
    });

    it("redacts absolute and traversal-looking positional values as path parameters", () => {
      for (const command of [
        "lune run ../secret.luau",
        "stylua --check /etc/passwd",
        "selene src/../../secret.luau",
      ]) {
        const sequence = projectDeterministicCommandSequence(command);
        expect(sequence).not.toBeNull();
        expect(JSON.stringify(sequence)).not.toMatch(/secret|passwd|etc/);
        expect(
          sequence?.steps[0]?.argv.some((arg) => "parameter" in arg && arg.role === "path"),
        ).toBe(true);
      }
    });
  });
});

describe("extractRawCommandStringFromEvent", () => {
  it("extracts from command_exec with string command", () => {
    const event: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "git status && git diff",
      args: [],
      exitCode: 0,
      durationMs: 120,
    };
    expect(extractRawCommandStringFromEvent(event)).toBe("git status && git diff");
  });

  it("extracts from command_exec with bash -c wrapper", () => {
    const event: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "bash",
      args: ["-c", "git status --short"],
      exitCode: 0,
      durationMs: 45,
    };
    expect(extractRawCommandStringFromEvent(event)).toBe("git status --short");
  });

  it("extracts from tool_call with shell tool and command parameter", () => {
    const event: NormalizedToolCallEvent = {
      ...createBaseHeaders(1),
      type: "tool_call",
      callId: "call_abc123",
      toolName: "bash",
      parameters: {
        command: "git log --oneline -n 5",
      },
      isShadow: false,
    };
    expect(extractRawCommandStringFromEvent(event)).toBe("git log --oneline -n 5");
  });

  it("returns null for non-shell tool_call or non-command events", () => {
    const toolEvent: NormalizedToolCallEvent = {
      ...createBaseHeaders(1),
      type: "tool_call",
      callId: "call_xyz",
      toolName: "file_read",
      parameters: { path: "src/index.ts" },
      isShadow: false,
    };
    expect(extractRawCommandStringFromEvent(toolEvent)).toBeNull();
  });

  it("fails closed for non-shell structured argv forms without interpreting argv as shell operators", () => {
    const eventWithOperatorsInArgv: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "git",
      args: ["status", "&&", "git", "diff"],
      exitCode: 0,
      durationMs: 50,
    };
    // Structured args must fail closed and never be concatenated into shell syntax
    expect(extractRawCommandStringFromEvent(eventWithOperatorsInArgv)).toBeNull();

    const eventWithSimpleArgs: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "git",
      args: ["status"],
      exitCode: 0,
      durationMs: 50,
    };
    expect(extractRawCommandStringFromEvent(eventWithSimpleArgs)).toBeNull();
  });

  it("rejects shell wrappers with extra positional arguments", () => {
    const eventExtraArgs: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "bash",
      args: ["-c", "git status", "extra_positional_arg"],
      exitCode: 0,
      durationMs: 50,
    };
    expect(extractRawCommandStringFromEvent(eventExtraArgs)).toBeNull();

    const eventMissingCommand: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "bash",
      args: ["-c"],
      exitCode: 0,
      durationMs: 50,
    };
    expect(extractRawCommandStringFromEvent(eventMissingCommand)).toBeNull();
  });

  it("rejects tool_call with mixed command-string and args ambiguity or conflicting keys", () => {
    const mixedCall: NormalizedToolCallEvent = {
      ...createBaseHeaders(1),
      type: "tool_call",
      callId: "call_mixed",
      toolName: "bash",
      parameters: {
        command: "git status",
        args: ["--short"],
      },
      isShadow: false,
    };
    expect(extractRawCommandStringFromEvent(mixedCall)).toBeNull();

    const conflictingCall: NormalizedToolCallEvent = {
      ...createBaseHeaders(1),
      type: "tool_call",
      callId: "call_conflict",
      toolName: "bash",
      parameters: {
        command: "git status",
        cmd: "git diff",
      },
      isShadow: false,
    };
    expect(extractRawCommandStringFromEvent(conflictingCall)).toBeNull();
  });
});

describe("projectEventToMetadataOnly integration", () => {
  it("attaches freshly derived deterministic command sequence to metadata", () => {
    const event: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "git status --short && git diff --stat",
      args: [],
      exitCode: 0,
      durationMs: 150,
    };

    const projected = projectEventToMetadataOnly(event);
    const seq = projected.metadata?.[RESIN_COMMAND_SEQUENCE_METADATA_KEY];
    expect(seq).toBeDefined();
    expect(isDeterministicCommandSequence(seq)).toBe(true);
  });

  it("discards preexisting inbound metadata.resinCommandSequence", () => {
    const forgedSequence = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [
        {
          id: "step0",
          executable: "git",
          argv: [{ literal: "forged" }],
        },
      ],
    };

    const event: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      metadata: {
        [RESIN_COMMAND_SEQUENCE_METADATA_KEY]: forgedSequence,
      },
      type: "command_exec",
      command: "echo $SECRET", // Shell expansion fails deterministic sequence parsing
      args: [],
      exitCode: 0,
      durationMs: 10,
    };

    const projected = projectEventToMetadataOnly(event);
    expect(projected.metadata?.[RESIN_COMMAND_SEQUENCE_METADATA_KEY]).toBeUndefined();
  });

  it("retains existing redactions for other fields while preserving derived sequence", () => {
    const event: NormalizedCommandExecEvent = {
      ...createBaseHeaders(1),
      type: "command_exec",
      command: "git status",
      args: [],
      cwd: "/home/user/workspace",
      stdout: "M file.txt",
      stderr: "",
      exitCode: 0,
      durationMs: 100,
    };

    const projected = projectEventToMetadataOnly(event) as NormalizedCommandExecEvent;
    expect(projected.metadata?.[RESIN_COMMAND_SEQUENCE_METADATA_KEY]).toBeDefined();
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactedFields).toContain("cwd");
    expect(projected.cwd).toBeUndefined();
    expect(projected.stdout).toBeUndefined();
  });
});
