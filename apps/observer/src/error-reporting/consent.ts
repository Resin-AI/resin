import fs from "node:fs";

/**
 * Error reporting and usage events are on by default. Any one of these switches turns them off:
 * `DO_NOT_TRACK`, `RESIN_ERROR_REPORTING=0`, `errorReportingEnabled: false` in the device config,
 * or disabled metadata telemetry (`resin privacy telemetry disable` / `RESIN_TELEMETRY_ENABLED=0`).
 * Test runners are off unless `RESIN_ERROR_REPORTING=1` forces reporting on.
 */
export type ErrorReportingConsentReason =
  | "enabled"
  | "do_not_track"
  | "environment_disabled"
  | "config_disabled"
  | "telemetry_disabled"
  | "config_unreadable"
  | "test_environment";

export interface ErrorReportingConsent {
  readonly enabled: boolean;
  readonly reason: ErrorReportingConsentReason;
}

export interface DeviceReportingConfig {
  readonly telemetryEnabled?: boolean;
  readonly errorReportingEnabled?: boolean;
}

/** `missing` is a fresh install (defaults apply); `invalid` fails closed. */
export type DeviceReportingConfigRead =
  | { readonly state: "missing" }
  | { readonly state: "invalid" }
  | { readonly state: "configured"; readonly config: DeviceReportingConfig };

const FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const TRUE_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/** `DO_NOT_TRACK` follows the consoledonottrack.com convention: any value but empty/0/false. */
export function isDoNotTrack(env: NodeJS.ProcessEnv): boolean {
  const value = normalized(env.DO_NOT_TRACK);
  return value !== undefined && value !== "0" && value !== "false";
}

/** `RESIN_ERROR_REPORTING`: true/false when explicitly set, null otherwise. */
export function parseErrorReportingEnv(env: NodeJS.ProcessEnv): boolean | null {
  const value = normalized(env.RESIN_ERROR_REPORTING);
  if (value === undefined) return null;
  if (FALSE_VALUES.has(value)) return false;
  if (TRUE_VALUES.has(value)) return true;
  return null;
}

/** Mirrors the daemon's `RESIN_TELEMETRY_ENABLED` parsing: set means "1"/"true" or off. */
function parseTelemetryEnv(env: NodeJS.ProcessEnv): boolean | null {
  if (env.RESIN_TELEMETRY_ENABLED === undefined) return null;
  return env.RESIN_TELEMETRY_ENABLED === "1" || env.RESIN_TELEMETRY_ENABLED === "true";
}

export function isTestEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    Boolean(env.VITEST) ||
    Boolean(env.VITEST_WORKER_ID) ||
    Boolean(env.JEST_WORKER_ID) ||
    env.NODE_ENV === "test"
  );
}

/**
 * The environment consent is judged on: an injected environment inherits the real process's
 * test-runner marker, so code under test never reports unless `RESIN_ERROR_REPORTING=1` forces it.
 */
export function withProcessTestMarker(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return isTestEnvironment(process.env) && !isTestEnvironment(env)
    ? { ...env, VITEST: "true" }
    : env;
}

export function readDeviceReportingConfig(configFile: string): DeviceReportingConfigRead {
  let contents: string;
  try {
    contents = fs.readFileSync(configFile, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid" };
    }
    const telemetryEnabled: unknown = Reflect.get(parsed, "telemetryEnabled");
    const errorReportingEnabled: unknown = Reflect.get(parsed, "errorReportingEnabled");
    return {
      state: "configured",
      config: {
        telemetryEnabled: typeof telemetryEnabled === "boolean" ? telemetryEnabled : undefined,
        errorReportingEnabled:
          typeof errorReportingEnabled === "boolean" ? errorReportingEnabled : undefined,
      },
    };
  } catch {
    return { state: "invalid" };
  }
}

export function resolveErrorReportingConsent(input: {
  env: NodeJS.ProcessEnv;
  config: DeviceReportingConfigRead;
}): ErrorReportingConsent {
  const { env, config } = input;
  if (isDoNotTrack(env)) return { enabled: false, reason: "do_not_track" };
  const explicit = parseErrorReportingEnv(env);
  if (explicit === false) return { enabled: false, reason: "environment_disabled" };
  if (config.state === "invalid") return { enabled: false, reason: "config_unreadable" };
  const device = config.state === "configured" ? config.config : {};
  if (device.errorReportingEnabled === false) return { enabled: false, reason: "config_disabled" };
  const telemetry = parseTelemetryEnv(env) ?? device.telemetryEnabled ?? true;
  if (!telemetry) return { enabled: false, reason: "telemetry_disabled" };
  if (explicit !== true && isTestEnvironment(env)) {
    return { enabled: false, reason: "test_environment" };
  }
  return { enabled: true, reason: "enabled" };
}

export function describeConsentReason(reason: ErrorReportingConsentReason): string {
  switch (reason) {
    case "enabled":
      return "enabled";
    case "do_not_track":
      return "disabled by DO_NOT_TRACK";
    case "environment_disabled":
      return "disabled by RESIN_ERROR_REPORTING";
    case "config_disabled":
      return "disabled (resin privacy error-reporting disable)";
    case "telemetry_disabled":
      return "disabled because metadata telemetry is disabled";
    case "config_unreadable":
      return "disabled because the device configuration is unreadable";
    case "test_environment":
      return "disabled under a test runner";
  }
}
