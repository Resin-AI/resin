/**
 * Recorded workflows: the shared representation of what Resin observed.
 *
 * The unit is the original call. A workflow is an ordered set of calls to the callables that were
 * actually used — a tool discovered over a protocol, a shell program, or any other executable
 * runtime — together with where each argument came from and what each call returned.
 *
 * The representation is deliberately identity-agnostic: it never says which applications are
 * supported. A newly discovered tool is described by its discovered schema and its connection, and
 * a workflow that uses it needs no compiler change.
 */

import { WORKFLOW_DERIVATION_RUNTIME } from "./derivation-steps.js";
import {
  type ProgramLanguage,
  embeddedProgramIsProtected,
  embeddedPrograms,
  programTokenPath,
  programTokenSpanFits,
  programTokenValueAt,
  tokenizeProgram,
} from "./program-tokens.js";
import { isOptionalSetupSegment } from "./shell-and-chain.js";
import {
  type ShellDialect,
  isShellDialect,
  programNotLearnableReason,
  recordedProgramLanguage,
} from "./shell-dialects.js";

export const RECORDED_WORKFLOW_SCHEMA_VERSION = 1 as const;
/** Maximum setup cells a captured Python closure may require before it fails closed. */
export const MAX_WORKFLOW_PYTHON_SETUP_CELLS = 32;
/** Maximum UTF-8 bytes for one captured Python source cell. */
export const MAX_WORKFLOW_PYTHON_SOURCE_BYTES = 262_144;
/** Maximum UTF-8 bytes for the complete Python program source. */
export const MAX_WORKFLOW_PYTHON_REPLAY_BYTES = 1_048_576;

/** Values the schema validator accepts without importing a JSON library. */
export type WorkflowJsonValue =
  | string
  | number
  | boolean
  | null
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };

/** A path into a returned value: object keys and array indexes, in order. */
export type WorkflowValuePath = ReadonlyArray<string | number>;

/** One leaf of a recursively constructed argument. */
export type WorkflowValueTemplate =
  | { type: "literal"; value: WorkflowJsonValue }
  | { type: "input"; name: string }
  | { type: "result"; stepId: string; path: WorkflowValuePath }
  | { type: "private"; reference: string }
  /**
   * The value an earlier step printed, found in its string result by a locator. `locator` is a
   * private reference whose value is the JSON text of an `ExtractLocator`; it is resolved locally
   * and never uploaded, because the text around the value came from tool output.
   */
  | { type: "extract"; stepId: string; locator: string }
  /** Origin the record does not establish: preserved as such, never guessed. */
  | { type: "unresolved"; reason: string }
  | { type: "object"; entries: Record<string, WorkflowValueTemplate> }
  | { type: "array"; items: WorkflowValueTemplate[] }
  /**
   * A recorded program with the values a replay bound inside it.
   *
   * Without projection metadata, `source` has its legacy local-source semantics. A projected
   * template carries sanitized, parseable text as a literal `source`, matching the sanitized
   * `callable.program.source`; neither sanitized value is executable. Runtime uses `sourceReference`
   * to resolve the complete original source locally, failing closed rather than falling back to
   * sanitized text. `protectedTokens` marks canonical tokens whose raw content changed during
   * redaction, so those tokens cannot also be replay holes.
   */
  | {
      type: "program";
      language: WorkflowProgramLanguage;
      source: WorkflowValueTemplate;
      /**
       * `token` is a top-level token index. With `embedded`, the hole addresses token `embedded` of
       * the program embedded in the shell source whose anchor is `token` (a heredoc body or a
       * `-c`/`-e` code string). With `span`, the hole binds only UTF-16 offsets [start, end) of the
       * addressed string token's decoded value, never all of it.
       */
      holes: Array<{
        token: number;
        embedded?: number;
        span?: { start: number; end: number };
        binding: WorkflowValueTemplate;
      }>;
      /** Whole original program source, kept in a local private resource. */
      sourceReference?: string;
      /** Sorted canonical token indexes changed by secret redaction; never binding holes. */
      protectedTokens?: number[];
    };

export type WorkflowValueSource =
  | { kind: "literal"; value: WorkflowJsonValue }
  /** Supplied by the caller of the generated tool. */
  | { kind: "input"; name: string }
  /** The value a previous step returned, addressed by path — never by matching text. */
  | { kind: "result"; stepId: string; path: WorkflowValuePath }
  /** A private resource resolved locally at execution time and never uploaded. */
  | { kind: "private"; reference: string }
  /**
   * The record does not establish where this value came from. It is preserved as unknown rather
   * than bound by guessing or frozen as a constant.
   */
  | { kind: "unresolved"; reason: string }
  /** A recursively constructed value whose leaves carry their own sources. */
  | { kind: "template"; template: WorkflowValueTemplate };

/**
 * A successful Python cell captured in the same persistent kernel interval as a target program.
 *
 * The source itself never crosses the recording boundary: `reference` is resolved by the owning
 * workspace at replay time. Event identifiers are structural identities used to reject replaying a
 * workflow call twice; they are not source names or executable metadata.
 */
export type WorkflowPythonStateSetup = {
  callId: string;
  sourceEventId: string;
  resultEventId: string;
  reference: string;
};

/**
 * The bounded closure facts needed to replay a Python program in a fresh disposable process.
 *
 * `unresolved` is retained in the wire vocabulary so an observer can explain why a candidate was
 * not closed; executable consumers reject it rather than guessing ambient session state.
 */
export type WorkflowPythonState = {
  schemaVersion: 1;
  status: "closed" | "unresolved";
  unresolvedReadCount: number;
  setup: WorkflowPythonStateSetup[];
};

/**
 * The language a program template's text is read in: a recorded program kind, or for a shell
 * program recorded in PowerShell, the edition's own grammar (`powershell` for Windows PowerShell
 * 5.1, `pwsh` for PowerShell 7+). A template's language must be its step's program's grammar.
 */
export type WorkflowProgramLanguage = WorkflowRecordedProgram["kind"] | "powershell" | "pwsh";

/**
 * A program the recording executed, with its source retained verbatim unless projected safely.
 *
 * For a native projected capture, `source` is sanitized metadata matching the argument template's
 * sanitized source; the original executable text is routed through that template's local
 * `sourceReference`, never inferred from or recovered from this field.
 *
 * The program is the executable artifact in an ordinary capture: it is never split, re-parsed,
 * re-quoted or reduced to a list of commands, because a shell's `&&`, pipelines, redirections and
 * exit status are part of what the call did. Reuse means running this text again through the same
 * family of runtime, not reconstructing an equivalent one.
 */
export type WorkflowRecordedProgram = {
  /**
   * How the program runs: the family of shell or interpreter the record establishes. A `patch` is
   * one file's unified diff, applied in-process to the file its header names.
   */
  kind: "shell" | "python" | "javascript" | "typescript" | "patch";
  /**
   * The shell dialect a `shell` program ran in, as the recording proved it (a harness's own shell
   * tool, or the shell executable it recorded running). Absent on a record made before dialects
   * were recorded, which keeps the POSIX reading. Never inferred from an operating system.
   */
  dialect?: ShellDialect;
  /**
   * A `shell` program whose dialect the recording does not prove. It is captured but never
   * tokenized, split, parameterized or replayed.
   */
  unprovenDialect?: true;
  /** Program text as recorded, or sanitized source metadata in a projected capture. */
  source: string;
  /**
   * Adapter-established execution semantics. Python Eval renders the final expression as well as
   * captured output; JavaScript Eval preserves the native completion and captured output; Codex
   * exec returns its authored text content items. Absent means ordinary process stdout, never
   * inferred from a callable name.
   */
  sourceInterface?: "python-eval" | "javascript-eval" | "codex-exec";
  /** The exact argument vector, when the record has one and it is not a shell wrapper. */
  argv?: string[];
  /** The argument the program arrived in, when it came as a tool argument rather than an event. */
  argument?: string;
  /** Working directory the program ran in, when the record identifies one. */
  cwd?: string;
  /**
   * Private closure metadata for Python programs captured from a persistent kernel interval.
   * It contains only local reference identities; setup source is resolved at replay time.
   */
  pythonState?: WorkflowPythonState;
};

/**
 * What a `patch` program returns when applied. It is fixed and value-free: the edit's effect is the
 * file, which later steps observe, and a recording records the same text so a replay compares equal.
 */
export const WORKFLOW_PATCH_STEP_RESULT = "patched";

/** How a step is called again: the original callable and the connection it was reached through. */
export type WorkflowCallable = {
  /** Protocol/runtime family the callable speaks, e.g. a tool protocol or a program runner. */
  runtime: string;
  /** Name the callable was recorded under, exactly as the record has it. */
  name: string;
  /** Connection or session the callable was reached through, if the record identifies one. */
  connection?: string;
  /**
   * The discovered input schema of the callable, when the record carries one. Compilation validates
   * against it; a missing schema is reported rather than guessed.
   */
  inputSchema?: WorkflowJsonValue;
  /** The output contract observed for this call, when the record carries one. */
  outputSchema?: WorkflowJsonValue;
  /** The recorded program this callable runs, when the call was a program execution. */
  program?: WorkflowRecordedProgram;
};

