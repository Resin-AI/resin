import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "@resin/observer";
import {
  type ErrorReporterLike,
  RESIN_POSTHOG_PROJECT_API_KEY,
  type ReportingTransport,
  resolveReportingKey,
} from "@resin/observer/error-reporting/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feedbackCommand } from "../src/commands/feedback.js";
import { privacyCommand, readErrorReportingStatus } from "../src/commands/privacy.js";
import { commandSurface, describeCommandPath } from "../src/error-reporting.js";
import {
  INSTALL_ANALYTICS_ID_ENV,
  INSTALL_TELEMETRY_OWNER_ENV,
  createInstallTelemetry,
  installFailureReason,
} from "../src/installer/install-telemetry.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const TEST_KEY = "phc_testKey0123456789abcdef";
const homes: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-cli-er-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function output() {
  const chunks: string[] = [];
  return {
    writer: {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(""),
  };
}

describe("describeCommandPath", () => {
  it("never includes argument values", () => {
    expect(describeCommandPath(["privacy", "telemetry", "disable"])).toBe("privacy telemetry");
    expect(describeCommandPath(["service", "restart", "--home", "/home/me"])).toBe(
      "service restart",
    );
    expect(describeCommandPath(["feedback", "my", "secret", "text"])).toBe("feedback");
    expect(describeCommandPath(["init", "--cloud-url=https://x"])).toBe("init");
    expect(describeCommandPath(["/home/me/typo"])).toBe("(unknown)");
    expect(describeCommandPath([])).toBe("(none)");
    expect(describeCommandPath(["--version"])).toBe("version");
  });

  it("reports the MCP gateway as the mcp_shim surface", () => {
    expect(commandSurface(["mcp"])).toBe("mcp_shim");
    expect(commandSurface(["-v", "status"])).toBe("cli");
  });
});

function fakeReporter(overrides: Partial<ErrorReporterLike> = {}): ErrorReporterLike {
  return {
    surface: "cli",
    isConfigured: () => true,
    isEnabled: () => true,
    consent: () => ({ enabled: true, reason: "enabled" }),
    captureException: () => undefined,
    captureExceptionImmediate: async () => undefined,
    capture: () => undefined,
    captureImmediate: async () => undefined,
    identifyCloudUser: () => undefined,
    submitFeedback: async () => true,
    flush: async () => undefined,
    ...overrides,
  };
}

describe("resin feedback", () => {
  it("submits the message and confirms", async () => {
    const submitFeedback = vi.fn(async () => true);
    const stdout = output();
    const code = await feedbackCommand(["works", "great"], {
      reporter: fakeReporter({ submitFeedback }),
      stdout: stdout.writer,
      stderr: output().writer,
    });
    expect(code).toBe(0);
    expect(submitFeedback).toHaveBeenCalledWith("works great");
    expect(stdout.text()).toContain("Thanks");
  });

  it("refuses and explains when reporting is disabled", async () => {
    const submitFeedback = vi.fn(async () => true);
    const stderr = output();
    const code = await feedbackCommand(["hello"], {
      reporter: fakeReporter({
        submitFeedback,
        consent: () => ({ enabled: false, reason: "do_not_track" }),
      }),
      stdout: output().writer,
      stderr: stderr.writer,
    });
    expect(code).toBe(1);
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(stderr.text()).toContain("DO_NOT_TRACK");
  });

  it("does nothing in an unconfigured build", async () => {
    const stderr = output();
    const code = await feedbackCommand(["hello"], { stderr: stderr.writer });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("not available");
  });

  it("prints usage without a message", async () => {
    const stderr = output();
    expect(await feedbackCommand([], { stderr: stderr.writer })).toBe(1);
    expect(stderr.text()).toContain("resin feedback <message...>");
  });
});

describe("resin privacy error-reporting", () => {
  it("disables and re-enables atomically in the device config", async () => {
    const home = tempHome();
    const env = {};
    const configFile = resolvePaths({ home, env }).configFile;
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ telemetryEnabled: true, logLevel: "info" }));

    const stdout = output();
    expect(
      await privacyCommand(["error-reporting", "disable"], {
        home,
        env,
        stdout: stdout.writer,
        stderr: output().writer,
      }),
    ).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile, "utf8"))).toEqual({
      telemetryEnabled: true,
      logLevel: "info",
      errorReportingEnabled: false,
    });
    expect(readErrorReportingStatus({ home, env })).toMatchObject({
      enabled: false,
      reason: "config_disabled",
      configured: false,
    });

    const json = output();
    expect(
      await privacyCommand(["error-reporting", "enable", "--json"], {
        home,
        env,
        stdout: json.writer,
        stderr: output().writer,
      }),
    ).toBe(0);
    expect(JSON.parse(json.text())).toMatchObject({
      ok: true,
      command: "error-reporting",
      configured: true,
      reason: "enabled",
      available: resolveReportingKey({}) !== undefined,
    });
  });

  it("reports telemetry opt-out as disabling error reporting", async () => {
    const home = tempHome();
    const stdout = output();
    await privacyCommand(["error-reporting", "status"], {
      home,
      env: { RESIN_TELEMETRY_ENABLED: "0" },
      stdout: stdout.writer,
      stderr: output().writer,
    });
    expect(stdout.text()).toContain("metadata telemetry is disabled");
  });

  it("rejects unknown sub-commands", async () => {
    const stderr = output();
    expect(
      await privacyCommand(["error-reporting", "maybe"], {
        env: {},
        stdout: output().writer,
        stderr: stderr.writer,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("error-reporting enable|disable|status");
  });
});

describe("install telemetry", () => {
  it("makes no request with the placeholder key", async () => {
    const fetchImpl = vi.fn<ReportingTransport>();
    const home = tempHome();
    await createInstallTelemetry({
      resinHome: path.join(home, ".resin"),
      env: { RESIN_POSTHOG_KEY: "__RESIN_POSTHOG_PROJECT_API_KEY__", RESIN_ERROR_REPORTING: "1" },
      transport: fetchImpl,
    }).send("install_started", { step: "helper" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a sanitized event and adopts the shell's anonymous id", async () => {
    const fetchImpl = vi.fn<ReportingTransport>(async () => ({
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    }));
    const home = tempHome();
    const resinHome = path.join(home, ".resin");
    const shellId = "anon_12345678-1234-4234-8234-123456789abc";
    const telemetry = createInstallTelemetry({
      resinHome,
      version: "1.2.3",
      env: {
        RESIN_POSTHOG_KEY: TEST_KEY,
        RESIN_ERROR_REPORTING: "1",
        [INSTALL_TELEMETRY_OWNER_ENV]: "bootstrap",
        [INSTALL_ANALYTICS_ID_ENV]: shellId,
      },
      transport: fetchImpl,
    });
    expect(telemetry.ownedByShell).toBe(true);
    await telemetry.send("install_failed", {
      step: "helper",
      exit_code: 1,
      reason: installFailureReason(new Error(`EACCES ${home}/x token=abc`)),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://resin.sh/ingest/i/v0/e/");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      api_key: TEST_KEY,
      event: "install_failed",
      distinct_id: shellId,
      properties: { step: "helper", exit_code: 1, resin_surface: "installer" },
    });
    expect(body.properties.reason).not.toContain("abc");
    expect(fs.readFileSync(path.join(resinHome, "state", "analytics-id"), "utf8").trim()).toBe(
      shellId,
    );
  });

  it("respects DO_NOT_TRACK and never throws on network failure", async () => {
    const home = tempHome();
    const blocked = vi.fn<ReportingTransport>();
    await createInstallTelemetry({
      resinHome: home,
      env: { RESIN_POSTHOG_KEY: TEST_KEY, RESIN_ERROR_REPORTING: "1", DO_NOT_TRACK: "1" },
      transport: blocked,
    }).send("install_started");
    expect(blocked).not.toHaveBeenCalled();

    const failing = vi.fn<ReportingTransport>(async () => {
      throw new Error("offline");
    });
    await expect(
      createInstallTelemetry({
        resinHome: home,
        env: { RESIN_POSTHOG_KEY: TEST_KEY, RESIN_ERROR_REPORTING: "1" },
        transport: failing,
      }).send("install_started"),
    ).resolves.toBeUndefined();
  });
});

describe("single source of truth for the PostHog project key", () => {
  it("installers carry exactly the key in facade.ts", () => {
    const literal = `"${RESIN_POSTHOG_PROJECT_API_KEY}"`;
    const sh = fs.readFileSync(path.join(repoRoot, "apps/cli/install/install.sh"), "utf8");
    const ps1 = fs.readFileSync(path.join(repoRoot, "apps/cli/install/install.ps1"), "utf8");
    expect(sh).toContain(`RESIN_POSTHOG_PROJECT_API_KEY=${literal}`);
    expect(ps1).toContain(`$RESIN_POSTHOG_PROJECT_API_KEY = ${literal}`);
    const helper = fs.readFileSync(
      path.join(repoRoot, "apps/cli/install/install-helper-v1.mjs"),
      "utf8",
    );
    expect(helper).toContain(literal);
    for (const source of [sh, ps1, helper]) {
      expect(source.match(/phc_[A-Za-z0-9_-]{16,}/g) ?? []).toEqual(
        RESIN_POSTHOG_PROJECT_API_KEY.startsWith("phc_") ? [RESIN_POSTHOG_PROJECT_API_KEY] : [],
      );
    }
  });
});
