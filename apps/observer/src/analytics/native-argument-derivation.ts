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
 * checking against a recording of different inputs, and so that a refusal can name the exact
 * fact the record is missing.
 */

import {
  type ExtractLocator,
  type ProgramLanguage,
  type ProgramToken,
  ProgramTokenizationError,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowValuePath,
  embeddedPrograms,
  extractCharsetOf,
  extractPrintedValue,
  inputRoleName,
  valueFlag,
  programTokenPath,
  scriptRecordFieldKeys,
  scriptTokenContextName,
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

/**
 * A program token whose value an earlier call printed inside its text output.
 *
 * The locator is text taken from that output, so it never becomes part of a candidate here: the
 * caller that owns the private value store keeps it locally and proposes only its reference.
 */
export interface DerivedExtract {
  stepId: string;
  argument: string;
  path: WorkflowValuePath;
  producerStepId: string;
  locator: ExtractLocator;
  /** Structural only: token count and position. */
  evidence: { tokens: number; token: number };
}

export interface NativeDerivation {
  calls: DerivedCall[];
  /** Bindings the record suggests but does not establish. Never executable as recorded. */
  candidates: WorkflowBindingCandidate[];
  /** Values printed by an earlier call; proposals only once their locator is stored privately. */
  extracts: DerivedExtract[];
  /**
   * The input name each program value was offered as (keyed by value), including the names it was
   * given. Passing it to the next derivation of the same growing recording keeps every name.
   */
  inputNames: ReadonlyMap<string, string>;
}

/**
 * The shortest string the derivation will offer as a candidate binding.
 *
 * A short token (`"0"`, `"ok"`, `"a"`) collides with unrelated arguments constantly, and offering it
 * would make the candidate list useless. The bound is deliberate and conservative: a value the
 * producer minted is an identifier, and identifiers are longer than this.
 */
const MIN_CANDIDATE_STRING_LENGTH = 4;

/**
 * Distinct candidate bindings one recording may report per call family, so a large session cannot
 * explode. Harness-tool calls (reads, edits, JSON tools) and program calls (shell, Python,
 * JavaScript, Codex exec) each get their own budget: a long session's many harness-tool offers can
 * never starve the program calls that come after them. The total stays bounded at twice this.
 */
const MAX_CANDIDATES_PER_FAMILY = 256;

type CandidateFamily = "harness" | "program";

/** A program the call ran is its own family; a file edit is harness data like any other tool's. */
function candidateFamily(call: DerivationCall): CandidateFamily {
  return call.program === undefined || call.program.kind === "patch" ? "harness" : "program";
}

/** Values one program call may offer as optional inputs, so a long command stays a short schema. */
const MAX_PROGRAM_INPUTS_PER_CALL = 6;
/** Span candidates offered inside one token. */
const MAX_SPAN_CANDIDATES_PER_TOKEN = 3;

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
  shared: boolean,
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
  return token.kind === "string" || shaped || flag !== undefined || shared;
}

/** Operators after which a shell word is at command position again. */
const SHELL_COMMAND_SEPARATORS = ["&&", "||", ";", "|", "|&", "(", "&", "\n"];

/**
 * Each shell token's place in its simple command: 0 at command position (leading assignments and
 * the program's name), 1 for the first argument (where a subcommand sits), 2 and on for the rest,
 * and undefined for an operator.
 */
function shellArgumentPositions(tokens: readonly ProgramToken[]): Array<number | undefined> {
  let commandPosition = true;
  let argumentIndex = 0;
  return tokens.map((token) => {
    if (token.kind === "operator") {
      commandPosition = SHELL_COMMAND_SEPARATORS.includes(token.raw);
      if (commandPosition) argumentIndex = 0;
      return undefined;
    }
    if (commandPosition) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.raw)) commandPosition = false;
      return 0;
    }
    argumentIndex += 1;
    return argumentIndex;
  });
}

/**
 * Bare words two or more calls ran with past their subcommand position. The steps of one job share
 * the value they work on (`./release test alpha`, `./release build alpha`) while each step's
 * subcommand names its own action, so a shared word is data even without a path, number or flag
 * shape.
 */
