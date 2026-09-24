import { RESIN_LOCAL_OMP_NATIVE_CALL_KEY } from "@resin/adapter-omp";
import type { NormalizedSessionEvent, NormalizedToolCallEvent } from "@resin/contracts";
import { extractRawCommandStringFromEvent } from "../deterministic-command-sequence.js";
import {
  COMPUTATION_EVAL_TOOL_NAMES,
  COMPUTATION_TRUNCATION_MARKER,
  type ComputationFileAction,
  type ComputationLanguage,
  type ComputationSourceFrame,
  type ComputationSourceFrameOptions,
  type LocalComputationModule,
  hasComputationTruncationEvidence,
} from "./types.js";

/**
 * Source framing: recover the code an agent actually authored from normalized events.
 *
 * This module observes and frames; it never executes, never spawns a subprocess and never reads the
 * filesystem. A frame is either ordinary code recovered from an explicit code argument, an isolated
 * interpreter invocation, a safely delimited heredoc, or an observed file body — or it is a
 * fail-closed frame carrying a `rejectionReason`, which the recorder turns into invalidation.
 *
 * The load-bearing distinction is `executionScope`:
 *   - `persistent`       — a known eval kernel shares session+language state across cells.
 *   - `isolated`         — `python -c`, `node -e` and heredoc processes each get a fresh interpreter.
 *   - `file_observation` — a written/read file body is never executed by framing. Writing a script and
 *     later running it produces two independent frames, never one continuous kernel, so a shell
 *     process is never treated as a persistent kernel.
 *
 * Fail-closed rules, beyond the above:
 *   - Normalization truncation (the in-band marker or a `truncation:` scrub) rejects the frame: a
 *     surviving prefix is not the authored source, even when it parses.
 *   - A file edit carries a patch, never a body, so it invalidates instead of rebuilding a file.
 *   - Complex shell framing (pipelines, substitutions, redirects, compound commands) yields no
 *     guessed fragment.
 *   - An undeclared or unknown dialect yields no guessed language.
 *   - A persistent eval kernel's explicit reset (`reset: true` on the selected language's kernel) is
 *     carried on the frame as `reset`, including a reset-only cell with no body. Only a persistent
 *     eval kernel can reset; an isolated `python -c`/`node -e`/heredoc process never does.
 *
 * Framing is call-scoped: an inline program, a shell invocation and a write are framed from the call
 * event, because that is where the body is observable. A read is framed from the matching result.
 */

const MAX_FRAME_BYTES = 256 * 1024;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, ComputationLanguage>> = {
  py: "python",
  pyw: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
};

const LANGUAGE_ALIASES: Readonly<Record<string, ComputationLanguage>> = {
  python: "python",
  python3: "python",
  py: "python",
  javascript: "javascript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  typescript: "typescript",
  ts: "typescript",
};

const EVAL_TOOLS = table([
  ...COMPUTATION_EVAL_TOOL_NAMES,
  "run_code",
  "execute_code",
  "run_python",
  "run_js",
  "repl",
]);
const WRITE_TOOLS = table([
  "write",
  "write_file",
  "create_file",
  "create",
  "save_file",
  "file_write",
]);
const READ_TOOLS = table(["read", "read_file", "file_read", "read_text", "view"]);

function table(values: readonly string[]): Readonly<Record<string, true>> {
  const out: Record<string, true> = {};
  for (const value of values) {
    out[value] = true;
  }
  return out;
}

function has(tableRef: Readonly<Record<string, true>>, value: string): boolean {
  return Object.prototype.hasOwnProperty.call(tableRef, value);
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeLanguage(value: unknown): ComputationLanguage | undefined {
  return typeof value === "string" ? LANGUAGE_ALIASES[value.trim().toLowerCase()] : undefined;
}

function languageFromPath(filePath: string): ComputationLanguage | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0 || dot === filePath.length - 1) {
    return undefined;
  }
  return LANGUAGE_BY_EXTENSION[filePath.slice(dot + 1).toLowerCase()];
}

