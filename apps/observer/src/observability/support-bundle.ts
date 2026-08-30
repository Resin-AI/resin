import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import type { DaemonConfig } from "../config.js";
import { redactConfig } from "../config.js";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
import type { AuditIntegrityReport, AuditTrailEntry, AuditTrailManager } from "./audit-trail.js";
import type { HealthAggregator, SystemHealthReport } from "./health-aggregator.js";
import type { KillSwitchManager, KillSwitchSnapshot } from "./kill-switches.js";
import { type LogEntry, type StructuredLogger, redactSecrets } from "./logger.js";
import type { QuarantinedToolEntry, RecoveryController } from "./recovery-controller.js";
import type { TelemetryAggregator, TelemetrySummary } from "./telemetry-aggregator.js";

export interface PlatformDiagnostics {
  nodeVersion: string;
  osType: string;
  osPlatform: string;
  osRelease: string;
  arch: string;
  cpuCount: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  uptimeSeconds: number;
  pid: number;
}

export interface SanitizedAuditSummary {
  totalEntries: number;
  integrity: AuditIntegrityReport;
  eventTypeCounts: Record<string, number>;
  recentEntries: Array<Omit<AuditTrailEntry, "details"> & { detailsSummary?: string }>;
}

export interface SchemaCompatibilityInfo {
  protocolVersion: string;
  schemaVersion: string;
  minSupportedVersion: string;
  observerVersion: string;
}

export interface SafeCloudState {
  status: string;
  cloudUrl?: string;
  accountId?: string;
  workspaceId?: string;
  deviceId?: string;
  userId?: string;
  reason?: string;
  [key: string]: JsonValue;
}

export interface SupportBundleData {
  bundleId: string;
  generatedAt: string;
  observerVersion: string;
  platform: PlatformDiagnostics;
  health: SystemHealthReport;
  config: JsonObject;
  cloudState?: SafeCloudState;
  killSwitches?: KillSwitchSnapshot;
  auditSummary?: SanitizedAuditSummary;
  telemetry?: TelemetrySummary;
  databaseDiagnostics?: JsonObject;
  quarantinedTools?: QuarantinedToolEntry[];
  sanitizedLogs?: LogEntry[];
  schemaCompatibility?: SchemaCompatibilityInfo;
}

export interface SupportBundleGeneratorOptions {
  observerVersion?: string;
  config?: DaemonConfig;
  cloudState?: SafeCloudState | null;
  cloudStateProvider?: () => Promise<SafeCloudState | null> | SafeCloudState | null;
  logger?: StructuredLogger;
  healthAggregator?: HealthAggregator;
  killSwitches?: KillSwitchManager;
  auditTrail?: AuditTrailManager;
  telemetry?: TelemetryAggregator;
  recoveryController?: RecoveryController;
  databaseDiagnosticsProvider?: () => Promise<JsonObject> | JsonObject;
  maxLogs?: number;
  maxAuditEntries?: number;
}

export class SupportBundleGenerator {
  private readonly observerVersion: string;
  private readonly config?: DaemonConfig;
  private readonly cloudState?: SafeCloudState | null;
  private readonly cloudStateProvider?: () =>
    | Promise<SafeCloudState | null>
    | SafeCloudState
    | null;
  private readonly logger?: StructuredLogger;
  private readonly healthAggregator?: HealthAggregator;
  private readonly killSwitches?: KillSwitchManager;
  private readonly auditTrail?: AuditTrailManager;
  private readonly telemetry?: TelemetryAggregator;
  private readonly recoveryController?: RecoveryController;
  private dbDiagnosticsProvider?: () => Promise<JsonObject> | JsonObject;
  private readonly maxLogs: number;
  private readonly maxAuditEntries: number;
  constructor(options: SupportBundleGeneratorOptions = {}) {
    this.observerVersion = options.observerVersion ?? "0.1.0";
    this.config = options.config;
    this.cloudState = options.cloudState;
    this.cloudStateProvider = options.cloudStateProvider;
    this.logger = options.logger;
    this.healthAggregator = options.healthAggregator;
    this.killSwitches = options.killSwitches;
    this.auditTrail = options.auditTrail;
    this.telemetry = options.telemetry;
    this.recoveryController = options.recoveryController;
    this.dbDiagnosticsProvider = options.databaseDiagnosticsProvider;
    this.maxLogs = options.maxLogs ?? 200;
    this.maxAuditEntries = options.maxAuditEntries ?? 50;
  }

  setDatabaseDiagnosticsProvider(provider: () => Promise<JsonObject> | JsonObject): this {
    this.dbDiagnosticsProvider = provider;
    return this;
  }

