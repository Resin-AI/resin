import os from "node:os";

/**
 * Privacy sanitizer for everything the error reporter sends. Error messages and stack traces are
 * the only free text that leaves the process, so every string passes through here first: local
 * paths lose the home directory, project root and OS user names, and anything that looks like a
 * credential, e-mail address or URL query is replaced by a marker.
 */

export const MAX_MESSAGE_LENGTH = 1_000;
export const MAX_STACK_FRAMES = 50;
export const MAX_FEEDBACK_LENGTH = 5_000;

export interface SanitizeContext {
  /** The user's home directory, replaced by `~`. */
  readonly homeDir?: string;
  /** The current project or workspace root, replaced by `<project>`. */
  readonly projectRoot?: string;
  /** The OS account name, replaced by `<user>` wherever it appears as a path segment. */
  readonly username?: string;
}

export function defaultSanitizeContext(projectRoot: string = process.cwd()): SanitizeContext {
  let username: string | undefined;
  try {
    username = os.userInfo().username;
  } catch {
    username = undefined;
  }
  let homeDir: string | undefined;
  try {
    homeDir = os.homedir();
  } catch {
    homeDir = undefined;
  }
  return { homeDir, projectRoot, username };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every spelling a local path can take in a message: native, forward-slash and backslash. */
function pathVariants(value: string): string[] {
  const trimmed = value.replace(/[\\/]+$/, "");
  if (trimmed.length < 2) return [];
  const variants = new Set([trimmed, trimmed.replace(/\\/g, "/"), trimmed.replace(/\//g, "\\")]);
  return [...variants].sort((left, right) => right.length - left.length);
}

/**
 * Replaces `root` with `marker` when it is followed by a path separator or a boundary, so
 * `/home/al` does not rewrite `/home/alice`.
 */
function replacePathPrefix(input: string, root: string | undefined, marker: string): string {
  if (!root) return input;
  let output = input;
  for (const variant of pathVariants(root)) {
    const flags = /^[A-Za-z]:[\\/]/.test(variant) ? "gi" : "g";
    output = output.replace(
      new RegExp(`${escapeRegExp(variant)}(?=[\\\\/:)"'\\s]|$)`, flags),
      marker,
    );
  }
  return output;
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`]+/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s"',;]{6,}/gi;
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const KNOWN_TOKEN_PATTERN =
  /\b(?:phc_|phx_|phs_|sk-|sk_live_|sk_test_|rk_live_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|resin_sec_|resin_tok_|npm_|AIza)[A-Za-z0-9_-]{8,}/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|secret|password|passwd|pwd|passphrase|credentials?|signature|authorization|auth|cookie|session[_-]?id))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"'`)}\]]+)/gi;