/** Canonicalize a tool name so `Write`, `write_file` and `write-file` agree. */
function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function executableBasename(executable: string): string {
  const unquoted = executable.trim().replace(/^["']|["']$/g, "");
  const segments = unquoted.replace(/\\/g, "/").split("/");
  const last = segments[segments.length - 1] ?? "";
  return last.toLowerCase().replace(/\.(exe|cmd|bat|sh)$/, "");
}

function basenameOfPath(filePath: string): string {
  const segments = filePath.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] ?? filePath;
}

/**
 * Interpreters whose invocations framing understands. A process started this way is isolated: it
 * never inherits a persistent kernel's definitions.
 */
function interpreterLanguage(executable: string): ComputationLanguage | undefined {
  switch (executableBasename(executable)) {
    case "python":
    case "python2":
    case "python3":
      return "python";
    case "node":
    case "nodejs":
    case "bun":
      return "javascript";
    case "deno":
    case "tsx":
    case "ts_node":
      return "typescript";
    default:
      return undefined;
  }
}

/**
 * Split a simple command line into whitespace-separated tokens, honoring single/double quotes.
 * Returns undefined for an unterminated quote or for any real shell metacharacter, which means the
 * line is not a simple invocation and must not be interpreted.
 */
function shellTokens(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        index++;
        current += command[index]!;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index++;
      current += command[index]!;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (/[|&;<>`$(){}]/.test(char)) {
      return undefined;
    }
    current += char;
    started = true;
  }
  if (quote !== undefined) {
    return undefined;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** Resolve a referenced path against the bounded known-file map; ambiguity fails closed. */
function resolveKnownFile(
  rawPath: string,
  knownFiles: ReadonlyMap<string, LocalComputationModule> | undefined,
): LocalComputationModule | undefined {
  if (knownFiles === undefined || knownFiles.size === 0) {
    return undefined;
  }
  const normalized = rawPath.replace(/\\/g, "/");
  const direct = knownFiles.get(rawPath) ?? knownFiles.get(normalized);
  if (direct !== undefined) {
    return direct;
  }
  const target = basenameOfPath(normalized);
  let match: LocalComputationModule | undefined;
  for (const [key, module] of knownFiles) {
    if (basenameOfPath(key) !== target) {
      continue;
    }
    if (match !== undefined) {
      // Two observed files share a basename; resolving would be a guess.
      return undefined;
    }
    match = module;
  }
  return match;
}

interface Candidate {
  readonly source: string;
  readonly language: ComputationLanguage;
  readonly originKind: ComputationSourceFrame["originKind"];
  readonly executionScope: ComputationSourceFrame["executionScope"];
  readonly path?: string;
  readonly fileAction?: ComputationFileAction;
  /** Text the source was recovered from; truncation evidence on it rejects the frame too. */
  readonly observed?: string;
  /**
   * True when the observation terminates the persistent kernel for this frame's language. Only a
   * known persistent eval kernel can carry it; an isolated interpreter process never resets anything.
   */
  readonly reset?: boolean;
}

type RejectionReason = NonNullable<ComputationSourceFrame["rejectionReason"]>;

function frameOf(event: NormalizedSessionEvent, candidate: Candidate): ComputationSourceFrame {
  const frame: ComputationSourceFrame = {
    language: candidate.language,
    source: candidate.source,
    originKind: candidate.originKind,
    executionScope: candidate.executionScope,
    sourceEventId: event.eventId,
  };
  if (candidate.path !== undefined) {
    frame.path = candidate.path;
  }
  if (candidate.fileAction !== undefined) {
    frame.fileAction = candidate.fileAction;
  }
  if (candidate.reset === true) {
    frame.reset = true;
  }
  return frame;
}

function rejectionFrame(
  event: NormalizedSessionEvent,
  reason: RejectionReason,
  language: ComputationLanguage,
  shape: Pick<Candidate, "originKind" | "executionScope" | "path" | "fileAction" | "reset"> = {
    originKind: "inline",
    executionScope: "isolated",
  },
): ComputationSourceFrame {
  const frame: ComputationSourceFrame = {
    language,
    source: "",
    originKind: shape.originKind,
    executionScope: shape.executionScope,
    sourceEventId: event.eventId,
    rejectionReason: reason,
  };
  if (shape.path !== undefined) {
    frame.path = shape.path;
  }
  if (shape.fileAction !== undefined) {
    frame.fileAction = shape.fileAction;
  }
  if (shape.reset === true) {
    // A rejected body still observes the state boundary the kernel announced.
    frame.reset = true;
  }
  return frame;
}

/** Reject truncated and oversize bodies; otherwise frame the candidate. */
function usableFrame(event: NormalizedSessionEvent, candidate: Candidate): ComputationSourceFrame {
  const shape = {
    originKind: candidate.originKind,
    executionScope: candidate.executionScope,
    ...(candidate.path === undefined ? {} : { path: candidate.path }),
    ...(candidate.fileAction === undefined ? {} : { fileAction: candidate.fileAction }),
    ...(candidate.reset === true ? { reset: true } : {}),
  };
  const truncated =
    hasComputationTruncationEvidence(event.redaction?.scrubbedPatterns) ||
    COMPUTATION_TRUNCATION_MARKER.test(candidate.source) ||
    (candidate.observed !== undefined && COMPUTATION_TRUNCATION_MARKER.test(candidate.observed));
  if (truncated) {
    return rejectionFrame(event, "truncated_source", candidate.language, shape);
  }
  if (Buffer.byteLength(candidate.source, "utf8") > MAX_FRAME_BYTES) {
    return rejectionFrame(event, "oversize_source", candidate.language, shape);
  }
  return frameOf(event, candidate);
}

// ============================================================================
// Inline eval kernels
// ============================================================================

function parametersOf(call: NormalizedToolCallEvent): Readonly<Record<string, unknown>> {
  const parameters: unknown = call.parameters;
  return typeof parameters === "object" && parameters !== null
    ? (parameters as Readonly<Record<string, unknown>>)
    : {};
}

function framesFromEvalCall(
  event: NormalizedSessionEvent,
  parameters: Readonly<Record<string, unknown>>,
): readonly ComputationSourceFrame[] {
  const declared = normalizeLanguage(
    parameters.language ?? parameters.lang ?? parameters.runtime ?? parameters.dialect,
  );
  // A persistent eval kernel exposes an explicit reset. It terminates the kernel of the SELECTED
  // language only, so it is carried even when the same cell defines no code at all.
  const reset = parameters.reset === true;
  const source =
    firstString(parameters.code) ??
    firstString(parameters.source) ??
    firstString(parameters.script) ??
    firstString(parameters.input);
  if (declared === undefined) {
    // An undeclared or unknown dialect is never guessed, and a reset cannot be attributed to a kernel.
    return source === undefined
      ? []
      : [
          rejectionFrame(event, "unknown_dialect", "python", {
            originKind: "inline",
            executionScope: "persistent",
          }),
        ];
  }
  if (source === undefined) {
    return reset
      ? [
          frameOf(event, {
            source: "",
            language: declared,
            originKind: "inline",
            executionScope: "persistent",
            reset: true,
          }),
        ]
      : [];
  }
  return [
    usableFrame(event, {
      source,
      language: declared,
      originKind: "inline",
      executionScope: "persistent",
      ...(reset ? { reset: true } : {}),
    }),
  ];
}

// ============================================================================
// Interpreter invocations
// ============================================================================

interface Invocation {
  /** Inline or heredoc program; empty when a known previously observed file is executed instead. */
  readonly source: string;
  readonly language: ComputationLanguage;
  readonly originKind: ComputationSourceFrame["originKind"];
  readonly path?: string;
  readonly fileAction?: ComputationFileAction;
}

/**
 * Extract the program from a simple `python -c '<code>'`, `node -e '<code>'`, `python3 - <<'EOF'`
 * or `<interpreter> path.py` invocation. Anything richer returns undefined so the caller fails closed
 * instead of guessing which fragment is the program.
 */
function parseInvocation(command: string): Invocation | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const heredoc =
    /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?:\r?\n|$)/.exec(
      trimmed,
    );
  if (heredoc !== null) {
    const header = trimmed.slice(0, heredoc.index);
    const withoutOperator = header.replace(/<<-?\s*["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*$/, "");
    const headerTokens = shellTokens(withoutOperator);
    if (headerTokens === undefined || headerTokens.length === 0) {
      return undefined;
    }
    const language = interpreterLanguage(headerTokens[0]!);
    if (language === undefined) {
      return undefined;
    }
    // A heredoc feeds stdin, so any remaining non-flag argument makes the body data, not the program.
    if (headerTokens.slice(1).some((token) => !token.startsWith("-"))) {
      return undefined;
    }
    const body = heredoc[2] ?? "";
    if (body.trim().length === 0) {
      return undefined;
    }
    return { source: `${body}\n`, language, originKind: "heredoc" };
  }

  const tokens = shellTokens(trimmed);
  if (tokens === undefined || tokens.length === 0) {
    return undefined;
  }
  const language = interpreterLanguage(tokens[0]!);
  if (language === undefined) {
    return undefined;
  }
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "-c" || token === "-e" || token === "--eval") {
      const inline = tokens[index + 1];
      if (inline === undefined || inline.trim().length === 0) {
        return undefined;
      }
      // Remaining tokens are program arguments, not more source.
      return { source: inline, language, originKind: "inline" };
    }
    if (token === "-m" || token === "--module") {
      // Module execution observes no authored body.
      return undefined;
    }
    if (token === "-") {
      // Reading stdin without an observed heredoc observes no body.
      return undefined;
    }
    if (token.startsWith("-")) {
      continue;
    }
    const fileLanguage = languageFromPath(token);
    if (fileLanguage === undefined) {
      return undefined;
    }
    return {
      source: "",
      language: fileLanguage,
      originKind: "referenced_file",
      path: token,
      fileAction: "execute",
    };
  }
  return undefined;
}

/** The interpreter heading a command, or undefined when the command is not an interpreter call. */
function commandInterpreter(command: string): ComputationLanguage | undefined {
  const tokens = shellTokens(command);
  const first = tokens?.[0] ?? command.trim().split(/\s+/)[0] ?? "";
  return interpreterLanguage(first);
}

function framesFromCommand(
  event: NormalizedSessionEvent,
  command: string,
  knownFiles: ReadonlyMap<string, LocalComputationModule> | undefined,
): readonly ComputationSourceFrame[] {
  const invocation = parseInvocation(command);
  if (invocation === undefined) {
    const language = commandInterpreter(command);
    if (language === undefined) {
      // A shell or unrelated command: never a persistent kernel, and its body is not observable.
      return [];
    }
    return [
      rejectionFrame(event, "ambiguous_shell", language, {
        originKind: "referenced_file",
        executionScope: "isolated",
      }),
    ];
  }
  if (invocation.fileAction === "execute" && invocation.path !== undefined) {
    const known = resolveKnownFile(invocation.path, knownFiles);
    if (known === undefined) {
      return [
        rejectionFrame(event, "unresolved_file", invocation.language, {
          originKind: "referenced_file",
          executionScope: "isolated",
          path: invocation.path,
          fileAction: "execute",
        }),
      ];
    }
    return [
      usableFrame(event, {
        source: known.source,
        language: known.language,
        originKind: "referenced_file",
        executionScope: "isolated",
        path: invocation.path,
        fileAction: "execute",
        observed: command,
      }),
    ];
  }
  return [
    usableFrame(event, {
      source: invocation.source,
      language: invocation.language,
      originKind: invocation.originKind,
      executionScope: "isolated",
      observed: command,
    }),
  ];
}

// ============================================================================
// File observations
// ============================================================================

function framesFromWriteCall(
  event: NormalizedSessionEvent,
  parameters: Readonly<Record<string, unknown>>,
): readonly ComputationSourceFrame[] {
  const path =
    firstString(parameters.path) ??
    firstString(parameters.filePath) ??
    firstString(parameters.file_path) ??
    firstString(parameters.targetPath) ??
    firstString(parameters.target);
  const content =
    firstString(parameters.content) ??
    firstString(parameters.text) ??
    firstString(parameters.body) ??
    firstString(parameters.fileText);
  if (path === undefined || content === undefined) {
    return [];
  }
  const language = languageFromPath(path);
  if (language === undefined) {
    // A non-code file body is not computation source.
    return [];
  }
  return [
    usableFrame(event, {
      source: content,
      language,
      originKind: "authored_file",
      executionScope: "file_observation",
      path,
      fileAction: "write",
    }),
  ];
}

function framesFromReadResult(
  event: NormalizedSessionEvent,
  call: NormalizedToolCallEvent,
): readonly ComputationSourceFrame[] {
  if (event.type !== "tool_result" || event.isError) {
    return [];
  }
  const parameters = parametersOf(call);
  const path =
    firstString(parameters.path) ??
    firstString(parameters.filePath) ??
    firstString(parameters.file_path) ??
    firstString(parameters.target);
  const body =
    typeof event.result === "string" && event.result.length > 0 ? event.result : undefined;
  const language = path === undefined ? undefined : languageFromPath(path);
  if (path === undefined || language === undefined || body === undefined) {
    return [];
  }
  return [
    usableFrame(event, {
      source: body,
      language,
      originKind: "referenced_file",
      executionScope: "file_observation",
      path,
      fileAction: "read",
    }),
  ];
}

/**
 * A file edit carries a patch, never a full body, so framing invalidates the observed file rather
 * than reconstructing one from a diff. A non-code path observes nothing.
 */
function framesFromFileEdit(event: NormalizedSessionEvent): readonly ComputationSourceFrame[] {
  if (event.type !== "file_edit") {
    return [];
  }
  const path = event.filePath;
  const language = languageFromPath(path);
  if (language === undefined) {
    return [];
  }
  return [
    rejectionFrame(event, "partial_edit", language, {
      originKind: "referenced_file",
      executionScope: "file_observation",
      path,
      fileAction: "write",
    }),
  ];
}

// ============================================================================
// Entry point
// ============================================================================

function framesFromToolCall(
  event: NormalizedSessionEvent,
  call: NormalizedToolCallEvent,
  knownFiles: ReadonlyMap<string, LocalComputationModule> | undefined,
): readonly ComputationSourceFrame[] {
  const tool = normalizeToolName(call.toolName);
  const parameters = parametersOf(call);

  const command = extractRawCommandStringFromEvent(event);
  if (command !== null) {
    return framesFromCommand(event, command, knownFiles);
  }
  if (has(EVAL_TOOLS, tool) || tool.endsWith("_eval")) {
    return framesFromEvalCall(event, parameters);
  }
  if (has(WRITE_TOOLS, tool)) {
    return framesFromWriteCall(event, parameters);
  }
  return [];
}

/**
 * Extract bounded, fail-closed source frames from one normalized event.
 *
 * The event is only read: no execution, no subprocess, no filesystem access, and no inference of a
 * dialect, a body or a shell fragment. `options.relatedCall` supplies the matching tool call when the
 * event is the result that carries a body; `options.knownFiles` is the recorder's bounded in-memory
 * file map.
 */
export function extractComputationSourceFrames(
  event: NormalizedSessionEvent,
  options: ComputationSourceFrameOptions = {},
): readonly ComputationSourceFrame[] {
  switch (event.type) {
    case "tool_call":
      return framesFromToolCall(event, event, options.knownFiles);
    case "tool_result": {
      const related = options.relatedCall;
      if (related === undefined) {
        return [];
      }
      if (
        related.toolName === "eval" &&
        event.toolName === "eval" &&
        related.callId === event.callId
      ) {
        const raw = event.metadata?.[RESIN_LOCAL_OMP_NATIVE_CALL_KEY];
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
        const handoff = raw as Record<string, unknown>;
        const parameters = handoff.parameters;
        if (
          handoff.callId !== event.callId ||
          handoff.toolName !== event.toolName ||
          typeof parameters !== "object" ||
          parameters === null ||
          Array.isArray(parameters)
        ) {
          return [];
        }
        return framesFromEvalCall(event, parameters as Record<string, unknown>);
      }
      return has(READ_TOOLS, normalizeToolName(related.toolName))
        ? framesFromReadResult(event, related)
        : [];
    }
    case "command_exec":
      return framesFromCommand(event, event.command, options.knownFiles);
    case "file_edit":
      return framesFromFileEdit(event);
    default:
      return [];
  }
}
