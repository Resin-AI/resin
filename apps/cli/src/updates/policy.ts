export const UPDATE_CHANNELS = ["stable", "beta", "nightly"] as const;

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const MIN_UPDATE_CHECK_INTERVAL_MINUTES = 5;
export const MAX_UPDATE_CHECK_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES = 360;

export interface UpdateMaintenanceWindow {
  /** Inclusive start time in 24-hour HH:mm form. */
  readonly start: string;
  /** Exclusive end time in 24-hour HH:mm form. May cross midnight. */
  readonly end: string;
  /** IANA time-zone name. UTC is used when omitted. */
  readonly timeZone?: string;
}

export interface UpdatePolicy {
  readonly autoUpdate: boolean;
  readonly channel: UpdateChannel;
  readonly checkIntervalMinutes: number;
  readonly maintenanceWindow: UpdateMaintenanceWindow | null;
  readonly allowDowngrades: boolean;
}

export const DEFAULT_UPDATE_POLICY: Readonly<UpdatePolicy> = Object.freeze({
  autoUpdate: true,
  channel: "stable",
  checkIntervalMinutes: DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES,
  maintenanceWindow: null,
  allowDowngrades: false,
});

export class UpdatePolicyValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "UpdatePolicyValidationError";
    this.path = path;
  }
}

interface UpdatePolicyPatch {
  autoUpdate?: boolean;
  channel?: UpdateChannel;
  checkIntervalMinutes?: number;
  maintenanceWindow?: UpdateMaintenanceWindow | null;
  allowDowngrades?: boolean;
}

const UPDATE_POLICY_KEYS: Readonly<Record<string, true>> = {
  autoUpdate: true,
  channel: true,
  checkIntervalMinutes: true,
  maintenanceWindow: true,
  allowDowngrades: true,
};
const MAINTENANCE_WINDOW_KEYS: Readonly<Record<string, true>> = {
  start: true,
  end: true,
  timeZone: true,
};
const CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function fail(path: string, message: string): never {
  throw new UpdatePolicyValidationError(path, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: Readonly<Record<string, true>>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowedKeys[key] !== true) {
      fail(`${path}.${key}`, "unknown property");
    }
  }
}

function parseClockTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !CLOCK_TIME_PATTERN.test(value)) {
    fail(path, "expected a 24-hour time in HH:mm form");
  }
  return value;
}

function parseTimeZone(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(path, "expected a non-empty IANA time-zone name");
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    fail(path, "expected a valid IANA time-zone name");
  }

  return value;
}

function parseMaintenanceWindow(value: unknown, path: string): UpdateMaintenanceWindow | null {
  if (value === null) {
    return null;
  }
  if (!isPlainRecord(value)) {
    fail(path, "expected null or an object");
  }

  rejectUnknownKeys(value, MAINTENANCE_WINDOW_KEYS, path);
  if (!("start" in value)) {
    fail(`${path}.start`, "required property is missing");
  }
  if (!("end" in value)) {
    fail(`${path}.end`, "required property is missing");
  }

  const start = parseClockTime(value.start, `${path}.start`);
  const end = parseClockTime(value.end, `${path}.end`);
  if (start === end) {
    fail(path, "start and end must describe a non-empty window");
  }

  if ("timeZone" in value) {
    return {
      start,
      end,
      timeZone: parseTimeZone(value.timeZone, `${path}.timeZone`),
    };
  }

  return { start, end };
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "beta" || value === "nightly";
}

function parsePolicyPatch(value: unknown, path: string): UpdatePolicyPatch {
  if (value === undefined) {
    return {};
  }
  if (!isPlainRecord(value)) {
    fail(path, "expected an object");
  }

  rejectUnknownKeys(value, UPDATE_POLICY_KEYS, path);
  const patch: UpdatePolicyPatch = {};

  if ("autoUpdate" in value) {
    if (typeof value.autoUpdate !== "boolean") {
      fail(`${path}.autoUpdate`, "expected a boolean");
    }
    patch.autoUpdate = value.autoUpdate;
  }

  if ("channel" in value) {
    if (!isUpdateChannel(value.channel)) {
      fail(`${path}.channel`, `expected one of ${UPDATE_CHANNELS.join(", ")}`);
    }
    patch.channel = value.channel;
  }

  if ("checkIntervalMinutes" in value) {
    const interval = value.checkIntervalMinutes;
    if (typeof interval !== "number" || !Number.isSafeInteger(interval)) {
      fail(`${path}.checkIntervalMinutes`, "expected a whole number of minutes");
    }
    if (
      interval < MIN_UPDATE_CHECK_INTERVAL_MINUTES ||
      interval > MAX_UPDATE_CHECK_INTERVAL_MINUTES
    ) {
      fail(
        `${path}.checkIntervalMinutes`,
        `expected ${MIN_UPDATE_CHECK_INTERVAL_MINUTES}..${MAX_UPDATE_CHECK_INTERVAL_MINUTES}`,
      );
    }
    patch.checkIntervalMinutes = interval;
  }

  if ("maintenanceWindow" in value) {
    patch.maintenanceWindow = parseMaintenanceWindow(
      value.maintenanceWindow,
      `${path}.maintenanceWindow`,
    );
  }

  if ("allowDowngrades" in value) {
    if (typeof value.allowDowngrades !== "boolean") {
      fail(`${path}.allowDowngrades`, "expected a boolean");
    }
    patch.allowDowngrades = value.allowDowngrades;
  }

  return patch;
}

function cloneMaintenanceWindow(
  window: UpdateMaintenanceWindow | null,
): UpdateMaintenanceWindow | null {
  if (window === null) {
    return null;
  }
  return window.timeZone === undefined
    ? { start: window.start, end: window.end }
    : { start: window.start, end: window.end, timeZone: window.timeZone };
}

/**
 * Strictly parses an updates configuration object and fills omitted fields from
 * the safe defaults. Unknown properties and explicit undefined values fail.
 */
export function parseUpdatePolicy(value: unknown = undefined): UpdatePolicy {
  return mergeUpdatePolicy(value);
}

/**
 * Applies policy layers from left to right. Every layer is independently
 * validated, so merging cannot hide an invalid or misspelled setting.
 */
export function mergeUpdatePolicy(...layers: readonly unknown[]): UpdatePolicy {
  let policy: UpdatePolicy = {
    ...DEFAULT_UPDATE_POLICY,
    maintenanceWindow: null,
  };

  for (let index = 0; index < layers.length; index += 1) {
    const patch = parsePolicyPatch(layers[index], `updates layer ${index + 1}`);
    policy = {
      autoUpdate: patch.autoUpdate ?? policy.autoUpdate,
      channel: patch.channel ?? policy.channel,
      checkIntervalMinutes: patch.checkIntervalMinutes ?? policy.checkIntervalMinutes,
      maintenanceWindow:
        patch.maintenanceWindow === undefined
          ? cloneMaintenanceWindow(policy.maintenanceWindow)
          : cloneMaintenanceWindow(patch.maintenanceWindow),
      allowDowngrades: patch.allowDowngrades ?? policy.allowDowngrades,
    };
  }

  return policy;
}
