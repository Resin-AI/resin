import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeviceReportingConfigRead,
  resolveErrorReportingConsent,
} from "../../src/error-reporting/consent.js";
import {
  peekAnonymousId,
  readCloudIdentity,
  readOrCreateAnonymousId,
} from "../../src/error-reporting/identity.js";
import {
  ErrorReporter,
  type ErrorReporterLike,
  LoggedError,
  RESIN_POSTHOG_DEFAULT_HOST,
  RESIN_POSTHOG_PROJECT_API_KEY,
  type ReportingClient,
  type ReportingMessage,
  bridgeErrorLogs,
  createSilentFetch,
  installCrashHandlers,
  isUsableProjectKey,
  logFingerprint,
  resetCrashHandlersForTesting,
  resolveReportingHost,
  resolveReportingKey,
  withErrorCapture,
} from "../../src/error-reporting/index.js";

const TEST_KEY = "phc_testKey0123456789abcdef";
/** Injected explicitly: tests never depend on (or send with) the shipped key. */
const PLACEHOLDER_KEY = "__RESIN_POSTHOG_PROJECT_API_KEY__";
const configured: DeviceReportingConfigRead = { state: "missing" };

describe("resolveErrorReportingConsent", () => {
  const enabledEnv = { RESIN_ERROR_REPORTING: "1" };
  const cases: Array<[string, NodeJS.ProcessEnv, DeviceReportingConfigRead, boolean, string]> = [
    ["defaults on outside tests", {}, configured, true, "enabled"],
    ["off under vitest", { VITEST: "true" }, configured, false, "test_environment"],
    ["off under NODE_ENV=test", { NODE_ENV: "test" }, configured, false, "test_environment"],
    ["forced on under tests", { VITEST: "true", ...enabledEnv }, configured, true, "enabled"],
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1", ...enabledEnv }, configured, false, "do_not_track"],
    ["DO_NOT_TRACK=true", { DO_NOT_TRACK: "true" }, configured, false, "do_not_track"],
    ["DO_NOT_TRACK=0 ignored", { DO_NOT_TRACK: "0" }, configured, true, "enabled"],
    [
      "RESIN_ERROR_REPORTING=0",
      { RESIN_ERROR_REPORTING: "0" },
      configured,
      false,
      "environment_disabled",
    ],
    [
      "RESIN_ERROR_REPORTING=off",
      { RESIN_ERROR_REPORTING: "off" },
      configured,
      false,
      "environment_disabled",
    ],
    [
      "RESIN_ERROR_REPORTING=false",
      { RESIN_ERROR_REPORTING: "FALSE" },
      configured,
      false,
      "environment_disabled",
    ],
    [
      "errorReportingEnabled false",
      enabledEnv,
      { state: "configured", config: { errorReportingEnabled: false } },
      false,
      "config_disabled",
    ],
    [
      "telemetryEnabled false",
      {},
      { state: "configured", config: { telemetryEnabled: false } },
      false,
      "telemetry_disabled",
    ],
    [
      "RESIN_TELEMETRY_ENABLED=0",
      { RESIN_TELEMETRY_ENABLED: "0" },
      configured,
      false,
      "telemetry_disabled",
    ],
    [
      "telemetry env overrides config like the daemon",
      { RESIN_TELEMETRY_ENABLED: "1" },
      { state: "configured", config: { telemetryEnabled: false } },
      true,
      "enabled",
    ],
    ["invalid config fails closed", {}, { state: "invalid" }, false, "config_unreadable"],
  ];

  it.each(cases)("%s", (_name, env, config, enabled, reason) => {
    expect(resolveErrorReportingConsent({ env, config })).toEqual({ enabled, reason });
  });
});