  async generateBundle(): Promise<SupportBundleData> {
    const bundleId = `sb_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const generatedAt = new Date().toISOString();

    // 1. Platform diagnostics
    const platform: PlatformDiagnostics = {
      nodeVersion: process.version,
      osType: os.type(),
      osPlatform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      cpuCount: os.cpus().length,
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
      freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
    };

    // 2. Health
    let health: SystemHealthReport;
    if (this.healthAggregator) {
      health = await this.healthAggregator.checkHealth();
    } else {
      health = {
        overallStatus: "ready",
        checkedAt: generatedAt,
        components: {},
        activeReasonCodes: [],
        remediationHints: [],
      };
    }

    // 3. Sanitized Config
    // SAFETY: redactConfig produces an object dictionary of sanitized configuration properties.
    const sanitizedConfig = this.config ? (redactConfig(this.config) as JsonObject) : {};

    // 4. Safe Cloud State (no secrets, safe status and binding fields only)
    let cloudState: SafeCloudState | undefined;
    if (this.cloudStateProvider) {
      try {
        const rawCloudState = await this.cloudStateProvider();
        if (rawCloudState) {
          // SAFETY: redactSecrets deeply redacts secret tokens while preserving SafeCloudState shape.
          cloudState = redactSecrets(rawCloudState) as SafeCloudState;
        }
      } catch (err) {
        cloudState = { status: "offline", reason: String(err) };
      }
    } else if (this.cloudState) {
      // SAFETY: redactSecrets deeply redacts secret tokens while preserving SafeCloudState shape.
      cloudState = redactSecrets(this.cloudState) as SafeCloudState;
    }

    // 5. Kill switches
    const killSwitches = this.killSwitches ? this.killSwitches.getSnapshot() : undefined;
    // 5. Audit summary
    let auditSummary: SanitizedAuditSummary | undefined;
    if (this.auditTrail) {
      const integrity = await this.auditTrail.verifyIntegrity();
      const totalEntries = await this.auditTrail.count();
      const rawEntries = await this.auditTrail.getEntries({
        limit: this.maxAuditEntries,
        order: "desc",
      });

      const eventTypeCounts: Record<string, number> = {};
      const recentEntries = rawEntries.map((e) => {
        eventTypeCounts[e.eventType] = (eventTypeCounts[e.eventType] ?? 0) + 1;
        const { details, ...rest } = e;
        return {
          ...rest,
          detailsSummary: `keys: ${Object.keys(details).join(", ")}`,
        };
      });

      auditSummary = {
        totalEntries,
        integrity,
        eventTypeCounts,
        recentEntries,
      };
    }

    // 6. Telemetry
    const telemetry = this.telemetry ? this.telemetry.getSummary() : undefined;

    // 7. Database diagnostics
    let databaseDiagnostics: JsonObject | undefined;
    if (this.dbDiagnosticsProvider) {
      try {
        const rawDbDiag = await this.dbDiagnosticsProvider();
        if (rawDbDiag) {
          // SAFETY: redactSecrets deeply redacts secret tokens while preserving JsonObject structure.
          databaseDiagnostics = redactSecrets(rawDbDiag) as JsonObject;
        }
      } catch (err) {
        databaseDiagnostics = { error: `Failed to retrieve DB diagnostics: ${String(err)}` };
      }
    }

    // 8. Quarantined tools
    const quarantinedTools = this.recoveryController
      ? this.recoveryController.getQuarantinedTools()
      : [];

    // 9. Sanitized Logs
    const rawLogs = this.logger ? this.logger.getRecentLogs(this.maxLogs) : [];
    // SAFETY: redactSecrets deep-cleans log objects while preserving LogEntry fields.
    const sanitizedLogs = rawLogs.map((log) => redactSecrets(log) as LogEntry);

    // 10. Schema compatibility
    const schemaCompatibility: SchemaCompatibilityInfo = {
      protocolVersion: "1.0.0",
      schemaVersion: "1.0.0",
      minSupportedVersion: "1.0.0",
      observerVersion: this.observerVersion,
    };

    const bundle: SupportBundleData = {
      bundleId,
      generatedAt,
      observerVersion: this.observerVersion,
      platform,
      health,
      config: sanitizedConfig,
      cloudState,
      killSwitches,
      auditSummary,
      telemetry,
      databaseDiagnostics,
      quarantinedTools,
      sanitizedLogs,
      schemaCompatibility,
    };

    // Final deep sanitization pass on the entire bundle
    // SAFETY: redactSecrets deep-cleans the assembled bundle object while preserving SupportBundleData.
    return redactSecrets(bundle) as SupportBundleData;
  }

  async generateBundleJson(options: { pretty?: boolean } = {}): Promise<string> {
    const bundle = await this.generateBundle();
    return options.pretty ? JSON.stringify(bundle, null, 2) : JSON.stringify(bundle);
  }

  async writeBundleToFile(
    destinationPath: string,
  ): Promise<{ bundleId: string; filePath: string; bytesWritten: number }> {
    const json = await this.generateBundleJson({ pretty: true });
    await fs.promises.writeFile(destinationPath, json, "utf8");
    // SAFETY: SupportBundle JSON string parses into SupportBundleData object.
    const parsed = JSON.parse(json) as SupportBundleData;

    return {
      bundleId: parsed.bundleId,
      filePath: destinationPath,
      bytesWritten: Buffer.byteLength(json, "utf8"),
    };
  }
}

export function createSupportBundleGenerator(
  options?: SupportBundleGeneratorOptions,
): SupportBundleGenerator {
  return new SupportBundleGenerator(options);
}