function sharedShellWords(calls: readonly DerivationCall[]): Set<string> {
  const callsByWord = new Map<string, number>();
  for (const call of calls) {
    if (call.program?.kind !== "shell") continue;
    const text = call.arguments[call.program.argument];
    if (typeof text !== "string") continue;
    let tokens: ProgramToken[];
    try {
      tokens = tokenizeProgram("shell", text);
    } catch (error) {
      if (error instanceof ProgramTokenizationError) continue;
      throw error;
    }
    const bodyStart = heredocStart("shell", text);
    const positions = shellArgumentPositions(tokens);
    const words = new Set<string>();
    for (const [index, token] of tokens.entries()) {
      if (token.start >= bodyStart) break;
      if ((positions[index] ?? 0) >= 2 && token.kind === "word" && typeof token.value === "string")
        words.add(token.value);
    }
    for (const word of words) callsByWord.set(word, (callsByWord.get(word) ?? 0) + 1);
  }
  return new Set([...callsByWord].flatMap(([word, count]) => (count >= 2 ? [word] : [])));
}

/** String literals of embedded programs that two or more shell calls ran with. */
function sharedEmbeddedStrings(calls: readonly DerivationCall[]): Set<string> {
  const callsByValue = new Map<string, number>();
  for (const call of calls) {
    if (call.program?.kind !== "shell") continue;
    const text = call.arguments[call.program.argument];
    if (typeof text !== "string") continue;
    const values = new Set<string>();
    for (const program of embeddedPrograms(text)) {
      for (const token of program.tokens) {
        if (token.bindable && token.kind === "string" && typeof token.value === "string") {
          values.add(token.value);
        }
      }
    }
    for (const value of values) callsByValue.set(value, (callsByValue.get(value) ?? 0) + 1);
  }
  return new Set([...callsByValue].flatMap(([value, count]) => (count >= 2 ? [value] : [])));
}

function longFlagName(token: ProgramToken | undefined): string | undefined {
  const flag = token?.kind === "word" ? /^--([A-Za-z][A-Za-z0-9-]{0,30})$/.exec(token.raw) : null;
  return flag?.[1]?.toLowerCase().replace(/-/g, "_");
}

/**
 * A readable input name for a program value: its flag's name, else the role the recorded value
 * plays (`data_path`, `archive_path`, `date`, …). Only this machine sees the value, so the role is
 * named here; the cloud only sees private references.
 */
