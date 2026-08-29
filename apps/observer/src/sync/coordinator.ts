import crypto from "node:crypto";
import type {
  CapabilityEnvelope,
  V1ActivationCertificate,
  V1LockedToolEntry,
} from "@resin/contracts";
import {
  V1ActivationCertificateSchema,
  V1LockedToolEntrySchema,
  V1RevocationMetadataSchema,
} from "@resin/contracts";
import type { LocalDatabaseConnection, ToolRepository } from "@resin/db";
import { z } from "zod";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
import type { DeploymentActivator } from "./activator.js";
import type { ArtifactTransferClient } from "./client.js";
import type { LocalPreactivationChecker } from "./preactivation.js";
import type { DeploymentReconciler, DesiredToolSpec } from "./reconciler.js";
import {
  type ArtifactInspectionResult,
  type DeploymentCommandMessage,
  DeploymentCommandMessageSchema,
  type DeploymentSyncStatusReport,
  DeploymentSyncStatusReportSchema,
  type SyncReconciliationResult,
  type ToolOverrideRecord,
  type TrustVerificationResult,
} from "./types.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

const TrustVerificationResultSchema = z.object({
  trusted: z.boolean(),
  certificate: V1ActivationCertificateSchema.optional(),
  revocationMetadata: V1RevocationMetadataSchema.optional(),
  reason: z.string().optional(),
  errorCode: z.string().optional(),
});

/**
 * Interface for bidirectional control stream adapter.
 */
export interface ControlStreamAdapter {
  onCommand(handler: (command: DeploymentCommandMessage) => Promise<void> | void): () => void;
  sendStatusReport?(report: DeploymentSyncStatusReport): Promise<void> | void;
}

/**
 * Options for configuring DeploymentSyncCoordinator.
 */
export interface DeploymentSyncCoordinatorOptions {
  conn: LocalDatabaseConnection;
  activator: DeploymentActivator;
  preactivation: LocalPreactivationChecker;
  client: ArtifactTransferClient;
  reconciler: DeploymentReconciler;
  toolRepo?: ToolRepository;
  defaultWorkspaceId?: string;
  allowDevKeys?: boolean;
}

/**
 * Deployment synchronization coordinator listening to control stream deployment commands
 * (deploy, activate, canary, suspend, resume, rollback, retire) with idempotency,
 * ordering, and status acknowledgements.
 */
export class DeploymentSyncCoordinator {
  private readonly conn: LocalDatabaseConnection;
  private readonly activator: DeploymentActivator;
  private readonly preactivation: LocalPreactivationChecker;
  private readonly client: ArtifactTransferClient;
  private readonly reconciler: DeploymentReconciler;
  private readonly toolRepo?: ToolRepository;
  private readonly defaultWorkspaceId: string;
  private readonly allowDevKeys: boolean;

  // Processed command cache for idempotency: commandId -> DeploymentSyncStatusReport
  private readonly processedCommands = new Map<string, DeploymentSyncStatusReport>();

  // Per-tool execution queues for deterministic serial command ordering
  private readonly toolQueues = new Map<string, Promise<unknown>>();

  // Control stream unsubscribers
  private readonly streamUnsubscribers: Array<() => void> = [];

  constructor(options: DeploymentSyncCoordinatorOptions) {
    this.conn = options.conn;
    this.activator = options.activator;
    this.preactivation = options.preactivation;
    this.client = options.client;
    this.reconciler = options.reconciler;
    this.toolRepo = options.toolRepo;
    this.defaultWorkspaceId = options.defaultWorkspaceId ?? "default";
    this.allowDevKeys = options.allowDevKeys ?? true;
  }

  /**
   * Attaches a control stream adapter to automatically process inbound deployment commands.
   */
  attachControlStream(stream: ControlStreamAdapter): () => void {
    const unsub = stream.onCommand(async (cmd) => {
      try {
        const report = await this.handleCommand(cmd);
        if (stream.sendStatusReport) {
          await stream.sendStatusReport(report);
        }
      } catch (err) {
        // Suppress unhandled stream command errors
      }
    });

    this.streamUnsubscribers.push(unsub);
    return unsub;
  }

