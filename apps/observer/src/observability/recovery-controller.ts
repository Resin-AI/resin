import fs from "node:fs";
import type { AuditActor } from "@resin/contracts";
import type { LocalDatabaseConnection } from "@resin/db";
import { inspectLockFile } from "../lock.js";
import type { JsonObject } from "../normalization/redaction.js";
import type { AuditTrailManager } from "./audit-trail.js";
import type { KillSwitchManager } from "./kill-switches.js";

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryableErrors?: (err: Error) => boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 50,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
  jitter: true,
};

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeoutMs?: number;
  successThreshold?: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 10000;
    this.successThreshold = options.successThreshold ?? 2;
  }

  getState(): CircuitBreakerState {
    if (this.state === "OPEN") {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.recoveryTimeoutMs) {
        this.state = "HALF_OPEN";
        this.successCount = 0;
      }
    }
    return this.state;
  }

  async execute<T>(op: () => Promise<T>): Promise<T> {
    const currentState = this.getState();
    if (currentState === "OPEN") {
      throw new Error(
        `Circuit breaker is OPEN (failed ${this.failureCount} times, cooldown active)`,
      );
    }

    try {
      const result = await op();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "CLOSED";
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (this.state === "CLOSED") {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
}

export interface QuarantinedToolEntry {
  toolId: string;
  version: string;
  quarantinedAt: string;
  reason: string;
  failureCount: number;
  lastError?: string;
  details?: JsonObject;
}

export interface ToolFailureStats {
  consecutiveFailures: number;
  totalFailures: number;
  lastFailureAt: number;
  lastError?: string;
}

export interface StaleLockRecoveryResult {
  recovered: boolean;
  previousPid?: number;
  reason: string;
  error?: string;
}

export interface RecoveryControllerOptions {
  quarantineThreshold?: number;
  quarantineWindowMs?: number;
  maxRetriesPerMinute?: number;
}

export class RecoveryController {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private toolStats = new Map<string, ToolFailureStats>();
  private quarantinedTools = new Map<string, QuarantinedToolEntry>();
  private retryBudgetTokens: number;
  private readonly maxRetryTokens: number;
  private lastBudgetRefillTime: number = Date.now();
  private readonly quarantineThreshold: number;

  constructor(
    private readonly options: RecoveryControllerOptions = {},
    private readonly auditTrail?: AuditTrailManager,
    private readonly killSwitches?: KillSwitchManager,
    private readonly conn?: LocalDatabaseConnection,
  ) {
    this.quarantineThreshold = options.quarantineThreshold ?? 3;
    this.maxRetryTokens = options.maxRetriesPerMinute ?? 60;
    this.retryBudgetTokens = this.maxRetryTokens;
  }

  // ---------------------------------------------------------------------------
  // 1. Retry Budget & Bounded Backoff
  // ---------------------------------------------------------------------------

  private refillRetryBudget(): void {
    const now = Date.now();
    const elapsedMinutes = (now - this.lastBudgetRefillTime) / 60000;
    if (elapsedMinutes >= 1) {
      this.retryBudgetTokens = this.maxRetryTokens;
      this.lastBudgetRefillTime = now;
    }
  }

  private consumeRetryToken(): boolean {
    this.refillRetryBudget();
    if (this.retryBudgetTokens > 0) {
      this.retryBudgetTokens--;
      return true;
    }
    return false;
  }

  getAvailableRetryBudget(): number {
    this.refillRetryBudget();
    return this.retryBudgetTokens;
  }

  async executeWithRetry<T>(
    operationName: string,
    op: () => Promise<T>,
    customPolicy?: Partial<RetryPolicy>,
  ): Promise<T> {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...customPolicy };
    let attempt = 0;
    let lastError: unknown;

    while (attempt < policy.maxAttempts) {
      attempt++;
      try {
        return await op();
      } catch (err) {
        lastError = err;

        if (attempt >= policy.maxAttempts) {
          break;
        }

        const error = err instanceof Error ? err : new Error(String(err));
        if (policy.retryableErrors && !policy.retryableErrors(error)) {
          throw err;
        }

        if (!this.consumeRetryToken()) {
          throw new Error(`Retry budget exhausted for operation '${operationName}'`);
        }

        let delayMs = policy.initialDelayMs * policy.backoffMultiplier ** (attempt - 1);
        delayMs = Math.min(delayMs, policy.maxDelayMs);

        if (policy.jitter) {
          const jitterRange = delayMs * 0.3;
          delayMs = delayMs - jitterRange + Math.random() * (jitterRange * 2);
        }

        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(delayMs))));
      }
    }

    throw lastError;
  }

  // ---------------------------------------------------------------------------
  // 2. Circuit Breakers
  // ---------------------------------------------------------------------------

  getCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    let cb = this.circuitBreakers.get(name);
    if (!cb) {
      cb = new CircuitBreaker(options);
      this.circuitBreakers.set(name, cb);
    }
    return cb;
  }

  async executeWithCircuitBreaker<T>(
    breakerName: string,
    op: () => Promise<T>,
    options?: CircuitBreakerOptions,
  ): Promise<T> {
    const cb = this.getCircuitBreaker(breakerName, options);
    return cb.execute(op);
  }

  // ---------------------------------------------------------------------------
  // 3. Stale Lock Recovery
  // ---------------------------------------------------------------------------

  async recoverStaleLock(
    lockPath: string,
    options: { staleThresholdMs?: number } = {},
  ): Promise<StaleLockRecoveryResult> {
    try {
      const inspection = await inspectLockFile(lockPath, options.staleThresholdMs ?? 15000);

      if (!inspection.exists) {
        return {
          recovered: true,
          reason: "No lock file found; path is free",
        };
      }

      if (inspection.isStale || !inspection.isProcessAlive) {
        const previousPid = inspection.pid;
        try {
          await fs.promises.unlink(lockPath);
          return {
            recovered: true,
            previousPid,
            reason: `Removed stale lock file from dead or unresponsive process (pid ${previousPid ?? "unknown"})`,
          };
        } catch (unlinkErr) {
          return {
            recovered: false,
            previousPid,
            reason: "Failed to remove stale lock file",
            error: String(unlinkErr),
          };
        }
      }

      return {
        recovered: false,
        previousPid: inspection.pid,
        reason: `Active daemon is running with pid ${inspection.pid}`,
      };
    } catch (err) {
      return {
        recovered: false,
        reason: "Failed to inspect lock file",
        error: String(err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Tool Failure Tracking & Quarantine
  // ---------------------------------------------------------------------------

  private toolKey(toolId: string, version: string): string {
    return `${toolId}@${version}`;
  }

  async recordToolFailure(
    toolId: string,
    version: string,
    error: Error | string,
  ): Promise<{ quarantined: boolean; reason?: string }> {
    const key = this.toolKey(toolId, version);
    const errMessage = error instanceof Error ? error.message : String(error);

    const stats = this.toolStats.get(key) ?? {
      consecutiveFailures: 0,
      totalFailures: 0,
      lastFailureAt: 0,
    };

    stats.consecutiveFailures++;
    stats.totalFailures++;
    stats.lastFailureAt = Date.now();
    stats.lastError = errMessage;
    this.toolStats.set(key, stats);

    if (stats.consecutiveFailures >= this.quarantineThreshold) {
      const reason = `Tool version failed ${stats.consecutiveFailures} consecutive times. Last error: ${errMessage}`;
      await this.quarantineTool(toolId, version, reason, {
        consecutiveFailures: stats.consecutiveFailures,
        totalFailures: stats.totalFailures,
      });

      return { quarantined: true, reason };
    }

    return { quarantined: false };
  }

  recordToolSuccess(toolId: string, version: string): void {
    const key = this.toolKey(toolId, version);
    const stats = this.toolStats.get(key);
    if (stats) {
      stats.consecutiveFailures = 0;
    }
  }

  isToolQuarantined(toolId: string, version?: string): boolean {
    if (version) {
      return this.quarantinedTools.has(this.toolKey(toolId, version));
    }
    // If version omitted, check if any version of toolId is quarantined
    for (const q of this.quarantinedTools.values()) {
      if (q.toolId === toolId) {
        return true;
      }
    }
    return false;
  }

  async quarantineTool(
    toolId: string,
    version: string,
    reason: string,
    details?: JsonObject,
  ): Promise<void> {
    const key = this.toolKey(toolId, version);
    const entry: QuarantinedToolEntry = {
      toolId,
      version,
      quarantinedAt: new Date().toISOString(),
      reason,
      failureCount: this.toolStats.get(key)?.totalFailures ?? 1,
      lastError: this.toolStats.get(key)?.lastError,
      details,
    };

    this.quarantinedTools.set(key, entry);

    if (this.auditTrail) {
      void this.auditTrail.append({
        eventType: "quarantine_applied",
        actor: { type: "daemon", id: "recovery-controller" },
        resourceType: "tool",
        resourceId: `${toolId}@${version}`,
        action: "quarantine_tool",
        status: "success",
        details: {
          toolId,
          version,
          reason,
          ...details,
        },
      });
    }

    if (this.killSwitches) {
      void this.killSwitches.disableTool(toolId, `Quarantined: ${reason}`, {
        type: "daemon",
        id: "recovery-controller",
      });
    }
  }

  async unquarantineTool(toolId: string, version?: string): Promise<void> {
    const actor: AuditActor = { type: "daemon", id: "recovery-controller" };
    if (version) {
      const key = this.toolKey(toolId, version);
      this.quarantinedTools.delete(key);
      const stats = this.toolStats.get(key);
      if (stats) stats.consecutiveFailures = 0;

      if (this.auditTrail) {
        void this.auditTrail.append({
          eventType: "quarantine_lifted",
          actor,
          resourceType: "tool",
          resourceId: `${toolId}@${version}`,
          action: "unquarantine_tool",
          status: "success",
        });
      }
    } else {
      for (const [key, q] of this.quarantinedTools.entries()) {
        if (q.toolId === toolId) {
          this.quarantinedTools.delete(key);
          const stats = this.toolStats.get(key);
          if (stats) stats.consecutiveFailures = 0;
        }
      }

      if (this.auditTrail) {
        void this.auditTrail.append({
          eventType: "quarantine_lifted",
          actor,
          resourceType: "tool",
          resourceId: toolId,
          action: "unquarantine_tool",
          status: "success",
        });
      }
    }

    if (this.killSwitches && !this.isToolQuarantined(toolId)) {
      void this.killSwitches.enableTool(toolId, actor);
    }
  }

  getQuarantinedTools(): QuarantinedToolEntry[] {
    return Array.from(this.quarantinedTools.values());
  }
}

export function createRecoveryController(
  options?: RecoveryControllerOptions,
  auditTrail?: AuditTrailManager,
  killSwitches?: KillSwitchManager,
  conn?: LocalDatabaseConnection,
): RecoveryController {
  return new RecoveryController(options, auditTrail, killSwitches, conn);
}
