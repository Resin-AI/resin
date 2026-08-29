import crypto from "node:crypto";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { defaultFsBridge } from "@resin/harness-contracts";

/**
 * Standard steps executed during a Resin installation transaction.
 */
export type InstallationStepName =
  | "preflight"
  | "platform"
  | "assets"
  | "directories"
  | "authorization"
  | "pairing"
  | "harness_discovery"
  | "config_planning"
  | "apply"
  | "verify"
  | "complete";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "rolled_back" | "skipped";

export type TransactionStatus = "in_progress" | "completed" | "failed" | "rolled_back";

export interface RollbackAction {
  readonly description: string;
  readonly stepName: InstallationStepName;
  readonly execute: (fsBridge: ConfigFsBridge) => Promise<void> | void;
}

export interface JournalStepRecord {
  readonly name: InstallationStepName;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface JournalData {
  readonly journalId: string;
  readonly createdAt: string;
  completedAt?: string;
  status: TransactionStatus;
  readonly steps: JournalStepRecord[];
  rollbackErrors?: string[];
  metadata?: Record<string, unknown>;
}

export interface RollbackResult {
  readonly success: boolean;
  readonly executedActionsCount: number;
  readonly errors: Array<{ description: string; error: string }>;
}

/**
 * Transaction journal that tracks the lifecycle of installation steps and coordinates
 * atomic rollback across filesystem, process, and harness mutations upon failure.
 */
export class InstallationJournal {
  readonly journalId: string;
  readonly createdAt: string;
  completedAt?: string;
  status: TransactionStatus = "in_progress";
  readonly steps: JournalStepRecord[];
  private readonly rollbackActions: RollbackAction[] = [];
  private readonly rollbackErrors: string[] = [];
  metadata: Record<string, unknown> = {};

  constructor(initialData?: Partial<JournalData>) {
    this.journalId = initialData?.journalId ?? crypto.randomUUID();
    this.createdAt = initialData?.createdAt ?? new Date().toISOString();
    this.completedAt = initialData?.completedAt;
    this.status = initialData?.status ?? "in_progress";
    this.metadata = { ...(initialData?.metadata ?? {}) };

    const predefinedSteps: InstallationStepName[] = [
      "preflight",
      "platform",
      "assets",
      "directories",
      "authorization",
      "pairing",
      "harness_discovery",
      "config_planning",
      "apply",
      "verify",
      "complete",
    ];

    if (initialData?.steps && initialData.steps.length > 0) {
      this.steps = initialData.steps.map((s) => ({ ...s }));
    } else {
      this.steps = predefinedSteps.map((name) => ({
        name,
        status: "pending",
      }));
    }
  }

  /**
   * Retrieves a step record by name.
   */
  getStep(stepName: InstallationStepName): JournalStepRecord {
    let step = this.steps.find((s) => s.name === stepName);
    if (!step) {
      step = { name: stepName, status: "pending" };
      this.steps.push(step);
    }
    return step;
  }

  /**
   * Marks a step as running.
   */
  startStep(stepName: InstallationStepName, details?: Record<string, unknown>): void {
    const step = this.getStep(stepName);
    step.status = "running";
    step.startedAt = new Date().toISOString();
    if (details) {
      step.details = { ...(step.details ?? {}), ...details };
    }
  }

  /**
   * Marks a step as completed successfully.
   */
  completeStep(stepName: InstallationStepName, details?: Record<string, unknown>): void {
    const step = this.getStep(stepName);
    step.status = "completed";
    step.completedAt = new Date().toISOString();
    if (details) {
      step.details = { ...(step.details ?? {}), ...details };
    }
  }

  /**
   * Marks a step as skipped (e.g. during dry-run or when optional).
   */
  skipStep(stepName: InstallationStepName, details?: Record<string, unknown>): void {
    const step = this.getStep(stepName);
    step.status = "skipped";
    step.completedAt = new Date().toISOString();
    if (details) {
      step.details = { ...(step.details ?? {}), ...details };
    }
  }

  /**
   * Marks a step as failed and marks transaction as failed.
   */
  failStep(
    stepName: InstallationStepName,
    error: Error | string,
    details?: Record<string, unknown>,
  ): void {
    const step = this.getStep(stepName);
    step.status = "failed";
    step.completedAt = new Date().toISOString();
    step.error = typeof error === "string" ? error : error.message;
    if (details) {
      step.details = { ...(step.details ?? {}), ...details };
    }
    this.status = "failed";
  }

  /**
   * Registers an atomic rollback action to be executed in reverse order on failure.
   */
  registerRollback(action: RollbackAction): void {
    this.rollbackActions.push(action);
  }

  /**
   * Helper to register a rollback action with step name and description.
   */
  addRollbackAction(
    stepName: InstallationStepName,
    description: string,
    execute: (fsBridge: ConfigFsBridge) => Promise<void> | void,
  ): void {
    this.rollbackActions.push({ stepName, description, execute });
  }

  /**
   * Completes the entire installation transaction.
   */
  finalize(status: "completed" | "failed" | "rolled_back" = "completed"): void {
    this.status = status;
    this.completedAt = new Date().toISOString();
  }

  /**
   * Executes all registered rollback actions in reverse order (LIFO).
   */
  async rollback(fsBridge: ConfigFsBridge = defaultFsBridge): Promise<RollbackResult> {
    const errors: Array<{ description: string; error: string }> = [];
    let executedCount = 0;

    // Execute in LIFO order
    while (this.rollbackActions.length > 0) {
      const action = this.rollbackActions.pop();
      if (!action) continue;

      try {
        await action.execute(fsBridge);
        executedCount++;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ description: action.description, error: errorMsg });
        this.rollbackErrors.push(`${action.description}: ${errorMsg}`);
      }
    }

    // Mark steps that had rollback actions as rolled_back
    for (const step of this.steps) {
      if (step.status === "completed" || step.status === "running") {
        step.status = "rolled_back";
      }
    }

    this.status = "rolled_back";
    this.completedAt = new Date().toISOString();

    return {
      success: errors.length === 0,
      executedActionsCount: executedCount,
      errors,
    };
  }

  /**
   * Serializes journal to a plain JSON object.
   */
  toJSON(): JournalData {
    return {
      journalId: this.journalId,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      status: this.status,
      steps: this.steps.map((s) => ({ ...s })),
      rollbackErrors: [...this.rollbackErrors],
      metadata: { ...this.metadata },
    };
  }

  /**
   * Saves the journal to a JSON file on disk.
   */
  async save(journalPath: string, fsBridge: ConfigFsBridge = defaultFsBridge): Promise<void> {
    const json = JSON.stringify(this.toJSON(), null, 2);
    await fsBridge.writeFile(journalPath, `${json}\n`);
  }

  /**
   * Loads an installation journal from disk.
   */
  static async load(
    journalPath: string,
    fsBridge: ConfigFsBridge = defaultFsBridge,
  ): Promise<InstallationJournal> {
    const content = await fsBridge.readFile(journalPath);
    if (!content) {
      throw new Error(`Installation journal not found at ${journalPath}`);
    }
    const data = JSON.parse(content) as JournalData;
    return new InstallationJournal(data);
  }
}
