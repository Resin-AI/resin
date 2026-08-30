import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DaemonConfigSchema,
  IMMUTABLE_CONFIG_FIELDS,
  loadDaemonConfig,
  parseEnvConfig,
  redactConfig,
  redactSensitiveData,
  validateConfigUpdate,
} from "../src/config.js";
import type { JsonObject } from "../src/normalization/redaction.js";

describe("config", () => {
  describe("DaemonConfigSchema defaults and validation", () => {
    it("provides expected default values", () => {
      const config = DaemonConfigSchema.parse({});
      expect(config.version).toBe("0.1.0");
      expect(config.logLevel).toBe("info");
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(9400);
      expect(config.cloudUrl).toBe("https://api.resin.sh");
      expect(config.telemetryEnabled).toBe(true);
      expect(config.heartbeatIntervalMs).toBe(3000);
      expect(config.lockStaleThresholdMs).toBe(15000);
      expect(config.shutdownTimeoutMs).toBe(10000);
      expect(config.maxWorkerMemoryMb).toBe(512);
      expect(config.workerExecutionTimeoutMs).toBe(30000);
    });

    it("rejects invalid port numbers", () => {
      expect(() => DaemonConfigSchema.parse({ port: -1 })).toThrow();
      expect(() => DaemonConfigSchema.parse({ port: 70000 })).toThrow();
    });

    it("rejects invalid log levels", () => {
      expect(() => DaemonConfigSchema.parse({ logLevel: "invalid_level" })).toThrow();
    });
  });

  describe("parseEnvConfig", () => {
    it("parses and maps RESIN_* environment variables", () => {
      const mockEnv = {
        RESIN_LOG_LEVEL: "debug",
        RESIN_HOST: "0.0.0.0",
        RESIN_PORT: "8080",
        RESIN_SOCKET_PATH: "/custom/socket.sock",
        RESIN_AUTH_TOKEN: "secret-token-123",
        RESIN_CLOUD_URL: "https://cloud.custom.dev",
        RESIN_TELEMETRY_ENABLED: "1",
        RESIN_STORAGE_DIR: "/custom/storage",
        RESIN_SHUTDOWN_TIMEOUT_MS: "5000",
        RESIN_MAX_WORKER_MEMORY_MB: "1024",
        RESIN_WORKER_EXECUTION_TIMEOUT_MS: "60000",
      };
      const parsed = parseEnvConfig(mockEnv);

      expect(parsed.logLevel).toBe("debug");
      expect(parsed.host).toBe("0.0.0.0");
      expect(parsed.port).toBe(8080);
      expect(parsed.socketPath).toBe("/custom/socket.sock");
      expect(parsed).not.toHaveProperty("authToken");
      expect(parsed.cloudUrl).toBe("https://cloud.custom.dev");
      expect(parsed.telemetryEnabled).toBe(true);
      expect(parsed.storageDir).toBe("/custom/storage");
      expect(parsed.shutdownTimeoutMs).toBe(5000);
      expect(parsed.maxWorkerMemoryMb).toBe(1024);
      expect(parsed.workerExecutionTimeoutMs).toBe(60000);
    });
  });

  describe("loadDaemonConfig", () => {
    it("merges file config with defaults and env overrides", async () => {
      const tempDir = path.join(os.tmpdir(), `resin-config-test-${Date.now()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const configPath = path.join(tempDir, "config.json");

      const fileData = {
        port: 9500,
        logLevel: "warn",
        telemetryEnabled: true,
      };
      await fs.promises.writeFile(configPath, JSON.stringify(fileData), "utf-8");

      const mockEnv = {
        RESIN_LOG_LEVEL: "error", // Env overrides file
      };

      const config = loadDaemonConfig({
        configPath,
        env: mockEnv,
        overrides: { port: 9600 }, // Explicit overrides take highest priority
      });

      expect(config.port).toBe(9600);
      expect(config.logLevel).toBe("error");
      expect(config.telemetryEnabled).toBe(true);
      expect(config.version).toBe("0.1.0"); // Default

      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe("Secret Redaction", () => {
    it("ignores obsolete local authToken while redacting nested secrets", () => {
      const config = DaemonConfigSchema.parse({
        authToken: "sentinel-local-ipc-token",
        moduleConfigs: {
          database: {
            password: "db-secret-password",
            host: "localhost",
          },
        },
        custom: {
          apiKey: "custom-api-key-value",
          normalField: "public-value",
        },
      });

      const redacted = redactConfig(config);

      expect(redacted).not.toHaveProperty("authToken");
      expect(redacted.port).toBe(9400);
      expect(redacted.cloudUrl).toBe("https://api.resin.sh");

      // SAFETY: Redacted config moduleConfigs carries database properties.
      const dbModule = (redacted.moduleConfigs as { database?: JsonObject })?.database;
      expect(dbModule.password).toBe("[REDACTED]");
      expect(dbModule.host).toBe("localhost");

      // SAFETY: Redacted config custom property is a JsonObject.
      const customObj = redacted.custom as JsonObject;
      expect(customObj.apiKey).toBe("[REDACTED]");
      expect(customObj.normalField).toBe("public-value");

      const json = JSON.stringify(redacted);
      expect(json).not.toContain("sentinel-local-ipc-token");
      expect(json).not.toContain("db-secret-password");
      expect(json).not.toContain("custom-api-key-value");
    });

    it("redacts access tokens, refresh tokens, device credentials, assertions, and vault secrets in arbitrary objects", () => {
      const sensitivePayload = {
        accessToken: "sentinel-access-token-alpha-12345",
        refreshToken: "sentinel-refresh-token-beta-67890",
        deviceCredentials: {
          accessToken: "sentinel-device-access-99999",
          refreshToken: "sentinel-device-refresh-88888",
          deviceId: "dev-sentinel-id",
          nested: {
            secretVal: "sentinel-nested-val",
            regular: "safe-sub-val",
          },
        },
        approvalAssertion: {
          signature: "sentinel-approval-sig-xyz",
          payload: "sentinel-assertion-payload-abc",
        },
        vaultSecret: {
          secretValue: "sentinel-vault-secret-raw",
          vaultKey: "vault-key-abc",
          metadata: {
            version: 1,
          },
        },
        authorization: "Bearer sentinel-bearer-tok-123",
        cloudState: {
          status: "valid",
          cloudUrl: "https://api.resin.sh",
          accountId: "acc-123",
          workspaceId: "ws-456",
          deviceId: "dev-789",
        },
        safeDiagnostic: "diagnosable-health-metric",
      };

      // SAFETY: Redacted payload maintains structure of input sensitivePayload.
      const redacted = redactSensitiveData(sensitivePayload) as typeof sensitivePayload;
      const json = JSON.stringify(redacted);

      // Prove all secret sentinels are completely scrubbed
      expect(json).not.toContain("sentinel-access-token-alpha-12345");
      expect(json).not.toContain("sentinel-refresh-token-beta-67890");
      expect(json).not.toContain("sentinel-device-access-99999");
      expect(json).not.toContain("sentinel-device-refresh-88888");
      expect(json).not.toContain("sentinel-approval-sig-xyz");
      expect(json).not.toContain("sentinel-assertion-payload-abc");
      expect(json).not.toContain("sentinel-vault-secret-raw");
      expect(json).not.toContain("sentinel-vault-key-abc");
      expect(json).not.toContain("sentinel-bearer-tok-123");

      // Prove safe diagnostics and non-secret binding fields remain diagnosable
      expect(redacted.cloudState.status).toBe("valid");
      expect(redacted.cloudState.cloudUrl).toBe("https://api.resin.sh");
      expect(redacted.cloudState.accountId).toBe("acc-123");
      expect(redacted.cloudState.workspaceId).toBe("ws-456");
      expect(redacted.cloudState.deviceId).toBe("dev-789");
      expect(redacted.safeDiagnostic).toBe("diagnosable-health-metric");
    });
    it("handles primitives and null in redactSensitiveData", () => {
      expect(redactSensitiveData(null)).toBe(null);
      expect(redactSensitiveData(undefined)).toBe(undefined);
      expect(redactSensitiveData(123)).toBe(123);
      expect(redactSensitiveData("test")).toBe("test");
    });
  });

  describe("validateConfigUpdate", () => {
    it("allows valid mutable updates", () => {
      const current = DaemonConfigSchema.parse({});
      const update = {
        logLevel: "debug" as const,
        port: 9800,
        telemetryEnabled: true,
      };

      const result = validateConfigUpdate(current, update);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.updatedConfig?.logLevel).toBe("debug");
      expect(result.updatedConfig?.port).toBe(9800);
      expect(result.updatedConfig?.telemetryEnabled).toBe(true);
    });

    it("rejects modifications to immutable fields", () => {
      const current = DaemonConfigSchema.parse({
        version: "0.1.0",
        storageDir: "/var/lib/storage",
        socketPath: "/run/daemon.sock",
      });

      for (const field of IMMUTABLE_CONFIG_FIELDS) {
        const update = { [field]: "modified-value" };
        const result = validateConfigUpdate(current, update);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes(field))).toBe(true);
      }
    });

    it("rejects updates that violate schema", () => {
      const current = DaemonConfigSchema.parse({});
      const update = {
        port: 999999, // Invalid port
      };

      const result = validateConfigUpdate(current, update);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("does not accept removed cloudSyncEnabled or cloudApiKey in updates", () => {
      const current = DaemonConfigSchema.parse({});
      const baseUpdate: Partial<DaemonConfig> = {
        port: 9000,
      };
      const update = Object.assign(baseUpdate, {
        cloudSyncEnabled: true,
        cloudApiKey: "obsolete-key",
      });

      const result = validateConfigUpdate(current, update);
      expect(result.valid).toBe(true);
      expect(result.updatedConfig).not.toHaveProperty("cloudSyncEnabled");
      expect(result.updatedConfig).not.toHaveProperty("cloudApiKey");
    });
  });
});
