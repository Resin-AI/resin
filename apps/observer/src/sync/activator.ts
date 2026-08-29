import crypto from "node:crypto";
import {
  type AuditActor,
  type CapabilityEnvelope,
  CapabilityEnvelopeSchema,
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  type CatalogToolSummary,
  type DeploymentRecord,
  type DeploymentState,
  type DeploymentTransition,
  type DeploymentTransitionReason,
  type InstallationRecord,
  type SafetyGateRefusal,
  type ToolManifest,
  type ToolVersion,
  canonicalJson,
  hashCanonicalContent,
  isSafetyGateBypassTool,
} from "@resin/contracts";
import { SecretRedactor } from "@resin/crypto";
import type { LocalDatabaseConnection, ToolRepository } from "@resin/db";
import type { JsonObject } from "../normalization/redaction.js";
import type { AuditTrailManager } from "../observability/audit-trail.js";
import {
  ArtifactTransferClient,
  AttestationVerificationError,
  DigestMismatchError,
  EnvelopeViolationError,
  IncompatibleRuntimeError,
  InvalidSignatureError,
  RevokedSigningKeyError,
  UnknownSigningKeyError,
  UntrustedSigningKeyError,
} from "./client.js";
import { LocalPreactivationChecker } from "./preactivation.js";
import type { CatalogChangeEvent, SigningKeyStore, UserControls } from "./types.js";

export interface QuarantineManagerLike {
  quarantineArtifact(options: {
    toolId: string;
    version: string;
    reason: string;
    errorMessage?: string;
    metadata?: JsonObject;
  }): Promise<undefined | boolean | JsonObject>;
}

/**
 * Listener function for CatalogChangeEvents.
 */
export type CatalogChangeListener = (event: CatalogChangeEvent) => void | Promise<void>;

/**
 * Parameters for activating a deployment.
 */
export interface ActivateDeploymentParams {
  workspaceId: string;
  toolId: string;
  version: string;
  deploymentId?: string;
  targetTrafficPercentage?: number;
  isCanary?: boolean;
  canaryConfig?: {
    strategy?: "shadow" | "traffic_split" | "developer_opt_in";
    trafficPercentage?: number;
    durationMinutes?: number;
    maxShadowWorkers?: number;
    autoRollbackThresholds?: {
      maxErrorRate?: number;
      maxLatencyP95Ms?: number;
      maxSchemaMismatchRate?: number;
      consecutiveFailureThreshold?: number;
    };
  };
  reason?: string;
  transitionReason?: DeploymentTransitionReason;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
  metadata?: JsonObject;
  artifactBuffer?: Buffer;
  requireSignature?: boolean;
  requireAttestation?: boolean;
  quarantineOnFailure?: boolean;
  manifest?: ToolManifest;
}

/**
 * Result of activating a deployment.
 */
export interface ActivationResult {
  success: boolean;
  deploymentId: string;
  snapshot: CatalogSnapshot;
  isCanary: boolean;
  trafficPercentage: number;
  activeTrafficPercentage?: number;
  previousVersion?: string;
  state?: DeploymentState | string;
  appliedAt?: string;
  revision?: number;
}

/**
 * Parameters for rolling back a deployment.
 */
export interface RollbackDeploymentParams {
  workspaceId: string;
  toolId: string;
  targetVersion?: string;
  targetSnapshotId?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
  reason?: string;
  candidateVersion?: string;
  quarantineCandidate?: boolean;
  quarantineReason?: string;
}

/**
 * Result of rolling back a deployment.
 */
export interface RollbackResult {
  success: boolean;
  deploymentId: string;
  toolId?: string;
  state?: DeploymentState;
  snapshot: CatalogSnapshot;
  rolledBackVersion: string;
  restoredVersion?: string;
  appliedAt?: string;
  revision?: number;
}
/**
 * Parameters for suspending a deployment.
 */
export interface SuspendDeploymentParams {
  workspaceId: string;
  toolId: string;
  version?: string;
  reason?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
}

/**
 * Parameters for resuming a deployment.
 */
export interface ResumeDeploymentParams {
  workspaceId: string;
  toolId: string;
  version?: string;
  reason?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
}

/**
 * Parameters for retiring a deployment.
 */
export interface RetireDeploymentParams {
  workspaceId: string;
  toolId: string;
  version?: string;
  reason?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
}

/**
 * Interface representing safety-gate verifier.
 */
export interface SafetyGateLike {
  canExecuteTool(
    toolId: string,
    action: string,
    isReadOperation?: boolean,
  ): { allowed: boolean; refusal?: SafetyGateRefusal };
  isUnsafeOverrideActive?(): boolean;
}

/**
 * Options for DeploymentActivator.
 */
export interface DeploymentActivatorOptions {
  conn: LocalDatabaseConnection;
  toolRepo?: ToolRepository;
  defaultActor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
  safetyGate?: SafetyGateLike;
  auditTrail?: AuditTrailManager;
  keyStore?: SigningKeyStore;
  client?: ArtifactTransferClient;
  preactivationChecker?: LocalPreactivationChecker;
  quarantineManager?: QuarantineManagerLike;
}
/**
 * Atomic deployment activator managing transition through SQLite in single transactions,
 * emitting catalog change events (TE-018) and guaranteeing crash resilience.
 */
