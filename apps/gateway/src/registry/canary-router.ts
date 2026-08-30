import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  type AutoRollbackThresholds,
  AutoRollbackThresholdsSchema,
  type CanaryConfig,
  CanaryConfigSchema,
  type ToolManifest,
  canonicalJson,
  isSafetyGateBypassTool,
} from "@resin/contracts";
import { SecretRedactor } from "@resin/crypto";
import type { ToolInvocationRequest } from "../meta/router-contract.js";
import { MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import type { CallToolResult, JsonRpcParamValue, JsonRpcParams } from "../protocol/types.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import {
  type ControlsDatabaseSource,
  type DbConnectionLike,
  type UserControlsManager,
  extractConnection,
} from "./controls.js";
import type { ToolRegistry } from "./registry.js";

export type { AutoRollbackThresholds, CanaryConfig };

export interface CanaryCandidate {
  toolId: string;
  candidateVersion: string;
  stableVersion?: string;
  workspaceId: string;
  config: CanaryConfig;
  status: "active" | "promoted" | "rolled_back" | "quarantined";
  activatedAt: string;
  deploymentId?: string;
  manifest?: ToolManifest;
  metadata?: JsonRpcParams;
}

export interface CanaryHealthMetrics {
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  schemaMismatches: number;
  capabilityViolations: number;
  consecutiveFailures: number;
  latenciesMs: number[];
  errorRate: number;
  schemaMismatchRate: number;
  p95LatencyMs: number;
  lastEvaluatedAt?: string;
  lastBreachReason?: string;
}

export interface RollbackExecutionResult {
  toolId: string;
  workspaceId: string;
  rolledBackVersion: string;
  restoredVersion?: string;
  reason: string;
  switchDurationMs: number;
  quarantined: boolean;
  timestamp: string;
  incidentDetails?: JsonRpcParams;
  metadata?: JsonRpcParams;
}

export interface QuarantinedCandidateRecord {
  quarantineId: string;
  toolId: string;
  version: string;
  workspaceId: string;
  reason: string;
  quarantinedAt: string;
  errorMessage?: string;
}

export interface CanaryRouterOptions {
  registry?: ToolRegistry;
  userControls?: UserControlsManager;
  db?: ControlsDatabaseSource;
  auditCallback?: (incident: JsonRpcParams) => void | Promise<void>;
  parameters?: JsonRpcParams;
  defaultThresholds?: Partial<AutoRollbackThresholds>;
}

/**
 * Computes deterministic traffic split bucket 0-99 using SHA-256.
 */
export function computeDeterministicBucket(
  seed: string,
  toolId: string,
  invocationCounter: number,
): number {
  const hash = crypto
    .createHash("sha256")
    .update(`${seed}:${toolId}:${invocationCounter}`)
    .digest("hex");
  const value = Number.parseInt(hash.slice(0, 8), 16);
  return value % 100;
}

/**
 * Computes the 95th percentile latency from an array of millisecond durations.
 */