  /**
   * Detaches all control stream adapters and clears active listeners.
   */
  detachAllStreams(): void {
    for (const unsub of this.streamUnsubscribers) {
      try {
        unsub();
      } catch {
        // Suppress errors
      }
    }
    this.streamUnsubscribers.length = 0;
  }

  /**
   * Handles an incoming deployment command with strict idempotency and deterministic queue ordering.
   */
  async handleCommand(command: DeploymentCommandMessage): Promise<DeploymentSyncStatusReport> {
    const validated = DeploymentCommandMessageSchema.parse(command);
    const commandId = validated.commandId;

    // 1. Check idempotency cache
    const existing = this.processedCommands.get(commandId);
    if (existing) {
      return existing;
    }

    const workspaceId = validated.workspaceId ?? this.defaultWorkspaceId;
    const toolKey = `${workspaceId}:${validated.toolId}`;

    // 2. Enqueue command for deterministic serial execution per tool
    const currentQueue = this.toolQueues.get(toolKey) ?? Promise.resolve();

    const executionPromise = currentQueue
      .catch(() => {})
      .then(async () => {
        // Double-check idempotency inside queue
        const cached = this.processedCommands.get(commandId);
        if (cached) return cached;

        const report = await this.executeCommand(validated, workspaceId);
        this.processedCommands.set(commandId, report);
        return report;
      });

    this.toolQueues.set(toolKey, executionPromise);
    return executionPromise;
  }

