import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";

describe("CloudCircuitBreaker & Connection Health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes in CLOSED state with online health", () => {
    const cb = new CloudCircuitBreaker({ failureThreshold: 3 });
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canExecute()).toBe(true);

    const health = cb.getHealth();
    expect(health.status).toBe("online");
    expect(health.circuitState).toBe("CLOSED");
    expect(health.failureCount).toBe(0);
  });

  it("transitions to degraded health on intermittent failures below threshold", () => {
    const cb = new CloudCircuitBreaker({ failureThreshold: 3 });

    cb.recordFailure(new Error("Transient network error 1"));
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canExecute()).toBe(true);
    expect(cb.getHealth().status).toBe("degraded");
    expect(cb.getHealth().failureCount).toBe(1);

    cb.recordFailure(new Error("Transient network error 2"));
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getHealth().status).toBe("degraded");
    expect(cb.getHealth().failureCount).toBe(2);

    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getHealth().status).toBe("online");
    expect(cb.getHealth().failureCount).toBe(0);
  });

  it("trips to OPEN state and offline health when failure threshold is reached", () => {
    const cb = new CloudCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

    cb.recordFailure(new Error("Fail 1"));
    cb.recordFailure(new Error("Fail 2"));
    cb.recordFailure(new Error("Fail 3"));

    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
    expect(cb.getHealth().status).toBe("offline");
    expect(cb.getHealth().circuitState).toBe("OPEN");
  });

  it("immediately trips to unauthorized health on 401 / auth errors", () => {
    const cb = new CloudCircuitBreaker({ failureThreshold: 5 });

    cb.recordFailure({ code: "unauthorized", message: "Device token expired or revoked" });
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
    expect(cb.getHealth().status).toBe("unauthorized");
  });

  it("immediately trips to upgrade_required health on 426 / version mismatch errors", () => {
    const cb = new CloudCircuitBreaker({ failureThreshold: 5 });

    cb.recordFailure({ code: "upgrade_required", message: "Protocol version 2.0.0 required" });
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
    expect(cb.getHealth().status).toBe("upgrade_required");
  });

  it("transitions to HALF_OPEN after cooldown and recovers to CLOSED on consecutive successes", () => {
    const cb = new CloudCircuitBreaker({
      failureThreshold: 2,
      successThreshold: 2,
      resetTimeoutMs: 1000,
      backoffFactor: 2,
    });

    cb.recordFailure(new Error("Error 1"));
    cb.recordFailure(new Error("Error 2"));
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);

    // Advance fake timer past cooldown
    vi.advanceTimersByTime(1100);

    // After cooldown, canExecute returns true and moves to HALF_OPEN
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe("HALF_OPEN");

    // First trial success
    cb.recordSuccess();
    expect(cb.getState()).toBe("HALF_OPEN");
    expect(cb.getHealth().status).toBe("degraded");

    // Second trial success (reaches successThreshold: 2)
    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getHealth().status).toBe("online");
    expect(cb.canExecute()).toBe(true);
  });

  it("trips immediately back to OPEN if a trial fails during HALF_OPEN", () => {
    const cb = new CloudCircuitBreaker({
      failureThreshold: 2,
      successThreshold: 2,
      resetTimeoutMs: 1000,
      backoffFactor: 2,
    });

    cb.recordFailure(new Error("Error 1"));
    cb.recordFailure(new Error("Error 2"));
    expect(cb.getState()).toBe("OPEN");

    vi.advanceTimersByTime(1100);
    expect(cb.getState()).toBe("HALF_OPEN");

    // Trial failure trips immediately back to OPEN with increased backoff
    cb.recordFailure(new Error("Trial failed"));
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
  });

  it("emits events on state and health transitions", () => {
    const cb = new CloudCircuitBreaker({ failureThreshold: 1 });
    const states: string[] = [];
    const healths: string[] = [];

    const unsubState = cb.onStateChange((state) => states.push(state));
    const unsubHealth = cb.onHealthChange((report) => healths.push(report.status));

    cb.recordFailure(new Error("Boom"));
    expect(states).toContain("OPEN");
    expect(healths).toContain("offline");

    cb.reset();
    expect(states).toContain("CLOSED");
    expect(healths).toContain("online");

    unsubState();
    unsubHealth();
  });
});
