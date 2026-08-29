/**
 * Cloud Circuit Breaker & Health Tracking
 *
 * Implements a state machine (CLOSED, OPEN, HALF_OPEN) with exponential backoff
 * and multi-state health tracking (online, connecting, degraded, unauthorized, upgrade_required, offline).
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type CloudHealthStatus =
  | "online"
  | "connecting"
  | "degraded"
  | "unauthorized"
  | "upgrade_required"
  | "offline";

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures before tripping to OPEN.
   * Default: 3
   */
  failureThreshold?: number;
  /**
   * Number of consecutive successes in HALF_OPEN to reset to CLOSED.
   * Default: 2
   */
  successThreshold?: number;
  /**
   * Initial cooldown period in milliseconds before moving from OPEN to HALF_OPEN.
   * Default: 5000ms
   */
  resetTimeoutMs?: number;
  /**
   * Maximum backoff timeout in milliseconds for OPEN state.
   * Default: 60000ms
   */
  maxResetTimeoutMs?: number;
  /**
   * Backoff multiplier for consecutive OPEN state trips.
   * Default: 2
   */
  backoffFactor?: number;
}

export interface CloudHealthReport {
  status: CloudHealthStatus;
  circuitState: CircuitState;
  failureCount: number;
  consecutiveSuccesses: number;
  lastStateChange: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  lastErrorReason?: string;
  nextRetryAllowedAt?: number;
}

export class CloudCircuitBreaker {
  private state: CircuitState = "CLOSED";
  private health: CloudHealthStatus = "online";
  private failureCount = 0;
  private consecutiveSuccesses = 0;
  private consecutiveOpenTrips = 0;
  private lastStateChange: number = Date.now();
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private lastErrorReason?: string;
  private nextRetryAllowedAt?: number;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly initialResetTimeoutMs: number;
  private readonly maxResetTimeoutMs: number;
  private readonly backoffFactor: number;

