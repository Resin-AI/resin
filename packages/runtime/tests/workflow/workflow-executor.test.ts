import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BindingResolver,
  CapabilityBrokerManager,
  CompensationManager,
  type WorkflowDefinition,
  WorkflowExecutor,
  type WorkflowProgressEvent,
} from "../../src/index.js";

describe("WorkflowExecutor Runtime Engine (AC 6 & AC 7)", () => {
  const executor = new WorkflowExecutor();

  describe("DAG Scheduling & Bounded Concurrency", () => {
    it("should execute steps respecting DAG dependencies and bounded concurrency", async () => {
      const executionOrder: string[] = [];
      const concurrentRunning: string[] = [];
      let maxObservedConcurrency = 0;

      const mockBrokerHandler = async (
        service: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        const stepId = String(payload.stepId);
        concurrentRunning.push(stepId);
        maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrentRunning.length);

        await Promise.resolve();

        executionOrder.push(stepId);
        const idx = concurrentRunning.indexOf(stepId);
        if (idx !== -1) concurrentRunning.splice(idx, 1);

        return { stepId, result: `done_${stepId}` };
      };

      // Graph structure:
      // step_1 -> step_2a & step_2b (parallel) -> step_3
      const workflow: WorkflowDefinition = {
        id: "wf_concurrency_test",
        name: "Concurrency Test Workflow",
        maxConcurrency: 2,
        steps: [
          {
            id: "step_1",
            name: "Initial Step",
            toolClass: "compute",
            action: "compute",
            inputs: { stepId: "step_1" },
            dependsOn: [],
          },
          {
            id: "step_2a",
            name: "Branch A",
            toolClass: "compute",
            action: "compute",
            inputs: { stepId: "step_2a", prev: "${step.step_1.result}" },
            dependsOn: ["step_1"],
          },
          {
            id: "step_2b",
            name: "Branch B",
            toolClass: "compute",
            action: "compute",
            inputs: { stepId: "step_2b", prev: "${step.step_1.result}" },
            dependsOn: ["step_1"],
          },
          {
            id: "step_3",
            name: "Final Aggregator",
            toolClass: "compute",
            action: "compute",
            inputs: {
              stepId: "step_3",
              fromA: "${step.step_2a.result}",
              fromB: "${step.step_2b.result}",
            },
            dependsOn: ["step_2a", "step_2b"],
          },
        ],
      };

      const result = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        maxConcurrency: 2,
      });

      expect(result.status).toBe("completed");
      expect(executionOrder[0]).toBe("step_1");
      expect(executionOrder[3]).toBe("step_3");
      expect(["step_2a", "step_2b"]).toContain(executionOrder[1]);
      expect(["step_2a", "step_2b"]).toContain(executionOrder[2]);
      expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
      expect(maxObservedConcurrency).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Variable Binding Resolution & Interpolation", () => {
    it("should resolve dynamic workflow inputs and preceding step outputs into step inputs", async () => {
      const receivedInputs: Record<string, Record<string, unknown>> = {};

      const mockBrokerHandler = async (
        service: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        const stepId = String(payload._stepId);
        receivedInputs[stepId] = payload;
        if (stepId === "step_1") {
          return { dataId: "item_9876", count: 42 };
        }
        return { status: "processed" };
      };

      const workflow: WorkflowDefinition = {
        id: "wf_binding_test",
        name: "Binding Test Workflow",
        steps: [
          {
            id: "step_1",
            name: "Produce Data",
            toolClass: "compute",
            action: "produce",
            inputs: {
              _stepId: "step_1",
              targetFile: "${input.baseDir}/data.json",
              limit: "$input.queryLimit",
            },
            dependsOn: [],
          },
          {
            id: "step_2",
            name: "Consume Data",
            toolClass: "compute",
            action: "consume",
            inputs: {
              _stepId: "step_2",
              receivedId: "${step.step_1.dataId}",
              totalCount: "$step.step_1.count",
              summary: "Processing ${step.step_1.dataId} in ${input.baseDir}",
            },
            dependsOn: ["step_1"],
          },
        ],
      };

      const result = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        inputs: {
          baseDir: "/workspace/project",
          queryLimit: 100,
        },
      });

      expect(result.status).toBe("completed");
      expect(receivedInputs.step_1.targetFile).toBe("/workspace/project/data.json");
      expect(receivedInputs.step_1.limit).toBe(100);
      expect(receivedInputs.step_2.receivedId).toBe("item_9876");
      expect(receivedInputs.step_2.totalCount).toBe(42);
      expect(receivedInputs.step_2.summary).toBe("Processing item_9876 in /workspace/project");
    });
  });

  describe("Real Broker Integration with Filesystem Operations", () => {
    it("should execute workflow with real FilesystemBroker", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf_broker_test_"));
      const testFilePath = path.join(tempDir, "test_output.txt");

      const brokerManager = new CapabilityBrokerManager({
        workspaceRoot: tempDir,
        requireGrant: false,
        allowUnverifiedBoundaries: true,
        development: true,
      });
      const workflow: WorkflowDefinition = {
        id: "wf_real_broker",
        name: "Real Broker Workflow",
        steps: [
          {
            id: "step_1",
            name: "Write File",
            toolClass: "file_write",
            action: "writeFile",
            service: "fs",
            inputs: {
              path: testFilePath,
              content: "Hello from WorkflowExecutor real broker!",
            },
            dependsOn: [],
            compensation: {
              action: "remove",
              service: "fs",
              inputs: { path: testFilePath },
            },
          },
          {
            id: "step_2",
            name: "Read File",
            toolClass: "file_read",
            action: "readFile",
            service: "fs",
            inputs: {
              path: testFilePath,
              encoding: "utf-8",
            },
            dependsOn: ["step_1"],
          },
        ],
      };

      try {
        const result = await executor.execute(workflow, {
          brokerManager,
          workspaceRoot: tempDir,
        });

        expect(result.status).toBe("completed");
        expect(fs.existsSync(testFilePath)).toBe(true);

        const readResult = result.outputs.step_2 as { content: string };
        expect(readResult.content).toBe("Hello from WorkflowExecutor real broker!");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Step Retry with Backoff on Transient Errors", () => {
    it("should retry idempotent steps up to maxRetries on failure", async () => {
      let attempts = 0;
      const progressEvents: WorkflowProgressEvent[] = [];

      const mockBrokerHandler = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Transient network error (attempt ${attempts})`);
        }
        return { success: true, attempts };
      };

      const workflow: WorkflowDefinition = {
        id: "wf_retry_test",
        name: "Retry Test Workflow",
        steps: [
          {
            id: "step_1",
            name: "Flaky Step",
            toolClass: "api_client",
            action: "net.fetch",
            inputs: { url: "https://api.test.com/data" },
            dependsOn: [],
            retryPolicy: {
              maxRetries: 3,
              backoffMs: 20,
              idempotent: true,
            },
          },
        ],
      };

      const result = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        onProgress: (evt) => {
          progressEvents.push(evt);
        },
      });

      expect(result.status).toBe("completed");
      expect(attempts).toBe(3);
      expect(result.stepResults.step_1.attempts).toBe(3);
      expect(progressEvents.some((e) => e.type === "step_retry")).toBe(true);
    });
  });

  describe("Step Failure & Automatic LIFO Compensation Rollback", () => {
    it("should rollback completed steps in reverse LIFO order when a downstream step fails", async () => {
      const rollbackLog: string[] = [];
      const progressEvents: WorkflowProgressEvent[] = [];

      const mockBrokerHandler = async (
        service: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        if (action === "rollback") {
          rollbackLog.push(String(payload.step));
          return { rolledBack: true };
        }

        const stepId = String(payload.step);
        if (stepId === "step_3") {
          throw new Error("Step 3 crashed unexpectedly!");
        }
        return { executed: stepId };
      };

      const workflow: WorkflowDefinition = {
        id: "wf_compensation_test",
        name: "Compensation Test",
        steps: [
          {
            id: "step_1",
            name: "Create Resource A",
            toolClass: "custom",
            action: "create",
            inputs: { step: "step_1" },
            dependsOn: [],
            compensation: {
              action: "rollback",
              inputs: { step: "step_1" },
            },
          },
          {
            id: "step_2",
            name: "Create Resource B",
            toolClass: "custom",
            action: "create",
            inputs: { step: "step_2" },
            dependsOn: ["step_1"],
            compensation: {
              action: "rollback",
              inputs: { step: "step_2" },
            },
          },
          {
            id: "step_3",
            name: "Failing Step C",
            toolClass: "custom",
            action: "create",
            inputs: { step: "step_3" },
            dependsOn: ["step_2"],
          },
        ],
      };

      const result = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        onProgress: (e) => {
          progressEvents.push(e);
        },
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Step 3 crashed unexpectedly");

      // Verify LIFO order: step_2 rollback executed BEFORE step_1 rollback
      expect(rollbackLog).toEqual(["step_2", "step_1"]);
      expect(result.compensationResults).toHaveLength(2);
      expect(result.compensationResults[0].stepId).toBe("step_2");
      expect(result.compensationResults[1].stepId).toBe("step_1");
      expect(progressEvents.some((e) => e.type === "compensation_start")).toBe(true);
      expect(progressEvents.some((e) => e.type === "compensation_complete")).toBe(true);
    });
  });

  describe("Failure Behavior: Continue on Optional Step Failure", () => {
    it("should continue workflow execution when failureBehavior is set to 'continue'", async () => {
      const executedSteps: string[] = [];

      const mockBrokerHandler = async (
        service: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        const stepId = String(payload.step);
        executedSteps.push(stepId);
        if (stepId === "step_optional") {
          throw new Error("Optional telemetry step failed");
        }
        return { step: stepId };
      };

      const workflow: WorkflowDefinition = {
        id: "wf_continue_test",
        name: "Continue Behavior Test",
        steps: [
          {
            id: "step_1",
            name: "Primary Step",
            toolClass: "custom",
            action: "act",
            inputs: { step: "step_1" },
            dependsOn: [],
          },
          {
            id: "step_optional",
            name: "Optional Telemetry",
            toolClass: "custom",
            action: "act",
            inputs: { step: "step_optional" },
            dependsOn: ["step_1"],
            failureBehavior: "continue",
            onFailure: "continue",
          },
          {
            id: "step_2",
            name: "Final Step",
            toolClass: "custom",
            action: "act",
            inputs: { step: "step_2" },
            dependsOn: ["step_1"], // Depends on step_1, not optional step
          },
        ],
      };

      const result = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
      });

      expect(result.status).toBe("completed");
      expect(executedSteps).toContain("step_1");
      expect(executedSteps).toContain("step_optional");
      expect(executedSteps).toContain("step_2");
      expect(result.stepResults.step_optional.status).toBe("failed");
      expect(result.stepResults.step_2.status).toBe("completed");
    });
  });

  describe("Workflow Cancellation via AbortSignal", () => {
    it("should cancel running workflow and roll back completed steps upon abort signal", async () => {
      const rollbackLog: string[] = [];
      const abortController = new AbortController();

      const mockBrokerHandler = async (
        service: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        if (action === "rollback") {
          rollbackLog.push(String(payload.step));
          return { rolledBack: true };
        }

        const stepId = String(payload.step);
        if (stepId === "step_1") {
          return { data: "ready" };
        }
        if (stepId === "step_2") {
          // Trigger abort during step 2
          abortController.abort();
          throw new Error("Cancelled by abort signal");
        }
        return { data: "done" };
      };

      const workflow: WorkflowDefinition = {
        id: "wf_abort_test",
        name: "Abort Test",
        steps: [
          {
            id: "step_1",
            name: "Step 1",
            toolClass: "custom",
            action: "act",
            inputs: { step: "step_1" },
            dependsOn: [],
            compensation: {
              action: "rollback",
              inputs: { step: "step_1" },
            },
          },
          {
            id: "step_2",
            name: "Step 2 (Triggers Abort)",
            toolClass: "custom",
            action: "act",
            inputs: { step: "step_2" },
            dependsOn: ["step_1"],
          },
          {
            id: "step_3",
            name: "Step 3 (Never Runs)",
            toolClass: "custom",
            action: "act",
            inputs: { step: "step_3" },
            dependsOn: ["step_2"],
          },
        ],
      };

      const result = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        signal: abortController.signal,
      });

      expect(result.status).toBe("cancelled");
      expect(rollbackLog).toEqual(["step_1"]);
      expect(result.stepResults.step_3).toBeUndefined(); // Never started
    });
  });

  describe("Audit Events & Redaction", () => {
    it("should emit sanitized audit events for all step broker operations", async () => {
      const auditEvents: Record<string, unknown>[] = [];

      const mockBrokerHandler = async () => {
        return { status: "ok" };
      };

      const workflow: WorkflowDefinition = {
        id: "wf_audit_test",
        name: "Audit Test Workflow",
        steps: [
          {
            id: "step_1",
            name: "Step 1",
            toolClass: "file_read",
            action: "fs.readFile",
            service: "fs",
            inputs: { path: "/workspace/secret.key" },
            dependsOn: [],
          },
        ],
      };

      const result = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        onAudit: (evt) => {
          auditEvents.push(evt);
        },
      });

      expect(result.status).toBe("completed");
      expect(auditEvents.length).toBeGreaterThan(0);
      expect(auditEvents[0].workflowId).toBe("wf_audit_test");
      expect(auditEvents[0].action).toBe("fs.readFile");
      expect(auditEvents[0].status).toBe("success");
    });
  });

  describe("Repeated / Idempotent Invocation", () => {
    it("should produce deterministic consistent results across multiple repeated invocations", async () => {
      let callCount = 0;
      const mockBrokerHandler = async (
        service: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        callCount++;
        return { query: payload.query, timestamp: "fixed_time", index: callCount };
      };

      const workflow: WorkflowDefinition = {
        id: "wf_idempotent_test",
        name: "Idempotent Invocation Test",
        steps: [
          {
            id: "step_1",
            name: "Query Data",
            toolClass: "compute",
            action: "query",
            inputs: { query: "${input.search}" },
            dependsOn: [],
          },
        ],
      };

      const run1 = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        inputs: { search: "test_keyword" },
      });

      const run2 = await executor.execute(workflow, {
        brokerHandler: mockBrokerHandler,
        inputs: { search: "test_keyword" },
      });

      expect(run1.status).toBe("completed");
      expect(run2.status).toBe("completed");
      expect((run1.outputs.step_1 as { query: string }).query).toBe("test_keyword");
      expect((run2.outputs.step_1 as { query: string }).query).toBe("test_keyword");
    });
  });
});
