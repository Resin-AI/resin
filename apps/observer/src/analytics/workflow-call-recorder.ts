/**
 * Workflow call recorder: attaches the per-call carrier the general compiler consumes.
 *
 * A call routed through the reference-aware invocation surface (`invoke_tool`) arrives
 * in the transcript with its argument envelopes verbatim. This recorder reads those
 * envelopes with the same shared analyzer the dispatcher used, so the recorded origin
 * of every argument is exactly what the caller stated — a literal, a declared input,
 * or a reference to an earlier result — never a guess from a matching value.
 *
 * The carrier is attached to the normalized event BEFORE privacy projection, as
 * `metadata.workflowCall`, so the live path and the import path produce identical
 * records. Projection re-reads it through `readWorkflowCallCarrier` and copies it
 * through by value; literal values ride along (they are what the workflow is made of)
 * while private leaves were already replaced by `private:` references whose originals
 * stay in the local value store.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { recordedFileUrlPath } from "@resin/adapter-codex";
import {
  type AgentArgumentOrigin,
  type NormalizedSessionEvent,
  type ProgramLanguage,
  ProgramSourceProjectionError,
  ProgramTokenizationError,
  type ShellDialect,
  WORKFLOW_PATCH_STEP_RESULT,
  type WorkflowArgumentProvenance,
  type WorkflowJsonValue,
  type WorkflowRecordedProgram,
  type WorkflowValuePath,
  analyzeAgentArguments,
  analyzeProgramSourceProjection,
  applyProgramTokenValues,
  embeddedPrograms,
  programTokenPath,
  programTokenValueAt,
  projectedEmbeddedTokenIsBindable,
  readCodexCommandMetadata,
  recordedProgramLanguage,
  tokenizeProgram,
  windowsShellInvocation,
} from "@resin/contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import {
  isLocalWorkflowResultSuppressed,
  localWorkflowEvent,
  localWorkflowResultObservation,
  redactLocalWorkflowProgramSource,
  retainLocalWorkflowPayload,
} from "../normalization/local-workflow-payload.js";
import { redactProgramSourceInPlace } from "../normalization/program-source-redaction.js";
import type { RedactedStringResult } from "../normalization/redaction.js";
import { isClosedCodexSource } from "./computation/codex-source-dependencies.js";
import { extractComputationSourceFrames } from "./computation/source-frames.js";
import { extractRawCommandStringFromEvent } from "./deterministic-command-sequence.js";
import { deriveNativeCalls } from "./native-argument-derivation.js";
import {
  FilePrivateValueStore,
  type PrivateValueOrigin,
  type PrivateValueStore,
  containsRedactionPlaceholder,
} from "./private-value-store.js";
import { declaredFlowOfToolCall } from "./tool-links/declared-flow.js";
import {
  WORKFLOW_CALL_DIALECT_CONFLICT_SLOT,
  WORKFLOW_CALL_DIALECT_SLOT,
  WORKFLOW_CALL_EXIT_CODE_SLOT,
  WORKFLOW_CALL_IDENTITY_SLOT,
  WORKFLOW_CALL_ORDER_SLOT,
  WORKFLOW_CALL_PRIVATE_POSITIONS_SLOT,
  WORKFLOW_CALL_RESULT_CONFLICT_SLOT,
  WORKFLOW_CALL_RESULT_REDACTED_SLOT,
  workflowCallArgumentSlot,
  workflowPrivateReference,
} from "./workflow-private-reference.js";

import {
  type DiscoveredCallable,
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_INVOKE_TOOL_RUNTIME,
  RESIN_NATIVE_RUNTIMES,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  type WorkflowCallCandidate,
  type WorkflowCallCarrier,
  type WorkflowCallHeldOut,
} from "./workflow-carrier.js";

export {
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_INVOKE_TOOL_RUNTIME,
  RESIN_NATIVE_RUNTIMES,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_DIALECT_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  type WorkflowDialectUpgrade,
  applyWorkflowDialectUpgrades,
  readWorkflowCallCarrier,
  readWorkflowDialectUpgrade,
  readWorkflowResultCarrier,
} from "./workflow-carrier.js";

/**
 * The order this process recorded calls in: `epoch` names the process, `index` increases with every
 * recorded call. Kept only in each call's local order slot, so a validator can tell whether the calls a
 * plan names ran in the order it claims; calls from different epochs have no recorded order.
 */
const RECORDING_EPOCH = randomUUID();
let recordingIndex = 0;

export type {
  DiscoveredCallable,
  WorkflowCallCandidate,
  WorkflowCallCarrier,
  WorkflowCallHeldOut,
} from "./workflow-carrier.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_DIALECT_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  type WorkflowDialectUpgrade,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./workflow-carrier.js";

function withoutLocalSourceInterface(event: NormalizedSessionEvent): NormalizedSessionEvent {
  if (!Object.hasOwn(event.metadata ?? {}, RESIN_LOCAL_SOURCE_INTERFACE_KEY)) return event;
  const metadata = { ...event.metadata };
  delete metadata[RESIN_LOCAL_SOURCE_INTERFACE_KEY];
  return { ...event, metadata };
}

/**
 * The shell interfaces whose command argument may leave as a scrubbed program view, each proven by
 * its decoder's local-only source-interface marker rather than by a tool name another server could
 * also use.
 */
/** Result markers by which a decoder proves its shell call ran in the foreground and exited 0. */
const SHELL_EXITED_ZERO: Readonly<Record<string, true>> = {
  "omp-bash-completed": true,
  "shell-exited-0": true,
};

const KNOWN_SHELL_COMMANDS: readonly {
  argument: string;
  /**
   * The dialect the harness's own tool runs its command in, as the tool itself establishes it;
   * `unproven` when the tool's shell is known only up to its family (Claude Code's `PowerShell`
   * runs `pwsh` when installed, else Windows PowerShell 5.1). Absent keeps the record's original
   * POSIX reading (a Codex command run in the session's own shell).
   */
  dialect?: ShellDialect | "unproven";
  /**
   * Arguments that only label the call for the user (`description`): the shell never reads them,
   * so they are not part of what the step does, and a label the model reworded each run would
   * otherwise be a pinned value no two recordings share.
   */
  labels?: readonly string[];
  proves: (event: Extract<NormalizedSessionEvent, { type: "tool_call" }>) => boolean;
}[] = [
  {
    argument: "cmd",
    dialect: "bash",
    proves: (event) =>
      event.toolName === "exec" && readCodexCommandMetadata(event.metadata)?.kind === "call",
  },
  {
    // Codex's direct terminal tool; the decoder marks only its own native call, never an MCP tool.
    argument: "cmd",
    proves: (event) => {
      const native = event.metadata?.codexNative;
      return (
        event.toolName === "exec_command" &&
        event.connection === undefined &&
        typeof native === "object" &&
        native !== null &&
        "sourceInterface" in native &&
        native.sourceInterface === "codex-exec-command"
      );
    },
  },
  {
    // Codex's string shell tool, run in the session's shell; the decoder marks only its own call.
    argument: "command",
    proves: (event) => {
      const native = event.metadata?.codexNative;
      return (
        event.toolName === "shell_command" &&
        event.connection === undefined &&
        typeof native === "object" &&
        native !== null &&
        "sourceInterface" in native &&
        native.sourceInterface === "codex-shell-command"
      );
    },
  },
  {
    argument: "command",
    dialect: "bash",
    proves: (event) =>
      event.toolName === "bash" &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "omp-bash",
  },
  {
    // Claude Code's `Bash` runs bash (Git Bash on native Windows).
    argument: "command",
    labels: ["description"],
    dialect: "bash",
    proves: (event) =>
      event.toolName === "Bash" &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "claude-bash",
  },
  {
    argument: "command",
    labels: ["description"],
    dialect: "unproven",
    proves: (event) =>
      event.toolName === "PowerShell" &&
      event.connection === undefined &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "claude-powershell",
  },
  {
    argument: "command",
    labels: ["description"],
    dialect: "bash",
    proves: (event) =>
      event.toolName === "bash" &&
      event.connection === undefined &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "opencode-bash",
  },
  {
    argument: "command",
    dialect: "sh-or-zsh",
    proves: (event) =>
      (event.toolName === "Shell" || event.toolName === "run_terminal_cmd") &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "cursor-shell",
  },
  {
    argument: "command",
    labels: ["description"],
    dialect: "bash",
    proves: (event) =>
      event.toolName === "bash" &&
      event.connection === undefined &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "copilot-bash",
  },
  {
    argument: "command",
    dialect: "bash",
    proves: (event) =>
      event.toolName === "bash" &&
      event.connection === undefined &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "pi-bash",
  },
  {
    argument: "command",
    labels: ["description"],
    dialect: "sh-or-zsh",
    proves: (event) =>
      event.toolName === "run_terminal_command" &&
      event.connection === undefined &&
      event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "grok-shell",
  },
];

/**
 * The dialect fields a shell program recorded from this call carries: the dialect its harness tool
 * proves, `unprovenDialect` when the decoder saw the shell only up to its family (a Codex command on
 * Windows, Claude Code's `PowerShell`), or nothing — the record's original POSIX reading.
 */
function recordedDialectOf(
  event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
  argument: string | undefined,
): Pick<WorkflowRecordedProgram, "dialect" | "unprovenDialect"> {
  if (event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "codex-unproven-shell") {
    return { unprovenDialect: true };
  }
  const known = KNOWN_SHELL_COMMANDS.find(
    (shell) => shell.argument === argument && shell.proves(event),
  )?.dialect;
  return known === undefined
    ? {}
    : known === "unproven"
      ? { unprovenDialect: true }
      : { dialect: known };
}

/** One observed call kept locally: its real values never leave this machine. */
interface LocalCall {
  callId: string;
  toolName: string;
  connection?: string;
  position: number;
  arguments: Record<string, WorkflowJsonValue>;
  argumentReferences: Record<string, string>;
  result?: WorkflowJsonValue;
  resultHandle?: string;
  resultReference?: string;
  resultComparison?: "text-trim";
  reads?: string[];
  writes?: string[];
  /**
   * The program this call ran: the language its record established and the argument whose text
   * holds it. Kept so the derivation can read the text as the program it is rather than as one
   * opaque argument.
   */
  program?: {
    kind: WorkflowRecordedProgram["kind"];
    argument: string;
    sourceInterface?: "python-eval" | "javascript-eval" | "codex-exec";
    dialect?: ShellDialect;
    unprovenDialect?: true;
  };
  /**
   * A harness's built-in shell call its decoder proved; its exit status is 0 when its decoder marks
   * the result as a foreground run that exited 0.
   */
  provenShell?: true;
  /** The Codex thread the call was made in, which its end event must share to prove its dialect. */
  codexThread?: string;
  /**
   * For a program recorded with an unproven dialect: the first completion's evidence, or `null` once
   * completions disagreed (never proven again), and the dialect the evidence proved.
   */
  dialectEvidence?: string | null;
  provenDialect?: "powershell" | "pwsh" | "cmd";
  /** The execution this call belongs to, so two executions of one session can be told apart. */
  executionIndex: number;
  /** This call's place among its execution's calls: the position a repeat of it is listed under. */
  executionPosition: number;
}

/** One execution of a session: the calls one task made, in order. */
interface LocalExecution {
  index: number;
  calls: LocalCall[];
  /** The demonstration this execution is, accumulated as its calls and results arrive. */
  accumulatedHeldOut?: WorkflowCallHeldOut;
  /**
   * The demonstration this execution is, once it has been seen to repeat an earlier one. Values are
   * stored as they are observed, so a replay has what the repeat actually produced.
   */
  heldOut?: WorkflowCallHeldOut;
  /** Words of the instruction that started this execution: the values its request named. */
  requestWords: ReadonlySet<string>;
  /** Input names already proposed for this execution's values, so a later derivation keeps them. */
  inputNames?: ReadonlyMap<string, string>;
}

