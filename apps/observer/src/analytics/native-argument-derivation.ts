/**
 * Deriving what ordinary tool use established about its own arguments.
 *
 * The model never labels its calls, so nothing here may read an origin out of an argument: an
 * argument states a value, not where the value came from. What can be established is established
 * from the record itself, and each conclusion carries the rule it came from so a consumer can tell
 * a fact from a suggestion:
 *
 *   - a call that declared it wrote a resource, and a later call that declared it read that same
 *     resource, is a recorded producer→consumer edge — both sides named the resource, so nothing is
 *     inferred from a value that merely looks similar;
 *   - a value a later call passed that first appeared in an earlier call's *result* is offered as a
 *     candidate binding, never as a binding;
 *   - a value that was already present in the record before the earlier call produced it is NOT
 *     offered at all: equality there is a coincidence the record cannot resolve, and proposing it
 *     would be exactly the mistake of turning a coincidence into a dependency;
 *   - a value embedded in the text of a program the call ran is offered under that same rule, but
 *     addressed by the token it sits at rather than by a path of leaves: the program's text is one
 *     argument, and a value inside it is not a leaf of that argument;
 *   - the same argument position taking different values across distinct executions of the same
 *     call is offered as a candidate input, never as an input.
 *
 * Candidates are not executable. They exist so that a later, deliberate step can confirm them by
 * replay on different inputs in a disposable environment, and so that a refusal can name the exact
 * fact the record is missing.
 */

import {
  type ProgramLanguage,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowValuePath,
  tokenizeProgram,
} from "@resin/contracts";

/** Local identities of the resources one call declared it would read and write. */
export interface ObservedResourceFlow {
  reads: readonly string[];
  writes: readonly string[];
}

/** One call, as the recording observed it, in recorded order. */
export interface DerivationCall {
  callId: string;
  /** Identity this call has as a step of the recording. */
  stepId: string;
  toolName: string;
  runtime: string;
  arguments: Record<string, WorkflowJsonValue>;
  result?: WorkflowJsonValue;
  /** The declared data flow, when the record establishes one. Absent means it does not. */
  flow?: ObservedResourceFlow;
  /** The callable's discovered input schema, when the record carries one. */
  inputSchema?: WorkflowJsonValue;
  /**
   * Arguments the recording already accounts for as local resources. A value the capture keeps on
   * this machine is not a caller input: turning it into one would hand the caller a resource the
   * recording deliberately held back.
   */
  privateArguments?: readonly string[];
  /**
   * The program this call ran, as the record established it: the language it is written in, and the
   * argument whose text holds it. A value embedded in that text is part of the program rather than a
   * leaf of an argument, so it is only comparable once the text has been read as the program it is.
   */
  program?: { kind: ProgramLanguage; argument: string };
}

export interface DerivedCall {
  callId: string;
  stepId: string;
  /** Steps this call must run after, established by the calls' own declared resource use. */
  dependsOn: string[];
}

export interface NativeDerivation {
  calls: DerivedCall[];
  /** Bindings the record suggests but does not establish. Never executable as recorded. */
  candidates: WorkflowBindingCandidate[];
}

/**
 * The shortest string the derivation will offer as a candidate binding.
 *
 * A short token (`"0"`, `"ok"`, `"a"`) collides with unrelated arguments constantly, and offering it
 * would make the candidate list useless. The bound is deliberate and conservative: a value the
 * producer minted is an identifier, and identifiers are longer than this.
 */
const MIN_CANDIDATE_STRING_LENGTH = 4;

/** Distinct candidate bindings one recording may report, so a large session cannot explode. */
const MAX_CANDIDATES = 256;

/** Bounded traversal of one argument or result, so a deep payload cannot stall capture. */
const MAX_LEAF_DEPTH = 8;
const MAX_LEAVES = 512;

function isPlainObject(value: unknown): value is Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every string leaf of a value, with the path it sits at, in a stable traversal order. */
function stringLeaves(
  value: WorkflowJsonValue | undefined,
  path: WorkflowValuePath,
  out: Array<{ path: WorkflowValuePath; value: string }>,
  depth = 0,
): void {
  if (depth > MAX_LEAF_DEPTH || out.length >= MAX_LEAVES) return;
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => stringLeaves(entry, [...path, index], out, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      stringLeaves(entry, [...path, key], out, depth + 1);
    }
  }
}

/** The property names a callable's discovered input schema declares, or undefined without one. */
function declaredProperties(schema: WorkflowJsonValue | undefined): Set<string> | undefined {
  if (!isPlainObject(schema)) return undefined;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return undefined;
  return new Set(Object.keys(properties));
}

/** The name a candidate input would take: the callable and the argument, in one identifier. */
function inputNameOf(callableName: string, argument: string): string {
  return `${callableName}_${argument}`.replace(/[^A-Za-z0-9_]+/g, "_");
}

