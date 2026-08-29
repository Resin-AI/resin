import process from "node:process";
import type { LocalDatabaseConnection } from "@resin/db";
import type { JsonObject } from "../normalization/redaction.js";
import type { KillSwitchManager, KillSwitchSnapshot } from "./kill-switches.js";

export type SubsystemHealthStatus =
  | "ready"
  | "degraded"
  | "offline"
  | "paused"
  | "upgrade_required";

export const HEALTH_STATUS_PRECEDENCE = {
  upgrade_required: 50,
  offline: 40,
  paused: 30,
  degraded: 20,
  ready: 10,
} satisfies Record<SubsystemHealthStatus, number>;

export interface ComponentHealth {
  component: string;
  status: SubsystemHealthStatus;
  critical: boolean;
  message?: string;
  reasonCode?: string;
  remediationHint?: string;
  details?: JsonObject;
  checkedAt: string;
  latencyMs?: number;
}

export interface SystemHealthReport {
  overallStatus: SubsystemHealthStatus;
  checkedAt: string;
  components: Record<string, ComponentHealth>;
  activeReasonCodes: string[];
  remediationHints: string[];
  killSwitchesSummary?: KillSwitchSnapshot;
}

export type HealthCheckFn = () =>
  | Promise<Partial<Omit<ComponentHealth, "component" | "checkedAt">>>
  | Partial<Omit<ComponentHealth, "component" | "checkedAt">>;

export interface HealthCheckRegistration {
  name: string;
  critical: boolean;
  timeoutMs: number;
  check: HealthCheckFn;
}

export const KNOWN_REMEDIATION_HINTS = {
  DB_BUSY_TIMEOUT:
    "SQLite busy timeout exceeded. Check for concurrent writers or long-running transactions.",
  DB_INTEGRITY_FAIL: "Database integrity check failed. Run repair or restore state from backup.",
  DB_MIGRATION_PENDING:
    "Unapplied database migrations found. Run migration runner before starting daemon.",
  DB_DISCONNECTED: "Database connection is not established or lost.",
  CLOUD_UPGRADE_REQUIRED:
    "Cloud protocol version deprecated. Upgrade resin daemon to latest release.",
  CLOUD_AUTH_EXPIRED:
    "Cloud API key is missing or invalid. Re-authenticate via `resin auth login`.",
  CLOUD_DISCONNECTED:
    "Emergency cloud disconnect active or network unreachable. Verify network connectivity.",
  RUNTIME_WORKER_CRASHED:
    "Runtime worker crashed or is unresponsive. Check worker logs and restart.",
  RUNTIME_QUARANTINE_ACTIVE:
    "One or more tools quarantined due to repeated failures or security policy violations.",
  EVOLUTION_PAUSED:
    "Evolution paused by operator kill switch. Resume with `resin kill-switch resume evolution`.",
  TOOLS_DISABLED:
    "Tool execution disabled globally or by workspace kill switch. Re-enable via kill-switch controls.",
  OBSERVER_MEMORY_PRESSURE:
    "Observer heap memory usage exceeded threshold. Inspect active tailers or restart daemon.",
  GATEWAY_UNREACHABLE: "Gateway IPC socket or HTTP port is unreachable.",
} as const;

export class HealthAggregator {
  private registrations = new Map<string, HealthCheckRegistration>();
  private lastReport?: SystemHealthReport;

  constructor(
    private readonly conn?: LocalDatabaseConnection,
    private readonly killSwitches?: KillSwitchManager,
  ) {
    this.registerDefaultChecks();
  }

  private registerDefaultChecks(): void {
    // 1. Observer process memory & uptime
    this.registerComponent(
      "observer",
      () => {
        const memory = process.memoryUsage();
        const heapUsedMb = Math.round(memory.heapUsed / (1024 * 1024));
        const heapTotalMb = Math.round(memory.heapTotal / (1024 * 1024));
        const isMemoryHigh = heapUsedMb > 512;

        return {
          status: isMemoryHigh ? "degraded" : "ready",
          reasonCode: isMemoryHigh ? "OBSERVER_MEMORY_PRESSURE" : undefined,
          remediationHint: isMemoryHigh
            ? KNOWN_REMEDIATION_HINTS.OBSERVER_MEMORY_PRESSURE
            : undefined,
          details: {
            uptimeSeconds: Math.round(process.uptime()),
            pid: process.pid,
            heapUsedMb,
            heapTotalMb,
            rssMb: Math.round(memory.rss / (1024 * 1024)),
          },
        };
      },
      { critical: true },
    );

    // 2. DB health check if connection provided
    if (this.conn) {
      this.registerComponent(
        "db",
        () => {
          if (!this.conn!.isOpen()) {
            return {
              status: "offline",
              reasonCode: "DB_DISCONNECTED",
              remediationHint: KNOWN_REMEDIATION_HINTS.DB_DISCONNECTED,
            };
          }

          try {
            const row = this.conn!.get<{ integrity_check: string }>("PRAGMA integrity_check(1)");
            const ok = row?.integrity_check === "ok";
            if (!ok) {
              return {
                status: "degraded",
                reasonCode: "DB_INTEGRITY_FAIL",
                remediationHint: KNOWN_REMEDIATION_HINTS.DB_INTEGRITY_FAIL,
                details: { integrity: row?.integrity_check },
              };
            }

            return {
              status: "ready",
              details: { integrity: "ok" },
            };
          } catch (err) {
            return {
              status: "degraded",
              reasonCode: "DB_BUSY_TIMEOUT",
              remediationHint: KNOWN_REMEDIATION_HINTS.DB_BUSY_TIMEOUT,
              details: { error: String(err) },
            };
          }
        },
        { critical: true },
      );
    }
  }