/** Executions kept per session: enough to recognise a repeat, bounded so a long session cannot grow. */
const MAX_EXECUTIONS = 8;

/** Per-session derivation state, bounded so a long session cannot grow without limit. */
interface SessionDerivationState {
  turnKey: string;
  position: number;
  /** The current execution, which is the last one seen. */
  executions: LocalExecution[];
  /**
   * A new instruction arrived, so the next call begins a new piece of work. A task boundary is what
   * a person means by "and then I asked for it again"; it is the only boundary a harness reports
   * uniformly, and the turn index a transcript may carry is not set by every decoder.
   */
  newExecutionPending: boolean;
  /** Words of the instructions since the last call, which the next execution was asked with. */
  pendingRequestWords: Set<string>;
  nativeOutputs: Map<string, { stdout: string; exitCode: number }>;
  /**
   * Audited single-command wrappers still awaiting their result. Such a result may still claim a
   * command that completes now, so that command cannot be recorded as an independent execution.
   */
  openCodexWrappers: Set<string>;
  /** Wrapper tracking exceeded its bound; claims can no longer be ruled out in this session. */
  codexWrapperOverflow: boolean;
}

/** Observed calls kept per session for derivation. */
const MAX_LOCAL_CALLS = 64;
/** Sessions retained before the least recently used is dropped. */
const MAX_SESSIONS = 16;

function isPlainObject(value: unknown): value is Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Instruction words kept for one execution; the latest are kept, as the request comes last. */
const MAX_REQUEST_WORDS = 256;

/** Adds an instruction's words, keeping only the most recent when the bound is reached. */
function addRequestWords(words: Set<string>, content: string): void {
  const add = (word: string): void => {
    words.delete(word);
    words.add(word);
    if (words.size > MAX_REQUEST_WORDS) words.delete(words.values().next().value!);
  };
  for (const match of content.matchAll(/[A-Za-z0-9][A-Za-z0-9_.:@+-]*/g)) {
    const word = match[0].replace(/[.:]+$/, "");
    if (word.length < 2 || word.length > 64) continue;
    add(word);
    // An ordinal names its number: `the 12th day` runs with `12`.
    const ordinal = /^(\d+)(?:st|nd|rd|th)$/i.exec(word);
    if (ordinal) add(ordinal[1]!);
  }
}
/**
 * The reference-aware invocation surface, however the harness spelled it: bare
 * `invoke_tool`/`sys_invoke_tool`, or an MCP-prefixed `mcp__<server>__invoke_tool`.
 */
function isInvokeToolCallName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "invoke_tool" || value === "sys_invoke_tool") return true;
  return value.endsWith("__invoke_tool") && value.startsWith("mcp__");
}

export interface WorkflowCallRecorderOptions {
  /** The local store private leaves are written to; defaults to the daemon's store. */
  privateValues?: PrivateValueStore;
  /** Paired cloud workspace that owns captured private values; local session workspace otherwise. */
  privateValueOwnerWorkspaceId?: string;
}

export class WorkflowCallRecorder {
  private readonly privateValues: PrivateValueStore;
  private readonly privateValueOwnerWorkspaceId: string | undefined;
  /** The workspace owner stamped on every private entry for the current observation. */
  private observeAccess: PrivateValueOrigin | undefined;
  private privateRepresentation: "literal" | "redacted" = "redacted";
  /**
   * What each session's discovery events reported about the callables it saw, keyed by the name the
   * harness called them by and then by the connection that reported it. Discovery is per session
   * because a connection is: two sessions, or two workspaces, may reach the same tool name over
   * different servers, and one session's discovery must never supply the other's connection. Two
   * connections of one session may expose the same name — that is ordinary for MCP — so what each
   * of them reported is kept apart, and a report that carries less than an earlier one for the same
   * connection (a device surface names the connection and nothing else) is merged into it.
   */
  private readonly discovered = new Map<string, Map<string, Map<string, DiscoveredCallable>>>();
  /**
   * Per-session derivation state: the observed calls whose values must stay here for the
   * conclusions that need them. Bounded per session and by session count.
   */
  private readonly sessions = new Map<string, SessionDerivationState>();

  constructor(options: WorkflowCallRecorderOptions = {}) {
    this.privateValues = options.privateValues ?? FilePrivateValueStore.default();
    this.privateValueOwnerWorkspaceId = options.privateValueOwnerWorkspaceId;
  }

  /** Drops per-session state; the coordinator calls this between sessions. */
  clear(): void {
    this.discovered.clear();
    this.sessions.clear();
    this.observeAccess = undefined;
  }

  /** The state of one session, evicting the least recently touched when the bound is reached. */
  private sessionState(sessionId: string): SessionDerivationState {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      // Re-insert so iteration order keeps the most recently used session last.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }
    const created: SessionDerivationState = {
      turnKey: "",
      position: 0,
      executions: [],
      nativeOutputs: new Map(),
      openCodexWrappers: new Set(),
      codexWrapperOverflow: false,
      newExecutionPending: false,
      pendingRequestWords: new Set(),
    };
    this.sessions.set(sessionId, created);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
    return created;
  }

  /**
   * What one session's discovery reported about a callable; nothing is taken from another session.
   *
   * A call that resolved its own connection asks for what that connection reported: that report is
   * the callable's own statement, and a same-named entry reported by another connection is not it.
   * A call that established no connection takes the name's own report — the most recently reported
   * one, which is all the record establishes.
   */
  private discoveredCallable(
    sessionId: string,
    toolName: string,
    connection?: string,
  ): DiscoveredCallable | undefined {
    const byName = this.discovered.get(sessionId)?.get(toolName);
    if (byName === undefined) return undefined;
    if (connection !== undefined) {
      return byName.get(connection);
    }
    let latest: DiscoveredCallable | undefined;
    for (const reported of byName.values()) latest = reported;
    return latest;
  }

  /** One session's discovery state, evicting the least recently created when the bound is reached. */
  private discoveryState(sessionId: string): Map<string, Map<string, DiscoveredCallable>> {
    const existing = this.discovered.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Map<string, Map<string, DiscoveredCallable>>();
    this.discovered.set(sessionId, created);
    while (this.discovered.size > MAX_SESSIONS) {
      const oldest = this.discovered.keys().next();
      if (oldest.done === true) break;
      this.discovered.delete(oldest.value);
    }
    return created;
  }

