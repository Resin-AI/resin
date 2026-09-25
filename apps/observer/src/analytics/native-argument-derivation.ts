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

/** Values one program call may offer as optional inputs, so a long command stays a short schema. */
const MAX_PROGRAM_INPUTS_PER_CALL = 6;

/** The longest program value offered as an input; longer text is program, not a parameter. */
const MAX_PROGRAM_INPUT_LENGTH = 256;

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
 * Whether a program token is a value a caller may plausibly want to change: a quoted string, a
 * flag's value, or a word shaped like a path or a number. Command names, flags, bare subcommands
 * and variable assignments are structure or configuration, and a credential flag's value is never
 * offered: a shell command carries no redaction projection to protect it.
 */
function isProgramValue(
  language: ProgramLanguage,
  token: ProgramToken,
  previous: ProgramToken | undefined,
): token is ProgramToken & { value: string } {
  if (!token.bindable || typeof token.value !== "string" || token.kind === "operator") return false;
  const value = token.value;
  if (value.length === 0 || value.length > MAX_PROGRAM_INPUT_LENGTH || value.startsWith("-")) {
    return false;
  }
  if (value.startsWith("/dev/")) return false;
  const flag = longFlagName(previous);
  if (flag !== undefined && /pass|secret|token|key|auth|cred/.test(flag)) return false;
  const shaped = /[/.\d]/.test(value);
  if (language !== "shell") return token.kind === "string" && shaped;
  if (token.kind === "word" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.raw)) return false;
  return token.kind === "string" || shaped || flag !== undefined;
}

function longFlagName(token: ProgramToken | undefined): string | undefined {
  const flag = token?.kind === "word" ? /^--([A-Za-z][A-Za-z0-9-]{0,30})$/.exec(token.raw) : null;
  return flag?.[1]?.toLowerCase().replace(/-/g, "_");
}

/** A readable input name for a program value: its flag's name, else what the value looks like. */
function programInputBaseName(value: string, previous: ProgramToken | undefined): string {
  const flag = longFlagName(previous);
  if (flag !== undefined) return flag;
  if (/^\d+(\.\d+)?$/.test(value)) return "number";
  if (value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value)) return "path";
  return "text";
}

/**
 * The shell tokenizer does not establish heredoc-body syntax, so nothing from the first heredoc on
 * is offered: body text is another program's source, not this command's arguments.
 */
function heredocStart(language: ProgramLanguage, text: string): number {
  if (language !== "shell") return Number.POSITIVE_INFINITY;
  const match = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.exec(text);
  return match === null ? Number.POSITIVE_INFINITY : match.index;
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
  // Weak caller-input suggestions never consume slots reserved for result evidence.
  const inputCandidates: WorkflowBindingCandidate[] = [];
  /**
   * The input each program value was offered as, in order of first appearance, so the same value
   * anywhere in the recording is one input and a name, once given, never changes as calls arrive.
   */
  const programInputs = new Map<string, string>();
  const programInputNames = new Set<string>();
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
      if (call.program?.argument === argumentName) continue;
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

    // Ordinary JSON leaves can be proposed as caller inputs, but one observation cannot
    // establish that they vary. Result-derived proposals take precedence at the same position.
    // Program-bearing calls use token proposals instead: never bind their source wholesale.
    if (call.program === undefined && inputCandidates.length < MAX_CANDIDATES) {
      for (const [leafIndex, leaf] of argumentLeaves.entries()) {
        if (inputCandidates.length >= MAX_CANDIDATES) break;
        const argument = leaf.path[0];
        if (typeof argument !== "string") continue;
        const type = typeof leaf.value;
        if (type !== "string" && type !== "number" && type !== "boolean") continue;
        const path = leaf.path.slice(1);
        inputCandidates.push({
          stepId: call.stepId,
          argument,
          path,
          proposed: {
            kind: "input",
            name: `input_${encodeURIComponent(call.toolName)}_${index}_${encodeURIComponent(argument)}_${leafIndex}`,
            type,
          },
          reason: "native-data-argument",
          missing:
            "the record does not establish that this argument varies with caller input across independent executions",
        });
      }
    }

    // A value embedded in the text of a program this call ran. The string leaves above are the
    // arguments' own values; a value inside a program is part of its text, so it is read as the
    // tokenizer both halves of the round-trip share reads it, and the candidate names the token
    // position rather than the text the value happens to sit in. Only a word or a string is offered
    // — an operator denotes no value — and the same producer rule decides it, so a token that merely
    // repeats something the record already contained is not offered either.
    if (call.program !== undefined) {
      const text = call.arguments[call.program.argument];
      if (typeof text !== "string") continue;
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

      // A value the program ran with can be offered as an optional input that defaults to exactly
      // what the recording ran. One recording cannot show that the value varies, but omitting the
      // input reproduces the recording, so the offer is safe to confirm by replaying it unchanged.
      const bodyStart = heredocStart(call.program.kind, text);
      const offered = new Set<string>();
      // A shell word at command position — the first word of a simple command after any leading
      // assignments — names the program to run, never a value it runs with.
      let commandPosition = call.program.kind === "shell";
      for (const [tokenIndex, token] of tokens.entries()) {
        if (inputCandidates.length >= MAX_CANDIDATES || token.start >= bodyStart) break;
        const previous = tokenIndex > 0 ? tokens[tokenIndex - 1] : undefined;
        if (call.program.kind === "shell") {
          if (token.kind === "operator") {
            commandPosition = ["&&", "||", ";", "|", "|&", "(", "&", "\n"].includes(token.raw);
            continue;
          }
          const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.raw);
          if (commandPosition) {
            if (!assignment) commandPosition = false;
            continue;
          }
        }
        if (!isProgramValue(call.program.kind, token, previous)) continue;
        const key = scalarKey(token.value);
        let name = programInputs.get(key);
        if (name === undefined) {
          if (offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) continue;
          const base = programInputBaseName(token.value, previous);
          name = base;
          for (let suffix = 2; programInputNames.has(name); suffix += 1) name = `${base}_${suffix}`;
          programInputs.set(key, name);
          programInputNames.add(name);
        } else if (!offered.has(name) && offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) {
          continue;
        }
        offered.add(name);
        inputCandidates.push({
          stepId: call.stepId,
          argument: call.program.argument,
          path: ["tokens", tokenIndex],
          proposed: { kind: "input", name, type: "string", recordedDefault: true },
          reason: "native-data-argument",
          evidence: { tokens: tokens.length, token: tokenIndex },
          missing:
            "one recording does not establish that this value varies; omitted, the input keeps the recorded value",
        });
      }
    }
  }

  const resultPositions = new Set(
    candidates.map((candidate) =>
      JSON.stringify([candidate.stepId, candidate.argument, candidate.path]),
    ),
  );
  for (const candidate of inputCandidates) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (resultPositions.has(JSON.stringify([candidate.stepId, candidate.argument, candidate.path])))
      continue;
    candidates.push(candidate);
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