/**
 * Where one argument's origin came from, and how firmly the record establishes it.
 *
 * `recorded` is a fact the caller stated; `derived` is a conclusion local analysis reached from the
 * record and can point at; `candidate` is a suggestion the record only *suggests* (for instance a
 * value that merely equals an earlier result) and that may never execute as recorded. Keeping the
 * three apart is what stops a coincidence from becoming a dependency.
 */
export type WorkflowArgumentProvenance = {
  standing: "recorded" | "derived" | "candidate";
  /** Finite rule vocabulary — never free text, so a consumer can act on it without parsing prose. */
  rule:
    | "caller-stated"
    | "declared-resource"
    | "variation-across-executions"
    | "replay-confirmed"
    | "equal-to-earlier-result"
    | "invariant-across-executions"
    | "single-observation";
  /** Structural, privacy-safe evidence for the rule. Never a value the recording may not carry. */
  evidence?: WorkflowJsonValue;
  /** For a candidate: the exact fact the record does not establish. */
  missing?: string;
};

export type WorkflowArgument = {
  /** Argument name as the callable's schema names it. */
  name: string;
  source: WorkflowValueSource;
  /** What the record says about this origin. Absent means the recording predates the vocabulary. */
  provenance?: WorkflowArgumentProvenance;
};

/**
 * A binding the capture proposes but has not established.
 *
 * A candidate is deliberately NOT executable: the plan keeps the recorded value until a caller
 * validates the proposed behaviour against a recorded demonstration of different inputs. Every candidate
 * names the fact the record is missing, so a refusal is reportable instead of silent.
 */
export type WorkflowBindingCandidate = {
  stepId: string;
  argument: string;
  /**
   * Where inside the argument the value sits; empty for the whole argument.
   *
   * A path of `["tokens", <index>]` names a token of the program the argument holds, as
   * `tokenizeProgram` numbers it — the position inside a recorded program text, for a value the
   * capture found embedded in it. Everything else is a path through the argument's own structure.
   */
  path: WorkflowValuePath;
  proposed:
    | { kind: "result"; stepId: string; path: WorkflowValuePath }
    | { kind: "extract"; stepId: string; locator: string }
    | {
        kind: "input";
        name: string;
        /**
         * `unknown` when the proposer cannot see the value's type (a private harness-tool
         * argument): the device that confirms it reports the type, and only proposals carry it —
         * never `RecordedWorkflow.inputs`.
         */
        type: "string" | "number" | "boolean" | "object" | "array" | "unknown";
        /**
         * Promote as an optional input that defaults to the recorded token (see
         * `RecordedWorkflow.inputs[].recordedDefault`). Only a program-token position qualifies.
         */
        recordedDefault?: true;
      };
  reason:
    | "equal-to-earlier-result"
    | "tracks-earlier-result-across-executions"
    | "varies-across-executions"
    | "declared-by-the-callable"
    | "shares-value-with-declared-input"
    | "classified-source-value"
    | "native-data-argument"
    | "printed-by-earlier-step"
    /**
     * The token is computed from the caller inputs by an `origin: "derivation"` step; `proposed` is
     * `{kind: "result", stepId: <that step>, path: [<name>]}`. Accepted only after local replay.
     */
    | "derived-from-inputs";
  /** Structural, privacy-safe evidence: identities and shapes, never the values themselves. */
  evidence?: WorkflowJsonValue;
  missing: string;
};

export type WorkflowStepFailureBehavior = "abort" | "continue";

/**
 * How the workflow behaves when this step fails, kept separate from what was observed.
 *
 * `policy` says where the behavior came from: `recorded` when the record shows the control flow,
 * `default` when this representation chose it because the record does not say. An observed failure
 * is evidence about one execution, not a description of the workflow's behavior.
 */
export type WorkflowStepFailurePolicy = {
  onError: WorkflowStepFailureBehavior;
  policy: "recorded" | "default";
};

/** What an observed demonstration result may project before comparison. */
export type WorkflowObservedComparison = "text-trim";

/** Value-free shape of an actual result; never contains the result itself. */
export type WorkflowObservedOutput = {
  type: "null" | "boolean" | "number" | "string" | "array" | "object";
  hasContent: boolean;
};

/** What the recording observed about this step's execution, for diagnostics only. */
export type WorkflowStepObservation = {
  outcome: "succeeded" | "failed" | "unknown";
  output?: WorkflowObservedOutput;
};

export type WorkflowStep = {
  /** Stable identity of this step inside the workflow. */
  id: string;
  /** Identity of the recording this step came from: the call and its result. */
  callId: string;
  callable: WorkflowCallable;
  arguments: WorkflowArgument[];
  /** Steps that must complete first, preserving the recorded ordering and dependencies. */
  dependsOn: string[];
  /** Recorded control flow, with the policy label it was derived under. */
  failurePolicy: WorkflowStepFailurePolicy;
  /** What the recording saw happen; never used as the workflow's behavior. */
  observed: WorkflowStepObservation;
  /** Execution permissions the recorded call used, for reporting and for the runtime to enforce. */
  permissions?: WorkflowJsonValue;
  /**
   * The step is a caller toggle: when the named boolean input resolves to `false`, the step is
   * skipped. The input defaults to `true`, so an omitted toggle keeps the recorded behavior. No
   * other step may consume an optional step's result.
   */
  optional?: { input: string };
  /**
   * The step is one command of a recorded shell `&&` chain (see `shell-and-chain.ts`): segment
   * `index` of `count`, split by splitter `version`. Every segment of the chain is a step of its own
   * with the chain's callId, its exact segment text as its program, in chain order. Only the last
   * segment's result may be read: the recording observed the chain's output as a whole.
   */
  segment?: { index: number; count: number; version: number };
  /**
   * Where this step came from. Absent or `recorded`: a call the recording executed. `derivation`:
   * a small Python program a model wrote to compute values from the caller inputs (see
   * `derivation-steps.ts`).
   *
   * Only a derivation step may carry program source that no recording produced. A derivation must
   * run as a Python Eval program in the program runtime, carry its source as a literal that equals
   * `callable.program.source`, bind only caller inputs in its holes (at least one), reference no
   * private value, depend on nothing, observe nothing, and be absent from `baseline`/`heldOut`.
   *
   * The structural validator cannot prove a recorded step's source was recorded: it can only reject
   * a projected recorded program whose literal differs from its recorded `program.source`, and any
   * step that claims the derivation origin without meeting the rules above. Whether recorded source
   * came from the recording is established by the observer that builds the plan, not here.
   */
  origin?: "recorded" | "derivation";
};

/**
 * A second execution of the same work, on inputs the recording under compilation did not use.
 *
 * The plan is compiled from one execution; this is what a replay is checked against. Every value in
 * it is a local reference the host resolves, never a value the plan carries: a demonstration is the
 * user's own work, and it stays on the machine that performed it.
 */
export type WorkflowHeldOutDemonstration = {
  /** The inputs the demonstration used, at the argument each one landed in. */
  inputs: Array<{ stepId: string; argument: string; reference: string }>;
  /** What each step of the demonstration produced. */
  observed: Array<{
    stepId: string;
    reference: string;
    /** An explicit projection for textual output whose trailing whitespace is incidental. */
    comparison?: WorkflowObservedComparison;
  }>;
  /**
   * The local calls that performed each recorded (non-derivation) step in this demonstration, in
   * execution order; more than one only for `for_each` iterations. The host recomputes every
   * recorded value from these call ids and its own sessions, so a plan never carries the recording.
   */
  calls?: Array<{
    stepId: string;
    callIds: string[];
    /**
     * Where each named call ran this step, parallel to `callIds`: a segment address in that call's
     * own recorded `&&` chain, or `null` for the whole call. Another run may have chained the same
     * command differently — behind another setup, fused with the next command, or alone — so the
     * address need not be the plan step's `segment`. Required for a segment step; absent means every
     * call ran the whole step. The host re-splits its own recording at an address and admits
     * nothing when it does not split so.
     */
    segments?: Array<{ index: number; count: number; version: number } | null>;
  }>;
};

export type RecordedWorkflow = {
  schemaVersion: typeof RECORDED_WORKFLOW_SCHEMA_VERSION;
  workflowId: string;
  /** Caller-supplied inputs, in the order the workflow exposes them, with their recorded types. */
  inputs: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "object" | "array";
    description?: string;
    /** The value to use when this caller input is omitted. */
    default?: WorkflowJsonValue;
    /**
     * The caller may omit this input, and then every program token it binds keeps the text the
     * recording ran. One recording establishes this default, and the value stays in the local record:
     * it never becomes part of the plan. Such an input is bound only by program-token holes.
     */
    recordedDefault?: true;
  }>;
  steps: WorkflowStep[];
  /** Private resources the workflow needs locally, addressed by reference only. */
  privateReferences?: string[];
  /**
   * Bindings the capture proposes but has not established. They are diagnostic, never executable:
   * the steps above keep the recorded values until a validator confirms a candidate on different
   * inputs recorded on this device.
   */
  candidates?: WorkflowBindingCandidate[];
  /**
   * The original execution's inputs and outputs, retained locally for a zero-candidate baseline
   * replay. It is separate from `heldOut`: this record can prove the captured plan ran in a fresh
   * process without becoming evidence for promoting any candidate.
   */
  baseline?: WorkflowHeldOutDemonstration;
  /**
   * A second execution of the same work, kept locally by reference. It is what makes a candidate
   * decidable without anyone supplying inputs or expectations by hand: the replay runs the plan on
   * the demonstration's inputs and compares each step with what that execution actually produced.
   */
  heldOut?: WorkflowHeldOutDemonstration;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is WorkflowJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function matchesWorkflowInputType(value: WorkflowJsonValue, type: string): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  return false;
}

