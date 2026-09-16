import { createHash } from "node:crypto";
import {
  DETERMINISTIC_COMMAND_SEQUENCE_CONTROL,
  DETERMINISTIC_COMMAND_SEQUENCE_KIND,
  DETERMINISTIC_COMMAND_SEQUENCE_LIMITS,
  DETERMINISTIC_COMMAND_SEQUENCE_SCHEMA_VERSION,
  type DeterministicCommandArg,
  type DeterministicCommandSequence,
  DeterministicCommandSequenceSchema,
  type DeterministicCommandStep,
  type NormalizedCommandExecEvent,
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  isDeterministicCommandSequence,
  isUnsafeDeterministicCommandExecutable,
  parseDeterministicCommandSequence,
  safeParseDeterministicCommandSequence,
} from "@resin/contracts";
import {
  COMMAND_PARAMETER_KEYS,
  normalizeCommandProfile,
  tokenizeShellLine,
} from "./evidence-normalization.js";

export {
  isDeterministicCommandSequence,
  parseDeterministicCommandSequence,
  safeParseDeterministicCommandSequence,
};

const FORBIDDEN_CHARS: Record<string, true> = {
  "\n": true,
  "\r": true,
  "\0": true,
  ";": true,
  "|": true,
  ">": true,
  "<": true,
  $: true,
  "`": true,
  "(": true,
  ")": true,
  "{": true,
  "}": true,
  "[": true,
  "]": true,
  "#": true,
  "~": true,
  "!": true,
  "\\": true,
  "*": true,
  "?": true,
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Extracts a pre-redaction raw shell command string from a normalized session event.
 * Only structurally unambiguous command-bearing events yield a string.
 */
export function extractRawCommandStringFromEvent(event: NormalizedSessionEvent): string | null {
  if (event.type === "command_exec") {
    const cmdEvent = event as NormalizedCommandExecEvent;
    const rawCmd = typeof cmdEvent.command === "string" ? cmdEvent.command.trim() : "";
    if (rawCmd.length === 0) return null;

    const rawArgs = Array.isArray(cmdEvent.args) ? cmdEvent.args : [];

    // Treat an exact `-c`/login-command argv shape as a command wrapper without
    // requiring the wrapper executable to appear in a fixed name catalog.
    if (rawArgs.length > 0) {
      if (
        rawArgs.length === 2 &&
        (rawArgs[0] === "-c" || rawArgs[0] === "-lc" || rawArgs[0] === "-cl") &&
        typeof rawArgs[1] === "string"
      ) {
        return rawArgs[1].trim() || null;
      }
      // Never reconstruct general structured argv by string concatenation:
      // an argument containing `&&` must remain data, not become shell syntax.
      return null;
    }

    // rawArgs is empty: rawCmd represents the full command string.
    return rawCmd;
  }

  if (event.type === "tool_call") {
    const toolEvent = event as NormalizedToolCallEvent;

    const params = toolEvent.parameters;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return null;
    }

    const record = params as Record<string, unknown>;

    // Accept an exact command-wrapper argv shape for any command-bearing tool;
    // the structural shape, not a fixed wrapper/tool-name list, controls extraction.
    const directArgs = record.args;
    if (Array.isArray(directArgs) && directArgs.length > 0) {
      if (
        directArgs.length === 2 &&
        (directArgs[0] === "-c" || directArgs[0] === "-lc" || directArgs[0] === "-cl") &&
        typeof directArgs[1] === "string"
      ) {
        return directArgs[1].trim() || null;
      }
      return null;
    }

    let foundCmd: string | null = null;
    for (const key of COMMAND_PARAMETER_KEYS) {
      const val = record[key];
      if (typeof val === "string" && val.trim().length > 0) {
        if (foundCmd !== null && foundCmd !== val.trim()) {
          // Multiple conflicting command parameters -> ambiguous, reject
          return null;
        }
        foundCmd = val.trim();
      }
    }
    return foundCmd;
  }

  return null;
}

const PATH_PLACEHOLDERS: Record<string, true> = {
  $PATH: true,
  $SRC_FILE: true,
  $TEST_FILE: true,
  $CONFIG_FILE: true,
  $DOC_FILE: true,
  $BUILD_DIR: true,
  $TMP_DIR: true,
};

