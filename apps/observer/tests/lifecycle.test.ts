import { describe, expect, it } from "vitest";
import {
  type DaemonModule,
  type ModuleLifecycleState,
  RestartBudgetTracker,
  computeShutdownOrder,
  computeStartupOrder,
  isValidStateTransition,
  withTimeout,
} from "../src/lifecycle.js";

function createMockModule(id: string, dependencies: string[] = [], critical = false): DaemonModule {
  let state: ModuleLifecycleState = "uninitialized";
  return {
    id,
    name: `Module ${id}`,
    dependencies,
    critical,
    getState: () => state,
    start: async () => {
      state = "ready";
    },
    stop: async () => {
      state = "stopped";
    },
  };
}

describe("lifecycle", () => {
  describe("State Transitions", () => {
    it("validates allowed state transitions", () => {
      expect(isValidStateTransition("uninitialized", "starting")).toBe(true);
      expect(isValidStateTransition("starting", "ready")).toBe(true);
      expect(isValidStateTransition("starting", "degraded")).toBe(true);
      expect(isValidStateTransition("starting", "failed")).toBe(true);
      expect(isValidStateTransition("ready", "degraded")).toBe(true);
      expect(isValidStateTransition("ready", "stopping")).toBe(true);
      expect(isValidStateTransition("degraded", "ready")).toBe(true);
      expect(isValidStateTransition("degraded", "stopping")).toBe(true);
      expect(isValidStateTransition("stopping", "stopped")).toBe(true);
      expect(isValidStateTransition("stopped", "starting")).toBe(true);
      expect(isValidStateTransition("failed", "starting")).toBe(true);
    });

    it("rejects invalid state transitions", () => {
      expect(isValidStateTransition("uninitialized", "ready")).toBe(false);
      expect(isValidStateTransition("uninitialized", "stopped")).toBe(false);
      expect(isValidStateTransition("stopped", "ready")).toBe(false);
      expect(isValidStateTransition("ready", "uninitialized")).toBe(false);
    });
  });

  describe("DAG Dependency Ordering", () => {
    it("computes startup order for linear dependency chain", () => {
      const modA = createMockModule("A", []);
      const modB = createMockModule("B", ["A"]);
      const modC = createMockModule("C", ["B"]);

      const order = computeStartupOrder([modC, modA, modB]);
      expect(order).toEqual(["A", "B", "C"]);
    });

    it("computes startup order for diamond dependency graph", () => {
      const modA = createMockModule("A", []);
      const modB = createMockModule("B", ["A"]);
      const modC = createMockModule("C", ["A"]);
      const modD = createMockModule("D", ["B", "C"]);

      const order = computeStartupOrder([modD, modB, modC, modA]);

      expect(order.indexOf("A")).toBe(0);
      expect(order.indexOf("B")).toBeGreaterThan(order.indexOf("A"));
      expect(order.indexOf("C")).toBeGreaterThan(order.indexOf("A"));
      expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("B"));
      expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("C"));
    });

    it("throws when duplicate module IDs are registered", () => {
      const modA1 = createMockModule("A", []);
      const modA2 = createMockModule("A", []);
      expect(() => computeStartupOrder([modA1, modA2])).toThrow(/Duplicate module/);
    });

    it("throws when a declared dependency is missing", () => {
      const modA = createMockModule("A", ["non_existent"]);
      expect(() => computeStartupOrder([modA])).toThrow(/depends on missing module 'non_existent'/);
    });

    it("throws when cyclic dependency is detected", () => {
      const modA = createMockModule("A", ["B"]);
      const modB = createMockModule("B", ["C"]);
      const modC = createMockModule("C", ["A"]);

      expect(() => computeStartupOrder([modA, modB, modC])).toThrow(/Cyclic dependency detected/);
    });

    it("computes shutdown order in reverse topological order", () => {
      const modA = createMockModule("A", []);
      const modB = createMockModule("B", ["A"]);
      const modC = createMockModule("C", ["B"]);

      const shutdownOrder = computeShutdownOrder([modA, modB, modC]);
      expect(shutdownOrder).toEqual(["C", "B", "A"]);
    });
  });

  describe("RestartBudgetTracker", () => {
    it("enforces restart limit within time window", () => {
      const tracker = new RestartBudgetTracker();
      const budget = { maxRestarts: 2, windowMs: 10000 };

      expect(tracker.canRestart("mod1", budget)).toBe(true);
      expect(tracker.getRemainingRestarts("mod1", budget)).toBe(2);

      tracker.recordRestart("mod1");
      expect(tracker.canRestart("mod1", budget)).toBe(true);
      expect(tracker.getRemainingRestarts("mod1", budget)).toBe(1);

      tracker.recordRestart("mod1");
      expect(tracker.canRestart("mod1", budget)).toBe(false);
      expect(tracker.getRemainingRestarts("mod1", budget)).toBe(0);

      tracker.reset("mod1");
      expect(tracker.canRestart("mod1", budget)).toBe(true);
    });
  });

  describe("withTimeout", () => {
    it("resolves when promise settles before timeout", async () => {
      const promise = Promise.resolve("success");
      const result = await withTimeout(promise, 1000, "test-op");
      expect(result).toBe("success");
    });

    it("rejects when promise times out", async () => {
      const neverPromise = new Promise((resolve) => {
        // intentionally not resolving
      });

      await expect(withTimeout(neverPromise, 50, "slow-op")).rejects.toThrow(
        /Operation 'slow-op' timed out after 50ms/,
      );
    });
  });
});
