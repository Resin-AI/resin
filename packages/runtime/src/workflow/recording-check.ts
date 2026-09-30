/**
 * Checking a plan against the device's own recording, without running anything the recording ran.
 *
 * Each recorded step is resolved exactly as an invocation resolves it — templates, holes, inputs,
 * extracts and derivation outputs — and the resolved call is then compared with the call the
 * recording made for that step: the same callable, and every argument that reaches what the call
 * runs equal to the recorded value.
 * A match answers with what the recording observed that call produce. A mismatch, or a step the
 * recording has no call for, fails the step. Nothing is spawned, dispatched or written: the only
 * code a check runs is a model-written derivation step, through the adapter the caller supplies.
 */

import path from "node:path";
import {
  type ProgramTokenAddress,
  type ShellDialect,
  type WorkflowJsonValue,
  type WorkflowStep,
  type WorkflowValuePath,
  type WorkflowValueTemplate,
  programTokenPath,
} from "@resin/contracts";
import {
  type RecordedCallRequest,
  type RuntimeAdapter,
  RuntimeAdapterRegistry,
} from "./recorded-workflow.js";
import {
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
} from "./runtime-families.js";

/** One call as this device recorded it, read from its own store under references it computed. */
export interface RecordedCall {
  callable: {
    name: string;
    connection?: string;
    program?: {
      kind: string;
      argument: string;
      /** The shell dialect the recording proved the program ran in. */
      dialect?: ShellDialect;
      /** A shell program whose dialect the recording did not prove. */
      unprovenDialect?: true;
    };
  };
  arguments: Record<string, WorkflowJsonValue>;
  result: WorkflowJsonValue;
  /** Whether secret redaction removed part of this output from its upload's view. */
  resultRedacted?: boolean;
  /**
   * Argument positions whose recorded value first appeared in an earlier step's recorded output.
   * A plan that still carries such a position as literal recorded text depends on a value it does
   * not read, so it is refused rather than verified.
   */
  hiddenDependencies: ReadonlyArray<{ argument: string; path: WorkflowValuePath }>;
  /**
   * Argument positions whose recorded value the upload kept private. Those secret redaction removed
   * (`redacted`, the default) the cloud never saw in any form. The plan must read each one from this device (a `private`
   * reference, an input, or a recorded step's output); a value the plan supplies itself, or one a
   * model-written derivation computed, is never compared with it. `[]` covers the whole argument.
   */
  privatePositions?: ReadonlyArray<{
    argument: string;
    path: WorkflowValuePath;
    /** Removed by secret redaction, rather than only sent by reference. */
    redacted?: boolean;
  }>;
  /**
   * The workspace roots the two sides' working directories stand for: `recorded` is the root of the
   * session that made this call, `plan` the root of the session the plan's own call ran in. Given
   * both, a working directory is compared as the place it names within its own root — `.`, the
   * root's absolute path, and an omitted one are the same — so a repeat recorded in a session that
   * spelled its directory differently is still the same call. Absent, directories compare as text.
   */
  roots?: { recorded: string; plan: string };
  /**
   * The call was recorded by another harness's built-in shell than the plan's step: the program
   * argument and the working directory (as the place it names under each side's root) are
   * compared; the shells' other arguments (timeout, label, profile) are not one vocabulary.
   */
  programOnly?: true;
}

/**
 * The recorded call each recorded step made in one run of a demonstration, by step id. A
 * demonstration that ran once per item is checked as one such recording per item.
 */
export type WorkflowRecording = ReadonlyMap<string, RecordedCall>;

