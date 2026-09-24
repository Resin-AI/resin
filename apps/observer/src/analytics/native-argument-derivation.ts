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
 *
 * Candidates are not executable. They exist so that a later, deliberate step can confirm them by
 * replay on different inputs in a disposable environment, and so that a refusal can name the exact
 * fact the record is missing.
 */

import {
  type ProgramLanguage,
  type ProgramToken,
  ProgramTokenizationError,
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

type CandidateScalar = string | number | boolean;

/** Every comparable primitive leaf, with type preserved so `1` never aliases `"1"`. */
function scalarLeaves(
  value: WorkflowJsonValue | undefined,
  path: WorkflowValuePath,
  out: Array<{ path: WorkflowValuePath; value: CandidateScalar }>,
  depth = 0,
): void {
  if (depth > MAX_LEAF_DEPTH || out.length >= MAX_LEAVES) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scalarLeaves(entry, [...path, index], out, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      scalarLeaves(entry, [...path, key], out, depth + 1);
    }
  }
}

/** Stable typed identity for exact primitive comparison. */
function scalarKey(value: CandidateScalar): string {
  return JSON.stringify([typeof value, value]);
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
  /** Every typed primitive leaf shown before each call's result arrived. */
  const seenBeforeResult: Array<Set<string>> = [];

  /** Typed primitive leaves each call's own result contributed. */
  const resultValues: Array<Set<string>> = [];
  const seen = new Set<string>();

  for (const [index, call] of calls.entries()) {
    const argumentLeaves: Array<{ path: WorkflowValuePath; value: CandidateScalar }> = [];
    for (const [argument, value] of Object.entries(call.arguments)) {
      scalarLeaves(value, [argument], argumentLeaves);
    }
    for (const leaf of argumentLeaves) seen.add(scalarKey(leaf.value));
    seenBeforeResult.push(new Set(seen));

    const resultLeaves: Array<{ path: WorkflowValuePath; value: CandidateScalar }> = [];
    scalarLeaves(call.result, [], resultLeaves);
    resultValues.push(new Set(resultLeaves.map((leaf) => scalarKey(leaf.value))));
    for (const leaf of resultLeaves) seen.add(scalarKey(leaf.value));

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

    // Candidate result bindings, only for values this call could only have got from the producer:
    // a value already present before the producer ran is not evidence of anything.
    if (candidates.length >= MAX_CANDIDATES) continue;
    for (const leaf of argumentLeaves) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (typeof leaf.value === "string" && leaf.value.length < MIN_CANDIDATE_STRING_LENGTH)
        continue;
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
        let tokens: ProgramToken[];
        try {
          tokens = tokenizeProgram(call.program.kind, text);
        } catch (error) {
          if (error instanceof ProgramTokenizationError) continue;
          throw error;
        }
        for (const [tokenIndex, token] of tokens.entries()) {
          if (candidates.length >= MAX_CANDIDATES) break;
          if (!token.bindable) continue;
          const value = token.value;
          if (typeof value !== "string" || value.length < MIN_CANDIDATE_STRING_LENGTH) continue;
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

  return { calls: derived, candidates };
}

/**
 * The earlier calls whose result minted this value: it appeared in that call's result, and nowhere
 * the record had already shown — neither in an earlier result nor in that call's own arguments. A
 * value the record already contained, or one the callable was given, is not an output of that call,
 * so it never becomes a producer.
 */
function producersOfValue(
  value: CandidateScalar,
  before: number,
  calls: readonly DerivationCall[],
  resultValues: ReadonlyArray<ReadonlySet<string>>,
  seenBeforeResult: ReadonlyArray<ReadonlySet<string>>,
): Array<{ stepId: string; path: WorkflowValuePath }> {
  const producers: Array<{ stepId: string; path: WorkflowValuePath }> = [];
  const key = scalarKey(value);
  for (let producerIndex = 0; producerIndex < before; producerIndex += 1) {
    if (!resultValues[producerIndex]!.has(key)) continue;
    if (seenBeforeResult[producerIndex]!.has(key)) continue;
    const produceLeaves: Array<{ path: WorkflowValuePath; value: CandidateScalar }> = [];
    scalarLeaves(calls[producerIndex]!.result, [], produceLeaves);
    for (const produced of produceLeaves) {
      if (produced.value !== value || typeof produced.value !== typeof value) continue;
      producers.push({ stepId: calls[producerIndex]!.stepId, path: produced.path });
    }
  }
  return producers;
}