  observe(
    event: NormalizedSessionEvent,
    /**
     * The local workspace the observed session belongs to. Unpaired capture stamps private entries
     * with it; paired capture uses the recorder's cloud workspace owner instead.
     */
    access?: PrivateValueOrigin,
  ): NormalizedSessionEvent {
    // A shadow result restates a result its call already has (Codex 0.135–0.140 records a direct MCP
    // call's result twice): it is no observation of its own.
    if (event.type === "tool_result" && event.isShadow === true) return event;
    this.observeAccess = this.privateValueOwnerWorkspaceId
      ? { workspaceId: this.privateValueOwnerWorkspaceId }
      : access;
    if (event.type === "tool_result" && isLocalWorkflowResultSuppressed(event)) {
      retainLocalWorkflowPayload(event, { result: event.result }, { suppressResult: true });
    }
    const original = localWorkflowEvent(event);
    this.privateRepresentation =
      original !== undefined || event.redaction?.isRedacted === false ? "literal" : "redacted";
    if (event.type === "tool_discovery") {
      const session = this.discoveryState(event.sessionId);
      for (const tool of event.tools) {
        let byConnection = session.get(tool.name);
        if (byConnection === undefined) {
          byConnection = new Map<string, DiscoveredCallable>();
          session.set(tool.name, byConnection);
        }
        // A report that carried no connection is filed under the name itself, so a session whose
        // harness reports a bare tool list still supplies what it established.
        const key = tool.provider ?? "";
        const previous = byConnection.get(key);
        // Merge: a later report for the same connection that carries less than an earlier one — a
        // device surface names the connection and nothing else — does not drop what was established.
        const recorded: DiscoveredCallable = { ...previous };
        if (tool.provider !== undefined) recorded.provider = tool.provider;
        if (tool.inputSchema !== undefined) {
          recorded.inputSchema = tool.inputSchema as WorkflowJsonValue;
        }
        // Re-insert so the most recently reported entry for a name is the last one seen.
        byConnection.delete(key);
        byConnection.set(key, recorded);
      }
      return event;
    }
    if (event.type === "message" && event.role === "user") {
      // The instruction that starts a piece of work. Nothing else in a transcript separates one
      // piece of work from the next often enough to rely on.
      const state = this.sessionState(event.sessionId);
      if (!state.newExecutionPending) state.pendingRequestWords = new Set();
      addRequestWords(state.pendingRequestWords, event.content);
      state.newExecutionPending = true;
      return event;
    }
    if (event.type === "command_exec") {
      const command = readCodexCommandMetadata(event.metadata);
      if (command?.kind !== "command") return event;
      const raw = localWorkflowEvent(event);
      if (
        raw?.type !== "command_exec" ||
        typeof raw.stdout !== "string" ||
        !Number.isInteger(raw.exitCode)
      )
        return event;
      const state = this.sessionState(event.sessionId);
      state.nativeOutputs.set(command.nativeId, { stdout: raw.stdout, exitCode: raw.exitCode });
      while (state.nativeOutputs.size > MAX_LOCAL_CALLS) {
        const oldest = state.nativeOutputs.keys().next();
        if (oldest.done) break;
        state.nativeOutputs.delete(oldest.value);
      }
      const association = command.association;
      // The end event of a Codex shell tool call already recorded under the same call id is not a
      // call of its own: it can only prove the dialect that call ran in.
      const recordedCall =
        association === undefined ? codexShellToolCall(state, command.nativeId) : undefined;
      if (recordedCall !== undefined) return this.proveCallDialect(event, raw, state, recordedCall);
      if (association === undefined) {
        if (state.codexWrapperOverflow || state.openCodexWrappers.size > 0) return event;
        const argv = raw.command === "/bin/bash" ? raw.args : undefined;
        // The executable Codex recorded running proves the dialect: `/bin/bash -lc`, or on Windows
        // `powershell.exe`/`pwsh.exe … -Command` and `cmd.exe /c` (see `windowsShellInvocation`).
        const windows =
          typeof raw.command === "string" && Array.isArray(raw.args)
            ? windowsShellInvocation(raw.command, raw.args)
            : undefined;
        const script =
          windows?.program ??
          (argv?.length === 2 && argv[0] === "-lc" && typeof argv[1] === "string"
            ? argv[1]
            : undefined);
        if (script === undefined || typeof raw.cwd !== "string") return event;
        // Codex records the working directory as a file URL; execution needs the path it names.
        let workdir: string;
        try {
          workdir = raw.cwd.startsWith("file:") ? recordedFileUrlPath(raw.cwd) : raw.cwd;
        } catch {
          return event;
        }
        const callId = command.nativeId;
        const parameters = {
          cmd: script,
          workdir,
          resinCodexShellProfile:
            windows === undefined ? "bash-login-native-v1" : `${windows.dialect}-native-v1`,
        };
        const program: WorkflowRecordedProgram = {
          kind: "shell",
          source: "",
          argument: "cmd",
          dialect: windows?.dialect ?? "bash",
        };
        const origins: WorkflowCallCarrier["origins"] = {};
        const provenance: Record<string, WorkflowArgumentProvenance> = {};
        for (const [argument, value] of Object.entries(parameters)) {
          origins[argument] = publicShellProfile(argument, value)
            ? { type: "literal", value }
            : this.launderOrigin({ type: "literal", value }, event.sessionId, callId, [argument]);
          provenance[argument] = { standing: "derived", rule: "single-observation" };
        }
        this.projectProgramSource(event, parameters, program, origins, true);
        // The session state above also retains native output for guarded outer results.
        let call: LocalCall | undefined;
        for (let index = state.executions.length - 1; index >= 0 && call === undefined; index--) {
          call = state.executions[index]!.calls.find(
            (entry) => entry.callId === callId && entry.toolName === "command_exec",
          );
        }
        if (call === undefined) {
          call = this.recordLocalCall(
            state,
            { sessionId: event.sessionId, callId, toolName: "command_exec" },
            parameters,
            program,
            origins,
            undefined,
            true,
          );
        }
        const carrier: WorkflowCallCarrier = {
          runtime: RESIN_PROCESS_RUNTIME,
          name: "command_exec",
          origins,
          inputs: [],
          provenance,
          program,
          executionIndex: call.executionIndex,
          executionPosition: call.executionPosition,
          baselineInputs: { ...call.argumentReferences },
        };
        const heldOut = this.heldOutSoFar(state, call);
        if (heldOut !== undefined && heldOut.inputs.length > 0) carrier.heldOut = heldOut;
        const relationships = this.relateLocalCall(state, call, event.sessionId);
        if (relationships.dependsOnCallIds.length > 0)
          carrier.dependsOnCallIds = relationships.dependsOnCallIds;
        const candidates = unprotectedCandidates(
          event,
          parameters,
          relationships.candidates,
          program,
          origins,
        );
        if (candidates.length > 0) carrier.candidates = candidates;
        const succeeded = raw.exitCode === 0;
        this.localResultReference(
          raw.exitCode,
          event.sessionId,
          callId,
          WORKFLOW_CALL_EXIT_CODE_SLOT,
        );
        const reference = succeeded
          ? this.localResultReference(raw.stdout, event.sessionId, callId, "native-result:v1:exact")
          : undefined;
        this.recordResultRedaction(
          event.sessionId,
          callId,
          event.type === "command_exec" ? event.stdout : undefined,
        );
        if (this.isResultConflicted(event.sessionId, callId)) {
          this.revokeResultBaseline(state, call);
        } else {
          call.result = raw.stdout;
          call.resultReference = reference;
          call.resultComparison = undefined;
        }
        if (call.resultReference !== undefined && state.executions.length > 0) {
          const execution = state.executions.find((entry) => entry.index === call!.executionIndex);
          if (execution?.accumulatedHeldOut !== undefined) {
            execution.accumulatedHeldOut.observed = [
              ...execution.accumulatedHeldOut.observed.filter(
                (entry) => entry.position !== call!.position,
              ),
              { position: call.position, reference: call.resultReference },
            ];
          }
        }
        const demonstration = this.demonstrationCarrier(event.sessionId, callId);
        const result = {
          ...(succeeded && call.resultReference !== undefined
            ? { baselineReference: call.resultReference }
            : {}),
          output: { type: "string" as const, hasContent: raw.stdout.length > 0 },
          ...(demonstration === undefined ? {} : { heldOut: demonstration }),
        };
        return {
          ...event,
          metadata: {
            ...event.metadata,
            [RESIN_WORKFLOW_CALL_METADATA_KEY]: carrier,
            [RESIN_WORKFLOW_RESULT_METADATA_KEY]: result,
          },
        };
      }
      if (association.nativeCommandId !== command.nativeId) return event;
      const reference =
        raw.exitCode === 0
          ? this.localResultReference(
              raw.stdout,
              event.sessionId,
              association.callId,
              "native-result:v1:text-trim",
            )
          : undefined;
      if (reference !== undefined) {
        this.recordResultRedaction(
          event.sessionId,
          association.callId,
          event.type === "command_exec" ? event.stdout : undefined,
        );
      }
      return {
        ...event,
        metadata: {
          ...event.metadata,
          [RESIN_WORKFLOW_RESULT_METADATA_KEY]: {
            ...(reference === undefined
              ? {}
              : {
                  baselineReference: reference,
                  baselineComparison: "text-trim",
                }),
            output: { type: "string", hasContent: raw.stdout.length > 0 },
          },
        },
      };
    }
    if (event.type === "file_edit") return this.observeCodexFileEdit(event);
    if (event.type === "tool_call") {
      // The cell's edits arrive as Codex-native file edits, and a carrier cell's commands as native
      // command items; those, not the cell, are the calls.
      const cellKind =
        event.toolName === "exec" ? readCodexCommandMetadata(event.metadata)?.kind : undefined;
      if (cellKind === "patch-call" || cellKind === "carrier-call") return event;
      if (cellKind === "call") {
        const state = this.sessionState(event.sessionId);
        if (state.openCodexWrappers.size >= MAX_LOCAL_CALLS) state.codexWrapperOverflow = true;
        else state.openCodexWrappers.add(event.callId);
      }
      return this.observeCall(event);
    }
    if (event.type === "tool_result") {
      this.sessions.get(event.sessionId)?.openCodexWrappers.delete(event.callId);
      const source = original ?? event;
      const codex =
        source.type === "tool_result" && source.toolName === "exec"
          ? readCodexCommandMetadata(source.metadata)
          : undefined;
      const native =
        codex?.kind === "result" && codex.association !== undefined
          ? this.sessionState(event.sessionId).nativeOutputs.get(codex.association.nativeCommandId)
          : undefined;
      const codexObservation =
        codex?.kind === "result" &&
        codex.form === "single-command-output" &&
        codex.status === "completed" &&
        native !== undefined
          ? { result: native.stdout, comparison: "text-trim" as const }
          : undefined;
      const resultObservation =
        codex?.kind === "result" ? codexObservation : localWorkflowResultObservation(event);
      const suppressResult =
        isLocalWorkflowResultSuppressed(event) ||
        (codex?.kind === "result" &&
          (codex.status !== "completed" || native === undefined || native.exitCode !== 0));
      const observed = this.observeResult(
        source,
        event,
        resultObservation,
        suppressResult,
        codex?.kind === "result" ? native?.exitCode : undefined,
      );
      // The cell completed, but the command it ran failed: the step failed.
      const resultEvent = withoutLocalSourceInterface(
        codex?.kind === "result" && native !== undefined && native.exitCode !== 0
          ? { ...event, isError: true, metadata: observed.metadata }
          : { ...event, metadata: observed.metadata },
      );
      if (suppressResult) {
        retainLocalWorkflowPayload(resultEvent, { result: event.result }, { suppressResult: true });
      } else if (resultObservation !== undefined) {
        retainLocalWorkflowPayload(resultEvent, { result: event.result }, { resultObservation });
      }
      return resultEvent;
    }
    return event;
  }

