import { z } from "zod";
import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "./common.js";

/**
 * 11 Deployment lifecycle states per ADR 0008.
 */
export const DeploymentStateSchema = z.enum([
  "drafted",
  "validating",
  "rejected",
  "replaying",
  "eligible",
  "canary",
  "promoted",
  "suspended",
  "rolling_back",
  "rolled_back",
  "retired",
]);

export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

/**
 * Transition triggers and reasons.
 */
export const DeploymentTransitionReasonSchema = z.enum([
  "initial_draft",
  "validation_started",
  "validation_passed",
  "validation_failed",
  "replay_started",
  "replay_passed",
  "replay_failed",
  "marked_eligible",
  "canary_started",
  "canary_passed",
  "canary_failed",
  "manual_promotion",
  "auto_promotion",
  "manual_suspension",
  "health_check_failed",
  "manual_rollback",
  "automated_rollback",
  "rollback_completed",
  "retired_by_superseded",
  "manual_retirement",
]);

export type DeploymentTransitionReason = z.infer<typeof DeploymentTransitionReasonSchema>;

/**
 * Audit record of a single deployment state transition.
 */
export const DeploymentTransitionSchema = z.object({
  fromState: DeploymentStateSchema,
  toState: DeploymentStateSchema,
  timestamp: ISOTimestampSchema,
  reason: DeploymentTransitionReasonSchema,
  actor: z.object({
    type: z.enum(["daemon", "user", "policy_engine", "gateway", "system"]),
    id: z.string().min(1),
  }),
  message: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type DeploymentTransition = z.infer<typeof DeploymentTransitionSchema>;

/**
 * Automated rollback threshold configuration.
 */
export const AutoRollbackThresholdsSchema = z.object({
  maxErrorRate: z.number().min(0).max(1).default(0.05),
  maxLatencyP95Ms: z.number().positive().default(5000),
  maxSchemaMismatchRate: z.number().min(0).max(1).default(0.01),
  consecutiveFailureThreshold: z.number().int().positive().default(3),
});

export type AutoRollbackThresholds = z.infer<typeof AutoRollbackThresholdsSchema>;

/**
 * Canary deployment strategy and threshold settings.
 */
export const CanaryConfigSchema = z.object({
  strategy: z.enum(["shadow", "traffic_split", "developer_opt_in"]).default("shadow"),
  trafficPercentage: z.number().min(0).max(100).default(0),
  durationMinutes: z.number().int().positive().default(30),
  maxShadowWorkers: z.number().int().min(1).max(8).default(2),
  autoRollbackThresholds: AutoRollbackThresholdsSchema.default({}),
});

export type CanaryConfig = z.infer<typeof CanaryConfigSchema>;

/**
 * Full Deployment Record tracking the lifecycle of a tool deployment.
 */
export const DeploymentRecordSchema = z.object({
  deploymentId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  state: DeploymentStateSchema,
  canaryConfig: CanaryConfigSchema.optional(),
  history: z.array(DeploymentTransitionSchema).default([]),
  activeTrafficPercentage: z.number().min(0).max(100).default(0),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional(),
});

export type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;

export type DeploymentTransitionMap = {
  readonly [State in DeploymentState]: readonly DeploymentState[];
};

/**
 * Mapping of valid state transitions across the deployment lifecycle.
 */
export const VALID_DEPLOYMENT_TRANSITIONS: DeploymentTransitionMap = {
  drafted: ["validating", "rejected"],
  validating: ["replaying", "rejected"],
  replaying: ["eligible", "rejected"],
  eligible: ["canary", "rejected", "retired"],
  canary: ["promoted", "rolling_back", "suspended"],
  promoted: ["rolling_back", "suspended", "retired"],
  suspended: ["canary", "promoted", "rolling_back", "retired"],
  rolling_back: ["rolled_back", "suspended"],
  rolled_back: ["retired"],
  rejected: [],
  retired: [],
};

/**
 * Error codes associated with deployment transitions and lifecycle operations.
 */
export type DeploymentErrorCode =
  | "INVALID_TRANSITION"
  | "DEPLOYMENT_REJECTED"
  | "ROLLBACK_TRIGGERED"
  | "CANARY_TIMEOUT"
  | "ENVELOPE_VIOLATION"
  | "HEALTH_CHECK_FAILED";

export type DeploymentDetailValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | DeploymentDetailRecord
  | DeploymentDetailValue[];

export interface DeploymentDetailRecord {
  [key: string]: DeploymentDetailValue;
}

/**
 * Structured error class for deployment lifecycle failures.
 */
export class DeploymentError extends Error {
  readonly code: DeploymentErrorCode;
  readonly currentState?: DeploymentState;
  readonly targetState?: DeploymentState;
  readonly details?: DeploymentDetailRecord;

  constructor(params: {
    message: string;
    code: DeploymentErrorCode;
    currentState?: DeploymentState;
    targetState?: DeploymentState;
    details?: DeploymentDetailRecord;
  }) {
    super(params.message);
    this.name = "DeploymentError";
    this.code = params.code;
    this.currentState = params.currentState;
    this.targetState = params.targetState;
    this.details = params.details;
    Object.setPrototypeOf(this, DeploymentError.prototype);
  }
}

export type TransitionValidationResult = { valid: true } | { valid: false; error: DeploymentError };

/**
 * Validates whether a state transition from `currentState` to `nextState` is permissible.
 */
export function validateDeploymentTransition(
  currentState: DeploymentState,
  nextState: DeploymentState,
): TransitionValidationResult {
  const allowedNext = VALID_DEPLOYMENT_TRANSITIONS[currentState];
  if (!allowedNext || !allowedNext.includes(nextState)) {
    const error = new DeploymentError({
      code: "INVALID_TRANSITION",
      currentState,
      targetState: nextState,
      message: `Illegal deployment transition from '${currentState}' to '${nextState}'. Allowed target states: [${(allowedNext ?? []).join(", ")}]`,
      details: { allowedTransitions: [...(allowedNext ?? [])] },
    });
    return { valid: false, error };
  }
  return { valid: true };
}

/**
 * Asserts that a state transition is valid, throwing a DeploymentError if invalid.
 */
export function assertValidDeploymentTransition(
  currentState: DeploymentState,
  nextState: DeploymentState,
): void {
  const result = validateDeploymentTransition(currentState, nextState);
  if (!result.valid) {
    throw result.error;
  }
}