const PYTHON_STATE_KEYS = ["schemaVersion", "status", "unresolvedReadCount", "setup"] as const;
const PYTHON_SETUP_KEYS = ["callId", "sourceEventId", "resultEventId", "reference"] as const;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * A shell program's argument template is read in its recorded dialect's grammar: a template in any
 * other language would render bound values with another shell's quoting. A program that is never
 * learned (cmd.exe, or an unproven dialect) takes no program template at all.
 */
function validateProgramArgumentLanguage(
  stepId: string,
  program: WorkflowRecordedProgram,
  argument: unknown,
  errors: string[],
): void {
  if (program.kind !== "shell" || !isPlainObject(argument)) return;
  const source = argument.source;
  if (!isPlainObject(source) || source.kind !== "template") return;
  const template = source.template;
  if (!isPlainObject(template) || template.type !== "program") return;
  const notLearnable = programNotLearnableReason(program);
  if (notLearnable !== undefined) {
    errors.push(`step ${stepId} argument ${program.argument}: ${notLearnable}`);
    return;
  }
  if (template.language !== recordedProgramLanguage(program)) {
    errors.push(
      `step ${stepId} argument ${program.argument} is a program template in another shell dialect than its recorded program`,
    );
  }
}

/** Rejects interface/language mismatches rather than silently replaying under different semantics. */
export function validateWorkflowProgramSourceInterface(
  program: { kind?: unknown; sourceInterface?: unknown },
  stepId: string,
  errors: string[],
): void {
  if (program.sourceInterface === undefined) return;
  if (program.sourceInterface === "python-eval") {
    if (program.kind !== "python") {
      errors.push(`step ${stepId} has a Python Eval sourceInterface on a non-Python program`);
    }
    return;
  }
  if (program.sourceInterface === "javascript-eval") {
    if (program.kind !== "javascript") {
      errors.push(
        `step ${stepId} has a JavaScript Eval sourceInterface on a non-JavaScript program`,
      );
    }
    return;
  }
  if (program.sourceInterface === "codex-exec") {
    if (program.kind !== "javascript") {
      errors.push(`step ${stepId} has a Codex exec sourceInterface on a non-JavaScript program`);
    }
    return;
  }
  errors.push(`step ${stepId} has an unsupported program sourceInterface`);
}

/** Validates only the projection-specific shape shared by workflow and native carrier readers. */
export function validateWorkflowProgramProjection(
  template: unknown,
  path: string,
  errors: string[],
): void {
  if (!isPlainObject(template)) return;
  const hasSourceReference = Object.prototype.hasOwnProperty.call(template, "sourceReference");
  const hasProtectedTokens = Object.prototype.hasOwnProperty.call(template, "protectedTokens");
  if (!hasSourceReference && !hasProtectedTokens) return;

  if (hasSourceReference !== hasProtectedTokens) {
    errors.push(`${path} projected program needs sourceReference and protectedTokens together`);
  }
  if (typeof template.sourceReference !== "string" || template.sourceReference.length === 0) {
    errors.push(`${path} projected program needs a non-empty private sourceReference`);
  }
  if (
    !isPlainObject(template.source) ||
    template.source.type !== "literal" ||
    typeof template.source.value !== "string"
  ) {
    errors.push(`${path} projected program source must be a literal string`);
  }

  const protectedTokens = new Set<number>();
  if (!Array.isArray(template.protectedTokens)) {
    errors.push(`${path} projected program protectedTokens must be an array`);
  } else {
    let previous = -1;
    for (const [index, token] of template.protectedTokens.entries()) {
      if (typeof token !== "number" || !Number.isInteger(token) || token < 0) {
        errors.push(`${path} protected token ${index} must be a non-negative integer`);
        continue;
      }
      if (token <= previous) errors.push(`${path} protectedTokens must be sorted and unique`);
      previous = token;
      protectedTokens.add(token);
    }
  }
  if (!Array.isArray(template.holes)) return;
  for (const hole of template.holes) {
    if (
      isPlainObject(hole) &&
      typeof hole.token === "number" &&
      Number.isInteger(hole.token) &&
      hole.token >= 0 &&
      protectedTokens.has(hole.token)
    ) {
      errors.push(`${path} hole ${hole.token} targets a protected token index`);
    }
  }
  const sanitized =
    template.language === "shell" &&
    isPlainObject(template.source) &&
    typeof template.source.value === "string"
      ? template.source.value
      : undefined;
  const embeddedHoles = template.holes.filter(
    (hole): hole is { token: number; embedded: number } =>
      isPlainObject(hole) && typeof hole.token === "number" && typeof hole.embedded === "number",
  );
  if (sanitized === undefined || embeddedHoles.length === 0 || protectedTokens.size === 0) return;
  const shellTokens = tokenizeProgram("shell", sanitized);
  const programs = embeddedPrograms(sanitized);
  for (const hole of embeddedHoles) {
    const program = programs.find((each) => each.anchor === hole.token);
    if (program && embeddedProgramIsProtected(program, shellTokens, [...protectedTokens])) {
      errors.push(`${path} hole ${hole.token}.${hole.embedded} is inside a protected program`);
    }
  }
}

