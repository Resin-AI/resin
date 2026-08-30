import { randomUUID } from "node:crypto";
import type { CanonicalJsonRecord, CanonicalJsonValue } from "@resin/contracts";
import type {
  BrokerExecutionResult,
  BrokerRequestPayload,
  BrokerRequestPayloadValue,
} from "../brokers/manager.js";
import { withResolvers } from "../worker/protocol.js";
import { BindingResolver } from "./binding-resolver.js";
import { CompensationManager } from "./compensation-manager.js";
import type {
  WorkflowCompensationResult,
  WorkflowDefinition,
  WorkflowExecutionOptions,
  WorkflowExecutionResult,
  WorkflowProgressEvent,
  WorkflowStep,
  WorkflowStepResult,
} from "./types.js";
function isRecordResult(val: BrokerExecutionResult): val is Extract<BrokerExecutionResult, object> {
  return val !== null && !Array.isArray(val) && Object(val) === val;
}

function toBrokerPayload(record: CanonicalJsonRecord): BrokerRequestPayload {
  const payload: BrokerRequestPayload = {};
  for (const [key, value] of Object.entries(record)) {
    payload[key] = toBrokerPayloadValue(value);
  }
  return payload;
}

function toBrokerPayloadValue(value: CanonicalJsonValue): BrokerRequestPayloadValue | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    const arr: BrokerRequestPayloadValue[] = [];
    for (const item of value) {
      const converted = toBrokerPayloadValue(item);
      if (converted !== undefined) {
        arr.push(converted);
      }
    }
    return arr;
  }
  if (Object.prototype.toString.call(value) === "[object Object]") {
    // SAFETY: Tag check confirms value is a record object.
    return toBrokerPayload(value as CanonicalJsonRecord);
  }
  // SAFETY: Primitive string, number, or boolean value is a valid BrokerRequestPayloadValue.
  return value as BrokerRequestPayloadValue;
}
/**
 * Robust workflow execution engine executing step graphs with real brokers,
 * bounded concurrency, cancellation, progress events, and safe compensation rollback.
 */
export class WorkflowExecutor {
  private readonly bindingResolver: BindingResolver;

  constructor(bindingResolver: BindingResolver = new BindingResolver()) {
    this.bindingResolver = bindingResolver;
  }

  /**
   * Executes a workflow definition against the provided options and broker context.
   */
  async execute(
    definition: WorkflowDefinition,
    options: WorkflowExecutionOptions = {},
  ): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const workflowId = definition.id || options.sessionId || `wf_${randomUUID().slice(0, 8)}`;
    const maxConcurrency = Math.max(1, options.maxConcurrency ?? definition.maxConcurrency ?? 4);
    const inputs = options.inputs ?? {};

    const stepResults: Record<string, WorkflowStepResult> = {};
    const rawStepOutputs: CanonicalJsonRecord = {};
    const compensationManager = new CompensationManager(this.bindingResolver);
    const auditEvents: CanonicalJsonRecord[] = [];

    const emitProgress = async (
      type: WorkflowProgressEvent["type"],
      progress: number,
      message: string,
      stepId?: string,
      action?: string,
      metadata?: CanonicalJsonRecord,
    ) => {
      const event: WorkflowProgressEvent = {
        type,
        workflowId,
        stepId,
        action,
        progress,
        message,
        timestamp: new Date().toISOString(),
        metadata,
      };
      if (options.onProgress) {
        await options.onProgress(event);
      }
    };

    const logAudit = (
      status: "allowed" | "denied" | "error" | "success",
      action: string,
      service: string,
      details: CanonicalJsonRecord,
    ) => {
      const auditEvent = {
        auditId: `aud_${randomUUID()}`,
        workflowId,
        service,
        action,
        status,
        timestamp: new Date().toISOString(),
        details,
      };
      auditEvents.push(auditEvent);
      if (options.onAudit) {
        options.onAudit(auditEvent);
      }
    };

    await emitProgress(
      "workflow_start",
      0,
      `Starting execution of workflow "${definition.name}" (${definition.steps.length} steps).`,
    );

    // Build step index and dependency tracking
    const stepMap = new Map<string, WorkflowStep>();
    const completedStepIds = new Set<string>();
    const inFlightStepIds = new Set<string>();
    const failedStepIds = new Set<string>();