const BARE_KEY_ASSIGNMENT_PATTERN = /\b(key)(\s*=\s*)("[^"]*"|'[^']*'|[^\s,;&"'`)}\]]+)/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Long opaque runs of letters and digits (API secrets, AWS secret keys, raw hex digests). */
const HIGH_ENTROPY_PATTERN = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;
const USER_PATH_PATTERN = /(^|[\s"'(=:]|file:\/\/)(\/home\/|\/Users\/|\/users\/)([^/\\\s"':)]+)/g;
const WINDOWS_USER_PATH_PATTERN =
  /\b([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])([^\\/\s"':)]+)/gi;

function redactUrl(match: string): string {
  const trailing = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
  const raw = trailing ? match.slice(0, -trailing.length) : match;
  if (/^file:/i.test(raw)) return match;
  let output = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1[REDACTED]@");
  output = output.replace(/[?#].*$/, (rest) => (rest.startsWith("#") ? "" : "?[REDACTED]"));
  return `${output}${trailing}`;
}

function hasLettersAndDigits(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/** A value after "name:" that is not ordinary prose: long, or mixing digits/symbols with letters. */
function looksLikeSecretValue(value: string): boolean {
  const bare = value.replace(/^["']|["']$/g, "");
  return bare.length >= 8 && (hasLettersAndDigits(bare) || /[^A-Za-z]/.test(bare));
}

/**
 * Redacts credentials and personal data from free text. Pure string transform; never throws.
 */
export function redactText(input: string): string {
  let output = input.replace(PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY]");
  output = output.replace(URL_PATTERN, redactUrl);
  output = output.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  output = output.replace(BASIC_AUTH_PATTERN, "Basic [REDACTED]");
  output = output.replace(JWT_PATTERN, "[REDACTED_JWT]");
  output = output.replace(KNOWN_TOKEN_PATTERN, "[REDACTED_TOKEN]");
  output = output.replace(AWS_ACCESS_KEY_PATTERN, "[REDACTED_AWS_KEY]");
  output = output.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (match: string, name: string, separator: string, value: string) => {
      if (value.startsWith("[REDACTED")) return match;
      // "name: value" is also ordinary prose ("auth: failed"); only redact secret-looking values.
      if (separator.trim() === ":" && !looksLikeSecretValue(value)) return match;
      return `${name}${separator}[REDACTED]`;
    },
  );
  output = output.replace(BARE_KEY_ASSIGNMENT_PATTERN, "$1$2[REDACTED]");
  output = output.replace(EMAIL_PATTERN, "<email>");
  output = output.replace(HIGH_ENTROPY_PATTERN, (match) =>
    hasLettersAndDigits(match) ? "[REDACTED_SECRET]" : match,
  );
  return output;
}

/**
 * Rewrites local paths: project root to `<project>`, home to `~`, and any remaining user-profile
 * path segment (other accounts, or when the home directory is unknown) to `<user>`.
 */
export function sanitizePaths(input: string, context: SanitizeContext = {}): string {
  let output = replacePathPrefix(input, context.projectRoot, "<project>");
  output = replacePathPrefix(output, context.homeDir, "~");
  output = output.replace(USER_PATH_PATTERN, "$1$2<user>");
  output = output.replace(WINDOWS_USER_PATH_PATTERN, "$1<user>");
  const username = context.username;
  if (username && username.length >= 3 && !/^(root|user|admin|runner)$/i.test(username)) {
    output = output.replace(
      new RegExp(`([\\\\/])${escapeRegExp(username)}(?=[\\\\/])`, "gi"),
      "$1<user>",
    );
  }
  return output;
}

export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 14))}…[truncated]`;
}

/** Sanitizes a free-text message: paths, then secrets, then the length cap. */
export function sanitizeText(
  input: string,
  context: SanitizeContext = {},
  maxLength: number = MAX_MESSAGE_LENGTH,
): string {
  try {
    return truncate(redactText(sanitizePaths(String(input), context)), maxLength);
  } catch {
    return "[unsanitizable]";
  }
}

export interface SanitizedStackFrame {
  readonly platform: "node:javascript";
  /** The frame's function, or {@link UNKNOWN_FRAME_FUNCTION} for a frame without one. */
  readonly function: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly in_app: boolean;
}

/**
 * The name of a frame without a function (`at file:line:col`). PostHog's error tracking drops an
 * exception any of whose frames lacks `function` ("missing field `function`"), so such a frame is
 * named the way PostHog's own stack parser names it.
 */
export const UNKNOWN_FRAME_FUNCTION = "?";

const FRAME_WITH_FUNCTION = /^\s*at\s+(?:async\s+)?(.*?)\s+\((.*)\)\s*$/;
const FRAME_WITHOUT_FUNCTION = /^\s*at\s+(?:async\s+)?(.*)\s*$/;
const LOCATION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

function parseLocation(location: string): { file: string; line?: number; column?: number } {
  const match = LOCATION_PATTERN.exec(location);
  if (!match) return { file: location };
  return {
    file: match[1] ?? location,
    line: Number.parseInt(match[2] ?? "", 10) || undefined,
    column: match[3] ? Number.parseInt(match[3], 10) : undefined,
  };
}

function isInApp(file: string): boolean {
  return !(
    file.startsWith("node:") ||
    file.startsWith("internal/") ||
    file.includes("/node_modules/posthog-node/") ||
    file.includes("\\node_modules\\posthog-node\\") ||
    file === "native" ||
    file === "<anonymous>"
  );
}

/**
 * Parses V8 stack lines into PostHog frames (outermost caller first), keeping at most
 * {@link MAX_STACK_FRAMES} of the innermost frames, with file:line:col after path sanitization.
 */
export function parseStackFrames(
  stack: string | undefined,
  context: SanitizeContext = {},
): SanitizedStackFrame[] {
  if (!stack) return [];
  const frames: SanitizedStackFrame[] = [];
  for (const line of stack.split("\n")) {
    if (!/^\s*at\s/.test(line)) continue;
    if (frames.length >= MAX_STACK_FRAMES) break;
    const withFunction = FRAME_WITH_FUNCTION.exec(line);
    const functionName = withFunction ? withFunction[1] : undefined;
    const rawLocation = withFunction ? withFunction[2] : FRAME_WITHOUT_FUNCTION.exec(line)?.[1];
    if (!rawLocation) continue;
    const location = parseLocation(rawLocation.trim());
    const filename = sanitizeText(location.file, context, 512);
    frames.push({
      platform: "node:javascript",
      function: functionName ? sanitizeText(functionName, context, 256) : UNKNOWN_FRAME_FUNCTION,
      filename,
      lineno: location.line,
      colno: location.column,
      in_app: isInApp(filename),
    });
  }
  return frames.reverse();
}

/**
 * Sanitizes a raw stack string: the message lines and at most {@link MAX_STACK_FRAMES} frames.
 */
export function sanitizeStack(stack: string | undefined, context: SanitizeContext = {}): string {
  if (!stack) return "";
  const lines = stack.split("\n");
  const header: string[] = [];
  const frameLines: string[] = [];
  for (const line of lines) {
    if (/^\s*at\s/.test(line)) {
      if (frameLines.length < MAX_STACK_FRAMES) frameLines.push(sanitizeText(line, context, 1_000));
    } else if (frameLines.length === 0) {
      header.push(line);
    }
  }
  return [sanitizeText(header.join("\n"), context), ...frameLines].join("\n");
}

const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{2,64}$/;

export interface SanitizedError {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly frames: SanitizedStackFrame[];
}

function readStringProperty(value: object, key: string): string | undefined {
  if (!(key in value)) return undefined;
  const property: unknown = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

/** Converts any thrown value into sanitized type/message/code/frames. Never throws. */
export function sanitizeError(error: unknown, context: SanitizeContext = {}): SanitizedError {
  try {
    if (error instanceof Error) {
      const code = readStringProperty(error, "code");
      return {
        type: sanitizeText(error.name || error.constructor?.name || "Error", context, 128),
        message: sanitizeText(error.message, context),
        code: code && ERROR_CODE_PATTERN.test(code) ? code : undefined,
        frames: parseStackFrames(error.stack, context),
      };
    }
    if (typeof error === "string") {
      return { type: "Error", message: sanitizeText(error, context), frames: [] };
    }
    if (error !== null && typeof error === "object") {
      const message = readStringProperty(error, "message");
      return {
        type: "NonErrorThrown",
        message: message ? sanitizeText(message, context) : "Non-Error object thrown",
        frames: [],
      };
    }
    return { type: "NonErrorThrown", message: `Thrown ${typeof error}`, frames: [] };
  } catch {
    return { type: "Error", message: "[unsanitizable error]", frames: [] };
  }
}

/** The error's cause chain (at most `limit` levels, cycles ignored). */
export function errorCauses(error: unknown, limit = 3): unknown[] {
  const causes: unknown[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = error;
  while (causes.length < limit && current instanceof Error && "cause" in current) {
    const cause: unknown = current.cause;
    if (cause === undefined || cause === null || seen.has(cause)) break;
    seen.add(cause);
    causes.push(cause);
    current = cause;
  }
  return causes;
}