export function validateWorkflowPythonState(
  program: { kind?: unknown; pythonState?: unknown },
  stepId: string,
  targetCallId: string | undefined,
  workflowCallIds: ReadonlySet<string>,
  declaredPrivates: ReadonlySet<string> | undefined,
  errors: string[],
): void {
  const state = program.pythonState;
  if (state === undefined) return;
  if (program.kind !== "python") {
    errors.push(`step ${stepId} has pythonState on a non-Python program`);
    return;
  }
  if (!isPlainObject(state)) {
    errors.push(`step ${stepId} pythonState must be an object`);
    return;
  }
  if (!hasOnlyKeys(state, PYTHON_STATE_KEYS)) {
    errors.push(`step ${stepId} pythonState contains unsupported metadata`);
  }
  if (state.schemaVersion !== 1) {
    errors.push(`step ${stepId} pythonState has an unsupported schemaVersion`);
  }
  if (state.status !== "closed" && state.status !== "unresolved") {
    errors.push(`step ${stepId} pythonState needs a closed or unresolved status`);
  }
  if (
    typeof state.unresolvedReadCount !== "number" ||
    !Number.isInteger(state.unresolvedReadCount) ||
    state.unresolvedReadCount < 0
  ) {
    errors.push(`step ${stepId} pythonState.unresolvedReadCount must be a non-negative integer`);
  } else if (state.status === "closed" && state.unresolvedReadCount !== 0) {
    errors.push(`step ${stepId} closed pythonState cannot have unresolved reads`);
  }
  if (state.status === "unresolved") {
    errors.push(`step ${stepId} pythonState is unresolved`);
  }
  if (!Array.isArray(state.setup)) {
    errors.push(`step ${stepId} pythonState.setup must be an array`);
    return;
  }
  if (state.setup.length > MAX_WORKFLOW_PYTHON_SETUP_CELLS) {
    errors.push(
      `step ${stepId} pythonState.setup exceeds ${MAX_WORKFLOW_PYTHON_SETUP_CELLS} cells`,
    );
  }
  const callIds = new Set<string>();
  const sourceEventIds = new Set<string>();
  const resultEventIds = new Set<string>();
  const descriptorIds = new Set<string>();
  const references = new Set<string>();
  for (const [index, descriptor] of state.setup.entries()) {
    const where = `step ${stepId} pythonState.setup[${index}]`;
    if (!isPlainObject(descriptor)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (!hasOnlyKeys(descriptor, PYTHON_SETUP_KEYS)) {
      errors.push(`${where} contains unsupported metadata`);
    }
    const fields: Array<keyof WorkflowPythonStateSetup> = [
      "callId",
      "sourceEventId",
      "resultEventId",
      "reference",
    ];
    for (const field of fields) {
      if (typeof descriptor[field] !== "string" || descriptor[field].length === 0) {
        errors.push(`${where}.${field} must be a non-empty string`);
      }
    }
    const callId = typeof descriptor.callId === "string" ? descriptor.callId : undefined;
    const sourceEventId =
      typeof descriptor.sourceEventId === "string" ? descriptor.sourceEventId : undefined;
    const resultEventId =
      typeof descriptor.resultEventId === "string" ? descriptor.resultEventId : undefined;
    for (const id of [callId, sourceEventId, resultEventId]) {
      if (id === undefined) continue;
      if (descriptorIds.has(id)) errors.push(`${where} duplicates descriptor identity ${id}`);
      descriptorIds.add(id);
      if (targetCallId !== undefined && id === targetCallId) {
        errors.push(`${where} references its target callId ${id}`);
      }
    }
    const reference = typeof descriptor.reference === "string" ? descriptor.reference : undefined;
    if (callId !== undefined) {
      if (callIds.has(callId)) errors.push(`${where} duplicates callId ${callId}`);
      callIds.add(callId);
      if (workflowCallIds.has(callId)) {
        errors.push(`${where} overlaps workflow callId ${callId}`);
      }
    }
    if (sourceEventId !== undefined) {
      if (sourceEventIds.has(sourceEventId)) {
        errors.push(`${where} duplicates sourceEventId ${sourceEventId}`);
      }
      sourceEventIds.add(sourceEventId);
    }
    if (resultEventId !== undefined) {
      if (resultEventIds.has(resultEventId)) {
        errors.push(`${where} duplicates resultEventId ${resultEventId}`);
      }
      resultEventIds.add(resultEventId);
    }
    if (
      callId !== undefined &&
      ((sourceEventId !== undefined && callId === sourceEventId) ||
        (resultEventId !== undefined && callId === resultEventId))
    ) {
      errors.push(`${where} self-references its own call event`);
    }
    if (
      sourceEventId !== undefined &&
      resultEventId !== undefined &&
      sourceEventId === resultEventId
    ) {
      errors.push(`${where} uses the same source and result event`);
    }
    if (reference !== undefined) {
      if (references.has(reference)) errors.push(`${where} duplicates reference ${reference}`);
      references.add(reference);
      if (declaredPrivates !== undefined && !declaredPrivates.has(reference)) {
        errors.push(`${where} reads undeclared private reference '${reference}'`);
      }
    }
  }
}

function validateDemonstration(
  label: "heldOut" | "baseline",
  demonstration: unknown,
  order: ReadonlyMap<string, number>,
  declaredPrivates: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isPlainObject(demonstration)) {
    errors.push(`${label} must be an object when present`);
    return;
  }
  const entries: ReadonlyArray<readonly [string, unknown]> = [
    ["inputs", demonstration.inputs],
    ["observed", demonstration.observed],
  ];
  for (const [entryLabel, list] of entries) {
    if (!Array.isArray(list)) {
      errors.push(`${label}.${entryLabel} must be an array`);
      continue;
    }
    for (const entry of list) {
      if (!isPlainObject(entry)) {
        errors.push(`every ${label}.${entryLabel} entry must be an object`);
        continue;
      }
      if (
        entryLabel === "observed" &&
        entry.comparison !== undefined &&
        entry.comparison !== "text-trim"
      ) {
        errors.push(
          `${label}.observed entry for step ${String(entry.stepId)} has unsupported comparison ${String(entry.comparison)}`,
        );
      }
      if (!order.has(String(entry.stepId))) {
        errors.push(
          `every ${label}.${entryLabel} entry names unknown step ${String(entry.stepId)}`,
        );
      }
      if (typeof entry.reference !== "string" || !declaredPrivates.has(entry.reference)) {
        errors.push(
          `${label}.${entryLabel} reads undeclared local reference ${String(entry.reference)}`,
        );
      }
      if (entryLabel === "inputs" && typeof entry.argument !== "string") {
        errors.push(`every ${label}.inputs entry needs the argument it was supplied for`);
      }
    }
  }
  if (demonstration.calls === undefined) return;
  if (!Array.isArray(demonstration.calls)) {
    errors.push(`${label}.calls must be an array when present`);
    return;
  }
  const seen = new Set<string>();
  for (const entry of demonstration.calls) {
    if (!isPlainObject(entry)) {
      errors.push(`every ${label}.calls entry must be an object`);
      continue;
    }
    const stepId = String(entry.stepId);
    if (!order.has(stepId)) errors.push(`every ${label}.calls entry names unknown step ${stepId}`);
    if (seen.has(stepId)) errors.push(`${label}.calls names step ${stepId} twice`);
    seen.add(stepId);
    if (
      !Array.isArray(entry.callIds) ||
      entry.callIds.length === 0 ||
      !entry.callIds.every((callId) => typeof callId === "string" && callId.length > 0)
    ) {
      errors.push(`${label}.calls entry for step ${stepId} needs non-empty call ids`);
    }
  }
}

/**
 * The steps whose results a recorded workflow returns, in recorded order: those no later step
 * consumes through a bound result, a declared dependency or Python setup. A chain returns its final
 * result; a run of independent steps returns every step's output.
 */
export function workflowSinkStepIds(workflow: RecordedWorkflow): string[] {
  const consumed = new Set<string>();
  const stepByCall = new Map(workflow.steps.map((step) => [step.callId, step.id]));
  const walkTemplate = (template: WorkflowValueTemplate): void => {
    switch (template.type) {
      case "result":
      case "extract":
        consumed.add(template.stepId);
        return;
      case "object":
        for (const entry of Object.values(template.entries)) walkTemplate(entry);
        return;
      case "array":
        for (const entry of template.items) walkTemplate(entry);
        return;
      case "program":
        walkTemplate(template.source);
        for (const hole of template.holes) walkTemplate(hole.binding);
        return;
      default:
        return;
    }
  };
  for (const step of workflow.steps) {
    for (const dependency of step.dependsOn) consumed.add(dependency);
    for (const argument of step.arguments) {
      if (argument.source.kind === "result") consumed.add(argument.source.stepId);
      if (argument.source.kind === "template") walkTemplate(argument.source.template);
    }
    for (const descriptor of step.callable.program?.pythonState?.setup ?? []) {
      const producer = stepByCall.get(descriptor.callId);
      if (producer !== undefined) consumed.add(producer);
    }
  }
  return workflow.steps.filter((step) => !consumed.has(step.id)).map((step) => step.id);
}

/**
 * Collects all local references an executable workflow may resolve.
 *
 * The result is metadata only: it contains opaque reference identities, never resolved values or
 * Python source. Keeping this traversal in the shared contract prevents compiler/runtime callers
 * from forgetting closure setup or baseline evidence when calculating required private resources.
 */
export function collectWorkflowPrivateReferences(workflow: RecordedWorkflow): string[] {
  const references = new Set<string>(workflow.privateReferences ?? []);
  const walkTemplate = (template: WorkflowValueTemplate): void => {
    switch (template.type) {
      case "private":
        references.add(template.reference);
        return;
      case "extract":
        references.add(template.locator);
        return;
      case "object":
        for (const entry of Object.values(template.entries)) walkTemplate(entry);
        return;
      case "array":
        for (const entry of template.items) walkTemplate(entry);
        return;
      case "program":
        walkTemplate(template.source);
        if (template.sourceReference !== undefined) references.add(template.sourceReference);
        for (const hole of template.holes) walkTemplate(hole.binding);
        return;
      default:
        return;
    }
  };
  for (const step of workflow.steps) {
    for (const argument of step.arguments) {
      if (argument.source.kind === "private") references.add(argument.source.reference);
      if (argument.source.kind === "template") walkTemplate(argument.source.template);
    }
    const state = step.callable.program?.pythonState;
    for (const descriptor of state?.setup ?? []) references.add(descriptor.reference);
  }
  for (const demonstration of [workflow.baseline, workflow.heldOut]) {
    if (demonstration === undefined) continue;
    for (const entry of demonstration.inputs) references.add(entry.reference);
    for (const entry of demonstration.observed) references.add(entry.reference);
  }
  // A proposed extract names its locator by reference; it must be declared so a replay can resolve
  // it, and the reference is never the locator text.
  for (const candidate of workflow.candidates ?? []) {
    if (candidate.proposed.kind === "extract") references.add(candidate.proposed.locator);
  }
  return [...references];
}

/**
 * An optional step is toggled by exactly one boolean input that defaults to `true` and is used
 * nowhere else; no other step (argument, hole, or candidate proposal) may read its result, so
 * skipping it can never leave a later binding without a value.
 */