  private readonly stateListeners = new Set<(state: CircuitState) => void>();
  private readonly healthListeners = new Set<(report: CloudHealthReport) => void>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.successThreshold = options.successThreshold ?? 2;
    this.initialResetTimeoutMs = options.resetTimeoutMs ?? 5000;
    this.maxResetTimeoutMs = options.maxResetTimeoutMs ?? 60000;
    this.backoffFactor = options.backoffFactor ?? 2;
  }

  /**
   * Current circuit state (CLOSED, OPEN, HALF_OPEN).
   */
  getState(): CircuitState {
    this.checkCooldownTransition();
    return this.state;
  }

  /**
   * Current health report.
   */
  getHealth(): CloudHealthReport {
    this.checkCooldownTransition();
    return {
      status: this.health,
      circuitState: this.state,
      failureCount: this.failureCount,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastStateChange: this.lastStateChange,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      lastErrorReason: this.lastErrorReason,
      nextRetryAllowedAt: this.nextRetryAllowedAt,
    };
  }

  /**
   * Checks whether a request can be dispatched.
   * Returns true if CLOSED or HALF_OPEN (after cooldown elapsed).
   */
  canExecute(): boolean {
    this.checkCooldownTransition();
    return this.state === "CLOSED" || this.state === "HALF_OPEN";
  }

  /**
   * Records a successful cloud operation.
   */
  recordSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.failureCount = 0;

    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transitionTo("CLOSED");
        this.consecutiveOpenTrips = 0;
        this.nextRetryAllowedAt = undefined;
        this.setHealth("online");
      } else {
        this.setHealth("degraded", "Trialing requests in HALF_OPEN state");
      }
    } else if (this.state === "CLOSED") {
      this.consecutiveSuccesses++;
      if (this.health !== "online") {
        this.setHealth("online");
      }
    }
  }

  /**
   * Records a failed cloud operation.
   */
  recordFailure(error?: unknown): void {
    const now = Date.now();
    this.lastFailureTime = now;
    this.failureCount++;
    this.consecutiveSuccesses = 0;

    const errorMsg = error instanceof Error ? error.message : String(error ?? "Unknown error");
    this.lastErrorReason = errorMsg;

    // Check for specific error types / status codes
    const isUnauthorized =
      (error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: unknown }).code === "unauthorized") ||
      (error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: unknown }).status === 401) ||
      errorMsg.toLowerCase().includes("unauthorized") ||
      errorMsg.toLowerCase().includes("token expired") ||
      errorMsg.toLowerCase().includes("device revoked");

    const isUpgradeRequired =
      (error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: unknown }).code === "upgrade_required") ||
      (error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: unknown }).status === 426) ||
      errorMsg.toLowerCase().includes("upgrade_required") ||
      errorMsg.toLowerCase().includes("upgrade required");

    if (isUnauthorized) {
      this.tripToOpen(now, errorMsg);
      this.setHealth("unauthorized", errorMsg);
      return;
    }

    if (isUpgradeRequired) {
      this.tripToOpen(now, errorMsg);
      this.setHealth("upgrade_required", errorMsg);
      return;
    }

    if (this.state === "HALF_OPEN") {
      // Immediate trip back to OPEN on any failure in HALF_OPEN
      this.tripToOpen(now, errorMsg);
      this.setHealth("offline", `Trial request failed: ${errorMsg}`);
    } else if (this.state === "CLOSED") {
      if (this.failureCount >= this.failureThreshold) {
        this.tripToOpen(now, errorMsg);
        this.setHealth(
          "offline",
          `Failure threshold (${this.failureThreshold}) reached: ${errorMsg}`,
        );
      } else {
        this.setHealth(
          "degraded",
          `Encountered ${this.failureCount}/${this.failureThreshold} failures: ${errorMsg}`,
        );
      }
    }
  }

  /**
   * Manually records health status (e.g. on stream disconnect or reconnect).
   */
  recordHealth(status: CloudHealthStatus, reason?: string): void {
    if (reason) {
      this.lastErrorReason = reason;
    }
    if (status === "offline" || status === "unauthorized" || status === "upgrade_required") {
      if (this.state !== "OPEN") {
        this.tripToOpen(Date.now(), reason);
      }
    } else if (status === "online") {
      if (this.state !== "CLOSED") {
        this.transitionTo("CLOSED");
        this.consecutiveOpenTrips = 0;
        this.failureCount = 0;
        this.nextRetryAllowedAt = undefined;
      }
    } else if (status === "connecting") {
      // connecting state
    }
    this.setHealth(status, reason);
  }

  /**
   * Resets circuit breaker to clean CLOSED & online state.
   */
  reset(): void {
    this.state = "CLOSED";
    this.health = "online";
    this.failureCount = 0;
    this.consecutiveSuccesses = 0;
    this.consecutiveOpenTrips = 0;
    this.lastStateChange = Date.now();
    this.lastFailureTime = undefined;
    this.lastSuccessTime = Date.now();
    this.lastErrorReason = undefined;
    this.nextRetryAllowedAt = undefined;
    this.notifyStateChange("CLOSED");
    this.notifyHealthChange();
  }

  /**
   * Subscribes to circuit state changes.
   */
  onStateChange(listener: (state: CircuitState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Subscribes to health report changes.
   */
  onHealthChange(listener: (report: CloudHealthReport) => void): () => void {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  private checkCooldownTransition(): void {
    if (this.state === "OPEN" && this.nextRetryAllowedAt !== undefined) {
      if (Date.now() >= this.nextRetryAllowedAt) {
        this.transitionTo("HALF_OPEN");
        this.consecutiveSuccesses = 0;
        if (this.health !== "unauthorized" && this.health !== "upgrade_required") {
          this.setHealth("connecting", "Testing cloud availability in HALF_OPEN");
        }
      }
    }
  }

  private tripToOpen(now: number, reason?: string): void {
    this.consecutiveOpenTrips++;
    const backoffExponent = Math.max(0, this.consecutiveOpenTrips - 1);
    const delay = Math.min(
      this.initialResetTimeoutMs * this.backoffFactor ** backoffExponent,
      this.maxResetTimeoutMs,
    );
    this.nextRetryAllowedAt = now + delay;
    this.transitionTo("OPEN");
  }

  private transitionTo(nextState: CircuitState): void {
    if (this.state !== nextState) {
      this.state = nextState;
      this.lastStateChange = Date.now();
      this.notifyStateChange(nextState);
    }
  }

  private setHealth(status: CloudHealthStatus, reason?: string): void {
    const changed = this.health !== status;
    this.health = status;
    if (reason) {
      this.lastErrorReason = reason;
    }
    if (changed) {
      this.notifyHealthChange();
    }
  }

  private notifyStateChange(state: CircuitState): void {
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private notifyHealthChange(): void {
    const report = this.getHealth();
    for (const listener of this.healthListeners) {
      try {
        listener(report);
      } catch {
        // ignore subscriber errors
      }
    }
  }
}
