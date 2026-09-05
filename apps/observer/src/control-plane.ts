import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  CONTROL_PLANE_ADAPTIVE_CADENCE,
  CONTROL_PLANE_CADENCE_HEADER,
  CONTROL_PLANE_CADENCE_JITTER_RATIO,
  CONTROL_PLANE_FAST_POLL_INTERVAL_MS,
  CONTROL_PLANE_HEARTBEAT_INTERVAL_MS,
  CONTROL_PLANE_QUIET_POLL_INTERVAL_MS,
  CONTROL_PLANE_QUIET_POLL_THRESHOLD,
  type ControlPlaneAppliedField,
  type ControlPlaneDesiredState,
  type ControlPlaneDeviceReport,
  type ControlPlaneEffectiveStateResponse,
  ControlPlaneEffectiveStateResponseSchema,
  type ControlPlaneRevisionVector,
  type ControlPlaneStateResponse,
  ControlPlaneStateResponseSchema,
  PROTOCOL_VERSION,
  ProtocolError,
} from "@resin/protocol";
import { z } from "zod";
import type { CloudRequestIdentity } from "./cloud-credentials.js";
import type { CloudRuntimeModule } from "./cloud-runtime.js";
import type {
  DaemonModule,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";
import type { JsonObject } from "./normalization/redaction.js";

/** Legacy cadence until the effective-state server advertises adaptive support. */
export const DEFAULT_CONTROL_PLANE_POLL_INTERVAL_MS = CONTROL_PLANE_FAST_POLL_INTERVAL_MS;
export const DEFAULT_CONTROL_PLANE_REPORT_INTERVAL_MS = 60_000;
export const CONTROL_PLANE_DEVICE_STATE_FILE_NAME = "control-plane-device-state.json";
const MAX_CONTROL_PLANE_RESPONSE_BYTES = 512 * 1024;

export interface ControlPlaneClientOptions {
  identityProvider: (options?: { forceRefresh?: boolean }) => Promise<CloudRequestIdentity | null>;
  fetchImpl?: typeof fetch;
}

export class ControlPlaneClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ControlPlaneClientError";
  }
}

interface EffectiveFetchResult {
  state: ControlPlaneEffectiveStateResponse | null;
  etag: string | null;
  notModified: boolean;
  adaptiveCadence: boolean;
}

async function readBoundedJson(response: Response): Promise<JsonObject | null> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_CONTROL_PLANE_RESPONSE_BYTES) {
    throw new ControlPlaneClientError("Cloud control-plane response exceeded the size limit", 502);
  }
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    // SAFETY: Parsed JSON response is an object record.
    return z.record(z.unknown()).safeParse(parsed).success ? (parsed as JsonObject) : null;
  } catch {
    throw new ControlPlaneClientError("Cloud control-plane response was not valid JSON", 502);
  }
}