function validateWorkflowOptionalSteps(workflow: Record<string, unknown>, errors: string[]): void {
  const steps = Array.isArray(workflow.steps) ? workflow.steps.filter(isPlainObject) : [];
  const inputs = Array.isArray(workflow.inputs) ? workflow.inputs.filter(isPlainObject) : [];
  const toggles = new Map<string, string>();
  for (const step of steps) {
    if (!Object.hasOwn(step, "optional")) continue;
    const optional = step.optional;
    const stepId = String(step.id);
    if (
      !isPlainObject(optional) ||
      !hasOnlyKeys(optional, ["input"]) ||
      typeof optional.input !== "string" ||
      optional.input.length === 0
    ) {
      errors.push(`step ${stepId} optional must name exactly one toggle input`);
      continue;
    }
    const name = optional.input;
    const input = inputs.find((entry) => entry.name === name);
    if (input === undefined) {
      errors.push(`step ${stepId} is toggled by unknown input ${name}`);
    } else if (input.type !== "boolean" || input.default !== true) {
      errors.push(`step ${stepId} toggle input ${name} must be a boolean defaulting to true`);
    }
    // A segment step may be skipped only when it is the chain's one setup that nothing else needs.
    const callable = isPlainObject(step.callable) ? step.callable : undefined;
    const program = isPlainObject(callable?.program) ? callable.program : undefined;
    if (
      Object.hasOwn(step, "segment") &&
      (typeof program?.source !== "string" || !isOptionalSetupSegment(program.source))
    ) {
      errors.push(
        `step ${stepId} is a segment that only a mkdir -p setup segment may make optional`,
      );
    }
    const other = toggles.get(name);
    if (other !== undefined) {
      errors.push(`input ${name} toggles both step ${other} and step ${stepId}`);
    } else {
      toggles.set(name, stepId);
    }
  }
  if (toggles.size === 0) return;
  const optionalSteps = new Set(toggles.values());
  const optionalCalls = new Set(
    steps
      .filter((step) => optionalSteps.has(String(step.id)) && typeof step.callId === "string")
      .map((step) => String(step.callId)),
  );
  const reported = new Set<string>();
  const report = (message: string): void => {
    if (reported.has(message)) return;
    reported.add(message);
    errors.push(message);
  };
  // A structural walk over every binding shape: templates (`type`) and sources/proposals (`kind`).
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, where);
      return;
    }
    if (!isPlainObject(node)) return;
    const shape = typeof node.type === "string" ? node.type : node.kind;
    // Recorded literal values are data, not bindings.
    if (shape === "literal") return;
    if ((shape === "result" || shape === "extract") && typeof node.stepId === "string") {
      if (optionalSteps.has(node.stepId)) {
        report(`${where} binds the result of optional step ${node.stepId}`);
      }
    }
    if (shape === "input" && typeof node.name === "string" && toggles.has(node.name)) {
      report(`${where} uses toggle input ${node.name} outside its toggle`);
    }
    for (const entry of Object.values(node)) walk(entry, where);
  };
  for (const step of steps) {
    walk(step.arguments, `step ${String(step.id)}`);
    const callable = isPlainObject(step.callable) ? step.callable : undefined;
    const program = isPlainObject(callable?.program) ? callable.program : undefined;
    const state = isPlainObject(program?.pythonState) ? program.pythonState : undefined;
    for (const descriptor of Array.isArray(state?.setup) ? state.setup : []) {
      if (isPlainObject(descriptor) && optionalCalls.has(String(descriptor.callId))) {
        report(`step ${String(step.id)} replays setup from an optional step`);
      }
    }
  }
  if (Array.isArray(workflow.candidates)) {
    for (const candidate of workflow.candidates) {
      if (isPlainObject(candidate)) walk(candidate.proposed, "candidate");
    }
  }
}

/**
 * Segment steps of one recorded chain: steps sharing a callId are exactly its segments `0..count-1`,
 * adjacent and in order, of one shell program, one count and one splitter version; no step shares
 * a callId otherwise, and nothing reads a segment's result but the chain's last segment's.
 */
/** Whether a value is a segment address: an index below a count of two or more, and a version. */
function isSegmentAddress(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, ["index", "count", "version"]) &&
    Number.isSafeInteger(value.index) &&
    Number.isSafeInteger(value.count) &&
    Number.isSafeInteger(value.version) &&
    (value.count as number) >= 2 &&
    (value.index as number) >= 0 &&
    (value.index as number) < (value.count as number)
  );
}

function validateWorkflowSegments(workflow: Record<string, unknown>, errors: string[]): void {
  const steps = Array.isArray(workflow.steps) ? workflow.steps.filter(isPlainObject) : [];
  // A held-out call names where it ran the step: a segment of its own chain, or the whole call.
  const heldOut = isPlainObject(workflow.heldOut) ? workflow.heldOut : undefined;
  for (const entry of Array.isArray(heldOut?.calls) ? heldOut.calls : []) {
    if (!isPlainObject(entry)) continue;
    const step = steps.find((candidate) => candidate.id === entry.stepId);
    const segmented = step !== undefined && Object.hasOwn(step, "segment");
    const segments = entry.segments;
    if (segments === undefined && !segmented) continue;
    if (
      !Array.isArray(segments) ||
      !Array.isArray(entry.callIds) ||
      segments.length !== entry.callIds.length ||
      !segments.every((address) => address === null || isSegmentAddress(address))
    ) {
      errors.push(
        `heldOut.calls entry for step ${String(entry.stepId)} needs one segment address or null per call`,
      );
    }
  }
  const nonFinal = new Set<string>();
  const seen = new Set<string>();
  for (let position = 0; position < steps.length; position += 1) {
    const step = steps[position]!;
    const stepId = String(step.id);
    const callId = step.callId;
    const sharing = steps.filter((other) => other !== step && other.callId === callId);
    if (!Object.hasOwn(step, "segment")) {
      if (sharing.length > 0) errors.push(`step ${stepId} shares its callId with another step`);
      continue;
    }
    const segment = step.segment;
    const callable = isPlainObject(step.callable) ? step.callable : undefined;
    const program = isPlainObject(callable?.program) ? callable.program : undefined;
    if (
      !isPlainObject(segment) ||
      !hasOnlyKeys(segment, ["index", "count", "version"]) ||
      !Number.isSafeInteger(segment.index) ||
      !Number.isSafeInteger(segment.count) ||
      !Number.isSafeInteger(segment.version) ||
      (segment.count as number) < 2 ||
      (segment.index as number) < 0 ||
      (segment.index as number) >= (segment.count as number) ||
      program?.kind !== "shell" ||
      // Only a POSIX program (or one recorded before dialects were) splits into `&&` segments.
      recordedProgramLanguage(program as WorkflowRecordedProgram) !== "shell"
    ) {
      errors.push(
        `step ${stepId} segment must be an index below a count of two or more of a shell program`,
      );
      continue;
    }
    const programArgument = Array.isArray(step.arguments)
      ? step.arguments.find((entry) => isPlainObject(entry) && entry.name === program.argument)
      : undefined;
    const source = isPlainObject(programArgument) ? programArgument.source : undefined;
    const template =
      isPlainObject(source) && source.kind === "template" ? source.template : undefined;
    // A segment runs its own text of the recorded chain, sliced from the chain's original source,
    // so its program argument must be the projected program naming that source.
    if (
      !isPlainObject(template) ||
      template.type !== "program" ||
      typeof template.sourceReference !== "string" ||
      !isPlainObject(template.source) ||
      template.source.type !== "literal" ||
      template.source.value !== program.source
    ) {
      errors.push(`step ${stepId} segment must carry its projected program text`);
      continue;
    }
    if (seen.has(String(callId))) continue;
    seen.add(String(callId));
    // From splitter version 2 a plan may leave out a segment of its own chain the recording device
    // finds skippable (`isSkippableSegment`): the steps it names stay adjacent, in order, one count
    // and one version. Only the device holds the left-out text, so the device checks it.
    const gaps = (segment.version as number) >= 2;
    const chain = steps.slice(position, position + sharing.length + 1);
    const whole =
      (gaps || chain.length === segment.count) &&
      chain.length <= (segment.count as number) &&
      chain.every(
        (other, index) =>
          other.callId === callId &&
          isPlainObject(other.segment) &&
          Number.isSafeInteger(other.segment.index) &&
          (gaps
            ? index === 0 ||
              (other.segment.index as number) >
                (chain[index - 1]!.segment as { index: number }).index
            : other.segment.index === index) &&
          other.segment.count === segment.count &&
          other.segment.version === segment.version,
      );
    if (!whole) {
      errors.push(
        gaps
          ? `call ${String(callId)} must be split into its segments, adjacent and in order`
          : `call ${String(callId)} must be split into all its segments, adjacent and in order`,
      );
      continue;
    }
    // A chain printed its output once, after its last segment: only that segment's result is read.
    for (const other of chain) {
      if ((other.segment as { index: number }).index < (segment.count as number) - 1)
        nonFinal.add(String(other.id));
    }
  }
  if (nonFinal.size === 0) return;
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, where);
      return;
    }
    if (!isPlainObject(node)) return;
    const shape = typeof node.type === "string" ? node.type : node.kind;
    if (shape === "literal") return;
    if (
      (shape === "result" || shape === "extract") &&
      typeof node.stepId === "string" &&
      nonFinal.has(node.stepId)
    ) {
      errors.push(`${where} binds the result of segment step ${node.stepId}, not its chain's last`);
    }
    for (const entry of Object.values(node)) walk(entry, where);
  };
  for (const step of steps) walk(step.arguments, `step ${String(step.id)}`);
  if (Array.isArray(workflow.candidates)) {
    for (const candidate of workflow.candidates) {
      if (isPlainObject(candidate)) walk(candidate.proposed, "candidate");
    }
  }
}

/**
 * The rules only a derivation step obeys (see `WorkflowStep.origin`). Input names and hole shapes
 * are also checked by the general argument walk; this adds what makes model-authored source safe to
 * carry: nothing private, nothing recorded, nothing but caller inputs flowing in.
 */
