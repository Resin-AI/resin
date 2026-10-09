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
  type EmbeddedProgram,
  type ExtractLocator,
  type ExtractOnlyPlace,
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
  isShellGrammar,
  powershellValueName,
  programTokenPath,
  scriptRecordFieldKeys,
  scriptTokenContextName,
  shellCommandSite,
  tokenizeProgram,
  uniqueRoleName,
  valueFlag,
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
  program?: {
    kind: ProgramLanguage;
    argument: string;
    /**
     * A program Resin never tokenizes (cmd.exe, or a shell the record did not prove): nothing is
     * proposed inside its text, for its text as a whole, or for the call's other arguments.
     */
    opaque?: true;
  };
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
  /** Structural only: token count and position, and the value's span inside an inline option. */
  evidence: { tokens: number; token: number; span?: [number, number] };
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

/**
 * Stable typed identity for exact primitive comparison. String leaves include whole tool outputs
 * that every re-derivation of a growing recording reads again; a string caches its own hash, so a
 * lookup costs far less than serializing the output again.
 */
const STRING_KEY_LIMIT = 16384;
const STRING_KEY_CHARS_LIMIT = 32 * 1024 * 1024;
const stringKeys = new Map<string, string>();
let stringKeyChars = 0;

function scalarKey(value: CandidateScalar): string {
  if (typeof value !== "string") return JSON.stringify([typeof value, value]);
  let key = stringKeys.get(value);
  if (key === undefined) {
    key = JSON.stringify(["string", value]);
    if (
      stringKeys.size >= STRING_KEY_LIMIT ||
      stringKeyChars + key.length > STRING_KEY_CHARS_LIMIT
    ) {
      stringKeys.clear();
      stringKeyChars = 0;
    }
    stringKeys.set(value, key);
    stringKeyChars += key.length;
  }
  return key;
}

/**
 * Program texts are re-read by every derivation of a growing recording (each new call re-derives the
 * calls before it), so their tokenizations are shared. Tokenizing is pure, and nothing here mutates a
 * token list, so a cached list is the list a fresh tokenization would return.
 */
const TOKEN_CACHE_LIMIT = 2048;
const tokenCache = new Map<string, readonly ProgramToken[] | ProgramTokenizationError>();
const embeddedCache = new Map<string, readonly EmbeddedProgram[]>();

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= TOKEN_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function cachedTokens(kind: ProgramLanguage, text: string): readonly ProgramToken[] {
  const key = `${kind}\u0000${text}`;
  let entry = tokenCache.get(key);
  if (entry === undefined) {
    try {
      entry = remember(tokenCache, key, Object.freeze(tokenizeProgram(kind, text)));
    } catch (error) {
      if (!(error instanceof ProgramTokenizationError)) throw error;
      entry = remember(tokenCache, key, error);
    }
  }
  if (entry instanceof ProgramTokenizationError) throw entry;
  return entry;
}

function cachedEmbeddedPrograms(text: string): readonly EmbeddedProgram[] {
  return embeddedCache.get(text) ?? remember(embeddedCache, text, embeddedPrograms(text));
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
  const flag = longFlagName(previous) ?? powershellParameter(language, previous);
  if (flag !== undefined && /pass|secret|token|key|auth|cred/.test(flag)) return false;
  const shaped = /[/.\d]/.test(value);
  if (!isShellGrammar(language)) return token.kind === "string" && shaped;
  if (token.kind === "word" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.raw)) return false;
  return token.kind === "string" || shaped || flag !== undefined || shared;
}

/** Operators after which a shell word is at command position again. */
const SHELL_COMMAND_SEPARATORS = ["&&", "||", ";", "|", "|&", "(", "&"];

/**
 * Each shell token's place in its simple command: 0 at command position (leading assignments and
 * the program's name), 1 for the first argument (where a subcommand sits), 2 and on for the rest,
 * and undefined for an operator. A line break (a heredoc body included) ends a command too.
 */