export class ControlPlaneClient {
  private readonly identityProvider: ControlPlaneClientOptions["identityProvider"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: ControlPlaneClientOptions) {
    this.identityProvider = options.identityProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(route: string, init: RequestInit, forceRefresh = false): Promise<Response> {
    const identity = await this.identityProvider(forceRefresh ? { forceRefresh: true } : undefined);
    if (!identity) throw new ControlPlaneClientError("Cloud credentials are unavailable");
    const response = await this.fetchImpl(`${identity.cloudUrl.replace(/\/$/, "")}${route}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${identity.accessToken}`,
        "x-account-id": identity.accountId,
        "x-workspace-id": identity.workspaceId,
        "x-device-id": identity.deviceId,
        "x-installation-id": identity.installationId,
        "x-protocol-version": PROTOCOL_VERSION,
        ...init.headers,
      },
    });
    if (!forceRefresh && (response.status === 401 || response.status === 403)) {
      await response.body?.cancel().catch(() => undefined);
      return this.request(route, init, true);
    }
    return response;
  }

  async getEffectiveState(
    deviceId: string,
    etag?: string,
    signal?: AbortSignal,
  ): Promise<EffectiveFetchResult> {
    const response = await this.request(
      `/v1/control-plane/effective?deviceId=${encodeURIComponent(deviceId)}`,
      {
        method: "GET",
        signal,
        headers: etag ? { "If-None-Match": etag } : undefined,
      },
    );
    const adaptiveCadence =
      response.headers.get(CONTROL_PLANE_CADENCE_HEADER) === CONTROL_PLANE_ADAPTIVE_CADENCE;
    if (response.status === 304) {
      await response.body?.cancel().catch(() => undefined);
      return { state: null, etag: etag ?? null, notModified: true, adaptiveCadence };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ControlPlaneClientError(
        `Cloud control-plane read failed with HTTP ${response.status}`,
        response.status,
      );
    }
    const state = ControlPlaneEffectiveStateResponseSchema.safeParse(
      await readBoundedJson(response),
    );
    if (!state.success) {
      throw new ControlPlaneClientError(
        "Cloud control-plane response failed schema validation",
        502,
      );
    }
    return {
      state: state.data,
      etag: response.headers.get("etag"),
      notModified: false,
      adaptiveCadence,
    };
  }

  async getTargetState(
    scope: "workspace" | "device",
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<ControlPlaneStateResponse> {
    const query =
      scope === "workspace"
        ? "scope=workspace"
        : `scope=device&deviceId=${encodeURIComponent(deviceId ?? "")}`;
    const response = await this.request(`/v1/control-plane/state?${query}`, {
      method: "GET",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ControlPlaneClientError(
        `Cloud control-plane read failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return ControlPlaneStateResponseSchema.parse(await readBoundedJson(response));
  }

  async report(report: ControlPlaneDeviceReport, signal?: AbortSignal): Promise<void> {
    const response = await this.request("/v1/control-plane/reports", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ControlPlaneClientError(
        `Cloud control-plane report failed with HTTP ${response.status}`,
        response.status,
      );
    }
    await response.body?.cancel().catch(() => undefined);
  }
}

export interface ControlPlaneApplyResult {
  status: ControlPlaneDeviceReport["status"];
  fields: ControlPlaneDeviceReport["fields"];
  appliedAt: string | null;
}

export interface ControlPlaneApplyAdapter {
  apply(
    desiredState: ControlPlaneDesiredState,
    revisions: ControlPlaneRevisionVector,
    revisionToken: string,
    context: ModuleContext,
  ): Promise<ControlPlaneApplyResult>;
}

export interface FileControlPlaneApplyAdapterOptions {
  reloadConfig?: () => Promise<undefined | boolean | JsonObject>;
  now?: () => Date;
}

function sameJson<L, R>(left: L, right: R): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writePrivateJsonAtomically<V>(filePath: string, value: V): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function fieldResult(
  status: ControlPlaneAppliedField["status"],
  code?: string,
  message?: string,
): ControlPlaneAppliedField {
  const res: ControlPlaneAppliedField = { status };
  if (code) res.code = code;
  if (message) res.message = message;
  return res;
}

function recordGroupFields(
  fields: ControlPlaneDeviceReport["fields"],
  prefix: "harnesses" | "tools",
  values: JsonObject | undefined,
  result: ControlPlaneAppliedField,
): void {
  for (const key of Object.keys(values ?? {})) fields[`${prefix}.${key}`] = result;
}

/**
 * Applies safe daemon configuration immediately and durably stages other explicitly
 * device-local controls for their owning runtimes. Staged fields are reported pending,
 * never falsely reported as globally applied.
 */
export class FileControlPlaneApplyAdapter implements ControlPlaneApplyAdapter {
  private readonly reloadConfig?: () => Promise<undefined | boolean | JsonObject>;
  private readonly now: () => Date;

  constructor(options: FileControlPlaneApplyAdapterOptions = {}) {
    this.reloadConfig = options.reloadConfig;
    this.now = options.now ?? (() => new Date());
  }

  async apply(
    desiredState: ControlPlaneDesiredState,
    revisions: ControlPlaneRevisionVector,
    revisionToken: string,
    context: ModuleContext,
  ): Promise<ControlPlaneApplyResult> {
    const fields: ControlPlaneDeviceReport["fields"] = {};
    let rawConfig: JsonObject = {};
    let configExisted = true;
    try {
      const raw = await fs.readFile(context.paths.configFile, "utf8");
      const parsed = JSON.parse(raw);
      const parsedObj = z.record(z.unknown()).safeParse(parsed);
      if (!parsedObj.success) {
        throw new Error("Daemon configuration must be a JSON object");
      }
      // SAFETY: Validated parsed object conforms to JsonObject.
      rawConfig = parsedObj.data as JsonObject;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Local daemon configuration is unreadable or invalid");
      }
      configExisted = false;
    }

    const nextConfig = { ...rawConfig };
    const configuration = desiredState.configuration;
    const configFieldPaths: string[] = [];
    if (configuration?.telemetryEnabled !== undefined) {
      nextConfig.telemetryEnabled = configuration.telemetryEnabled;
      configFieldPaths.push("configuration.telemetryEnabled");
      fields["configuration.telemetryEnabled"] = fieldResult("applied");
    }
    if (configuration?.logLevel !== undefined) {
      nextConfig.logLevel = configuration.logLevel;
      configFieldPaths.push("configuration.logLevel");
      fields["configuration.logLevel"] = fieldResult("applied");
    }
    if (configuration?.heartbeatIntervalMs !== undefined) {
      nextConfig.heartbeatIntervalMs = configuration.heartbeatIntervalMs;
      configFieldPaths.push("configuration.heartbeatIntervalMs");
      fields["configuration.heartbeatIntervalMs"] = fieldResult("applied");
    }

    const privacyAuthorityRequired = fieldResult(
      "unsupported",
      "PRIVACY_AUTHORITY_REQUIRED",
      "Use the authoritative Cloud privacy controls",
    );
    if (desiredState.privacy?.metadataTelemetryEnabled !== undefined) {
      fields["privacy.metadataTelemetryEnabled"] = privacyAuthorityRequired;
    }
    if (desiredState.privacy?.retentionDays !== undefined) {
      fields["privacy.retentionDays"] = privacyAuthorityRequired;
    }

    let configApplyFailed = false;
    if (!sameJson(rawConfig, nextConfig)) {
      await writePrivateJsonAtomically(context.paths.configFile, nextConfig);
      try {
        const reloadResult = await this.reloadConfig?.();
        const parsedReload = z.object({ success: z.boolean() }).safeParse(reloadResult);
        if (parsedReload.success && !parsedReload.data.success) {
          throw new Error("Daemon rejected updated configuration");
        }
      } catch {
        if (configExisted) {
          await writePrivateJsonAtomically(context.paths.configFile, rawConfig);
        } else {
          await fs.rm(context.paths.configFile, { force: true });
        }
        const failure = fieldResult(
          "error",
          "CONFIG_RELOAD_FAILED",
          "Daemon rejected updated configuration; local configuration was rolled back",
        );
        for (const fieldPath of configFieldPaths) fields[fieldPath] = failure;
        configApplyFailed = true;
      }
    }

    const pending = fieldResult(
      "pending",
      "DEVICE_RUNTIME_PENDING",
      "Persisted for the owning device runtime",
    );
    recordGroupFields(fields, "harnesses", desiredState.harnesses, pending);
    recordGroupFields(fields, "tools", desiredState.tools, pending);
    if (desiredState.updates) fields.updates = pending;
    if (desiredState.recovery) fields.recovery = pending;

    await writePrivateJsonAtomically(
      path.join(context.paths.stateDir, CONTROL_PLANE_DEVICE_STATE_FILE_NAME),
      {
        schemaVersion: 1,
        revisions,
        revisionToken,
        desiredState,
        reconciledAt: this.now().toISOString(),
      },
    );
    const hasPending = Object.values(fields).some((field) => field.status !== "applied");
    return {
      status: configApplyFailed ? "error" : hasPending ? "degraded" : "applied",
      fields,
      appliedAt: configApplyFailed ? null : this.now().toISOString(),
    };
  }
}

export interface ControlPlaneRuntimeModuleOptions {
  client: ControlPlaneClient;
  deviceId: string;
  applyAdapter: ControlPlaneApplyAdapter;
  /** Explicit intervals stay fixed (without jitter), including on adaptive servers. */
  pollIntervalMs?: number;
  reportIntervalMs?: number;
  now?: () => Date;
  random?: () => number;
}
function safeRuntimeError<E>(error: E): string {
  const message = error instanceof Error ? error.message : "Unknown control-plane failure";
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 256);
}

function isCurrentRevision(
  candidate: ControlPlaneRevisionVector,
  current: ControlPlaneRevisionVector | null,
): boolean {
  return (
    current === null ||
    (candidate.workspace >= current.workspace && candidate.device >= current.device)
  );
}

export class ControlPlaneRuntimeModule implements DaemonModule {
  readonly id = "control-plane";
  readonly name = "Cloud Desired-State Reconciliation";
  readonly dependencies = ["cloud-runtime"] as const;
  readonly critical = false;

  private readonly client: ControlPlaneClient;
  private readonly deviceId: string;
  private readonly applyAdapter: ControlPlaneApplyAdapter;
  private readonly pollIntervalMs: number | undefined;
  private readonly reportIntervalMs: number | undefined;
  private readonly now: () => Date;
  private readonly random: () => number;
  private state: ModuleLifecycleState = "uninitialized";
  private timer: NodeJS.Timeout | undefined;
  private context: ModuleContext | null = null;
  private controller: AbortController | null = null;
  private active = false;
  private adaptiveCadence = false;
  private unchangedPolls = 0;
  private nextPollAt = 0;
  private nextReportAt = Number.POSITIVE_INFINITY;
  private manualRequested = false;
  private etag: string | undefined;
  private lastRevisions: ControlPlaneRevisionVector | null = null;
  private lastRevisionToken: string | null = null;
  private lastReport: ControlPlaneDeviceReport | null = null;
  private lastReportAt = 0;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private pollError: string | null = null;
  private reportError: string | null = null;
  private cycle: Promise<void> | null = null;
  private pollCount = 0;
  private reportCount = 0;

  constructor(options: ControlPlaneRuntimeModuleOptions) {
    this.client = options.client;
    this.deviceId = options.deviceId;
    this.applyAdapter = options.applyAdapter;
    this.pollIntervalMs = options.pollIntervalMs;
    this.reportIntervalMs = options.reportIntervalMs;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(context: ModuleContext): Promise<void> {
    if (this.active) return this.cycle ?? undefined;
    // Restart cannot overlap work still settling after an external abort.
    if (this.cycle) {
      this.state = "starting";
      await this.cycle;
      if (this.state !== "starting") return;
    }
    this.state = "starting";
    this.controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, this.controller.signal])
      : this.controller.signal;
    this.context = { ...context, signal };
    this.active = !signal.aborted;
    if (!this.active) {
      this.state = "stopped";
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        this.active = false;
        this.manualRequested = false;
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.state !== "stopping") this.state = "stopped";
      },
      { once: true },
    );
    this.adaptiveCadence = false;
    this.unchangedPolls = 0;
    // A restarted module must reapply against its new context, not accept a 304.
    // Keep the successfully applied vector as a monotonicity guard.
    this.etag = undefined;
    this.lastRevisionToken = null;
    this.lastReport = null;
    this.lastReportAt = 0;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.pollError = null;
    this.reportError = null;
    this.nextPollAt = this.now().getTime();
    this.nextReportAt = Number.POSITIVE_INFINITY;
    await this.wake(true);
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    this.active = false;
    this.manualRequested = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.cycle;
    this.context = null;
    this.state = "stopped";
  }

  private pollInterval(): number {
    return (
      this.pollIntervalMs ??
      (this.adaptiveCadence && this.unchangedPolls >= CONTROL_PLANE_QUIET_POLL_THRESHOLD
        ? CONTROL_PLANE_QUIET_POLL_INTERVAL_MS
        : DEFAULT_CONTROL_PLANE_POLL_INTERVAL_MS)
    );
  }

  private reportInterval(): number {
    return (
      this.reportIntervalMs ??
      (this.adaptiveCadence
        ? CONTROL_PLANE_HEARTBEAT_INTERVAL_MS
        : DEFAULT_CONTROL_PLANE_REPORT_INTERVAL_MS)
    );
  }

  private delay(interval: number, overridden: boolean): number {
    if (!this.adaptiveCadence || overridden) return interval;
    return (
      interval * (1 + Math.max(0, Math.min(1, this.random())) * CONTROL_PLANE_CADENCE_JITTER_RATIO)
    );
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.active) return;
    const deadline = Math.min(this.nextPollAt, this.nextReportAt);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.wake(false);
      },
      Math.max(0, deadline - this.now().getTime()),
    );
    this.timer.unref();
  }

  private wake(manual: boolean): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (manual) {
      this.unchangedPolls = 0;
      this.manualRequested = true;
    }
    if (this.cycle) return this.cycle;
    clearTimeout(this.timer);
    this.timer = undefined;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.cycle = promise;
    const complete = (): void => {
      // A wake can arrive between drain settling and this continuation.
      if (this.active && this.manualRequested) {
        void this.drain().then(complete, fail);
        return;
      }
      this.cycle = null;
      this.arm();
      resolve();
    };
    const fail = (error: unknown): void => {
      // Also contain unexpected adapter/logger failures at timer-driven wakes.
      if (this.active) {
        this.unchangedPolls = 0;
        this.lastError = safeRuntimeError(error);
        this.pollError = this.lastError;
        this.state = "degraded";
        this.nextPollAt = this.now().getTime() + this.pollInterval();
        this.nextReportAt = Math.max(this.nextReportAt, this.nextPollAt);
      }
      this.cycle = null;
      this.arm();
      resolve();
    };
    void this.drain().then(complete, fail);
    return promise;
  }

  async reconcileNow(): Promise<void> {
    await this.wake(true);
  }

  private async drain(): Promise<void> {
    do {
      const manual = this.manualRequested;
      this.manualRequested = false;
      await this.reconcileOnce(manual);
    } while (this.active && this.manualRequested);
  }

  private fail(error: unknown, context: ModuleContext): void {
    if (!this.active) return;
    this.unchangedPolls = 0;
    // A heartbeat failure may shorten, but never push back, an already due poll.
    this.nextPollAt = Math.min(
      this.nextPollAt,
      this.now().getTime() + this.delay(this.pollInterval(), this.pollIntervalMs !== undefined),
    );
    this.lastError = safeRuntimeError(error);
    this.state = "degraded";
    context.logger.warn("Cloud desired-state reconciliation is degraded", {
      reason: this.lastError,
    });
  }

  private async sendReport(
    report: ControlPlaneDeviceReport,
    context: ModuleContext,
  ): Promise<void> {
    this.reportCount += 1;
    try {
      await this.client.report(report, context.signal);
    } catch (error) {
      if (this.active) this.reportError = safeRuntimeError(error);
      this.nextReportAt =
        this.lastReport && isCurrentRevision(this.lastReport.revisions, this.lastRevisions)
          ? this.now().getTime() +
            this.delay(
              this.pollIntervalMs ?? DEFAULT_CONTROL_PLANE_POLL_INTERVAL_MS,
              this.pollIntervalMs !== undefined,
            )
          : Number.POSITIVE_INFINITY;
      throw error;
    }
    if (!this.active) return;
    this.reportError = null;
    this.lastReport = report;
    this.lastReportAt = this.now().getTime();
    this.nextReportAt =
      this.lastReportAt + this.delay(this.reportInterval(), this.reportIntervalMs !== undefined);
  }

  private async poll(context: ModuleContext, manual: boolean): Promise<void> {
    this.pollCount += 1;
    let reporting = false;
    try {
      const fetched = await this.client.getEffectiveState(this.deviceId, this.etag, context.signal);
      if (!this.active) return;
      if (this.adaptiveCadence !== fetched.adaptiveCadence) {
        this.adaptiveCadence = fetched.adaptiveCadence;
        this.unchangedPolls = 0;
        if (this.lastReport) {
          this.nextReportAt =
            this.lastReportAt +
            this.delay(this.reportInterval(), this.reportIntervalMs !== undefined);
        }
      }
      const staleReply =
        fetched.state !== null && !isCurrentRevision(fetched.state.revisions, this.lastRevisions);
      const changed =
        fetched.state && !staleReply && fetched.state.revisionToken !== this.lastRevisionToken;
      if (changed && fetched.state) {
        this.unchangedPolls = 0;
        const applied = await this.applyAdapter.apply(
          fetched.state.desiredState,
          fetched.state.revisions,
          fetched.state.revisionToken,
          context,
        );
        if (!this.active) return;
        const report: ControlPlaneDeviceReport = {
          deviceId: this.deviceId,
          revisions: fetched.state.revisions,
          revisionToken: fetched.state.revisionToken,
          status: applied.status,
          fields: applied.fields,
          observedAt: this.now().toISOString(),
          appliedAt: applied.appliedAt,
        };
        if (applied.status !== "error") this.lastRevisions = fetched.state.revisions;
        this.pollError = applied.status === "error" ? "Cloud desired state was not applied" : null;
        reporting = true;
        await this.sendReport(report, context);
        reporting = false;
        if (!this.active) return;
        if (applied.status === "error") throw new Error("Cloud desired state was not applied");
        this.lastRevisionToken = fetched.state.revisionToken;
      } else if (
        !manual &&
        !staleReply &&
        this.lastRevisionToken !== null &&
        this.lastReport?.revisionToken === this.lastRevisionToken &&
        isCurrentRevision(this.lastReport.revisions, this.lastRevisions)
      ) {
        this.unchangedPolls = Math.min(this.unchangedPolls + 1, CONTROL_PLANE_QUIET_POLL_THRESHOLD);
      } else {
        this.unchangedPolls = 0;
      }
      if (!staleReply && fetched.etag) this.etag = fetched.etag;
      if (!staleReply) this.pollError = null;
    } catch (error) {
      if (this.active && !reporting) this.pollError = safeRuntimeError(error);
      throw error;
    }
  }

  private async reconcileOnce(manual: boolean): Promise<void> {
    const context = this.context;
    if (!this.active || !context) return;
    if (manual || this.now().getTime() >= this.nextPollAt) {
      try {
        await this.poll(context, manual);
      } catch (error) {
        this.fail(error, context);
      }
      if (!this.active) return;
      this.nextPollAt =
        this.now().getTime() + this.delay(this.pollInterval(), this.pollIntervalMs !== undefined);
    }
    if (this.lastReport && this.now().getTime() >= this.nextReportAt) {
      // Never send an older cached acknowledgement after a newer successful apply
      // whose report failed. The next unconditional poll retries that revision.
      if (isCurrentRevision(this.lastReport.revisions, this.lastRevisions)) {
        try {
          await this.sendReport(
            { ...this.lastReport, observedAt: this.now().toISOString() },
            context,
          );
        } catch (error) {
          this.fail(error, context);
        }
      } else {
        this.nextReportAt = Number.POSITIVE_INFINITY;
      }
    }
    if (this.active) {
      // A successful heartbeat proves transport/presence, not desired-state health.
      // Likewise, a healthy GET cannot resolve an outstanding report failure.
      this.lastError = this.pollError ?? this.reportError;
      this.state = this.lastError === null ? "ready" : "degraded";
      if (this.lastError === null) this.lastSuccessAt = this.now().toISOString();
    }
  }

  async healthCheck(): Promise<ModuleHealth> {
    return {
      status: this.state === "ready" ? "ready" : this.state === "degraded" ? "degraded" : "offline",
      message: this.lastError ?? "Cloud desired-state reconciliation is active",
      details: {
        deviceId: this.deviceId,
        revisionToken: this.lastRevisionToken,
        lastSuccessAt: this.lastSuccessAt,
        lastReportAt: this.lastReportAt || null,
      },
      lastCheckTime: this.now().getTime(),
    };
  }
  async getDiagnostics(): Promise<JsonObject> {
    return {
      state: this.state,
      deviceId: this.deviceId,
      revisionToken: this.lastRevisionToken,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      cadence: this.adaptiveCadence ? CONTROL_PLANE_ADAPTIVE_CADENCE : "legacy",
      pollIntervalMs: this.pollInterval(),
      reportIntervalMs: this.reportInterval(),
      unchangedPolls: this.unchangedPolls,
      pollCount: this.pollCount,
      reportCount: this.reportCount,
      lastReport: this.lastReport
        ? {
            status: this.lastReport.status,
            revisions: this.lastReport.revisions,
            observedAt: this.lastReport.observedAt,
          }
        : null,
    };
  }
}
