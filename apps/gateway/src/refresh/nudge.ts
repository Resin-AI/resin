import type { NudgePayload, NudgeScope } from "./types.js";

/**
 * Standard invariant meta-tools reminder text instructing harnesses to use safe discovery tools.
 */
export const DEFAULT_META_TOOLS_REMINDER =
  "Always use invariant meta-tools (evolve_search_tools, evolve_get_tool_schema, evolve_invoke_tool) to dynamically discover, inspect, and invoke tools.";

/**
 * Regex for valid, safe tool identifiers.
 * Only alphanumeric characters, underscores, colons, hyphens, and periods are allowed.
 */
const SAFE_TOOL_ID_REGEX = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Sanitizes a tool ID to prevent prompt injection or markdown layout corruption.
 * Disallowed characters are replaced with underscores.
 */
export function sanitizeToolId(rawId: string): string {
  if (typeof rawId !== "string") {
    return "unknown_tool";
  }
  const trimmed = rawId.trim();
  if (SAFE_TOOL_ID_REGEX.test(trimmed)) {
    return trimmed;
  }
  // Replace disallowed characters (e.g. backticks, newlines, control characters, tags) with underscores
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 128);
  return cleaned || "sanitized_tool";
}

/**
 * Sanitizes a list of tool IDs.
 */
export function sanitizeToolIds(rawIds: readonly string[]): string[] {
  return rawIds.map(sanitizeToolId).filter((id) => id.length > 0);
}

export interface BuildNudgePayloadOptions {
  catalogRevision: number;
  scope: NudgeScope;
  addedToolIds?: readonly string[];
  updatedToolIds?: readonly string[];
  removedToolIds?: readonly string[];
  metaToolsReminder?: string;
  timestamp?: string;
}

/**
 * Builds a safe, structured NudgePayload.
 * Strictly guarantees that no untrusted candidate text (prompts, code, raw descriptions) is included.
 */
export function buildSafeNudgePayload(options: BuildNudgePayloadOptions): NudgePayload {
  const catalogRevision = Math.max(0, Math.floor(options.catalogRevision));
  const added = sanitizeToolIds(options.addedToolIds ?? []);
  const updated = sanitizeToolIds(options.updatedToolIds ?? []);
  const removed = sanitizeToolIds(options.removedToolIds ?? []);
  const metaToolsReminder = options.metaToolsReminder?.trim() || DEFAULT_META_TOOLS_REMINDER;
  const timestamp = options.timestamp || new Date().toISOString();

  const addedStr = added.length > 0 ? added.map((id) => `\`${id}\``).join(", ") : "none";
  const updatedStr = updated.length > 0 ? updated.map((id) => `\`${id}\``).join(", ") : "none";
  const removedStr = removed.length > 0 ? removed.map((id) => `\`${id}\``).join(", ") : "none";

  const scopeLabel = options.scope.sessionId
    ? `Workspace: \`${options.scope.workspaceId}\` | Session: \`${options.scope.sessionId}\``
    : `Workspace: \`${options.scope.workspaceId}\``;

  const noticeMessage = [
    `[Tool Catalog Update: Revision ${catalogRevision}]`,
    `Scope: ${scopeLabel}`,
    `Changes:`,
    `- Added: ${addedStr}`,
    `- Updated: ${updatedStr}`,
    `- Removed: ${removedStr}`,
    ``,
    `Reminder: ${metaToolsReminder}`,
  ].join("\n");

  return {
    catalogRevision,
    scope: {
      workspaceId: options.scope.workspaceId,
      ...(options.scope.sessionId ? { sessionId: options.scope.sessionId } : {}),
      ...(options.scope.accountRoot ? { accountRoot: options.scope.accountRoot } : {}),
    },
    addedToolIds: added,
    updatedToolIds: updated,
    removedToolIds: removed,
    metaToolsReminder,
    noticeMessage,
    timestamp,
  };
}

export interface NudgeDeduplicatorOptions {
  /**
   * Maximum allowed nudges per minute per scope before rate limiting kicks in.
   * Default: 60.
   */
  maxNudgesPerMinute?: number;
}

/**
 * Enforces per-session & per-workspace deduplication policy (max 1 context notice per revision)
 * and sliding window rate limiting.
 */
export class NudgeDeduplicator {
  private readonly maxNudgesPerMinute: number;
  // scopeKey -> revision
  private readonly lastSentRevision = new Map<string, number>();
  // scopeKey -> timestamps of sent nudges in ms
  private readonly sendTimestamps = new Map<string, number[]>();

  constructor(options: NudgeDeduplicatorOptions = {}) {
    this.maxNudgesPerMinute = options.maxNudgesPerMinute ?? 60;
  }

  /**
   * Generates a composite key for scope tracking.
   */
  private makeScopeKey(scope: NudgeScope): string {
    return `${scope.workspaceId}::${scope.sessionId ?? "*"}`;
  }

  /**
   * Checks if sending a nudge for the given scope and revision is allowed.
   * Disallows if revision was already sent to this scope or if rate limited.
   */
  shouldSendNudge(scope: NudgeScope, revision: number): boolean {
    const key = this.makeScopeKey(scope);
    const lastRev = this.lastSentRevision.get(key);

    if (lastRev !== undefined && lastRev >= revision) {
      return false;
    }

    if (this.isRateLimited(scope)) {
      return false;
    }

    return true;
  }

  /**
   * Checks if the scope is currently rate limited (exceeded max nudges per minute).
   */
  isRateLimited(scope: NudgeScope): boolean {
    const key = this.makeScopeKey(scope);
    const now = Date.now();
    const windowStart = now - 60_000;

    const timestamps = this.sendTimestamps.get(key);
    if (!timestamps || timestamps.length === 0) {
      return false;
    }

    // Retain only timestamps in current 1-minute window
    const active = timestamps.filter((t) => t > windowStart);
    this.sendTimestamps.set(key, active);

    return active.length >= this.maxNudgesPerMinute;
  }

  /**
   * Records that a nudge was successfully sent for the given revision.
   */
  recordNudgeSent(scope: NudgeScope, revision: number): void {
    const key = this.makeScopeKey(scope);
    this.lastSentRevision.set(key, revision);

    const now = Date.now();
    const timestamps = this.sendTimestamps.get(key) ?? [];
    timestamps.push(now);
    this.sendTimestamps.set(key, timestamps);
  }

  /**
   * Returns the last revision sent for a given scope.
   */
  getLastSentRevision(scope: NudgeScope): number | undefined {
    return this.lastSentRevision.get(this.makeScopeKey(scope));
  }

  /**
   * Clears deduplication and rate limit history for a scope or all scopes.
   */
  clear(scope?: NudgeScope): void {
    if (scope) {
      const key = this.makeScopeKey(scope);
      this.lastSentRevision.delete(key);
      this.sendTimestamps.delete(key);
    } else {
      this.lastSentRevision.clear();
      this.sendTimestamps.clear();
    }
  }
}
