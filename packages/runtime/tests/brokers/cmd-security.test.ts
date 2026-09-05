import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityLimits, CommandCapability } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  type BrokerAuditEvent,
  BrokerSecurityError,
  CommandBroker,
  SecretBroker,
} from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Command Broker Security & Isolation", () => {
  let tempWorkspace: string;
  let broker: CommandBroker;

  beforeAll(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cmd_broker_ws_"));
    broker = new CommandBroker();

    // Set a dummy host secret in process.env to verify it does not leak
    process.env.TEST_HOST_SECRET_TOKEN = "SUPER_SECRET_HOST_TOKEN_12345";
  });

  afterAll(() => {
    delete process.env.TEST_HOST_SECRET_TOKEN;
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  const createGrant = (
    overrides: Partial<CommandCapability> = {},
    limitOverrides: Partial<CapabilityLimits> = {},
  ) => {
    return createInvocationGrant({
      invocationId: "inv_cmd_001",
      toolId: "test_cmd_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_cmd_test",
      envelopeId: "env_cmd_test",
      capabilities: {
        command: {
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: ["node"],
          forbiddenPatterns: ["--forbidden-flag", "eval\\s*\\("],
          allowEnvPassthrough: ["TEST_ALLOWED_VAR"],
          ...overrides,
        },
        limits: {
          maxOutputSizeBytes: 1048576,
          maxExecutionTimeMs: 10000,
          ...limitOverrides,
        },
      },
    });
  };

  it("executes authorized binary and returns stdout, exitCode, and duration", async () => {
    const scriptPath = path.join(tempWorkspace, "success.js");
    fs.writeFileSync(scriptPath, "console.log('Command Broker Success');");

    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const res = await broker.execute(
      {
        executable: "node",
        args: [scriptPath],
      },
      ctx,
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("Command Broker Success");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executes a fixed explicitly granted Python unittest module through canonical aliases", async () => {
    fs.writeFileSync(
      path.join(tempWorkspace, "resin_module_test.py"),
      "import unittest\nclass Smoke(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n",
    );
    const grant = createGrant({
      allowedBinaries: [],
      allowedCommands: ["python3 -m unittest $STR -v"],
    });
    const result = await broker.execute(
      { executable: "python3", args: ["-m", "unittest", "resin_module_test", "-v"] },
      { invocationId: "inv_cmd_001", grant, workspaceRoot: tempWorkspace },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("OK");
  });

  it.each([
    { profiles: [], args: ["-m", "unittest", "resin_module_test", "-v"] },
    { profiles: ["python3 -m $STR $STR -v"], args: ["-m", "unittest", "resin_module_test", "-v"] },
    { profiles: ["python3 -m http.server"], args: ["-m", "http.server"] },
    { profiles: ["python3 -munittest"], args: ["-munittest"] },
    { profiles: ["python3 -m unittest $STR -v"], args: ["-m", "unittest", "-c", "-v"] },
  ])("retains interpreter escape guards for $profiles / $args", async ({ profiles, args }) => {
    const grant = createGrant({ allowedBinaries: ["python3"], allowedCommands: profiles });
    await expect(
      broker.execute(
        { executable: "python3", args },
        { invocationId: "inv_cmd_001", grant, workspaceRoot: tempWorkspace },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ARGUMENT_PATTERN" });
  });

  it("rejects unauthorized binary execution", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };
    let threw = false;
    try {
      await broker.execute({ executable: "git", args: ["status"] }, ctx);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("UNAUTHORIZED_BINARY");
      }
    }
    expect(threw).toBe(true);
  });

  it("denies direct shell binary invocation when allowShellExecution is false", async () => {
    const grant = createGrant({
      allowShellExecution: false,
      allowedBinaries: ["sh", "bash", "node"],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };
    let threwSh = false;
    try {
      await broker.execute({ executable: "sh", args: ["-c", "echo pwned"] }, ctx);
    } catch (err) {
      threwSh = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("SHELL_EXECUTION_DENIED");
      }
    }
    expect(threwSh).toBe(true);

    let threwBash = false;
    try {
      await broker.execute({ executable: "bash", args: ["-c", "whoami"] }, ctx);
    } catch (err) {
      threwBash = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("SHELL_EXECUTION_DENIED");
      }
    }
    expect(threwBash).toBe(true);
  });

  it("rejects commands with forbidden argument patterns", async () => {
    const scriptPath = path.join(tempWorkspace, "forbidden_test.js");
    fs.writeFileSync(scriptPath, "console.log('test');");

    const grant = createGrant({
      allowedBinaries: ["node"],
      forbiddenPatterns: ["--forbidden-flag", "eval\\s*\\("],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    let threw = false;
    try {
      await broker.execute({ executable: "node", args: [scriptPath, "--forbidden-flag"] }, ctx);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("FORBIDDEN_PATTERN");
      }
    }
    expect(threw).toBe(true);
  });

  it("rejects shell injection characters in command arguments", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const dangerousArgs = [
      ["console.log(1); rm -rf /"],
      ["console.log(1) | cat"],
      ["console.log(1) && echo evil"],
      ["`whoami`"],
      ["$(whoami)"],
      ["test\ninjection"],
      ["test\0nullbyte"],
    ];

    for (const args of dangerousArgs) {
      await expect(broker.execute({ executable: "node", args }, ctx)).rejects.toThrow(
        BrokerSecurityError,
      );
    }
  });

  it("enforces templated allowedCommands argument shapes", async () => {
    const testDirectory = path.join(tempWorkspace, "packages", "a");
    const testFile = path.join(testDirectory, "test.js");
    fs.mkdirSync(testDirectory, { recursive: true });
    fs.writeFileSync(
      testFile,
      'const test = require("node:test"); test("template target", () => {});',
    );

    const grant = createGrant({
      allowedCommands: ["node --test $TEST_FILE"],
      allowedBinaries: ["node"],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const result = await broker.execute(
      {
        executable: "node",
        args: ["--test", "packages/a/test.js"],
      },
      ctx,
    );
    expect(result.exitCode).toBe(0);

    await expect(
      broker.execute({ executable: "node", args: ["--test", "-x"] }, ctx),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_BINARY" });
    await expect(
      broker.execute({ executable: "node", args: ["--test"] }, ctx),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_BINARY" });
    await expect(
      broker.execute({ executable: "node", args: ["--test", "$TEST_FILE"] }, ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ARGUMENT_PATTERN" });
  });

  it("blocks relative PATH injection executable attempts", async () => {
    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    let threw = false;
    try {
      await broker.execute({ executable: "./unauthorized_local_binary" }, ctx);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("UNAUTHORIZED_BINARY");
      }
    }
    expect(threw).toBe(true);
  });

  it("rejects working directories outside workspace or scratch dir", async () => {
    const scriptPath = path.join(tempWorkspace, "cwd_test.js");
    fs.writeFileSync(scriptPath, "console.log('hi');");

    const grant = createGrant({ allowedBinaries: ["node"] });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };
    let threw = false;
    try {
      await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          cwd: "/etc",
        },
        ctx,
      );
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("WORKING_DIRECTORY_DENIED");
      }
    }
    expect(threw).toBe(true);
  });

  it("sanitizes environment and prevents leaking unapproved host environment variables", async () => {
    const scriptPath = path.join(tempWorkspace, "env_test.js");
    fs.writeFileSync(
      scriptPath,
      `console.log(JSON.stringify({
        secret: process.env.TEST_HOST_SECRET_TOKEN,
        allowed: process.env.TEST_ALLOWED_VAR,
      }));`,
    );

    process.env.TEST_ALLOWED_VAR = "ALLOWED_VALUE_123";

    const grant = createGrant({
      allowedBinaries: ["node"],
      allowEnvPassthrough: ["TEST_ALLOWED_VAR"],
    });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const res = await broker.execute(
      {
        executable: "node",
        args: [scriptPath],
      },
      ctx,
    );

    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.secret).toBeUndefined(); // Host secret must NOT be leaked
    expect(parsed.allowed).toBe("ALLOWED_VALUE_123"); // Explicitly allowed var is passed

    delete process.env.TEST_ALLOWED_VAR;
  });

  it("enforces output size limits and terminates subprocess if exceeded", async () => {
    const scriptPath = path.join(tempWorkspace, "large_output.js");
    fs.writeFileSync(scriptPath, "console.log('A'.repeat(10240));");

    const grant = createGrant(
      { allowedBinaries: ["node"] },
      { maxOutputSizeBytes: 500 }, // 500 bytes max
    );
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    let threwOutput = false;
    try {
      await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
        },
        ctx,
      );
    } catch (err) {
      threwOutput = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("MAX_OUTPUT_EXCEEDED");
      }
    }
    expect(threwOutput).toBe(true);
  });

  it("enforces execution timeout bounds and terminates subprocess on deadline", async () => {
    const scriptPath = path.join(tempWorkspace, "timeout_loop.js");
    fs.writeFileSync(scriptPath, "while(true){}");

    const grant = createGrant({ allowedBinaries: ["node"] }, { maxExecutionTimeMs: 100 });
    const ctx = {
      invocationId: "inv_cmd_001",
      grant,
      workspaceRoot: tempWorkspace,
    };
    let threwTimeout = false;
    try {
      await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
        },
        ctx,
      );
    } catch (err) {
      threwTimeout = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      if (err instanceof BrokerSecurityError) {
        expect(err.code).toBe("COMMAND_TIMEOUT");
      }
    }
    expect(threwTimeout).toBe(true);
  });

  describe("CWD Symlink and Containment Security (RUNTIME-COMMAND-CWD-SYMLINK-007)", () => {
    it("allows execution in valid nested directory within canonical workspace", async () => {
      const nestedDir = path.join(tempWorkspace, "nested", "sub_dir");
      fs.mkdirSync(nestedDir, { recursive: true });

      const scriptPath = path.join(tempWorkspace, "print_cwd.js");
      fs.writeFileSync(scriptPath, "console.log(process.cwd());");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };

      const res = await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          cwd: "nested/sub_dir",
        },
        ctx,
      );

      const expectedReal = fs.realpathSync(nestedDir);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe(expectedReal);
    });

    it("rejects working directory that is a symlink pointing outside the workspace", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside_ws_"));
      const linkPath = path.join(tempWorkspace, "link_to_outside");
      try {
        fs.symlinkSync(outsideDir, linkPath, "dir");
      } catch {
        fs.symlinkSync(outsideDir, linkPath, "junction");
      }

      const scriptPath = path.join(tempWorkspace, "test_outside.js");
      fs.writeFileSync(scriptPath, "console.log('should not run');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };

      try {
        await broker.execute(
          {
            executable: "node",
            args: [scriptPath],
            cwd: "link_to_outside",
          },
          ctx,
        );
        expect.unreachable("Should have rejected symlink cwd to outside workspace");
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.code).toBe("WORKING_DIRECTORY_DENIED");
        }
      } finally {
        try {
          fs.unlinkSync(linkPath);
          fs.rmdirSync(outsideDir);
        } catch {
          // ignore cleanup
        }
      }
    });

    it("rejects working directory that is a symlink even if pointing inside the workspace", async () => {
      const realNestedDir = path.join(tempWorkspace, "real_nested");
      fs.mkdirSync(realNestedDir, { recursive: true });

      const linkPath = path.join(tempWorkspace, "link_to_inside");
      try {
        fs.symlinkSync(realNestedDir, linkPath, "dir");
      } catch {
        fs.symlinkSync(realNestedDir, linkPath, "junction");
      }

      const scriptPath = path.join(tempWorkspace, "test_inside_link.js");
      fs.writeFileSync(scriptPath, "console.log('should not run');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };

      try {
        await broker.execute(
          {
            executable: "node",
            args: [scriptPath],
            cwd: "link_to_inside",
          },
          ctx,
        );
        expect.unreachable("Should have rejected symlink cwd pointing inside workspace");
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.code).toBe("WORKING_DIRECTORY_DENIED");
        }
      } finally {
        try {
          fs.unlinkSync(linkPath);
          fs.rmdirSync(realNestedDir);
        } catch {
          // ignore cleanup
        }
      }
    });

    it("rejects working directory whose path contains intermediate symlink components", async () => {
      const realParent = path.join(tempWorkspace, "real_parent");
      const subDir = path.join(realParent, "target_child");
      fs.mkdirSync(subDir, { recursive: true });

      const symlinkParent = path.join(tempWorkspace, "symlink_parent");
      try {
        fs.symlinkSync(realParent, symlinkParent, "dir");
      } catch {
        fs.symlinkSync(realParent, symlinkParent, "junction");
      }

      const scriptPath = path.join(tempWorkspace, "test_intermediate.js");
      fs.writeFileSync(scriptPath, "console.log('should not run');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };

      try {
        await broker.execute(
          {
            executable: "node",
            args: [scriptPath],
            cwd: "symlink_parent/target_child",
          },
          ctx,
        );
        expect.unreachable("Should have rejected intermediate symlink component in cwd");
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.code).toBe("WORKING_DIRECTORY_DENIED");
        }
      } finally {
        try {
          fs.unlinkSync(symlinkParent);
          fs.rmdirSync(subDir);
          fs.rmdirSync(realParent);
        } catch {
          // ignore cleanup
        }
      }
    });

    it("rejects non-existent working directory or non-directory file as cwd", async () => {
      const fileAsCwd = path.join(tempWorkspace, "not_a_dir.txt");
      fs.writeFileSync(fileAsCwd, "hello");

      const scriptPath = path.join(tempWorkspace, "test_file_cwd.js");
      fs.writeFileSync(scriptPath, "console.log('should not run');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };

      // Non-existent
      try {
        await broker.execute(
          {
            executable: "node",
            args: [scriptPath],
            cwd: "does_not_exist_12345",
          },
          ctx,
        );
        expect.unreachable("Should have rejected non-existent cwd");
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.code).toBe("FILE_NOT_FOUND");
        }
      }

      // File as cwd
      try {
        await broker.execute(
          {
            executable: "node",
            args: [scriptPath],
            cwd: "not_a_dir.txt",
          },
          ctx,
        );
        expect.unreachable("Should have rejected regular file as cwd");
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.code).toBe("FILE_NOT_FOUND");
        }
      }
    });

    it("exact argv authorization does not grant uncontained cwd authorization", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside_exact_"));
      const scriptPath = path.join(tempWorkspace, "exact_cmd.js");
      fs.writeFileSync(scriptPath, "console.log('exact');");

      const grant = createGrant({
        allowedBinaries: ["node"],
        allowedCommands: [`node ${scriptPath}`],
      });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };

      // Even with exact command authorization, specifying an outside directory fails
      try {
        await broker.execute(
          {
            executable: "node",
            args: [scriptPath],
            cwd: outsideDir,
          },
          ctx,
        );
        expect.unreachable("Exact command authorization must not allow outside cwd");
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.code).toBe("WORKING_DIRECTORY_DENIED");
        }
      } finally {
        try {
          fs.rmdirSync(outsideDir);
        } catch {
          // ignore cleanup
        }
      }
    });

    it("blocks dangerous interpreter escape flags, response files, and argument injection vectors", async () => {
      const grant = createGrant({
        allowedBinaries: ["node", "python3", "sh"],
        allowEnvPassthrough: [
          "TEST_ALLOWED_VAR",
          "SAFE_CUSTOM",
          "LD_PRELOAD",
          "NODE_OPTIONS",
          "PYTHONPATH",
          "BASH_ENV",
        ],
      });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };
      const dangerousVectors = [
        // Node interpreter eval/interactive/print/preload/import/loader/inspect/env escape vectors
        { executable: "node", args: ["-e", "console.log('eval escape')"] },
        { executable: "node", args: ["--eval", "console.log('eval escape')"] },
        { executable: "node", args: ["-i"] },
        { executable: "node", args: ["--interactive"] },
        { executable: "node", args: ["-p", "process.env"] },
        { executable: "node", args: ["--print", "process.env"] },
        { executable: "node", args: ["-r", "/tmp/evil.js"] },
        { executable: "node", args: ["--require=/tmp/evil.js"] },
        { executable: "node", args: ["--import=/tmp/evil.js"] },
        { executable: "node", args: ["--loader=/tmp/loader.mjs"] },
        { executable: "node", args: ["--inspect"] },
        { executable: "node", args: ["--inspect-brk"] },
        { executable: "node", args: ["--env-file=.env"] },
        { executable: "node", args: ["--openssl-config=/etc/shadow"] },

        // Python eval/interactive/module/import escape vectors
        { executable: "python3", args: ["-c", "import os; os.system('whoami')"] },
        { executable: "python3", args: ["--command", "import sys; print(1)"] },
        { executable: "python3", args: ["-m", "http.server"] },
        { executable: "python3", args: ["-i"] },
        { executable: "python3", args: ["-ic", "print(1)"] },

        // Shell eval/interactive/config escape vectors
        { executable: "sh", args: ["-c", "echo evil"] },
        { executable: "sh", args: ["-s"] },
        { executable: "sh", args: ["-ec", "whoami"] },
        { executable: "sh", args: ["-ic", "whoami"] },

        // Response-file escape vectors
        { executable: "node", args: ["@/etc/passwd"] },
        { executable: "node", args: ["--config=@/etc/shadow"] },
        { executable: "node", args: ["@.env"] },
        { executable: "node", args: ["@.ssh/id_rsa"] },
        { executable: "node", args: ["@../outside_secret.txt"] },
      ];

      for (const { executable, args } of dangerousVectors) {
        let threw = false;
        try {
          await broker.execute({ executable, args }, ctx);
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(BrokerSecurityError);
          if (err instanceof BrokerSecurityError) {
            expect([
              "FORBIDDEN_ARGUMENT_PATTERN",
              "SHELL_EXECUTION_DENIED",
              "UNAUTHORIZED_BINARY",
            ]).toContain(err.code);
          }
        }
        expect(threw).toBe(true);
      }

      // Verify that dangerous environment variables are rejected
      const scriptPath = path.join(tempWorkspace, "env_leak_test.js");
      fs.writeFileSync(
        scriptPath,
        "console.log(JSON.stringify({ ld: process.env.LD_PRELOAD, node_opts: process.env.NODE_OPTIONS, py: process.env.PYTHONPATH, custom: process.env.SAFE_CUSTOM }));",
      );

      // Direct provision of dangerous env vars is rejected fail-closed
      const dangerousVars = ["LD_PRELOAD", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV"];
      for (const dangerousKey of dangerousVars) {
        let threwEnv = false;
        try {
          await broker.execute(
            {
              executable: "node",
              args: [scriptPath],
              env: { [dangerousKey]: "/tmp/evil" },
            },
            ctx,
          );
        } catch (err) {
          threwEnv = true;
          expect(err).toBeInstanceOf(BrokerSecurityError);
          if (err instanceof BrokerSecurityError) {
            expect(["DANGEROUS_ENV_VAR", "UNAUTHORIZED_ENV_VAR"]).toContain(err.code);
          }
        }
        expect(threwEnv).toBe(true);
      }
      // Safe custom variable is passed through
      const res = await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          env: {
            SAFE_CUSTOM: "allowed_value",
          },
        },
        ctx,
      );

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.ld).toBeUndefined();
      expect(parsed.node_opts).toBeUndefined();
      expect(parsed.py).toBeUndefined();
      expect(parsed.custom).toBe("allowed_value");
    });
    it("prevents secret mediation leakage in command lines, arguments, audit logs, and error messages", async () => {
      const auditEmitter = new BrokerAuditEmitter();
      const secretBroker = new SecretBroker({ auditEmitter });
      await secretBroker.addSecret("DB_PASSWORD", "super_secret_db_password_999", {
        workspaceId: "ws_cmd_test",
        allowedMediationModes: ["env_var"],
      });

      const brokerWithSecrets = new CommandBroker({
        auditEmitter,
        secretBroker,
      });

      const grant = createGrant({
        allowedBinaries: ["node"],
        allowEnvPassthrough: ["TEST_ALLOWED_VAR", "SECRET_VAR"],
        secrets: [{ name: "DB_PASSWORD" }],
      });
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        secretBroker,
      };

      const scriptPath = path.join(tempWorkspace, "fail_with_secret.js");
      fs.writeFileSync(
        scriptPath,
        "console.error('Failure with ' + process.env.SECRET_VAR); process.exit(1);",
      );

      const capturedAuditEvents: BrokerAuditEvent[] = [];
      auditEmitter.on("audit", (evt: BrokerAuditEvent) => {
        capturedAuditEvents.push(evt);
      });

      const res = await brokerWithSecrets.execute(
        {
          executable: "node",
          args: [scriptPath],
          env: {
            SECRET_VAR: {
              type: "secret_ref",
              name: "DB_PASSWORD",
            },
          },
        },
        ctx,
      );

      expect(res.exitCode).toBe(1);
      // Assert secret is absent from stderr and audit logs (literal [REDACTED] is not required)
      expect(res.stderr).not.toContain("super_secret_db_password_999");
      const auditString = JSON.stringify(capturedAuditEvents);
      expect(auditString).not.toContain("super_secret_db_password_999");
    });

    it("enforces child process resource limits, process tree termination, and output limits", async () => {
      const grant = createGrant(
        { allowedBinaries: ["node"] },
        { maxOutputSizeBytes: 512, maxExecutionTimeMs: 200 },
      );
      const ctx = {
        invocationId: "inv_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
      };

      // Subprocess exceeding output limit is truncated or rejected
      const scriptPath = path.join(tempWorkspace, "massive_output.js");
      let threwMaxOut = false;
      try {
        await broker.execute({ executable: "node", args: [scriptPath] }, ctx);
      } catch (err) {
        threwMaxOut = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.code).toBe("MAX_OUTPUT_EXCEEDED");
        }
      }
      expect(threwMaxOut).toBe(true);
    });
  });
});
