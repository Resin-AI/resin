import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCiEnvironment,
  isInteractiveEnvironment,
  isMachineInitialized,
  isRootUser,
  main,
  shouldEnterFirstRunOnboarding,
} from "../src/bin/cli.js";
import { DEFAULT_DEVICE_AUTH_SCOPES } from "../src/service/auth-bootstrap.js";

const ACCESS_TOKEN = "access-token-test-value";
const REFRESH_TOKEN = "refresh-token-test-value";
const CLOUD_URL = "https://auth.resin.sh";

function createValidDeviceTokenJson(expiresInSeconds = 3600): string {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  return JSON.stringify({
    cloudUrl: CLOUD_URL,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    claims: {
      accountId: "acc_123",
      workspaceId: "ws_456",
      deviceId: "dev_789",
      installationId: "inst_789",
      userId: "usr_alice",
      subject: "usr_alice",
      scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
      rawUploadConsent: false,
      issuedAt,
      expiresAt,
      tokenType: "access",
    },
    deviceId: "dev_789",
    workspaceId: "ws_456",
    storedAt: issuedAt,
  });
}

function createExpiredDeviceTokenJson(): string {
  const issuedAt = new Date(Date.now() - 7_200_000).toISOString();
  const expiresAt = new Date(Date.now() - 3_600_000).toISOString();
  return JSON.stringify({
    cloudUrl: CLOUD_URL,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    claims: {
      accountId: "acc_123",
      workspaceId: "ws_456",
      deviceId: "dev_789",
      installationId: "inst_789",
      userId: "usr_alice",
      subject: "usr_alice",
      scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
      rawUploadConsent: false,
      issuedAt,
      expiresAt,
      tokenType: "access",
    },
    deviceId: "dev_789",
    workspaceId: "ws_456",
    storedAt: issuedAt,
  });
}

