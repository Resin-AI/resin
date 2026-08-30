import type { CapabilityEnvelope, ToolManifest } from "@resin/contracts";
import type { LocalDatabaseConnection, ToolRepository } from "@resin/db";
import type { JsonObject } from "../normalization/redaction.js";
import type { DeploymentActivator } from "./activator.js";
import type { ArtifactTransferClient } from "./client.js";
import type { LocalPreactivationChecker } from "./preactivation.js";
import type {
  SyncReconciliationAction,
  SyncReconciliationResult,
  ToolOverrideRecord,
} from "./types.js";

/**
 * Desired state tool specification.
 */
export interface DesiredToolSpec {
  version: string;
  digest?: string;
  manifest?: ToolManifest;
  metadata?: JsonObject;
}

/**
 * Options passed to DeploymentReconciler.reconcile().
 */
export interface ReconcileOptions {
  workspaceId: string;
  desiredTools?: Record<string, DesiredToolSpec>;
  desiredDeployments?: Record<string, string>;
  overrides?: ToolOverrideRecord[];
  envelope?: CapabilityEnvelope;
  force?: boolean;
  allowDevKeys?: boolean;
}

/**
 * Options for configuring DeploymentReconciler.
 */
export interface DeploymentReconcilerOptions {
  conn: LocalDatabaseConnection;
  activator: DeploymentActivator;
  preactivation: LocalPreactivationChecker;
  client?: ArtifactTransferClient;
  toolRepo?: ToolRepository;
}

/**
 * Desired vs actual state reconciler handling daemon restarts, reconnected sessions,
 * and user overrides.
 */
export class DeploymentReconciler {
  private readonly conn: LocalDatabaseConnection;
  private readonly activator: DeploymentActivator;
  private readonly preactivation: LocalPreactivationChecker;
  private readonly client?: ArtifactTransferClient;
  private readonly toolRepo?: ToolRepository;

  constructor(options: DeploymentReconcilerOptions) {
    this.conn = options.conn;
    this.activator = options.activator;
    this.preactivation = options.preactivation;
    this.client = options.client;
    this.toolRepo = options.toolRepo;
  }