/**
 * Derives, from a recorded call sequence, the dependencies and the candidate bindings it supports.
 *
 * The function is a pure function of what it is given: no clock, no filesystem, no execution, and
 * no model. Two runs over the same recording produce the same derivation.
 */
export function deriveNativeCalls(calls: readonly DerivationCall[]): NativeDerivation {
  const derived: DerivedCall[] = [];
  const candidates: WorkflowBindingCandidate[] = [];
  /**
   * The value each declared input was given. A value the callable itself declares as an input, used
   * again somewhere else in the same recording, is the same caller's value in both places — it is
   * neither a dependency on an earlier result nor a constant of the work.
   */
  const declaredInputValues = new Map<string, { name: string; count: number }>();

  /** Every string leaf the record had shown once a call's result arrived, before it arrived. */
  const seenBeforeResult: Array<Set<string>> = [];
  /** The string leaves each call's own arguments carried, so an echo is told from a minting. */
  const argumentValues: Array<Set<string>> = [];
  /** The string leaves each call's own result contributed. */
  const resultValues: Array<Set<string>> = [];
  const seen = new Set<string>();

  for (const [index, call] of calls.entries()) {
    const argumentLeaves: Array<{ path: WorkflowValuePath; value: string }> = [];
    for (const [argument, value] of Object.entries(call.arguments)) {
      stringLeaves(value, [argument], argumentLeaves);
    }
    for (const leaf of argumentLeaves) seen.add(leaf.value);
    argumentValues.push(new Set(argumentLeaves.map((leaf) => leaf.value)));
    seenBeforeResult.push(new Set(seen));

    const resultLeaves: Array<{ path: WorkflowValuePath; value: string }> = [];
    stringLeaves(call.result, [], resultLeaves);
    resultValues.push(new Set(resultLeaves.map((leaf) => leaf.value)));
    for (const leaf of resultLeaves) seen.add(leaf.value);

    // Declared-resource edges: the earlier call declared it wrote what this call declared it reads,
    // so the order is a fact of the record rather than an inference from the values involved.
    const dependsOn: string[] = [];
    if (call.flow !== undefined && call.flow.reads.length > 0) {
      const reads = new Set(call.flow.reads);
      for (const earlier of calls.slice(0, index)) {
        if (earlier.flow === undefined || earlier.flow.writes.length === 0) continue;
        if (!earlier.flow.writes.some((resource) => reads.has(resource))) continue;
        dependsOn.push(earlier.stepId);
      }
    }
    derived.push({ callId: call.callId, stepId: call.stepId, dependsOn });

    // Arguments the callable itself declares it accepts, that nothing in this recording produced.
    // The schema is the callable's own statement of what it takes, so proposing one costs nothing
    // and is confirmed only by running the work with a different value.
    const declared = declaredProperties(call.inputSchema);
    if (declared !== undefined) {
      const heldLocally = new Set(call.privateArguments ?? []);
      for (const [argument, value] of Object.entries(call.arguments)) {
        if (candidates.length >= MAX_CANDIDATES) break;
        if (!declared.has(argument)) continue;
        if (heldLocally.has(argument)) continue;
        // Discovery describes the executor's API, not the reusable workflow's inputs. Its program
        // argument is the implementation we recorded. Lifting that entire string asks the next
        // caller to implement the work again and competes with legitimate data-token proposals.
        // Program identity comes from capture, never from the tool or argument name.
        if (call.program?.argument === argument) continue;
        // Only a string is offered. A number or a boolean at a declared position is far more often
        // a fixed setting than a value a caller would vary, and this recording cannot separate the
        // two — so the conservative reading wins and the value stays as recorded.
        if (typeof value !== "string" || value.length < MIN_CANDIDATE_STRING_LENGTH) continue;
        // A value an EARLIER call of this recording minted is that call's output, not an input. The
        // call being examined is excluded on purpose: a callable that echoes what it was given
        // (an id it just minted, a name it was handed) would otherwise disqualify its own input,
        // and whether the result has arrived yet must not change what is proposed.
        if (mintedBefore(String(value), index, calls, resultValues, argumentValues)) continue;
        const inputName = inputNameOf(call.toolName, argument);
        const recorded = declaredInputValues.get(value);
        declaredInputValues.set(value, {
          name: recorded?.name ?? inputName,
          count: (recorded?.count ?? 0) + 1,
        });
        candidates.push({
          stepId: call.stepId,
          argument,
          path: [],
          proposed: { kind: "input", name: inputName, type: "string" },
          reason: "declared-by-the-callable",
          evidence: { declaredProperties: declared.size },
          missing:
            "the callable's own schema declares this argument and the recording shows the value it was called with, but nothing shows whether a caller supplies it; only running the work with a different value establishes that",
        });
      }
    }

    // Candidate result bindings, only for values this call could only have got from the producer:
    // a value already present before the producer ran is not evidence of anything.
    if (candidates.length >= MAX_CANDIDATES) continue;
    for (const leaf of argumentLeaves) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (leaf.value.length < MIN_CANDIDATE_STRING_LENGTH) continue;
      const argumentName = leaf.path[0];
      if (typeof argumentName !== "string") continue;
      const producers = producersOfValue(leaf.value, index, calls, resultValues, seenBeforeResult);
      if (producers.length === 0) continue;
      const first = producers[0]!;
      candidates.push({
        stepId: call.stepId,
        argument: argumentName,
        path: leaf.path.slice(1),
        proposed: { kind: "result", stepId: first.stepId, path: first.path },
        reason: "equal-to-earlier-result",
        evidence: { producers: producers.length },
        missing:
          producers.length > 1
            ? `the record shows ${producers.length} earlier calls returning this value, so it does not establish which one this argument came from`
            : "the value first appeared after that call returned, but the record does not show this call read its result",
      });
    }

    // A value embedded in the text of a program this call ran. The string leaves above are the
    // arguments' own values; a value inside a program is part of its text, so it is read as the
    // tokenizer both halves of the round-trip share reads it, and the candidate names the token
    // position rather than the text the value happens to sit in. Only a word or a string is offered
    // — an operator denotes no value — and the same producer rule decides it, so a token that merely
    // repeats something the record already contained is not offered either.
    if (call.program !== undefined && candidates.length < MAX_CANDIDATES) {
      const text = call.arguments[call.program.argument];
      if (typeof text === "string") {
        const tokens = tokenizeProgram(call.program.kind, text);
        for (const [tokenIndex, token] of tokens.entries()) {
          if (candidates.length >= MAX_CANDIDATES) break;
          if (token.kind === "operator") continue;
          const value = token.value;
          if (value === undefined || value.length < MIN_CANDIDATE_STRING_LENGTH) continue;
          const producers = producersOfValue(value, index, calls, resultValues, seenBeforeResult);
          if (producers.length === 0) continue;
          const first = producers[0]!;
          candidates.push({
            stepId: call.stepId,
            argument: call.program.argument,
            path: ["tokens", tokenIndex],
            proposed: { kind: "result", stepId: first.stepId, path: first.path },
            reason: "equal-to-earlier-result",
            // Structural only: how many tokens the program has, which one this is, and how many
            // calls returned the value. The token's text never leaves the recording.
            evidence: { tokens: tokens.length, token: tokenIndex, producers: producers.length },
            missing:
              producers.length > 1
                ? `the record shows ${producers.length} earlier calls returning this value, so it does not establish which one this token came from`
                : "the token's text first appeared after that call returned, but the record does not show this token was rendered from its result rather than written into the program as a literal",
          });
        }
      }
    }
  }

  // Every other place the same caller's value was used, once it is known which values those are.
  // A value two arguments share without that justification stays where it is: two constants that
  // happen to be equal say nothing about where either came from.
  const sharedCandidates: WorkflowBindingCandidate[] = [];
  for (const [indexOfCall, call] of calls.entries()) {
    if (sharedCandidates.length >= MAX_CANDIDATES) break;
    const leaves: Array<{ path: WorkflowValuePath; value: string }> = [];
    for (const [argument, value] of Object.entries(call.arguments)) {
      stringLeaves(value, [argument], leaves);
    }
    for (const leaf of leaves) {
      const declared = declaredInputValues.get(leaf.value);
      if (declared === undefined || declared.count !== 1) continue;
      if (typeof leaf.path[0] !== "string") continue;
      // A value an earlier call MINTED is that call's output, so it is a result binding rather than
      // the caller's input. A value an earlier call merely echoed back is not: the callable was
      // given it, and finding it somewhere else means the caller needed it in both places.
      if (mintedBefore(leaf.value, indexOfCall, calls, resultValues, argumentValues)) continue;
      if (alreadyProposed(candidates, call.stepId, leaf)) continue;
      sharedCandidates.push({
        stepId: call.stepId,
        argument: leaf.path[0],
        path: leaf.path.slice(1),
        proposed: { kind: "input", name: declared.name, type: "string" },
        reason: "shares-value-with-declared-input",
        evidence: { declaredInputs: 1 },
        missing:
          "this argument was given the same value the callable's own schema declares as an input elsewhere in the recording, but nothing shows whether a caller supplies it",
      });
    }
  }
  return { calls: derived, candidates: [...candidates, ...sharedCandidates] };
}