function shellArgumentPositions(
  text: string,
  tokens: readonly ProgramToken[],
): Array<number | undefined> {
  let commandPosition = true;
  let argumentIndex = 0;
  let previousEnd = 0;
  return tokens.map((token) => {
    if (text.slice(previousEnd, token.start).includes("\n")) {
      commandPosition = true;
      argumentIndex = 0;
    }
    previousEnd = token.end;
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
    if (call.program === undefined || call.program.opaque || !isShellGrammar(call.program.kind))
      continue;
    const text = call.arguments[call.program.argument];
    if (typeof text !== "string") continue;
    let tokens: readonly ProgramToken[];
    try {
      tokens = cachedTokens(call.program.kind, text);
    } catch (error) {
      if (error instanceof ProgramTokenizationError) continue;
      throw error;
    }
    const positions = shellArgumentPositions(text, tokens);
    const words = new Set<string>();
    // A heredoc body's words carry no value: they are the text a command reads, not its arguments.
    for (const [index, token] of tokens.entries()) {
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
    if (call.program?.kind !== "shell" || call.program.opaque) continue;
    const text = call.arguments[call.program.argument];
    if (typeof text !== "string") continue;
    const values = new Set<string>();
    for (const program of cachedEmbeddedPrograms(text)) {
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

/** A PowerShell parameter's name (`-ApiToken` → `apitoken`), for a program in a PowerShell grammar. */
function powershellParameter(
  language: ProgramLanguage,
  token: ProgramToken | undefined,
): string | undefined {
  if (language !== "powershell" && language !== "pwsh") return undefined;
  const parameter =
    token?.kind === "word" ? /^-([A-Za-z][A-Za-z0-9_]{0,30})$/.exec(token.raw) : null;
  return parameter?.[1]?.toLowerCase();
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
  language: ProgramLanguage,
): string {
  const flag =
    language === "powershell" || language === "pwsh"
      ? (powershellValueName(tokens, index) ?? valueFlag(tokens, index))
      : valueFlag(tokens, index);
  const command = isShellGrammar(language) ? shellCommandSite(tokens, index) : undefined;
  return inputRoleName([
    {
      value,
      ...(flag === undefined ? {} : { flag }),
      ...(command === undefined ? {} : { command }),
    },
  ]);
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
  /**
   * When each typed primitive leaf was first shown: stage 2i while call i's arguments were shown,
   * 2i+1 once its result arrived. A leaf was shown before call i's result arrived exactly when its
   * first stage is at most 2i, so one map answers what a per-call copy of everything seen did.
   */
  const firstShown = new Map<string, number>();

  /** Typed primitive leaves each call's own result contributed, and those leaves themselves. */
  const resultValues: Array<Set<string>> = [];
  const resultLeavesOf: Array<Array<{ path: WorkflowValuePath; value: CandidateScalar }>> = [];
  /** The string leaves each call's arguments hold, read once per derivation when first needed. */
  const mentionStrings: Array<string[] | undefined> = [];
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
    for (const leaf of argumentLeaves) {
      const key = scalarKey(leaf.value);
      if (!firstShown.has(key)) firstShown.set(key, 2 * index);
    }

    const resultLeaves: Array<{
      path: WorkflowValuePath;
      value: CandidateScalar;
    }> = [];
    scalarLeaves(call.result, [], resultLeaves);
    resultLeavesOf.push(resultLeaves);
    resultValues.push(new Set(resultLeaves.map((leaf) => scalarKey(leaf.value))));
    for (const leaf of resultLeaves) {
      const key = scalarKey(leaf.value);
      if (!firstShown.has(key)) firstShown.set(key, 2 * index + 1);
    }
    const shown = { firstShown, resultValues, resultLeavesOf };

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
      const producers = producersOfValue(leaf.value, index, calls, shown);
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
    if (call.program !== undefined && call.program.opaque !== true) {
      const text = call.arguments[call.program.argument];
      if (typeof text !== "string") continue;
      let tokens: readonly ProgramToken[];
      try {
        tokens = cachedTokens(call.program.kind, text);
      } catch (error) {
        if (error instanceof ProgramTokenizationError) continue;
        throw error;
      }
      for (const [tokenIndex, token] of tokens.entries()) {
        if (resultFull()) break;
        if (!token.bindable) continue;
        const value = token.value;
        if (typeof value !== "string" || value.length < MIN_CANDIDATE_STRING_LENGTH) continue;
        const producers = producersOfValue(value, index, calls, shown);
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

      // A shell word at command position — the first word of a simple command after any leading
      // assignments — names the program to run, never a value it runs with.
      const positions = isShellGrammar(call.program.kind)
        ? shellArgumentPositions(text, tokens)
        : undefined;

      // A token an earlier call printed inside its text output (`created deployment dep-9e983a`).
      // Whole-value equality above cannot see it; a locator on the producer's output can.
      if (positions !== undefined) {
        const bound = new Set(
          candidates
            .filter((entry) => entry.stepId === call.stepId && entry.path[0] === "tokens")
            .map((entry) => entry.path[1]),
        );
        // A heredoc body's words are unbindable: the tokenizer lexes the body as another text.
        for (const [tokenIndex, token] of tokens.entries()) {
          if (resultFull()) break;
          if (!token.bindable || typeof token.value !== "string" || bound.has(tokenIndex)) continue;
          if (requestWords.has(token.value)) continue;
          // An operand: an option's value, or the last argument of its command — what a command
          // runs on, where a subcommand (`migration show`) only names what it does.
          const position = positions[tokenIndex];
          const next = positions[tokenIndex + 1];
          const operand =
            position !== undefined &&
            position >= 1 &&
            (valueFlag(tokens, tokenIndex) !== undefined || next === undefined || next === 0);
          let found = printedBy(token.value, index, calls, mentionStrings, operand);
          let span: { start: number; end: number } | undefined;
          // An inline option or field value (`-f commit_sha=<sha>`, `--run=<id>`) is read from the
          // output where the value alone was printed: the token keeps its name, the value is the
          // span after `=`.
          if (found === undefined) {
            const name = INLINE_VALUE_NAME.exec(token.value)?.[0];
            const value = name === undefined ? undefined : token.value.slice(name.length);
            if (value !== undefined && value.length > 0 && !requestWords.has(value)) {
              found = printedBy(value, index, calls, mentionStrings, true);
              span = { start: name!.length, end: token.value.length };
            }
          }
          if (found === undefined) continue;
          resultUsed[family] += 1;
          extracts.push({
            stepId: call.stepId,
            argument: call.program.argument,
            path:
              span === undefined
                ? ["tokens", tokenIndex]
                : ["tokens", tokenIndex, "span", span.start, span.end],
            producerStepId: calls[found.producer]!.stepId,
            locator: found.locator,
            evidence:
              span === undefined
                ? { tokens: tokens.length, token: tokenIndex }
                : { tokens: tokens.length, token: tokenIndex, span: [span.start, span.end] },
          });
        }
      }

      // A value the program ran with can be offered as an optional input that defaults to exactly
      // what the recording ran. One recording cannot show that the value varies, but omitting the
      // input reproduces the recording, so the offer is safe to confirm by replaying it unchanged.
      // A bare word past the subcommand's position is a value when other calls ran with it too.
      const offered = new Set<string>();
      // A script's record-field keys (`x['merchant']`) are its schema, never its data.
      const script = call.program.kind === "python" || call.program.kind === "javascript";
      const fieldKeys = script ? scriptRecordFieldKeys(text, tokens) : new Set<number>();
      for (const [tokenIndex, token] of tokens.entries()) {
        if (inputFull()) break;
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
          const contextName = script ? scriptTokenContextName(text, tokens, tokenIndex) : undefined;
          const command = isShellGrammar(call.program.kind)
            ? shellCommandSite(tokens, tokenIndex)
            : undefined;
          name = uniqueRoleName(
            contextName ?? programInputBaseName(token.value, tokens, tokenIndex, call.program.kind),
            command === undefined ? [] : [{ command }],
            programInputNames,
          );
          programInputs.set(key, name);
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
        for (const program of cachedEmbeddedPrograms(text)) {
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
                programInputBaseName(value, program.tokens, embeddedIndex, program.language);
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
        for (const program of cachedEmbeddedPrograms(text)) {
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
              candidate.stepId === call.stepId &&
              (JSON.stringify(candidate.path) === pathKey ||
                JSON.stringify(spanTokenOf(candidate.path)) === pathKey),
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
  // A token whose inline value is read from an earlier output keeps its name as recorded text: an
  // input over the whole token, or over a part of it, would overlap that hole.
  const spanExtractTokens = new Set(
    extracts.flatMap((extract) => {
      const token = spanTokenOf(extract.path);
      return token === undefined ? [] : [JSON.stringify([extract.stepId, extract.argument, token])];
    }),
  );
  // Inputs fill what result evidence left of each family's budget, in recording order.
  const used: Record<CandidateFamily, number> = { ...resultUsed };
  for (const candidate of inputCandidates) {
    const family = familyOf.get(candidate.stepId) ?? "harness";
    if (used[family] >= MAX_CANDIDATES_PER_FAMILY) continue;
    if (resultPositions.has(JSON.stringify([candidate.stepId, candidate.argument, candidate.path])))
      continue;
    const token = candidate.path[0] === "tokens" ? candidate.path.slice(0, 2) : undefined;
    if (
      token !== undefined &&
      candidate.path[2] !== "embedded" &&
      spanExtractTokens.has(JSON.stringify([candidate.stepId, candidate.argument, token]))
    )
      continue;
    used[family] += 1;
    candidates.push(candidate);
  }
  return { calls: derived, candidates, extracts, inputNames: programInputs };
}

/** The top-level token a span path (`["tokens", 4, "span", 11, 51]`) lies in; undefined otherwise. */
function spanTokenOf(path: WorkflowValuePath): WorkflowValuePath | undefined {
  return path[0] === "tokens" && path[2] === "span" ? path.slice(0, 2) : undefined;
}

/**
 * Whether a token looks like a minted identifier rather than a word: `dep-9e983a`, a long hash, or
 * a prefixed hex id whose random part happens to be letters only (`dep-abcdef`, about 1 in 360).
 * A flag (`--exit-status`) or a name made only of letters (`acme/widgets`, `fix/login-page`) is
 * chosen, not minted, however long: an earlier output that shows one may be echoing it, so it is
 * read only under the stricter rules `printedBy` gives a word.
 */
function looksMinted(value: string): boolean {
  if (/\s/.test(value) || value.startsWith("-")) return false;
  if (/[-_.:][0-9a-f]{6,}$|^[0-9a-f]{6,}[-_.:]/i.test(value)) return true;
  if (!/[0-9]/.test(value)) return false;
  if (value.length >= 12) return true;
  return value.length >= 4 && /[A-Za-z]/.test(value);
}

/** The name part of an inline option or field value: `commit_sha=`, `--run-id=`, `-f=`. */
const INLINE_VALUE_NAME = /^-{0,2}[A-Za-z_][\w.-]*=/;

/**
 * An integer shorter than this many digits (a pull request, issue or port number) coincides with
 * counts and options printed in prose, so it is read only from a structured position in the output.
 */
const MIN_UNSTRUCTURED_INTEGER_DIGITS = 6;

/** Occurrences of a value one producer's output is searched at, so a large output cannot stall. */
const MAX_PRINTED_OCCURRENCES = 16;

/** Characters a locator may start at inside a word: they open a path segment, field or parameter. */
const LOCATOR_OPENERS = "/?&=:#@\"'([{,;";

/** The longest locator text tried that names the value's position (`/pull/`, `"merge":"`). */
const MAX_NAMED_LOCATOR_LENGTH = 64;

type PrintedStructure = "path-segment" | "field" | "reference" | "table-cell";

/**
 * The structured position a value occupies in printed output, if any: a URL path segment after a
 * named segment (`/pull/107`), a `key=value` or JSON/YAML field value (`head=…`, `"merge": "…"`,
 * `id: 42`), a `#123` reference, or a cell of a tab-separated table row.
 */
function printedStructure(
  output: string,
  start: number,
  length: number,
): PrintedStructure | undefined {
  const end = start + length;
  const before = output.slice(Math.max(0, start - MAX_NAMED_LOCATOR_LENGTH), start);
  const next = output[end];
  const closedBy = (characters: string) =>
    next === undefined || /\s/.test(next) || characters.includes(next);
  if (/\/[A-Za-z][\w.-]*\/$/.test(before) && closedBy("/?#\"'),;]>")) return "path-segment";
  if (/(?:^|[^\w-])[A-Za-z_][\w.-]*=$/.test(before) && closedBy("&;,\"')]}")) return "field";
  if (
    (/"[A-Za-z_][\w.-]*"\s*:\s*"?$/.test(before) || /(?:^|\s)[A-Za-z_][\w-]*:\s+$/.test(before)) &&
    closedBy(",}]\"'")
  )
    return "field";
  if (/(?:^|[^\w&])#$/.test(before) && closedBy(".,;:)]}\"'")) return "reference";
  const lineStart = output.lastIndexOf("\n", start - 1) + 1;
  const lineBreak = output.indexOf("\n", end);
  const lineEnd = lineBreak < 0 ? output.length : lineBreak;
  if (
    output.slice(lineStart, lineEnd).includes("\t") &&
    (start === lineStart || output[start - 1] === "\t") &&
    (end === lineEnd || output[end] === "\t" || output[end] === "\r")
  )
    return "table-cell";
  return undefined;
}

/**
 * Texts before the value at `position` in `text` that may name where it is printed, in the order
 * they are tried. The shortest text naming the value's position comes first: from a word start or a
 * character that opens a segment or field (`/runs/`, `"merge":"`, `?code=`), holding a letter. It
 * names the field without repeating the run's other values, so a URL's owner and repository — often
 * a caller input — never become part of where the value is read. Then the last one, two and three
 * whole words, the whole line with the break before it, and the empty text at the start of `text`.
 */
function beforeTexts(text: string, position: number): string[] {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  const prefix = text.slice(lineStart, position);
  const named: string[] = [];
  for (
    let at = Math.max(0, prefix.length - MAX_NAMED_LOCATOR_LENGTH);
    at < prefix.length;
    at += 1
  ) {
    const opens = at === 0 || /\s/.test(prefix[at - 1]!) || LOCATOR_OPENERS.includes(prefix[at]!);
    if (!opens || /\s/.test(prefix[at]!)) continue;
    const suffix = prefix.slice(at);
    if (/[A-Za-z]/.test(suffix)) named.push(suffix);
  }
  named.sort((left, right) => left.length - right.length);
  const attempts = [...named];
  const words = [...prefix.matchAll(/\S+\s*/g)];
  for (const count of [1, 2, 3]) {
    const word = words[words.length - count];
    if (word !== undefined) attempts.push(prefix.slice(word.index));
  }
  attempts.push(lineStart > 0 ? text.slice(lineStart - 1, position) : prefix);
  if (position === 0) attempts.push("");
  return [...new Set(attempts)].filter((attempt) => attempt.length > 0 || position === 0);
}

/** Texts after the value ending at `end`, through its line's next one, two and three words. */
function afterTexts(output: string, end: number): string[] {
  const lineBreak = output.indexOf("\n", end);
  const rest = output.slice(end, lineBreak < 0 ? output.length : lineBreak);
  const attempts: string[] = [];
  for (const word of rest.matchAll(/\s*\S+/g)) {
    const text = rest.slice(0, word.index + word[0].length);
    if (attempts.length === 3 || text.length > MAX_NAMED_LOCATOR_LENGTH) break;
    attempts.push(text);
  }
  return attempts;
}

/** How far above the value's line a marker line is looked for. */
const MAX_MARKER_LINES_ABOVE = 8;

/** A marker word: letters no letter, digit or `_` adjoins, as `holdsMarkerWord` finds it. */
const MARKER_WORD = /(?<![A-Za-z0-9_])[A-Za-z]{3,64}(?![A-Za-z0-9_])/g;

/** What a printed value is, which decides the locators that may read it. */
type PrintedKind = "number" | "minted" | "word";

/**
 * A locator that reads exactly the value at `position` from `output`, or undefined.
 *
 * A number keeps the first-run form, and its locator must name it; only a table cell, whose row is
 * the structure, may be read at the start of its line. A minted identifier is read first by a
 * naming text before it (the first-run form). Then the value must be the only whole run its
 * locator finds: named by the text before it, by the label after it
 * (`0059_accounts_contact_email: NOT backward compatible`), by its position at a line start
 * (`\n  fastgraph`), or on the line a marker word on a line above names (`warnings`, one line
 * above `checkout  38 …`). A word is read only by its position or a marker. These texts hold no
 * digit: a count, version or date printed around a value changes with it. A minted identifier no
 * locator singles out stays an input: reading the first of several rows that start the same way
 * would guess, and another run's output can put a different line first.
 */
function locatePrinted(
  output: string,
  position: number,
  value: string,
  charset: string[],
  kind: PrintedKind,
  structure: PrintedStructure | undefined,
): ExtractLocator | undefined {
  const reads = (locator: ExtractLocator) => extractPrintedValue(output, locator) === value;
  const befores = beforeTexts(output, position);
  const named = befores.filter((before) => /[A-Za-z]/.test(before));
  const positional = befores.filter((before) => !/[A-Za-z]/.test(before));
  if (kind === "number") {
    for (const before of befores) {
      const tableStart = structure === "table-cell" && (before === "" || before === "\n");
      if (!/[A-Za-z]/.test(before) && !tableStart) continue;
      if (reads({ before, charset })) return { before, charset };
    }
    return undefined;
  }
  if (kind === "minted") {
    for (const before of named) if (reads({ before, charset })) return { before, charset };
  }
  // A word stands at its line's start (see `printedBy`): the text before it is only that.
  const places: ExtractOnlyPlace[] = [
    ...(kind === "word"
      ? []
      : [
          ...named.filter((before) => !/\d/.test(before)).map((before) => ({ before, after: "" })),
          ...afterTexts(output, position + value.length)
            .filter((after) => /[A-Za-z]/.test(after) && !/\d/.test(after))
            .map((after) => ({ before: "", after })),
        ]),
    ...positional.filter((before) => !/\d/.test(before)).map((before) => ({ before, after: "" })),
  ];
  for (const only of places) if (reads({ only, charset })) return { only, charset };
  return markedLocator(output, position, value, charset);
}

/**
 * A locator reading the value at `position` as the only whole run on its line, or the run its
 * line starts with, that line named as the first row under a header: the nearest non-blank line
 * above it, opening its block (the output or a blank line comes before it, so it is no earlier
 * row), holding no digit (a header or a label, not a row of measured values), and holding a
 * marker word no other line holds. A row further down is chosen by more than its place under the
 * header, so it is not read this way.
 */
function markedLocator(
  output: string,
  position: number,
  value: string,
  charset: string[],
): ExtractLocator | undefined {
  const lines = output.split("\n");
  const lineStart = output.lastIndexOf("\n", position - 1) + 1;
  const valueLine = output.slice(0, lineStart).split("\n").length - 1;
  let offset = 1;
  while (
    offset < valueLine &&
    offset < MAX_MARKER_LINES_ABOVE &&
    !lines[valueLine - offset]!.trim()
  )
    offset += 1;
  const markerLine = valueLine - offset;
  const markerText = lines[markerLine];
  if (markerText === undefined || !markerText.trim() || /\d/.test(markerText)) return undefined;
  if (markerLine > 0 && lines[markerLine - 1]!.trim()) return undefined;
  const valueText = lines[valueLine]!;
  const indent = valueText.slice(0, position - lineStart);
  const befores = beforeTexts(valueText, position - lineStart).filter(
    (before) => !/\d/.test(before),
  );
  // A value starting its row (`CHK-PAY-504     29  2026-09-02T07:28:32Z …`) is read from the line
  // start when other runs share its line.
  const lineStartBefores = indent.trim() === "" ? [`\n${indent}`] : [];
  // A marker another line also holds reads several lines, so the locator check refuses it.
  for (const marker of new Set(markerText.match(MARKER_WORD) ?? [])) {
    if (marker === value) continue;
    for (const before of new Set(["", ...lineStartBefores, ...befores])) {
      const locator = { only: { before, after: "", line: { marker, offset } }, charset };
      if (extractPrintedValue(output, locator) === value) return locator;
    }
  }
  return undefined;
}

/** The string leaves of a value, in the order and within the bounds `scalarLeaves` reads them. */
function stringLeaves(value: WorkflowJsonValue | undefined): string[] {
  const leaves: Array<{ path: WorkflowValuePath; value: CandidateScalar }> = [];
  scalarLeaves(value, [], leaves);
  return leaves.flatMap((leaf) => (typeof leaf.value === "string" ? [leaf.value] : []));
}

/**
 * Where `value` next stands in `text` at or after `from` as a whole run of its charset's characters:
 * `473` inside `…-46-473Z` or `pr473.log` is part of another value. -1 when it does not.
 */
function wholeIndexOf(
  text: string,
  value: string,
  charset: readonly string[],
  from: number,
): number {
  const inCharset = (char: string | undefined): boolean => {
    const entry = char === undefined ? undefined : extractCharsetOf(char)?.[0];
    return entry !== undefined && charset.includes(entry);
  };
  let position = text.indexOf(value, from);
  while (
    position >= 0 &&
    (inCharset(text[position - 1]) || inCharset(text[position + value.length]))
  )
    position = text.indexOf(value, position + 1);
  return position;
}

/**
 * The earlier call that printed `value` and the locator that finds it in that call's output.
 *
 * A value counts where it stands as a whole run of its characters, neither printed nor given
 * inside another value. The producer is the latest earlier call whose text result prints the
 * value, provided no call up to and including it was given the value: a value a call was given is
 * echoed, not minted. A short integer is read only where the output gives it a structured position
 * (`/pull/107`, `"number": 107`, `pr=107`, `#107`, a table cell).
 *
 * A word (`checkout`, `fastgraph`) is chosen as often as it is printed, so it is read only when the
 * call takes it as an `operand` — an option's value or its command's last argument, never a
 * subcommand — and only where the output starts a line with it: a listing's row names it, where a
 * printed command line (`gh run watch 123 --repo acme/widgets`) or prose would echo it. Its locator
 * must find it as the only run (see `locatePrinted`).
 */
function printedBy(
  value: string,
  before: number,
  calls: readonly DerivationCall[],
  mentionStrings: Array<string[] | undefined>,
  operand: boolean,
): { producer: number; locator: ExtractLocator } | undefined {
  // A computed number is found as a whole run of digits, `.` and `-`, so a replay reads the new
  // number whatever its sign or precision; numbers coincide easily, so its locator must name it.
  const kind: PrintedKind | undefined = /^-?(?:\d+\.\d+|\d{3,})$/.test(value)
    ? "number"
    : looksMinted(value)
      ? "minted"
      : operand &&
          value.length >= MIN_CANDIDATE_STRING_LENGTH &&
          !value.startsWith("-") &&
          /[A-Za-z]/.test(value)
        ? "word"
        : undefined;
  if (kind === undefined) return undefined;
  // A word is read as a name, letters joined by `-` or `_` (`checkout`, `search-indexer`), so a
  // replay reads the whole name another run printed there, whichever joiners it holds.
  const charset =
    kind === "number"
      ? ["digit", "-", "."]
      : extractCharsetOf(kind === "word" ? `${value}-_` : value);
  if (charset === undefined) return undefined;
  const structuredOnly = /^\d+$/.test(value) && value.length < MIN_UNSTRUCTURED_INTEGER_DIGITS;
  let firstMention = before;
  for (let index = 0; index < before; index += 1) {
    const strings = (mentionStrings[index] ??= stringLeaves(calls[index]!.arguments));
    if (strings.some((leaf) => wholeIndexOf(leaf, value, charset, 0) >= 0)) {
      firstMention = index;
      break;
    }
  }
  for (let producer = Math.min(before, firstMention) - 1; producer >= 0; producer -= 1) {
    const output = calls[producer]!.result;
    if (typeof output !== "string") continue;
    let seen = 0;
    for (
      let position = wholeIndexOf(output, value, charset, 0);
      position >= 0 && seen < MAX_PRINTED_OCCURRENCES;
      position = wholeIndexOf(output, value, charset, position + 1), seen += 1
    ) {
      const lineStart = output.lastIndexOf("\n", position - 1) + 1;
      if (kind === "word" && output.slice(lineStart, position).trim() !== "") continue;
      const structure = printedStructure(output, position, value.length);
      if (structuredOnly && structure === undefined) continue;
      const locator = locatePrinted(output, position, value, charset, kind, structure);
      if (locator !== undefined) return { producer, locator };
    }
  }
  return undefined;
}

/** A label an agent reads a value by: letters and spaces, as the cloud accepts it. */
const OPERAND_LABEL = /^[A-Za-z][A-Za-z ]{0,30}$/;

/** Labels one call's result reports, so a long command cannot grow its result carrier. */
const MAX_OPERAND_LABELS = 16;

/** What a call's own output calls one of the values its program ran with. */
export interface ProgramOperandLabel {
  argument: string;
  /** `["tokens", i]`, or `["tokens", i, "span", start, end]` for an inline option's value. */
  path: WorkflowValuePath;
  label: string;
}

/**
 * The labels a shell call's own output gives the values it ran with, past each command's name: an
 * agent reading `Package: fastgraph` after `release.py license fastgraph` knows the operand is a
 * package. Only the label leaves the device; the value and the text around it never do.
 */
export function programOperandLabels(
  program: NonNullable<DerivationCall["program"]>,
  args: Record<string, WorkflowJsonValue>,
  output: WorkflowJsonValue | undefined,
): ProgramOperandLabel[] {
  const text = args[program.argument];
  if (program.opaque || !isShellGrammar(program.kind) || typeof text !== "string") return [];
  if (typeof output !== "string" || output.length === 0) return [];
  let tokens: readonly ProgramToken[];
  try {
    tokens = cachedTokens(program.kind, text);
  } catch (error) {
    if (error instanceof ProgramTokenizationError) return [];
    throw error;
  }
  const positions = shellArgumentPositions(text, tokens);
  const labels: ProgramOperandLabel[] = [];
  for (const [index, token] of tokens.entries()) {
    if (labels.length >= MAX_OPERAND_LABELS) break;
    if (!token.bindable || typeof token.value !== "string" || !positions[index]) continue;
    const name = INLINE_VALUE_NAME.exec(token.value)?.[0];
    const start = name?.length ?? 0;
    const label = operandLabel(token.value.slice(start), output);
    if (label === undefined) continue;
    labels.push({
      argument: program.argument,
      path:
        name === undefined
          ? ["tokens", index]
          : ["tokens", index, "span", start, token.value.length],
      label,
    });
  }
  return labels;
}

/**
 * What `output` calls `value`, when it says so the same way everywhere. The label is the text
 * before the value on its line, without trailing `:`, `=` or space (`Package: fastgraph` →
 * `Package`), or — for a value that starts its line inside a block led by a digit-free header
 * line — the header word over its column (`service` over `checkout  38 …`). Occurrences without
 * such a label are skipped; two different labels give none. A label holding the value is dropped.
 */
function operandLabel(value: string, output: string): string | undefined {
  if (value.length === 0) return undefined;
  const charset = extractCharsetOf(value);
  if (charset === undefined) return undefined;
  let label: string | undefined;
  let seen = 0;
  for (
    let position = wholeIndexOf(output, value, charset, 0);
    position >= 0 && seen < MAX_PRINTED_OCCURRENCES;
    position = wholeIndexOf(output, value, charset, position + 1), seen += 1
  ) {
    const lineStart = output.lastIndexOf("\n", position - 1) + 1;
    const prefix = output.slice(lineStart, position);
    let found = prefix
      .replace(/[\s:=]+$/, "")
      .trim()
      .replace(/\s+/g, " ");
    if (found === "" && prefix.trim() === "") {
      found = columnHeader(output, lineStart, position - lineStart) ?? "";
    }
    if (!OPERAND_LABEL.test(found) || found.toLowerCase().includes(value.toLowerCase())) continue;
    if (label !== undefined && label !== found) return undefined;
    label = found;
  }
  return label;
}

/**
 * The header word over `column` for the line starting at `lineStart`: the first line of its block
 * (lines up to the previous blank line), when that line holds no digit and a word starts at the
 * column.
 */
function columnHeader(output: string, lineStart: number, column: number): string | undefined {
  let headerStart = lineStart;
  while (headerStart > 0) {
    const previousStart = output.lastIndexOf("\n", headerStart - 2) + 1;
    if (output.slice(previousStart, headerStart - 1).trim() === "") break;
    headerStart = previousStart;
  }
  if (headerStart === lineStart) return undefined;
  const lineBreak = output.indexOf("\n", headerStart);
  const header = output.slice(headerStart, lineBreak < 0 ? output.length : lineBreak);
  if (/\d/.test(header) || (column > 0 && !/\s/.test(header[column - 1] ?? ""))) return undefined;
  return /^[A-Za-z]+/.exec(header.slice(column))?.[0];
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
  shown: {
    firstShown: ReadonlyMap<string, number>;
    resultValues: ReadonlyArray<ReadonlySet<string>>;
    resultLeavesOf: ReadonlyArray<
      ReadonlyArray<{ path: WorkflowValuePath; value: CandidateScalar }>
    >;
  },
): Array<{ stepId: string; path: WorkflowValuePath }> {
  const producers: Array<{ stepId: string; path: WorkflowValuePath }> = [];
  const key = scalarKey(value);
  // Shown while some call's arguments were shown, or in an earlier result: never minted after it.
  const first = shown.firstShown.get(key);
  for (let producerIndex = 0; producerIndex < before; producerIndex += 1) {
    if (!shown.resultValues[producerIndex]!.has(key)) continue;
    if (first !== undefined && first <= 2 * producerIndex) continue;
    for (const produced of shown.resultLeavesOf[producerIndex]!) {
      if (produced.value !== value || typeof produced.value !== typeof value) continue;
      producers.push({ stepId: calls[producerIndex]!.stepId, path: produced.path });
    }
  }
  return producers;
}