  /**
   * Reconciles desired vs actual deployment state for a workspace.
   */
  async reconcile(options: ReconcileOptions): Promise<SyncReconciliationResult> {
    const timestamp = new Date().toISOString();
    const actions: SyncReconciliationAction[] = [];
    const errors: Array<{ toolId?: string; error: string }> = [];

    const { workspaceId, desiredTools, allowDevKeys } = options;

    // -------------------------------------------------------------------------
    // 1. Crash Recovery & Interrupted State Cleanup
    // -------------------------------------------------------------------------
    try {
      const interruptedRows = this.conn.all<{
        deployment_id: string;
        tool_id: string;
        tool_version: string;
        state: string;
      }>(
        "SELECT deployment_id, tool_id, tool_version, state FROM deployment_records WHERE workspace_id = ? AND state IN ('activating', 'rolling_back');",
        [workspaceId],
      );

      for (const row of interruptedRows) {
        if (row.state === "activating") {
          // Check if workspace active tools contains this version
          const wsRow = this.conn.get<{ active_tools_json: string }>(
            "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
            [workspaceId],
          );
          const activeMap: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");

          if (activeMap[row.tool_id] === row.tool_version) {
            // Activation did succeed in DB before crash; promote to active
            this.conn.run(
              "UPDATE deployment_records SET state = 'promoted', updated_at = ? WHERE deployment_id = ?;",
              [timestamp, row.deployment_id],
            );
            actions.push({
              toolId: row.tool_id,
              deploymentId: row.deployment_id,
              version: row.tool_version,
              action: "activated",
              reason: "Crash recovery: completed in-flight activation",
              status: "success",
            });
          } else {
            // Activation interrupted before completion; clean up to rolled_back
            this.conn.run(
              "UPDATE deployment_records SET state = 'rolled_back', updated_at = ? WHERE deployment_id = ?;",
              [timestamp, row.deployment_id],
            );
            actions.push({
              toolId: row.tool_id,
              deploymentId: row.deployment_id,
              version: row.tool_version,
              action: "rolled_back",
              reason: "Crash recovery: rolled back incomplete in-flight activation",
              status: "success",
            });
          }
        } else if (row.state === "rolling_back") {
          this.conn.run(
            "UPDATE deployment_records SET state = 'rolled_back', updated_at = ? WHERE deployment_id = ?;",
            [timestamp, row.deployment_id],
          );
          actions.push({
            toolId: row.tool_id,
            deploymentId: row.deployment_id,
            version: row.tool_version,
            action: "rolled_back",
            reason: "Crash recovery: finalized in-flight rollback",
            status: "success",
          });
        }
      }
    } catch (err) {
      errors.push({
        error: `Crash recovery scan failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // -------------------------------------------------------------------------
    // 2. Fetch Current Local State
    // -------------------------------------------------------------------------
    const wsRow = this.conn.get<{
      active_tools_json: string;
      capability_envelope_json: string;
    }>(
      "SELECT active_tools_json, capability_envelope_json FROM workspaces WHERE workspace_id = ?;",
      [workspaceId],
    );

    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");

    // Load workspace envelope
    let envelope: CapabilityEnvelope | undefined = options.envelope;
    if (!envelope && wsRow?.capability_envelope_json && wsRow.capability_envelope_json !== "{}") {
      try {
        envelope = JSON.parse(wsRow.capability_envelope_json);
      } catch {
        // Ignore envelope parse error
      }
    }

    // Load tool overrides
    let overrides: ToolOverrideRecord[] = options.overrides ?? [];
    if (overrides.length === 0) {
      try {
        const overrideRows = this.conn.all<{
          override_id: string;
          tool_id: string;
          action: "disable" | "pin" | "allow" | "custom";
          pinned_version?: string;
          is_enabled?: number;
        }>(
          "SELECT override_id, tool_id, action, pinned_version, is_enabled FROM tool_overrides WHERE workspace_id = ?;",
          [workspaceId],
        );

        overrides = overrideRows.map((r) => ({
          overrideId: r.override_id,
          toolId: r.tool_id,
          workspaceId,
          action: r.action,
          pinnedVersion: r.pinned_version,
          isEnabled: r.is_enabled !== 0,
          createdAt: timestamp,
          metadata: {},
        }));
      } catch {
        // Table might not exist or empty
      }
    }

    const overrideByTool = new Map<string, ToolOverrideRecord>();
    for (const ov of overrides) {
      overrideByTool.set(ov.toolId, ov);
    }

    // -------------------------------------------------------------------------
    // 3. Enforce User Overrides on Currently Active Tools
    // -------------------------------------------------------------------------
    for (const [toolId, activeVer] of Object.entries(activeTools)) {
      const override = overrideByTool.get(toolId);
      if (override) {
        // Check disabled
        if (override.action === "disable" || override.isEnabled === false) {
          try {
            await this.activator.suspend({
              workspaceId,
              toolId,
              version: activeVer,
              reason: "User override: tool is disabled",
            });
            delete activeTools[toolId];
            actions.push({
              toolId,
              version: activeVer,
              action: "suspended",
              reason: "User override: disabled",
              status: "success",
            });
          } catch (err) {
            errors.push({
              toolId,
              error: `Failed to suspend disabled tool ${toolId}: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          continue;
        }

        // Check pinned
        if (override.action === "pin" && override.pinnedVersion) {
          if (activeVer !== override.pinnedVersion) {
            try {
              // Check if pinned version is staged
              const pinnedRow = this.conn.get<{ manifest_json: string }>(
                "SELECT manifest_json FROM tool_versions WHERE tool_id = ? AND version = ?;",
                [toolId, override.pinnedVersion],
              );

              if (pinnedRow) {
                await this.activator.activate({
                  workspaceId,
                  toolId,
                  version: override.pinnedVersion,
                  reason: `User override: restored pinned version ${override.pinnedVersion}`,
                });
                activeTools[toolId] = override.pinnedVersion;
                actions.push({
                  toolId,
                  version: override.pinnedVersion,
                  action: "activated",
                  reason: `User override: restored pinned version ${override.pinnedVersion}`,
                  status: "success",
                });
              } else {
                actions.push({
                  toolId,
                  version: override.pinnedVersion,
                  action: "skipped",
                  reason: `Pinned version ${override.pinnedVersion} is not staged locally`,
                  status: "skipped",
                });
              }
            } catch (err) {
              errors.push({
                toolId,
                error: `Failed to restore pinned version for ${toolId}: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 4. Capability Envelope Compliance on Active Tools
    // -------------------------------------------------------------------------
    if (envelope) {
      for (const [toolId, activeVer] of Object.entries(activeTools)) {
        const manifestRow = this.conn.get<{ manifest_json: string }>(
          "SELECT manifest_json FROM tool_versions WHERE tool_id = ? AND version = ?;",
          [toolId, activeVer],
        );

        if (manifestRow) {
          let manifest: ToolManifest | null = null;
          try {
            manifest = JSON.parse(manifestRow.manifest_json);
          } catch {
            // Ignore parse error
          }

          if (manifest) {
            const check = await this.preactivation.checkPreactivation({
              manifest,
              workspaceId,
              envelope,
              overrides,
              targetVersion: activeVer,
            });

            if (!check.eligible) {
              try {
                await this.activator.suspend({
                  workspaceId,
                  toolId,
                  version: activeVer,
                  reason: `Capability envelope violation: ${check.violations.map((v) => v.message).join("; ")}`,
                });
                delete activeTools[toolId];
                actions.push({
                  toolId,
                  version: activeVer,
                  action: "suspended",
                  reason: `Capability envelope violation: ${check.violations[0]?.message ?? "Violation"}`,
                  status: "success",
                });
              } catch (err) {
                errors.push({
                  toolId,
                  error: `Failed to suspend envelope-violating tool ${toolId}: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 5. Desired State Alignment (Cloud Sync / Session Reconnect)
    // -------------------------------------------------------------------------
    if (desiredTools) {
      for (const [toolId, desiredSpec] of Object.entries(desiredTools)) {
        const override = overrideByTool.get(toolId);

        // Check if user override blocks this update
        if (override) {
          if (override.action === "disable" || override.isEnabled === false) {
            actions.push({
              toolId,
              version: desiredSpec.version,
              action: "skipped",
              reason: "Skipped: Tool disabled by local user override",
              status: "skipped",
            });
            continue;
          }

          if (
            override.action === "pin" &&
            override.pinnedVersion &&
            override.pinnedVersion !== desiredSpec.version
          ) {
            actions.push({
              toolId,
              version: desiredSpec.version,
              action: "skipped",
              reason: `Skipped: Tool pinned to version ${override.pinnedVersion} by local user override`,
              status: "skipped",
            });
            continue;
          }
        }

        const currentActiveVer = activeTools[toolId];
        if (currentActiveVer === desiredSpec.version) {
          actions.push({
            toolId,
            version: desiredSpec.version,
            action: "skipped",
            reason: "Already active at desired version",
            status: "skipped",
          });
          continue;
        }

        // Tool needs download or activation
        try {
          let manifest = desiredSpec.manifest;

          // Check if manifest is already in DB
          if (!manifest) {
            const verRow = this.conn.get<{ manifest_json: string }>(
              "SELECT manifest_json FROM tool_versions WHERE tool_id = ? AND version = ?;",
              [toolId, desiredSpec.version],
            );
            if (verRow) {
              manifest = JSON.parse(verRow.manifest_json);
            }
          }

          // If not in DB and client is available, download it
          if (!manifest && desiredSpec.digest && this.client) {
            const downloadRes = await this.client.downloadArtifact(desiredSpec.digest, {
              allowDevKeys,
              metadata: desiredSpec.metadata,
            });
            manifest = downloadRes.manifest;
            await this.activator.stageTool(manifest, {
              workspaceId,
              artifactDigest: desiredSpec.digest,
            });
            actions.push({
              toolId,
              version: desiredSpec.version,
              action: "downloaded",
              reason: "Downloaded desired artifact from cloud",
              status: "success",
            });
          }

          if (!manifest) {
            actions.push({
              toolId,
              version: desiredSpec.version,
              action: "rejected",
              reason: "Manifest or artifact not available locally and cannot be downloaded",
              status: "failure",
              error: "MANIFEST_UNAVAILABLE",
            });
            continue;
          }

          // Check preactivation
          const check = await this.preactivation.checkPreactivation({
            manifest,
            workspaceId,
            envelope,
            overrides,
            targetVersion: desiredSpec.version,
          });

          if (!check.eligible) {
            actions.push({
              toolId,
              version: desiredSpec.version,
              action: "rejected",
              reason: `Preactivation check rejected: ${check.violations.map((v) => v.message).join("; ")}`,
              status: "failure",
              error: check.violations[0]?.code ?? "PREACTIVATION_REJECTED",
            });
            continue;
          }

          // Stage if not already staged
          await this.activator.stageTool(manifest, {
            workspaceId,
            artifactDigest: desiredSpec.digest,
          });

          // Activate
          await this.activator.activate({
            workspaceId,
            toolId,
            version: desiredSpec.version,
            reason: `Reconciled to desired version ${desiredSpec.version}`,
          });

          activeTools[toolId] = desiredSpec.version;
          actions.push({
            toolId,
            version: desiredSpec.version,
            action: "activated",
            reason: `Reconciled to desired version ${desiredSpec.version}`,
            status: "success",
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          errors.push({ toolId, error: errorMsg });
          actions.push({
            toolId,
            version: desiredSpec.version,
            action: "rejected",
            reason: `Failed to reconcile tool: ${errorMsg}`,
            status: "failure",
            error: errorMsg,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // 6. Summary Result
    // -------------------------------------------------------------------------
    const finalWsRow = this.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      [workspaceId],
    );
    const finalActiveTools: Record<string, string> = JSON.parse(
      finalWsRow?.active_tools_json || "{}",
    );

    const appliedActionsCount = actions.filter((a) => a.status === "success").length;
    const pendingActionsCount = actions.filter((a) => a.status === "skipped").length;
    const errorCount = errors.length + actions.filter((a) => a.status === "failure").length;

    const suspendedTools = actions
      .filter((a) => a.action === "suspended" && a.status === "success")
      .map((a) => a.toolId);

    const rolledBackTools = actions
      .filter((a) => a.action === "rolled_back" && a.status === "success")
      .map((a) => a.toolId);

    return {
      workspaceId,
      reconciledAt: timestamp,
      actions,
      activeTools: finalActiveTools,
      suspendedTools,
      rolledBackTools,
      pendingActionsCount,
      appliedActionsCount,
      errorCount,
      errors,
    };
  }
}