describe("keys and hosts", () => {
  it("treats the placeholder as unconfigured", () => {
    expect(isUsableProjectKey(PLACEHOLDER_KEY)).toBe(false);
    expect(resolveReportingKey({ RESIN_POSTHOG_KEY: PLACEHOLDER_KEY })).toBeUndefined();
    expect(resolveReportingKey({})).toBe(
      isUsableProjectKey(RESIN_POSTHOG_PROJECT_API_KEY) ? RESIN_POSTHOG_PROJECT_API_KEY : undefined,
    );
    expect(resolveReportingKey({ RESIN_POSTHOG_KEY: TEST_KEY })).toBe(TEST_KEY);
    expect(resolveReportingKey({ RESIN_POSTHOG_KEY: "not-a-key" })).toBeUndefined();
  });

  it("accepts only https or loopback host overrides", () => {
    expect(resolveReportingHost({})).toBe(RESIN_POSTHOG_DEFAULT_HOST);
    expect(resolveReportingHost({ RESIN_POSTHOG_HOST: "https://eu.i.posthog.com/" })).toBe(
      "https://eu.i.posthog.com",
    );
    expect(resolveReportingHost({ RESIN_POSTHOG_HOST: "http://127.0.0.1:8010" })).toBe(
      "http://127.0.0.1:8010",
    );
    expect(resolveReportingHost({ RESIN_POSTHOG_HOST: "http://evil.example" })).toBe(
      RESIN_POSTHOG_DEFAULT_HOST,
    );
  });
});

describe("identity", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-er-state-"));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("creates and persists one owner-only anonymous id", () => {
    expect(peekAnonymousId(stateDir)).toBeUndefined();
    const first = readOrCreateAnonymousId(stateDir);
    expect(first).toMatch(/^anon_[0-9a-f-]{36}$/);
    expect(readOrCreateAnonymousId(stateDir)).toBe(first);
    expect(peekAnonymousId(stateDir)).toBe(first);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(stateDir, "analytics-id")).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces a corrupt id file", () => {
    fs.writeFileSync(path.join(stateDir, "analytics-id"), "hostname-derived");
    expect(readOrCreateAnonymousId(stateDir)).toMatch(/^anon_/);
  });

  it("reads the cloud user id claim and never an e-mail", () => {
    const write = (claims: Record<string, string>) =>
      fs.writeFileSync(path.join(stateDir, "device-token.json"), JSON.stringify({ claims }));
    write({ userId: "usr_123", subject: "sub_1", accountId: "acc_1", workspaceId: "ws_1" });
    expect(readCloudIdentity(stateDir)).toEqual({
      userId: "usr_123",
      accountId: "acc_1",
      workspaceId: "ws_1",
    });
    write({ subject: "sub_9", accountId: "acc_1", workspaceId: "ws_1" });
    expect(readCloudIdentity(stateDir)?.userId).toBe("sub_9");
    write({ userId: "someone@example.com", accountId: "acc_1", workspaceId: "ws_1" });
    expect(readCloudIdentity(stateDir)).toBeUndefined();
  });
});

class FakeClient implements ReportingClient {
  readonly captured: ReportingMessage[] = [];
  readonly immediate: ReportingMessage[] = [];
  readonly aliases: Array<{ distinctId: string; alias: string }> = [];
  flushes = 0;
  capture(message: ReportingMessage): void {
    this.captured.push(message);
  }
  async captureImmediate(message: ReportingMessage): Promise<void> {
    this.immediate.push(message);
  }
  alias(data: { distinctId: string; alias: string }): void {
    this.aliases.push(data);
  }
  async flush(): Promise<void> {
    this.flushes += 1;
  }
}