  registerComponent(
    name: string,
    check: HealthCheckFn,
    options: { critical?: boolean; timeoutMs?: number } = {},
  ): void {
    this.registrations.set(name, {
      name,
      critical: options.critical ?? false,
      timeoutMs: options.timeoutMs ?? 5000,
      check,
    });
  }

  unregisterComponent(name: string): void {
    this.registrations.delete(name);
  }

  async checkHealth(): Promise<SystemHealthReport> {
    const checkedAt = new Date().toISOString();
    const components: Record<string, ComponentHealth> = {};
    const activeReasonCodes: string[] = [];
    const remediationHints: string[] = [];

    // Evaluate kill switches first if available
    let killSwitchesSummary: KillSwitchSnapshot | undefined;
    let evolutionPaused = false;
    let allToolsDisabled = false;

    if (this.killSwitches) {
      killSwitchesSummary = this.killSwitches.getSnapshot();
      evolutionPaused = killSwitchesSummary.evolutionPaused;
      allToolsDisabled = killSwitchesSummary.allToolsDisabled;
    }

    const checkPromises = Array.from(this.registrations.values()).map(async (reg) => {
      const startTime = performance.now();
      try {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Health check for '${reg.name}' timed out after ${reg.timeoutMs}ms`));
          }, reg.timeoutMs);
        });

        const checkPromise = Promise.resolve(reg.check());
        const partialResult = await Promise.race([checkPromise, timeoutPromise]);
        clearTimeout(timer);

        const latencyMs = Math.round(performance.now() - startTime);
        const knownRemediationHint = Object.entries(KNOWN_REMEDIATION_HINTS).find(
          ([reasonCode]) => reasonCode === partialResult.reasonCode,
        )?.[1];
        const compHealth: ComponentHealth = {
          component: reg.name,
          status: partialResult.status ?? "ready",
          critical: partialResult.critical ?? reg.critical,
          message: partialResult.message,
          reasonCode: partialResult.reasonCode,
          remediationHint: partialResult.remediationHint ?? knownRemediationHint,
          details: partialResult.details,
          checkedAt,
          latencyMs,
        };

        return compHealth;
      } catch (err) {
        const latencyMs = Math.round(performance.now() - startTime);
        const compHealth: ComponentHealth = {
          component: reg.name,
          status: reg.critical ? "offline" : "degraded",
          critical: reg.critical,
          message: err instanceof Error ? err.message : String(err),
          checkedAt,
          latencyMs,
        };
        return compHealth;
      }
    });

    const results = await Promise.all(checkPromises);
    for (const comp of results) {
      components[comp.component] = comp;
      if (comp.reasonCode) {
        activeReasonCodes.push(comp.reasonCode);
      }
      if (comp.remediationHint && !remediationHints.includes(comp.remediationHint)) {
        remediationHints.push(comp.remediationHint);
      }
    }

    // Determine overall status
    let overallStatus: SubsystemHealthStatus = "ready";

    // 1. Check for upgrade_required
    if (results.some((c) => c.status === "upgrade_required")) {
      overallStatus = "upgrade_required";
    }
    // 2. Check for offline critical components
    else if (results.some((c) => c.critical && c.status === "offline")) {
      overallStatus = "offline";
    }
    // 3. Check for kill switch pause
    else if (evolutionPaused || allToolsDisabled || results.some((c) => c.status === "paused")) {
      overallStatus = "paused";
      if (evolutionPaused) {
        activeReasonCodes.push("EVOLUTION_PAUSED");
        if (!remediationHints.includes(KNOWN_REMEDIATION_HINTS.EVOLUTION_PAUSED)) {
          remediationHints.push(KNOWN_REMEDIATION_HINTS.EVOLUTION_PAUSED);
        }
      }
      if (allToolsDisabled) {
        activeReasonCodes.push("TOOLS_DISABLED");
        if (!remediationHints.includes(KNOWN_REMEDIATION_HINTS.TOOLS_DISABLED)) {
          remediationHints.push(KNOWN_REMEDIATION_HINTS.TOOLS_DISABLED);
        }
      }
    }
    // 4. Check for degraded or non-critical offline components
    else if (results.some((c) => c.status === "degraded" || c.status === "offline")) {
      overallStatus = "degraded";
    }

    const report: SystemHealthReport = {
      overallStatus,
      checkedAt,
      components,
      activeReasonCodes: Array.from(new Set(activeReasonCodes)),
      remediationHints,
      killSwitchesSummary,
    };

    this.lastReport = report;
    return report;
  }

  async getComponentHealth(name: string): Promise<ComponentHealth | undefined> {
    const report = await this.checkHealth();
    return report.components[name];
  }

  getLastReport(): SystemHealthReport | undefined {
    return this.lastReport;
  }
}

export function createHealthAggregator(
  conn?: LocalDatabaseConnection,
  killSwitches?: KillSwitchManager,
): HealthAggregator {
  return new HealthAggregator(conn, killSwitches);
}