/**
 * The earlier calls whose result minted this value: it appeared in that call's result, and nowhere
 * the record had already shown — neither in an earlier result nor in that call's own arguments. A
 * value the record already contained, or one the callable was given, is not an output of that call,
 * so it never becomes a producer.
 */
function producersOfValue(
  value: string,
  before: number,
  calls: readonly DerivationCall[],
  resultValues: ReadonlyArray<ReadonlySet<string>>,
  seenBeforeResult: ReadonlyArray<ReadonlySet<string>>,
): Array<{ stepId: string; path: WorkflowValuePath }> {
  const producers: Array<{ stepId: string; path: WorkflowValuePath }> = [];
  for (let producerIndex = 0; producerIndex < before; producerIndex += 1) {
    if (!resultValues[producerIndex]!.has(value)) continue;
    if (seenBeforeResult[producerIndex]!.has(value)) continue;
    const produceLeaves: Array<{ path: WorkflowValuePath; value: string }> = [];
    stringLeaves(calls[producerIndex]!.result, [], produceLeaves);
    for (const produced of produceLeaves) {
      if (produced.value !== value) continue;
      producers.push({ stepId: calls[producerIndex]!.stepId, path: produced.path });
    }
  }
  return producers;
}

/**
 * True when a call BEFORE `before` minted this value — it appeared in that call's result and not in
 * its arguments. An echo of a value the callable was given is not an output: it is the caller's
 * value passing through, and treating it as an output would lose the input it came from.
 */
