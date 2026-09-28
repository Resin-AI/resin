/**
 * The shell dialect a recorded shell program ran in is proven by the recording itself — the harness's
 * own shell tool, or the executable a harness recorded running — and never by the operating system.
 * A program whose dialect is unproven, or that ran in cmd.exe, is captured but never tokenized,
 * projected or offered as inputs.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeRecordDecoder } from "@resin/adapter-claude-code";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { NormalizedSessionEvent } from "@resin/contracts";
import type { HarnessRecordDecoder } from "@resin/harness-contracts";
import type { HarnessAdapter } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { createLocalCallIdentity } from "../../src/analytics/local-call-identity.js";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";
import {
  RESIN_WORKFLOW_DIALECT_METADATA_KEY,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-carrier.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-shell-dialect-capture";

async function capture(
  harnessId: "claude-code" | "codex-cli",
  decoder: HarnessRecordDecoder,
  lines: readonly Record<string, unknown>[],
) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(decoder);
  const recorder = new WorkflowCallRecorder({
    privateValues: store,
    privateValueOwnerWorkspaceId: WORKSPACE,
  });
  const sessionId = `${harnessId}-session`;
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const ordinal = index + 1;
    const timestamp = `2026-09-26T12:00:${String(ordinal).padStart(2, "0")}.000Z`;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${ordinal}`,
        sessionId,
        harnessId,
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ...line }),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
        metadata: {},
      },
      { sessionId, harnessId, workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  return Object.assign(
    observed.flatMap((event) => {
      const carrier = readWorkflowCallCarrier(
        projectEventToMetadataOnly(event).metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY],
      );
      return carrier === undefined ? [] : [{ event, carrier }];
    }),
    { projected: observed.map((event) => projectEventToMetadataOnly(event)), store },
  );
}

const claudeTurn = (id: string, name: string, command: string, result: string) => [
  {
    type: "assistant",
    sessionId: "claude-code-session",
    uuid: `a-${id}`,
    message: {
      role: "assistant",
      type: "message",
      content: [
        { type: "tool_use", id, name, input: { command, description: "Build the report" } },
      ],
    },
  },
  {
    type: "user",
    sessionId: "claude-code-session",
    uuid: `u-${id}`,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: false }],
    },
  },
];

const REQUEST = {
  type: "user",
  sessionId: "claude-code-session",
  uuid: "u-request",
  message: { role: "user", content: "Build the monthly report for region emea, month 2025-03" },
};

describe("the shell dialect a recording proves", () => {
  it("records Claude Code's Bash as bash and its PowerShell tool as unproven, never tokenized", async () => {
    const captured = await capture("claude-code", new ClaudeRecordDecoder(), [
      REQUEST,
      ...claudeTurn("toolu_bash", "Bash", "./report.sh --region emea --month 2025-03", "ok\n"),
      ...claudeTurn(
        "toolu_ps",
        "PowerShell",
        ".\\report.ps1 -Region emea -Month 2025-03",
        "report region=emea month=2025-03\r\n",
      ),
    ]);
    const bash = captured.find(
      ({ event }) => event.type === "tool_call" && event.toolName === "Bash",
    );
    const powershell = captured.find(
      ({ event }) => event.type === "tool_call" && event.toolName === "PowerShell",
    );
    expect(bash?.carrier.program).toMatchObject({ kind: "shell", dialect: "bash" });
    expect(bash?.carrier.candidates?.length).toBeGreaterThan(0);
    // Claude Code runs pwsh when installed, else Windows PowerShell 5.1: the edition is unproven.
    expect(powershell?.carrier.program).toMatchObject({ kind: "shell", unprovenDialect: true });
    expect(powershell?.carrier.program).not.toHaveProperty("dialect");
    expect(powershell?.carrier.program?.source).toBe("");
    expect(powershell?.carrier.candidates ?? []).toEqual([]);
    expect(powershell?.carrier.origins.command).toMatchObject({ type: "private" });
  });

  const codexCall = (name: string, args: Record<string, unknown>) => ({
    type: "response_item",
    payload: {
      type: "function_call",
      name,
      call_id: `call_${name}`,
      arguments: JSON.stringify(args),
    },
  });
  const codexSession = (cwd: string) => [
    {
      type: "session_meta",
      payload: { session_id: "codex-cli-session", id: "codex-cli-session", cwd },
    },
    { type: "turn_context", payload: { turn_id: "turn", cwd, model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Build the monthly report for region emea" }],
      },
    },
  ];

  it("keeps a Codex command a Windows session ran unproven, and one on Linux in its original reading", async () => {
    const windows = await capture("codex-cli", new CodexRecordDecoder(), [
      ...codexSession("C:\\work\\reports"),
      codexCall("exec_command", { cmd: ".\\report.ps1 -Region emea" }),
      codexCall("shell_command", { command: "Get-ChildItem out" }),
    ]);
    expect(windows.map(({ carrier }) => carrier.program)).toEqual([
      expect.objectContaining({ kind: "shell", unprovenDialect: true }),
      expect.objectContaining({ kind: "shell", unprovenDialect: true }),
    ]);
    for (const { carrier } of windows) expect(carrier.candidates ?? []).toEqual([]);

    // A `shell` argument names the family only: Codex may resolve powershell to pwsh.
    const named = await capture("codex-cli", new CodexRecordDecoder(), [
      ...codexSession("/work/reports"),
      codexCall("exec_command", { cmd: "Get-ChildItem out", shell: "powershell.exe" }),
    ]);
    expect(named[0]?.carrier.program).toMatchObject({ unprovenDialect: true });

    const linux = await capture("codex-cli", new CodexRecordDecoder(), [
      ...codexSession("/work/reports"),
      codexCall("exec_command", { cmd: "./report.sh --region emea" }),
    ]);
    expect(linux[0]?.carrier.program).toEqual(
      expect.objectContaining({ kind: "shell", argument: "cmd" }),
    );
    expect(linux[0]?.carrier.program).not.toHaveProperty("dialect");
    expect(linux[0]?.carrier.program).not.toHaveProperty("unprovenDialect");
  });

  const commandExecution = (id: string, command: string[], stdout: string) => ({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        id,
        command,
        cwd: pathToFileURL(path.resolve("/work/reports")).href,
        status: "completed",
        stdout,
        stderr: "",
        exit_code: 0,
        duration: { secs: 0, nanos: 5_000_000 },
      },
      started_at_ms: 1_000,
      completed_at_ms: 1_005,
    },
  });

  it("proves each Windows shell from the executable Codex recorded running", async () => {
    const captured = await capture("codex-cli", new CodexRecordDecoder(), [
      ...codexSession("/work/reports"),
      commandExecution(
        "exec-ps",
        [
          "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "-Command",
          ".\\report.ps1 -Region emea -Month 2025-03",
        ],
        "report\r\n",
      ),
      commandExecution(
        "exec-pwsh",
        [
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          "-NoProfile",
          "-Command",
          "Get-Date && Get-ChildItem out",
        ],
        "x\r\n",
      ),
      commandExecution(
        "exec-cmd",
        ["C:\\WINDOWS\\system32\\cmd.exe", "/c", "report.cmd emea"],
        "report\r\n",
      ),
    ]);
    const programs = captured.map(({ carrier }) => carrier.program);
    expect(programs).toEqual([
      expect.objectContaining({ kind: "shell", dialect: "powershell" }),
      expect.objectContaining({ kind: "shell", dialect: "pwsh" }),
      expect.objectContaining({ kind: "shell", dialect: "cmd", source: "" }),
    ]);
    const [powershell, pwsh, cmd] = captured.map(({ carrier }) => carrier);
    // PowerShell programs are read in their own grammar; cmd.exe never is.
    expect(powershell?.origins.cmd).toMatchObject({ type: "program", language: "powershell" });
    expect(pwsh?.origins.cmd).toMatchObject({ type: "program", language: "pwsh" });
    expect(
      (powershell?.candidates ?? []).flatMap((candidate) =>
        candidate.proposed.kind === "input" ? [candidate.proposed.name] : [],
      ),
    ).toContain("region");
    expect(cmd?.origins.cmd).toMatchObject({ type: "private" });
    expect(cmd?.candidates ?? []).toEqual([]);
    expect(cmd?.baselineInputs?.resinCodexShellProfile).toBeDefined();
  });

  describe("a Codex shell tool call its end event proves", () => {
    const COMMAND = ".\\report.ps1 -Region emea -Month 2025-03";
    /** A Windows session calling `tool` with COMMAND, then Codex's end event with `argv`. */
    const session = (tool: "exec_command" | "shell_command", argv?: string[]) => [
      ...codexSession("C:\\work\\reports"),
      codexCall(tool, tool === "exec_command" ? { cmd: COMMAND } : { command: COMMAND }),
      ...(argv === undefined
        ? []
        : [
            {
              type: "event_msg",
              payload: {
                type: "exec_command_end",
                call_id: `call_${tool}`,
                command: argv,
                cwd: "C:\\work\\reports",
                stdout: "report\r\n",
                stderr: "",
                exit_code: 0,
                duration: { secs: 0, nanos: 5_000_000 },
              },
            },
          ]),
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `call_${tool}`,
          output: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nreport\r\n",
        },
      },
    ];
    const recorded = async (tool: "exec_command" | "shell_command", argv?: string[]) => {
      const captured = await capture("codex-cli", new CodexRecordDecoder(), session(tool, argv));
      const recipe = recordCallsFromEvents("codex-cli-session", captured.projected);
      return { captured, steps: recipe?.workflow.steps ?? [], recipe };
    };
    const POWERSHELL = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

    it.each([
      ["shell_command", POWERSHELL, "powershell", "command"],
      ["exec_command", PWSH, "pwsh", "cmd"],
    ] as const)(
      "upgrades %s to the edition %s proves",
      async (tool, executable, dialect, argument) => {
        const { captured, steps, recipe } = await recorded(tool, [
          executable,
          "-NoProfile",
          "-Command",
          COMMAND,
        ]);
        // The call was recorded unproven; its end event carries the proof, and the recording applies it.
        expect(captured[0]?.carrier.program).toMatchObject({ unprovenDialect: true });
        expect(
          captured.projected.find((event) => event.type === "command_exec")?.metadata?.[
            RESIN_WORKFLOW_DIALECT_METADATA_KEY
          ],
        ).toMatchObject({ argument, dialect });
        expect(steps).toHaveLength(1);
        expect(steps[0]?.callable.program).toEqual({
          kind: "shell",
          source: COMMAND,
          argument,
          dialect,
        });
        expect(steps[0]?.arguments.find((entry) => entry.name === argument)?.source).toMatchObject({
          kind: "template",
          template: { type: "program", language: dialect },
        });
        expect(
          (recipe?.workflow.candidates ?? []).flatMap((candidate) =>
            candidate.proposed.kind === "input" ? [candidate.proposed.name] : [],
          ),
        ).toEqual(expect.arrayContaining(["region", "month"]));
      },
    );

    it.each([
      ["no end event", undefined],
      ["an end event for other text", [POWERSHELL, "-Command", "Get-Date"]],
      [
        "an execution policy it does not model",
        [POWERSHELL, "-ExecutionPolicy", "Bypass", "-Command", COMMAND],
      ],
      ["a shell that is not a Windows shell", ["C:\\tools\\nu.exe", "-c", COMMAND]],
    ])("keeps the call unproven with %s", async (_, argv) => {
      const { steps, recipe } = await recorded("shell_command", argv as string[] | undefined);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.callable.program).toMatchObject({ unprovenDialect: true });
      expect(steps[0]?.callable.program).not.toHaveProperty("dialect");
      expect(recipe?.workflow.candidates ?? []).toEqual([]);
    });

    it("leaves a POSIX Codex command's end event as it was, one step", async () => {
      const captured = await capture("codex-cli", new CodexRecordDecoder(), [
        ...codexSession("/work/reports"),
        codexCall("exec_command", { cmd: "./report.sh --region emea" }),
        {
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "call_exec_command",
            command: ["/bin/bash", "-lc", "./report.sh --region emea"],
            cwd: "/work/reports",
            stdout: "ok\n",
            stderr: "",
            exit_code: 0,
            duration: { secs: 0, nanos: 5_000_000 },
          },
        },
      ]);
      const steps = recordCallsFromEvents("codex-cli-session", captured.projected)?.workflow.steps;
      expect(steps?.map((step) => step.callable.name)).toEqual(["exec_command"]);
      expect(steps?.[0]?.callable.program).not.toHaveProperty("dialect");
    });
  });

  describe("a Codex session on Windows the model cannot turn into a POSIX one", () => {
    it.each([
      ["a relative workdir", { workdir: "." }],
      ["a relative cwd", { cwd: "reports" }],
      ["a POSIX-looking workdir", { workdir: "/tmp" }],
      ["a bash shell argument", { shell: "bash" }],
    ])("keeps a call with %s unproven", async (_, extra) => {
      const captured = await capture("codex-cli", new CodexRecordDecoder(), [
        ...codexSession("C:\\work\\reports"),
        codexCall("shell_command", { command: "Get-ChildItem out", ...extra }),
      ]);
      expect(captured[0]?.carrier.program).toMatchObject({ unprovenDialect: true });
    });

    it("keeps a call with a Windows workdir unproven in a session with no Windows directory", async () => {
      const captured = await capture("codex-cli", new CodexRecordDecoder(), [
        ...codexSession("/work/reports"),
        codexCall("exec_command", { cmd: "dir", workdir: "C:\\work" }),
      ]);
      expect(captured[0]?.carrier.program).toMatchObject({ unprovenDialect: true });
    });

    it("lets the call's cmd.exe end event prove it, as cmd: captured, never learned", async () => {
      const captured = await capture("codex-cli", new CodexRecordDecoder(), [
        ...codexSession("C:\\work\\reports"),
        codexCall("shell_command", { command: "report.cmd emea", workdir: "." }),
        endEvent("call_shell_command", ["C:\\WINDOWS\\system32\\cmd.exe", "/c", "report.cmd emea"]),
      ]);
      const steps = recordCallsFromEvents("codex-cli-session", captured.projected)?.workflow.steps;
      expect(steps?.[0]?.callable.program).toMatchObject({ dialect: "cmd" });
    });
  });

  describe("conflicting completions of one Codex call", () => {
    const POWERSHELL = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const CMD = "C:\\WINDOWS\\system32\\cmd.exe";
    // cmd reads everything after `rem` as a comment; PowerShell would start calc.
    const SOURCE = "rem 2>NUL; Start-Process calc";

    async function completions(...ends: Array<Record<string, unknown>>) {
      const captured = await capture("codex-cli", new CodexRecordDecoder(), [
        ...codexSession("C:\\work\\reports"),
        codexCall("shell_command", { command: SOURCE }),
        ...ends,
      ]);
      const recipe = recordCallsFromEvents("codex-cli-session", captured.projected);
      const identity = await createLocalCallIdentity({
        workspaceId: WORKSPACE,
        privateValues: captured.store,
        adapters: [
          {
            listWorkspaces: async () => [{ workspaceId: WORKSPACE, rootPath: "C:\\work" }],
            listSessions: async () => [{ sessionId: "codex-cli-session", workspaceId: WORKSPACE }],
          } as unknown as HarnessAdapter,
        ],
      }).lookup("call_shell_command");
      return {
        program: recipe?.workflow.steps[0]?.callable.program,
        local: identity?.callable.program,
      };
    }

    it("proves a call two agreeing completions name, and keeps it proven", async () => {
      const agreeing = endEvent("call_shell_command", [CMD, "/c", SOURCE]);
      const { program, local } = await completions(agreeing, agreeing);
      expect(program).toMatchObject({ dialect: "cmd" });
      expect(local).toMatchObject({ dialect: "cmd" });
    });

    it.each([
      [
        "a forged PowerShell 7 completion before the real cmd one",
        [
          endEvent("call_shell_command", [PWSH, "-Command", SOURCE]),
          endEvent("call_shell_command", [CMD, "/c", SOURCE]),
        ],
      ],
      [
        "two PowerShell editions",
        [
          endEvent("call_shell_command", [POWERSHELL, "-Command", SOURCE]),
          endEvent("call_shell_command", [PWSH, "-Command", SOURCE]),
        ],
      ],
      [
        "a completion for other text",
        [
          endEvent("call_shell_command", [PWSH, "-Command", SOURCE]),
          endEvent("call_shell_command", [PWSH, "-Command", "Get-Date"]),
        ],
      ],
      [
        "a first completion that proves nothing",
        [
          endEvent("call_shell_command", [PWSH, "-ExecutionPolicy", "Bypass", "-Command", SOURCE]),
          endEvent("call_shell_command", [PWSH, "-Command", SOURCE]),
        ],
      ],
      [
        "a completion from another thread",
        [
          { type: "session_meta", payload: { id: "other-thread", cwd: "C:\\work\\reports" } },
          endEvent("call_shell_command", [PWSH, "-Command", SOURCE]),
        ],
      ],
    ])("leaves the call unproven, locally and in the recording, after %s", async (_, ends) => {
      const { program, local } = await completions(...ends);
      expect(program).toMatchObject({ unprovenDialect: true });
      expect(program).not.toHaveProperty("dialect");
      expect(local).toMatchObject({ unprovenDialect: true });
      expect(local).not.toHaveProperty("dialect");
    });
  });
});

function endEvent(callId: string, argv: string[]): Record<string, unknown> {
  return {
    type: "event_msg",
    payload: {
      type: "exec_command_end",
      call_id: callId,
      command: argv,
      cwd: "C:\\work\\reports",
      stdout: "ok\r\n",
      stderr: "",
      exit_code: 0,
      duration: { secs: 0, nanos: 5_000_000 },
    },
  };
}
