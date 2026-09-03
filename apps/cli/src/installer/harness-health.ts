import { randomUUID } from "node:crypto";
import { type Stats, constants as fsConstants, realpathSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeConfigFsBridge } from "@resin/harness-contracts";
import { z } from "zod";
import {
  HARNESS_DISPLAY_NAMES,
  SUPPORTED_HARNESS_IDS,
  type SupportedHarnessId,
  resolveHarnessConfigPath,
} from "./harness-config.js";
import {
  DEFAULT_HARNESS_AUTO_REPAIR,
  type HarnessInstallationProbe,
  type HarnessReconcileFsBridge,
  type HarnessReconcileOptions,
  HarnessReconciler,
  type HarnessReconciliationReport,
  type HarnessRegistrationCondition,
  type HarnessRegistrationStatus,
  ReconciliationNodeFsBridge,
} from "./harness-reconciler.js";

export const HARNESS_HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const HARNESS_HEALTH_STATE_FORMAT = "resin-harness-health/v1" as const;
export const HARNESS_HEALTH_STATE_FILENAME = "harness-health.json";
export const HARNESS_HEALTH_COMMAND_DEADLINE_MS = 250;
export const HARNESS_HEALTH_SETTINGS_FORMAT = "resin-harness-health-settings/v1" as const;
export const HARNESS_HEALTH_SETTINGS_FILENAME = "harness-health.json";

export type HarnessHealthTrigger =
  | "init"
  | "doctor"
  | "repair"
  | "startup"
  | "scheduled"
  | "manual";

export type HarnessHealthRecentActionKind =
  | "discovered"
  | "reconciled"
  | "drift_detected"
  | "repair_failed";

export interface HarnessHealthRecentAction {
  readonly kind: HarnessHealthRecentActionKind;
  readonly at: string;
}

export interface HarnessConfigHealthCache {
  readonly present: boolean;
  readonly mtimeMs: number | null;
}

export interface HarnessHealthConfigFiles {
  readonly "claude-code": HarnessConfigHealthCache;
  readonly "codex-cli": HarnessConfigHealthCache;
  readonly omp: HarnessConfigHealthCache;
}

export interface HarnessHealthConfigFileCache {
  "claude-code": HarnessConfigHealthCache;
  "codex-cli": HarnessConfigHealthCache;
  omp: HarnessConfigHealthCache;
}

export interface HarnessHealthHarnessSnapshot {
  readonly harnessId: SupportedHarnessId;
  readonly displayName: string;
  readonly installed: boolean;
  readonly configured: boolean;
  readonly status: HarnessRegistrationStatus;
  readonly condition: HarnessRegistrationCondition;
  readonly changed: boolean;
  readonly checkedAt: string;
  readonly recentAction?: HarnessHealthRecentAction;
}

export interface HarnessHealthFailureSnapshot {
  readonly code: "check_failed";
  readonly at: string;
}
export type HarnessHealthSettingsDiagnostic =
  | "settings_invalid"
  | "settings_unreadable"
  | "settings_unsafe";

export interface HarnessHealthSnapshot {
  readonly format: typeof HARNESS_HEALTH_STATE_FORMAT;
  readonly checkedAt: string | null;
  readonly trigger: HarnessHealthTrigger;
  readonly autoRepair: boolean;
  readonly settingsDiagnostic?: HarnessHealthSettingsDiagnostic;
  readonly success: boolean;
  readonly hasDrift: boolean;
  readonly configFiles: HarnessHealthConfigFiles;
  readonly harnesses: readonly HarnessHealthHarnessSnapshot[];
  readonly lastFailure?: HarnessHealthFailureSnapshot;
}

export interface HarnessHealthSettings {
  readonly format: typeof HARNESS_HEALTH_SETTINGS_FORMAT;
  readonly autoRepair: boolean;
  readonly diagnostic?: HarnessHealthSettingsDiagnostic;
}

export interface HarnessConfigFileStat {
  readonly mtimeMs: number;
}

export type HarnessConfigStatReader = (filePath: string) => Promise<HarnessConfigFileStat | null>;

export interface HarnessHealthReconciler {
  reconcile(options?: HarnessReconcileOptions): Promise<HarnessReconciliationReport>;
}

export interface HarnessHealthCoordinatorOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly resinCommand?: string;
  readonly entryPath?: string;
  readonly workspacePath?: string;
  readonly gatewayUrl?: string;
  readonly statePath?: string;
  readonly settingsPath?: string;
  readonly autoRepair?: boolean;
  readonly checkIntervalMs?: number;
  readonly fsBridge?: HarnessReconcileFsBridge;
  readonly reconciler?: HarnessHealthReconciler;
  readonly probeHarness?: HarnessInstallationProbe;
  readonly installedHarnesses?: readonly SupportedHarnessId[];
  readonly harnesses?: readonly SupportedHarnessId[];
  readonly now?: () => Date;
  readonly statFile?: HarnessConfigStatReader;
}

export interface HarnessHealthRunOptions {
  readonly trigger?: HarnessHealthTrigger;
  readonly force?: boolean;
  readonly autoRepair?: boolean;
  readonly installedHarnesses?: readonly SupportedHarnessId[];
  readonly harnesses?: readonly SupportedHarnessId[];
}

export type HarnessHealthRunStatus = "checked" | "debounced" | "failed";

export interface HarnessHealthRunResult {
  readonly status: HarnessHealthRunStatus;
  readonly snapshot: HarnessHealthSnapshot | null;
}

export interface HarnessHealthRunner {
  run(options?: HarnessHealthRunOptions): Promise<HarnessHealthRunResult>;
}

export type BoundedHarnessHealthCheckResult =
  | {
      readonly status: "completed";
      readonly result: HarnessHealthRunResult;
    }
  | {
      readonly status: "timed_out";
      readonly result: null;
    };

export interface BoundedHarnessHealthCheckOptions
  extends HarnessHealthCoordinatorOptions,
    HarnessHealthRunOptions {
  readonly runner?: HarnessHealthRunner;
  readonly deadlineMs?: number;
}

export interface HarnessHealthSchedulerOptions extends HarnessHealthCoordinatorOptions {
  readonly resinHome?: string;
  readonly runner?: HarnessHealthRunner;
  readonly deadlineMs?: number;
  readonly intervalMs?: number;
  readonly runImmediately?: boolean;
}

export interface HarnessHealthScheduler {
  stop(): void;
}

const HarnessIdSchema = z.enum(SUPPORTED_HARNESS_IDS);
const HarnessRegistrationStatusSchema = z.enum([
  "registered",
  "unregistered",
  "reconciled",
  "drift_detected",
]);
const HarnessRegistrationConditionSchema = z.enum([
  "healthy",
  "missing",
  "drifted",
  "corrupt",
  "not_installed",
]);
const HarnessHealthTriggerSchema = z.enum([
  "init",
  "doctor",
  "repair",
  "startup",
  "scheduled",
  "manual",
]);
const HarnessHealthSettingsDiagnosticSchema = z.enum([
  "settings_invalid",
  "settings_unreadable",
  "settings_unsafe",
]);
const HarnessHealthRecentActionSchema = z
  .object({
    kind: z.enum(["discovered", "reconciled", "drift_detected", "repair_failed"]),
    at: z.string().datetime(),
  })
  .strict();
const HarnessConfigHealthCacheSchema = z
  .object({
    present: z.boolean(),
    mtimeMs: z.number().finite().nullable(),
  })
  .strict();
const HarnessHealthHarnessSnapshotSchema = z
  .object({
    harnessId: HarnessIdSchema,
    displayName: z.string().min(1).max(128),
    installed: z.boolean(),
    configured: z.boolean(),
    status: HarnessRegistrationStatusSchema,
    condition: HarnessRegistrationConditionSchema,
    changed: z.boolean(),
    checkedAt: z.string().datetime(),
    recentAction: HarnessHealthRecentActionSchema.optional(),
  })
  .strict();
