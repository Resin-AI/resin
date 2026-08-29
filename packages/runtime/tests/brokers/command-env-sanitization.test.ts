import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandCapability } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  BrokerSecurityError,
  CommandBroker,
  SecretBroker,
} from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Command Child Environment Sanitization & Isolation", () => {
  let tempWorkspace: string;
  let tempScratch: string;
  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let broker: CommandBroker;

  const HOST_SECRETS = {
    AWS_SECRET_ACCESS_KEY: "AKIA_SYNTHETIC_HOST_AWS_SECRET_KEY",
    GITHUB_TOKEN: "ghp_synthetic_host_github_token_abcdef123456",
    NPM_TOKEN: "npm_synthetic_host_token_987654321",
    DATABASE_URL: "postgres://user:pass@internal-db:5432/prod",
    UNAPPROVED_HOST_VAR: "UNAPPROVED_HOST_VALUE_XYZ",
  };

  beforeAll(async () => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cmd_env_ws_"));
    tempScratch = fs.mkdtempSync(path.join(os.tmpdir(), "cmd_env_scratch_"));

    // Inject host secrets into process.env to verify they NEVER leak into child processes
    for (const [k, v] of Object.entries(HOST_SECRETS)) {
      process.env[k] = v;
    }

    auditEmitter = new BrokerAuditEmitter();
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "cmd-env-test-passphrase",
    });

    await secretBroker.addSecret("MEDIATED_API_KEY", "real_mediated_api_key_value_9999", {
      workspaceId: "ws_cmd_env",
      allowedMediationModes: ["command_env", "command_stdin"],
    });

    broker = new CommandBroker({
      auditEmitter,
      secretBroker,
    });
  });

  afterAll(() => {
    for (const k of Object.keys(HOST_SECRETS)) {
      delete process.env[k];
    }
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
    if (fs.existsSync(tempScratch)) {
      fs.rmSync(tempScratch, { recursive: true, force: true });
    }
  });

  const createGrant = (cmdOverrides: Partial<CommandCapability> = {}) => {
    return createInvocationGrant({
      invocationId: "inv_cmd_env_001",
      toolId: "cmd_env_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_cmd_env",
      envelopeId: "env_cmd_env",
      capabilities: {
        command: {
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: ["node"],
          forbiddenPatterns: [],
          allowEnvPassthrough: ["NODE_ENV", "ALLOWED_PASSTHROUGH_VAR"],
          ...cmdOverrides,
        },
        secrets: {
          allowedSecretNames: ["MEDIATED_API_KEY"],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxOutputSizeBytes: 1048576,
          maxExecutionTimeMs: 10000,
        },
      },
    });
  };

  describe("Fixed safe defaults & host environment isolation", () => {
    it("provides minimal safe defaults (PATH, LANG, LC_ALL, TMPDIR, HOME) and zeroes host secrets", async () => {
      const dumpScript = path.join(tempWorkspace, "dump_env.js");
      fs.writeFileSync(dumpScript, "console.log(JSON.stringify(process.env));");

      const grant = createGrant();
      const ctx = {
        invocationId: "inv_cmd_env_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute(
        {
          executable: "node",
          args: [dumpScript],
        },
        ctx,
      );

      expect(res.exitCode).toBe(0);
      const childEnv = JSON.parse(res.stdout.trim());

      // Safe defaults must be present
      expect(childEnv.PATH).toBeDefined();
      expect(childEnv.LANG).toBeDefined();
      expect(childEnv.LC_ALL).toBeDefined();
      expect(childEnv.TMPDIR).toBeDefined();
      expect(childEnv.HOME).toBeDefined();

      // Zero host secrets must be present
      for (const [secretKey, secretVal] of Object.entries(HOST_SECRETS)) {
        expect(childEnv[secretKey]).toBeUndefined();
        expect(res.stdout).not.toContain(secretVal);
      }
    });

    it("passes through only explicitly approved environment variables from process.env", async () => {
      process.env.NODE_ENV = "test_environment_production";
      process.env.ALLOWED_PASSTHROUGH_VAR = "PASSED_VALUE_777";
      process.env.BLOCKED_HOST_VAR = "SHOULD_BE_OMITTED";

      const inspectScript = path.join(tempWorkspace, "inspect_passthrough.js");
      fs.writeFileSync(
        inspectScript,
        `console.log(JSON.stringify({
          nodeEnv: process.env.NODE_ENV,
          allowedVar: process.env.ALLOWED_PASSTHROUGH_VAR,
          blockedVar: process.env.BLOCKED_HOST_VAR,
        }));`,
      );

      const grant = createGrant({
        allowEnvPassthrough: ["NODE_ENV", "ALLOWED_PASSTHROUGH_VAR"],
      });
      const ctx = {
        invocationId: "inv_cmd_env_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute(
        {
          executable: "node",
          args: [inspectScript],
        },
        ctx,
      );

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.nodeEnv).toBe("test_environment_production");
      expect(parsed.allowedVar).toBe("PASSED_VALUE_777");
      expect(parsed.blockedVar).toBeUndefined();

      delete process.env.NODE_ENV;
      delete process.env.ALLOWED_PASSTHROUGH_VAR;
      delete process.env.BLOCKED_HOST_VAR;
    });
  });

  describe("Rejection of dynamic loader overrides and dangerous environment variables", () => {
    it("rejects caller-provided LD_PRELOAD, LD_LIBRARY_PATH, and LD_* variables", async () => {
      const grant = createGrant({ allowEnvPassthrough: ["LD_PRELOAD", "PATH"] });
      const ctx = {
        invocationId: "inv_cmd_env_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const dangerousVars = [
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "LD_DEBUG",
        "LD_ORIGIN_PATH",
      ];

      for (const dangerousVar of dangerousVars) {
        await expect(
          broker.execute(
            {
              executable: "node",
              args: ["test.js"],
              env: { [dangerousVar]: "/tmp/malicious.so" },
            },
            ctx,
          ),
        ).rejects.toMatchObject({
          code: "DANGEROUS_ENV_VAR",
        });
      }
    });

    it("rejects caller-provided DYLD_INSERT_LIBRARIES and macOS dynamic loader variables", async () => {
      const grant = createGrant({ allowEnvPassthrough: ["DYLD_INSERT_LIBRARIES"] });
      const ctx = {
        invocationId: "inv_cmd_env_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const dyldVars = [
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "DYLD_FRAMEWORK_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
      ];

      for (const dyldVar of dyldVars) {
        await expect(
          broker.execute(
            {
              executable: "node",
              args: ["test.js"],
              env: { [dyldVar]: "/tmp/malicious.dylib" },
            },
            ctx,
          ),
        ).rejects.toMatchObject({
          code: "DANGEROUS_ENV_VAR",
        });
      }
    });

    it("rejects interpreter hijacking variables (NODE_OPTIONS, PYTHONPATH, PYTHONHOME, RUBYOPT, BASH_ENV)", async () => {
      const grant = createGrant({
        allowEnvPassthrough: ["NODE_OPTIONS", "PYTHONPATH", "BASH_ENV"],
      });
      const ctx = {
        invocationId: "inv_cmd_env_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const interpreterVars = [
        "NODE_OPTIONS",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "RUBYOPT",
        "PERL5OPT",
        "BASH_ENV",
        "GLIBC_TUNABLES",
        "IFS",
      ];

      for (const envVar of interpreterVars) {
        const error = await broker
          .execute(
            {
              executable: "node",
              args: ["test.js"],
              env: { [envVar]: "--eval malicious" },
            },
            ctx,
          )
          .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(BrokerSecurityError);
        if (error instanceof BrokerSecurityError) {
          expect(error.code).toBe("DANGEROUS_ENV_VAR");
        }
      }
    });

    it("rejects unapproved caller-provided environment variables", async () => {
      const grant = createGrant({
        allowEnvPassthrough: ["NODE_ENV"], // Only NODE_ENV is permitted
      });
      const ctx = {
        invocationId: "inv_cmd_env_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute(
          {
            executable: "node",
            args: ["test.js"],
            env: {
              UNAUTHORIZED_CUSTOM_KEY: "arbitrary_value",
            },
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED_ENV_VAR",
      });
    });
  });

  describe("Broker-mediated credential insertion into child environment", () => {
    it("mediates secret references and injects them securely into child environment", async () => {
      const secretCheckScript = path.join(tempWorkspace, "check_secret_env.js");
      fs.writeFileSync(
        secretCheckScript,
        `console.log(JSON.stringify({
          hasKey: Boolean(process.env.APP_SECRET_ENV),
          length: process.env.APP_SECRET_ENV ? process.env.APP_SECRET_ENV.length : 0,
        }));`,
      );

      const grant = createGrant();
      const ctx = {
        invocationId: "inv_cmd_env_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
        secretBroker,
      };

      const secretRef = secretBroker.createSecretReference("MEDIATED_API_KEY", ctx, {
        modes: ["command_env"],
      });

      const res = await broker.execute(
        {
          executable: "node",
          args: [secretCheckScript],
          env: {
            APP_SECRET_ENV: secretRef,
          },
        },
        ctx,
      );

      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.hasKey).toBe(true);
      expect(parsed.length).toBe("real_mediated_api_key_value_9999".length);

      // Raw secret value must be redacted from stdout
      expect(res.stdout).not.toContain("real_mediated_api_key_value_9999");
    });
  });
});