function validateDerivationStep(step: Record<string, unknown>, errors: string[]): void {
  const where = `derivation step ${String(step.id)}`;
  const callable = isPlainObject(step.callable) ? step.callable : undefined;
  const program = isPlainObject(callable?.program) ? callable.program : undefined;
  if (
    callable?.runtime !== WORKFLOW_DERIVATION_RUNTIME ||
    program === undefined ||
    program.kind !== "python" ||
    program.sourceInterface !== "python-eval" ||
    typeof program.argument !== "string" ||
    typeof program.source !== "string" ||
    program.source.length === 0 ||
    program.argv !== undefined ||
    program.pythonState !== undefined
  ) {
    errors.push(
      `${where} must be a Python Eval program in the ${WORKFLOW_DERIVATION_RUNTIME} runtime, carried in a named argument`,
    );
    return;
  }
  const observed = isPlainObject(step.observed) ? step.observed : undefined;
  if (observed?.outcome !== "unknown" || observed.output !== undefined) {
    errors.push(`${where} must not claim an observed outcome`);
  }
  if (!Array.isArray(step.dependsOn) || step.dependsOn.length !== 0) {
    errors.push(`${where} must not depend on other steps`);
  }
  const args = Array.isArray(step.arguments) ? step.arguments : [];
  for (const argument of args) {
    if (!isPlainObject(argument)) continue;
    const source = isPlainObject(argument.source) ? argument.source : undefined;
    if (argument.name !== program.argument) {
      if (source?.kind !== "literal") {
        errors.push(`${where} argument ${String(argument.name)} must be a literal`);
      }
      continue;
    }
    const template = source?.kind === "template" ? source.template : undefined;
    if (
      !isPlainObject(template) ||
      template.type !== "program" ||
      template.language !== "python" ||
      template.sourceReference !== undefined ||
      template.protectedTokens !== undefined ||
      !isPlainObject(template.source) ||
      template.source.type !== "literal" ||
      template.source.value !== program.source ||
      !Array.isArray(template.holes)
    ) {
      errors.push(
        `${where} must carry its source as a literal program template equal to its program source`,
      );
      continue;
    }
    const holes = template.holes;
    if (holes.length === 0) {
      errors.push(`${where} must read at least one caller input`);
    }
    for (const hole of holes) {
      if (
        !isPlainObject(hole) ||
        hole.embedded !== undefined ||
        hole.span !== undefined ||
        !isPlainObject(hole.binding) ||
        hole.binding.type !== "input"
      ) {
        errors.push(`${where} may bind only whole tokens to caller inputs`);
      }
    }
  }
  if (
    !args.some(
      (argument) =>
        isPlainObject(argument) &&
        argument.name === program.argument &&
        isPlainObject(argument.source) &&
        argument.source.kind === "template",
    )
  ) {
    errors.push(`${where} must carry its source in argument ${program.argument}`);
  }
}

/**
 * Validates a recorded workflow structurally.
 *
 * Structural only on purpose: nothing here inspects callable names, applications, or task
 * categories. What makes a workflow compilable is that its calls, arguments and connections are
 * representable — not which tools it happens to use.
 */
