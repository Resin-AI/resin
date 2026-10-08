/**
 * The stdin/stdout contracts of `resin suggest --harness <id>`.
 *
 * - `claude-code`: Claude Code's PreToolUse hook payload in (`tool_name`, `tool_input.command`,
 *   `cwd`, `session_id`); out, only on a suggestion, `{"hookSpecificOutput": {"hookEventName":
 *   "PreToolUse", "additionalContext": <line>}}`. No permission decision is ever returned, so the
 *   command runs exactly as it would without the hook.
 * - `omp`: Resin's OMP extension sends `{"command", "cwd", "sessionId"?}`; out, only on a
 *   suggestion, `{"additionalContext": <line>}`, which the extension returns from its `tool_call`
 *   handler.
 *
 * Anything else (another tool, another event, malformed input) produces no output.
 */
import path from "node:path";
import type { SuggestHarness } from "./render.js";
import type { SuggestRequest } from "./suggest.js";

function field(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function parseObject(text: string): object | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The request a Claude Code PreToolUse payload asks about, or undefined when it is not a Bash call. */
export function parseClaudeCodeHookInput(text: string): SuggestRequest | undefined {
  const payload = parseObject(text);
  if (payload === undefined) return undefined;
  const event = field(payload, "hook_event_name");
  if (event !== undefined && event !== "PreToolUse") return undefined;
  if (field(payload, "tool_name") !== "Bash") return undefined;
  const input = field(payload, "tool_input");
  if (typeof input !== "object" || input === null) return undefined;
  const command = nonEmptyString(field(input, "command"));
  const cwd = nonEmptyString(field(payload, "cwd"));
  if (command === undefined || cwd === undefined || !path.isAbsolute(cwd)) return undefined;
  const sessionId = nonEmptyString(field(payload, "session_id"));
  return {
    command,
    cwd,
    harness: "claude-code",
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

export function renderClaudeCodeHookOutput(line: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: line },
  })}\n`;
}

/** The request Resin's OMP extension sends, or undefined when malformed. */
export function parseOmpHookInput(text: string): SuggestRequest | undefined {
  const payload = parseObject(text);
  if (payload === undefined) return undefined;
  const command = nonEmptyString(field(payload, "command"));
  const cwd = nonEmptyString(field(payload, "cwd"));
  if (command === undefined || cwd === undefined || !path.isAbsolute(cwd)) return undefined;
  const sessionId = nonEmptyString(field(payload, "sessionId"));
  return { command, cwd, harness: "omp", ...(sessionId === undefined ? {} : { sessionId }) };
}

export function renderOmpHookOutput(line: string): string {
  return `${JSON.stringify({ additionalContext: line })}\n`;
}

export function parseHookInput(harness: SuggestHarness, text: string): SuggestRequest | undefined {
  return harness === "omp" ? parseOmpHookInput(text) : parseClaudeCodeHookInput(text);
}

export function renderHookOutput(harness: SuggestHarness, line: string): string {
  return harness === "omp" ? renderOmpHookOutput(line) : renderClaudeCodeHookOutput(line);
}
