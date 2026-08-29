import { BindingResolver } from "./binding-resolver.js";
import type {
  WorkflowCompensationResult,
  WorkflowExecutionOptions,
  WorkflowStep,
  WorkflowStepCompensation,
} from "./types.js";

interface RegisteredCompensation {
  stepId: string;
  stepName: string;
  compensation: WorkflowStepCompensation;
  stepOutput: unknown;
}

/**
 * Manages the LIFO compensation stack and executes deterministic safe rollbacks on step failures.
 */
export class CompensationManager {
  private readonly stack: RegisteredCompensation[] = [];
  private readonly bindingResolver: BindingResolver;

  constructor(bindingResolver: BindingResolver = new BindingResolver()) {
    this.bindingResolver = bindingResolver;
  }

  /**
   * Registers a successfully completed step onto the compensation stack if it declares a compensation action.
   */
  registerStep(step: WorkflowStep, stepOutput: unknown): void {
    if (step.compensation && step.compensation.action) {
      this.stack.push({
        stepId: step.id,
        stepName: step.name,
        compensation: step.compensation,
        stepOutput,
      });
    }
  }

  /**
   * Checks if there are pending compensation actions to execute.
   */
  hasPendingCompensation(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Returns current count of registered compensation actions.
   */
  get count(): number {
    return this.stack.length;
  }

  /**
   * Executes all registered compensation actions in reverse (LIFO) order.
   */
  async executeCompensation(
    options: WorkflowExecutionOptions,
    context: {
      workflowInputs: Record<string, unknown>;
      stepResults: Record<string, unknown>;
    },
  ): Promise<WorkflowCompensationResult[]> {
    const results: WorkflowCompensationResult[] = [];

    // Unwind stack in LIFO reverse order
    while (this.stack.length > 0) {
      const item = this.stack.pop();
      if (!item) break;

      const startTime = Date.now();
      const { stepId, compensation } = item;

      if (options.onProgress) {
        await options.onProgress({
          type: "compensation_step",
          workflowId: options.sessionId ?? "workflow",
          stepId,
          action: compensation.action,
          progress: 1.0,
          message: `Rolling back step "${stepId}" (${compensation.action})...`,
          timestamp: new Date().toISOString(),
        });
      }

      try {
        // Resolve dynamic compensation inputs
        const resolvedInputs = this.bindingResolver.resolveInputs(compensation.inputs ?? {}, {
          workflowInputs: context.workflowInputs,
          stepResults: context.stepResults,
        });

        // Execute compensation action via broker
        const rawService =
          compensation.service && compensation.service !== "compute"
            ? compensation.service
            : this.inferService(compensation.action);
        const service: "fs" | "net" | "cmd" | "secret" =
          (rawService as "fs" | "net" | "cmd" | "secret") || "fs";

        // Execute compensation action via broker
        const actionName = compensation.action.includes(".")
          ? compensation.action.split(".").slice(1).join(".")
          : compensation.action;

        if (options.brokerHandler) {
          await options.brokerHandler(service, compensation.action, resolvedInputs);
        } else if (options.brokerManager) {
          await options.brokerManager.handleRequest(service, actionName, resolvedInputs, {
            invocationId: options.grant?.invocationId ?? options.sessionId ?? `comp_${stepId}`,
            workspaceRoot: options.workspaceRoot ?? process.cwd(),
            source: "worker",
          });
        }

        results.push({
          stepId,
          action: compensation.action,
          status: "compensated",
          durationMs: Date.now() - startTime,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.push({
          stepId,
          action: compensation.action,
          status: "failed",
          error: errorMsg,
          durationMs: Date.now() - startTime,
        });

        if (options.onProgress) {
          await options.onProgress({
            type: "compensation_fail",
            workflowId: options.sessionId ?? "workflow",
            stepId,
            action: compensation.action,
            progress: 1.0,
            message: `Compensation rollback failed for step "${stepId}": ${errorMsg}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    return results;
  }

  /**
   * Clears the compensation stack.
   */
  clear(): void {
    this.stack.length = 0;
  }

  private inferService(action: string): "fs" | "net" | "cmd" | "secret" {
    if (
      action.startsWith("fs.") ||
      action.startsWith("writeFile") ||
      action.startsWith("remove") ||
      action.startsWith("delete")
    ) {
      return "fs";
    }
    if (action.startsWith("net.")) return "net";
    if (action.startsWith("cmd.") || action.startsWith("exec")) return "cmd";
    if (action.startsWith("secret.")) return "secret";
    return "fs";
  }
}
