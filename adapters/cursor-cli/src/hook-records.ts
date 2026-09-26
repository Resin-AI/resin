import { isRecord } from "./guards.js";

/**
 * Field contract for every hook payload Resin decodes, taken from cursor-agent
 * 2026.09.26-dd393fe's hook executor (`executeHookForStep` call sites). Every payload also
 * carries the executor's base fields: `hook_event_name`, `cursor_version`, `workspace_roots`
 * and (except for `sessionStart`) `transcript_path`. The capture script adds
 * `resin_received_at` and strips `user_email`.
 *
 * `required` fields must be present with the given type; their absence is format drift.
 * Additional fields are tolerated.
 */
type FieldType = "string" | "number" | "boolean" | "object" | "array";

export const CURSOR_HOOK_BASE_FIELDS: Readonly<Record<string, FieldType>> = {
  hook_event_name: "string",
  resin_received_at: "string",
  workspace_roots: "array",
};

export const CURSOR_HOOK_REQUIRED_FIELDS: Readonly<
  Record<string, Readonly<Record<string, FieldType>>>
> = {
  // Session ids arrive as `conversation_id` or `session_id` depending on the caller.
  sessionStart: {},
  sessionEnd: {},
  beforeSubmitPrompt: { conversation_id: "string", generation_id: "string", prompt: "string" },
  afterAgentThought: { conversation_id: "string", generation_id: "string", text: "string" },
  afterAgentResponse: { conversation_id: "string", generation_id: "string", text: "string" },
  postToolUse: { conversation_id: "string", tool_name: "string", tool_use_id: "string" },
  postToolUseFailure: {
    conversation_id: "string",
    tool_name: "string",
    tool_use_id: "string",
    error_message: "string",
  },
  afterFileEdit: { conversation_id: "string", file_path: "string", edits: "array" },
  preCompact: { conversation_id: "string", trigger: "string" },
  subagentStart: { conversation_id: "string", subagent_id: "string" },
  subagentStop: { conversation_id: "string" },
  stop: { conversation_id: "string", status: "string" },
};

export type CursorHookEventName = keyof typeof CURSOR_HOOK_REQUIRED_FIELDS;

export interface CursorHookDriftIssue {
  readonly kind: "not_an_object" | "unknown_event" | "missing_field" | "wrong_type";
  readonly event?: string;
  readonly field?: string;
  readonly detail: string;
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
  }
}

/**
 * Checks one captured payload against the pinned field contract. An empty list means the
 * payload decodes losslessly; anything else means cursor-agent's hook format drifted.
 */
export function inspectCursorHookPayload(payload: unknown): CursorHookDriftIssue[] {
  if (!isRecord(payload)) {
    return [{ kind: "not_an_object", detail: "hook payload is not a JSON object" }];
  }
  const event = payload.hook_event_name;
  const issues: CursorHookDriftIssue[] = [];
  const check = (fields: Readonly<Record<string, FieldType>>, eventName?: string): void => {
    for (const [field, type] of Object.entries(fields)) {
      if (!(field in payload) || payload[field] === undefined) {
        issues.push({ kind: "missing_field", event: eventName, field, detail: `missing ${field}` });
      } else if (!matchesType(payload[field], type)) {
        issues.push({
          kind: "wrong_type",
          event: eventName,
          field,
          detail: `${field} is ${Array.isArray(payload[field]) ? "array" : typeof payload[field]}, expected ${type}`,
        });
      }
    }
  };
  check(CURSOR_HOOK_BASE_FIELDS, typeof event === "string" ? event : undefined);
  if (typeof event !== "string") return issues;
  const fields = CURSOR_HOOK_REQUIRED_FIELDS[event];
  if (fields === undefined) {
    issues.push({ kind: "unknown_event", event, detail: `unknown hook event ${event}` });
    return issues;
  }
  check(fields, event);
  return issues;
}

/** Parses a JSONL spool line; null for blank or malformed lines. */
export function parseSpoolLine(line: string): Record<string, unknown> | null {
  if (line.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