/** The recorded runtime families every check registers. */
export const RECORDING_CHECK_RUNTIMES: readonly string[] = [
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_HARNESS_TOOL_RUNTIME,
];

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => deepEqual(entry, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

/**
 * Whether a template position reads its value from an earlier step: a result (a derivation step's
 * included) or an extract. Literal, private and unresolved leaves carry the recorded text, and an
 * input — a recorded default above all — would resend whatever the caller or the recording supplies.
 */
function templateBinds(template: WorkflowValueTemplate, path: WorkflowValuePath): boolean {
  switch (template.type) {
    case "result":
    case "extract":
      return true;
    case "literal":
    case "private":
    case "unresolved":
    case "input":
      return false;
    case "object": {
      const [head, ...rest] = path;
      const child = typeof head === "string" ? template.entries[head] : undefined;
      return child !== undefined && templateBinds(child, rest);
    }
    case "array": {
      const [head, ...rest] = path;
      const child = typeof head === "number" ? template.items[head] : undefined;
      return child !== undefined && templateBinds(child, rest);
    }
    case "program": {
      const address = programTokenPath(path);
      if (address === undefined) return false;
      const { span } = address;
      return template.holes.some(
        (hole) =>
          holeCovers(hole, address) &&
          // A whole-token hole binds every span of it; a span hole binds only what it covers.
          (hole.span === undefined ||
            (span !== undefined && hole.span.start <= span.start && hole.span.end >= span.end)) &&
          templateBinds(hole.binding, []),
      );
    }
    default:
      return false;
  }
}

/**
 * Whether a program hole replaces the token `address` names: a word list replaces every word of its
 * run, any other hole only its own (top-level or embedded) token.
 */
function holeCovers(
  hole: Extract<WorkflowValueTemplate, { type: "program" }>["holes"][number],
  address: ProgramTokenAddress,
): boolean {
  if (hole.through === undefined && address.through === undefined) {
    return hole.token === address.token && hole.embedded === address.embedded;
  }
  return (
    address.embedded === undefined &&
    hole.token <= address.token &&
    (address.through ?? address.token) <= (hole.through ?? hole.token)
  );
}

/** Whether the plan binds this argument position to an earlier step, rather than recorded text. */
export function stepBindsPosition(
  step: WorkflowStep,
  argument: string,
  path: WorkflowValuePath,
): boolean {
  const source = step.arguments.find((entry) => entry.name === argument)?.source;
  if (source === undefined) return false;
  if (source.kind === "result") return true;
  return source.kind === "template" && templateBinds(source.template, path);
}

/**
 * What a check may compare with a private recorded value: only values this device supplies. A
 * literal is the cloud's own guess; a derivation's output is the cloud's code applied to recorded
 * data; an input declared with a plan-written default is a literal by another name. A recorded
 * step's result stays the device's own record.
 */
export interface DeviceSourceRules {
  /** Steps this device recorded: their results are recorded values, not computed ones. */
  recordedSteps: ReadonlySet<string>;
  /** Inputs whose value the plan itself can supply (a declared `default`). */
  planSuppliedInputs: ReadonlySet<string>;
}

function templateDeviceSourced(
  template: WorkflowValueTemplate,
  path: WorkflowValuePath,
  rules: DeviceSourceRules,
): boolean {
  switch (template.type) {
    case "private":
      return true;
    case "input":
      return !rules.planSuppliedInputs.has(template.name);
    case "result":
    case "extract":
      return rules.recordedSteps.has(template.stepId);
    case "literal":
    case "unresolved":
      return false;
    case "object": {
      if (path.length === 0) {
        return Object.values(template.entries).every((entry) =>
          templateDeviceSourced(entry, [], rules),
        );
      }
      const [head, ...rest] = path;
      const child = typeof head === "string" ? template.entries[head] : undefined;
      return child !== undefined && templateDeviceSourced(child, rest, rules);
    }
    case "array": {
      if (path.length === 0) {
        return template.items.every((item) => templateDeviceSourced(item, [], rules));
      }
      const [head, ...rest] = path;
      const child = typeof head === "number" ? template.items[head] : undefined;
      return child !== undefined && templateDeviceSourced(child, rest, rules);
    }
    case "program": {
      // Recorded text comes from this device's store only through a private source reference; the
      // plan's literal source is the uploaded, redacted view or the cloud's own text.
      const text = template.sourceReference !== undefined || template.source.type === "private";
      if (path.length === 0) {
        return (
          text && template.holes.every((hole) => templateDeviceSourced(hole.binding, [], rules))
        );
      }
      const address = programTokenPath(path);
      if (address === undefined) return false;
      const covering = template.holes.filter((hole) => holeCovers(hole, address));
      if (!covering.every((hole) => templateDeviceSourced(hole.binding, [], rules))) return false;
      // A whole-token hole replaces the token; a span hole leaves the rest of it to the text.
      return text || covering.some((hole) => hole.span === undefined);
    }
    default:
      return false;
  }
}

/** Whether the plan reads this argument position from values this device supplies. */
export function stepDeviceSourcesPosition(
  step: WorkflowStep,
  argument: string,
  path: WorkflowValuePath,
  rules: DeviceSourceRules,
): boolean {
  const source = step.arguments.find((entry) => entry.name === argument)?.source;
  if (source === undefined) return false;
  switch (source.kind) {
    case "private":
      return true;
    case "input":
      return !rules.planSuppliedInputs.has(source.name);
    case "result":
      return rules.recordedSteps.has(source.stepId);
    case "template":
      return templateDeviceSourced(source.template, path, rules);
    default:
      return false;
  }
}

/**
 * Arguments of a recorded program call that decide what its replay runs, beside the program
 * argument itself: where it runs and how the program runner invokes it. Everything else a harness
 * passed with the program — an intent label, a timeout, an output limit, a yield interval — never
 * reaches the program runner, and another session of the same job routinely chose it differently.
 */
const PROGRAM_CONTEXT_ARGUMENTS: Record<string, true> = {
  workdir: true,
  cwd: true,
  resinCodexShellProfile: true,
  raw: true,
  patch: true,
};

/** The working-directory arguments among them: each names a place relative to its session's root. */
const WORKING_DIRECTORY_ARGUMENTS = ["workdir", "cwd"] as const;

/**
 * The arguments of a call that the check compares: every argument of a call without a program, and
 * the program argument and its context arguments of a process or program call — with each working
 * directory, when `root` is known, as the place it names under that root.
 */
function comparedArguments(
  step: WorkflowStep,
  args: Record<string, WorkflowJsonValue>,
  root: string | undefined,
  programOnly = false,
): Record<string, WorkflowJsonValue> {
  const program = step.callable.program;
  const runtime = step.callable.runtime;
  if (
    program === undefined ||
    (runtime !== RESIN_PROCESS_RUNTIME && runtime !== RESIN_PROGRAM_RUNTIME)
  ) {
    return args;
  }
  const compared = Object.fromEntries(
    Object.entries(args).filter(
      ([name]) =>
        name === program.argument ||
        (programOnly
          ? (WORKING_DIRECTORY_ARGUMENTS as readonly string[]).includes(name)
          : Object.hasOwn(PROGRAM_CONTEXT_ARGUMENTS, name)),
    ),
  );
  if (root === undefined) return compared;
  for (const name of WORKING_DIRECTORY_ARGUMENTS) {
    const value = compared[name] ?? ".";
    if (typeof value !== "string") continue;
    compared[name] = path.posix.relative(root, path.posix.resolve(root, value));
  }
  return compared;
}

/** Why a resolved call is not the recorded one; undefined when it is. */
function mismatch(
  step: WorkflowStep,
  request: RecordedCallRequest,
  recorded: RecordedCall,
  rules: DeviceSourceRules,
) {
  const callable = step.callable;
  if (
    callable.name !== recorded.callable.name ||
    callable.connection !== recorded.callable.connection ||
    callable.program?.kind !== recorded.callable.program?.kind ||
    callable.program?.argument !== recorded.callable.program?.argument ||
    // A program recorded in one shell dialect is never checked against a run in another; a record
    // made before dialects were recorded names none, and its callable decides it.
    (callable.program?.dialect !== undefined &&
      recorded.callable.program?.dialect !== undefined &&
      callable.program.dialect !== recorded.callable.program.dialect) ||
    callable.program?.unprovenDialect === true ||
    recorded.callable.program?.unprovenDialect === true
  ) {
    return "names a different callable than the recording";
  }
  // Checked before any comparison: a guessed or computed value at a private position is refused
  // whether or not it would have matched, so the verdict says nothing about the recorded value.
  for (const position of recorded.privatePositions ?? []) {
    // A value only sent by reference was never secret-redacted; plans may state it (the check then
    // proves the plan reproduces it). What secret redaction removed is never compared with one.
    if (position.redacted === false) continue;
    if (!stepDeviceSourcesPosition(step, position.argument, position.path, rules)) {
      return "compares a private recorded value with a value this device did not supply";
    }
  }
  if (
    !deepEqual(
      comparedArguments(step, request.arguments, recorded.roots?.plan, recorded.programOnly),
      comparedArguments(step, recorded.arguments, recorded.roots?.recorded, recorded.programOnly),
    )
  ) {
    return "resolves to arguments the recording did not pass";
  }
  for (const dependency of recorded.hiddenDependencies) {
    if (!stepBindsPosition(step, dependency.argument, dependency.path)) {
      return "carries literal text the recording shows came from an earlier step";
    }
  }
  return undefined;
}

/**
 * The adapter that answers one recorded runtime family from the recording.
 *
 * Derivation steps are model-written and were never recorded, so a program-runtime check hands them
 * to `derivation` — the only adapter here that runs anything.
 */
export function createRecordingCheckAdapter(
  runtime: string,
  recording: WorkflowRecording,
  derivation?: RuntimeAdapter,
  planSuppliedInputs: ReadonlySet<string> = new Set(),
): RuntimeAdapter {
  const rules: DeviceSourceRules = { recordedSteps: new Set(recording.keys()), planSuppliedInputs };
  return {
    runtime,
    async call(request) {
      const step = request.step;
      if (step.origin === "derivation") {
        if (derivation === undefined) {
          throw new Error(`derivation step '${step.id}' has no sandboxed runner`);
        }
        return await derivation.call(request);
      }
      const recorded = recording.get(step.id);
      if (recorded === undefined) {
        throw new Error(`step '${step.id}' has no call in this device's recording`);
      }
      const reason = mismatch(step, request, recorded, rules);
      if (reason !== undefined) throw new Error(`step '${step.id}' ${reason}`);
      return recorded.result;
    },
  };
}

/** A registry that checks every listed recorded runtime family against `recording`. */
export function createRecordingCheckAdapters(options: {
  recording: WorkflowRecording;
  /** Recorded runtime families beyond `RECORDING_CHECK_RUNTIMES`, checked the same way. */
  runtimes?: readonly string[];
  /** Sandboxed runner for model-written derivation steps. */
  derivation?: RuntimeAdapter;
  /** The plan's inputs declared with a `default`: the plan, not this device, supplies them. */
  planSuppliedInputs?: ReadonlySet<string>;
}): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  for (const runtime of new Set([...RECORDING_CHECK_RUNTIMES, ...(options.runtimes ?? [])])) {
    registry.register(
      createRecordingCheckAdapter(
        runtime,
        options.recording,
        runtime === RESIN_PROGRAM_RUNTIME ? options.derivation : undefined,
        options.planSuppliedInputs,
      ),
    );
  }
  return registry;
}