    for (const step of definition.steps) {
      stepMap.set(step.id, step);
    }

    let workflowFailed = false;
    let workflowCancelled = false;
    let failureError: string | undefined;

    // Check cancellation
    if (options.signal?.aborted) {
      workflowCancelled = true;
      failureError = "Workflow execution cancelled before start.";
    }

    // Main execution loop: execute steps respecting DAG dependencies and bounded concurrency
    while (
      !workflowFailed &&
      !workflowCancelled &&
      completedStepIds.size + failedStepIds.size < definition.steps.length
    ) {
      if (options.signal?.aborted) {
        workflowCancelled = true;
        failureError = "Workflow execution was cancelled.";
        break;
      }

      // Find all ready steps whose dependencies are completed and not yet started
      const readySteps: WorkflowStep[] = [];
      for (const step of definition.steps) {
        if (
          !completedStepIds.has(step.id) &&
          !inFlightStepIds.has(step.id) &&
          !failedStepIds.has(step.id)
        ) {
          const allDepsSatisfied = step.dependsOn.every((depId) => completedStepIds.has(depId));
          if (allDepsSatisfied) {
            readySteps.push(step);
          }
        }
      }

      // If no steps are ready and none in-flight, but some remaining -> deadlock / unresolvable dependency
      if (readySteps.length === 0 && inFlightStepIds.size === 0) {
        workflowFailed = true;
        failureError = "Workflow stalled: unresolvable dependencies or circular wait.";
        break;
      }

      // If no new steps are ready right now, wait briefly for in-flight steps
      if (readySteps.length === 0) {
        const { promise, resolve } = withResolvers<void>();
        setTimeout(resolve, 20);
        await promise;
        continue;
      }

      // Select up to maxConcurrency steps to run in parallel
      const availableSlots = maxConcurrency - inFlightStepIds.size;
      const batchToRun = readySteps.slice(0, Math.max(1, availableSlots));

      const stepPromises = batchToRun.map(async (step) => {
        inFlightStepIds.add(step.id);
        const stepStartTime = Date.now();

        await emitProgress(
          "step_start",
          completedStepIds.size / definition.steps.length,
          `Starting step "${step.id}" (${step.action})...`,
          step.id,
          step.action,
        );

        // Check step condition
        if (step.condition) {
          try {
            const conditionVal = this.bindingResolver.resolveValue(
              step.condition,
              { workflowInputs: inputs, stepResults: rawStepOutputs },
              `step "${step.id}".condition`,
            );
            if (conditionVal === false || conditionVal === "false") {
              stepResults[step.id] = {
                stepId: step.id,
                status: "skipped",
                attempts: 0,
                durationMs: Date.now() - stepStartTime,
                startedAt: new Date(stepStartTime).toISOString(),
                completedAt: new Date().toISOString(),
              };
              completedStepIds.add(step.id);
              inFlightStepIds.delete(step.id);
              return;
            }
          } catch (condErr) {
            // Ignore condition evaluation error and proceed
          }
        }

        // Resolve dynamic step inputs
        let resolvedInputs: CanonicalJsonRecord = {};
        try {
          resolvedInputs = this.bindingResolver.resolveInputs(step.inputs, {
            workflowInputs: inputs,
            stepResults: rawStepOutputs,
          });
        } catch (resErr) {
          const errMessage = resErr instanceof Error ? resErr.message : String(resErr);
          stepResults[step.id] = {
            stepId: step.id,
            status: "failed",
            error: `Failed to resolve step inputs: ${errMessage}`,
            attempts: 1,
            durationMs: Date.now() - stepStartTime,
            startedAt: new Date(stepStartTime).toISOString(),
            completedAt: new Date().toISOString(),
          };
          failedStepIds.add(step.id);
          inFlightStepIds.delete(step.id);

          if (step.failureBehavior !== "continue" && step.onFailure !== "continue") {
            workflowFailed = true;
            failureError = `Step "${step.id}" failed input resolution: ${errMessage}`;
          }
          return;
        }

        // Execute step with retry loop
        const maxRetries = step.retryPolicy?.maxRetries ?? 0;
        const backoffMs = step.retryPolicy?.backoffMs ?? 1000;
        let attempts = 0;
        let stepSucceeded = false;
        let lastError: string | undefined;
        let stepOutput: CanonicalJsonValue = null;

        while (attempts <= maxRetries && !stepSucceeded && !options.signal?.aborted) {
          attempts++;
          try {
            stepOutput = await this.executeStepAction(step, resolvedInputs, options);
            stepSucceeded = true;
            logAudit("success", step.action, step.service ?? "fs", { stepId: step.id, attempts });
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            logAudit("error", step.action, step.service ?? "fs", {
              stepId: step.id,
              attempts,
              error: lastError,
            });

            if (attempts <= maxRetries && !options.signal?.aborted) {
              await emitProgress(
                "step_retry",
                completedStepIds.size / definition.steps.length,
                `Step "${step.id}" attempt ${attempts} failed (${lastError}). Retrying in ${backoffMs}ms...`,
                step.id,
                step.action,
              );
              const { promise: delayPromise, resolve: delayResolve } = withResolvers<void>();
              setTimeout(delayResolve, backoffMs);
              await delayPromise;
            }
          }
        }

        inFlightStepIds.delete(step.id);

        if (stepSucceeded) {
          rawStepOutputs[step.id] = stepOutput;
          if (step.outputVar) {
            rawStepOutputs[step.outputVar] = stepOutput;
          }

          stepResults[step.id] = {
            stepId: step.id,
            status: "completed",
            output: stepOutput,
            attempts,
            durationMs: Date.now() - stepStartTime,
            startedAt: new Date(stepStartTime).toISOString(),
            completedAt: new Date().toISOString(),
          };
          completedStepIds.add(step.id);

          // Register compensation for successfully completed step
          compensationManager.registerStep(step, stepOutput);

          await emitProgress(
            "step_complete",
            completedStepIds.size / definition.steps.length,
            `Step "${step.id}" completed successfully.`,
            step.id,
            step.action,
          );
        } else {
          const failureReason = options.signal?.aborted
            ? "Step cancelled by abort signal"
            : (lastError ?? "Step execution failed");

          stepResults[step.id] = {
            stepId: step.id,
            status: options.signal?.aborted ? "cancelled" : "failed",
            error: failureReason,
            attempts,
            durationMs: Date.now() - stepStartTime,
            startedAt: new Date(stepStartTime).toISOString(),
            completedAt: new Date().toISOString(),
          };
          failedStepIds.add(step.id);

          await emitProgress(
            "step_fail",
            completedStepIds.size / definition.steps.length,
            `Step "${step.id}" failed: ${failureReason}`,
            step.id,
            step.action,
          );

          if (step.failureBehavior !== "continue" && step.onFailure !== "continue") {
            if (options.signal?.aborted) {
              workflowCancelled = true;
              failureError = "Workflow execution was cancelled.";
            } else {
              workflowFailed = true;
              failureError = `Step "${step.id}" (${step.name}) failed: ${failureReason}`;
            }
          }
        }
      });

      await Promise.all(stepPromises);
    }