  /**
   * A native file edit (a Codex `FileChange` item or a Claude Code `Edit`/`Write` result) becomes a patch step: the recorded diff, applied again in the directory
   * the session worked in. The diff is file content, so it is stored privately and never projected,
   * not even redacted; only its added lines' values are offered, and none when the redaction engine
   * would change the diff. An edit outside the working directory, or without one, is not a step.
   */
  private observeCodexFileEdit(
    event: Extract<NormalizedSessionEvent, { type: "file_edit" }>,
  ): NormalizedSessionEvent {
    const native = readCodexCommandMetadata(event.metadata);
    if (native?.kind !== "file-change") return event;
    const raw = localWorkflowEvent(event);
    if (raw?.type !== "file_edit" || typeof raw.patch !== "string") return event;
    // Codex records the edit's working directory with the rollout; Claude with each transcript record.
    const recorded = event.metadata?.codexNative ?? event.metadata?.claudeNative;
    const recordedCwd =
      isPlainObject(recorded) && typeof recorded.cwd === "string" ? recorded.cwd : undefined;
    let workdir: string;
    try {
      workdir =
        recordedCwd === undefined
          ? ""
          : recordedCwd.startsWith("file:")
            ? recordedFileUrlPath(recordedCwd)
            : recordedCwd;
    } catch {
      return event;
    }
    if (!isAbsolute(workdir) || !isAbsolute(raw.filePath)) return event;
    const inside = relative(resolve(workdir), resolve(raw.filePath));
    if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) return event;
    try {
      tokenizeProgram("patch", raw.patch);
    } catch {
      return event;
    }
    const state = this.sessionState(event.sessionId);
    const callId = native.nativeId;
    const parameters = { patch: raw.patch, workdir };
    const program: WorkflowRecordedProgram = { kind: "patch", source: "", argument: "patch" };
    const origins: WorkflowCallCarrier["origins"] = {};
    const provenance: Record<string, WorkflowArgumentProvenance> = {};
    for (const [argument, value] of Object.entries(parameters)) {
      origins[argument] = this.launderOrigin({ type: "literal", value }, event.sessionId, callId, [
        argument,
      ]);
      provenance[argument] = { standing: "derived", rule: "single-observation" };
    }
    const privateSource = origins.patch;
    if (privateSource?.type !== "private") return event;
    origins.patch = { type: "program", language: "patch", source: privateSource, holes: [] };
    let call: LocalCall | undefined;
    for (let index = state.executions.length - 1; index >= 0 && call === undefined; index--) {
      call = state.executions[index]!.calls.find(
        (entry) => entry.callId === callId && entry.toolName === "apply_patch",
      );
    }
    call ??= this.recordLocalCall(
      state,
      { sessionId: event.sessionId, callId, toolName: "apply_patch" },
      parameters,
      program,
      origins,
    );
    const carrier: WorkflowCallCarrier = {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "apply_patch",
      origins,
      inputs: [],
      provenance,
      program,
      executionIndex: call.executionIndex,
      executionPosition: call.executionPosition,
      baselineInputs: { ...call.argumentReferences },
    };
    const heldOut = this.heldOutSoFar(state, call);
    if (heldOut !== undefined && heldOut.inputs.length > 0) carrier.heldOut = heldOut;
    const relationships = this.relateLocalCall(state, call, event.sessionId);
    if (relationships.dependsOnCallIds.length > 0)
      carrier.dependsOnCallIds = relationships.dependsOnCallIds;
    // The diff names its files by absolute path, so the scan reads them relative to the working
    // directory: where the project lives must not decide which values are offered.
    const root = resolve(workdir);
    const scrubbed = redactLocalWorkflowProgramSource(
      event,
      raw.patch.replaceAll(root.endsWith(sep) ? root : `${root}${sep}`, ""),
    );
    const candidates = scrubbed === undefined || scrubbed.changed ? [] : relationships.candidates;
    if (candidates.length > 0) carrier.candidates = candidates;
    call.result = WORKFLOW_PATCH_STEP_RESULT;
    call.resultReference = this.localReference(
      WORKFLOW_PATCH_STEP_RESULT,
      event.sessionId,
      callId,
      "native-result:v1:exact",
    );
    this.recordResultRedaction(event.sessionId, callId, WORKFLOW_PATCH_STEP_RESULT);
    call.resultComparison = undefined;
    const execution = state.executions.find((entry) => entry.index === call.executionIndex);
    if (execution?.accumulatedHeldOut !== undefined) {
      execution.accumulatedHeldOut.observed = [
        ...execution.accumulatedHeldOut.observed.filter(
          (entry) => entry.position !== call.position,
        ),
        { position: call.position, reference: call.resultReference },
      ];
    }
    const demonstration = this.demonstrationCarrier(event.sessionId, callId);
    return {
      ...event,
      metadata: {
        ...event.metadata,
        [RESIN_WORKFLOW_CALL_METADATA_KEY]: carrier,
        [RESIN_WORKFLOW_RESULT_METADATA_KEY]: {
          baselineReference: call.resultReference,
          output: { type: "string" as const, hasContent: true },
          ...(demonstration === undefined ? {} : { heldOut: demonstration }),
        },
      },
    };
  }

  /**
   * Replaces literal leaves that still carry a redaction placeholder, or that restate a value this
   * device recorded as private (an agent copying a recorded step's value into its call), with
   * `private:` references, writing the leaf to the local store so the executor can reconstruct the
   * original at invocation time.
   */
  private sweepOrigin(
    origin: AgentArgumentOrigin,
    sessionId: string,
    callId: string,
    path: WorkflowValuePath,
  ): AgentArgumentOrigin {
    switch (origin.type) {
      case "literal": {
        const expand = (
          value: WorkflowJsonValue,
          currentPath: WorkflowValuePath,
        ): AgentArgumentOrigin => {
          if (
            typeof value === "string" &&
            (containsRedactionPlaceholder(value) ||
              this.privateValues.holdsValue?.(value, this.observeAccess) === true)
          ) {
            return this.storeLocalValue(value, sessionId, callId, currentPath);
          }
          if (Array.isArray(value)) {
            return {
              type: "array",
              items: value.map((item, index) => expand(item, [...currentPath, index])),
            };
          }
          if (isPlainObject(value)) {
            const entries: Record<string, AgentArgumentOrigin> = {};
            for (const [key, entry] of Object.entries(value)) {
              entries[key] = expand(entry, [...currentPath, key]);
            }
            return { type: "object", entries };
          }
          return { type: "literal", value };
        };
        return expand(origin.value, path);
      }
      case "object": {
        const entries: Record<string, AgentArgumentOrigin> = {};
        for (const [key, entry] of Object.entries(origin.entries)) {
          entries[key] = this.sweepOrigin(entry, sessionId, callId, [...path, key]);
        }
        return { type: "object", entries };
      }
      case "array":
        return {
          type: "array",
          items: origin.items.map((item, index) =>
            this.sweepOrigin(item, sessionId, callId, [...path, index]),
          ),
        };
      default:
        return origin;
    }
  }

  /**
   * Attaches the carrier the compiler consumes.
   *
   * Both surfaces are recorded the same way, and neither one changes what the caller wrote: a call
   * through the reference-aware invocation surface keeps the origins the caller itself stated, and
   * a call the model made with its ordinary tools is recorded from what the harness actually
   * dispatched — the callable it named, the arguments it passed, and the program the record shows
   * it ran. Nothing here asks the model to spell its calls differently.
   */
  private observeCall(event: NormalizedSessionEvent): NormalizedSessionEvent {
    if (event.type !== "tool_call") return event;
    if (isInvokeToolCallName(event.toolName)) {
      this.privateRepresentation = "redacted";
      return this.observeComposedCall(event);
    }
    const observed = this.observeNativeCall(localWorkflowEvent(event) ?? event, event);
    // Originals remain local; only references and an engine-scrubbed source view can leave.
    return { ...event, metadata: observed.metadata };
  }

  /** Records a call composed through the reference-aware surface, keeping the caller's envelopes. */
  private observeComposedCall(
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
  ): NormalizedSessionEvent {
    const parameters = event.parameters;
    if (!isPlainObject(parameters)) return event;
    const routedName =
      typeof parameters.toolName === "string"
        ? parameters.toolName
        : typeof parameters.name === "string"
          ? parameters.name
          : typeof parameters.tool_name === "string"
            ? parameters.tool_name
            : typeof parameters.toolId === "string"
              ? parameters.toolId
              : undefined;
    if (routedName === undefined) return event;
    const inner = parameters.parameters ?? parameters.arguments;
    const argumentsAtCall = isPlainObject(inner) ? inner : {};
    const state = this.sessionState(event.sessionId);
    // A delayed redelivery belongs to its original call, even after later executions.
    // Its input identities must not drift to the current execution's next position.
    let existing: LocalCall | undefined;
    for (let index = state.executions.length - 1; index >= 0 && !existing; index--) {
      existing = state.executions[index]!.calls.find((call) => call.callId === event.callId);
    }
    const position =
      existing?.position ??
      (state.executions.length === 0 || state.newExecutionPending ? 0 : state.position);
    // Input identity follows the selected workflow step, not a session-global call id.
    // Repeated executions have new call ids but the same logical positions.
    const nameInput = (argument: string, path: WorkflowValuePath): string =>
      `step${position}_${argument}${path.length === 0 ? "" : `.${path.map(String).join(".")}`}`;
    const analysis = analyzeAgentArguments(argumentsAtCall, { nameInput });
    const origins: Record<string, AgentArgumentOrigin> = {};
    const provenance: Record<string, WorkflowArgumentProvenance> = {};
    for (const [argument, origin] of Object.entries(analysis.origins)) {
      origins[argument] = this.sweepOrigin(origin, event.sessionId, event.callId, [argument]);
      provenance[argument] = { standing: "recorded", rule: "caller-stated" };
    }
    const carrier: WorkflowCallCarrier = {
      runtime: RESIN_INVOKE_TOOL_RUNTIME,
      name: routedName,
      origins,
      inputs: analysis.inputs.map((input) => ({
        name: input.name,
        argument: input.argument,
        path: input.path,
        type: input.type,
      })),
      provenance,
    };
    const discovered = this.discoveredCallable(event.sessionId, routedName, event.connection);
    // The connection is the resolution the call itself carries, or what this session's discovery
    // recorded for the callable. Nothing else: not the harness, never a guess from the name.
    const connection = event.connection ?? discovered?.provider;
    if (connection !== undefined) carrier.connection = connection;
    const actualArguments: Record<string, WorkflowJsonValue> = {};
    for (const [argument, envelope] of Object.entries(argumentsAtCall)) {
      try {
        const resolved = analyzeAgentArguments(
          { [argument]: envelope },
          {
            resolveReference: (reference, path) => {
              let producer: LocalCall | undefined;
              for (
                let index = state.executions.length - 1;
                index >= 0 && producer === undefined;
                index--
              ) {
                const calls = state.executions[index]!.calls;
                for (let position = calls.length - 1; position >= 0; position--) {
                  if (calls[position]!.resultHandle === reference) {
                    producer = calls[position];
                    break;
                  }
                }
              }
              if (producer?.result === undefined) throw new Error("unobserved reference");
              let value: WorkflowJsonValue = producer.result;
              for (const part of path) {
                if (typeof part === "number") {
                  if (
                    !Number.isInteger(part) ||
                    part < 0 ||
                    !Array.isArray(value) ||
                    part >= value.length
                  ) {
                    throw new Error("unobserved reference path");
                  }
                  value = value[part]!;
                } else {
                  if (!isPlainObject(value) || !Object.hasOwn(value, part)) {
                    throw new Error("unobserved reference path");
                  }
                  value = value[part]!;
                }
              }
              return value;
            },
          },
        ).resolved;
        if (resolved !== undefined) actualArguments[argument] = resolved[argument]!;
      } catch {
        // An unresolved reference supplies no demonstration or baseline value.
      }
    }
    // The positions this call's upload keeps private are the swept origins' private leaves. Each
    // one stands where the caller stated a literal, so its resolved argument leaf is the text the
    // upload withheld: a redaction placeholder marks a secret, anything else a restated value.
    const local =
      existing ??
      this.recordLocalCall(
        state,
        { ...event, toolName: routedName, parameters: actualArguments },
        actualArguments,
        undefined,
        origins,
        actualArguments,
      );
    carrier.executionIndex = local.executionIndex;
    carrier.executionPosition = local.executionPosition;
    carrier.baselineInputs = { ...local.argumentReferences };
    const heldOut = this.heldOutSoFar(state, local);
    if (heldOut !== undefined && heldOut.inputs.length > 0) carrier.heldOut = heldOut;
    return this.withCallCarrier(event, carrier);
  }

  /**
   * Proves the dialect of a Codex shell tool call recorded with an unproven one, from its end event:
   * the executable Codex recorded running it (`powershell.exe`, `pwsh.exe`, `cmd.exe`) with exactly
   * the call's program text, in the call's own thread. The call's program is then read in that
   * dialect's grammar — projected, derived and kept locally — and the end event carries the upgrade
   * for the recording to apply.
   *
   * Every completion is evidence. The call's recorded program stays unproven, and a completion that
   * disagrees with the first one (another executable or argv, another thread, other text, or one
   * that proves nothing) revokes the proof: locally, through a conflict slot the identity reader
   * honours, and publicly, through a conflict the recording applies. Nothing reinstates it.
   */
  private proveCallDialect(
    event: Extract<NormalizedSessionEvent, { type: "command_exec" }>,
    raw: { command?: unknown; args?: unknown },
    state: SessionDerivationState,
    call: LocalCall,
  ): NormalizedSessionEvent {
    const program = call.program;
    if (program?.kind !== "shell" || program.unprovenDialect !== true) return event;
    // A completion Codex derived from the tool output names no executable: it is no evidence.
    if (!Array.isArray(raw.args) || raw.args.length === 0) return event;
    const text = call.arguments[program.argument];
    const proven =
      typeof raw.command === "string" ? windowsShellInvocation(raw.command, raw.args) : undefined;
    const thread = codexThreadOf(event);
    const proves =
      proven !== undefined &&
      typeof text === "string" &&
      proven.program === text &&
      thread !== undefined &&
      thread === call.codexThread;
    const evidence = JSON.stringify([raw.command ?? null, raw.args, thread ?? null, proves]);
    if (call.dialectEvidence === evidence) return event;
    if (call.dialectEvidence !== undefined || !proves) {
      // A second, disagreeing completion, or a first that proves nothing: never proven again.
      call.dialectEvidence = null;
      call.provenDialect = undefined;
      this.localReference(true, event.sessionId, call.callId, WORKFLOW_CALL_DIALECT_CONFLICT_SLOT);
      return this.withDialectUpgrade(event, {
        callId: call.callId,
        argument: program.argument,
        conflict: true,
      });
    }
    call.dialectEvidence = evidence;
    call.provenDialect = proven.dialect;
    this.localReference(proven.dialect, event.sessionId, call.callId, WORKFLOW_CALL_DIALECT_SLOT);
    const recorded: WorkflowRecordedProgram = {
      kind: "shell",
      source: "",
      argument: program.argument,
      dialect: proven.dialect,
    };
    // The same private leaf the call's own carrier holds for its program text.
    const origins: WorkflowCallCarrier["origins"] = {
      [program.argument]: this.storeLocalValue(text, event.sessionId, call.callId, [
        program.argument,
      ]),
    };
    this.projectProgramSource(event, call.arguments, recorded, origins, call.provenShell === true);
    const relationships = this.relateLocalCall(state, call, event.sessionId);
    const candidates = unprotectedCandidates(
      event,
      call.arguments,
      relationships.candidates,
      recorded,
      origins,
    );
    const origin = origins[program.argument];
    return this.withDialectUpgrade(event, {
      callId: call.callId,
      argument: program.argument,
      dialect: proven.dialect,
      ...(origin?.type === "program" ? { source: recorded.source, origin } : {}),
      ...(candidates.length === 0 ? {} : { candidates }),
    });
  }

  private withDialectUpgrade(
    event: Extract<NormalizedSessionEvent, { type: "command_exec" }>,
    upgrade: WorkflowDialectUpgrade,
  ): NormalizedSessionEvent {
    return {
      ...event,
      metadata: { ...event.metadata, [RESIN_WORKFLOW_DIALECT_METADATA_KEY]: upgrade },
    };
  }

  /**
   * Records a call the model made with an ordinary tool.
   *
   * Ordinary argument values and the complete executable program stay on this machine behind
   * local references. A program may additionally expose a parser-aligned, secret-redacted source
   * view produced by the normalization engine; that view is never the executable source.
   *
   * Those conclusions need the values, so they are reached here, on the pre-privacy record, and
   * travel as conclusions: the calls this one must follow because of declared resource use, and the
   * bindings the values only suggest, each naming the fact this recording does not establish.
   */
  private observeNativeCall(
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
    normalizedEvent: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
  ): NormalizedSessionEvent {
    // Optional arguments omitted by a producer have no JSON value to reference locally.
    const rawParameters = isPlainObject(event.parameters) ? event.parameters : {};
    let observedParameters = rawParameters;
    for (const argument in rawParameters) {
      if (!Object.hasOwn(rawParameters, argument) || rawParameters[argument] !== undefined)
        continue;
      if (observedParameters === rawParameters) observedParameters = { ...rawParameters };
      delete observedParameters[argument];
    }
    for (const label of KNOWN_SHELL_COMMANDS.find((shell) => shell.proves(event))?.labels ?? []) {
      if (!Object.hasOwn(observedParameters, label)) continue;
      if (observedParameters === rawParameters) observedParameters = { ...rawParameters };
      delete observedParameters[label];
    }
    const codex = event.toolName === "exec" ? readCodexCommandMetadata(event.metadata) : undefined;
    const parameters =
      codex?.kind === "call" && typeof observedParameters.cmd === "string"
        ? { ...observedParameters, resinCodexShellProfile: "bash-login-v1" }
        : observedParameters;
    const program = this.programOf(event, parameters);
    const origins: WorkflowCallCarrier["origins"] = {};
    const provenance: Record<string, WorkflowArgumentProvenance> = {};
    // Ordinary native JSON is data, not the explicit composition interface.
    for (const [argument, value] of Object.entries(parameters)) {
      origins[argument] = publicShellProfile(argument, value)
        ? { type: "literal", value }
        : this.launderOrigin({ type: "literal", value }, event.sessionId, event.callId, [argument]);
      provenance[argument] = { standing: "derived", rule: "single-observation" };
    }
    if (program !== undefined) {
      const shellKnown = KNOWN_SHELL_COMMANDS.some(
        (shell) => shell.argument === program.argument && shell.proves(event),
      );
      this.projectProgramSource(normalizedEvent, parameters, program, origins, shellKnown);
    }
    const discovered = this.discoveredCallable(event.sessionId, event.toolName, event.connection);
    const connection = event.connection ?? discovered?.provider;
    const carrier: WorkflowCallCarrier = {
      runtime:
        program === undefined
          ? connection === undefined
            ? RESIN_HARNESS_TOOL_RUNTIME
            : RESIN_TOOL_PROTOCOL_RUNTIME
          : program.kind === "shell"
            ? RESIN_PROCESS_RUNTIME
            : RESIN_PROGRAM_RUNTIME,
      name: event.toolName,
      origins,
      inputs: [],
      provenance,
    };
    if (program !== undefined) carrier.program = program;
    if (connection !== undefined) carrier.connection = connection;
    if (discovered?.inputSchema !== undefined) carrier.inputSchema = discovered.inputSchema;

    const state = this.sessionState(event.sessionId);
    const call = this.recordLocalCall(
      state,
      event,
      parameters,
      program,
      origins,
      isPlainObject(normalizedEvent.parameters) ? normalizedEvent.parameters : undefined,
      program !== undefined &&
        KNOWN_SHELL_COMMANDS.some(
          (shell) => shell.argument === program.argument && shell.proves(event),
        ),
    );
    const relationships = this.relateLocalCall(state, call, event.sessionId);
    carrier.executionIndex = call.executionIndex;
    carrier.executionPosition = call.executionPosition;
    carrier.baselineInputs = { ...call.argumentReferences };
    const heldOut = this.heldOutSoFar(state, call);
    if (heldOut !== undefined && heldOut.inputs.length > 0) carrier.heldOut = heldOut;
    if (relationships.dependsOnCallIds.length > 0) {
      carrier.dependsOnCallIds = relationships.dependsOnCallIds;
    }
    // The normalization engine's redactor is kept for the normalized record, not the local copy.
    const candidates = unprotectedCandidates(
      normalizedEvent,
      parameters,
      relationships.candidates,
      program,
      origins,
    );
    if (candidates.length > 0) carrier.candidates = candidates;
    return this.withCallCarrier(withoutLocalSourceInterface(event), carrier);
  }

  /**
   * Replaces every leaf of a recorded value with a local reference, so the value itself never leaves
   * this machine. A composite keeps its shape — which is what a workflow argument is made of — and
   * each leaf is stored locally, exactly as a private leaf already is.
   */
  private launderOrigin(
    origin: AgentArgumentOrigin,
    sessionId: string,
    callId: string,
    path: WorkflowValuePath,
  ): AgentArgumentOrigin {
    switch (origin.type) {
      case "literal": {
        const expand = (
          value: WorkflowJsonValue,
          currentPath: WorkflowValuePath,
        ): AgentArgumentOrigin => {
          if (Array.isArray(value)) {
            return {
              type: "array",
              items: value.map((item, index) => expand(item, [...currentPath, index])),
            };
          }
          if (isPlainObject(value)) {
            const entries: Record<string, AgentArgumentOrigin> = {};
            for (const [key, entry] of Object.entries(value)) {
              entries[key] = expand(entry, [...currentPath, key]);
            }
            return { type: "object", entries };
          }
          return this.storeLocalValue(value, sessionId, callId, currentPath);
        };
        return expand(origin.value, path);
      }
      case "object": {
        const entries: Record<string, AgentArgumentOrigin> = {};
        for (const [key, entry] of Object.entries(origin.entries)) {
          entries[key] = this.launderOrigin(entry, sessionId, callId, [...path, key]);
        }
        return { type: "object", entries };
      }
      case "array":
        return {
          type: "array",
          items: origin.items.map((item, index) =>
            this.launderOrigin(item, sessionId, callId, [...path, index]),
          ),
        };
      default:
        return origin;
    }
  }

  /**
   * Records whether a call's output, as its upload's redacted view carried it, had any secret
   * redacted. An output this path has no redacted view of counts as redacted.
   */
  private recordResultRedaction(sessionId: string, callId: string, uploadedOutput: unknown): void {
    this.localResultReference(
      uploadedOutput === undefined ||
        containsRedactionPlaceholder(
          typeof uploadedOutput === "string" ? uploadedOutput : JSON.stringify(uploadedOutput),
        ),
      sessionId,
      callId,
      WORKFLOW_CALL_RESULT_REDACTED_SLOT,
    );
  }

  /** Stores one value of a demonstration and returns the stable reference a replay resolves it by. */
  private localReference(
    value: WorkflowJsonValue,
    sessionId: string,
    callId: string,
    slot: string,
  ): string {
    const reference = workflowPrivateReference(
      "demonstration",
      this.observeAccess?.workspaceId,
      this.privateRepresentation,
      [sessionId, callId, slot],
    );
    this.privateValues.set(reference, value, this.observeAccess, this.privateRepresentation);
    return reference;
  }

  /**
   * Stores one value of a call's result (the result itself, whether its upload was redacted, its
   * exit status) and returns its reference. Private references are immutable: a value for a slot
   * that already holds a different one, from a second, different result for the same call, is never
   * written and never replaces the first. It marks the call's result conflicted instead, as the
   * dialect conflict slot does for a program, and capture carries on. Once the result is
   * conflicted nothing more is stored for it and undefined is returned.
   */
  private localResultReference(
    value: WorkflowJsonValue,
    sessionId: string,
    callId: string,
    slot: string,
  ): string | undefined {
    if (this.isResultConflicted(sessionId, callId)) return undefined;
    const reference = this.demonstrationReference(sessionId, callId, slot);
    const stored = this.privateValues.get(reference);
    if (
      stored !== undefined &&
      !isDeepStrictEqual(stored, JSON.parse(JSON.stringify(value)) as unknown)
    ) {
      this.localReference(true, sessionId, callId, WORKFLOW_CALL_RESULT_CONFLICT_SLOT);
      return undefined;
    }
    this.privateValues.set(reference, value, this.observeAccess, this.privateRepresentation);
    return reference;
  }

  /** Whether a call received two different results (see `localResultReference`). */
  private isResultConflicted(sessionId: string, callId: string): boolean {
    return (
      this.privateValues.get(
        this.demonstrationReference(sessionId, callId, WORKFLOW_CALL_RESULT_CONFLICT_SLOT),
      ) !== undefined
    );
  }

  /** A conflicted result is no baseline: the call's demonstration no longer observes it. */
  private revokeResultBaseline(state: SessionDerivationState, call: LocalCall): void {
    call.resultReference = undefined;
    call.resultComparison = undefined;
    const execution = state.executions.find((entry) => entry.index === call.executionIndex);
    if (execution?.accumulatedHeldOut !== undefined) {
      execution.accumulatedHeldOut.observed = execution.accumulatedHeldOut.observed.filter(
        (entry) => entry.position !== call.position,
      );
    }
  }

  private demonstrationReference(sessionId: string, callId: string, slot: string): string {
    return workflowPrivateReference(
      "demonstration",
      this.observeAccess?.workspaceId,
      this.privateRepresentation,
      [sessionId, callId, slot],
    );
  }

  private storeLocalValue(
    value: WorkflowJsonValue,
    sessionId: string,
    callId: string,
    path: WorkflowValuePath,
  ): AgentArgumentOrigin {
    const reference = workflowPrivateReference(
      "value",
      this.observeAccess?.workspaceId,
      this.privateRepresentation,
      [sessionId, callId, path],
    );
    this.privateValues.set(reference, value, this.observeAccess, this.privateRepresentation);
    return { type: "private", reference };
  }

  /** Keeps the observed call locally, so the conclusions that need its values are reached here. */
  private recordLocalCall(
    state: SessionDerivationState,
    event:
      | Extract<NormalizedSessionEvent, { type: "tool_call" }>
      | Pick<
          Extract<NormalizedSessionEvent, { type: "tool_call" }>,
          "sessionId" | "callId" | "toolName" | "connection"
        >,
    parameters: Record<string, WorkflowJsonValue>,
    /** The program the record established for this call, when it established one. */
    program?: WorkflowRecordedProgram,
    /**
     * The argument origins this call's upload carried. Their private leaves and protected program
     * tokens are the positions the cloud never saw; without them every string leaf counts as one.
     */
    uploaded?: WorkflowCallCarrier["origins"],
    /** The redacted arguments the upload was built from, when this path has them. */
    uploadedView?: Record<string, WorkflowJsonValue>,
    /** The harness's own built-in shell ran this program (a `KNOWN_SHELL_COMMANDS` proof). */
    shellProven = false,
  ): LocalCall {
    const startsExecution = state.executions.length === 0 || state.newExecutionPending;
    if (startsExecution) {
      state.newExecutionPending = false;
      state.position = 0;
      state.executions.push({
        index:
          state.executions.length === 0
            ? 0
            : state.executions[state.executions.length - 1]!.index + 1,
        calls: [],
        requestWords: state.pendingRequestWords,
      });
      state.pendingRequestWords = new Set();
      while (state.executions.length > MAX_EXECUTIONS) state.executions.shift();
    }
    const execution = state.executions[state.executions.length - 1]!;
    const flow =
      "type" in event && event.type === "tool_call" ? declaredFlowOfToolCall(event) : undefined;
    const discovered = this.discoveredCallable(event.sessionId, event.toolName, event.connection);
    const call: LocalCall = {
      callId: event.callId,
      toolName: event.toolName,
      ...((event.connection ?? discovered?.provider) === undefined
        ? {}
        : { connection: event.connection ?? discovered?.provider }),
      position: state.position,
      ...("metadata" in event &&
      event.type === "tool_call" &&
      KNOWN_SHELL_COMMANDS.some((known) => known.proves(event))
        ? { provenShell: true as const }
        : {}),
      ...("metadata" in event && codexThreadOf(event) !== undefined
        ? { codexThread: codexThreadOf(event) }
        : {}),
      executionIndex: execution.index,
      executionPosition: execution.calls.length,
      arguments: parameters,
      argumentReferences: Object.fromEntries(
        Object.entries(parameters).map(([argument, value]) => [
          argument,
          this.localReference(
            value,
            event.sessionId,
            event.callId,
            workflowCallArgumentSlot(argument),
          ),
        ]),
      ),
      // Only a program whose text arrived in a named argument can be read as a program here: with
      // no argument there is no text to tokenize, and a program that only arrived as an argv has no
      // token positions to address.
      ...(program?.argument === undefined
        ? {}
        : {
            program: {
              kind: program.kind,
              argument: program.argument,
              ...(program.sourceInterface === undefined
                ? {}
                : { sourceInterface: program.sourceInterface }),
              ...(program.dialect === undefined ? {} : { dialect: program.dialect }),
              ...(program.unprovenDialect === true ? { unprovenDialect: true as const } : {}),
            },
          }),
      ...(flow === undefined
        ? {}
        : {
            reads: flow.reads.map((resource) => `${resource.kind}:${resource.identity}`),
            writes: flow.writes.map((resource) => `${resource.kind}:${resource.identity}`),
          }),
    };
    // The call's own identity, so a validator can compare a plan's callable with the recording
    // under a reference it computes itself, never one the plan carries.
    this.localReference(
      {
        name: call.toolName,
        ...(call.connection === undefined ? {} : { connection: call.connection }),
        ...(call.program === undefined
          ? {}
          : {
              program: {
                kind: call.program.kind,
                argument: call.program.argument,
                ...(call.program.dialect === undefined ? {} : { dialect: call.program.dialect }),
                ...(call.program.unprovenDialect === true ? { unprovenDialect: true } : {}),
              },
            }),
        ...(shellProven && call.program?.kind === "shell" ? { builtinShell: true } : {}),
        arguments: Object.keys(parameters),
      },
      event.sessionId,
      event.callId,
      WORKFLOW_CALL_IDENTITY_SLOT,
    );
    if (uploaded !== undefined) {
      this.localReference(
        // SAFETY: positions are plain JSON: argument names and path segments.
        uploadedPrivatePositions(uploaded, (reference, argument, path) => {
          const stored = this.privateValues.get(reference);
          if (typeof stored === "string" && containsRedactionPlaceholder(stored)) return true;
          // Without the redacted view the upload was built from, a withheld leaf may hide a secret.
          if (uploadedView === undefined) return true;
          let leaf: unknown = uploadedView[argument];
          for (const part of path) {
            leaf =
              leaf !== null && typeof leaf === "object"
                ? (leaf as Record<string | number, unknown>)[part]
                : undefined;
          }
          return typeof leaf !== "string" || containsRedactionPlaceholder(leaf);
        }) as unknown as WorkflowJsonValue,
        event.sessionId,
        event.callId,
        WORKFLOW_CALL_PRIVATE_POSITIONS_SLOT,
      );
    }
    // Where this call falls in the recorded order, kept from the first time it was recorded: a
    // redelivered or re-read call keeps its place rather than moving to the end.
    const order = workflowPrivateReference(
      "demonstration",
      this.observeAccess?.workspaceId,
      this.privateRepresentation,
      [event.sessionId, event.callId, WORKFLOW_CALL_ORDER_SLOT],
    );
    if (this.privateValues.get(order) === undefined) {
      this.localReference(
        { epoch: RECORDING_EPOCH, index: recordingIndex++ },
        event.sessionId,
        event.callId,
        WORKFLOW_CALL_ORDER_SLOT,
      );
    }
    state.position += 1;
    execution.calls.push(call);
    return call;
  }

  /** The calls of the execution a call belongs to. */
  private callsOf(state: SessionDerivationState, executionIndex: number): LocalCall[] {
    return state.executions.find((entry) => entry.index === executionIndex)?.calls ?? [];
  }

  /**
   * The earlier work this execution is repeating, as far as it has repeated it.
   *
   * "The same work" is the same callables in the same order — a shape two executions share, which is
   * what makes their values comparable. The demonstration is THIS execution's values: it is the one
   * that ran on different inputs, so a replay of the earlier, recorded execution has both inputs the
   * recording never used and what those inputs actually produced. It never extends past the point
   * the repeat has reached, so a session that diverges half way never presents the earlier half as
   * if the whole thing had been performed twice.
   *
   * An execution that runs the earlier work's calls once per item — `for_each` on a learned tool, or
   * the same job done for several items in one request — is a demonstration with one iteration per
   * item: call j repeats the earlier call at position j mod k, and every iteration's call is listed
   * under that position in execution order. Past its first iteration it is advertised only once a
   * whole iteration has completed.
   *
   * Values are stored by reference: they are the user's own work and stay where they were performed.
   */
  private heldOutSoFar(
    state: SessionDerivationState,
    call: LocalCall,
  ): WorkflowCallHeldOut | undefined {
    const execution = state.executions.find((entry) => entry.index === call.executionIndex);
    if (execution === undefined) return undefined;
    const earlier = [...state.executions].reverse().find(
      (entry) =>
        entry.index < call.executionIndex &&
        entry.calls.length > 0 &&
        execution.calls.every((mine, position) => {
          const theirs = entry.calls[position % entry.calls.length]!;
          return (
            mine.toolName === theirs.toolName &&
            mine.connection === theirs.connection &&
            mine.program?.kind === theirs.program?.kind &&
            mine.program?.argument === theirs.program?.argument &&
            mine.program?.sourceInterface === theirs.program?.sourceInterface &&
            mine.program?.dialect === theirs.program?.dialect &&
            mine.program?.unprovenDialect === theirs.program?.unprovenDialect
          );
        }),
    );
    if (earlier === undefined) {
      // A diverging prefix must not leave an old demonstration advertised on later results.
      execution.accumulatedHeldOut = undefined;
      return undefined;
    }
    const width = earlier.calls.length;
    if (execution.calls.length > width && execution.calls.length % width !== 0) {
      // Mid-iteration: keep the last demonstration whose iterations were all complete.
      return execution.accumulatedHeldOut;
    }
    const inputs: WorkflowCallHeldOut["inputs"] = [];
    const observed: WorkflowCallHeldOut["observed"] = [];
    const calls: NonNullable<WorkflowCallHeldOut["calls"]> = [];
    for (const [ordinal, mine] of execution.calls.entries()) {
      const position = ordinal % width;
      calls.push({ position, callId: mine.callId });
      for (const [argument, reference] of Object.entries(mine.argumentReferences)) {
        // Nested arguments are part of an ordinary call too. Keep the complete value by local
        // reference; validation selects the candidate's nested path without uploading the value.
        inputs.push({ position, argument, reference });
      }
      if (mine.resultReference !== undefined) {
        observed.push({ position, reference: mine.resultReference });
      }
    }
    if (inputs.length === 0 && observed.length === 0) return undefined;
    execution.accumulatedHeldOut = { repeats: earlier.index, inputs, observed, calls };
    return execution.accumulatedHeldOut;
  }

  /**
   * What the calls observed so far establish about this one: the calls it must follow, and the
   * bindings its values only suggest.
   *
   * A suggestion is never a binding. The only value offered as a result binding is one that first
   * appeared in an earlier call's result — a value the record already contained before that call
   * produced it is not evidence of anything, and offering it would turn a coincidence into a
   * dependency. A program argument is never offered whole, because replacing it would replace the
   * work: a result-derived value embedded in a program is offered at its token position.
   */
  private relateLocalCall(
    state: SessionDerivationState,
    call: LocalCall,
    sessionId: string,
  ): { dependsOnCallIds: string[]; candidates: WorkflowCallCandidate[] } {
    const candidates: WorkflowCallCandidate[] = [];
    const calls = this.callsOf(state, call.executionIndex);

    // Resources the earlier calls declared they wrote and this call declared it reads. Both sides
    // named the resource, so the order is a fact of the record rather than a guess from the values.
    const dependsOnCallIds: string[] = [];
    if (call.reads !== undefined && call.reads.length > 0) {
      const reads = new Set(call.reads);
      for (const earlier of calls) {
        if (earlier === call) break;
        if (earlier.writes === undefined) continue;
        if (!earlier.writes.some((resource) => reads.has(resource))) continue;
        dependsOnCallIds.push(earlier.callId);
      }
    }

    // What the calls of this execution establish about their own arguments.
    const index = calls.indexOf(call);
    const ownStepId = index < 0 ? undefined : `local${index}`;
    const execution = state.executions.find((entry) => entry.index === call.executionIndex);
    const derivation = deriveNativeCalls(
      calls.map((entry, position) => ({
        callId: entry.callId,
        stepId: `local${position}`,
        toolName: entry.toolName,
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: entry.arguments,
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.program === undefined
          ? {}
          : { program: derivationProgram(entry.program, entry.provenDialect) }),
      })),
      execution?.requestWords,
      execution?.inputNames,
    );
    if (execution !== undefined) execution.inputNames = derivation.inputNames;
    if (index < 0) return { dependsOnCallIds, candidates };
    for (const candidate of derivation.candidates) {
      // Derivation bindings are proposed by the cloud against a compiled plan, never recorded here.
      if (candidate.stepId !== ownStepId || candidate.reason === "derived-from-inputs") continue;
      const proposed = candidate.proposed;
      // The recorder sees the value, so it never proposes an input of unknown type.
      if (proposed.kind === "input" && proposed.type !== "unknown") {
        candidates.push({
          argument: candidate.argument,
          path: candidate.path,
          proposed: { ...proposed, type: proposed.type },
          reason: candidate.reason,
          missing: candidate.missing,
        });
        continue;
      }
      if (candidate.proposed.kind !== "result") continue;
      const producingIndex = Number.parseInt(candidate.proposed.stepId.slice("local".length), 10);
      const producingCall = calls[producingIndex];
      if (producingCall === undefined) continue;
      candidates.push({
        argument: candidate.argument,
        path: candidate.path,
        proposed: { kind: "result", callId: producingCall.callId, path: candidate.proposed.path },
        reason: "equal-to-earlier-result",
        ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
        missing: candidate.missing,
      });
    }
    // A value an earlier call printed. The locator is text from that call's output, so it is kept
    // in the local store and only its reference is proposed.
    for (const extract of derivation.extracts) {
      if (extract.stepId !== ownStepId) continue;
      const producingIndex = Number.parseInt(extract.producerStepId.slice("local".length), 10);
      const producingCall = calls[producingIndex];
      if (producingCall === undefined) continue;
      const locatorText = JSON.stringify(extract.locator);
      // The identity covers the locator itself, so an immutable entry is never rewritten.
      const locator = workflowPrivateReference(
        "value",
        this.observeAccess?.workspaceId,
        this.privateRepresentation,
        [sessionId, call.callId, "extract-locator:v1", extract.argument, extract.path, locatorText],
      );
      this.privateValues.set(locator, locatorText, this.observeAccess, this.privateRepresentation);
      candidates.push({
        argument: extract.argument,
        path: extract.path,
        proposed: { kind: "extract", callId: producingCall.callId, locator },
        reason: "printed-by-earlier-step",
        evidence: extract.evidence,
        missing:
          "one recording does not establish that this token was the value the earlier step printed rather than a literal that happens to match it",
      });
    }
    return { dependsOnCallIds, candidates };
  }

  /**
   * The program this call ran, as the record establishes it.
   *
   * A command-bearing call is a process program whatever the callable is called; a call whose record
   * frames executed source in a language is a program in that language. Observing source in a file
   * read or write is not execution. Neither is decided by a list of tool names, and a plain shell
   * chain is preserved whole — its operators, pipes, redirections and exit status are part of it.
   *
   * A program starts with opaque source authority behind its named argument. Only the later
   * trusted normalization projection can expose a scrubbed view; runtime still resolves the
   * complete original locally before applying any approved token bindings.
   */
  private programOf(
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
    parameters: Record<string, WorkflowJsonValue>,
  ): WorkflowRecordedProgram | undefined {
    const codex = event.toolName === "exec" ? readCodexCommandMetadata(event.metadata) : undefined;
    if (codex?.kind === "call" && typeof parameters.cmd === "string") {
      return { kind: "shell", source: "", argument: "cmd", ...recordedDialectOf(event, "cmd") };
    }
    const command = extractRawCommandStringFromEvent(event);
    if (command !== null) {
      const program: WorkflowRecordedProgram = { kind: "shell", source: "" };
      const argument = this.argumentHolding(parameters, command);
      if (argument !== undefined) program.argument = argument;
      Object.assign(program, recordedDialectOf(event, argument));
      return program;
    }
    const language =
      typeof parameters.language === "string" ? parameters.language.trim().toLowerCase() : "";
    const sourceInterface =
      event.toolName === "eval" && typeof parameters.code === "string"
        ? event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "python-eval" &&
          (language === "py" || language === "python")
          ? "python-eval"
          : event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "javascript-eval" &&
              (language === "js" || language === "javascript")
            ? "javascript-eval"
            : undefined
        : undefined;
    for (const frame of extractComputationSourceFrames(event)) {
      if (frame.rejectionReason !== undefined || frame.executionScope === "file_observation") {
        continue;
      }
      const codexExecFrameMatches =
        frame.sourceInterface === "codex-exec" &&
        frame.executionScope === "isolated" &&
        frame.language === "javascript" &&
        typeof parameters.raw === "string" &&
        frame.source === parameters.raw &&
        isClosedCodexSource(frame.source);
      const evalInterfaceMatchesFrame =
        sourceInterface !== undefined &&
        frame.executionScope === "persistent" &&
        frame.source === parameters.code &&
        ((sourceInterface === "python-eval" && frame.language === "python") ||
          (sourceInterface === "javascript-eval" && frame.language === "javascript"));
      // A Codex frame is a native harness call unless its entire source is executable in
      // the isolated VM. Never recast a host-dependent wrapper as generic Node JavaScript.
      if (frame.sourceInterface === "codex-exec" && !codexExecFrameMatches) continue;
      const program: WorkflowRecordedProgram = { kind: frame.language, source: "" };
      if (codexExecFrameMatches) {
        program.argument = "raw";
        program.sourceInterface = "codex-exec";
      } else if (evalInterfaceMatchesFrame && sourceInterface !== undefined) {
        program.argument = "code";
        program.sourceInterface = sourceInterface;
      } else {
        const argument = this.argumentHolding(parameters, frame.source);
        if (argument !== undefined) program.argument = argument;
      }
      return program;
    }
    return undefined;
  }

  /**
   * Exposes a source view only when the real redactor and canonical parser both accept it. A shell
   * program is exposed only when its caller proved a known harness shell interface (a native Codex
   * command, or an entry of `KNOWN_SHELL_COMMANDS`); other shell programs stay private.
   */
  private projectProgramSource(
    event: Extract<NormalizedSessionEvent, { type: "tool_call" | "command_exec" }>,
    parameters: Record<string, WorkflowJsonValue>,
    program: WorkflowRecordedProgram,
    origins: WorkflowCallCarrier["origins"],
    shellKnown: boolean,
  ): void {
    if (program.argument === undefined) return;
    if (program.kind === "shell" && !shellKnown) return;
    const original = parameters[program.argument];
    const origin = origins[program.argument];
    if (typeof original !== "string" || origin?.type !== "private") return;
    // A program in a dialect Resin never tokenizes (cmd.exe, or one the record did not prove) keeps
    // its text private: there is no parser-aligned view of it to share.
    const language = recordedProgramLanguage(program);
    if (language === undefined) return;
    const scrubbed = redactLocalWorkflowProgramSource(event, original);
    if (scrubbed === undefined) return;
    const view = programSourceView(event, language, original, scrubbed);
    if (view === undefined) return;

    try {
      const sourceTokens = tokenizeProgram(language, view);
      let replacements: Map<number, string> | undefined;
      for (const [index, token] of sourceTokens.entries()) {
        if (token.kind !== "string" || typeof token.value !== "string") continue;
        // Scan decoded static literals too, so escaping a credential does not bypass the same
        // engine that already inspected the complete source and its assignment context.
        const decoded = redactLocalWorkflowProgramSource(event, token.value);
        if (decoded === undefined) return;
        if (!decoded.changed) continue;
        if (!token.bindable) return;
        replacements ??= new Map();
        replacements.set(index, decoded.redactedText);
      }
      const redacted =
        replacements === undefined
          ? view
          : applyProgramTokenValues(view, sourceTokens, replacements, language);
      // Only a POSIX shell program's words are rewritten relative to its working directory.
      const source =
        language === "shell"
          ? workdirRelativeProjection(redacted, original, parameters.workdir)
          : redacted;
      const projection = analyzeProgramSourceProjection(language, original, source);
      origins[program.argument] = {
        type: "program",
        language,
        source: { type: "literal", value: source },
        sourceReference: origin.reference,
        protectedTokens: projection.protectedTokens,
        holes: [],
      };
      program.source = source;
    } catch (error) {
      if (
        error instanceof ProgramTokenizationError ||
        error instanceof ProgramSourceProjectionError
      ) {
        return;
      }
      throw error;
    }
  }

  /** The top-level argument that carries this program text, so a host can resolve it before running. */
  private argumentHolding(
    parameters: Record<string, WorkflowJsonValue>,
    program: string,
  ): string | undefined {
    const trimmed = program.trim();
    for (const [name, value] of Object.entries(parameters)) {
      if (typeof value !== "string") continue;
      if (value === program || value.trim() === trimmed) return name;
    }
    return undefined;
  }

  private withCallCarrier(
    event: NormalizedSessionEvent,
    carrier: WorkflowCallCarrier,
  ): NormalizedSessionEvent {
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    metadata[RESIN_WORKFLOW_CALL_METADATA_KEY] = carrier;
    return { ...event, metadata } as NormalizedSessionEvent;
  }

  private observeResult(
    event: NormalizedSessionEvent,
    publicEvent: NormalizedSessionEvent = event,
    localResultObservation?: { result: string; comparison?: "text-trim" },
    suppressResult = false,
    /** The exit code of the native command a Codex cell ran, when it reported one. */
    nativeExitCode?: number,
  ): NormalizedSessionEvent {
    let baselineReference: string | undefined;
    let baselineComparison: "text-trim" | undefined;
    let output:
      | { type: "null" | "boolean" | "number" | "string" | "array" | "object"; hasContent: boolean }
      | undefined;
    if (event.type === "tool_result") {
      // The result's own value is what a later call's argument may have carried, so it is kept
      // locally for that comparison and never attached to the event.
      const state = this.sessionState(event.sessionId);
      for (let e = state.executions.length - 1; e >= 0; e -= 1) {
        const execution = state.executions[e]!;
        const call = execution.calls.find((entry) => entry.callId === event.callId);
        if (call === undefined) continue;
        const wrappedComposedResult =
          isInvokeToolCallName(event.toolName) &&
          this.resultHandle(publicEvent) !== undefined &&
          isPlainObject(event.result) &&
          Object.hasOwn(event.result, "result");
        const actual = suppressResult
          ? undefined
          : localResultObservation !== undefined
            ? localResultObservation.result
            : wrappedComposedResult
              ? (event.result as Record<string, WorkflowJsonValue>).result
              : event.result;
        const value = extractResultValueOf(actual);
        if (actual !== undefined) {
          const type = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
          if (
            type === "null" ||
            type === "boolean" ||
            type === "number" ||
            type === "string" ||
            type === "array" ||
            type === "object"
          ) {
            output = {
              type,
              hasContent:
                type === "null"
                  ? false
                  : type === "string"
                    ? (actual as string).length > 0
                    : type === "array"
                      ? (actual as unknown[]).length > 0
                      : type === "object"
                        ? Object.keys(actual as object).length > 0
                        : true,
            };
          }
        }
        const reference =
          value === undefined
            ? undefined
            : this.localResultReference(
                value,
                event.sessionId,
                call.callId,
                localResultObservation === undefined
                  ? "result"
                  : `native-result:v1:${localResultObservation.comparison ?? "exact"}`,
              );
        if (value !== undefined) {
          this.recordResultRedaction(
            event.sessionId,
            call.callId,
            publicEvent.type === "tool_result" ? publicEvent.result : undefined,
          );
        }
        // A harness shell call's status is known only for a run its decoder saw exit 0 in the
        // foreground; a result that returned early carries no exit status at all.
        const exitCode =
          nativeExitCode ??
          (call.provenShell === true &&
          event.isError === false &&
          SHELL_EXITED_ZERO[String(event.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY])] === true
            ? 0
            : undefined);
        if (exitCode !== undefined) {
          this.localResultReference(
            exitCode,
            event.sessionId,
            call.callId,
            WORKFLOW_CALL_EXIT_CODE_SLOT,
          );
        }
        // A second, different result for the call: the first stays the call's value, and neither
        // is its baseline any more.
        if (this.isResultConflicted(event.sessionId, call.callId)) {
          this.revokeResultBaseline(state, call);
          break;
        }
        call.result = value;
        call.resultHandle = value === undefined ? undefined : this.resultHandle(publicEvent);
        call.resultComparison = localResultObservation?.comparison;
        call.resultReference = reference;
        if (
          event.isError === false &&
          !suppressResult &&
          !isLocalWorkflowResultSuppressed(publicEvent)
        ) {
          baselineReference = call.resultReference;
          baselineComparison = baselineReference === undefined ? undefined : call.resultComparison;
        }
        // A repeat's own observations are what its results produced, so the demonstration grows
        // here rather than at a call that was recorded before they happened.
        if (execution.accumulatedHeldOut !== undefined && call.resultReference !== undefined) {
          execution.accumulatedHeldOut.observed = [
            ...execution.accumulatedHeldOut.observed.filter(
              (entry) => entry.position !== call.position,
            ),
            {
              position: call.position,
              reference: call.resultReference,
              ...(call.resultComparison === undefined ? {} : { comparison: call.resultComparison }),
            },
          ];
        }
        break;
      }
    }
    const handle = this.resultHandle(publicEvent);
    const heldOut =
      event.type === "tool_result"
        ? this.demonstrationCarrier(event.sessionId, event.callId)
        : undefined;
    if (
      handle === undefined &&
      heldOut === undefined &&
      baselineReference === undefined &&
      baselineComparison === undefined &&
      output === undefined
    ) {
      return event;
    }
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    metadata[RESIN_WORKFLOW_RESULT_METADATA_KEY] = {
      ...(handle === undefined ? {} : { handle }),
      ...(heldOut === undefined ? {} : { heldOut }),
      ...(baselineReference === undefined ? {} : { baselineReference }),
      ...(output === undefined ? {} : { output }),
      ...(baselineComparison === undefined ? {} : { baselineComparison }),
    };
    return { ...event, metadata } as NormalizedSessionEvent;
  }

  /** The demonstration so far of the execution this result belongs to, when it is a repeat. */
  private demonstrationCarrier(sessionId: string, callId: string): WorkflowCallHeldOut | undefined {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return undefined;
    for (let index = state.executions.length - 1; index >= 0; index -= 1) {
      const execution = state.executions[index]!;
      if (!execution.calls.some((call) => call.callId === callId)) continue;
      const heldOut = execution.accumulatedHeldOut;
      if (heldOut === undefined || heldOut.observed.length === 0) return undefined;
      return {
        repeats: heldOut.repeats,
        inputs: [...heldOut.inputs],
        observed: [...heldOut.observed],
        ...(heldOut.calls === undefined ? {} : { calls: [...heldOut.calls] }),
      };
    }
    return undefined;
  }

  /**
   * The handle a composed call returned for its result, when the record carries one.
   * A tool that happens to return a `ref:`-shaped handle field is indistinguishable
   * from a real one — and harmless, since the value genuinely came from that call.
   */
  private resultHandle(event: NormalizedSessionEvent): string | undefined {
    if (event.type !== "tool_result" || !isPlainObject(event.result)) return undefined;
    const handle = event.result.handle;
    return typeof handle === "string" && handle.startsWith("ref:") ? handle : undefined;
  }
}