export class DeploymentActivator {
  private readonly conn: LocalDatabaseConnection;
  private readonly toolRepo?: ToolRepository;
  private readonly listeners = new Set<CatalogChangeListener>();
  private safetyGate?: SafetyGateLike;
  private auditTrail?: AuditTrailManager;
  private readonly defaultActor: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
  private readonly client: ArtifactTransferClient;
  private readonly preactivationChecker: LocalPreactivationChecker;
  private readonly quarantineManager?: QuarantineManagerLike;

  constructor(options: DeploymentActivatorOptions) {
    this.conn = options.conn;
    this.toolRepo = options.toolRepo;
    this.safetyGate = options.safetyGate;
    this.auditTrail = options.auditTrail;
    this.defaultActor = options.defaultActor ?? {
      type: "daemon",
      id: "resin-daemon",
    };
    this.client =
      options.client ??
      new ArtifactTransferClient({
        keyStore: options.keyStore,
      });
    this.preactivationChecker = options.preactivationChecker ?? new LocalPreactivationChecker();
    this.quarantineManager = options.quarantineManager;
    this.initTables();
  }

  private initTables(): void {
    try {
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS user_tool_controls (
          workspace_id TEXT PRIMARY KEY,
          pinned_versions_json TEXT NOT NULL DEFAULT '{}',
          disabled_tools_json TEXT NOT NULL DEFAULT '[]',
          frozen_tools_json TEXT NOT NULL DEFAULT '[]',
          rollbacks_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        );
      `);
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS quarantined_artifacts (
          quarantine_id TEXT PRIMARY KEY,
          tool_id TEXT,
          tool_version TEXT,
          artifact_digest TEXT,
          reason TEXT,
          error_message TEXT,
          quarantined_at TEXT NOT NULL,
          metadata_json TEXT DEFAULT '{}'
        );
      `);
    } catch {
      // Fallback if table already exists or read-only
    }
  }

  setSafetyGate(safetyGate: SafetyGateLike): void {
    this.safetyGate = safetyGate;
  }
  setAuditTrail(auditTrail: AuditTrailManager): void {
    this.auditTrail = auditTrail;
  }
  /**
   * Register a listener for catalog change notifications.
   */
  onCatalogChange(listener: CatalogChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * Retrieves current active tools map for a workspace from SQLite.
   */
  async getActiveTools(workspaceId: string): Promise<Record<string, string>> {
    const wsRow = this.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      [workspaceId],
    );
    if (!wsRow?.active_tools_json) {
      return {};
    }
    try {
      // SAFETY: active_tools_json is valid JSON string dictionary of active tool versions.
      return JSON.parse(wsRow.active_tools_json) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /**
   * Broadcast catalog change event to all registered listeners.
   */
  private emitCatalogChange(event: CatalogChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        void listener(event);
      } catch {
        // Suppress listener errors
      }
    }
  }

  /**
   * Stages a tool manifest and version in the local database.
   */
  async stageTool(
    manifest: ToolManifest,
    options: {
      workspaceId?: string;
      artifactDigest?: string;
      bundleUri?: string;
      status?: "draft" | "active";
      createdBy?: string;
    } = {},
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const manifestDigest =
      manifest.digest || crypto.createHash("sha256").update(canonicalJson(manifest)).digest("hex");
    const artifactDigest = options.artifactDigest ?? manifestDigest;

    await this.conn.transaction(async () => {
      // 1. Upsert tool manifest
      this.conn.run(
        `INSERT INTO tool_manifests (
          tool_id, name, version, description, scope, parameters_json,
          output_schema_json, runtime_json, capabilities_json, limits_json,
          digest, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool_id) DO UPDATE SET
          name = excluded.name,
          version = excluded.version,
          description = excluded.description,
          scope = excluded.scope,
          parameters_json = excluded.parameters_json,
          output_schema_json = excluded.output_schema_json,
          runtime_json = excluded.runtime_json,
          capabilities_json = excluded.capabilities_json,
          limits_json = excluded.limits_json,
          digest = excluded.digest,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at;`,
        [
          manifest.id,
          manifest.name,
          manifest.version,
          manifest.description,
          manifest.scope ?? "workspace",
          canonicalJson(manifest.parameters ?? {}),
          manifest.outputSchema ? canonicalJson(manifest.outputSchema) : null,
          canonicalJson(manifest.runtime ?? {}),
          canonicalJson(manifest.capabilities ?? {}),
          canonicalJson(manifest.limits ?? {}),
          manifestDigest,
          canonicalJson(manifest.metadata ?? {}),
          timestamp,
          timestamp,
        ],
      );

      // 2. Upsert tool version
      const artifactObj = {
        artifactDigest,
        bundleReference: {
          uri: options.bundleUri ?? `memory://${manifest.id}/${manifest.version}`,
          hash: artifactDigest,
          format: "tar",
        },
      };

      const provenanceObj = {
        synthesizer: "manual",
        evolutionStrategy: "deterministic",
        createdAt: timestamp,
      };

      this.conn.run(
        `INSERT INTO tool_versions (
          tool_id, version, manifest_digest, artifact_digest, manifest_json,
          artifact_json, provenance_json, signature_json, status, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)
        ON CONFLICT(tool_id, version) DO UPDATE SET
          manifest_digest = excluded.manifest_digest,
          artifact_digest = excluded.artifact_digest,
          manifest_json = excluded.manifest_json,
          artifact_json = excluded.artifact_json,
          provenance_json = excluded.provenance_json,
          status = excluded.status;`,
        [
          manifest.id,
          manifest.version,
          manifestDigest,
          artifactDigest,
          canonicalJson(manifest),
          canonicalJson(artifactObj),
          canonicalJson(provenanceObj),
          options.status ?? "draft",
          timestamp,
          options.createdBy ?? "system",
        ],
      );
    });
  }

  /**
   * Atomically activates a tool deployment for a workspace in a single SQLite transaction.
   */
  async activate(params: ActivateDeploymentParams): Promise<ActivationResult> {
    const timestamp = new Date().toISOString();
    const actor = params.actor ?? this.defaultActor;
    const isCanary = Boolean(params.isCanary);
    const trafficPct = isCanary ? (params.targetTrafficPercentage ?? 10) : 100;
    const targetState: DeploymentState = isCanary ? "canary" : "promoted";

    // 1. Artifact inspection and cryptographic signature / attestation verification if buffer provided
    if (params.artifactBuffer) {
      try {
        await this.client.inspectArtifactBytes(params.artifactBuffer, {
          verifySignature: true,
          requireSignature: params.requireSignature,
          requireAttestation: params.requireAttestation,
        });
      } catch (err) {
        const qReason =
          err instanceof InvalidSignatureError || err instanceof RevokedSigningKeyError
            ? "signature_mismatch"
            : err instanceof DigestMismatchError
              ? "digest_mismatch"
              : "policy_violation";

        if (params.quarantineOnFailure || this.quarantineManager) {
          if (this.quarantineManager) {
            await this.quarantineManager.quarantineArtifact({
              toolId: params.toolId,
              version: params.version,
              // SAFETY: qReason maps directly to recognized quarantine reason code.
              reason: qReason as string,
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
          try {
            this.conn.run(
              `INSERT INTO quarantined_artifacts (
                quarantine_id, tool_id, tool_version, reason, error_message, quarantined_at
              ) VALUES (?, ?, ?, ?, ?, ?);`,
              [
                `quar_${crypto.randomUUID()}`,
                params.toolId,
                params.version,
                qReason,
                err instanceof Error ? err.message : String(err),
                timestamp,
              ],
            );
          } catch {
            // Ignore table write errors
          }
        }
        if (this.auditTrail) {
          await this.auditTrail.append({
            eventType: "quarantine_incident",
            actor: {
              // SAFETY: Actor type mapping transforms gateway into system actor.
              type: (actor.type === "gateway" ? "system" : actor.type) as AuditActor["type"],
              id: actor.id,
            },
            resourceType: "deployment",
            resourceId: params.deploymentId ?? `dep_${params.toolId}_${params.version}`,
            action: "quarantine",
            status: "failure",
            details: {
              error: err instanceof Error ? err.message : String(err),
              toolId: params.toolId,
              version: params.version,
            },
          });
        }
        throw err;
      }
    }

    // 2. Enforce User Controls: disable, freeze, pin
    try {
      const userControlsRow = this.conn.get<{
        disabled_tools_json?: string;
        pinned_versions_json?: string;
        frozen_tools_json?: string;
      }>(
        "SELECT disabled_tools_json, pinned_versions_json, frozen_tools_json FROM user_tool_controls WHERE workspace_id = ?;",
        [params.workspaceId],
      );

      if (userControlsRow) {
        const disabledTools: string[] = JSON.parse(userControlsRow.disabled_tools_json || "[]");
        if (disabledTools.includes(params.toolId)) {
          throw new Error(
            `Deployment activation rejected: tool '${params.toolId}' is disabled by user control in workspace '${params.workspaceId}'`,
          );
        }
        const frozenTools: string[] = JSON.parse(userControlsRow.frozen_tools_json || "[]");
        if (frozenTools.includes(params.toolId)) {
          throw new Error(
            `Deployment activation rejected: tool '${params.toolId}' is frozen by user control in workspace '${params.workspaceId}'`,
          );
        }
        const pinnedVersions: Record<string, string> = JSON.parse(
          userControlsRow.pinned_versions_json || "{}",
        );
        if (pinnedVersions[params.toolId] && pinnedVersions[params.toolId] !== params.version) {
          throw new Error(
            `Deployment activation rejected: tool '${params.toolId}' is pinned to version '${pinnedVersions[params.toolId]}' in workspace '${params.workspaceId}'`,
          );
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("Deployment activation rejected: tool '")
      ) {
        throw err;
      }
      // Suppress table query errors if table doesn't exist
    }

    // 3. Re-evaluate local capability envelope against candidate manifest
    try {
      const wsEnvelopeRow = this.conn.get<{ capability_envelope_json: string }>(
        "SELECT capability_envelope_json FROM workspaces WHERE workspace_id = ?;",
        [params.workspaceId],
      );
      let envelope: CapabilityEnvelope | undefined;
      if (wsEnvelopeRow?.capability_envelope_json) {
        try {
          envelope = CapabilityEnvelopeSchema.parse(
            JSON.parse(wsEnvelopeRow.capability_envelope_json),
          );
        } catch {
          // Ignored
        }
      }

      let manifestToVerify: ToolManifest | undefined = params.manifest;
      if (!manifestToVerify) {
        const tvRow = this.conn.get<{ manifest_json: string }>(
          "SELECT manifest_json FROM tool_versions WHERE tool_id = ? AND version = ?;",
          [params.toolId, params.version],
        );
        if (tvRow?.manifest_json) {
          try {
            manifestToVerify = JSON.parse(tvRow.manifest_json);
          } catch {
            // Ignored
          }
        }
      }

      if (envelope && manifestToVerify && !isSafetyGateBypassTool(params.toolId)) {
        const precheck = await this.preactivationChecker.checkPreactivation({
          manifest: manifestToVerify,
          workspaceId: params.workspaceId,
          envelope,
          targetVersion: params.version,
        });

        if (!precheck.eligible && precheck.violations.length > 0) {
          const violationMsg = precheck.violations.map((v) => v.message).join("; ");
          if (this.auditTrail) {
            const auditActor: AuditActor = {
              type: actor.type === "gateway" ? "system" : actor.type,
              id: actor.id,
            };
            const violationRecords: JsonObject[] = precheck.violations.map((v) => {
              const item: JsonObject = {
                code: v.code,
                subsystem: v.subsystem,
                message: v.message,
              };
              if (v.field !== undefined) {
                item.field = v.field;
              }
              if (v.requestedValue !== undefined) {
                item.requestedValue = String(v.requestedValue);
              }
              return item;
            });
            await this.auditTrail.append({
              eventType: "safety_gate_refusal",
              actor: auditActor,
              resourceType: "deployment",
              resourceId: params.deploymentId ?? `dep_${params.toolId}_${params.version}`,
              action: "activate",
              status: "denied",
              details: {
                refusalReason: violationMsg,
                toolId: params.toolId,
                version: params.version,
                violations: violationRecords,
              },
            });
          }
          if (params.quarantineOnFailure || this.quarantineManager) {
            if (this.quarantineManager) {
              await this.quarantineManager.quarantineArtifact({
                toolId: params.toolId,
                version: params.version,
                reason: "policy_violation",
                errorMessage: violationMsg,
              });
            }
            try {
              this.conn.run(
                `INSERT INTO quarantined_artifacts (
                  quarantine_id, tool_id, tool_version, reason, error_message, quarantined_at
                ) VALUES (?, ?, ?, ?, ?, ?);`,
                [
                  `quar_${crypto.randomUUID()}`,
                  params.toolId,
                  params.version,
                  "policy_violation",
                  violationMsg,
                  timestamp,
                ],
              );
            } catch {
              // Ignore write error
            }
          }
          throw new EnvelopeViolationError(violationMsg, {
            toolId: params.toolId,
            version: params.version,
          });
        }
      }
    } catch (err) {
      if (err instanceof EnvelopeViolationError) {
        throw err;
      }
      // Suppress other precheck query errors
    }

    // 4. Safety gate fail-closed enforcement on non-system tools
    if (this.safetyGate && !isSafetyGateBypassTool(params.toolId)) {
      const check = this.safetyGate.canExecuteTool(params.toolId, params.toolId, false);
      if (!check.allowed && check.refusal) {
        if (this.auditTrail) {
          const auditActor: AuditActor = {
            type: actor.type === "gateway" ? "system" : actor.type,
            id: actor.id,
          };
          await this.auditTrail.append({
            eventType: "safety_gate_refusal",
            actor: auditActor,
            resourceType: "deployment",
            resourceId: params.toolId,
            action: "activate",
            status: "denied",
            details: {
              code: check.refusal.refusalCode,
              refusalReason: check.refusal.refusalReason,
              toolId: params.toolId,
              version: params.version,
              category: check.refusal.refusalCode,
            },
          });
        }
        throw new Error(
          `Deployment activation blocked by fail-closed safety gate: ${check.refusal.refusalReason}`,
        );
      }

      if (this.safetyGate.isUnsafeOverrideActive?.() && this.auditTrail) {
        const auditActor: AuditActor = {
          type: actor.type === "gateway" ? "system" : actor.type,
          id: actor.id,
        };
        await this.auditTrail.append({
          eventType: "safety_gate_unsafe_override",
          actor: auditActor,
          resourceType: "deployment",
          resourceId: params.toolId,
          action: "override",
          status: "success",
          details: {
            toolId: params.toolId,
            version: params.version,
          },
        });
      }
    }

    let snapshotResult: CatalogSnapshot | null = null;
    let deploymentIdResult = params.deploymentId;
    let revisionResult = 1;
    let previousActiveVersion: string | undefined;
    await this.conn.transaction(async () => {
      // 1. Ensure workspace exists
      let wsRow = this.conn.get<{
        workspace_id: string;
        active_tools_json: string;
        capability_envelope_json: string;
      }>(
        "SELECT workspace_id, active_tools_json, capability_envelope_json FROM workspaces WHERE workspace_id = ?;",
        [params.workspaceId],
      );

      if (!wsRow) {
        this.conn.run(
          `INSERT INTO workspaces (
            workspace_id, root_path, name, config_json, capability_envelope_json,
            active_tools_json, created_at, updated_at
          ) VALUES (?, ?, ?, '{}', '{}', '{}', ?, ?);`,
          [
            params.workspaceId,
            `/workspaces/${params.workspaceId}`,
            params.workspaceId,
            timestamp,
            timestamp,
          ],
        );
        wsRow = {
          workspace_id: params.workspaceId,
          active_tools_json: "{}",
          capability_envelope_json: "{}",
        };
      }

      const activeTools: Record<string, string> = JSON.parse(wsRow.active_tools_json || "{}");
      previousActiveVersion = activeTools[params.toolId];

      // 2. Read or create deployment record
      let depRow = this.conn.get<{
        deployment_id: string;
        state: string;
        history_json: string;
      }>(
        "SELECT deployment_id, state, history_json FROM deployment_records WHERE workspace_id = ? AND tool_id = ? AND tool_version = ?;",
        [params.workspaceId, params.toolId, params.version],
      );

      if (!depRow && params.deploymentId) {
        depRow = this.conn.get<{
          deployment_id: string;
          state: string;
          history_json: string;
        }>(
          "SELECT deployment_id, state, history_json FROM deployment_records WHERE deployment_id = ?;",
          [params.deploymentId],
        );
      }
      const deploymentId =
        depRow?.deployment_id ?? params.deploymentId ?? `dep_${crypto.randomUUID()}`;
      deploymentIdResult = deploymentId;
      // SAFETY: Deployment state column matches DeploymentState union.
      const previousState = (depRow?.state as DeploymentState) ?? "drafted";

      const transReason: DeploymentTransitionReason =
        params.transitionReason ?? (isCanary ? "canary_started" : "auto_promotion");

      const history: DeploymentTransition[] = JSON.parse(depRow?.history_json || "[]");
      const transition: DeploymentTransition = {
        fromState: previousState,
        toState: targetState,
        timestamp,
        reason: transReason,
        actor,
        message: params.reason ?? `Activated tool ${params.toolId} v${params.version}`,
        metadata: params.metadata ?? {},
      };
      history.push(transition);

      // 3. Upsert deployment record
      this.conn.run(
        `INSERT INTO deployment_records (
          deployment_id, workspace_id, tool_id, tool_version, state,
          canary_config_json, history_json, active_traffic_percentage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(deployment_id) DO UPDATE SET
          state = excluded.state,
          canary_config_json = excluded.canary_config_json,
          history_json = excluded.history_json,
          active_traffic_percentage = excluded.active_traffic_percentage,
          updated_at = excluded.updated_at;`,
        [
          deploymentId,
          params.workspaceId,
          params.toolId,
          params.version,
          targetState,
          isCanary ? JSON.stringify({ trafficPercentage: trafficPct }) : null,
          canonicalJson(history),
          trafficPct,
          timestamp,
          timestamp,
        ],
      );

      // 4. Update tool_versions status to active
      this.conn.run(
        "UPDATE tool_versions SET status = 'active' WHERE tool_id = ? AND version = ?;",
        [params.toolId, params.version],
      );

      // 5. Upsert installation record in table installations
      this.conn.run(
        `INSERT INTO installations (
          installation_id, workspace_id, tool_id, tool_version, deployment_id,
          installed_at, state, config_overrides_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          tool_version = excluded.tool_version,
          deployment_id = excluded.deployment_id,
          installed_at = excluded.installed_at,
          state = 'active',
          updated_at = excluded.updated_at;`,
        [
          `inst_${params.workspaceId}_${params.toolId}`,
          params.workspaceId,
          params.toolId,
          params.version,
          deploymentId,
          timestamp,
          timestamp,
          timestamp,
        ],
      );

      // 6. Update workspace active tools mapping
      activeTools[params.toolId] = params.version;
      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );

      // 7. Generate and save new CatalogSnapshot
      const toolSummaries: Record<string, CatalogToolSummary> = {};

      for (const [tId, tVer] of Object.entries(activeTools)) {
        const manifestRow = this.conn.get<{
          scope: string;
          digest: string;
        }>("SELECT scope, digest FROM tool_manifests WHERE tool_id = ?;", [tId]);

        toolSummaries[tId] = {
          toolId: tId,
          version: tVer,
          manifestDigest:
            manifestRow?.digest ??
            crypto.createHash("sha256").update(`${tId}@${tVer}`).digest("hex"),
          // SAFETY: Manifest scope column matches tool scope union.
          scope: (manifestRow?.scope as "workspace" | "user" | "global" | "session") ?? "workspace",
          status: "active",
        };
      }

      // Determine next revision number
      const latestSnap = this.conn.get<{
        snapshot_id: string;
      }>(
        "SELECT snapshot_id FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC, snapshot_id DESC LIMIT 1;",
        [params.workspaceId],
      );

      let nextRev = 1;
      if (latestSnap) {
        const match = latestSnap.snapshot_id.match(/_rev(\d+)$/);
        if (match) {
          nextRev = Number.parseInt(match[1], 10) + 1;
        }
      }
      revisionResult = nextRev;

      const snapshotDigest = hashCanonicalContent({
        workspaceId: params.workspaceId,
        tools: toolSummaries,
      });

      const snapshotId = `snap_${params.workspaceId}_rev${nextRev}`;
      snapshotResult = {
        snapshotId,
        workspaceId: params.workspaceId,
        timestamp,
        tools: toolSummaries,
        digest: snapshotDigest,
      };

      this.conn.run(
        `INSERT INTO catalog_snapshots (
          snapshot_id, workspace_id, timestamp, tools_json, digest
        ) VALUES (?, ?, ?, ?, ?);`,
        [snapshotId, params.workspaceId, timestamp, canonicalJson(toolSummaries), snapshotDigest],
      );
    });

    if (!snapshotResult || !deploymentIdResult) {
      throw new Error("Failed to activate deployment in transaction");
    }

    // Emit catalog change event after successful transaction commit
    const event: CatalogChangeEvent = {
      workspaceId: params.workspaceId,
      revision: revisionResult,
      snapshot: snapshotResult,
      changedToolIds: [params.toolId],
      timestamp,
    };
    this.emitCatalogChange(event);

    return {
      success: true,
      deploymentId: deploymentIdResult,
      isCanary,
      trafficPercentage: trafficPct,
      activeTrafficPercentage: trafficPct,
      state: isCanary ? "canary" : "active",
      revision: revisionResult,
      snapshot: snapshotResult,
      appliedAt: timestamp,
      previousVersion: previousActiveVersion,
    };
  }

  /**
   * Atomically rolls back a deployment in a single SQLite transaction.
   */
  async rollback(params: RollbackDeploymentParams): Promise<RollbackResult> {
    const timestamp = new Date().toISOString();
    const actor = params.actor ?? this.defaultActor;

    let snapshotResult: CatalogSnapshot | null = null;
    let rolledBackVersion = "";
    let restoredVersion: string | undefined;
    let deploymentIdResult = "";
    let revisionResult = 1;

    await this.conn.transaction(async () => {
      const wsRow = this.conn.get<{
        active_tools_json: string;
      }>("SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;", [params.workspaceId]);

      const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
      rolledBackVersion = activeTools[params.toolId] ?? "";

      // Read current deployment record
      const depRow = this.conn.get<{
        deployment_id: string;
        state: string;
        history_json: string;
      }>(
        "SELECT deployment_id, state, history_json FROM deployment_records WHERE workspace_id = ? AND tool_id = ? ORDER BY created_at DESC LIMIT 1;",
        [params.workspaceId, params.toolId],
      );

      const deploymentId = depRow?.deployment_id ?? `dep_${crypto.randomUUID()}`;
      deploymentIdResult = deploymentId;
      const history: DeploymentTransition[] = JSON.parse(depRow?.history_json || "[]");

      // Record rolling_back and rolled_back transition
      history.push({
        toState: "rolled_back",
        // SAFETY: Deployment state column matches DeploymentState union.
        fromState: (depRow?.state as DeploymentState) ?? "promoted",
        timestamp,
        reason: "manual_rollback",
        actor,
        message: params.reason ?? `Rolled back tool ${params.toolId}`,
        metadata: {},
      });

      this.conn.run(
        `UPDATE deployment_records SET
          state = 'rolled_back',
          history_json = ?,
          active_traffic_percentage = 0,
          updated_at = ?
        WHERE deployment_id = ?;`,
        [canonicalJson(history), timestamp, deploymentId],
      );

      // Determine rollback target version
      if (params.targetVersion) {
        restoredVersion = params.targetVersion;
      } else if (params.targetSnapshotId) {
        const snapRow = this.conn.get<{
          tools_json: string;
        }>("SELECT tools_json FROM catalog_snapshots WHERE snapshot_id = ?;", [
          params.targetSnapshotId,
        ]);
        if (snapRow) {
          const snapTools: Record<string, CatalogToolSummary> = JSON.parse(snapRow.tools_json);
          restoredVersion = snapTools[params.toolId]?.version;
        }
      } else {
        // 1. Look back in historical catalog_snapshots
        const snapRows = this.conn.all<{
          tools_json: string;
        }>(
          "SELECT tools_json FROM catalog_snapshots WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 10;",
          [params.workspaceId],
        );

        for (const sRow of snapRows) {
          try {
            const sTools: Record<string, CatalogToolSummary> = JSON.parse(sRow.tools_json);
            const candVer = sTools[params.toolId]?.version;
            if (candVer && candVer !== rolledBackVersion) {
              restoredVersion = candVer;
              break;
            }
          } catch {
            // Ignore parse error
          }
        }

        // 2. Fallback to deployment_records
        if (!restoredVersion) {
          const prevDepRow = this.conn.get<{
            tool_version: string;
          }>(
            "SELECT tool_version FROM deployment_records WHERE workspace_id = ? AND tool_id = ? AND tool_version != ? ORDER BY rowid DESC LIMIT 1;",
            [params.workspaceId, params.toolId, rolledBackVersion],
          );
          restoredVersion = prevDepRow?.tool_version;
        }
      }

      if (restoredVersion) {
        activeTools[params.toolId] = restoredVersion;
        this.conn.run(
          "UPDATE installations SET tool_version = ?, state = 'active', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
          [restoredVersion, timestamp, params.workspaceId, params.toolId],
        );
      } else {
        delete activeTools[params.toolId];
        this.conn.run(
          "UPDATE installations SET state = 'uninstalled', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
          [timestamp, params.workspaceId, params.toolId],
        );
      }

      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );
      // If quarantine requested, quarantine candidate version
      if (params.quarantineCandidate && (params.candidateVersion || rolledBackVersion)) {
        const cVer = params.candidateVersion ?? rolledBackVersion;
        const qReason = params.quarantineReason ?? "auto_rollback_breach";
        if (this.quarantineManager) {
          try {
            void this.quarantineManager.quarantineArtifact({
              toolId: params.toolId,
              version: cVer,
              // SAFETY: qReason maps directly to recognized quarantine reason code.
              reason: qReason as string,
              errorMessage: params.reason ?? "Candidate rolled back and quarantined",
            });
          } catch {
            // Suppress
          }
        }
        try {
          this.conn.run(
            `INSERT INTO quarantined_artifacts (
              quarantine_id, tool_id, tool_version, reason, error_message, quarantined_at
            ) VALUES (?, ?, ?, ?, ?, ?);`,
            [
              `quar_${crypto.randomUUID()}`,
              params.toolId,
              cVer,
              qReason,
              params.reason ?? "Candidate rolled back and quarantined",
              timestamp,
            ],
          );
        } catch {
          // Suppress
        }
      }

      // Generate new CatalogSnapshot
      const toolSummaries: Record<string, CatalogToolSummary> = {};
      for (const [tId, tVer] of Object.entries(activeTools)) {
        const manifestRow = this.conn.get<{
          scope: string;
          digest: string;
        }>("SELECT scope, digest FROM tool_manifests WHERE tool_id = ?;", [tId]);

        toolSummaries[tId] = {
          toolId: tId,
          version: tVer,
          manifestDigest:
            manifestRow?.digest ??
            crypto.createHash("sha256").update(`${tId}@${tVer}`).digest("hex"),
          // SAFETY: Manifest scope column matches tool scope union.
          scope: (manifestRow?.scope as "workspace" | "user" | "global" | "session") ?? "workspace",
          status: "active",
        };
      }

      const latestSnap = this.conn.get<{
        snapshot_id: string;
      }>(
        "SELECT snapshot_id FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC, snapshot_id DESC LIMIT 1;",
        [params.workspaceId],
      );

      let nextRev = 1;
      if (latestSnap) {
        const match = latestSnap.snapshot_id.match(/_rev(\d+)$/);
        if (match) {
          nextRev = Number.parseInt(match[1], 10) + 1;
        }
      }
      revisionResult = nextRev;

      const snapshotDigest = hashCanonicalContent({
        workspaceId: params.workspaceId,
        tools: toolSummaries,
      });

      const snapshotId = `snap_${params.workspaceId}_rev${nextRev}`;
      snapshotResult = {
        snapshotId,
        workspaceId: params.workspaceId,
        timestamp,
        tools: toolSummaries,
        digest: snapshotDigest,
      };

      this.conn.run(
        `INSERT INTO catalog_snapshots (
          snapshot_id, workspace_id, timestamp, tools_json, digest
        ) VALUES (?, ?, ?, ?, ?);`,
        [snapshotId, params.workspaceId, timestamp, canonicalJson(toolSummaries), snapshotDigest],
      );
    });

    if (!snapshotResult) {
      throw new Error("Failed to rollback deployment in transaction");
    }

    const event: CatalogChangeEvent = {
      workspaceId: params.workspaceId,
      revision: revisionResult,
      snapshot: snapshotResult,
      changedToolIds: [params.toolId],
      timestamp,
    };
    this.emitCatalogChange(event);

    return {
      success: true,
      deploymentId: deploymentIdResult,
      toolId: params.toolId,
      rolledBackVersion,
      restoredVersion,
      state: "rolled_back",
      revision: revisionResult,
      snapshot: snapshotResult,
      appliedAt: timestamp,
    };
  }

  /**
   * Suspends an active deployment.
   */
  async suspend(
    params: SuspendDeploymentParams,
  ): Promise<{ success: boolean; snapshot: CatalogSnapshot }> {
    const timestamp = new Date().toISOString();
    let snapshotResult: CatalogSnapshot | null = null;
    let revisionResult = 1;

    await this.conn.transaction(async () => {
      const wsRow = this.conn.get<{
        active_tools_json: string;
      }>("SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;", [params.workspaceId]);

      const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
      delete activeTools[params.toolId];

      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );

      this.conn.run(
        "UPDATE deployment_records SET state = 'suspended', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );

      this.conn.run(
        "UPDATE installations SET state = 'inactive', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );

      // Generate new CatalogSnapshot
      const toolSummaries: Record<string, CatalogToolSummary> = {};
      for (const [tId, tVer] of Object.entries(activeTools)) {
        const manifestRow = this.conn.get<{
          scope: string;
          digest: string;
        }>("SELECT scope, digest FROM tool_manifests WHERE tool_id = ?;", [tId]);

        toolSummaries[tId] = {
          toolId: tId,
          version: tVer,
          manifestDigest:
            manifestRow?.digest ??
            crypto.createHash("sha256").update(`${tId}@${tVer}`).digest("hex"),
          // SAFETY: Manifest scope column matches tool scope union.
          scope: (manifestRow?.scope as "workspace" | "user" | "global" | "session") ?? "workspace",
          status: "active",
        };
      }
      const latestSnap = this.conn.get<{
        snapshot_id: string;
      }>(
        "SELECT snapshot_id FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC, snapshot_id DESC LIMIT 1;",
        [params.workspaceId],
      );

      let nextRev = 1;
      if (latestSnap) {
        const match = latestSnap.snapshot_id.match(/_rev(\d+)$/);
        if (match) nextRev = Number.parseInt(match[1], 10) + 1;
      }
      revisionResult = nextRev;

      const snapshotDigest = hashCanonicalContent({
        workspaceId: params.workspaceId,
        tools: toolSummaries,
      });

      const snapshotId = `snap_${params.workspaceId}_rev${nextRev}`;
      snapshotResult = {
        snapshotId,
        workspaceId: params.workspaceId,
        timestamp,
        tools: toolSummaries,
        digest: snapshotDigest,
      };

      this.conn.run(
        "INSERT INTO catalog_snapshots (snapshot_id, workspace_id, timestamp, tools_json, digest) VALUES (?, ?, ?, ?, ?);",
        [snapshotId, params.workspaceId, timestamp, canonicalJson(toolSummaries), snapshotDigest],
      );
    });

    if (!snapshotResult) {
      throw new Error("Failed to suspend deployment");
    }

    const event: CatalogChangeEvent = {
      workspaceId: params.workspaceId,
      revision: revisionResult,
      snapshot: snapshotResult,
      changedToolIds: [params.toolId],
      timestamp,
    };
    this.emitCatalogChange(event);

    return { success: true, snapshot: snapshotResult };
  }

  /**
   * Resumes a suspended deployment.
   */
  async resume(params: ResumeDeploymentParams): Promise<ActivationResult> {
    // Find version for tool
    let version = params.version;
    if (!version) {
      const depRow = this.conn.get<{
        tool_version: string;
      }>(
        "SELECT tool_version FROM deployment_records WHERE workspace_id = ? AND tool_id = ? ORDER BY created_at DESC LIMIT 1;",
        [params.workspaceId, params.toolId],
      );
      version = depRow?.tool_version;
    }

    if (!version) {
      throw new Error(`No deployment record found to resume for tool '${params.toolId}'`);
    }

    return this.activate({
      workspaceId: params.workspaceId,
      toolId: params.toolId,
      version,
      reason: params.reason ?? "Resumed deployment",
      actor: params.actor,
    });
  }

  /**
   * Retires a deployment.
   */
  async retire(params: RetireDeploymentParams): Promise<{ success: boolean }> {
    const timestamp = new Date().toISOString();

    await this.conn.transaction(async () => {
      const wsRow = this.conn.get<{
        active_tools_json: string;
      }>("SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;", [params.workspaceId]);

      const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
      delete activeTools[params.toolId];

      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );

      this.conn.run(
        "UPDATE deployment_records SET state = 'retired', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );

      this.conn.run("UPDATE tool_versions SET status = 'revoked' WHERE tool_id = ?;", [
        params.toolId,
      ]);

      this.conn.run(
        "UPDATE installations SET state = 'uninstalled', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );
    });

    return { success: true };
  }
}