function mintedBefore(
  value: string,
  before: number,
  calls: readonly DerivationCall[],
  resultValues: ReadonlyArray<ReadonlySet<string>>,
  argumentValues: ReadonlyArray<ReadonlySet<string>>,
): boolean {
  return calls.slice(0, before).some((_earlier, index) => {
    if (!resultValues[index]!.has(value)) return false;
    return !argumentValues[index]!.has(value);
  });
}

/** True when this exact position is already proposed, so one value is never proposed twice. */
function alreadyProposed(
  candidates: readonly WorkflowBindingCandidate[],
  stepId: string,
  leaf: { path: WorkflowValuePath },
): boolean {
  return candidates.some(
    (candidate) =>
      candidate.stepId === stepId &&
      JSON.stringify([candidate.argument, ...candidate.path]) === JSON.stringify(leaf.path),
  );
}

/** One argument position of one execution, as far as comparing executions needs to see it. */
export interface ExecutionArgument {
  /** Ordinal of the step inside its own execution; the only identity that aligns executions. */
  position: number;
  /** The step this argument belongs to inside its own execution. */
  stepId: string;
  callableName: string;
  argument: string;
  value: WorkflowJsonValue;
}

export interface ExecutionRecording {
  /** Stable identity of the execution: its session and task, never its values. */
  executionId: string;
  steps: readonly ExecutionArgument[];
}

/**
 * Offers the argument positions that took different values across distinct executions as candidate
 * inputs.
 *
 * Variation is evidence that a value is not a constant of the workflow, not proof that the caller
 * supplies it: a value can also change because the recording itself produced it differently. The
 * candidate therefore carries how many executions agreed, and stays non-executable until a replay
 * confirms it on an input the recordings never contained.
 */
export function proposeInputsAcrossExecutions(
  executions: readonly ExecutionRecording[],
): WorkflowBindingCandidate[] {
  if (executions.length < 2) return [];
  const base = executions[0]!;
  const others = executions.slice(1);
  const candidates: WorkflowBindingCandidate[] = [];
  for (const position of base.steps) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const values = others.map((execution) =>
      execution.steps.find(
        (step) =>
          step.position === position.position &&
          step.callableName === position.callableName &&
          step.argument === position.argument,
      ),
    );
    if (values.some((match) => match === undefined)) continue;
    const seenValues: WorkflowJsonValue[] = [
      position.value,
      ...values.map((match) => match!.value),
    ];
    if (new Set(seenValues.map((value) => JSON.stringify(value))).size < 2) continue;
    const sample = position.value;
    if (typeof sample !== "string" && typeof sample !== "number" && typeof sample !== "boolean") {
      continue;
    }
    if (seenValues.some((value) => typeof value !== typeof sample)) continue;
    if (typeof sample === "string" && sample.length < MIN_CANDIDATE_STRING_LENGTH) continue;
    const valueType: "string" | "number" | "boolean" =
      typeof sample === "string" ? "string" : typeof sample === "number" ? "number" : "boolean";
    candidates.push({
      stepId: position.stepId,
      argument: position.argument,
      path: [],
      proposed: {
        kind: "input",
        name: `${position.callableName}_${position.argument}`,
        type: valueType === "number" ? "number" : valueType === "boolean" ? "boolean" : "string",
      },
      reason: "varies-across-executions",
      evidence: { executions: executions.length, distinctValues: seenValues.length },
      missing:
        "the value differed between recorded executions, but no execution used an input the recording had never seen, so the record does not establish that a caller supplies it",
    });
  }
  return candidates;
}
