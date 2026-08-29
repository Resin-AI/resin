import type {
  CanonicalJsonRecord,
  CapabilityEnvelope,
  CapabilityManifest,
  ToolOutputSchema,
  ToolParameterSchema,
} from "@resin/contracts";
import type { CapabilityBrokerManager } from "../brokers/manager.js";
import type { InvocationGrant } from "../policy/grant.js";
import type { BrokerRequestHandlerFn, ToolContext } from "../worker/sdk.js";

/**
 * Compensation action attached to a workflow step for deterministic rollback on failure.
 */
export interface WorkflowStepCompensation {
  action: string;
  inputs: CanonicalJsonRecord;
  service?: "fs" | "net" | "cmd" | "secret" | "compute" | string;
  description?: string;
  deterministicInverse?: boolean;
}

/**
 * Step retry policy configuration.
 */
export interface WorkflowStepRetryPolicy {
  maxRetries: number;
  backoffMs?: number;
  idempotent?: boolean;
}

/**
 * Individual executable step in a workflow DAG.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  description?: string;
  toolClass: string;
  action: string;
  service?: "fs" | "net" | "cmd" | "secret" | "compute";
  inputs: CanonicalJsonRecord;
  outputs?: CanonicalJsonRecord | string[];
  outputVar?: string;
  dependsOn: string[];
  capabilities?: CapabilityManifest;
  capabilityRequirements?: CapabilityManifest;
  timeout?: number;
  timeoutMs?: number;
  compensation?: WorkflowStepCompensation;
  retryPolicy?: WorkflowStepRetryPolicy;
  failureBehavior?: "abort" | "continue" | "compensate" | "fail";
  onFailure?: "abort" | "continue" | "compensate" | "fail";
  condition?: string;
}

/**
 * Complete workflow specification.
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  version?: string;
  description?: string;
  steps: WorkflowStep[];
  inputSchema?: ToolParameterSchema | CanonicalJsonRecord;
  outputSchema?: ToolOutputSchema | CanonicalJsonRecord;
  capabilities?: CapabilityManifest;
  maxConcurrency?: number;
  timeoutMs?: number;
  compensationPolicy?: {
    enabled: boolean;
    autoRollback: boolean;
  };
  metadata?: CanonicalJsonRecord;
}

/**
 * Event emitted during workflow execution lifecycle.
 */
export interface WorkflowProgressEvent {
  type:
    | "workflow_start"
    | "step_start"
    | "step_progress"
    | "step_complete"
    | "step_retry"
    | "step_fail"
    | "compensation_start"
    | "compensation_step"
    | "compensation_complete"
    | "compensation_fail"
    | "workflow_complete"
    | "workflow_fail"
    | "workflow_cancelled";
  workflowId: string;
  stepId?: string;
  action?: string;
  progress: number; // 0.0 to 1.0
  message: string;
  timestamp: string;
  metadata?: CanonicalJsonRecord;
}

/**
 * Result of executing an individual workflow step.
 */
export interface WorkflowStepResult {
  stepId: string;
  status: "completed" | "failed" | "skipped" | "compensated" | "cancelled";
  output?: unknown;
  error?: string;
  attempts: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

/**
 * Result of executing a compensation rollback action.
 */
export interface WorkflowCompensationResult {
  stepId: string;
  action: string;
  status: "compensated" | "failed";
  error?: string;
  durationMs: number;
}

/**
 * Result of complete workflow execution.
 */
export interface WorkflowExecutionResult {
  workflowId: string;
  status: "completed" | "failed" | "cancelled";
  outputs: CanonicalJsonRecord;
  stepResults: Record<string, WorkflowStepResult>;
  compensationResults: WorkflowCompensationResult[];
  durationMs: number;
  error?: string;
  auditEvents: CanonicalJsonRecord[];
}

/**
 * Options for workflow execution engine.
 */
export interface WorkflowExecutionOptions {
  inputs?: CanonicalJsonRecord;
  brokerManager?: CapabilityBrokerManager;
  brokerHandler?: BrokerRequestHandlerFn;
  maxConcurrency?: number;
  signal?: AbortSignal;
  sessionId?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  scratchDir?: string;
  onProgress?: (event: WorkflowProgressEvent) => void | Promise<void>;
  onAudit?: (event: CanonicalJsonRecord) => void;
  autoRollbackOnFailure?: boolean;
  grant?: InvocationGrant;
  envelope?: CapabilityEnvelope;
  dryRun?: boolean;
}
