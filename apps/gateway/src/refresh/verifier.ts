import crypto from "node:crypto";
import type { RefreshAttempt, RefreshVerification, RefreshVerificationStatus } from "./types.js";

interface PendingVerificationEntry {
  verification: RefreshVerification;
  timer: NodeJS.Timeout;
}

export interface VerifierOptions {
  defaultTimeoutMs?: number;
  maxHistorySize?: number;
}

/**
 * Manages opportunistic verification of catalog refreshes by observing subsequent
 * `tools/list` requests or explicit client acknowledgments.
 */
export class RefreshVerifier {
  private readonly defaultTimeoutMs: number;
  private readonly maxHistorySize: number;
  // verificationId -> PendingVerificationEntry
  private readonly pendingVerifications = new Map<string, PendingVerificationEntry>();
  // connectionId -> Set<verificationId>
  private readonly pendingByConnection = new Map<string, Set<string>>();
  // Historical log of verifications
  private readonly history: RefreshVerification[] = [];
  // Callbacks for verification state transitions
  private readonly listeners = new Set<(verification: RefreshVerification) => void>();

  constructor(options: VerifierOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxHistorySize = options.maxHistorySize ?? 1000;
  }

  /**
   * Registers a new refresh attempt for opportunistic verification.
   */
  registerAttempt(attempt: RefreshAttempt, timeoutMs?: number): RefreshVerification {
    const verificationId = `v-${crypto.randomUUID()}`;
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
    const now = new Date().toISOString();

    const verification: RefreshVerification = {
      verificationId,
      attemptId: attempt.attemptId,
      connectionId: attempt.connectionId,
      workspaceId: attempt.workspaceId,
      revision: attempt.revision,
      status: "pending",
      notifiedAt: now,
      observedVia: "none",
      timeoutMs: effectiveTimeoutMs,
    };
    if (attempt.sessionId !== undefined) {
      verification.sessionId = attempt.sessionId;
    }

    const timer = setTimeout(() => {
      this.handleTimeout(verificationId);
    }, effectiveTimeoutMs);

    // Prevent Node process from staying alive solely for verification timeouts
    if ("unref" in timer && timer.unref instanceof Function) {
      timer.unref();
    }

    this.pendingVerifications.set(verificationId, { verification, timer });

    let connSet = this.pendingByConnection.get(attempt.connectionId);
    if (!connSet) {
      connSet = new Set<string>();
      this.pendingByConnection.set(attempt.connectionId, connSet);
    }
    connSet.add(verificationId);

    this.addToHistory(verification);
    this.notifyListeners(verification);

    return verification;
  }

  /**
   * Handles timeout when a client does not observe the catalog change within the deadline.
   */
  private handleTimeout(verificationId: string): void {
    const entry = this.pendingVerifications.get(verificationId);
    if (!entry) return;

    this.pendingVerifications.delete(verificationId);
    const connSet = this.pendingByConnection.get(entry.verification.connectionId);
    if (connSet) {
      connSet.delete(verificationId);
      if (connSet.size === 0) {
        this.pendingByConnection.delete(entry.verification.connectionId);
      }
    }

    const updated: RefreshVerification = {
      ...entry.verification,
      status: "timeout",
    };

    this.addToHistory(updated);
    this.notifyListeners(updated);
  }

  /**
   * Records that `tools/list` was observed on a connection, transitioning pending verifications to `observed`.
   */
  recordToolsListObserved(connectionId: string, workspaceId?: string): RefreshVerification[] {
    const connSet = this.pendingByConnection.get(connectionId);
    if (!connSet || connSet.size === 0) {
      return [];
    }

    const observedVerifications: RefreshVerification[] = [];
    const now = new Date().toISOString();
    const verificationIds = Array.from(connSet);

    for (const vId of verificationIds) {
      const entry = this.pendingVerifications.get(vId);
      if (!entry) continue;

      if (workspaceId && entry.verification.workspaceId !== workspaceId) {
        continue;
      }

      clearTimeout(entry.timer);
      this.pendingVerifications.delete(vId);
      connSet.delete(vId);

      const observed: RefreshVerification = {
        ...entry.verification,
        status: "observed",
        verifiedAt: now,
        observedVia: "tools_list",
      };

      observedVerifications.push(observed);
      this.addToHistory(observed);
      this.notifyListeners(observed);
    }

    if (connSet.size === 0) {
      this.pendingByConnection.delete(connectionId);
    }

    return observedVerifications;
  }

  /**
   * Explicitly marks a verification as observed (e.g. via explicit adapter ping or meta-tool invocation).
   */
  recordExplicitAck(
    verificationId: string,
    observedVia: "meta_tool" | "explicit_ack" = "explicit_ack",
  ): RefreshVerification | undefined {
    const entry = this.pendingVerifications.get(verificationId);
    if (!entry) return undefined;

    clearTimeout(entry.timer);
    this.pendingVerifications.delete(verificationId);
    const connSet = this.pendingByConnection.get(entry.verification.connectionId);
    if (connSet) {
      connSet.delete(verificationId);
      if (connSet.size === 0) {
        this.pendingByConnection.delete(entry.verification.connectionId);
      }
    }

    const observed: RefreshVerification = {
      ...entry.verification,
      status: "observed",
      verifiedAt: new Date().toISOString(),
      observedVia,
    };

    this.addToHistory(observed);
    this.notifyListeners(observed);
    return observed;
  }

  /**
   * Returns all currently pending verifications.
   */
  getPendingVerifications(): RefreshVerification[] {
    return Array.from(this.pendingVerifications.values()).map((e) => e.verification);
  }

  /**
   * Returns verification records filtered by status or connection.
   */
  getVerifications(filter?: {
    connectionId?: string;
    workspaceId?: string;
    status?: RefreshVerificationStatus;
  }): RefreshVerification[] {
    let result = this.history;
    if (filter?.connectionId) {
      result = result.filter((v) => v.connectionId === filter.connectionId);
    }
    if (filter?.workspaceId) {
      result = result.filter((v) => v.workspaceId === filter.workspaceId);
    }
    if (filter?.status) {
      result = result.filter((v) => v.status === filter.status);
    }
    return result;
  }

  /**
   * Appends or updates a verification in the history buffer.
   */
  private addToHistory(verification: RefreshVerification): void {
    const idx = this.history.findIndex((v) => v.verificationId === verification.verificationId);
    if (idx >= 0) {
      this.history[idx] = verification;
    } else {
      this.history.push(verification);
      if (this.history.length > this.maxHistorySize) {
        this.history.shift();
      }
    }
  }

  /**
   * Subscribes to verification state transitions.
   */
  onVerificationChanged(listener: (verification: RefreshVerification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(verification: RefreshVerification): void {
    for (const listener of this.listeners) {
      try {
        listener(verification);
      } catch {
        // Suppress listener errors
      }
    }
  }

  /**
   * Destroys the verifier, canceling all active timers.
   */
  destroy(): void {
    for (const entry of this.pendingVerifications.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingVerifications.clear();
    this.pendingByConnection.clear();
    this.listeners.clear();
  }
}