describe("ErrorReporter", () => {
  let home: string;
  let client: FakeClient;
  let factory: ReturnType<typeof vi.fn<(config: { apiKey: string }) => ReportingClient>>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-er-home-"));
    client = new FakeClient();
    factory = vi.fn(() => client);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function reporter(env: NodeJS.ProcessEnv): ErrorReporter {
    return new ErrorReporter({
      surface: "cli",
      version: "1.2.3",
      env: { HOME: home, RESIN_HOME: path.join(home, ".resin"), ...env },
      home,
      projectRoot: path.join(home, "proj"),
      clientFactory: factory,
      transport: () => {
        throw new Error("network must not be used");
      },
    });
  }

  it("is a silent no-op with the placeholder key", async () => {
    const instance = reporter({ RESIN_POSTHOG_KEY: PLACEHOLDER_KEY, RESIN_ERROR_REPORTING: "1" });
    expect(instance.isEnabled()).toBe(false);
    instance.captureException(new Error("x"), { handled: true });
    instance.capture("cli_command_completed", { command: "status" });
    await instance.captureExceptionImmediate(new Error("y"), { handled: false });
    await instance.flush();
    expect(factory).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".resin", "state", "analytics-id"))).toBe(false);
  });

  it("is a no-op when consent is withdrawn", () => {
    const instance = reporter({ RESIN_POSTHOG_KEY: TEST_KEY, DO_NOT_TRACK: "1" });
    instance.captureException(new Error("x"), { handled: true });
    expect(factory).not.toHaveBeenCalled();
  });

  it("sends sanitized $exception events with common properties", () => {
    const instance = reporter({ RESIN_POSTHOG_KEY: TEST_KEY, RESIN_ERROR_REPORTING: "1" });
    const error = Object.assign(new Error(`failed at ${home}/proj/a.ts token=abc`), {
      code: "CONFIG_WRITE_FAILED",
    });
    instance.captureException(error, {
      handled: true,
      failureClass: "privacy_config",
      properties: { command: "privacy", secret_path: `${home}/x`, tool_id: "tool_1" },
    });
    instance.captureException(error, { handled: true });
    expect(client.captured).toHaveLength(1);
    const [message] = client.captured;
    expect(message?.event).toBe("$exception");
    expect(message?.distinctId).toMatch(/^anon_/);
    const props = message?.properties ?? {};
    expect(props).toMatchObject({
      resin_surface: "cli",
      resin_version: "1.2.3",
      os: process.platform,
      arch: process.arch,
      node_version: process.version,
      resin_error_code: "CONFIG_WRITE_FAILED",
      resin_failure_class: "privacy_config",
      $exception_handled: true,
      $exception_level: "error",
      command: "privacy",
      secret_path: "~/x",
      tool_id: "tool_1",
    });
    const list = props.$exception_list as Array<{ value: string; mechanism: { handled: boolean } }>;
    expect(list[0]?.value).toBe("failed at <project>/a.ts token=[REDACTED]");
    expect(list[0]?.mechanism.handled).toBe(true);
    expect(JSON.stringify(message)).not.toContain(home);
  });

  it("uses the paired cloud user id and groups, and aliases the anonymous id", () => {
    const instance = reporter({ RESIN_POSTHOG_KEY: TEST_KEY, RESIN_ERROR_REPORTING: "1" });
    instance.capture("before_pairing");
    const anonymousId = client.captured[0]?.distinctId;
    instance.identifyCloudUser({ userId: "usr_42", accountId: "acc_1", workspaceId: "ws_1" });
    instance.capture("after_pairing");
    expect(client.aliases).toEqual([{ distinctId: "usr_42", alias: anonymousId }]);
    expect(client.captured[1]).toMatchObject({
      distinctId: "usr_42",
      groups: { account: "acc_1", workspace: "ws_1" },
    });
  });

  it("never throws or writes to stdout when the client fails", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const broken: ReportingClient = {
      capture: () => {
        throw new Error("boom");
      },
      captureImmediate: async () => {
        throw new Error("boom");
      },
      alias: () => {
        throw new Error("boom");
      },
      flush: async () => {
        throw new Error("boom");
      },
    };
    const instance = new ErrorReporter({
      surface: "mcp_shim",
      version: "1",
      env: { RESIN_POSTHOG_KEY: TEST_KEY, RESIN_ERROR_REPORTING: "1", RESIN_HOME: home },
      home,
      clientFactory: () => broken,
    });
    expect(() => instance.captureException(new Error("x"), { handled: true })).not.toThrow();
    expect(() => instance.capture("e")).not.toThrow();
    await expect(instance.captureImmediate("e")).resolves.toBeUndefined();
    await expect(
      instance.captureExceptionImmediate(new Error("z"), { handled: false }),
    ).resolves.toBeUndefined();
    await expect(instance.flush()).resolves.toBeUndefined();
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it("withErrorCapture reports and rethrows the same value", async () => {
    const instance = reporter({ RESIN_POSTHOG_KEY: TEST_KEY, RESIN_ERROR_REPORTING: "1" });
    const error = new Error("original");
    await expect(
      withErrorCapture(
        async () => {
          throw error;
        },
        { handled: false },
        instance,
      ),
    ).rejects.toBe(error);
    expect(client.immediate).toHaveLength(1);
    expect(client.immediate[0]?.properties.$exception_handled).toBe(false);
    await expect(withErrorCapture(async () => 7, { handled: false }, instance)).resolves.toBe(7);
  });
});

