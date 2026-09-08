/**
 * Discovery identifiers for built-in metadata discovery tools.
 */
const DISCOVERY_TOOL_IDENTIFIERS: Record<string, true> = {
  sys_search_tools: true,
  sys_get_tool_schema: true,
  sys_manage_tools: true,
  search_tools: true,
  get_tool_schema: true,
  manage_tools: true,
};

/**
 * Returns true if the identifier refers to a metadata discovery tool (search, get schema, manage tools).
 * Specifically excludes invoke_tool, which executes generated tools.
 */
export function isDiscoveryTool(nameOrId: string | undefined | null): boolean {
  if (!nameOrId || typeof nameOrId !== "string") {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(
    DISCOVERY_TOOL_IDENTIFIERS,
    nameOrId.trim().toLowerCase(),
  );
}

export interface SessionDiscoveryState {
  pendingTokens: number;
  charged: boolean;
  totalChargedTokens: number;
}

/**
 * Tracks metadata discovery overhead per gateway session.
 * Discovery overhead is drained once per generated tool invocation. Subsequent
 * discovery calls in the session continue to accumulate pending tokens for future
 * generated invocations. State is bounded via LRU eviction. Concurrent invocations
 * drain atomically without double-charging.
 */
export class SessionDiscoveryTracker {
  private static instance?: SessionDiscoveryTracker;
  private readonly sessionStates = new Map<string, SessionDiscoveryState>();
  private readonly maxSessions: number;

  constructor(options?: { maxSessions?: number }) {
    this.maxSessions = options?.maxSessions ?? 10_000;
  }

  static getInstance(): SessionDiscoveryTracker {
    if (!SessionDiscoveryTracker.instance) {
      SessionDiscoveryTracker.instance = new SessionDiscoveryTracker();
    }
    return SessionDiscoveryTracker.instance;
  }

  /**
   * Records discovery tokens for a session.
   * Allows continuous accumulation across the session lifetime.
   */
  recordDiscoveryOverhead(sessionId: string, tokens: number): void {
    if (!sessionId || typeof sessionId !== "string") {
      return;
    }
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    const intTokens = Math.floor(tokens);
    if (intTokens <= 0) {
      return;
    }

    let state = this.sessionStates.get(sessionId);
    if (!state) {
      if (this.sessionStates.size >= this.maxSessions) {
        const oldestKey = this.sessionStates.keys().next().value;
        if (oldestKey !== undefined) {
          this.sessionStates.delete(oldestKey);
        }
      }
      state = {
        pendingTokens: Math.min(Number.MAX_SAFE_INTEGER, intTokens),
        charged: false,
        totalChargedTokens: 0,
      };
      this.sessionStates.set(sessionId, state);
    } else {
      state.pendingTokens = Math.min(Number.MAX_SAFE_INTEGER, state.pendingTokens + intTokens);
      // Re-insert to maintain LRU access order
      this.sessionStates.delete(sessionId);
      this.sessionStates.set(sessionId, state);
    }
  }

  /**
   * Consumes pending discovery tokens for the session and resets pending tokens to 0.
   * Returns the consumed tokens (or 0 if none pending).
   * Concurrent invocations drain pending tokens atomically, preventing double-charging.
   */
  consumeDiscoveryTokens(sessionId: string): number {
    if (!sessionId || typeof sessionId !== "string") {
      return 0;
    }
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      return 0;
    }
    if (state.pendingTokens <= 0) {
      return 0;
    }
    const tokens = state.pendingTokens;
    state.pendingTokens = 0;
    state.charged = true;
    state.totalChargedTokens = Math.min(
      Number.MAX_SAFE_INTEGER,
      (state.totalChargedTokens || 0) + tokens,
    );

    // Re-insert to maintain LRU access order
    this.sessionStates.delete(sessionId);
    this.sessionStates.set(sessionId, state);

    return tokens;
  }

  /**
   * Checks if discovery overhead has been charged at least once for a session.
   */
  isCharged(sessionId: string): boolean {
    if (!sessionId || typeof sessionId !== "string") {
      return false;
    }
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      return false;
    }
    this.sessionStates.delete(sessionId);
    this.sessionStates.set(sessionId, state);
    return Boolean(state.charged);
  }

  /**
   * Gets pending discovery tokens for a session without consuming them.
   * Touches the session to maintain LRU access order.
   */
  getPendingTokens(sessionId: string): number {
    if (!sessionId || typeof sessionId !== "string") {
      return 0;
    }
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      return 0;
    }
    this.sessionStates.delete(sessionId);
    this.sessionStates.set(sessionId, state);
    return state.pendingTokens;
  }

  /**
   * Cleans up a session explicitly from the tracker.
   */
  cleanupSession(sessionId: string): void {
    if (sessionId && typeof sessionId === "string") {
      this.sessionStates.delete(sessionId);
    }
  }

  /**
   * Gets the total discovery tokens charged across all consumptions in a session.
   */
  getTotalChargedTokens(sessionId: string): number {
    if (!sessionId || typeof sessionId !== "string") {
      return 0;
    }
    return this.sessionStates.get(sessionId)?.totalChargedTokens ?? 0;
  }

  /**
   * Resets the tracker (for tests and teardown).
   */
  reset(): void {
    this.sessionStates.clear();
  }
}
