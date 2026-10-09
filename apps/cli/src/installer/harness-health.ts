import { createHash, randomUUID } from "node:crypto";
import { type Stats, constants as fsConstants, realpathSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "@resin/contracts";
import { NodeConfigFsBridge, resolveHarnessUserHome } from "@resin/harness-contracts";
import { z } from "zod";
import {
  SUPPORTED_HARNESS_IDS,
  getHarnessDefinition,
  isSupportedHarnessId,
} from "../harness-registry.js";
import { resolveHarnessConfigPath } from "./harness-config.js";
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
/**
 * How often the resident scheduler looks for changed harness files. A look that finds no change
 * costs a settings read, a state read and a few `stat` calls; a full check runs only when a
 * fingerprinted file changed or {@link HARNESS_HEALTH_CHECK_INTERVAL_MS} elapsed. Another tool
 * that rewrites a harness config and drops Resin is thereby repaired within seconds, before most
 * new harness sessions start without Resin.
 */
export const HARNESS_HEALTH_POLL_INTERVAL_MS = 15_000;
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

/**
 * File fingerprints: the MCP config under the harness id, and each guidance or install-extension
 * file under `<harness id>:<path digest>`. A missing key reads as absent.
 */
export type HarnessHealthConfigFiles = Readonly<Partial<Record<string, HarnessConfigHealthCache>>>;

export interface HarnessHealthHarnessSnapshot {
  readonly harnessId: HarnessId;
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
  /** Harnesses the user removed Resin from on purpose; never checked or repaired. */
  readonly disabledHarnesses?: readonly HarnessId[];
  readonly success: boolean;
  readonly hasDrift: boolean;
  readonly configFiles: HarnessHealthConfigFiles;
  readonly harnesses: readonly HarnessHealthHarnessSnapshot[];
  readonly lastFailure?: HarnessHealthFailureSnapshot;
}

export interface HarnessHealthSettings {
  readonly format: typeof HARNESS_HEALTH_SETTINGS_FORMAT;
  readonly autoRepair: boolean;
  /**
   * Harness ids the user removed Resin from with `resin uninstall --harness`. Resin never
   * re-registers them on its own; `resin init --harness <id>` clears the entry. Ids this build
   * does not know are kept so a newer build's choices survive a downgrade.
   */
  readonly disabledHarnesses: readonly string[];
  readonly diagnostic?: HarnessHealthSettingsDiagnostic;
}

export interface HarnessHealthSettingsChange {
  readonly autoRepair?: boolean;
  /** Records a user opt-out for these harnesses. */
  readonly disableHarnesses?: readonly HarnessId[];
  /** Clears a user opt-out for these harnesses. */
  readonly enableHarnesses?: readonly HarnessId[];
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
  readonly installedHarnesses?: readonly HarnessId[];
  readonly harnesses?: readonly HarnessId[];
  readonly now?: () => Date;
  readonly statFile?: HarnessConfigStatReader;
}

export interface HarnessHealthRunOptions {
  readonly trigger?: HarnessHealthTrigger;
  readonly force?: boolean;
  readonly autoRepair?: boolean;
  readonly installedHarnesses?: readonly HarnessId[];
  readonly harnesses?: readonly HarnessId[];
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

const HarnessIdSchema = z.custom<HarnessId>(isSupportedHarnessId);
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
    disabledHarnesses: z.array(HarnessIdSchema).max(64).optional(),
    success: z.boolean(),
    hasDrift: z.boolean(),
    configFiles: z.record(z.string(), HarnessConfigHealthCacheSchema),
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
    disabledHarnesses: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u))
      .max(64)
      .optional(),
  })
  .strict();

const ABSENT_CONFIG_FILE: HarnessConfigHealthCache = { present: false, mtimeMs: null };

