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
  parseDeterministicCommandSequence,
  safeParseDeterministicCommandSequence,
} from "@resin/contracts";
import { COMMAND_PARAMETER_KEYS, isShellToolName } from "./evidence-normalization.js";

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

const SHELL_COMMAND_WRAPPERS: Record<string, true> = {
  bash: true,
  sh: true,
  zsh: true,
  "/bin/bash": true,
  "/bin/sh": true,
  "/bin/zsh": true,
  "/usr/bin/bash": true,
  "/usr/bin/sh": true,
  "/usr/bin/zsh": true,
};

/**
 * Extracts a pre-redaction raw shell command string from a normalized session event.
 * Only unambiguous command_exec and known shell tool_call events yield a string.
 */
export function extractRawCommandStringFromEvent(event: NormalizedSessionEvent): string | null {
  if (event.type === "command_exec") {
    const cmdEvent = event as NormalizedCommandExecEvent;
    const rawCmd = typeof cmdEvent.command === "string" ? cmdEvent.command.trim() : "";
    if (rawCmd.length === 0) return null;

    const rawArgs = Array.isArray(cmdEvent.args) ? cmdEvent.args : [];

    // Shell wrapper invocations: bash -c "command" or bash -lc "command"
    if (SHELL_COMMAND_WRAPPERS[rawCmd] === true) {
      // Must have exactly two arguments: [-c flag, commandString].
      // Any extra positional arguments or missing command is rejected.
      if (
        rawArgs.length === 2 &&
        (rawArgs[0] === "-c" || rawArgs[0] === "-lc" || rawArgs[0] === "-cl") &&
        typeof rawArgs[1] === "string"
      ) {
        return rawArgs[1].trim() || null;
      }
      return null;
    }

    // If rawArgs is non-empty for a non-shell command, fail closed.
    // Never reconstruct structured argv by string concatenation to prevent argv data
    // (e.g. literal '&&' or quotes in an argument) from being interpreted as shell syntax.
    if (rawArgs.length > 0) {
      return null;
    }

    // rawArgs is empty: rawCmd represents the full command string.
    return rawCmd;
  }

  if (event.type === "tool_call") {
    const toolEvent = event as NormalizedToolCallEvent;
    if (!isShellToolName(toolEvent.toolName)) {
      return null;
    }

    const params = toolEvent.parameters;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return null;
    }

    const record = params as Record<string, unknown>;

    // Check if tool parameters provide a shell wrapper like command: "bash", args: ["-c", "..."]
    const directCmd = record.command;
    const directArgs = record.args;
    if (typeof directCmd === "string" && SHELL_COMMAND_WRAPPERS[directCmd.trim()] === true) {
      if (
        Array.isArray(directArgs) &&
        directArgs.length === 2 &&
        (directArgs[0] === "-c" || directArgs[0] === "-lc" || directArgs[0] === "-cl") &&
        typeof directArgs[1] === "string"
      ) {
        return directArgs[1].trim() || null;
      }
      return null;
    }

    // If args is present and non-empty for non-shell-wrapper, reject (fail closed for structured argv / mixed ambiguity)
    if (Array.isArray(directArgs) && directArgs.length > 0) {
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

function isSafeRelativePathToken(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith("-")) return false;
  if (token.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(token)) return false;
  if (token.includes("..")) return false;
  return true;
}

/**
 * Projects a raw shell command string into a deterministic command sequence evidence structure.
 *
 * Requirements:
 * - Only explicit '&&' sequencing is supported (rejects pipes, semicolons, redirections, expansions).
 * - Supported grammar:
 *     git status (--short, --porcelain)
 *     git diff (--stat, --name-only, --name-status)
 *     git log (--oneline, optional -n NUMBER in either order)
 *     lune run PATH (optional --suite STRING)
 *     stylua --check PATH... (one or more safe relative paths)
 *     selene [--allow-warnings] PATH... (one or more safe relative paths)
 * - Returns null on any malformed, hostile, unsupported, or ambiguous input (fail closed).
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

    // Assignments are rejected
    if (char === "=") {
      return null;
    }

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
  if (
    stepTokensList.length === 0 ||
    stepTokensList.length > DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSteps
  ) {
    return null;
  }
  let paramIndex = 0;
  const steps: DeterministicCommandStep[] = [];

  for (let s = 0; s < stepTokensList.length; s++) {
    const tokens = stepTokensList[s] as string[];
    if (tokens.length === 0 || tokens.length - 1 > DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxArgs) {
      return null;
    }

    const stepId = `step${s}`;
    const exe = tokens[0];
    if (exe !== "git" && exe !== "lune" && exe !== "stylua" && exe !== "selene") {
      return null;
    }

    const argv: DeterministicCommandArg[] = [];

    if (exe === "git") {
      if (tokens.length < 2) return null;
      const sub = tokens[1];

      if (sub === "status") {
        argv.push({ literal: "status" });
        if (tokens.length === 2) {
          // git status
        } else if (tokens.length === 3) {
          const flag = tokens[2];
          if (flag === "--short" || flag === "--porcelain") {
            argv.push({ literal: flag });
          } else {
            return null;
          }
        } else {
          return null;
        }
      } else if (sub === "diff") {
        argv.push({ literal: "diff" });
        if (tokens.length === 2) {
          // git diff
        } else if (tokens.length === 3) {
          const flag = tokens[2];
          if (flag === "--stat" || flag === "--name-only" || flag === "--name-status") {
            argv.push({ literal: flag });
          } else {
            return null;
          }
        } else {
          return null;
        }
      } else if (sub === "log") {
        argv.push({ literal: "log" });
        let hasOneline = false;
        let hasLimit = false;

        let t = 2;
        while (t < tokens.length) {
          const tok = tokens[t] as string;
          if (tok === "--oneline") {
            if (hasOneline) return null;
            hasOneline = true;
            argv.push({ literal: "--oneline" });
            t++;
          } else if (tok === "-n") {
            if (hasLimit) return null;
            t++;
            if (t >= tokens.length) return null;
            const numTok = tokens[t] as string;
            if (!/^[1-9][0-9]*$/.test(numTok)) return null;
            hasLimit = true;
            argv.push({ literal: "-n" });
            argv.push({ parameter: `arg${paramIndex++}`, role: "number" });
            t++;
          } else {
            return null;
          }
        }

        if (!hasOneline) return null;
      } else {
        return null;
      }

      steps.push({ id: stepId, executable: "git", argv });
    } else if (exe === "lune") {
      if (tokens.length < 3) return null;
      if (tokens[1] !== "run") return null;
      argv.push({ literal: "run" });

      const pathTok = tokens[2] as string;
      if (pathTok.length === 0 || pathTok.startsWith("-") || pathTok.includes("..")) {
        return null;
      }

      argv.push({ parameter: `arg${paramIndex++}`, role: "path" });

      if (tokens.length === 3) {
        // lune run PATH
      } else if (tokens.length === 5) {
        if (tokens[3] !== "--suite") return null;
        const suiteTok = tokens[4] as string;
        if (suiteTok.length === 0 || suiteTok.startsWith("-")) return null;
        argv.push({ literal: "--suite" });
        argv.push({ parameter: `arg${paramIndex++}`, role: "string" });
      } else {
        return null;
      }

      steps.push({ id: stepId, executable: "lune", argv });
    } else if (exe === "stylua") {
      if (tokens.length < 3) return null;
      if (tokens[1] !== "--check") return null;

      argv.push({ literal: "--check" });

      for (let t = 2; t < tokens.length; t++) {
        const pathTok = tokens[t] as string;
        if (!isSafeRelativePathToken(pathTok)) {
          return null;
        }
        argv.push({ parameter: `arg${paramIndex++}`, role: "path" });
      }

      steps.push({ id: stepId, executable: "stylua", argv });
    } else if (exe === "selene") {
      if (tokens.length < 2) return null;

      let pathStartIdx = 1;
      if (tokens[1] === "--allow-warnings") {
        argv.push({ literal: "--allow-warnings" });
        pathStartIdx = 2;
      }

      if (pathStartIdx >= tokens.length) {
        return null;
      }

      for (let t = pathStartIdx; t < tokens.length; t++) {
        const pathTok = tokens[t] as string;
        if (!isSafeRelativePathToken(pathTok)) {
          return null;
        }
        argv.push({ parameter: `arg${paramIndex++}`, role: "path" });
      }

      steps.push({ id: stepId, executable: "selene", argv });
    }
  }

  const sequence: DeterministicCommandSequence = {
    schemaVersion: DETERMINISTIC_COMMAND_SEQUENCE_SCHEMA_VERSION,
    kind: DETERMINISTIC_COMMAND_SEQUENCE_KIND,
    control: DETERMINISTIC_COMMAND_SEQUENCE_CONTROL,
    steps,
  };

  const parseResult = DeterministicCommandSequenceSchema.safeParse(sequence);
  if (!parseResult.success) {
    return null;
  }

  return parseResult.data;
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