const HarnessHealthSnapshotSchema = z
  .object({
    format: z.literal(HARNESS_HEALTH_STATE_FORMAT),
    checkedAt: z.string().datetime().nullable(),
    trigger: HarnessHealthTriggerSchema,
    autoRepair: z.boolean(),
    settingsDiagnostic: HarnessHealthSettingsDiagnosticSchema.optional(),
    success: z.boolean(),
    hasDrift: z.boolean(),
    configFiles: z
      .object({
        "claude-code": HarnessConfigHealthCacheSchema,
        "codex-cli": HarnessConfigHealthCacheSchema,
        omp: HarnessConfigHealthCacheSchema,
      })
      .strict(),
    harnesses: z.array(HarnessHealthHarnessSnapshotSchema),
    lastFailure: z
      .object({
        code: z.literal("check_failed"),
        at: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
const HarnessHealthSettingsSchema = z
  .object({
    format: z.literal(HARNESS_HEALTH_SETTINGS_FORMAT),
    autoRepair: z.boolean(),
  })
  .strict();

const EMPTY_CONFIG_CACHE = {
  "claude-code": { present: false, mtimeMs: null },
  "codex-cli": { present: false, mtimeMs: null },
  omp: { present: false, mtimeMs: null },
} as const satisfies HarnessHealthConfigFiles;

export function resolveHarnessHealthStatePath(home = os.homedir()): string {
  return path.join(path.resolve(home), ".resin", "state", HARNESS_HEALTH_STATE_FILENAME);
}

export function resolveHarnessHealthSettingsPath(home = os.homedir()): string {
  return path.join(path.resolve(home), ".resin", "config", HARNESS_HEALTH_SETTINGS_FILENAME);
}

export async function loadHarnessHealthSnapshot(
  options: {
    readonly home?: string;
    readonly statePath?: string;
    readonly fsBridge?: HarnessReconcileFsBridge;
  } = {},
): Promise<HarnessHealthSnapshot | null> {
  const bridge = options.fsBridge ?? new ReconciliationNodeFsBridge();
  const statePath = options.statePath
    ? path.resolve(options.statePath)
    : resolveHarnessHealthStatePath(options.home);

  try {
    const content = await bridge.readFile(statePath);
    if (content === null) {
      return null;
    }

    const decoded: unknown = JSON.parse(content);
    const parsed = HarnessHealthSnapshotSchema.safeParse(decoded);
    if (!parsed.success) {
      return null;
    }

    return {
      ...parsed.data,
      harnesses: parsed.data.harnesses.map((snapshot) => ({
        ...snapshot,
        displayName: HARNESS_DISPLAY_NAMES[snapshot.harnessId],
      })),
    };
  } catch {
    return null;
  }
}

type HarnessHealthSettingsSource =
  | { readonly kind: "missing" }
  | { readonly kind: "readable"; readonly content: string }
  | {
      readonly kind: "failed";
      readonly diagnostic: HarnessHealthSettingsDiagnostic;
    };

function isNodeHarnessSettingsBridge(bridge: HarnessReconcileFsBridge): boolean {
  return bridge instanceof NodeConfigFsBridge || bridge instanceof ReconciliationNodeFsBridge;
}

async function readHarnessHealthSettingsSource(
  settingsPath: string,
  bridge: HarnessReconcileFsBridge,
): Promise<HarnessHealthSettingsSource> {
  if (isNodeHarnessSettingsBridge(bridge)) {
    return readNodeHarnessHealthSettingsSource(settingsPath);
  }

  try {
    const content = await bridge.readFile(settingsPath);
    return content === null ? { kind: "missing" } : { kind: "readable", content };
  } catch {
    return { kind: "failed", diagnostic: "settings_unreadable" };
  }
}

async function readNodeHarnessHealthSettingsSource(
  settingsPath: string,
): Promise<HarnessHealthSettingsSource> {
  let handle: FileHandle | undefined;

  try {
    const pathStat = await fs.lstat(settingsPath);
    if (!pathStat.isFile() || pathStat.nlink !== 1) {
      return { kind: "failed", diagnostic: "settings_unsafe" };
    }

    handle = await fs.open(settingsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openStat = await handle.stat();
    const currentPathStat = await fs.lstat(settingsPath);
    if (
      !openStat.isFile() ||
      openStat.nlink !== 1 ||
      !currentPathStat.isFile() ||
      currentPathStat.nlink !== 1 ||
      pathStat.dev !== openStat.dev ||
      pathStat.ino !== openStat.ino ||
      currentPathStat.dev !== openStat.dev ||
      currentPathStat.ino !== openStat.ino
    ) {
      return { kind: "failed", diagnostic: "settings_unsafe" };
    }

    return { kind: "readable", content: await handle.readFile("utf8") };
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return { kind: "missing" };
    }
    if (isSymbolicLinkPathError(error)) {
      return { kind: "failed", diagnostic: "settings_unsafe" };
    }
    return { kind: "failed", diagnostic: "settings_unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function unsafeHarnessHealthSettingsPathError(): Error {
  return new Error(
    "Harness health settings path is unsafe; replace any link or non-regular entry with a regular file and retry.",
  );
}

function unverifiableHarnessHealthSettingsPathError(): Error {
  return new Error(
    "Harness health settings path could not be verified; ensure it is accessible and is a regular file, then retry.",
  );
}

async function readNodeHarnessHealthSettingsWriteStat(settingsPath: string): Promise<Stats | null> {
  let pathStat: Stats;
  try {
    pathStat = await fs.lstat(settingsPath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw unverifiableHarnessHealthSettingsPathError();
  }

  if (!pathStat.isFile() || pathStat.nlink !== 1) {
    throw unsafeHarnessHealthSettingsPathError();
  }
  return pathStat;
}

async function writeNodeHarnessHealthSettings(
  settingsPath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const initialStat = await readNodeHarnessHealthSettingsWriteStat(settingsPath);
  const targetMode = initialStat === null ? 0o600 : initialStat.mode & 0o777;
  const temporaryPath = path.join(
    path.dirname(settingsPath),
    `.${path.basename(settingsPath)}.resin-${randomUUID()}.tmp`,
  );
  let replaced = false;

  try {
    const handle = await fs.open(temporaryPath, "wx", targetMode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.chmod(targetMode);
    } finally {
      await handle.close();
    }

    const currentStat = await readNodeHarnessHealthSettingsWriteStat(settingsPath);
    if (
      (initialStat === null && currentStat !== null) ||
      (initialStat !== null &&
        (currentStat === null ||
          currentStat.dev !== initialStat.dev ||
          currentStat.ino !== initialStat.ino))
    ) {
      throw unsafeHarnessHealthSettingsPathError();
    }

    await fs.rename(temporaryPath, settingsPath);
    replaced = true;
  } finally {
    if (!replaced) {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function failClosedHarnessHealthSettings(
  diagnostic: HarnessHealthSettingsDiagnostic,
): HarnessHealthSettings {
  return {
    format: HARNESS_HEALTH_SETTINGS_FORMAT,
    autoRepair: false,
    diagnostic,
  };
}

export async function loadHarnessHealthSettings(
  options: {
    readonly home?: string;
    readonly settingsPath?: string;
    readonly fsBridge?: HarnessReconcileFsBridge;
  } = {},
): Promise<HarnessHealthSettings> {
  const bridge = options.fsBridge ?? new ReconciliationNodeFsBridge();
  const settingsPath = options.settingsPath
    ? path.resolve(options.settingsPath)
    : resolveHarnessHealthSettingsPath(options.home);
  const source = await readHarnessHealthSettingsSource(settingsPath, bridge);

  if (source.kind === "missing") {
    return {
      format: HARNESS_HEALTH_SETTINGS_FORMAT,
      autoRepair: DEFAULT_HARNESS_AUTO_REPAIR,
    };
  }
  if (source.kind === "failed") {
    return failClosedHarnessHealthSettings(source.diagnostic);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(source.content);
  } catch {
    return failClosedHarnessHealthSettings("settings_invalid");
  }

  const parsed = HarnessHealthSettingsSchema.safeParse(decoded);
  return parsed.success ? parsed.data : failClosedHarnessHealthSettings("settings_invalid");
}

export async function saveHarnessHealthSettings(
  autoRepair: boolean,
  options: {
    readonly home?: string;
    readonly settingsPath?: string;
    readonly fsBridge?: HarnessReconcileFsBridge;
  } = {},
): Promise<HarnessHealthSettings> {
  const bridge = options.fsBridge ?? new ReconciliationNodeFsBridge();
  const settingsPath = options.settingsPath
    ? path.resolve(options.settingsPath)
    : resolveHarnessHealthSettingsPath(options.home);
  const settings: HarnessHealthSettings = {
    format: HARNESS_HEALTH_SETTINGS_FORMAT,
    autoRepair,
  };
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const nodeBridge = isNodeHarnessSettingsBridge(bridge);
  const persist = async (): Promise<void> => {
    if (nodeBridge) {
      await writeNodeHarnessHealthSettings(settingsPath, content);
      return;
    }
    await bridge.mkdirp(path.dirname(settingsPath));
    await bridge.writeFile(settingsPath, content);
  };

  if (nodeBridge) {
    await readNodeHarnessHealthSettingsWriteStat(settingsPath);
  }
  if (bridge.withFileLock) {
    await bridge.withFileLock(settingsPath, persist);
  } else {
    await persist();
  }
  return settings;
}

export function resolveLocalSourceResinCommand(
  env: NodeJS.ProcessEnv,
  entryPath: string | undefined = process.argv[1],
): string | undefined {
  if (!entryPath) return undefined;

  try {
    const resolvedEntry = realpathSync.native(entryPath);
    const requestedRoot = env.RESIN_LOCAL_SOURCE_ROOT?.trim();
    const root = requestedRoot
      ? realpathSync.native(requestedRoot)
      : path.resolve(path.dirname(resolvedEntry), "..", "..", "..");
    const sourceCommand = realpathSync.native(path.join(root, "apps", "cli", "bin", "resin.mjs"));
    const remainsInsideRoot = (candidatePath: string): boolean => {
      const relativePath = path.relative(root, candidatePath);
      return (
        relativePath.length > 0 &&
        !relativePath.startsWith(`..${path.sep}`) &&
        relativePath !== ".." &&
        !path.isAbsolute(relativePath)
      );
    };
    if (!remainsInsideRoot(sourceCommand)) return undefined;
    if (resolvedEntry === sourceCommand) return sourceCommand;
    if (!requestedRoot) return undefined;

    const supervisorCommand = realpathSync.native(
      path.join(root, "apps", "cli", "dist", "index.js"),
    );
    return remainsInsideRoot(supervisorCommand) && resolvedEntry === supervisorCommand
      ? sourceCommand
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Coordinates low-overhead harness checks and safe reconciliation without ever
 * exposing planner data, config contents, paths, or raw errors in persisted state.
 */
export class HarnessHealthCoordinator implements HarnessHealthRunner {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly workspacePath: string;
  private readonly gatewayUrl: string | undefined;
  private readonly resinCommand: string | undefined;
  private readonly statePath: string;
  private readonly settingsPath: string;
  private readonly autoRepairOverride: boolean | undefined;
  private readonly checkIntervalMs: number;
  private readonly fsBridge: HarnessReconcileFsBridge;
  private readonly reconciler: HarnessHealthReconciler;
  private readonly probeHarness: HarnessInstallationProbe | undefined;
  private readonly installedHarnesses: readonly SupportedHarnessId[] | undefined;
  private readonly harnesses: readonly SupportedHarnessId[];
  private readonly now: () => Date;
  private readonly statFile: HarnessConfigStatReader;
  private inFlight: Promise<HarnessHealthRunResult> | null = null;

  constructor(options: HarnessHealthCoordinatorOptions = {}) {
    this.home = path.resolve(options.home ?? options.env?.HOME ?? os.homedir());
    this.env = options.env ?? (options.home === undefined ? process.env : { HOME: this.home });
    this.resinCommand =
      options.resinCommand ??
      resolveLocalSourceResinCommand(options.env ?? process.env, options.entryPath);
    this.workspacePath = path.resolve(options.workspacePath ?? process.cwd());
    this.gatewayUrl = options.gatewayUrl;
    this.statePath = options.statePath
      ? path.resolve(options.statePath)
      : resolveHarnessHealthStatePath(this.home);
    this.settingsPath = options.settingsPath
      ? path.resolve(options.settingsPath)
      : resolveHarnessHealthSettingsPath(this.home);
    this.autoRepairOverride = options.autoRepair;
    this.checkIntervalMs =
      options.checkIntervalMs !== undefined &&
      Number.isFinite(options.checkIntervalMs) &&
      options.checkIntervalMs >= 0
        ? options.checkIntervalMs
        : HARNESS_HEALTH_CHECK_INTERVAL_MS;
    this.fsBridge = options.fsBridge ?? new ReconciliationNodeFsBridge();
    this.reconciler = options.reconciler ?? new HarnessReconciler();
    this.probeHarness = options.probeHarness;
    this.installedHarnesses = options.installedHarnesses;
    this.harnesses = [...new Set(options.harnesses ?? SUPPORTED_HARNESS_IDS)];
    this.now = options.now ?? (() => new Date());

    const bridgeStatFile =
      "statFile" in this.fsBridge && this.fsBridge.statFile instanceof Function
        ? this.fsBridge.statFile
        : undefined;
    this.statFile = options.statFile ?? bridgeStatFile?.bind(this.fsBridge) ?? readNodeFileStat;
  }

  run(options: HarnessHealthRunOptions = {}): Promise<HarnessHealthRunResult> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    const operation = this.runOnce(options).finally(() => {
      if (this.inFlight === operation) {
        this.inFlight = null;
      }
    });
    this.inFlight = operation;
    return operation;
  }

  private async runOnce(options: HarnessHealthRunOptions): Promise<HarnessHealthRunResult> {
    const trigger = options.trigger ?? "scheduled";
    const autoRepairOverride = options.autoRepair ?? this.autoRepairOverride;
    const settings = await loadHarnessHealthSettings({
      settingsPath: this.settingsPath,
      fsBridge: this.fsBridge,
    });
    const autoRepair = autoRepairOverride ?? settings.autoRepair;
    const settingsDiagnostic = settings.diagnostic;
    let previous: HarnessHealthSnapshot | null = null;
    let configFiles: HarnessHealthConfigFiles = EMPTY_CONFIG_CACHE;
    let attemptedAt = new Date(0);

    try {
      attemptedAt = this.now();
      previous = await loadHarnessHealthSnapshot({
        statePath: this.statePath,
        fsBridge: this.fsBridge,
      });
      configFiles = await this.captureConfigFiles();

      if (
        options.force !== true &&
        previous !== null &&
        !isHarnessHealthCheckDue(
          previous,
          configFiles,
          autoRepair,
          settingsDiagnostic,
          attemptedAt.getTime(),
          this.checkIntervalMs,
        )
      ) {
        return { status: "debounced", snapshot: previous };
      }

      const report = await this.reconciler.reconcile({
        autoRepair,
        harnesses: options.harnesses ?? this.harnesses,
        installedHarnesses: options.installedHarnesses ?? this.installedHarnesses,
        customHome: this.home,
        env: this.env,
        workspacePath: this.workspacePath,
        gatewayUrl: this.gatewayUrl,
        resinCommand: this.resinCommand,
        fsBridge: this.fsBridge,
        probeHarness: this.probeHarness,
        now: () => attemptedAt,
      });

      const checkedAt = attemptedAt.toISOString();
      const postCheckConfigFiles = await this.captureConfigFiles();
      const snapshot: HarnessHealthSnapshot = {
        format: HARNESS_HEALTH_STATE_FORMAT,
        checkedAt,
        trigger,
        autoRepair,
        settingsDiagnostic,
        success: report.success,
        hasDrift: report.hasDrift,
        configFiles: postCheckConfigFiles,
        harnesses: sanitizeHarnessResults(report, previous, checkedAt),
      };

      await this.persistSnapshot(snapshot);
      return { status: "checked", snapshot };
    } catch {
      const failureAt = safeIsoTimestamp(attemptedAt, this.now);
      const failureSnapshot: HarnessHealthSnapshot = previous
        ? {
            ...previous,
            trigger,
            autoRepair,
            settingsDiagnostic,
            success: false,
            configFiles,
            lastFailure: { code: "check_failed", at: failureAt },
          }
        : {
            format: HARNESS_HEALTH_STATE_FORMAT,
            checkedAt: null,
            trigger,
            autoRepair,
            settingsDiagnostic,
            success: false,
            hasDrift: false,
            configFiles,
            harnesses: [],
            lastFailure: { code: "check_failed", at: failureAt },
          };

      try {
        await this.persistSnapshot(failureSnapshot);
      } catch {
        // The command hook remains best-effort even when the state directory is unavailable.
      }
      return { status: "failed", snapshot: failureSnapshot };
    }
  }

  private async captureConfigFiles(): Promise<HarnessHealthConfigFiles> {
    const entries = await Promise.all(
      SUPPORTED_HARNESS_IDS.map(async (harnessId) => {
        const configPath = resolveHarnessConfigPath(harnessId, this.home, this.env);
        const present = await this.fsBridge.exists(configPath);
        if (!present) {
          return [harnessId, { present: false, mtimeMs: null }] as const;
        }

        const fileStat = await this.statFile(configPath);
        return [
          harnessId,
          {
            present: true,
            mtimeMs:
              fileStat === null || !Number.isFinite(fileStat.mtimeMs) ? null : fileStat.mtimeMs,
          },
        ] as const;
      }),
    );

    const cacheRecord: HarnessHealthConfigFileCache = {
      "claude-code": { present: false, mtimeMs: null },
      "codex-cli": { present: false, mtimeMs: null },
      omp: { present: false, mtimeMs: null },
    };
    for (const [id, cache] of entries) {
      cacheRecord[id] = cache;
    }
    return cacheRecord;
  }

  private async persistSnapshot(snapshot: HarnessHealthSnapshot): Promise<void> {
    await this.fsBridge.mkdirp(path.dirname(this.statePath));
    await this.fsBridge.writeFile(this.statePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}

export async function runHarnessHealthCheck(
  options: HarnessHealthCoordinatorOptions & HarnessHealthRunOptions = {},
): Promise<HarnessHealthRunResult> {
  const coordinator = new HarnessHealthCoordinator(options);
  return coordinator.run({
    trigger: options.trigger,
    force: options.force,
    autoRepair: options.autoRepair,
    installedHarnesses: options.installedHarnesses,
    harnesses: options.harnesses,
  });
}

export async function runBoundedHarnessHealthCheck(
  options: BoundedHarnessHealthCheckOptions = {},
): Promise<BoundedHarnessHealthCheckResult> {
  const runner = options.runner ?? new HarnessHealthCoordinator(options);
  const requestedDeadlineMs = options.deadlineMs;
  const deadlineMs =
    requestedDeadlineMs !== undefined &&
    Number.isSafeInteger(requestedDeadlineMs) &&
    requestedDeadlineMs >= 0
      ? requestedDeadlineMs
      : HARNESS_HEALTH_COMMAND_DEADLINE_MS;
  const operation = Promise.resolve()
    .then(() =>
      runner.run({
        trigger: options.trigger,
        force: options.force,
        autoRepair: options.autoRepair,
        installedHarnesses: options.installedHarnesses,
        harnesses: options.harnesses,
      }),
    )
    .catch(
      (): HarnessHealthRunResult => ({
        status: "failed",
        snapshot: null,
      }),
    );

  let deadlineHandle: NodeJS.Timeout | undefined;
  const deadline = new Promise<BoundedHarnessHealthCheckResult>((resolve) => {
    deadlineHandle = setTimeout(() => {
      resolve({ status: "timed_out", result: null });
    }, deadlineMs);
  });
  const completed = operation.then(
    (result): BoundedHarnessHealthCheckResult => ({
      status: "completed",
      result,
    }),
  );
  const outcome = await Promise.race([completed, deadline]);
  clearTimeout(deadlineHandle);
  return outcome;
}

export async function runHarnessHealthStartupCheck(
  options: Omit<BoundedHarnessHealthCheckOptions, "trigger"> = {},
): Promise<BoundedHarnessHealthCheckResult> {
  return runBoundedHarnessHealthCheck({
    ...options,
    trigger: "startup",
  });
}

export function startHarnessHealthScheduler(
  options: HarnessHealthSchedulerOptions = {},
): HarnessHealthScheduler {
  const resinHome = options.resinHome ? path.resolve(options.resinHome) : undefined;
  const home = path.resolve(options.home ?? (resinHome ? path.dirname(resinHome) : os.homedir()));
  const runner =
    options.runner ??
    new HarnessHealthCoordinator({
      ...options,
      home,
      statePath:
        options.statePath ??
        (resinHome ? path.join(resinHome, "state", HARNESS_HEALTH_STATE_FILENAME) : undefined),
      settingsPath:
        options.settingsPath ??
        (resinHome ? path.join(resinHome, "config", HARNESS_HEALTH_SETTINGS_FILENAME) : undefined),
    });
  const requestedIntervalMs = options.intervalMs;
  const intervalMs =
    requestedIntervalMs !== undefined &&
    Number.isSafeInteger(requestedIntervalMs) &&
    requestedIntervalMs > 0
      ? requestedIntervalMs
      : HARNESS_HEALTH_CHECK_INTERVAL_MS;
  let stopped = false;
  const dispatch = (trigger: "startup" | "scheduled"): void => {
    if (stopped) {
      return;
    }
    void runBoundedHarnessHealthCheck({
      runner,
      trigger,
      deadlineMs: options.deadlineMs,
    }).catch(() => {
      // Resident checks are isolated from the supervisor lifecycle.
    });
  };
  const interval = setInterval(() => {
    dispatch("scheduled");
  }, intervalMs);
  interval.unref();

  if (options.runImmediately !== false) {
    dispatch("startup");
  }

  return {
    stop(): void {
      if (!stopped) {
        stopped = true;
        clearInterval(interval);
      }
    },
  };
}

function sanitizeHarnessResults(
  report: HarnessReconciliationReport,
  previous: HarnessHealthSnapshot | null,
  checkedAt: string,
): HarnessHealthHarnessSnapshot[] {
  const previousById = new Map(
    previous?.harnesses.map((snapshot) => [snapshot.harnessId, snapshot] as const) ?? [],
  );
  const snapshots: HarnessHealthHarnessSnapshot[] = [];
  const seen = new Set<SupportedHarnessId>();

  for (const result of report.results) {
    if (!isSupportedHarnessId(result.harnessId) || seen.has(result.harnessId)) {
      continue;
    }
    seen.add(result.harnessId);

    const prior = previousById.get(result.harnessId);
    let recentAction = prior?.recentAction;
    if (result.error !== undefined) {
      recentAction = { kind: "repair_failed", at: checkedAt };
    } else if (result.changed) {
      recentAction = { kind: "reconciled", at: checkedAt };
    } else if (
      result.installed &&
      (result.status === "drift_detected" || result.status === "unregistered")
    ) {
      recentAction = { kind: "drift_detected", at: checkedAt };
    } else if (result.installed && prior?.installed !== true) {
      recentAction = { kind: "discovered", at: checkedAt };
    }

    const snapshot: HarnessHealthHarnessSnapshot = {
      harnessId: result.harnessId,
      displayName: HARNESS_DISPLAY_NAMES[result.harnessId],
      installed: result.installed,
      configured: result.configured,
      status: result.status,
      condition: result.condition,
      changed: result.changed,
      checkedAt,
      recentAction: recentAction ?? undefined,
    };
    snapshots.push(snapshot);
  }

  return snapshots;
}

function isHarnessHealthCheckDue(
  previous: HarnessHealthSnapshot,
  configFiles: Readonly<Record<SupportedHarnessId, HarnessConfigHealthCache>>,
  autoRepair: boolean,
  settingsDiagnostic: HarnessHealthSettingsDiagnostic | undefined,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (
    previous.checkedAt === null ||
    previous.autoRepair !== autoRepair ||
    previous.settingsDiagnostic !== settingsDiagnostic ||
    configFilesChanged(previous.configFiles, configFiles)
  ) {
    return true;
  }

  const checkedAtMs = Date.parse(previous.checkedAt);
  const elapsedMs = nowMs - checkedAtMs;
  return !Number.isFinite(checkedAtMs) || elapsedMs < 0 || elapsedMs >= intervalMs;
}

function configFilesChanged(
  previous: HarnessHealthConfigFiles,
  current: HarnessHealthConfigFiles,
): boolean {
  return SUPPORTED_HARNESS_IDS.some((harnessId) => {
    const before = previous[harnessId];
    const after = current[harnessId];
    return before.present !== after.present || before.mtimeMs !== after.mtimeMs;
  });
}

function isSupportedHarnessId(value: string): value is SupportedHarnessId {
  return value === "claude-code" || value === "codex-cli" || value === "omp";
}

async function readNodeFileStat(filePath: string): Promise<HarnessConfigFileStat | null> {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs };
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function isMissingPathError(cause: unknown): cause is NodeJS.ErrnoException {
  return (
    Boolean(cause) &&
    cause instanceof Object &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
  );
}

function isSymbolicLinkPathError(cause: unknown): cause is NodeJS.ErrnoException {
  return (
    Boolean(cause) &&
    cause instanceof Object &&
    "code" in cause &&
    (cause.code === "ELOOP" || cause.code === "EINVAL")
  );
}
function safeIsoTimestamp(value: Date, fallback: () => Date): string {
  try {
    return value.toISOString();
  } catch {
    try {
      return fallback().toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  }
}
