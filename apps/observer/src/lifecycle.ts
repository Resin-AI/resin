import type { DaemonConfig } from "./config.js";
import type { DaemonPaths } from "./paths.js";

export type ModuleLifecycleState =
  | "uninitialized"
  | "starting"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export type ModuleHealthStatus = "ready" | "degraded" | "failed" | "offline";

export interface ModuleHealth {
  status: ModuleHealthStatus;
  message?: string;
  details?: Record<string, unknown>;
  lastCheckTime?: number;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ModuleContext {
  readonly config: DaemonConfig;
  readonly paths: DaemonPaths;
  readonly signal?: AbortSignal;
  readonly logger: Logger;
  getModule<T extends DaemonModule>(id: string): T | undefined;
}

export interface RestartBudget {
  maxRestarts: number;
  windowMs: number;
}

export interface DaemonModule {
  readonly id: string;
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly restartBudget?: RestartBudget;
  readonly critical?: boolean;

  getState(): ModuleLifecycleState;
  start(context: ModuleContext): Promise<void>;
  stop(context: ModuleContext): Promise<void>;
  healthCheck?(): Promise<ModuleHealth>;
  reloadConfig?(newConfig: DaemonConfig): Promise<void>;
  getDiagnostics?(): Promise<Record<string, unknown>>;
}

const VALID_TRANSITIONS: Record<ModuleLifecycleState, readonly ModuleLifecycleState[]> = {
  uninitialized: ["starting"],
  starting: ["ready", "degraded", "failed", "stopping"],
  ready: ["degraded", "stopping", "failed"],
  degraded: ["ready", "stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: ["starting"],
  failed: ["starting", "stopped"],
};

/**
 * Validates whether a lifecycle state transition is allowed.
 */
export function isValidStateTransition(
  from: ModuleLifecycleState,
  to: ModuleLifecycleState,
): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Computes topological startup order for registered daemon modules.
 * Detects missing dependencies and cyclic dependencies.
 */
export function computeStartupOrder(modules: readonly DaemonModule[]): string[] {
  const moduleMap = new Map<string, DaemonModule>();
  for (const mod of modules) {
    if (moduleMap.has(mod.id)) {
      throw new Error(`Duplicate module registered with ID '${mod.id}'`);
    }
    moduleMap.set(mod.id, mod);
  }

  // Validate all declared dependencies exist
  for (const mod of modules) {
    if (mod.dependencies) {
      for (const depId of mod.dependencies) {
        if (!moduleMap.has(depId)) {
          throw new Error(`Module '${mod.id}' depends on missing module '${depId}'`);
        }
      }
    }
  }

  // Build in-degree map and adjacency list (dep -> dependents)
  const inDegree = new Map<string, number>();
  const dependentsMap = new Map<string, string[]>();

  for (const mod of modules) {
    inDegree.set(mod.id, 0);
    dependentsMap.set(mod.id, []);
  }

  for (const mod of modules) {
    const deps = mod.dependencies ?? [];
    inDegree.set(mod.id, deps.length);
    for (const depId of deps) {
      const currentDependents = dependentsMap.get(depId);
      if (currentDependents) {
        currentDependents.push(mod.id);
      }
    }
  }

  // Queue of modules with 0 remaining dependencies
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    order.push(current);

    const dependents = dependentsMap.get(current) ?? [];
    for (const dep of dependents) {
      const currentDeg = inDegree.get(dep) ?? 0;
      const newDeg = currentDeg - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) {
        queue.push(dep);
      }
    }
  }

  if (order.length !== modules.length) {
    const remaining = modules.filter((m) => !order.includes(m.id)).map((m) => m.id);
    throw new Error(`Cyclic dependency detected among modules: ${remaining.join(", ")}`);
  }

  return order;
}

/**
 * Computes reverse topological shutdown order (dependents stop before their dependencies).
 */
export function computeShutdownOrder(modules: readonly DaemonModule[]): string[] {
  const startupOrder = computeStartupOrder(modules);
  return [...startupOrder].reverse();
}

/**
 * Tracks restarts of modules within a sliding time window.
 */
export class RestartBudgetTracker {
  private restartTimestamps = new Map<string, number[]>();

  canRestart(
    moduleId: string,
    budget: RestartBudget = { maxRestarts: 3, windowMs: 60000 },
  ): boolean {
    const now = Date.now();
    const timestamps = this.restartTimestamps.get(moduleId) ?? [];
    const recent = timestamps.filter((t) => now - t <= budget.windowMs);
    this.restartTimestamps.set(moduleId, recent);
    return recent.length < budget.maxRestarts;
  }

  recordRestart(moduleId: string): void {
    const now = Date.now();
    const timestamps = this.restartTimestamps.get(moduleId) ?? [];
    timestamps.push(now);
    this.restartTimestamps.set(moduleId, timestamps);
  }

  getRemainingRestarts(
    moduleId: string,
    budget: RestartBudget = { maxRestarts: 3, windowMs: 60000 },
  ): number {
    const now = Date.now();
    const timestamps = this.restartTimestamps.get(moduleId) ?? [];
    const recent = timestamps.filter((t) => now - t <= budget.windowMs);
    return Math.max(0, budget.maxRestarts - recent.length);
  }

  reset(moduleId: string): void {
    this.restartTimestamps.delete(moduleId);
  }
}

/**
 * Executes a promise with an enforced timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation '${operationName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
