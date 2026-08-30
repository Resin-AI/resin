import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
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

export const DEFAULT_CONTROL_PLANE_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_CONTROL_PLANE_REPORT_INTERVAL_MS = 30_000;
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
    if (response.status === 304) {
      await response.body?.cancel().catch(() => undefined);
      return { state: null, etag: etag ?? null, notModified: true };
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
  pollIntervalMs?: number;
  reportIntervalMs?: number;
  now?: () => Date;
}
function safeRuntimeError<E>(error: E): string {
  const message = error instanceof Error ? error.message : "Unknown control-plane failure";
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 256);
}

export class ControlPlaneRuntimeModule implements DaemonModule {
  readonly id = "control-plane";
  readonly name = "Cloud Desired-State Reconciliation";
  readonly dependencies = ["cloud-runtime"] as const;
  readonly critical = false;

  private readonly client: ControlPlaneClient;
  private readonly deviceId: string;
  private readonly applyAdapter: ControlPlaneApplyAdapter;
  private readonly pollIntervalMs: number;
  private readonly reportIntervalMs: number;
  private readonly now: () => Date;
  private state: ModuleLifecycleState = "uninitialized";
  private timer: ReturnType<typeof setInterval> | null = null;
  private context: ModuleContext | null = null;
  private etag: string | undefined;
  private lastRevisionToken: string | null = null;
  private lastReport: ControlPlaneDeviceReport | null = null;
  private lastReportAt = 0;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private cycle: Promise<void> = Promise.resolve();

  constructor(options: ControlPlaneRuntimeModuleOptions) {
    this.client = options.client;
    this.deviceId = options.deviceId;
    this.applyAdapter = options.applyAdapter;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CONTROL_PLANE_POLL_INTERVAL_MS;
    this.reportIntervalMs = options.reportIntervalMs ?? DEFAULT_CONTROL_PLANE_REPORT_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(context: ModuleContext): Promise<void> {
    this.state = "starting";
    this.context = context;
    await this.enqueueCycle();
    this.timer = setInterval(() => {
      void this.enqueueCycle();
    }, this.pollIntervalMs);
    this.timer.unref();
    if (this.state === "starting") this.state = "ready";
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.cycle;
    this.context = null;
    this.state = "stopped";
  }

  private enqueueCycle(): Promise<void> {
    this.cycle = this.cycle.then(
      () => this.reconcileOnce(),
      () => this.reconcileOnce(),
    );
    return this.cycle;
  }

  async reconcileNow(): Promise<void> {
    await this.enqueueCycle();
  }

  private async reconcileOnce(): Promise<void> {
    const context = this.context;
    if (!context || context.signal?.aborted) return;
    try {
      const fetched = await this.client.getEffectiveState(this.deviceId, this.etag, context.signal);
      const now = this.now();
      if (fetched.state && fetched.state.revisionToken !== this.lastRevisionToken) {
        const applied = await this.applyAdapter.apply(
          fetched.state.desiredState,
          fetched.state.revisions,
          fetched.state.revisionToken,
          context,
        );
        const report: ControlPlaneDeviceReport = {
          deviceId: this.deviceId,
          revisions: fetched.state.revisions,
          revisionToken: fetched.state.revisionToken,
          status: applied.status,
          fields: applied.fields,
          observedAt: now.toISOString(),
          appliedAt: applied.appliedAt,
        };
        await this.client.report(report, context.signal);
        this.lastReport = report;
        this.lastReportAt = now.getTime();
        if (applied.status === "error") {
          throw new Error("Cloud desired state was not applied");
        }
        this.lastRevisionToken = fetched.state.revisionToken;
      } else if (this.lastReport && now.getTime() - this.lastReportAt >= this.reportIntervalMs) {
        const report = { ...this.lastReport, observedAt: now.toISOString() };
        await this.client.report(report, context.signal);
        this.lastReport = report;
        this.lastReportAt = now.getTime();
      }
      if (fetched.etag) this.etag = fetched.etag;
      this.lastSuccessAt = now.toISOString();
      this.lastError = null;
      this.state = "ready";
    } catch (error) {
      this.lastError = safeRuntimeError(error);
      this.state = "degraded";
      context.logger.warn("Cloud desired-state reconciliation is degraded", {
        reason: this.lastError,
      });
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