/**
 * The shell profiles the recorder itself stamps on a Codex command: fixed identifiers, never user
 * data, so they stay public and the cloud can tell which POSIX shell a step ran in (and so split
 * its `;`/newline batches). Any other value under that name stays private.
 */
const PUBLIC_CODEX_SHELL_PROFILES: Readonly<Record<string, true>> = {
  "bash-login-v1": true,
  "bash-login-native-v1": true,
};

function publicShellProfile(argument: string, value: unknown): boolean {
  return (
    argument === "resinCodexShellProfile" &&
    typeof value === "string" &&
    Object.hasOwn(PUBLIC_CODEX_SHELL_PROFILES, value)
  );
}

/**
 * The redacted text a program is projected as. The engine's whole-text redaction is used when it
 * keeps the program's token structure. When it does not (a placeholder turned a bare word into a
 * glob, or an entropy match took in a `;`), each redacted value is replaced inside its own token
 * instead, so the rest of the program stays readable; that view is published only if the engine
 * finds nothing left in it to redact. Undefined keeps the program private.
 */
function programSourceView(
  event: NormalizedSessionEvent,
  language: ProgramLanguage,
  original: string,
  scrubbed: RedactedStringResult,
): string | undefined {
  try {
    analyzeProgramSourceProjection(language, original, scrubbed.redactedText);
    return scrubbed.redactedText;
  } catch (error) {
    if (
      !(error instanceof ProgramTokenizationError) &&
      !(error instanceof ProgramSourceProjectionError)
    ) {
      throw error;
    }
  }
  if (scrubbed.spans === undefined) return undefined;
  const inPlace = redactProgramSourceInPlace(language, original, scrubbed.spans);
  if (inPlace === undefined) return undefined;
  const rescanned = redactLocalWorkflowProgramSource(event, inPlace);
  return rescanned === undefined || rescanned.changed ? undefined : inPlace;
}