  /**
   * Executes a deployment command.
   */
  private async executeCommand(
    command: DeploymentCommandMessage,
    workspaceId: string,
  ): Promise<DeploymentSyncStatusReport> {
    const timestamp = new Date().toISOString();
    const reportId = `rep_${crypto.randomUUID()}`;

    const { commandId, commandType, toolId, version, targetDigest, canaryWeight, reason } = command;

    try {
      switch (commandType) {
        case "deploy":
        case "activate":
        case "canary": {
          const isCanary = commandType === "canary";
          let manifest = command.manifest;
          let inspection: ArtifactInspectionResult | undefined;

          // 1. Download artifact if digest is provided and manifest not supplied
          if (!manifest && targetDigest) {
            const downloadRes = await this.client.downloadArtifact(targetDigest, {
              allowDevKeys: this.allowDevKeys,
              metadata: JsonObjectSchema.safeParse(command.metadata).data,
            });
            manifest = downloadRes.manifest;
            inspection = downloadRes.inspection;
          }

          // 2. If manifest still missing, check local DB
          if (!manifest) {
            const verRow = this.conn.get<{ manifest_json: string }>(
              "SELECT manifest_json FROM tool_versions WHERE tool_id = ? AND version = ?;",
              [toolId, version],
            );
            if (verRow) {
              manifest = JSON.parse(verRow.manifest_json);
            }
          }

          if (!manifest) {
            return DeploymentSyncStatusReportSchema.parse({
              reportId,
              commandId,
              deploymentId: command.deploymentId,
              toolId,
              version,
              workspaceId,
              status: "rejected",
              appliedAt: timestamp,
              errorCode: "ARTIFACT_UNAVAILABLE",
              errorMessage: `Artifact for tool ${toolId} v${version} is unavailable`,
              details: {},
            });
          }

          // 3. Load workspace envelope & overrides
          const wsRow = this.conn.get<{
            capability_envelope_json: string;
            config_json?: string;
          }>(
            "SELECT capability_envelope_json, config_json FROM workspaces WHERE workspace_id = ?;",
            [workspaceId],
          );

          let envelope: CapabilityEnvelope | undefined;
          if (wsRow?.capability_envelope_json && wsRow.capability_envelope_json !== "{}") {
            try {
              envelope = JSON.parse(wsRow.capability_envelope_json);
            } catch {
              // Ignore envelope parse error
            }
          }

          const overrides: ToolOverrideRecord[] = [];
          try {
            const ctrlRow = this.conn.get<{
              pinned_versions_json?: string;
              disabled_tools_json?: string;
            }>(
              "SELECT pinned_versions_json, disabled_tools_json FROM user_tool_controls WHERE workspace_id = ?;",
              [workspaceId],
            );

            if (ctrlRow) {
              const disabled: string[] = JSON.parse(ctrlRow.disabled_tools_json || "[]");
              const pinned: Record<string, string> = JSON.parse(
                ctrlRow.pinned_versions_json || "{}",
              );

              for (const dId of disabled) {
                overrides.push({
                  toolId: dId,
                  workspaceId,
                  action: "disable",
                  isEnabled: false,
                  createdAt: timestamp,
                  metadata: {},
                });
              }

              for (const [pId, pVer] of Object.entries(pinned)) {
                overrides.push({
                  toolId: pId,
                  workspaceId,
                  action: "pin",
                  pinnedVersion: pVer,
                  isEnabled: true,
                  createdAt: timestamp,
                  metadata: {},
                });
              }
            }
          } catch {
            // Table user_tool_controls might not exist
          }

          // 4. Run Preactivation Checks
          const metaLockedEntry = command.metadata?.lockedEntry
            ? V1LockedToolEntrySchema.safeParse(command.metadata.lockedEntry).data
            : undefined;
          const metaCertificate = command.metadata?.certificate
            ? V1ActivationCertificateSchema.safeParse(command.metadata.certificate).data
            : undefined;
          const commandTrustVerification = command.trustVerification
            ? TrustVerificationResultSchema.safeParse(command.trustVerification).data
            : undefined;
          const metaTrustVerification = command.metadata?.trustVerification
            ? TrustVerificationResultSchema.safeParse(command.metadata.trustVerification).data
            : undefined;

          const preactivationResult = await this.preactivation.checkPreactivation({
            manifest,
            workspaceId,
            projectId:
              command.projectId ??
              z.string().safeParse(command.metadata?.projectId).data ??
              workspaceId,
            envelope,
            overrides,
            inspection,
            targetVersion: version,
            targetDigest,
            lockedEntry: command.lockedEntry ?? metaLockedEntry,
            certificate: command.certificate ?? metaCertificate,
            trustVerification: commandTrustVerification ?? metaTrustVerification,
          });

          if (!preactivationResult.eligible) {
            const primaryViolation = preactivationResult.violations[0];
            return DeploymentSyncStatusReportSchema.parse({
              reportId,
              commandId,
              deploymentId: command.deploymentId,
              toolId,
              version,
              workspaceId,
              status: "rejected",
              appliedAt: timestamp,
              errorCode: primaryViolation?.code ?? "PREACTIVATION_REJECTED",
              errorMessage:
                primaryViolation?.message ??
                `Preactivation check rejected with ${preactivationResult.violations.length} violations`,
              details: {
                outcome: preactivationResult.outcome,
                violations: preactivationResult.violations,
                warnings: preactivationResult.warnings,
              },
            });
          }

          // 5. Stage tool manifest & version
          await this.activator.stageTool(manifest, {
            workspaceId,
            artifactDigest: targetDigest,
            bundleUri: command.bundleUrl ?? command.artifactUri,
          });

          // 6. Atomically activate deployment
          const activationResult = await this.activator.activate({
            workspaceId,
            toolId,
            version,
            deploymentId: command.deploymentId,
            isCanary,
            targetTrafficPercentage: canaryWeight,
            reason: reason ?? `Applied command ${commandId}`,
            metadata: JsonObjectSchema.safeParse(command.metadata).data,
          });

          return DeploymentSyncStatusReportSchema.parse({
            reportId,
            commandId,
            deploymentId: activationResult.deploymentId,
            toolId,
            version,
            workspaceId,
            status: activationResult.state,
            activeTrafficPercentage: activationResult.activeTrafficPercentage,
            appliedAt: activationResult.appliedAt,
            catalogRevision: activationResult.revision,
            catalogDigest: activationResult.snapshot.digest,
            details: {
              snapshotId: activationResult.snapshot.snapshotId,
            },
          });
        }

        case "rollback": {
          const rollbackResult = await this.activator.rollback({
            workspaceId,
            toolId,
            targetVersion: command.rollbackToVersion,
            targetSnapshotId: command.rollbackToSnapshotId,
            reason: reason ?? `Applied rollback command ${commandId}`,
          });

          return DeploymentSyncStatusReportSchema.parse({
            reportId,
            commandId,
            deploymentId: rollbackResult.deploymentId,
            toolId,
            version,
            workspaceId,
            status: rollbackResult.state,
            activeTrafficPercentage: 0,
            appliedAt: rollbackResult.appliedAt,
            catalogRevision: rollbackResult.revision,
            catalogDigest: rollbackResult.snapshot.digest,
            details: {
              rolledBackVersion: rollbackResult.rolledBackVersion,
              restoredVersion: rollbackResult.restoredVersion,
            },
          });
        }

        case "suspend": {
          const suspendResult = await this.activator.suspend({
            workspaceId,
            toolId,
            version,
            reason: reason ?? `Applied suspend command ${commandId}`,
          });

          return DeploymentSyncStatusReportSchema.parse({
            reportId,
            commandId,
            deploymentId: command.deploymentId,
            toolId,
            version,
            workspaceId,
            status: "suspended",
            activeTrafficPercentage: 0,
            appliedAt: timestamp,
            catalogDigest: suspendResult.snapshot.digest,
            details: {},
          });
        }

        case "resume": {
          const resumeResult = await this.activator.resume({
            workspaceId,
            toolId,
            version,
            reason: reason ?? `Applied resume command ${commandId}`,
          });

          return DeploymentSyncStatusReportSchema.parse({
            reportId,
            commandId,
            deploymentId: resumeResult.deploymentId,
            toolId,
            version,
            workspaceId,
            status: resumeResult.state,
            activeTrafficPercentage: resumeResult.activeTrafficPercentage,
            appliedAt: resumeResult.appliedAt,
            catalogRevision: resumeResult.revision,
            catalogDigest: resumeResult.snapshot.digest,
            details: {},
          });
        }

        case "retire": {
          await this.activator.retire({
            workspaceId,
            toolId,
            version,
            reason: reason ?? `Applied retire command ${commandId}`,
          });

          return DeploymentSyncStatusReportSchema.parse({
            reportId,
            commandId,
            deploymentId: command.deploymentId,
            toolId,
            version,
            workspaceId,
            status: "retired",
            activeTrafficPercentage: 0,
            appliedAt: timestamp,
            details: {},
          });
        }

        default: {
          return DeploymentSyncStatusReportSchema.parse({
            reportId,
            commandId,
            deploymentId: command.deploymentId,
            toolId,
            version,
            workspaceId,
            status: "rejected",
            appliedAt: timestamp,
            errorCode: "UNKNOWN_COMMAND_TYPE",
            // SAFETY: Dispatches unknown command payload to read its reported commandType.
            errorMessage: `Unknown command type: ${String((command as { commandType?: unknown }).commandType)}`,
            details: {},
          });
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return DeploymentSyncStatusReportSchema.parse({
        reportId,
        commandId,
        deploymentId: command.deploymentId,
        toolId,
        version,
        workspaceId,
        status: "failed",
        appliedAt: timestamp,
        errorCode: "COMMAND_EXECUTION_ERROR",
        errorMessage: errorMsg,
        details: {},
      });
    }
  }

  /**
   * Reconnects and performs full state synchronization with desired cloud tools.
   */
  async sync(
    options: {
      workspaceId?: string;
      desiredTools?: Record<string, DesiredToolSpec>;
      overrides?: ToolOverrideRecord[];
      envelope?: CapabilityEnvelope;
      force?: boolean;
    } = {},
  ): Promise<SyncReconciliationResult> {
    const workspaceId = options.workspaceId ?? this.defaultWorkspaceId;
    return this.reconciler.reconcile({
      workspaceId,
      desiredTools: options.desiredTools,
      overrides: options.overrides,
      envelope: options.envelope,
      force: options.force,
      allowDevKeys: this.allowDevKeys,
    });
  }
}