describe("installCrashHandlers", () => {
  afterEach(() => {
    resetCrashHandlersForTesting();
  });

  it("does not install anything when reporting is disabled", () => {
    const before = process.listenerCount("uncaughtException");
    const disabled = new ErrorReporter({
      surface: "cli",
      version: "1",
      env: { RESIN_POSTHOG_KEY: PLACEHOLDER_KEY, RESIN_ERROR_REPORTING: "1" },
    });
    expect(installCrashHandlers(disabled)).toBe(false);
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  it("reports the crash, prints the stack and exits 1", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-er-crash-"));
    const client = new FakeClient();
    const instance = new ErrorReporter({
      surface: "daemon",
      version: "1",
      env: { RESIN_POSTHOG_KEY: TEST_KEY, RESIN_ERROR_REPORTING: "1", RESIN_HOME: home },
      home,
      clientFactory: () => client,
    });
    const exited = Promise.withResolvers<number>();
    const exit = vi.fn((code: number) => exited.resolve(code));
    const stderr = { write: vi.fn(() => true) };
    const existing = process.listeners("uncaughtException");
    expect(installCrashHandlers(instance, { exit, stderr })).toBe(true);
    const listener = process
      .listeners("uncaughtException")
      .find((candidate) => !existing.includes(candidate));
    const crash = new Error("crash");
    listener?.(crash, "uncaughtException");
    await expect(exited.promise).resolves.toBe(1);
    expect(client.immediate[0]?.properties).toMatchObject({
      $exception_handled: false,
      $exception_level: "fatal",
      resin_crash_origin: "uncaughtException",
    });
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("Error: crash"));
    expect(exit).toHaveBeenCalledTimes(1);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("createSilentFetch", () => {
  it("reports failures as delivered without throwing", async () => {
    const failing = createSilentFetch(async () => {
      throw new Error("offline");
    });
    await expect(
      failing("https://resin.sh/ingest/batch/", { method: "POST", headers: {} }),
    ).resolves.toMatchObject({ status: 200 });
    const rejected = createSilentFetch(async () => new Response("", { status: 500 }));
    await expect(
      rejected("https://resin.sh/ingest/batch/", { method: "POST", headers: {} }),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe("bridgeErrorLogs", () => {
  it("reports error logs as handled LoggedErrors, rate-limited per pattern", () => {
    const captured: Array<{ error: unknown; handled: boolean; fingerprint: unknown }> = [];
    const reporter: ErrorReporterLike = {
      surface: "daemon",
      isConfigured: () => true,
      isEnabled: () => true,
      consent: () => ({ enabled: true, reason: "enabled" }),
      captureException: (error, options) => {
        captured.push({
          error,
          handled: options.handled,
          fingerprint: options.properties?.$exception_fingerprint,
        });
      },
      captureExceptionImmediate: async () => undefined,
      capture: () => undefined,
      captureImmediate: async () => undefined,
      identifyCloudUser: () => undefined,
      submitFeedback: async () => false,
      flush: async () => undefined,
    };
    const logged: string[] = [];
    const base = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string) => {
        logged.push(message);
      },
    };
    const logger = bridgeErrorLogs(base, {
      reporter: () => reporter,
      now: () => 0,
    });
    for (let index = 0; index < 5; index += 1) {
      logger.error(`Failed to submit observation batch for generic session ses_${index}`, {
        error: "boom",
      });
    }
    logger.error("Failed to start module 'x': y");
    expect(logged).toHaveLength(6);
    expect(captured).toHaveLength(3);
    expect(captured[0]?.handled).toBe(true);
    expect(captured[0]?.error).toBeInstanceOf(LoggedError);
    expect(captured[0]?.fingerprint).toBe(
      `logged:${logFingerprint("Failed to submit observation batch for generic session ses_0")}`,
    );
    expect(logFingerprint("session ses_1 failed at 'a'")).toBe("session <x> failed at <x>");
  });
});