/**
 * The shell projection with every literal path inside the recorded working directory spelled
 * relative to it, as a command run there would spell it: `/app/inputs/*.csv` run in `/app` and
 * `inputs/*.csv` run in `/app` name the same files, and the cloud, which never learns the working
 * directory, can only see that from the projection. Where the project lives must not make one job
 * two. A rewritten token differs from the original, so it is protected like a redacted one; the
 * executable original is untouched. Only a plain unquoted word no input could bind (a glob) is
 * rewritten: protecting a bindable path would stop it from ever becoming an input, and one that
 * differs only in spelling is offered as an input instead. An expansion, quote or escape is never
 * rewritten; paths outside the working directory, the directory itself, and tokens the redactor
 * already changed keep their text.
 */
function workdirRelativeProjection(
  projection: string,
  original: string,
  workdir: WorkflowJsonValue | undefined,
): string {
  if (typeof workdir !== "string" || !isAbsolute(workdir)) return projection;
  const root = resolve(workdir);
  const tokens = tokenizeProgram("shell", projection);
  const originalTokens = tokenizeProgram("shell", original);
  let rewritten = projection;
  // Right to left, so each splice leaves the earlier tokens' offsets valid.
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index]!;
    if (
      token.kind !== "word" ||
      token.bindable ||
      token.quote !== undefined ||
      token.raw !== originalTokens[index]?.raw ||
      !/^\/[^\s$`'"\\]*$/u.test(token.raw)
    )
      continue;
    const inside = relative(root, token.raw);
    if (
      inside.length === 0 ||
      inside.startsWith("..") ||
      inside.startsWith("-") ||
      isAbsolute(inside)
    )
      continue;
    // `relative` drops a trailing slash that names a directory; the spelling keeps it.
    const spelled = token.raw.endsWith("/") ? `${inside}/` : inside;
    rewritten = rewritten.slice(0, token.start) + spelled + rewritten.slice(token.end);
  }
  return rewritten;
}

/**
 * A redacted token can never become a binding hole, so it is not proposed as one either; nor is a
 * token of an embedded program that carries or touches a secret. A program without a secret offers
 * all its tokens. In a program with one, only the tokens its projection shows verbatim — outside
 * every protected span, spelled identically in the original — are offered, each one whose own text
 * the redaction engine leaves unchanged.
 */
function unprotectedCandidates(
  event: NormalizedSessionEvent,
  parameters: Record<string, WorkflowJsonValue>,
  candidates: readonly WorkflowCallCandidate[],
  program: WorkflowRecordedProgram | undefined,
  origins: WorkflowCallCarrier["origins"],
): WorkflowCallCandidate[] {
  const projected = program?.argument === undefined ? undefined : origins[program.argument];
  const protectedTokens = projected?.type === "program" ? (projected.protectedTokens ?? []) : [];
  const sanitized =
    projected?.type === "program" &&
    projected.language === "shell" &&
    projected.source.type === "literal" &&
    typeof projected.source.value === "string"
      ? projected.source.value
      : undefined;
  const original = program?.argument === undefined ? undefined : parameters[program.argument];
  const programs =
    program !== undefined &&
    recordedProgramLanguage(program) === "shell" &&
    typeof original === "string"
      ? embeddedPrograms(original)
      : [];
  const safeEmbedded = new Map<string, boolean>();
  const embeddedIsSafe = (anchor: number, index: number): boolean => {
    const key = `${anchor}.${index}`;
    const known = safeEmbedded.get(key);
    if (known !== undefined) return known;
    const embedded = programs.find((each) => each.anchor === anchor);
    const token = embedded?.tokens[index];
    let safe = false;
    if (embedded !== undefined && token !== undefined && typeof original === "string") {
      const scrubbed = redactLocalWorkflowProgramSource(
        event,
        original.slice(embedded.start, embedded.end),
      );
      const projection = sanitized !== undefined && protectedTokens.length > 0;
      const own = scrubbed?.changed ? redactLocalWorkflowProgramSource(event, token.raw) : scrubbed;
      // A program with a secret needs its projection to establish which tokens are verbatim.
      safe =
        own !== undefined &&
        !own.changed &&
        (projection
          ? projectedEmbeddedTokenIsBindable(original, sanitized, protectedTokens, anchor, index)
          : !scrubbed!.changed);
    }
    safeEmbedded.set(key, safe);
    return safe;
  };
  // A span keeps the rest of its token as recorded text, so a token that held a secret (or its
  // redaction placeholder) is never split, whatever the projection says about the whole token.
  const spanTokenIsSafe = (address: { token: number; embedded?: number }): boolean => {
    if (program === undefined || typeof original !== "string") return false;
    const language = recordedProgramLanguage(program);
    if (language === undefined) return false;
    let value: unknown;
    try {
      value = programTokenValueAt(language, original, address);
    } catch {
      return false;
    }
    if (typeof value !== "string" || containsRedactionPlaceholder(value)) return false;
    const scrubbed = redactLocalWorkflowProgramSource(event, value);
    return scrubbed !== undefined && !scrubbed.changed;
  };
  return candidates.filter((candidate) => {
    if (candidate.argument !== program?.argument) return true;
    const address = programTokenPath(candidate.path);
    if (address === undefined) return true;
    if (protectedTokens.includes(address.token)) return false;
    if (address.embedded !== undefined && !embeddedIsSafe(address.token, address.embedded)) {
      return false;
    }
    return (
      address.span === undefined ||
      spanTokenIsSafe(
        address.embedded === undefined
          ? { token: address.token }
          : { token: address.token, embedded: address.embedded },
      )
    );
  });
}

/** A tool result as a comparable value: its text when it is text, its own value otherwise. */
function extractResultValueOf(result: unknown): WorkflowJsonValue | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
    return result;
  }
  if (result === null) return null;
  if (Array.isArray(result)) return result as WorkflowJsonValue;
  if (typeof result === "object") return result as WorkflowJsonValue;
  return undefined;
}

/**
 * The argument positions an upload kept private: every `private` leaf (the cloud received only a
 * reference), every protected token of a projected program, and the whole of a program whose text
 * the upload carried only by reference. `redacted` marks the positions secret redaction removed
 * (protected tokens, placeholder-bearing leaves) from those merely sent by reference.
 */
function uploadedPrivatePositions(
  origins: WorkflowCallCarrier["origins"],
  /** Whether a private leaf held a secret the upload redacted. */
  redactedLeaf: (reference: string, argument: string, path: WorkflowValuePath) => boolean,
): Array<{ argument: string; path: WorkflowValuePath; redacted: boolean }> {
  const positions: Array<{ argument: string; path: WorkflowValuePath; redacted: boolean }> = [];
  const walk = (
    argument: string,
    origin: WorkflowCallCarrier["origins"][string],
    path: WorkflowValuePath,
  ): void => {
    switch (origin.type) {
      case "private":
        positions.push({
          argument,
          path,
          redacted: redactedLeaf(origin.reference, argument, path),
        });
        return;
      case "object":
        for (const [key, entry] of Object.entries(origin.entries))
          walk(argument, entry, [...path, key]);
        return;
      case "array":
        origin.items.forEach((item, index) => walk(argument, item, [...path, index]));
        return;
      case "program":
        if (origin.source.type !== "literal") {
          const source = origin.source;
          positions.push({
            argument,
            path,
            redacted:
              source.type === "private" ? redactedLeaf(source.reference, argument, path) : true,
          });
          return;
        }
        for (const token of origin.protectedTokens ?? []) {
          positions.push({ argument, path: [...path, "tokens", token], redacted: true });
        }
        return;
      default:
        return;
    }
  };
  for (const [argument, origin] of Object.entries(origins)) walk(argument, origin, []);
  return positions;
}

/**
 * The program a derivation reads a call's text as: its language, or for a shell program its
 * recorded dialect's grammar. A program Resin never tokenizes (cmd.exe, an unproven dialect) is
 * opaque: nothing is proposed inside it or for it.
 */
function derivationProgram(
  program: NonNullable<LocalCall["program"]>,
  provenDialect?: LocalCall["provenDialect"],
): {
  kind: ProgramLanguage;
  argument: string;
  opaque?: true;
} {
  const language = recordedProgramLanguage(
    provenDialect === undefined ? program : { kind: program.kind, dialect: provenDialect },
  );
  return language === undefined
    ? { kind: program.kind, argument: program.argument, opaque: true }
    : { kind: language, argument: program.argument };
}

/** A Codex shell tool call this session recorded under `callId`, whose end event this may be. */
function codexShellToolCall(state: SessionDerivationState, callId: string): LocalCall | undefined {
  for (let index = state.executions.length - 1; index >= 0; index -= 1) {
    const call = state.executions[index]!.calls.find(
      (entry) =>
        entry.callId === callId &&
        (entry.toolName === "exec_command" || entry.toolName === "shell_command"),
    );
    if (call !== undefined) return call;
  }
  return undefined;
}

/** The Codex thread an event's native record names. */
function codexThreadOf(event: { metadata?: Record<string, unknown> }): string | undefined {
  const native = event.metadata?.codexNative;
  if (typeof native !== "object" || native === null || !("threadId" in native)) return undefined;
  return typeof native.threadId === "string" ? native.threadId : undefined;
}