function programInputBaseName(
  value: string,
  tokens: readonly ProgramToken[],
  index: number,
): string {
  const flag = valueFlag(tokens, index);
  return inputRoleName([{ value, ...(flag === undefined ? {} : { flag }) }]);
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
 * `requestWords` are the words of the instruction the calls answered: a bare word the request named
 * (`Cut a release of the alpha project` → `./release test alpha`) is what the work runs on, even at
 * its first use.
 *
 * The function is a pure function of what it is given: no clock, no filesystem, no execution, and
 * no model. Two runs over the same recording produce the same derivation.
 */
export function deriveNativeCalls(
  calls: readonly DerivationCall[],
  requestWords: ReadonlySet<string> = new Set(),
  /**
   * Names an earlier derivation of this recording already gave. A value can first be offered at a
   * call before a later one, once a later call shares it; without these, that value would take a
   * name an earlier call's proposal already used for a different value.
   */
  givenInputNames: ReadonlyMap<string, string> = new Map(),
): NativeDerivation {
  const derived: DerivedCall[] = [];
  const candidates: WorkflowBindingCandidate[] = [];
  const extracts: DerivedExtract[] = [];
  // Weak caller-input suggestions never consume slots reserved for result evidence.
  const inputCandidates: WorkflowBindingCandidate[] = [];
  /**
   * The input each program value was offered as, in order of first appearance, so the same value
   * anywhere in the recording is one input and a name, once given, never changes as calls arrive.
   */
  const programInputs = new Map<string, string>(givenInputNames);
  const programInputNames = new Set<string>(givenInputNames.values());
  /** Values a file edit's added lines were offered as inputs for. */
  const patchInputValues = new Set<string>();
  /** Every typed primitive leaf shown before each call's result arrived. */
  const seenBeforeResult: Array<Set<string>> = [];

  /** Typed primitive leaves each call's own result contributed. */
  const resultValues: Array<Set<string>> = [];
  const seen = new Set<string>();
  /** Candidates (result, extract, and input) each family has taken, in order of arrival. */
  const resultUsed: Record<CandidateFamily, number> = { harness: 0, program: 0 };
  const inputUsed: Record<CandidateFamily, number> = { harness: 0, program: 0 };
  const familyOf = new Map<string, CandidateFamily>();
  const sharedWords = sharedShellWords(calls);
  const sharedEmbedded = sharedEmbeddedStrings(calls);

  for (const [index, call] of calls.entries()) {
    const family = candidateFamily(call);
    familyOf.set(call.stepId, family);
    const resultFull = () => resultUsed[family] >= MAX_CANDIDATES_PER_FAMILY;
    const inputFull = () => inputUsed[family] >= MAX_CANDIDATES_PER_FAMILY;
    const argumentLeaves: Array<{
      path: WorkflowValuePath;
      value: CandidateScalar;
    }> = [];
    for (const [argument, value] of Object.entries(call.arguments)) {
      scalarLeaves(value, [argument], argumentLeaves);
    }
    for (const leaf of argumentLeaves) seen.add(scalarKey(leaf.value));
    seenBeforeResult.push(new Set(seen));

    const resultLeaves: Array<{
      path: WorkflowValuePath;
      value: CandidateScalar;
    }> = [];
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
    if (resultFull() && inputFull()) continue;
    for (const leaf of argumentLeaves) {
      if (resultFull()) break;
      if (typeof leaf.value === "string" && leaf.value.length < MIN_CANDIDATE_STRING_LENGTH)
        continue;
      const argumentName = leaf.path[0];
      if (call.program?.argument === argumentName) continue;
      if (typeof argumentName !== "string") continue;
      const producers = producersOfValue(leaf.value, index, calls, resultValues, seenBeforeResult);
      if (producers.length === 0) continue;
      const first = producers[0]!;
      resultUsed[family] += 1;
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
    if (call.program === undefined && !inputFull()) {
      for (const [leafIndex, leaf] of argumentLeaves.entries()) {
        if (inputFull()) break;
        const argument = leaf.path[0];
        if (typeof argument !== "string") continue;
        const type = typeof leaf.value;
        if (type !== "string" && type !== "number" && type !== "boolean") continue;
        const path = leaf.path.slice(1);
        inputUsed[family] += 1;
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
        if (resultFull()) break;
        if (!token.bindable) continue;
        const value = token.value;
        if (typeof value !== "string" || value.length < MIN_CANDIDATE_STRING_LENGTH) continue;
        const producers = producersOfValue(value, index, calls, resultValues, seenBeforeResult);
        if (producers.length === 0) continue;
        const first = producers[0]!;
        resultUsed[family] += 1;
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

      // A token an earlier call printed inside its text output (`created deployment dep-9e983a`).
      // Whole-value equality above cannot see it; a locator on the producer's output can.
      if (call.program.kind === "shell") {
        const bound = new Set(
          candidates
            .filter((entry) => entry.stepId === call.stepId && entry.path[0] === "tokens")
            .map((entry) => entry.path[1]),
        );
        const bodyStart = heredocStart("shell", text);
        for (const [tokenIndex, token] of tokens.entries()) {
          if (resultFull()) break;
          if (token.start >= bodyStart) break;
          if (!token.bindable || typeof token.value !== "string" || bound.has(tokenIndex)) continue;
          if (requestWords.has(token.value)) continue;
          const found = printedBy(token.value, index, calls);
          if (found === undefined) continue;
          resultUsed[family] += 1;
          extracts.push({
            stepId: call.stepId,
            argument: call.program.argument,
            path: ["tokens", tokenIndex],
            producerStepId: calls[found.producer]!.stepId,
            locator: found.locator,
            evidence: { tokens: tokens.length, token: tokenIndex },
          });
        }
      }

      // A value the program ran with can be offered as an optional input that defaults to exactly
      // what the recording ran. One recording cannot show that the value varies, but omitting the
      // input reproduces the recording, so the offer is safe to confirm by replaying it unchanged.
      const bodyStart = heredocStart(call.program.kind, text);
      const offered = new Set<string>();
      // A shell word at command position — the first word of a simple command after any leading
      // assignments — names the program to run, never a value it runs with. A bare word past the
      // subcommand's position is a value when other calls ran with it too.
      const positions = call.program.kind === "shell" ? shellArgumentPositions(tokens) : undefined;
      // A script's record-field keys (`x['merchant']`) are its schema, never its data.
      const script = call.program.kind === "python" || call.program.kind === "javascript";
      const fieldKeys = script ? scriptRecordFieldKeys(text, tokens) : new Set<number>();
      for (const [tokenIndex, token] of tokens.entries()) {
        if (inputFull() || token.start >= bodyStart) break;
        const previous = tokenIndex > 0 ? tokens[tokenIndex - 1] : undefined;
        const position = positions?.[tokenIndex];
        if (positions !== undefined && (position === undefined || position === 0)) continue;
        const shared =
          position !== undefined &&
          typeof token.value === "string" &&
          ((position >= 2 && (sharedWords.has(token.value) || requestWords.has(token.value))) ||
            // A value an earlier edit wrote as an input is the same value where a command uses it.
            (position >= 1 && patchInputValues.has(token.value)));
        if (!isProgramValue(call.program.kind, token, previous, shared)) continue;
        if (fieldKeys.has(tokenIndex)) continue;
        const key = scalarKey(token.value);
        let name = programInputs.get(key);
        if (name === undefined) {
          if (offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) continue;
          const base =
            (script ? scriptTokenContextName(text, tokens, tokenIndex) : undefined) ??
            programInputBaseName(token.value, tokens, tokenIndex);
          name = base;
          for (let suffix = 2; programInputNames.has(name); suffix += 1) name = `${base}_${suffix}`;
          programInputs.set(key, name);
          programInputNames.add(name);
        } else if (!offered.has(name) && offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) {
          continue;
        }
        offered.add(name);
        inputUsed[family] += 1;
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

      // A value a file edit adds is offered when the request named it or an earlier call already
      // offered it as an input. A key (`port:`) is the file's structure, never a value, and the
      // input is named after that key when the value sits right after one.
      if (call.program.kind === "patch") {
        for (const [tokenIndex, token] of tokens.entries()) {
          if (inputFull()) break;
          const value = token.value;
          if (!token.bindable || typeof value !== "string") continue;
          if (value.length === 0 || value.length > MAX_PROGRAM_INPUT_LENGTH) continue;
          if (value.startsWith("-") || /^\s*:/.test(text.slice(token.end))) continue;
          const key = scalarKey(value);
          let name = programInputs.get(key);
          if (name === undefined && !requestWords.has(value)) continue;
          if (name === undefined) {
            if (offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) continue;
            const lineStart = text.lastIndexOf("\n", token.start) + 1;
            const field = /([A-Za-z_][A-Za-z0-9_]{0,30})\s*:\s*$/.exec(
              text.slice(lineStart, token.start),
            )?.[1];
            const base = field?.toLowerCase() ?? inputRoleName([{ value }]);
            name = base;
            for (let suffix = 2; programInputNames.has(name); suffix += 1)
              name = `${base}_${suffix}`;
            programInputs.set(key, name);
            programInputNames.add(name);
          } else if (!offered.has(name) && offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) {
            continue;
          }
          offered.add(name);
          patchInputValues.add(value);
          inputUsed[family] += 1;
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

      // A literal inside a program the command embeds (a heredoc body or a `-c` string) is offered
      // when the request named it or other calls ran with it too: the script is written around the
      // task's inputs, and its address stays inside that program so top-level indexes never move.
      if (call.program.kind === "shell") {
        for (const program of embeddedPrograms(text)) {
          const embeddedFields = scriptRecordFieldKeys(text, program.tokens);
          for (const [embeddedIndex, token] of program.tokens.entries()) {
            if (inputFull()) break;
            const value = token.value;
            if (!token.bindable || token.kind !== "string" || typeof value !== "string") continue;
            if (value.length === 0 || value.length > MAX_PROGRAM_INPUT_LENGTH) continue;
            if (!requestWords.has(value) && !sharedEmbedded.has(value)) continue;
            if (embeddedFields.has(embeddedIndex)) continue;
            const key = scalarKey(value);
            let name = programInputs.get(key);
            if (name === undefined) {
              if (offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) continue;
              const base =
                scriptTokenContextName(text, program.tokens, embeddedIndex) ??
                programInputBaseName(value, program.tokens, embeddedIndex);
              name = base;
              for (let suffix = 2; programInputNames.has(name); suffix += 1) {
                name = `${base}_${suffix}`;
              }
              programInputs.set(key, name);
              programInputNames.add(name);
            } else if (!offered.has(name) && offered.size >= MAX_PROGRAM_INPUTS_PER_CALL) {
              continue;
            }
            offered.add(name);
            inputUsed[family] += 1;
            inputCandidates.push({
              stepId: call.stepId,
              argument: call.program.argument,
              path: ["tokens", program.anchor, "embedded", embeddedIndex],
              proposed: { kind: "input", name, type: "string", recordedDefault: true },
              reason: "native-data-argument",
              evidence: { tokens: tokens.length, token: program.anchor, embedded: embeddedIndex },
              missing:
                "one recording does not establish that this value varies; omitted, the input keeps the recorded value",
            });
          }
        }
      }

      // Part of a token can carry an input: `out/emea-2025-03/summary.csv` holds the region and
      // month the command also ran with. A span is offered at segment boundaries for a value this
      // workflow already offers as an input (the token then follows that input instead of being an
      // input of its own), or for a request word, when nothing offers the token whole.
      const spanTargets: Array<{
        token: ProgramToken & { value: string };
        path: WorkflowValuePath;
      }> = [];
      for (const [tokenIndex, token] of tokens.entries()) {
        if (token.start >= bodyStart) break;
        const position = positions?.[tokenIndex];
        if (positions !== undefined && (position === undefined || position === 0)) continue;
        const patchValue =
          call.program.kind === "patch" &&
          token.bindable &&
          typeof token.value === "string" &&
          token.value.length > 0 &&
          token.value.length <= MAX_PROGRAM_INPUT_LENGTH &&
          !token.value.startsWith("-") &&
          !/^\s*:/.test(text.slice(token.end));
        if (!patchValue && !isProgramValue(call.program.kind, token, tokens[tokenIndex - 1], true))
          continue;
        if (fieldKeys.has(tokenIndex)) continue;
        spanTargets.push({
          token: token as ProgramToken & { value: string },
          path: ["tokens", tokenIndex],
        });
      }
      if (call.program.kind === "shell") {
        for (const program of embeddedPrograms(text)) {
          const embeddedFields = scriptRecordFieldKeys(text, program.tokens);
          for (const [embeddedIndex, token] of program.tokens.entries()) {
            if (embeddedFields.has(embeddedIndex)) continue;
            if (!token.bindable || token.kind !== "string" || typeof token.value !== "string") {
              continue;
            }
            spanTargets.push({
              token: token as ProgramToken & { value: string },
              path: ["tokens", program.anchor, "embedded", embeddedIndex],
            });
          }
        }
      }
      const inputValues = [...programInputs.keys()].flatMap((key) => {
        const [type, value] = JSON.parse(key) as [string, unknown];
        return type === "string" && typeof value === "string" && value.length > 0 ? [value] : [];
      });
      for (const target of spanTargets) {
        if (inputFull()) break;
        const value = target.token.value;
        const pathKey = JSON.stringify(target.path);
        const wholeIndex = inputCandidates.findIndex(
          (candidate) =>
            candidate.stepId === call.stepId &&
            candidate.argument === call.program!.argument &&
            JSON.stringify(candidate.path) === pathKey,
        );
        const needles = [
          ...inputValues.map((needle) => ({ needle, input: true })),
          ...[...requestWords]
            .filter((word) => word.length >= 3)
            .map((needle) => ({ needle, input: false })),
        ];
        const matches: Array<{
          start: number;
          end: number;
          needle: string;
          input: boolean;
        }> = [];
        for (const { needle, input } of needles) {
          if (needle.length >= value.length) continue;
          for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) {
            const end = at + needle.length;
            // A segment ends at the token's edge or at a character outside identifiers: `_` joins
            // words (`day_of_year`), so it never separates a segment.
            if (/\w/.test(value[at - 1] ?? "") || /\w/.test(value[end] ?? "")) {
              continue;
            }
            matches.push({ start: at, end, needle, input });
          }
        }
        // Inputs first, then longer values; overlapping occurrences keep the first chosen.
        matches.sort(
          (left, right) =>
            Number(right.input) - Number(left.input) ||
            right.end - right.start - (left.end - left.start) ||
            left.start - right.start,
        );
        const chosen: typeof matches = [];
        for (const match of matches) {
          if (chosen.length >= MAX_SPAN_CANDIDATES_PER_TOKEN) break;
          if (chosen.some((other) => other.start < match.end && match.start < other.end)) continue;
          chosen.push(match);
        }
        if (chosen.length === 0) continue;
        // A token a result may have produced — equal to an earlier result, or printed inside an
        // earlier call's output — is decided by that evidence, not split into parts: an input span
        // inside it would carry the recorded text the evidence says to read from that result.
        if (
          [...candidates, ...extracts].some(
            (candidate) =>
              candidate.stepId === call.stepId && JSON.stringify(candidate.path) === pathKey,
          )
        ) {
          continue;
        }
        // Only a span the call can still offer an input for may split the token: one the per-call
        // input cap or the family's candidate budget turns away would leave the token pinned to its
        // recorded text.
        chosen.sort((left, right) => left.start - right.start);
        const slots = new Set(offered);
        const budget = MAX_CANDIDATES_PER_FAMILY - inputUsed[family] + (wholeIndex >= 0 ? 1 : 0);
        const offerable = chosen
          .filter((match) => {
            const slot = programInputs.get(scalarKey(match.needle)) ?? `\u0000${match.needle}`;
            if (!slots.has(slot) && slots.size >= MAX_PROGRAM_INPUTS_PER_CALL) return false;
            slots.add(slot);
            return true;
          })
          .slice(0, Math.max(0, budget));
        // A token offered whole stays whole unless an input it carries says where it came from.
        if (wholeIndex >= 0) {
          if (!offerable.some((match) => match.input)) continue;
          inputCandidates.splice(wholeIndex, 1);
          inputUsed[family] -= 1;
        }
        for (const match of offerable) {
          if (inputFull()) break;
          const key = scalarKey(match.needle);
          let name = programInputs.get(key);
          if (name === undefined) {
            const base = inputRoleName([{ value: match.needle }]);
            name = base;
            for (let suffix = 2; programInputNames.has(name); suffix += 1)
              name = `${base}_${suffix}`;
            programInputs.set(key, name);
            programInputNames.add(name);
          }
          offered.add(name);
          const address = programTokenPath(target.path)!;
          inputUsed[family] += 1;
          inputCandidates.push({
            stepId: call.stepId,
            argument: call.program.argument,
            path: [...target.path, "span", match.start, match.end],
            proposed: {
              kind: "input",
              name,
              type: "string",
              recordedDefault: true,
            },
            reason: "native-data-argument",
            evidence: {
              tokens: tokens.length,
              token: address.token,
              ...(address.embedded === undefined ? {} : { embedded: address.embedded }),
              span: [match.start, match.end],
            },
            missing:
              "one recording does not establish that this part of the value varies; omitted, the input keeps the recorded value",
          });
        }
      }
    }
  }

  const resultPositions = new Set(
    [...candidates, ...extracts].map((candidate) =>
      JSON.stringify([candidate.stepId, candidate.argument, candidate.path]),
    ),
  );
  // Inputs fill what result evidence left of each family's budget, in recording order.
  const used: Record<CandidateFamily, number> = { ...resultUsed };
  for (const candidate of inputCandidates) {
    const family = familyOf.get(candidate.stepId) ?? "harness";
    if (used[family] >= MAX_CANDIDATES_PER_FAMILY) continue;
    if (resultPositions.has(JSON.stringify([candidate.stepId, candidate.argument, candidate.path])))
      continue;
    used[family] += 1;
    candidates.push(candidate);
  }
  return { calls: derived, candidates, extracts, inputNames: programInputs };
}

/**
 * Whether a token looks like a minted identifier rather than a word: `dep-9e983a`, a long hash, or
 * a prefixed hex id whose random part happens to be letters only (`dep-abcdef`, about 1 in 360).
 */
function looksMinted(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (value.length >= 12) return true;
  if (/[-_.:][0-9a-f]{6,}$|^[0-9a-f]{6,}[-_.:]/i.test(value)) return true;
  return value.length >= 4 && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/** Whether some string leaf of a value contains `needle`. */
function mentions(value: WorkflowJsonValue | undefined, needle: string): boolean {
  const leaves: Array<{ path: WorkflowValuePath; value: CandidateScalar }> = [];
  scalarLeaves(value, [], leaves);
  return leaves.some((leaf) => typeof leaf.value === "string" && leaf.value.includes(needle));
}

/**
 * The earlier call that printed `value` and the locator that finds it in that call's output.
 *
 * The producer is the latest earlier call whose text result holds the value as a whole run of its
 * characters, provided no call up to and including it was given the value: a value a call was
 * given is echoed, not minted. The locator is the shortest text before the value, on its own line,
 * that finds exactly this value in the producer's output.
 */
function printedBy(
  value: string,
  before: number,
  calls: readonly DerivationCall[],
): { producer: number; locator: ExtractLocator } | undefined {
  // A computed number is found as a whole run of digits, `.` and `-`, so a replay reads the new
  // number whatever its sign or precision; numbers coincide easily, so its locator must name it.
  const numeric = /^-?(?:\d+\.\d+|\d{3,})$/.test(value);
  if (!numeric && !looksMinted(value)) return undefined;
  const charset = numeric ? ["digit", "-", "."] : extractCharsetOf(value);
  if (charset === undefined) return undefined;
  const inCharset = (char: string | undefined): boolean => {
    const entry = char === undefined ? undefined : extractCharsetOf(char)?.[0];
    return entry !== undefined && charset.includes(entry);
  };
  let firstMention = before;
  for (let index = 0; index < before; index += 1) {
    if (mentions(calls[index]!.arguments, value)) {
      firstMention = index;
      break;
    }
  }
  for (let producer = Math.min(before, firstMention) - 1; producer >= 0; producer -= 1) {
    const output = calls[producer]!.result;
    if (typeof output !== "string") continue;
    let position = output.indexOf(value);
    while (
      position >= 0 &&
      (inCharset(output[position - 1]) || inCharset(output[position + value.length]))
    ) {
      position = output.indexOf(value, position + 1);
    }
    if (position < 0) continue;
    const lineStart = output.lastIndexOf("\n", position - 1) + 1;
    const prefix = output.slice(lineStart, position);
    const attempts: string[] = [];
    // The last one, two and three whole words before the value, with their separators.
    const words = [...prefix.matchAll(/\S+\s*/g)];
    for (const count of [1, 2, 3]) {
      const word = words[words.length - count];
      if (word !== undefined) attempts.push(prefix.slice(word.index));
    }
    attempts.push(lineStart > 0 ? output.slice(lineStart - 1, position) : prefix);
    if (position === 0) attempts.push("");
    for (const attempt of attempts) {
      if (attempt.length === 0 && position !== 0) continue;
      if (numeric && !/[A-Za-z]/.test(attempt)) continue;
      const locator = { before: attempt, charset };
      if (extractPrintedValue(output, locator) === value) return { producer, locator };
    }
    return undefined;
  }
  return undefined;
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
    const produceLeaves: Array<{
      path: WorkflowValuePath;
      value: CandidateScalar;
    }> = [];
    scalarLeaves(calls[producerIndex]!.result, [], produceLeaves);
    for (const produced of produceLeaves) {
      if (produced.value !== value || typeof produced.value !== typeof value) continue;
      producers.push({ stepId: calls[producerIndex]!.stepId, path: produced.path });
    }
  }
  return producers;
}