const STRING_PLACEHOLDERS: Record<string, true> = {
  $STR: true,
  $URL: true,
  $GLOB: true,
};

const PREFIXED_PARAMETER_PLACEHOLDER =
  /^(-{1,2}[A-Za-z][A-Za-z0-9_.-]*=)(\$PATH|\$SRC_FILE|\$TEST_FILE|\$CONFIG_FILE|\$DOC_FILE|\$BUILD_DIR|\$TMP_DIR|\$STR|\$URL|\$GLOB|\$NUM|-\$NUM|\+\$NUM)$/;

function placeholderRole(token: string): "path" | "string" | "number" | null {
  if (PATH_PLACEHOLDERS[token] === true) return "path";
  if (token === "$NUM" || token === "-$NUM" || token === "+$NUM") return "number";
  if (STRING_PLACEHOLDERS[token] === true) return "string";
  return null;
}

function valueSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Projects a raw shell command string into privacy-safe deterministic command
 * evidence. Any portable executable is accepted; argument values are replaced
 * by typed parameters through the shared command normalizer. Only explicit
 * `&&` sequencing is supported, and the compiled runtime still invokes each
 * executable directly without a shell.
 */
export function projectDeterministicCommandSequence(
  command: string,
): DeterministicCommandSequence | null {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;

  // Reject forbidden metacharacters immediately
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i] as string;
    if (FORBIDDEN_CHARS[char] === true) {
      return null;
    }
  }

  // Tokenize commands and split strictly by '&&' outside quotes
  const stepTokensList: string[][] = [];
  let currentTokens: string[] = [];
  let currentToken = "";
  let hasToken = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let expectingStep = false;

  const flushToken = () => {
    if (hasToken) {
      currentTokens.push(currentToken);
      currentToken = "";
      hasToken = false;
    }
  };

  const flushStep = () => {
    flushToken();
    if (currentTokens.length > 0) {
      stepTokensList.push(currentTokens);
      currentTokens = [];
    }
  };

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i] as string;

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        currentToken += char;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else {
        currentToken += char;
      }
      continue;
    }

    // Outside quotes
    if (char === "'") {
      // Reject quotes embedded in the middle of a token
      if (currentToken.length > 0) return null;
      hasToken = true;
      inSingleQuote = true;
      expectingStep = false;
      continue;
    }

    if (char === '"') {
      if (currentToken.length > 0) return null;
      hasToken = true;
      inDoubleQuote = true;
      expectingStep = false;
      continue;
    }

    if (char === "&") {
      // Must be followed by exactly one '&'
      if (trimmed[i + 1] !== "&") {
        return null;
      }
      if (trimmed[i + 2] === "&") {
        return null;
      }
      flushToken();
      if (currentTokens.length === 0) {
        // Leading or empty step like '&& cmd' or 'cmd && && cmd'
        return null;
      }
      flushStep();
      expectingStep = true;
      i++; // Skip the second '&'
      continue;
    }

    if (char === " " || char === "\t") {
      flushToken();
      continue;
    }

    // Environment assignments are rejected after tokenization so ordinary
    // shell-free `--flag=value` argv tokens remain representable.

    hasToken = true;
    expectingStep = false;
    currentToken += char;
  }

  // If quoting was left open, fail closed (do not heuristically repair)
  if (inSingleQuote || inDoubleQuote) {
    return null;
  }

  if (expectingStep) {
    return null;
  }

  flushStep();

  // If trailing && resulted in no following step, or no steps at all
  if (stepTokensList.length === 0) {
    return null;
  }
  if (stepTokensList.some((tokens) => tokens.some((token) => token.length === 0))) {
    return null;
  }
  // Length is bounded by the sequence argument budget and the raw command-length check above,
  // never by a fixed command count: a longer workflow stays representable as long as it fits.
  let totalArguments = 0;
  for (const tokens of stepTokensList) {
    totalArguments += Math.max(tokens.length - 1, 0);
  }
  if (totalArguments > DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSequenceArgs) {
    return null;
  }
  if (
    stepTokensList.some((tokens) => {
      const executable = tokens[0];
      if (!executable || ENV_ASSIGNMENT.test(executable)) return true;
      return isUnsafeDeterministicCommandExecutable(executable);
    })
  ) {
    return null;
  }
  const normalizedProfile = normalizeCommandProfile(trimmed, {
    maxTokens: stepTokensList.length + DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSequenceArgs,
    maxLength: 2048,
  });
  if (normalizedProfile.length === 0 || normalizedProfile.length >= 2048) {
    return null;
  }

  const normalizedSteps: string[][] = [];
  let normalizedStep: string[] = [];
  for (const token of tokenizeShellLine(normalizedProfile)) {
    if (!token.quoted && token.text === "&&") {
      if (normalizedStep.length === 0) return null;
      normalizedSteps.push(normalizedStep);
      normalizedStep = [];
      continue;
    }
    if (
      !token.quoted &&
      (token.text === "||" ||
        token.text === "|" ||
        token.text === ";" ||
        token.text === ">" ||
        token.text === ">>" ||
        token.text === "<" ||
        token.text === "2>" ||
        token.text === "2>>" ||
        token.text === "2>&1" ||
        token.text === "&>" ||
        token.text === "1>")
    ) {
      return null;
    }
    normalizedStep.push(token.text);
  }
  if (normalizedStep.length === 0) return null;
  normalizedSteps.push(normalizedStep);

  if (normalizedSteps.length !== stepTokensList.length) {
    return null;
  }

  let paramIndex = 0;
  const parameterValueSha256: Record<string, string> = {};
  const steps: DeterministicCommandStep[] = [];
  for (let stepIndex = 0; stepIndex < normalizedSteps.length; stepIndex++) {
    const tokens = normalizedSteps[stepIndex] as string[];
    const executable = stepTokensList[stepIndex]?.[0];
    if (!executable) return null;
    const argumentTokens = tokens.slice(1);
    const rawArgumentTokens = stepTokensList[stepIndex]?.slice(1);
    if (
      !rawArgumentTokens ||
      argumentTokens.length !== rawArgumentTokens.length ||
      argumentTokens.length > DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxArgs
    ) {
      return null;
    }

    const argv: DeterministicCommandArg[] = [];
    for (let argumentIndex = 0; argumentIndex < argumentTokens.length; argumentIndex++) {
      const token = argumentTokens[argumentIndex] as string;
      const rawArgument = rawArgumentTokens[argumentIndex] as string;
      const role = placeholderRole(token);
      if (role !== null) {
        const parameter = `arg${paramIndex++}`;
        argv.push({ parameter, role });
        if (role === "string") {
          parameterValueSha256[parameter] = valueSha256(rawArgument);
        }
        continue;
      }

      const prefixedParameter = token.match(PREFIXED_PARAMETER_PLACEHOLDER);
      if (prefixedParameter) {
        const prefix = prefixedParameter[1] as string;
        const prefixedRole = placeholderRole(prefixedParameter[2] as string);
        if (prefixedRole === null || !rawArgument.startsWith(prefix)) return null;
        const parameter = `arg${paramIndex++}`;
        argv.push({
          prefix,
          parameter,
          role: prefixedRole,
        });
        if (prefixedRole === "string") {
          parameterValueSha256[parameter] = valueSha256(rawArgument.slice(prefix.length));
        }
        continue;
      }

      if (token.includes("$")) return null;
      argv.push({ literal: token });
    }

    steps.push({
      id: `step${stepIndex}`,
      executable,
      argv,
    });
  }

  const sequence: DeterministicCommandSequence = {
    schemaVersion: DETERMINISTIC_COMMAND_SEQUENCE_SCHEMA_VERSION,
    kind: DETERMINISTIC_COMMAND_SEQUENCE_KIND,
    control: DETERMINISTIC_COMMAND_SEQUENCE_CONTROL,
    steps,
    ...(Object.keys(parameterValueSha256).length > 0 ? { parameterValueSha256 } : {}),
  };

  const parseResult = DeterministicCommandSequenceSchema.safeParse(sequence);
  return parseResult.success ? parseResult.data : null;
}

/**
 * Derives a deterministic command sequence from a session event if possible.
 */
export function projectDeterministicCommandSequenceFromEvent(
  event: NormalizedSessionEvent,
): DeterministicCommandSequence | null {
  const rawCommand = extractRawCommandStringFromEvent(event);
  if (rawCommand === null) {
    return null;
  }
  return projectDeterministicCommandSequence(rawCommand);
}