    // Execute compensation rollback if workflow failed or was cancelled
    let compensationResults: WorkflowCompensationResult[] = [];
    const shouldRollback =
      (workflowFailed || workflowCancelled) &&
      options.autoRollbackOnFailure !== false &&
      definition.compensationPolicy?.autoRollback !== false &&
      compensationManager.hasPendingCompensation();

    if (shouldRollback) {
      await emitProgress(
        "compensation_start",
        1.0,
        `Unwinding compensation stack (${compensationManager.count} actions)...`,
      );

      compensationResults = await compensationManager.executeCompensation(options, {
        workflowInputs: inputs,
        stepResults: rawStepOutputs,
      });

      // Mark compensated steps in stepResults
      for (const compRes of compensationResults) {
        if (compRes.status === "compensated" && stepResults[compRes.stepId]) {
          stepResults[compRes.stepId].status = "compensated";
        }
      }

      await emitProgress(
        "compensation_complete",
        1.0,
        `Completed compensation rollback with ${compensationResults.length} actions executed.`,
      );
    }

    const durationMs = Date.now() - startTime;
    const finalStatus: WorkflowExecutionResult["status"] = workflowCancelled
      ? "cancelled"
      : workflowFailed
        ? "failed"
        : "completed";

    if (finalStatus === "completed") {
      await emitProgress(
        "workflow_complete",
        1.0,
        `Workflow completed successfully in ${durationMs}ms.`,
      );
    } else if (finalStatus === "cancelled") {
      await emitProgress("workflow_cancelled", 1.0, `Workflow cancelled after ${durationMs}ms.`);
    } else {
      await emitProgress(
        "workflow_fail",
        1.0,
        `Workflow failed after ${durationMs}ms: ${failureError}`,
      );
    }

