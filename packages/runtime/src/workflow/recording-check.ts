/**
 * Checking a plan against the device's own recording, without running anything the recording ran.
 *
 * Each recorded step is resolved exactly as an invocation resolves it — templates, holes, inputs,
 * extracts and derivation outputs — and the resolved call is then compared with the call the
 * recording made for that step: the same callable, and every argument equal to the recorded value.
 * A match answers with what the recording observed that call produce. A mismatch, or a step the
 * recording has no call for, fails the step. Nothing is spawned, dispatched or written: the only
 * code a check runs is a model-written derivation step, through the adapter the caller supplies.
 */

import {
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
    program?: { kind: string; argument: string };
  };
  arguments: Record<string, WorkflowJsonValue>;
  result: WorkflowJsonValue;
  /**
   * Argument positions whose recorded value first appeared in an earlier step's recorded output.
   * A plan that still carries such a position as literal recorded text depends on a value it does
   * not read, so it is refused rather than verified.
   */
  hiddenDependencies: ReadonlyArray<{ argument: string; path: WorkflowValuePath }>;
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
          hole.token === address.token &&
          hole.embedded === address.embedded &&
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

/** Why a resolved call is not the recorded one; undefined when it is. */
function mismatch(step: WorkflowStep, request: RecordedCallRequest, recorded: RecordedCall) {
  const callable = step.callable;
  if (
    callable.name !== recorded.callable.name ||
    callable.connection !== recorded.callable.connection ||
    callable.program?.kind !== recorded.callable.program?.kind ||
    callable.program?.argument !== recorded.callable.program?.argument
  ) {
    return "names a different callable than the recording";
  }
  if (!deepEqual(request.arguments, recorded.arguments)) {
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
): RuntimeAdapter {
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
      const reason = mismatch(step, request, recorded);
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
}): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  for (const runtime of new Set([...RECORDING_CHECK_RUNTIMES, ...(options.runtimes ?? [])])) {
    registry.register(
      createRecordingCheckAdapter(
        runtime,
        options.recording,
        runtime === RESIN_PROGRAM_RUNTIME ? options.derivation : undefined,
      ),
    );
  }
  return registry;
}