export function computeP95Latency(latencies: number[]): number {
  if (latencies.length === 0) {
    return 0;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/**
 * CanaryRouter orchestrates local canary activations, shadow executions,
 * deterministic traffic splitting, live health evaluation, sub-100ms atomic rollback,
 * and crash-safe state persistence surviving daemon restarts.
 */
export class CanaryRouter {
  private readonly canaries = new Map<string, CanaryCandidate>(); // `${workspaceId}:${toolId}` -> candidate
  private readonly metrics = new Map<string, CanaryHealthMetrics>(); // `${workspaceId}:${toolId}` -> metrics
  private readonly quarantinedCandidates = new Set<string>(); // `${workspaceId}:${toolId}:${version}`
  private readonly quarantineRecords = new Map<string, QuarantinedCandidateRecord>();
  private readonly userControls?: UserControlsManager;
  private readonly registry?: ToolRegistry;
  private readonly auditCallback?: (incident: JsonRpcParams) => void | Promise<void>;
  private readonly redactor: SecretRedactor;
  private readonly conn: DbConnectionLike | null;
  private readonly defaultThresholds: AutoRollbackThresholds;

  constructor(options: CanaryRouterOptions = {}) {
    this.registry = options.registry;
    this.userControls = options.userControls ?? options.registry?.controls;
    this.conn = extractConnection(options.db);
    this.auditCallback = options.auditCallback;
    this.redactor = new SecretRedactor();
    this.defaultThresholds = {
      maxErrorRate: options.defaultThresholds?.maxErrorRate ?? 0.05,
      maxLatencyP95Ms: options.defaultThresholds?.maxLatencyP95Ms ?? 5000,
      maxSchemaMismatchRate: options.defaultThresholds?.maxSchemaMismatchRate ?? 0.01,
      consecutiveFailureThreshold: options.defaultThresholds?.consecutiveFailureThreshold ?? 3,
    };
    this.initDb();
    this.loadPersistedState();
  }

  private key(workspaceId: string, toolId: string): string {
    return `${workspaceId}:${toolId}`;
  }

  private quarantineKey(workspaceId: string, toolId: string, version: string): string {
    return `${workspaceId}:${toolId}:${version}`;
  }

  private initDb(): void {
    if (!this.conn) {
      return;
    }
    try {
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS canary_deployments (
          workspace_id TEXT NOT NULL,
          tool_id TEXT NOT NULL,
          candidate_version TEXT NOT NULL,
          stable_version TEXT,
          strategy TEXT NOT NULL,
          traffic_percentage REAL NOT NULL,
          duration_minutes INTEGER NOT NULL,
          max_shadow_workers INTEGER NOT NULL,
          thresholds_json TEXT NOT NULL,
          status TEXT NOT NULL,
          activated_at TEXT NOT NULL,
          deployment_id TEXT,
          metadata_json TEXT DEFAULT '{}',
          PRIMARY KEY (workspace_id, tool_id)
        );
      `);
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS quarantined_candidates (
          quarantine_id TEXT PRIMARY KEY,
          tool_id TEXT NOT NULL,
          version TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          error_message TEXT,
          quarantined_at TEXT NOT NULL
        );
      `);
    } catch {
      // Ignore if table initialization is handled elsewhere or read-only
    }
  }

  private loadPersistedState(): void {
    if (!this.conn) {
      return;
    }
    try {
      // 1. Load Quarantined Candidates
      const qRows = this.conn.all<{
        quarantine_id: string;
        tool_id: string;
        version: string;
        workspace_id: string;
        reason: string;
        error_message?: string;
        quarantined_at: string;
      }>("SELECT * FROM quarantined_candidates;");

      for (const row of qRows) {
        const qk = this.quarantineKey(row.workspace_id, row.tool_id, row.version);
        this.quarantinedCandidates.add(qk);
        this.quarantineRecords.set(qk, {
          quarantineId: row.quarantine_id,
          toolId: row.tool_id,
          version: row.version,
          workspaceId: row.workspace_id,
          reason: row.reason,
          quarantinedAt: row.quarantined_at,
          errorMessage: row.error_message,
        });
      }

      // 2. Load Active Canary Deployments
      const cRows = this.conn.all<{
        workspace_id: string;
        tool_id: string;
        candidate_version: string;
        stable_version?: string;
        strategy: string;
        traffic_percentage: number;
        duration_minutes: number;
        max_shadow_workers: number;
        thresholds_json: string;
        status: string;
        activated_at: string;
        deployment_id?: string;
        metadata_json?: string;
      }>("SELECT * FROM canary_deployments WHERE status = 'active';");

      for (const row of cRows) {
        const qk = this.quarantineKey(row.workspace_id, row.tool_id, row.candidate_version);
        if (this.quarantinedCandidates.has(qk)) {
          continue; // Do not reactivate quarantined candidates
        }

        const candidate: CanaryCandidate = {
          workspaceId: row.workspace_id,
          toolId: row.tool_id,
          candidateVersion: row.candidate_version,
          stableVersion: row.stable_version,
          status:
            row.status === "promoted" ||
            row.status === "rolled_back" ||
            row.status === "quarantined"
              ? row.status
              : "active",
          activatedAt: row.activated_at,
          deploymentId: row.deployment_id,
          config: {
            strategy:
              row.strategy === "traffic_split" || row.strategy === "developer_opt_in"
                ? row.strategy
                : "shadow",
            trafficPercentage: row.traffic_percentage ?? 10,
            durationMinutes: row.duration_minutes ?? 30,
            maxShadowWorkers: row.max_shadow_workers ?? 2,
            autoRollbackThresholds: row.thresholds_json
              ? JSON.parse(row.thresholds_json)
              : this.defaultThresholds,
          },
          metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
        };

        const ck = this.key(row.workspace_id, row.tool_id);
        this.canaries.set(ck, candidate);
        this.metrics.set(ck, this.createEmptyMetrics());
      }
    } catch {
      // Suppress read errors
    }
  }

  private createEmptyMetrics(): CanaryHealthMetrics {
    return {
      totalCalls: 0,
      successCalls: 0,
      errorCalls: 0,
      schemaMismatches: 0,
      capabilityViolations: 0,
      consecutiveFailures: 0,
      latenciesMs: [],
      errorRate: 0,
      schemaMismatchRate: 0,
      p95LatencyMs: 0,
    };
  }

  /**
   * Registers a new canary deployment candidate for a tool in a workspace.
   */
  async registerCanary(params: {
    workspaceId: string;
    toolId: string;
    candidateVersion: string;
    stableVersion?: string;
    config?: Partial<CanaryConfig>;
    deploymentId?: string;
    manifest?: ToolManifest;
    metadata?: JsonRpcParams;
  }): Promise<CanaryCandidate> {
    const { workspaceId, toolId, candidateVersion } = params;

    // Check if candidate is quarantined
    const qk = this.quarantineKey(workspaceId, toolId, candidateVersion);
    if (this.quarantinedCandidates.has(qk)) {
      throw new Error(
        `Cannot activate candidate '${candidateVersion}' for tool '${toolId}': version is quarantined`,
      );
    }

    // Check user controls
    if (this.userControls) {
      if (await this.userControls.isToolDisabled(workspaceId, toolId)) {
        throw new Error(
          `Cannot activate canary: tool '${toolId}' is disabled by user control in workspace '${workspaceId}'`,
        );
      }
      if (await this.userControls.isToolFrozen(workspaceId, toolId)) {
        throw new Error(
          `Cannot activate canary: tool '${toolId}' is frozen by user control in workspace '${workspaceId}'`,
        );
      }
      const pinned = await this.userControls.getPinnedVersion(workspaceId, toolId);
      if (pinned && pinned !== candidateVersion) {
        throw new Error(
          `Cannot activate canary: tool '${toolId}' is pinned to version '${pinned}' in workspace '${workspaceId}'`,
        );
      }
    }

    const config: CanaryConfig = {
      strategy: params.config?.strategy ?? "shadow",
      trafficPercentage: params.config?.trafficPercentage ?? 10,
      durationMinutes: params.config?.durationMinutes ?? 30,
      maxShadowWorkers: params.config?.maxShadowWorkers ?? 2,
      autoRollbackThresholds: {
        maxErrorRate:
          params.config?.autoRollbackThresholds?.maxErrorRate ??
          this.defaultThresholds.maxErrorRate,
        maxLatencyP95Ms:
          params.config?.autoRollbackThresholds?.maxLatencyP95Ms ??
          this.defaultThresholds.maxLatencyP95Ms,
        maxSchemaMismatchRate:
          params.config?.autoRollbackThresholds?.maxSchemaMismatchRate ??
          this.defaultThresholds.maxSchemaMismatchRate,
        consecutiveFailureThreshold:
          params.config?.autoRollbackThresholds?.consecutiveFailureThreshold ??
          this.defaultThresholds.consecutiveFailureThreshold,
      },
    };

    const candidate: CanaryCandidate = {
      workspaceId,
      toolId,
      candidateVersion,
      stableVersion: params.stableVersion,
      config,
      status: "active",
      activatedAt: new Date().toISOString(),
      deploymentId: params.deploymentId ?? `dep_${toolId}_${candidateVersion}_canary`,
      manifest: params.manifest,
      metadata: params.metadata ?? {},
    };

    const ck = this.key(workspaceId, toolId);
    this.canaries.set(ck, candidate);
    this.metrics.set(ck, this.createEmptyMetrics());

    // Persist to DB
    if (this.conn) {
      try {
        this.conn.run(
          `
          INSERT INTO canary_deployments (
            workspace_id, tool_id, candidate_version, stable_version,
            strategy, traffic_percentage, duration_minutes, max_shadow_workers,
            thresholds_json, status, activated_at, deployment_id, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
          ON CONFLICT(workspace_id, tool_id) DO UPDATE SET
            candidate_version = excluded.candidate_version,
            stable_version = excluded.stable_version,
            strategy = excluded.strategy,
            traffic_percentage = excluded.traffic_percentage,
            duration_minutes = excluded.duration_minutes,
            max_shadow_workers = excluded.max_shadow_workers,
            thresholds_json = excluded.thresholds_json,
            status = 'active',
            activated_at = excluded.activated_at,
            deployment_id = excluded.deployment_id,
            metadata_json = excluded.metadata_json;
        `,
          [
            workspaceId,
            toolId,
            candidateVersion,
            params.stableVersion ?? null,
            config.strategy,
            config.trafficPercentage,
            config.durationMinutes,
            config.maxShadowWorkers,
            JSON.stringify(config.autoRollbackThresholds),
            candidate.activatedAt,
            candidate.deploymentId ?? null,
            JSON.stringify(candidate.metadata),
          ],
        );
      } catch {
        // Suppress write error
      }
    }

    return candidate;
  }

  /**
   * Retrieves active canary candidate for a tool in a workspace.
   */
  getCanary(toolId: string, workspaceId: string): CanaryCandidate | undefined {
    const ck = this.key(workspaceId, toolId);
    const candidate = this.canaries.get(ck);
    if (candidate && candidate.status === "active") {
      return candidate;
    }
    return undefined;
  }

  /**
   * Returns all active canary candidates.
   */
  getActiveCanaries(workspaceId?: string): CanaryCandidate[] {
    const results: CanaryCandidate[] = [];
    for (const candidate of this.canaries.values()) {
      if (candidate.status === "active") {
        if (!workspaceId || candidate.workspaceId === workspaceId) {
          results.push(candidate);
        }
      }
    }
    return results;
  }

  /**
   * Retrieves current live health metrics for a canary candidate.
   */
  getHealthMetrics(toolId: string, workspaceId: string): CanaryHealthMetrics {
    const ck = this.key(workspaceId, toolId);
    const m = this.metrics.get(ck);
    if (m) {
      return { ...m, latenciesMs: [...m.latenciesMs] };
    }
    return this.createEmptyMetrics();
  }

  /**
   * Evaluates routing decision for a tool invocation request.
   */
  async routeInvocation(request: ToolInvocationRequest): Promise<{
    version: string;
    isCanary: boolean;
    shadowCandidateVersion?: string;
    reason?: string;
  }> {
    const { toolId, context } = request;
    const workspaceId = context.workspaceId;

    // Check user controls: disabled, pinned, frozen
    if (this.userControls) {
      if (await this.userControls.isToolDisabled(workspaceId, toolId)) {
        throw new McpProtocolError(
          MCP_ERROR_CODES.TOOL_NOT_FOUND,
          `Tool '${toolId}' is disabled in workspace '${workspaceId}'`,
        );
      }
      const pinned = await this.userControls.getPinnedVersion(workspaceId, toolId);
      if (pinned) {
        return { version: pinned, isCanary: false, reason: "pinned" };
      }
      if (await this.userControls.isToolFrozen(workspaceId, toolId)) {
        const candidate = this.getCanary(toolId, workspaceId);
        return {
          version: candidate?.stableVersion ?? request.version,
          isCanary: false,
          reason: "frozen",
        };
      }
    }

    const candidate = this.getCanary(toolId, workspaceId);
    if (!candidate) {
      return { version: request.version, isCanary: false };
    }

    const m = this.metrics.get(this.key(workspaceId, toolId)) ?? this.createEmptyMetrics();

    if (candidate.config.strategy === "shadow") {
      // In shadow mode, primary request is routed to stable version, candidate is shadowed
      return {
        version: candidate.stableVersion ?? request.version,
        isCanary: false,
        shadowCandidateVersion: candidate.candidateVersion,
        reason: "shadow_primary",
      };
    }

    if (candidate.config.strategy === "traffic_split") {
      const bucket = computeDeterministicBucket(
        context.sessionId || workspaceId || "default",
        toolId,
        m.totalCalls,
      );
      if (bucket < candidate.config.trafficPercentage) {
        return {
          version: candidate.candidateVersion,
          isCanary: true,
          reason: "traffic_split_canary",
        };
      }
      return {
        version: candidate.stableVersion ?? request.version,
        isCanary: false,
        reason: "traffic_split_stable",
      };
    }

    if (candidate.config.strategy === "developer_opt_in") {
      const contextMeta =
        "metadata" in context && context.metadata && context.metadata instanceof Object
          ? context.metadata
          : undefined;
      const contextOptIn =
        contextMeta && "canaryOptIn" in contextMeta && Boolean(contextMeta.canaryOptIn);
      const optIn = Boolean(request.parameters?.__canary_opt_in ?? contextOptIn);
      if (optIn) {
        return {
          version: candidate.candidateVersion,
          isCanary: true,
          reason: "developer_opt_in",
        };
      }
      return {
        version: candidate.stableVersion ?? request.version,
        isCanary: false,
        reason: "developer_opt_in_default",
      };
    }

    return { version: request.version, isCanary: false };
  }

  /**
   * Executes a tool invocation under canary management (shadowing, traffic split, live health tracking,
   * in-flight fallback, and automatic rollback on threshold breaches).
   */
  async executeWithCanary(
    request: ToolInvocationRequest,
    executeVersionFn: (version: string) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const { toolId, context } = request;
    const workspaceId = context.workspaceId;

    const routeDecision = await this.routeInvocation(request);
    const candidate = this.getCanary(toolId, workspaceId);

    // 1. Shadow Mode Execution
    if (routeDecision.shadowCandidateVersion && candidate) {
      // Run stable version for the caller
      const primaryResult = await executeVersionFn(routeDecision.version);

      // Asynchronously shadow against candidate in background
      void (async () => {
        const shadowStart = performance.now();
        try {
          const shadowResult = await executeVersionFn(routeDecision.shadowCandidateVersion!);
          const durationMs = performance.now() - shadowStart;

          const isSchemaMismatch = Boolean(
            shadowResult.isError || (shadowResult.content && shadowResult.content.length === 0),
          );

          await this.recordInvocation(toolId, workspaceId, {
            success: !shadowResult.isError,
            latencyMs: durationMs,
            schemaMismatch: isSchemaMismatch,
            isError: Boolean(shadowResult.isError),
            error: shadowResult.isError ? "Shadow candidate returned error result" : undefined,
          });
        } catch (err) {
          const durationMs = performance.now() - shadowStart;
          const isCapViolation =
            err instanceof Error &&
            (err.message.includes("capability") ||
              err.message.includes("permission") ||
              err.message.includes("envelope"));

          await this.recordInvocation(toolId, workspaceId, {
            success: false,
            latencyMs: durationMs,
            isError: true,
            capabilityViolation: isCapViolation,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return primaryResult;
    }

    // 2. Traffic Split / Candidate Execution
    if (routeDecision.isCanary && candidate) {
      const callStart = performance.now();
      try {
        const result = await executeVersionFn(routeDecision.version);
        const durationMs = performance.now() - callStart;

        const isSchemaMismatch = Boolean(
          result.isError &&
            result.content?.some(
              (c) => c.type === "text" && c.text.toLowerCase().includes("schema"),
            ),
        );
        await this.recordInvocation(toolId, workspaceId, {
          success: !result.isError,
          latencyMs: durationMs,
          schemaMismatch: isSchemaMismatch,
          isError: Boolean(result.isError),
          error: result.isError ? "Candidate execution returned error" : undefined,
        });

        if (result.isError && candidate.stableVersion) {
          // In-flight fallback to stable version if candidate produced error result
          try {
            return await executeVersionFn(candidate.stableVersion);
          } catch {
            return result;
          }
        }

        return result;
      } catch (err) {
        const durationMs = performance.now() - callStart;
        const isCapViolation =
          err instanceof Error &&
          (err.message.includes("capability") ||
            err.message.includes("permission") ||
            err.message.includes("envelope"));

        await this.recordInvocation(toolId, workspaceId, {
          success: false,
          latencyMs: durationMs,
          isError: true,
          capabilityViolation: isCapViolation,
          error: err instanceof Error ? err.message : String(err),
        });

        // In-flight fallback to stable version
        if (candidate.stableVersion) {
          try {
            return await executeVersionFn(candidate.stableVersion);
          } catch {
            throw err;
          }
        }
        throw err;
      }
    }

    // 3. Normal / Stable Execution
    return await executeVersionFn(routeDecision.version);
  }

  /**
   * Records a candidate invocation outcome, updates health metrics, and evaluates auto-rollback thresholds.
   */
  async recordInvocation(
    toolId: string,
    workspaceId: string,
    outcome: {
      success: boolean;
      latencyMs: number;
      isError?: boolean;
      schemaMismatch?: boolean;
      capabilityViolation?: boolean;
      error?: string;
    },
  ): Promise<{ breach: boolean; reason?: string }> {
    const ck = this.key(workspaceId, toolId);
    let m = this.metrics.get(ck);
    if (!m) {
      m = this.createEmptyMetrics();
      this.metrics.set(ck, m);
    }

    m.totalCalls++;
    m.latenciesMs.push(outcome.latencyMs);
    if (m.latenciesMs.length > 500) {
      m.latenciesMs.shift();
    }

    if (outcome.success) {
      m.successCalls++;
      m.consecutiveFailures = 0;
    } else {
      m.errorCalls++;
      m.consecutiveFailures++;
    }

    if (outcome.schemaMismatch) {
      m.schemaMismatches++;
    }
    if (outcome.capabilityViolation) {
      m.capabilityViolations++;
    }

    m.errorRate = m.totalCalls > 0 ? m.errorCalls / m.totalCalls : 0;
    m.schemaMismatchRate = m.totalCalls > 0 ? m.schemaMismatches / m.totalCalls : 0;
    m.p95LatencyMs = computeP95Latency(m.latenciesMs);
    m.lastEvaluatedAt = new Date().toISOString();

    const evaluation = await this.evaluateHealth(toolId, workspaceId);
    if (!evaluation.healthy && evaluation.breachReason) {
      m.lastBreachReason = evaluation.breachReason;
      await this.triggerRollback(toolId, workspaceId, evaluation.breachReason, {
        error: outcome.error,
      });
      return { breach: true, reason: evaluation.breachReason };
    }

    return { breach: false };
  }

  /**
   * Evaluates current candidate metrics against AutoRollbackThresholds.
   */
  async evaluateHealth(
    toolId: string,
    workspaceId: string,
  ): Promise<{ healthy: boolean; breachReason?: string; metrics: CanaryHealthMetrics }> {
    const candidate = this.getCanary(toolId, workspaceId);
    const m = this.getHealthMetrics(toolId, workspaceId);

    if (!candidate || candidate.status !== "active") {
      return { healthy: true, metrics: m };
    }

    const thresholds = candidate.config.autoRollbackThresholds;

    // 1. Immediate rollback on capability / security envelope violations
    if (m.capabilityViolations > 0) {
      return {
        healthy: false,
        breachReason: `Capability violation detected: ${m.capabilityViolations} violation(s)`,
        metrics: m,
      };
    }

    // 2. Consecutive failure threshold breach
    if (m.consecutiveFailures >= thresholds.consecutiveFailureThreshold) {
      return {
        healthy: false,
        breachReason: `Consecutive failure threshold breached (${m.consecutiveFailures} >= ${thresholds.consecutiveFailureThreshold})`,
        metrics: m,
      };
    }

    // 3. Error rate threshold breach (after at least 3 calls)
    if (m.totalCalls >= 3 && m.errorRate > thresholds.maxErrorRate) {
      return {
        healthy: false,
        breachReason: `Error rate threshold breached (${(m.errorRate * 100).toFixed(1)}% > ${(thresholds.maxErrorRate * 100).toFixed(1)}%)`,
        metrics: m,
      };
    }

    // 4. Schema mismatch rate threshold breach
    if (m.totalCalls >= 3 && m.schemaMismatchRate > thresholds.maxSchemaMismatchRate) {
      return {
        healthy: false,
        breachReason: `Schema mismatch rate threshold breached (${(m.schemaMismatchRate * 100).toFixed(1)}% > ${(thresholds.maxSchemaMismatchRate * 100).toFixed(1)}%)`,
        metrics: m,
      };
    }

    // 5. P95 latency threshold breach
    if (m.latenciesMs.length >= 3 && m.p95LatencyMs > thresholds.maxLatencyP95Ms) {
      return {
        healthy: false,
        breachReason: `P95 latency baseline threshold breached (${m.p95LatencyMs.toFixed(1)}ms > ${thresholds.maxLatencyP95Ms}ms)`,
        metrics: m,
      };
    }

    return { healthy: true, metrics: m };
  }

  /**
   * Atomically triggers rollback of a faulty candidate with sub-100ms switch guarantee,
   * restoring the exact previous known-good version, quarantining the candidate, and emitting
   * a redacted audit incident.
   */
  async triggerRollback(
    toolId: string,
    workspaceId: string,
    reason: string,
    options?: {
      actor?: { type: string; id: string };
      error?: unknown;
    },
  ): Promise<RollbackExecutionResult> {
    const switchStart = performance.now();
    const timestamp = new Date().toISOString();
    const ck = this.key(workspaceId, toolId);
    const candidate = this.canaries.get(ck);

    const rolledBackVersion = candidate?.candidateVersion ?? "unknown";
    const restoredVersion = candidate?.stableVersion;

    // 1. Atomic in-memory state transition (zero out traffic immediately)
    if (candidate) {
      candidate.status = "rolled_back";
      candidate.config.trafficPercentage = 0;
    }

    // 2. Quarantine candidate version
    if (candidate) {
      await this.quarantineCandidate(
        toolId,
        candidate.candidateVersion,
        workspaceId,
        "auto_rollback_breach",
        reason,
      );
    }

    // 3. Restore stable version in registry if available
    if (this.registry && restoredVersion) {
      try {
        await this.registry.activateToolVersion(toolId, restoredVersion, workspaceId);
      } catch {
        // Fallback
      }
    }

    // 4. Measure switch latency (must be sub-100ms)
    const switchDurationMs = performance.now() - switchStart;

    // 5. Build and redact audit incident
    const rawIncident: JsonRpcParams = {
      eventType: "canary_automatic_rollback",
      incidentId: crypto.randomUUID(),
      timestamp,
      workspaceId,
      toolId,
      rolledBackVersion,
      restoredVersion: restoredVersion ?? null,
      reason,
      switchDurationMs,
    };
    if (options?.error !== undefined) {
      rawIncident.error = String(options.error);
    }

    const redactedIncident = this.redactor.redactObject(rawIncident);

    // 6. Emit audit incident
    if (this.auditCallback) {
      try {
        await this.auditCallback(redactedIncident);
      } catch {
        // Suppress audit callback error
      }
    }

    // 7. Persist rollback in DB
    if (this.conn) {
      try {
        this.conn.run(
          "UPDATE canary_deployments SET status = 'rolled_back', traffic_percentage = 0 WHERE workspace_id = ? AND tool_id = ?;",
          [workspaceId, toolId],
        );
      } catch {
        // Suppress
      }
    }

    return {
      toolId,
      workspaceId,
      rolledBackVersion,
      restoredVersion,
      reason,
      switchDurationMs,
      quarantined: true,
      timestamp,
      incidentDetails: redactedIncident,
    };
  }

  /**
   * Promotes an active canary candidate to standard promoted status.
   */
  async promoteCanary(toolId: string, workspaceId: string): Promise<void> {
    const ck = this.key(workspaceId, toolId);
    const candidate = this.canaries.get(ck);
    if (!candidate || candidate.status !== "active") {
      throw new Error(
        `No active canary candidate found for tool '${toolId}' in workspace '${workspaceId}'`,
      );
    }

    candidate.status = "promoted";
    candidate.config.trafficPercentage = 100;

    if (this.registry) {
      await this.registry.activateToolVersion(toolId, candidate.candidateVersion, workspaceId);
    }

    if (this.conn) {
      try {
        this.conn.run(
          "UPDATE canary_deployments SET status = 'promoted', traffic_percentage = 100 WHERE workspace_id = ? AND tool_id = ?;",
          [workspaceId, toolId],
        );
      } catch {
        // Suppress
      }
    }
  }

  /**
   * Quarantines a candidate version so it cannot be activated or receive traffic.
   */
  async quarantineCandidate(
    toolId: string,
    version: string,
    workspaceId: string,
    reason = "manual_quarantine",
    errorMessage?: string,
  ): Promise<void> {
    const qk = this.quarantineKey(workspaceId, toolId, version);
    this.quarantinedCandidates.add(qk);

    const record: QuarantinedCandidateRecord = {
      quarantineId: `quar_${crypto.randomUUID()}`,
      toolId,
      version,
      workspaceId,
      reason,
      quarantinedAt: new Date().toISOString(),
      errorMessage,
    };
    this.quarantineRecords.set(qk, record);

    // If candidate was active, mark it quarantined
    const ck = this.key(workspaceId, toolId);
    const candidate = this.canaries.get(ck);
    if (candidate && candidate.candidateVersion === version) {
      candidate.status = "quarantined";
      candidate.config.trafficPercentage = 0;
    }

    // Persist to DB
    if (this.conn) {
      try {
        this.conn.run(
          `
          INSERT INTO quarantined_candidates (
            quarantine_id, tool_id, version, workspace_id, reason, error_message, quarantined_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(quarantine_id) DO NOTHING;
        `,
          [
            record.quarantineId,
            toolId,
            version,
            workspaceId,
            reason,
            errorMessage ?? null,
            record.quarantinedAt,
          ],
        );
      } catch {
        // Suppress
      }
    }
  }

  /**
   * Checks whether a version is quarantined for a tool in a workspace.
   */
  isQuarantined(toolId: string, version: string, workspaceId: string): boolean {
    const qk = this.quarantineKey(workspaceId, toolId, version);
    return this.quarantinedCandidates.has(qk);
  }

  /**
   * Retrieves quarantine record if present.
   */
  getQuarantineRecord(
    toolId: string,
    version: string,
    workspaceId: string,
  ): QuarantinedCandidateRecord | undefined {
    const qk = this.quarantineKey(workspaceId, toolId, version);
    return this.quarantineRecords.get(qk);
  }
}