    return {
      workflowId,
      status: finalStatus,
      outputs: rawStepOutputs,
      stepResults,
      compensationResults,
      durationMs,
      error: failureError,
      auditEvents,
    };
  }

  /**
   * Executes a single step action through brokerHandler, brokerManager, or simulated handler.
   */
  private async executeStepAction(
    step: WorkflowStep,
    inputs: CanonicalJsonRecord,
    options: WorkflowExecutionOptions,
  ): Promise<CanonicalJsonValue> {
    if (options.dryRun) {
      return { dryRun: true, action: step.action, inputs };
    }

    if (step.service === "compute") {
      return this.executeSimulatedAction(step.action, inputs);
    }
    const service = step.service ?? this.inferService(step.action);
    const actionName = step.action.includes(".")
      ? step.action.split(".").slice(1).join(".")
      : step.action;

    if (options.brokerHandler) {
      return await options.brokerHandler(service, step.action, inputs);
    }

    if (options.brokerManager) {
      const brokerRes = await options.brokerManager.handleRequest(
        service,
        actionName,
        toBrokerPayload(inputs),
        {
          invocationId: options.grant?.invocationId ?? options.sessionId ?? `wf_step_${step.id}`,
          workspaceRoot: options.workspaceRoot ?? process.cwd(),
          source: "worker",
        },
      );
      if (brokerRes === null || brokerRes === undefined) {
        return null;
      }
      if (Array.isArray(brokerRes)) {
        // SAFETY: Array result is a valid CanonicalJsonValue.
        return brokerRes as CanonicalJsonValue;
      }
      if (isRecordResult(brokerRes)) {
        if ("content" in brokerRes && Buffer.isBuffer(brokerRes.content)) {
          return {
            ...brokerRes,
            content: brokerRes.content.toString("utf-8"),
          };
        }
        // SAFETY: Tag check confirms brokerRes is a record object.
        return brokerRes as CanonicalJsonRecord;
      }
      // SAFETY: Primitive boolean or number is a valid CanonicalJsonValue.
      return brokerRes as CanonicalJsonValue;
    }

    // Direct simulated execution for unit test and mock environments
    return this.executeSimulatedAction(step.action, inputs);
  }

  private async executeSimulatedAction(
    action: string,
    inputs: CanonicalJsonRecord,
  ): Promise<CanonicalJsonValue> {
    if (action.includes("writeFile")) {
      const isStringContent = Object.prototype.toString.call(inputs.content) === "[object String]";
      // SAFETY: Tag check confirms inputs.content is a string primitive.
      const content = isStringContent ? (inputs.content as string) : undefined;
      return {
        path: inputs.path,
        writtenBytes: content ? content.length : 128,
      };
    }
    if (action.includes("createDirectory") || action.includes("mkdir")) {
      return { path: inputs.path, created: true };
    }
    if (action.includes("remove") || action.includes("delete")) {
      return { path: inputs.path, removed: true };
    }
    if (action.includes("copy") || action.includes("move")) {
      return {
        source: inputs.source ?? inputs.from,
        destination: inputs.destination ?? inputs.to,
        success: true,
      };
    }
    if (action.includes("exec")) {
      return { stdout: "Command executed successfully", stderr: "", exitCode: 0 };
    }
    if (action.includes("fetch") || action.includes("request")) {
      return { status: 200, data: { ok: true, url: inputs.url } };
    }
    return { action, executed: true, inputs };
  }

  private inferService(action: string): "fs" | "net" | "cmd" | "secret" {
    if (
      action.startsWith("fs.") ||
      action.includes("readFile") ||
      action.includes("writeFile") ||
      action.includes("mkdir") ||
      action.includes("remove")
    ) {
      return "fs";
    }
    if (action.startsWith("net.") || action.includes("fetch")) return "net";
    if (action.startsWith("cmd.") || action.includes("exec")) return "cmd";
    if (action.startsWith("secret.")) return "secret";
    return "fs";
  }
}