export function validateRecordedWorkflow(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["workflow must be an object"] };
  if (value.schemaVersion !== RECORDED_WORKFLOW_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (typeof value.workflowId !== "string" || value.workflowId.length === 0) {
    errors.push("workflowId must be a non-empty string");
  }
  const inputs = Array.isArray(value.inputs) ? value.inputs : null;
  if (!inputs) errors.push("inputs must be an array");
  const inputNames = new Set<string>();
  const inputTypes = new Map<string, string>();
  const recordedDefaults = new Set<string>();
  for (const input of inputs ?? []) {
    if (!isPlainObject(input) || typeof input.name !== "string" || input.name.length === 0) {
      errors.push("every input needs a non-empty name");
      continue;
    }
    if (inputNames.has(input.name)) errors.push(`duplicate input: ${input.name}`);
    inputNames.add(input.name);
    if (
      input.type !== "string" &&
      input.type !== "number" &&
      input.type !== "boolean" &&
      input.type !== "object" &&
      input.type !== "array"
    ) {
      errors.push(`input ${input.name} needs a recorded type`);
    } else {
      inputTypes.set(input.name, input.type);
      if (Object.hasOwn(input, "default")) {
        if (!isJsonValue(input.default)) {
          errors.push(`input ${input.name} default must be a JSON value`);
        } else if (!matchesWorkflowInputType(input.default, input.type)) {
          errors.push(`input ${input.name} default must match its recorded type '${input.type}'`);
        }
      }
      if (Object.hasOwn(input, "recordedDefault")) {
        if (input.recordedDefault !== true) {
          errors.push(`input ${input.name} recordedDefault must be true when present`);
        } else if (Object.hasOwn(input, "default")) {
          errors.push(`input ${input.name} cannot have both a default and a recorded default`);
        } else {
          recordedDefaults.add(input.name);
        }
      }
    }
  }
  const declaredPrivates = new Set<string>();
  const privateReferences = (value as { privateReferences?: unknown }).privateReferences;
  if (privateReferences !== undefined) {
    if (!Array.isArray(privateReferences)) {
      errors.push("privateReferences must be an array when present");
    } else {
      for (const reference of privateReferences) {
        if (typeof reference !== "string" || reference.length === 0) {
          errors.push("every private reference must be a non-empty string");
          continue;
        }
        declaredPrivates.add(reference);
      }
    }
  }
  const steps = Array.isArray(value.steps) ? value.steps : null;
  if (!steps || steps.length === 0) errors.push("steps must be a non-empty array");
  const workflowCallIds = new Set<string>();
  for (const step of steps ?? []) {
    if (isPlainObject(step) && typeof step.callId === "string" && step.callId.length > 0) {
      workflowCallIds.add(step.callId);
    }
  }
  const stepIds = new Set<string>();
  for (const step of steps ?? []) {
    if (!isPlainObject(step) || typeof step.id !== "string" || step.id.length === 0) {
      errors.push("every step needs a non-empty id");
      continue;
    }
    if (stepIds.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    stepIds.add(step.id);
    if (typeof step.callId !== "string" || step.callId.length === 0) {
      errors.push(`step ${step.id} needs the callId it was recorded from`);
    }
    const callable = step.callable;
    if (
      !isPlainObject(callable) ||
      typeof callable.runtime !== "string" ||
      typeof callable.name !== "string" ||
      callable.name.length === 0
    ) {
      errors.push(`step ${step.id} needs a callable with a runtime and a recorded name`);
    }
    const failurePolicy = (step as { failurePolicy?: unknown }).failurePolicy;
    if (
      !isPlainObject(failurePolicy) ||
      (failurePolicy.onError !== "abort" && failurePolicy.onError !== "continue") ||
      (failurePolicy.policy !== "recorded" && failurePolicy.policy !== "default")
    ) {
      errors.push(`step ${step.id} needs a failurePolicy with onError and policy`);
    }
    const observed = (step as { observed?: unknown }).observed;
    if (
      !isPlainObject(observed) ||
      (observed.outcome !== "succeeded" &&
        observed.outcome !== "failed" &&
        observed.outcome !== "unknown")
    ) {
      errors.push(`step ${step.id} needs an observed outcome`);
    }
    if (isPlainObject(observed) && observed.output !== undefined) {
      const output = observed.output;
      if (
        !isPlainObject(output) ||
        Object.keys(output).some((key) => key !== "type" && key !== "hasContent") ||
        !["null", "boolean", "number", "string", "array", "object"].includes(
          output.type as string,
        ) ||
        typeof output.hasContent !== "boolean"
      )
        errors.push(`step ${step.id} has an invalid observed output`);
    }
    const permissions = (step as { permissions?: unknown }).permissions;
    if (permissions !== undefined && !isJsonValue(permissions)) {
      errors.push(`step ${step.id} permissions must be JSON`);
    }
    const origin = step.origin;
    if (origin !== undefined && origin !== "recorded" && origin !== "derivation") {
      errors.push(`step ${step.id} has an unknown origin ${String(origin)}`);
    }
    if (origin === "derivation") {
      validateDerivationStep(step, errors);
    }
  }
  // Dependencies and bindings may only address steps that exist and come earlier.
  const order = new Map<string, number>();
  (steps ?? []).forEach((step, index) => {
    if (isPlainObject(step) && typeof step.id === "string") order.set(step.id, index);
  });
  const derivationIds = new Set<string>();
  for (const step of steps ?? []) {
    if (isPlainObject(step) && typeof step.id === "string" && step.origin === "derivation") {
      derivationIds.add(step.id);
    }
  }
  for (const step of steps ?? []) {
    if (!isPlainObject(step) || typeof step.id !== "string") continue;
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn : null;
    if (!dependsOn) {
      errors.push(`step ${step.id} dependsOn must be an array`);
    }
    for (const dependency of dependsOn ?? []) {
      if (typeof dependency !== "string" || !order.has(dependency)) {
        errors.push(`step ${step.id} depends on unknown step ${String(dependency)}`);
        continue;
      }
      if ((order.get(dependency) ?? 0) >= (order.get(step.id) ?? 0)) {
        errors.push(`step ${step.id} depends on ${dependency}, which does not come earlier`);
      }
    }
    const args = Array.isArray(step.arguments) ? step.arguments : null;
    if (!args) {
      errors.push(`step ${step.id} arguments must be an array`);
      continue;
    }
    for (const argument of args) {
      if (!isPlainObject(argument) || typeof argument.name !== "string") {
        errors.push(`step ${step.id} has an argument without a name`);
        continue;
      }
      const source = argument.source;
      if (!isPlainObject(source) || typeof source.kind !== "string") {
        errors.push(`step ${step.id} argument ${argument.name} needs a value source`);
        continue;
      }
      if (source.kind === "input" && !inputNames.has(String(source.name))) {
        errors.push(
          `step ${step.id} argument ${argument.name} reads unknown input ${String(source.name)}`,
        );
      } else if (source.kind === "input" && recordedDefaults.has(String(source.name))) {
        errors.push(
          `step ${step.id} argument ${argument.name} reads recorded-default input ${String(source.name)} outside a program token`,
        );
      }
      if (source.kind === "result") {
        const stepRef = String(source.stepId);
        if (!order.has(stepRef)) {
          errors.push(`step ${step.id} argument ${argument.name} reads unknown step ${stepRef}`);
        } else if ((order.get(stepRef) ?? 0) >= (order.get(step.id) ?? 0)) {
          errors.push(
            `step ${step.id} argument ${argument.name} reads ${stepRef}, which does not come earlier`,
          );
        }
        const path = source.path;
        if (
          !Array.isArray(path) ||
          !path.every((part) => typeof part === "string" || typeof part === "number")
        ) {
          errors.push(`step ${step.id} argument ${argument.name} has an invalid result path`);
        }
      }
      if (source.kind === "literal" && !isJsonValue(source.value)) {
        errors.push(`step ${step.id} argument ${argument.name} has a non-JSON literal`);
      }
      if (source.kind === "unresolved" && typeof source.reason !== "string") {
        errors.push(
          `step ${step.id} argument ${argument.name} needs a reason for its unknown origin`,
        );
      }
      if (source.kind === "template") {
        const problems: string[] = [];
        const walk = (template: unknown, where: string, holeBinding = false): void => {
          if (!isPlainObject(template)) {
            problems.push(`${where} is not a template node`);
            return;
          }
          switch (template.type) {
            case "literal":
              if (!isJsonValue(template.value)) problems.push(`${where} has a non-JSON literal`);
              return;
            case "input":
              if (typeof template.name !== "string" || !inputNames.has(template.name)) {
                problems.push(`${where} reads unknown input ${String(template.name)}`);
              } else if (recordedDefaults.has(template.name) && !holeBinding) {
                problems.push(
                  `${where} reads recorded-default input ${template.name} outside a program token`,
                );
              }
              return;
            case "result": {
              const stepRef = typeof template.stepId === "string" ? template.stepId : "";
              if (!order.has(stepRef)) problems.push(`${where} reads unknown step ${stepRef}`);
              else if (
                (order.get(stepRef) ?? 0) >=
                (order.get(
                  typeof (step as { id?: unknown }).id === "string"
                    ? (step as { id: string }).id
                    : "",
                ) ?? 0)
              ) {
                problems.push(`${where} reads ${stepRef}, which does not come earlier`);
              }
              return;
            }
            case "private":
              if (
                typeof template.reference !== "string" ||
                !declaredPrivates.has(template.reference)
              ) {
                problems.push(
                  `${where} reads undeclared private reference ${String(template.reference)}`,
                );
              }
              return;
            case "extract": {
              const stepRef = typeof template.stepId === "string" ? template.stepId : "";
              if (!order.has(stepRef))
                problems.push(`${where} extracts from unknown step ${stepRef}`);
              else if ((order.get(stepRef) ?? 0) >= (order.get(String(step.id)) ?? 0)) {
                problems.push(`${where} extracts from ${stepRef}, which does not come earlier`);
              }
              if (typeof template.locator !== "string" || !declaredPrivates.has(template.locator)) {
                problems.push(
                  `${where} reads undeclared private reference ${String(template.locator)}`,
                );
              }
              return;
            }
            case "unresolved":
              if (typeof template.reason !== "string") problems.push(`${where} needs a reason`);
              return;
            case "object": {
              if (!isPlainObject(template.entries)) {
                problems.push(`${where} object entries must be an object`);
                return;
              }
              for (const [key, entry] of Object.entries(template.entries)) {
                walk(entry, `${where}.${key}`);
              }
              return;
            }
            case "array": {
              if (!Array.isArray(template.items)) {
                problems.push(`${where} array items must be an array`);
                return;
              }
              template.items.forEach((entry, index) => walk(entry, `${where}[${index}]`));
              return;
            }
            case "program": {
              if (
                template.language !== "shell" &&
                template.language !== "powershell" &&
                template.language !== "pwsh" &&
                template.language !== "python" &&
                template.language !== "javascript" &&
                template.language !== "typescript" &&
                template.language !== "patch"
              ) {
                problems.push(`${where} program needs the language it runs in`);
              }
              validateWorkflowProgramProjection(template, where, problems);
              if (
                Object.prototype.hasOwnProperty.call(template, "sourceReference") &&
                typeof template.sourceReference === "string" &&
                template.sourceReference.length > 0 &&
                !declaredPrivates.has(template.sourceReference)
              ) {
                problems.push(
                  `${where} reads undeclared private reference ${template.sourceReference}`,
                );
              }
              if (!isPlainObject(template.source)) {
                problems.push(`${where} program needs the recorded text it resolves`);
              } else {
                walk(template.source, `${where}<text>`);
              }
              if (!Array.isArray(template.holes)) {
                problems.push(`${where} program holes must be an array`);
                return;
              }
              const spansByToken = new Map<string, Array<{ start: number; end: number } | null>>();
              for (const [index, hole] of template.holes.entries()) {
                if (
                  !isPlainObject(hole) ||
                  typeof hole.token !== "number" ||
                  !Number.isInteger(hole.token) ||
                  hole.token < 0
                ) {
                  problems.push(`${where} hole ${index} must name a recorded token index`);
                  continue;
                }
                if (
                  hole.embedded !== undefined &&
                  (typeof hole.embedded !== "number" ||
                    !Number.isInteger(hole.embedded) ||
                    hole.embedded < 0 ||
                    template.language !== "shell")
                ) {
                  problems.push(`${where} hole ${index} must name an embedded token index`);
                  continue;
                }
                if (
                  hole.span !== undefined &&
                  (!isPlainObject(hole.span) ||
                    typeof hole.span.start !== "number" ||
                    typeof hole.span.end !== "number" ||
                    !Number.isInteger(hole.span.start) ||
                    !Number.isInteger(hole.span.end) ||
                    hole.span.start < 0 ||
                    hole.span.start >= hole.span.end)
                ) {
                  problems.push(`${where} hole ${index} must name a span of its token value`);
                  continue;
                }
                const key = `${hole.token}.${String(hole.embedded ?? "")}`;
                const span =
                  hole.span === undefined
                    ? null
                    : {
                        start: hole.span.start as number,
                        end: hole.span.end as number,
                      };
                const siblings = spansByToken.get(key) ?? [];
                if (
                  siblings.some(
                    (other) =>
                      other === null ||
                      span === null ||
                      (other.start < span.end && span.start < other.end),
                  )
                ) {
                  problems.push(`${where} hole ${index} overlaps another hole of its token`);
                }
                spansByToken.set(key, [...siblings, span]);
                if (
                  span !== null &&
                  isPlainObject(template.source) &&
                  template.source.type === "literal" &&
                  typeof template.source.value === "string" &&
                  typeof template.language === "string"
                ) {
                  const value = programTokenValueAt(
                    template.language as ProgramLanguage,
                    template.source.value,
                    typeof hole.embedded === "number"
                      ? { token: hole.token, embedded: hole.embedded }
                      : { token: hole.token },
                  );
                  if (typeof value !== "string" || !programTokenSpanFits(span, value.length)) {
                    problems.push(`${where} hole ${index} span does not fit its token value`);
                  }
                }
                walk(
                  hole.binding,
                  hole.embedded === undefined
                    ? `${where}<token ${hole.token}>`
                    : `${where}<token ${hole.token}.${hole.embedded}>`,
                  true,
                );
              }
              return;
            }
            default:
              problems.push(`${where} has unknown template type ${String(template.type)}`);
          }
        };
        walk(source.template, `step ${step.id} argument ${argument.name}`);
        errors.push(...problems);
      }
      if (source.kind === "private") {
        if (typeof source.reference !== "string" || source.reference.length === 0) {
          errors.push(`step ${step.id} argument ${argument.name} needs a private reference`);
        } else if (!declaredPrivates.has(source.reference)) {
          errors.push(
            `step ${step.id} argument ${argument.name} reads undeclared private reference '${source.reference}'`,
          );
        }
      }
      const provenance = argument.provenance;
      if (provenance !== undefined) {
        if (
          !isPlainObject(provenance) ||
          (provenance.standing !== "recorded" &&
            provenance.standing !== "derived" &&
            provenance.standing !== "candidate") ||
          typeof provenance.rule !== "string"
        ) {
          errors.push(`step ${step.id} argument ${argument.name} has an invalid provenance`);
        } else if (provenance.standing === "candidate" && typeof provenance.missing !== "string") {
          // A candidate that does not name what the record is missing is not reportable.
          errors.push(
            `step ${step.id} argument ${argument.name} is a candidate without the missing fact`,
          );
        }
      }
    }
    const callable = step.callable;
    const program = isPlainObject(callable) ? callable.program : undefined;
    if (program !== undefined) {
      if (
        !isPlainObject(program) ||
        (program.kind !== "shell" &&
          program.kind !== "python" &&
          program.kind !== "javascript" &&
          program.kind !== "typescript" &&
          program.kind !== "patch") ||
        typeof program.source !== "string"
      ) {
        errors.push(`step ${step.id} has an invalid recorded program`);
      } else if (
        program.source.length === 0 &&
        (!Array.isArray(program.argv) || program.argv.length === 0) &&
        typeof program.argument !== "string"
      ) {
        errors.push(
          `step ${step.id} records neither a program source, an argument vector, nor the argument the program arrives in`,
        );
      } else if (
        (program.dialect !== undefined &&
          (program.kind !== "shell" || !isShellDialect(program.dialect))) ||
        (program.unprovenDialect !== undefined &&
          (program.kind !== "shell" ||
            program.unprovenDialect !== true ||
            program.dialect !== undefined))
      ) {
        errors.push(`step ${step.id} has an invalid recorded shell dialect`);
      } else {
        validateWorkflowProgramSourceInterface(program, step.id, errors);
        validateWorkflowPythonState(
          program,
          step.id,
          typeof step.callId === "string" ? step.callId : undefined,
          workflowCallIds,
          declaredPrivates,
          errors,
        );
        validateProgramArgumentLanguage(
          step.id,
          program as WorkflowRecordedProgram,
          args.find((entry) => isPlainObject(entry) && entry.name === program.argument),
          errors,
        );
      }
    }
    if (
      isPlainObject(program) &&
      typeof program.argument === "string" &&
      typeof program.source === "string"
    ) {
      const argument = args.find(
        (entry) => isPlainObject(entry) && entry.name === program.argument,
      );
      const argumentSource = isPlainObject(argument) ? argument.source : undefined;
      const template =
        isPlainObject(argumentSource) && argumentSource.kind === "template"
          ? argumentSource.template
          : undefined;
      if (
        isPlainObject(template) &&
        template.type === "program" &&
        Object.prototype.hasOwnProperty.call(template, "sourceReference") &&
        Object.prototype.hasOwnProperty.call(template, "protectedTokens") &&
        isPlainObject(template.source) &&
        template.source.type === "literal" &&
        typeof template.source.value === "string" &&
        template.source.value !== program.source
      ) {
        errors.push(
          `step ${step.id} recorded program source differs from projected argument ${program.argument}`,
        );
      }
    }
  }
  // A candidate addresses a real argument of a real step, and never executes.
  const candidates = value.candidates;
  if (candidates !== undefined) {
    if (!Array.isArray(candidates)) {
      errors.push("candidates must be an array when present");
    } else {
      for (const candidate of candidates) {
        if (!isPlainObject(candidate) || typeof candidate.argument !== "string") {
          errors.push("every candidate needs a step and an argument");
          continue;
        }
        const stepId = typeof candidate.stepId === "string" ? candidate.stepId : "";
        if (!order.has(stepId)) {
          errors.push(`candidate names unknown step ${stepId}`);
          continue;
        }
        const step = (steps ?? []).find((entry) => isPlainObject(entry) && entry.id === stepId);
        const args = isPlainObject(step) && Array.isArray(step.arguments) ? step.arguments : [];
        if (!args.some((entry) => isPlainObject(entry) && entry.name === candidate.argument)) {
          errors.push(`candidate ${stepId}.${candidate.argument} names no such argument`);
        }
        // A token path addresses the text of the program the step's own record names; a token that
        // points anywhere else would be applied to a value no tokenizer has read.
        const path = Array.isArray(candidate.path) ? candidate.path : [];
        if (path[0] === "tokens") {
          const address = programTokenPath(path);
          const recorded =
            isPlainObject(step) && isPlainObject(step.callable) ? step.callable.program : undefined;
          const language = isPlainObject(recorded)
            ? recordedProgramLanguage(recorded as WorkflowRecordedProgram)
            : undefined;
          if (
            address === undefined ||
            (address.embedded !== undefined && isPlainObject(recorded) && language !== "shell")
          ) {
            errors.push(`candidate ${stepId}.${candidate.argument} has an invalid token position`);
          }
          if (!isPlainObject(recorded) || recorded.argument !== candidate.argument) {
            errors.push(
              `candidate ${stepId}.${candidate.argument} names a token of a program the step's record does not hold in that argument`,
            );
          } else {
            const notLearnable = programNotLearnableReason(recorded as WorkflowRecordedProgram);
            if (notLearnable !== undefined) {
              errors.push(`candidate ${stepId}.${candidate.argument}: ${notLearnable}`);
            }
          }
        }
        const proposed = candidate.proposed;
        if (!isPlainObject(proposed) || typeof proposed.kind !== "string") {
          errors.push(`candidate ${stepId}.${candidate.argument} needs a proposal`);
        } else if (proposed.kind === "result") {
          const stepRef = String(proposed.stepId);
          if (!order.has(stepRef)) {
            errors.push(`candidate ${stepId}.${candidate.argument} reads unknown step ${stepRef}`);
          }
        } else if (proposed.kind === "extract") {
          const stepRef = String(proposed.stepId);
          if (!order.has(stepRef)) {
            errors.push(`candidate ${stepId}.${candidate.argument} reads unknown step ${stepRef}`);
          } else if ((order.get(stepRef) ?? 0) >= (order.get(stepId) ?? 0)) {
            errors.push(
              `candidate ${stepId}.${candidate.argument} extracts from ${stepRef}, which does not come earlier`,
            );
          }
          if (typeof proposed.locator !== "string" || !declaredPrivates.has(proposed.locator)) {
            errors.push(
              `candidate ${stepId}.${candidate.argument} reads undeclared private reference ${String(proposed.locator)}`,
            );
          }
        } else if (proposed.kind === "input") {
          if (typeof proposed.name !== "string" || proposed.name.length === 0) {
            errors.push(`candidate ${stepId}.${candidate.argument} needs an input name`);
          }
          if (
            Object.hasOwn(proposed, "recordedDefault") &&
            (proposed.recordedDefault !== true || path[0] !== "tokens")
          ) {
            errors.push(
              `candidate ${stepId}.${candidate.argument} may propose a recorded default only for a program token`,
            );
          }
          if (
            proposed.type !== "string" &&
            proposed.type !== "number" &&
            proposed.type !== "boolean" &&
            proposed.type !== "object" &&
            proposed.type !== "array" &&
            proposed.type !== "unknown"
          ) {
            errors.push(`candidate ${stepId}.${candidate.argument} needs an input type`);
          }
        } else {
          errors.push(`candidate ${stepId}.${candidate.argument} has an unknown proposal kind`);
        }
        if (
          candidate.reason !== "equal-to-earlier-result" &&
          candidate.reason !== "tracks-earlier-result-across-executions" &&
          candidate.reason !== "varies-across-executions" &&
          candidate.reason !== "declared-by-the-callable" &&
          candidate.reason !== "shares-value-with-declared-input" &&
          candidate.reason !== "classified-source-value" &&
          candidate.reason !== "printed-by-earlier-step" &&
          candidate.reason !== "native-data-argument" &&
          candidate.reason !== "derived-from-inputs"
        )
          errors.push(`candidate ${stepId}.${candidate.argument} has an unknown reason`);
        // A derivation's output binds only recorded program tokens, only under its own reason, by
        // one top-level name; nothing is ever bound into a derivation's own code.
        const readsDerivation =
          isPlainObject(proposed) &&
          proposed.kind === "result" &&
          derivationIds.has(String(proposed.stepId));
        if (derivationIds.has(stepId)) {
          errors.push(`candidate ${stepId}.${candidate.argument} binds into a derivation step`);
        }
        if (readsDerivation !== (candidate.reason === "derived-from-inputs")) {
          errors.push(
            `candidate ${stepId}.${candidate.argument} must read a derivation step exactly when its reason is derived-from-inputs`,
          );
        } else if (readsDerivation && isPlainObject(proposed)) {
          const stepRef = String(proposed.stepId);
          if ((order.get(stepRef) ?? 0) >= (order.get(stepId) ?? 0)) {
            errors.push(
              `candidate ${stepId}.${candidate.argument} reads derivation ${stepRef}, which does not come earlier`,
            );
          }
          if (
            !Array.isArray(proposed.path) ||
            proposed.path.length !== 1 ||
            typeof proposed.path[0] !== "string" ||
            proposed.path[0].length === 0
          ) {
            errors.push(
              `candidate ${stepId}.${candidate.argument} must read one named value of its derivation`,
            );
          }
          if (path[0] !== "tokens") {
            errors.push(
              `candidate ${stepId}.${candidate.argument} may bind a derived value only to a program token`,
            );
          }
        }
        if (typeof candidate.missing !== "string" || candidate.missing.length === 0) {
          errors.push(
            `candidate ${stepId}.${candidate.argument} must name the fact the record is missing`,
          );
        }
      }
    }
  }
  // Demonstration references and baseline references are local only; neither carries values.
  if (value.baseline !== undefined) {
    validateDemonstration("baseline", value.baseline, order, declaredPrivates, errors);
  }
  if (value.heldOut !== undefined) {
    validateDemonstration("heldOut", value.heldOut, order, declaredPrivates, errors);
  }
  validateWorkflowOptionalSteps(value, errors);
  validateWorkflowSegments(value, errors);
  // A derivation was never executed by the recording, so no demonstration can have observed it.
  for (const label of ["baseline", "heldOut"] as const) {
    const demonstration = value[label];
    if (!isPlainObject(demonstration)) continue;
    for (const list of [demonstration.inputs, demonstration.observed, demonstration.calls]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (isPlainObject(entry) && derivationIds.has(String(entry.stepId))) {
          errors.push(`${label} references derivation step ${String(entry.stepId)}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