const EMPTY_CONFIG_CACHE: HarnessHealthConfigFiles = Object.fromEntries(
  SUPPORTED_HARNESS_IDS.map((harnessId) => [harnessId, ABSENT_CONFIG_FILE]),
);

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
        displayName: getHarnessDefinition(snapshot.harnessId).displayName,
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
    disabledHarnesses: [],
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
      disabledHarnesses: [],
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
  if (!parsed.success) {
    return failClosedHarnessHealthSettings("settings_invalid");
  }
  return {
    format: parsed.data.format,
    autoRepair: parsed.data.autoRepair,
    disabledHarnesses: [...new Set(parsed.data.disabledHarnesses ?? [])].sort(),
  };
}

export async function saveHarnessHealthSettings(
  autoRepair: boolean,
  options: {
    readonly home?: string;
    readonly settingsPath?: string;
    readonly fsBridge?: HarnessReconcileFsBridge;
  } = {},
): Promise<HarnessHealthSettings> {
  return updateHarnessHealthSettings({ autoRepair }, options);
}

/**
 * Read-modify-write of the harness health settings under the settings file lock. Fields the
 * change leaves unset keep their stored value; an unreadable or invalid file contributes its
 * fail-closed values (automatic repair off, no opt-outs).
 */
export async function updateHarnessHealthSettings(
  change: HarnessHealthSettingsChange,
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
  const nodeBridge = isNodeHarnessSettingsBridge(bridge);
  let saved: HarnessHealthSettings | undefined;
  const persist = async (): Promise<void> => {
    const current = await loadHarnessHealthSettings({ settingsPath, fsBridge: bridge });
    const disabled = new Set(current.disabledHarnesses);
    for (const harnessId of change.disableHarnesses ?? []) disabled.add(harnessId);
    for (const harnessId of change.enableHarnesses ?? []) disabled.delete(harnessId);
    const settings: HarnessHealthSettings = {
      format: HARNESS_HEALTH_SETTINGS_FORMAT,
      autoRepair: change.autoRepair ?? current.autoRepair,
      disabledHarnesses: [...disabled].sort(),
    };
    // An empty opt-out list is left out so builds that predate opt-outs still read the file.
    const stored =
      settings.disabledHarnesses.length === 0
        ? { format: settings.format, autoRepair: settings.autoRepair }
        : settings;
    const content = `${JSON.stringify(stored, null, 2)}\n`;
    if (nodeBridge) {
      await writeNodeHarnessHealthSettings(settingsPath, content);
    } else {
      await bridge.mkdirp(path.dirname(settingsPath));
      await bridge.writeFile(settingsPath, content);
    }
    saved = settings;
  };

  if (nodeBridge) {
    await readNodeHarnessHealthSettingsWriteStat(settingsPath);
  }
  if (bridge.withFileLock) {
    await bridge.withFileLock(settingsPath, persist);
  } else {
    await persist();
  }
  if (saved === undefined) {
    throw new Error("Harness health settings were not written");
  }
  return saved;
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
  private readonly installedHarnesses: readonly HarnessId[] | undefined;
  private readonly harnesses: readonly HarnessId[];
  private readonly now: () => Date;
  private readonly statFile: HarnessConfigStatReader;
  private inFlight: Promise<HarnessHealthRunResult> | null = null;

  constructor(options: HarnessHealthCoordinatorOptions = {}) {
    this.home = path.resolve(
      options.home ?? resolveHarnessUserHome({ env: options.env ?? process.env }),
    );
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
    const disabledHarnesses = SUPPORTED_HARNESS_IDS.filter((harnessId) =>
      settings.disabledHarnesses.includes(harnessId),
    );
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

      const fullCheckDue =
        options.force === true ||
        previous === null ||
        isFullHarnessHealthCheckDue(
          previous,
          autoRepair,
          settingsDiagnostic,
          disabledHarnesses,
          attemptedAt.getTime(),
          this.checkIntervalMs,
        );
      // A harness the user removed Resin from on purpose is left alone, by every trigger.
      const requested = (options.harnesses ?? this.harnesses).filter(
        (harnessId) => !disabledHarnesses.includes(harnessId),
      );
      // Between full checks only harnesses whose files changed are checked, without probing
      // their installation when the config file exists: a harness that rewrites its own config
      // on every session (Claude Code's ~/.claude.json) costs one read and parse per poll.
      const changed =
        fullCheckDue || previous === null
          ? null
          : changedHarnessIds(previous.configFiles, configFiles).filter((harnessId) =>
              requested.includes(harnessId),
            );
      if (changed !== null && changed.length === 0) {
        return { status: "debounced", snapshot: previous };
      }
      const scope = changed ?? requested;
      const installedHarnesses =
        changed === null
          ? (options.installedHarnesses ?? this.installedHarnesses)
          : [
              ...new Set([
                ...(options.installedHarnesses ?? this.installedHarnesses ?? []),
                ...changed.filter((harnessId) => configFiles[harnessId]?.present === true),
              ]),
            ];

      const report = await this.reconciler.reconcile({
        autoRepair,
        harnesses: scope,
        installedHarnesses,
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
      const checkedHarnesses = sanitizeHarnessResults(report, previous, checkedAt);
      const snapshot: HarnessHealthSnapshot =
        changed === null || previous === null
          ? {
              format: HARNESS_HEALTH_STATE_FORMAT,
              checkedAt,
              trigger,
              autoRepair,
              settingsDiagnostic,
              ...(disabledHarnesses.length > 0 ? { disabledHarnesses } : {}),
              success: report.success,
              hasDrift: report.hasDrift,
              configFiles: postCheckConfigFiles,
              harnesses: checkedHarnesses,
            }
          : mergePartialHarnessCheck(previous, {
              trigger,
              success: report.success,
              checked: changed,
              checkedHarnesses,
              // Unchecked harnesses keep the fingerprints they had before this check, so a change
              // landing while it ran is still seen by the next poll.
              configFiles: mergeFingerprints(configFiles, postCheckConfigFiles, changed),
            });

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
    const targets: Array<readonly [string, string]> = [];
    for (const harnessId of SUPPORTED_HARNESS_IDS) {
      targets.push([harnessId, resolveHarnessConfigPath(harnessId, this.home, this.env)]);
      for (const artifactPath of resolveHarnessArtifactPaths(harnessId, this.home, this.env)) {
        targets.push([`${harnessId}:${digestPath(artifactPath)}`, artifactPath]);
      }
    }
    const entries = await Promise.all(
      targets.map(async ([key, filePath]) => {
        const present = await this.fsBridge.exists(filePath);
        if (!present) {
          return [key, ABSENT_CONFIG_FILE] as const;
        }

        const fileStat = await this.statFile(filePath);
        return [
          key,
          {
            present: true,
            mtimeMs:
              fileStat === null || !Number.isFinite(fileStat.mtimeMs) ? null : fileStat.mtimeMs,
          },
        ] as const;
      }),
    );

    return Object.fromEntries(entries);
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
      : HARNESS_HEALTH_POLL_INTERVAL_MS;
  let stopped = false;
  const dispatch = (trigger: "startup" | "scheduled"): void => {
    if (stopped) {
      return;
    }
    void runBoundedHarnessHealthCheck({
      runner,
      trigger,
      // The daemon starts after an install, an upgrade or a reboot. A new release can carry new
      // managed hooks or extension content that only a full check installs: the file-change
      // debounce sees nothing changed, so without this they would wait for the hourly check.
      force: trigger === "startup",
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
  const seen = new Set<HarnessId>();

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
      displayName: getHarnessDefinition(result.harnessId).displayName,
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

function isFullHarnessHealthCheckDue(
  previous: HarnessHealthSnapshot,
  autoRepair: boolean,
  settingsDiagnostic: HarnessHealthSettingsDiagnostic | undefined,
  disabledHarnesses: readonly HarnessId[],
  nowMs: number,
  intervalMs: number,
): boolean {
  const previouslyDisabled = previous.disabledHarnesses ?? [];
  if (
    previous.checkedAt === null ||
    previous.autoRepair !== autoRepair ||
    previous.settingsDiagnostic !== settingsDiagnostic ||
    previouslyDisabled.length !== disabledHarnesses.length ||
    previouslyDisabled.some((harnessId) => !disabledHarnesses.includes(harnessId))
  ) {
    return true;
  }

  const checkedAtMs = Date.parse(previous.checkedAt);
  const elapsedMs = nowMs - checkedAtMs;
  return !Number.isFinite(checkedAtMs) || elapsedMs < 0 || elapsedMs >= intervalMs;
}

/**
 * The guidance file and install-extension files Resin keeps for `harnessId`, other than its MCP
 * config. A path an adapter cannot resolve is left out.
 */
function resolveHarnessArtifactPaths(
  harnessId: HarnessId,
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const definition = getHarnessDefinition(harnessId);
  const paths = new Set<string>();
  const add = (resolve: () => readonly string[]): void => {
    try {
      for (const artifactPath of resolve()) paths.add(path.resolve(artifactPath));
    } catch {
      // An unresolvable artifact is still repaired by the hourly full check.
    }
  };
  const { guidance } = definition;
  if (guidance !== undefined) add(() => [guidance.resolvePath(home, env)]);
  for (const extension of definition.installExtensions ?? []) {
    const { watchPaths } = extension;
    if (watchPaths !== undefined) add(() => watchPaths.call(extension, home, env));
  }
  paths.delete(path.resolve(resolveHarnessConfigPath(harnessId, home, env)));
  return [...paths].sort();
}

/** Stable key part for a fingerprinted artifact; persisted state never holds the path itself. */
function digestPath(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function harnessIdOfFingerprintKey(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? key : key.slice(0, separator);
}

function changedHarnessIds(
  previous: HarnessHealthConfigFiles,
  current: HarnessHealthConfigFiles,
): HarnessId[] {
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = previous[key] ?? ABSENT_CONFIG_FILE;
    const after = current[key] ?? ABSENT_CONFIG_FILE;
    if (before.present !== after.present || before.mtimeMs !== after.mtimeMs) {
      changed.add(harnessIdOfFingerprintKey(key));
    }
  }
  return SUPPORTED_HARNESS_IDS.filter((harnessId) => changed.has(harnessId));
}

function mergeFingerprints(
  before: HarnessHealthConfigFiles,
  after: HarnessHealthConfigFiles,
  checked: readonly HarnessId[],
): HarnessHealthConfigFiles {
  const checkedIds = new Set<string>(checked);
  const merged: Record<string, HarnessConfigHealthCache> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const source = checkedIds.has(harnessIdOfFingerprintKey(key)) ? after : before;
    merged[key] = source[key] ?? ABSENT_CONFIG_FILE;
  }
  return merged;
}

/**
 * Folds a check of only `checked` harnesses into the last full snapshot. `checkedAt` stays the
 * last full check's, so the hourly full check keeps its cadence.
 */
function mergePartialHarnessCheck(
  previous: HarnessHealthSnapshot,
  partial: {
    readonly trigger: HarnessHealthTrigger;
    readonly success: boolean;
    readonly checked: readonly HarnessId[];
    readonly checkedHarnesses: readonly HarnessHealthHarnessSnapshot[];
    readonly configFiles: HarnessHealthConfigFiles;
  },
): HarnessHealthSnapshot {
  const byId = new Map(previous.harnesses.map((snapshot) => [snapshot.harnessId, snapshot]));
  for (const harnessId of partial.checked) byId.delete(harnessId);
  for (const snapshot of partial.checkedHarnesses) byId.set(snapshot.harnessId, snapshot);
  const harnesses = SUPPORTED_HARNESS_IDS.flatMap((harnessId) => byId.get(harnessId) ?? []);
  return {
    ...previous,
    trigger: partial.trigger,
    success: previous.success && partial.success,
    hasDrift: harnesses.some(
      (snapshot) =>
        snapshot.installed &&
        (snapshot.status === "unregistered" || snapshot.status === "drift_detected"),
    ),
    configFiles: partial.configFiles,
    harnesses,
  };
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