describe("npm-auto-onboard: fail-safe npm lifecycle & first-run onboarding", () => {
  let tempDir: string;
  let homeDir: string;
  let originalGetuid: typeof process.getuid;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-npm-onboard-test-"));
    homeDir = path.join(tempDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    originalGetuid = process.getuid;
    process.getuid = () => 1000;
  });

  afterEach(async () => {
    process.getuid = originalGetuid;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("environment detection", () => {
    it("identifies CI environments accurately across standard CI variables", () => {
      expect(isCiEnvironment({ CI: "true" })).toBe(true);
      expect(isCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
      expect(isCiEnvironment({ CONTINUOUS_INTEGRATION: "1" })).toBe(true);
      expect(isCiEnvironment({ BUILD_NUMBER: "42" })).toBe(true);
      expect(isCiEnvironment({ RUN_ID: "99" })).toBe(true);
      expect(isCiEnvironment({ GITLAB_CI: "true" })).toBe(true);
      expect(isCiEnvironment({ TRAVIS: "true" })).toBe(true);
      expect(isCiEnvironment({ CIRCLECI: "true" })).toBe(true);
      expect(isCiEnvironment({ JENKINS_URL: "http://jenkins.local" })).toBe(true);
      expect(isCiEnvironment({ DEBIAN_FRONTEND: "noninteractive" })).toBe(true);
      expect(isCiEnvironment({ RESIN_NON_INTERACTIVE: "1" })).toBe(true);
      expect(isCiEnvironment({})).toBe(false);
    });

    it("identifies root user", () => {
      const originalGetuid = process.getuid;
      try {
        process.getuid = () => 0;
        expect(isRootUser({})).toBe(true);

        process.getuid = () => 1000;
        expect(isRootUser({})).toBe(false);
        expect(isRootUser({ SUDO_USER: "alice" })).toBe(false);
      } finally {
        process.getuid = originalGetuid;
      }
    });

    it("evaluates interactivity correctly based on TTY, CI, root, and skip flags", () => {
      const ttyIn = { isTTY: true };
      const ttyOut = { isTTY: true };
      const nonTtyIn = { isTTY: false };
      const nonTtyOut = { isTTY: false };

      // Normal interactive terminal
      expect(isInteractiveEnvironment({}, ttyIn, ttyOut)).toBe(true);

      // Non-TTY
      expect(isInteractiveEnvironment({}, nonTtyIn, ttyOut)).toBe(false);
      expect(isInteractiveEnvironment({}, ttyIn, nonTtyOut)).toBe(false);

      // CI flag overrides TTY
      expect(isInteractiveEnvironment({ CI: "1" }, ttyIn, ttyOut)).toBe(false);

      // Local-only flag overrides TTY
      expect(isInteractiveEnvironment({ RESIN_LOCAL_ONLY: "1" }, ttyIn, ttyOut)).toBe(false);

      // Skip onboarding flag overrides TTY
      expect(isInteractiveEnvironment({ RESIN_SKIP_ONBOARDING: "1" }, ttyIn, ttyOut)).toBe(false);
      expect(isInteractiveEnvironment({ RESIN_SKIP_POSTINSTALL: "1" }, ttyIn, ttyOut)).toBe(false);
    });
  });

  describe("machine initialization check", () => {
    it("returns false when neither device token nor install journal exists", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const initialized = await isMachineInitialized({
        home: homeDir,
        fsBridge: bridge,
      });
      expect(initialized).toBe(false);
    });

    it("returns true when valid unexpired device credentials exist", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const tokenPath = path.join(homeDir, ".resin", "state", "device-token.json");
      await bridge.writeFile(tokenPath, createValidDeviceTokenJson());

      const initialized = await isMachineInitialized({
        home: homeDir,
        fsBridge: bridge,
      });
      expect(initialized).toBe(true);
    });

    it("returns false for an unexpired legacy family missing current privacy scopes", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const tokenPath = path.join(homeDir, ".resin", "state", "device-token.json");
      const legacyCredentials = JSON.parse(createValidDeviceTokenJson());
      legacyCredentials.claims.familyId = "fam_legacy_scope_family";
      legacyCredentials.claims.scopes = [
        "device:connect",
        "observations:write",
        "catalog:read",
        "artifacts:read",
      ];
      await bridge.writeFile(tokenPath, JSON.stringify(legacyCredentials));

      const initialized = await isMachineInitialized({
        home: homeDir,
        fsBridge: bridge,
      });
      expect(initialized).toBe(false);
    });

    it("returns false when device credentials are expired and no journal completed", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const tokenPath = path.join(homeDir, ".resin", "state", "device-token.json");
      await bridge.writeFile(tokenPath, createExpiredDeviceTokenJson());

      const initialized = await isMachineInitialized({
        home: homeDir,
        fsBridge: bridge,
      });
      expect(initialized).toBe(false);
    });

    it("returns true when prior installation journal is marked completed", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const journalPath = path.join(homeDir, ".resin", "state", "install-journal.json");
      await bridge.writeFile(
        journalPath,
        JSON.stringify({
          status: "completed",
          timestamp: new Date().toISOString(),
          steps: [],
        }),
      );

      const initialized = await isMachineInitialized({
        home: homeDir,
        fsBridge: bridge,
      });
      expect(initialized).toBe(true);
    });
  });

  describe("first-run onboarding trigger decision", () => {
    it("returns true for interactive, uninitialized environment", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const shouldOnboard = await shouldEnterFirstRunOnboarding({
        env: {},
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        home: homeDir,
        fsBridge: bridge,
      });
      expect(shouldOnboard).toBe(true);
    });

    it("returns false when CI environment is detected", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const shouldOnboard = await shouldEnterFirstRunOnboarding({
        env: { CI: "true" },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        home: homeDir,
        fsBridge: bridge,
      });
      expect(shouldOnboard).toBe(false);
    });

    it("returns false when stream is not a TTY", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const shouldOnboard = await shouldEnterFirstRunOnboarding({
        env: {},
        stdin: { isTTY: false },
        stdout: { isTTY: true },
        home: homeDir,
        fsBridge: bridge,
      });
      expect(shouldOnboard).toBe(false);
    });

    it("returns false when machine is already initialized", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const tokenPath = path.join(homeDir, ".resin", "state", "device-token.json");
      await bridge.writeFile(tokenPath, createValidDeviceTokenJson());

      const shouldOnboard = await shouldEnterFirstRunOnboarding({
        env: {},
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        home: homeDir,
        fsBridge: bridge,
      });
      expect(shouldOnboard).toBe(false);
    });
  });

  describe("main CLI routing & first-run entrypoint", () => {
    it("triggers automated onboarding when bare resin is executed on uninitialized interactive machine", async () => {
      const bridge = new InMemoryConfigFsBridge();
      let stdoutOutput = "";
      const stdout = {
        isTTY: true,
        write: (chunk: string) => {
          stdoutOutput += chunk;
          return true;
        },
      };

      const customFetch = vi
        .fn()
        .mockImplementation(async (url: string | URL, init?: RequestInit) => {
          const urlStr = String(url);
          if (urlStr.includes("/device/code")) {
            return Response.json({
              deviceCode: "device_code_1234567890abcdef",
              userCode: "ABCD-9876",
              verificationUri: "https://auth.resin.sh/device",
              verificationUriComplete: "https://auth.resin.sh/device?code=ABCD-9876",
              expiresIn: 900,
              interval: 1,
            });
          }
          if (urlStr.includes("/device/token")) {
            const body = init?.body && String(init.body) === init.body ? JSON.parse(init.body) : {};
            const deviceId = body.deviceId ?? "dev_789";
            const installationId = body.installationId ?? `inst_${deviceId}`;
            return Response.json({
              accessToken: ACCESS_TOKEN,
              refreshToken: REFRESH_TOKEN,
              tokenType: "Bearer",
              expiresIn: 3600,
              scope: DEFAULT_DEVICE_AUTH_SCOPES.join(" "),
              accountId: "acc_123",
              workspaceId: "ws_456",
              deviceId,
              claims: {
                accountId: "acc_123",
                workspaceId: "ws_456",
                deviceId,
                installationId,
                scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
                rawUploadConsent: false,
                issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
                tokenType: "access",
                subject: "usr_alice",
                userId: "usr_alice",
              },
            });
          }
          return new Response(null, { status: 404 });
        });

      const openBrowser = vi.fn().mockResolvedValue(true);

      const exitCode = await main([], {
        env: { RESIN_CLOUD_URL: CLOUD_URL },
        stdin: { isTTY: true },
        stdout,
        home: homeDir,
        // SAFETY: Mock fetch matching fetch interface for testing.
        customFetch: customFetch as typeof fetch,
        openBrowser,
        fsBridge: bridge,
      });

      expect(exitCode).toBe(0);
      expect(openBrowser).toHaveBeenCalledWith(
        expect.stringContaining("https://auth.resin.sh/device?code=ABCD-9876"),
      );
      expect(stdoutOutput).toContain("Resin installation completed successfully");
    });

    it("displays global help on bare resin in CI or non-interactive environment without triggering onboarding", async () => {
      let stdoutOutput = "";
      const stdout = {
        isTTY: true,
        write: (chunk: string) => {
          stdoutOutput += chunk;
          return true;
        },
      };

      const exitCode = await main([], {
        env: { CI: "true" },
        stdin: { isTTY: true },
        stdout,
        home: homeDir,
      });

      expect(exitCode).toBe(0);
      expect(stdoutOutput).toContain("Resin CLI");
      expect(stdoutOutput).toContain("Commands:");
      expect(stdoutOutput).toContain("init");
      expect(stdoutOutput).toContain("login");
    });

    it("displays global help on bare resin when machine is already initialized", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const tokenPath = path.join(homeDir, ".resin", "state", "device-token.json");
      await bridge.writeFile(tokenPath, createValidDeviceTokenJson());

      let stdoutOutput = "";
      const stdout = {
        isTTY: true,
        write: (chunk: string) => {
          stdoutOutput += chunk;
          return true;
        },
      };

      const exitCode = await main([], {
        env: {},
        stdin: { isTTY: true },
        stdout,
        home: homeDir,
        fsBridge: bridge,
      });

      expect(exitCode).toBe(0);
      expect(stdoutOutput).toContain("Resin CLI");
      expect(stdoutOutput).toContain("Commands:");
    });

    it("always displays help when explicit help flags are provided even on uninitialized interactive machine", async () => {
      const bridge = new InMemoryConfigFsBridge();

      for (const helpArg of ["help", "--help", "-h"]) {
        let stdoutOutput = "";
        const stdout = {
          isTTY: true,
          write: (chunk: string) => {
            stdoutOutput += chunk;
            return true;
          },
        };

        const exitCode = await main([helpArg], {
          env: {},
          stdin: { isTTY: true },
          stdout,
          home: homeDir,
          fsBridge: bridge,
        });

        expect(exitCode).toBe(0);
        expect(stdoutOutput).toContain("Resin CLI");
        expect(stdoutOutput).toContain("Usage:");
      }
    });

    it("displays version when version flags are provided", async () => {
      let stdoutOutput = "";
      const stdout = {
        isTTY: true,
        write: (chunk: string) => {
          stdoutOutput += chunk;
          return true;
        },
      };

      const exitCode = await main(["--version"], {
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stdoutOutput).toMatch(/^resin v/);
    });
  });
});
