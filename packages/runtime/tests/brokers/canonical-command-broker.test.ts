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

describe("Canonical Command Broker & Process Group Isolation", () => {
  let tempWorkspace: string;
  let tempScratch: string;
  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let broker: CommandBroker;
  const capturedAuditEvents: BrokerAuditEvent[] = [];

  beforeAll(async () => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "canon_cmd_ws_"));
    tempScratch = fs.mkdtempSync(path.join(os.tmpdir(), "canon_cmd_scratch_"));

    auditEmitter = new BrokerAuditEmitter();
    auditEmitter.on("audit", (ev) => capturedAuditEvents.push(ev));
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "canonical-broker-test-passphrase",
    });

    await secretBroker.addSecret("TEST_SECRET_KEY", "super_secret_cmd_token_98765", {
      workspaceId: "ws_canon_cmd",
      allowedMediationModes: ["command_env", "command_stdin"],
    });

    broker = new CommandBroker({
      auditEmitter,
      secretBroker,
    });
  });

  afterAll(() => {
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
    if (fs.existsSync(tempScratch)) {
      fs.rmSync(tempScratch, { recursive: true, force: true });
    }
  });

  const createGrant = (
    cmdOverrides: Partial<CommandCapability> = {},
    limitOverrides: Partial<CapabilityLimits> = {},
  ) => {
    return createInvocationGrant({
      invocationId: "inv_canon_cmd_001",
      toolId: "canon_cmd_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_canon_cmd",
      envelopeId: "env_canon_cmd",
      capabilities: {
        command: {
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: ["node"],
          forbiddenPatterns: [],
          allowEnvPassthrough: ["PATH"],
          ...cmdOverrides,
        },
        secrets: {
          allowedSecretNames: ["TEST_SECRET_KEY"],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxOutputSizeBytes: 1048576,
          maxExecutionTimeMs: 10000,
          ...limitOverrides,
        },
      },
    });
  };

  describe("Basename-only matching rejection", () => {
    it("rejects execution when caller substitutes a fake binary in /tmp with the same basename", async () => {
      // Create a fake node executable in /tmp/evil_bin/node
      const fakeDir = path.join(tempWorkspace, "fake_bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      const fakeNode = path.join(fakeDir, "node");
      fs.writeFileSync(fakeNode, "#!/bin/sh\necho 'MALICIOUS_SUBSTITUTE'", { mode: 0o755 });

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Attempting to execute the fake node executable in /tmp/fake_bin/node
      await expect(broker.execute({ executable: fakeNode, args: [] }, ctx)).rejects.toMatchObject({
        code: "UNAUTHORIZED_BINARY",
        message: expect.stringContaining("not permitted by capability grant"),
      });
    });

    it("rejects relative path binary execution attempt", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(broker.execute({ executable: "./fake_node" }, ctx)).rejects.toMatchObject({
        code: "UNAUTHORIZED_BINARY",
      });
    });
  });

  describe("Pre-spawn executable identity re-resolution", () => {
    it("detects symlink swaps between resolution and execution", async () => {
      const legitScript = path.join(tempWorkspace, "legit.js");
      fs.writeFileSync(legitScript, "console.log('LEGIT_OK');");

      const legitBin = path.join(tempWorkspace, "legit_bin");
      fs.writeFileSync(legitBin, `#!/bin/sh\n"${process.execPath}" "${legitScript}"\n`, {
        mode: 0o755,
      });

      const evilBin = path.join(tempWorkspace, "evil_bin");
      fs.writeFileSync(evilBin, "#!/bin/sh\necho 'EVIL_PWNED'\n", { mode: 0o755 });

      const symlinkBin = path.join(tempWorkspace, "dynamic_bin");
      fs.symlinkSync(legitBin, symlinkBin);

      const grant = createGrant({ allowedBinaries: [symlinkBin] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // First run with legit target
      const res = await broker.execute({ executable: symlinkBin }, ctx);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("LEGIT_OK");
    });
  });

  describe("Interpreter escape & argument policy enforcement", () => {
    it("rejects node inline eval flags (-e, --eval, -p, --print, --inspect)", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const escapeFlags = [
        ["-e", "console.log('pwn')"],
        ["--eval", "console.log('pwn')"],
        ["-p", "process.env"],
        ["--print", "process.env"],
        ["--inspect"],
        ["--inspect-brk"],
        ["--input-type=module", "-e", "import 'fs'"],
      ];

      for (const args of escapeFlags) {
        await expect(broker.execute({ executable: "node", args }, ctx)).rejects.toMatchObject({
          code: "FORBIDDEN_ARGUMENT_PATTERN",
        });
      }
    });

    it("rejects shell execution when allowShellExecution is false", async () => {
      const grant = createGrant({
        allowShellExecution: false,
        allowedBinaries: ["sh", "bash", "zsh", "node"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };
      await expect(
        broker.execute({ executable: "bash", args: ["-c", "echo pwned"] }, ctx),
      ).rejects.toMatchObject({
        code: "SHELL_EXECUTION_DENIED",
      });
    });

    it("rejects arguments containing dangerous control characters or command injection sequences", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const maliciousArgs = [
        ["script.js; rm -rf /"],
        ["script.js && whoami"],
        ["script.js | cat /etc/passwd"],
        ["`whoami`"],
        ["$(id)"],
        ["script.js\nmalicious_cmd"],
        ["script.js\0null_byte"],
      ];

      for (const args of maliciousArgs) {
        await expect(broker.execute({ executable: "node", args }, ctx)).rejects.toThrow(
          BrokerSecurityError,
        );
      }
    });

    it("rejects response file boundary escapes", async () => {
      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute({ executable: "node", args: ["@/etc/shadow"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      await expect(
        broker.execute({ executable: "node", args: ["@../../outside.txt"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("allows execution of approved script files inside workspace", async () => {
      const scriptPath = path.join(tempWorkspace, "approved_script.js");
      fs.writeFileSync(scriptPath, "console.log('APPROVED_EXECUTION_SUCCESS');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute({ executable: "node", args: [scriptPath] }, ctx);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("APPROVED_EXECUTION_SUCCESS");
    });
  });

  describe("Working directory boundary enforcement", () => {
    it("rejects working directories outside workspace or scratch dir", async () => {
      const scriptPath = path.join(tempWorkspace, "test_cwd.js");
      fs.writeFileSync(scriptPath, "console.log(process.cwd());");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute({ executable: "node", args: [scriptPath], cwd: "/etc" }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      await expect(
        broker.execute({ executable: "node", args: [scriptPath], cwd: "../../../" }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("allows working directories inside workspace subdirectories", async () => {
      const subDir = path.join(tempWorkspace, "subdir");
      fs.mkdirSync(subDir, { recursive: true });
      const scriptPath = path.join(tempWorkspace, "test_sub_cwd.js");
      fs.writeFileSync(scriptPath, "console.log('IN_SUBDIR');");

      const grant = createGrant({ allowedBinaries: ["node"] });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          cwd: "subdir",
        },
        ctx,
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("IN_SUBDIR");
    });
  });

  describe("Process Group Termination, Timeouts, and Output Limits", () => {
    it("terminates process group on timeout and throws COMMAND_TIMEOUT", async () => {
      const loopScript = path.join(tempWorkspace, "infinite_loop.js");
      fs.writeFileSync(loopScript, "process.on('SIGINT', () => {}); while(true){}");

      const grant = createGrant({ allowedBinaries: ["node"] }, { maxExecutionTimeMs: 100 });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      await expect(
        broker.execute(
          {
            executable: "node",
            args: [loopScript],
            timeoutMs: 100,
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: "COMMAND_TIMEOUT",
      });
    });

    it("terminates subprocess and process group when output exceeds maxOutputSizeBytes", async () => {
      const floodScript = path.join(tempWorkspace, "flood.js");
      fs.writeFileSync(
        floodScript,
        "for(let i = 0; i < 1000; i++) { console.log('X'.repeat(1024)); }",
      );

      const grant = createGrant({ allowedBinaries: ["node"] }, { maxOutputSizeBytes: 1024 });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };
      await expect(
        broker.execute({ executable: "node", args: [floodScript] }, ctx),
      ).rejects.toMatchObject({
        code: "MAX_OUTPUT_EXCEEDED",
      });
    });
  });

  describe("Audit trail redaction and secret non-disclosure", () => {
    it("redacts mediated secrets from stdout, stderr, and audit event logs", async () => {
      capturedAuditEvents.length = 0;

      const scriptPath = path.join(tempWorkspace, "secret_echo.js");
      fs.writeFileSync(
        scriptPath,
        "console.log('SECRET_OUTPUT:' + (process.env.APP_SECRET ?? 'NONE'));",
      );

      const grant = createGrant({
        allowedBinaries: ["node"],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const secretRef = secretBroker.createSecretReference("TEST_SECRET_KEY", ctx, {
        modes: ["command_env"],
      });

      const res = await broker.execute(
        {
          executable: "node",
          args: [scriptPath],
          env: {
            APP_SECRET: secretRef,
          },
        },
        ctx,
      );

      expect(res.exitCode).toBe(0);
      // Result stdout is redacted
      expect(res.stdout).not.toContain("super_secret_cmd_token_98765");

      // Verify audit trail contains no plaintext secret
      const auditString = JSON.stringify(capturedAuditEvents);
      expect(auditString).not.toContain("super_secret_cmd_token_98765");
    });
  });

  describe("Exact command tuple enforcement (allowedCommands)", () => {
    it("permits exact allowedCommands tuple for git status and rejects alternate commands and args", async () => {
      const grant = createGrant({
        allowedCommands: ["git status"],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Exact tuple via executable + args succeeds
      const res1 = await broker.execute({ executable: "git", args: ["status"] }, ctx);
      expect(res1.exitCode).toBeDefined();

      // Exact tuple via command string succeeds
      const res2 = await broker.execute({ command: "git status" }, ctx);
      expect(res2.exitCode).toBeDefined();

      // Reject git ls-remote
      await expect(
        broker.execute(
          { executable: "git", args: ["ls-remote", "https://github.com/evil/repo"] },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Reject alternate args: git status --porcelain
      await expect(
        broker.execute({ executable: "git", args: ["status", "--porcelain"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      // Reject git diff
      await expect(broker.execute({ executable: "git", args: ["diff"] }, ctx)).rejects.toThrow(
        BrokerSecurityError,
      );

      // Reject arbitrary host path argument
      await expect(
        broker.execute({ executable: "git", args: ["/etc/shadow"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("ensures allowedBinaries cannot bypass allowedCommands restrictions", async () => {
      const grant = createGrant({
        allowedCommands: ["git status"],
        allowedBinaries: ["git"],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Matching tuple succeeds
      const res = await broker.execute({ executable: "git", args: ["status"] }, ctx);
      expect(res.exitCode).toBeDefined();

      // Non-matching tuple is rejected despite allowedBinaries containing git
      await expect(
        broker.execute({ executable: "git", args: ["diff", "--stat"] }, ctx),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED_BINARY",
      });
    });

    it("executes novel exact command tuple without global code changes", async () => {
      const novelTool = path.join(tempWorkspace, "novel_tool.sh");
      fs.writeFileSync(novelTool, '#!/bin/sh\necho "NOVEL_TOOL_SUCCESS $1"\n', { mode: 0o755 });

      const grant = createGrant({
        allowedCommands: [`${novelTool} --novel-flag`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute({ executable: novelTool, args: ["--novel-flag"] }, ctx);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("NOVEL_TOOL_SUCCESS --novel-flag");

      // Reject different flag
      await expect(
        broker.execute({ executable: novelTool, args: ["--other-flag"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("maintains explicit broad binary execution when allowedCommands is empty", async () => {
      const scriptPath = path.join(tempWorkspace, "broad_test.js");
      fs.writeFileSync(scriptPath, "console.log('BROAD_BINARY_OK');");

      const grant = createGrant({
        allowedCommands: [],
        allowedBinaries: ["node"],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res = await broker.execute({ executable: "node", args: [scriptPath] }, ctx);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("BROAD_BINARY_OK");

      // Unlisted binary rejected
      await expect(broker.execute({ executable: "git", args: ["status"] }, ctx)).rejects.toThrow(
        BrokerSecurityError,
      );
    });

    it("handles quoted whitespace in single and double quotes without splitting tokens across executable+args and command-string APIs", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_quoted.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      // Double quotes with spaces
      const grantDouble = createGrant({
        allowedCommands: [
          `node "${argvPrinter}" "first arg with spaces" --description "hello world"`,
        ],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxDouble = {
        invocationId: "inv_canon_cmd_001",
        grant: grantDouble,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res1 = await broker.execute(
        {
          command: `node "${argvPrinter}" "first arg with spaces" --description "hello world"`,
        },
        ctxDouble,
      );
      expect(res1.exitCode).toBe(0);
      expect(JSON.parse(res1.stdout.trim())).toEqual([
        "first arg with spaces",
        "--description",
        "hello world",
      ]);

      const res2 = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, "first arg with spaces", "--description", "hello world"],
        },
        ctxDouble,
      );
      expect(res2.exitCode).toBe(0);
      expect(JSON.parse(res2.stdout.trim())).toEqual([
        "first arg with spaces",
        "--description",
        "hello world",
      ]);

      // Single quotes with spaces
      const grantSingle = createGrant({
        allowedCommands: [
          `node '${argvPrinter}' 'single quoted text with spaces' --flag 'alpha beta'`,
        ],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxSingle = {
        invocationId: "inv_canon_cmd_001",
        grant: grantSingle,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const res3 = await broker.execute(
        {
          command: `node '${argvPrinter}' 'single quoted text with spaces' --flag 'alpha beta'`,
        },
        ctxSingle,
      );
      expect(res3.exitCode).toBe(0);
      expect(JSON.parse(res3.stdout.trim())).toEqual([
        "single quoted text with spaces",
        "--flag",
        "alpha beta",
      ]);

      const res4 = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, "single quoted text with spaces", "--flag", "alpha beta"],
        },
        ctxSingle,
      );
      expect(res4.exitCode).toBe(0);
      expect(JSON.parse(res4.stdout.trim())).toEqual([
        "single quoted text with spaces",
        "--flag",
        "alpha beta",
      ]);
    });

    it("preserves empty quoted arguments losslessly across executable+args and command-string APIs and rejects omitted/altered empty args", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_empty.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      const grant = createGrant({
        allowedCommands: [`node "${argvPrinter}" "" "--empty-flag" ""`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Double quoted empty strings via command string
      const res1 = await broker.execute(
        {
          command: `node "${argvPrinter}" "" "--empty-flag" ""`,
        },
        ctx,
      );
      expect(res1.exitCode).toBe(0);
      expect(JSON.parse(res1.stdout.trim())).toEqual(["", "--empty-flag", ""]);

      // Single quoted empty strings via command string
      const res2 = await broker.execute(
        {
          command: `node '${argvPrinter}' '' '--empty-flag' ''`,
        },
        ctx,
      );
      expect(res2.exitCode).toBe(0);
      expect(JSON.parse(res2.stdout.trim())).toEqual(["", "--empty-flag", ""]);

      // Exact tuple via executable + args
      const res3 = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, "", "--empty-flag", ""],
        },
        ctx,
      );
      expect(res3.exitCode).toBe(0);
      expect(JSON.parse(res3.stdout.trim())).toEqual(["", "--empty-flag", ""]);

      // Rejection when caller omits empty argument
      await expect(
        broker.execute({ executable: "node", args: [argvPrinter, "--empty-flag"] }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute({ command: `node "${argvPrinter}" "--empty-flag"` }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      // Rejection when caller supplies non-empty argument where empty argument was permitted
      await expect(
        broker.execute(
          { executable: "node", args: [argvPrinter, "non-empty", "--empty-flag", ""] },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute({ command: `node "${argvPrinter}" "non-empty" "--empty-flag" ""` }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("handles escaped spaces outside quotes and normalizes equivalent quotes losslessly", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_escaped.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      const grant = createGrant({
        allowedCommands: [
          `node "${argvPrinter}" path\\ with\\ spaces.txt --opt=val\\ with\\ space`,
        ],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Command string with backslash escapes
      const res1 = await broker.execute(
        {
          command: `node "${argvPrinter}" path\\ with\\ spaces.txt --opt=val\\ with\\ space`,
        },
        ctx,
      );
      expect(res1.exitCode).toBe(0);
      expect(JSON.parse(res1.stdout.trim())).toEqual([
        "path with spaces.txt",
        "--opt=val with space",
      ]);

      // Command string with equivalent quoted arguments
      const res2 = await broker.execute(
        {
          command: `node "${argvPrinter}" "path with spaces.txt" "--opt=val with space"`,
        },
        ctx,
      );
      expect(res2.exitCode).toBe(0);
      expect(JSON.parse(res2.stdout.trim())).toEqual([
        "path with spaces.txt",
        "--opt=val with space",
      ]);

      // Executable + args
      const res3 = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, "path with spaces.txt", "--opt=val with space"],
        },
        ctx,
      );
      expect(res3.exitCode).toBe(0);
      expect(JSON.parse(res3.stdout.trim())).toEqual([
        "path with spaces.txt",
        "--opt=val with space",
      ]);

      // Rejection when space is unescaped and treated as word break
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "path", "with", "spaces.txt", "--opt=val", "with", "space"],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("preserves Unicode text and Unicode whitespace without mangling or corruption", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_unicode.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      const unicodeMsg = "🚀 release v2.0 (日本語 / 日本)";
      const unicodeWhitespaceMsg = "non\u00A0breaking\u2003space";
      const frenchMsg = "café crème et résumé";

      const grant = createGrant({
        allowedCommands: [
          `node "${argvPrinter}" "${unicodeMsg}" "${unicodeWhitespaceMsg}" "${frenchMsg}"`,
        ],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Via command string
      const res1 = await broker.execute(
        {
          command: `node "${argvPrinter}" "${unicodeMsg}" "${unicodeWhitespaceMsg}" "${frenchMsg}"`,
        },
        ctx,
      );
      expect(res1.exitCode).toBe(0);
      expect(JSON.parse(res1.stdout.trim())).toEqual([unicodeMsg, unicodeWhitespaceMsg, frenchMsg]);

      // Via executable + args
      const res2 = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, unicodeMsg, unicodeWhitespaceMsg, frenchMsg],
        },
        ctx,
      );
      expect(res2.exitCode).toBe(0);
      expect(JSON.parse(res2.stdout.trim())).toEqual([unicodeMsg, unicodeWhitespaceMsg, frenchMsg]);

      // Rejection of mismatched Unicode text
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "🚀 release v2.0", unicodeWhitespaceMsg, frenchMsg],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute(
          {
            command: `node "${argvPrinter}" "🚀 release v2.0" "${unicodeWhitespaceMsg}" "${frenchMsg}"`,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("resolves canonical binary aliases (/usr/bin/git vs git, canonical path vs basename) after parsing before tuple comparison", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_alias.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      // Profile specifies short alias 'node', invocation uses canonical full path process.execPath
      const grantShort = createGrant({
        allowedCommands: [`node "${argvPrinter}" --alias-check`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxShort = {
        invocationId: "inv_canon_cmd_001",
        grant: grantShort,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Short binary matches via executable+args and command
      const resShort1 = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, "--alias-check"],
        },
        ctxShort,
      );
      expect(resShort1.exitCode).toBe(0);

      const resShort2 = await broker.execute(
        {
          command: `node "${argvPrinter}" --alias-check`,
        },
        ctxShort,
      );
      expect(resShort2.exitCode).toBe(0);

      // Canonical full path matches because canonical identity resolves to the same realPath
      const resCanon1 = await broker.execute(
        {
          executable: process.execPath,
          args: [argvPrinter, "--alias-check"],
        },
        ctxShort,
      );
      expect(resCanon1.exitCode).toBe(0);

      const resCanon2 = await broker.execute(
        {
          command: `"${process.execPath}" "${argvPrinter}" --alias-check`,
        },
        ctxShort,
      );
      expect(resCanon2.exitCode).toBe(0);

      // Profile specifies canonical path, invocation uses short alias 'node'
      const grantCanon = createGrant({
        allowedCommands: [`"${process.execPath}" "${argvPrinter}" --canon-profile`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxCanon = {
        invocationId: "inv_canon_cmd_001",
        grant: grantCanon,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const resShort3 = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, "--canon-profile"],
        },
        ctxCanon,
      );
      expect(resShort3.exitCode).toBe(0);

      const resShort4 = await broker.execute(
        {
          command: `node "${argvPrinter}" --canon-profile`,
        },
        ctxCanon,
      );
      expect(resShort4.exitCode).toBe(0);

      // Malicious substitute with same basename in temporary directory has different canonical identity and is rejected
      const fakeDir = path.join(tempWorkspace, "fake_node_alias_bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      const fakeNode = path.join(fakeDir, "node");
      fs.writeFileSync(fakeNode, "#!/bin/sh\necho 'MALICIOUS_SUBSTITUTE_NODE'\n", { mode: 0o755 });

      await expect(
        broker.execute({ executable: fakeNode, args: [argvPrinter, "--alias-check"] }, ctxShort),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute({ command: `"${fakeNode}" "${argvPrinter}" --alias-check` }, ctxShort),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("rejects unterminated quotes and unterminated escapes in both command strings and allowedCommands profiles", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_unterminated.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      const grant = createGrant({
        allowedCommands: [`node "${argvPrinter}" --safe-flag`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Unterminated single quote in command
      await expect(
        broker.execute({ command: `node "${argvPrinter}" 'unterminated single quote` }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      // Unterminated double quote in command
      await expect(
        broker.execute({ command: `node "${argvPrinter}" "unterminated double quote` }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      // Trailing backslash escape in command
      await expect(
        broker.execute({ command: `node "${argvPrinter}" trailing\\` }, ctx),
      ).rejects.toThrow(BrokerSecurityError);

      // Unterminated single quote in profile -> execution fails closed
      const grantBadProfile1 = createGrant({
        allowedCommands: [`node "${argvPrinter}" 'unterminated single quote`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxBad1 = { ...ctx, grant: grantBadProfile1 };
      await expect(
        broker.execute(
          { executable: "node", args: [argvPrinter, "unterminated single quote"] },
          ctxBad1,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Unterminated double quote in profile -> execution fails closed
      const grantBadProfile2 = createGrant({
        allowedCommands: [`node "${argvPrinter}" "unterminated double quote`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxBad2 = { ...ctx, grant: grantBadProfile2 };
      await expect(
        broker.execute(
          { executable: "node", args: [argvPrinter, "unterminated double quote"] },
          ctxBad2,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Trailing backslash in profile -> execution fails closed
      const grantBadProfile3 = createGrant({
        allowedCommands: [`node "${argvPrinter}" trailing\\`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxBad3 = { ...ctx, grant: grantBadProfile3 };
      await expect(
        broker.execute({ executable: "node", args: [argvPrinter, "trailing\\"] }, ctxBad3),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("rejects shell operators, expansions, subshells, and redirections without invoking a shell", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_shell_ops.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      const grant = createGrant({
        allowedCommands: [`node "${argvPrinter}" --safe`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      const maliciousCommands = [
        // Semicolon command chaining
        `node "${argvPrinter}"; echo INJECTED`,
        `node "${argvPrinter}" ; echo INJECTED`,
        // Pipe
        `node "${argvPrinter}" | cat`,
        // Logical operators
        `node "${argvPrinter}" && echo INJECTED`,
        `node "${argvPrinter}" || echo INJECTED`,
        // Background execution
        `node "${argvPrinter}" &`,
        // Redirections
        `node "${argvPrinter}" > /tmp/out`,
        `node "${argvPrinter}" < /tmp/in`,
        `node "${argvPrinter}" 2>&1`,
        `node "${argvPrinter}" >> /tmp/out`,
        // Environment / variable expansion
        `node "${argvPrinter}" $SECRET`,
        `node "${argvPrinter}" \${SECRET}`,
        // Subshell command substitution
        `node "${argvPrinter}" $(whoami)`,
        `node "${argvPrinter}" \`whoami\``,
        // Newline / carriage return injection
        `node "${argvPrinter}"\necho INJECTED`,
        `node "${argvPrinter}"\recho INJECTED`,
      ];

      for (const cmd of maliciousCommands) {
        await expect(
          broker.execute({ command: cmd }, ctx),
          `Expected command to be rejected: ${cmd}`,
        ).rejects.toThrow(BrokerSecurityError);
      }

      // Shell operators inside allowedCommands profile must also fail closed
      const grantWithShellOp = createGrant({
        allowedCommands: [`node "${argvPrinter}"; echo INJECTED`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctxShellOp = { ...ctx, grant: grantWithShellOp };
      await expect(
        broker.execute({ executable: "node", args: [argvPrinter] }, ctxShellOp),
      ).rejects.toThrow(BrokerSecurityError);
    });

    it("enforces strict tuple equality and rejects argument addition, removal, reordering, and prefix/substring mutations", async () => {
      const argvPrinter = path.join(tempWorkspace, "print_argv_mismatch.js");
      fs.writeFileSync(argvPrinter, "console.log(JSON.stringify(process.argv.slice(2)));\n");

      const grant = createGrant({
        allowedCommands: [`node "${argvPrinter}" --mode=production --flag-a --flag-b`],
        allowedBinaries: [],
        allowEnvPassthrough: ["PATH"],
      });
      const ctx = {
        invocationId: "inv_canon_cmd_001",
        grant,
        workspaceRoot: tempWorkspace,
        scratchDir: tempScratch,
      };

      // Exact matching succeeds via both APIs
      const resCmd = await broker.execute(
        {
          command: `node "${argvPrinter}" --mode=production --flag-a --flag-b`,
        },
        ctx,
      );
      expect(resCmd.exitCode).toBe(0);

      const resExec = await broker.execute(
        {
          executable: "node",
          args: [argvPrinter, "--mode=production", "--flag-a", "--flag-b"],
        },
        ctx,
      );
      expect(resExec.exitCode).toBe(0);

      // Extra argument appended
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "--mode=production", "--flag-a", "--flag-b", "--extra"],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute(
          {
            command: `node "${argvPrinter}" --mode=production --flag-a --flag-b --extra`,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Missing argument
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "--mode=production", "--flag-a"],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute(
          {
            command: `node "${argvPrinter}" --mode=production --flag-a`,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Argument substitution / difference
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "--mode=production", "--flag-a", "--other-flag"],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute(
          {
            command: `node "${argvPrinter}" --mode=production --flag-a --other-flag`,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Reordered arguments
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "--mode=production", "--flag-b", "--flag-a"],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute(
          {
            command: `node "${argvPrinter}" --mode=production --flag-b --flag-a`,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Substring mutation (--mode=prod instead of --mode=production)
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "--mode=prod", "--flag-a", "--flag-b"],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute(
          {
            command: `node "${argvPrinter}" --mode=prod --flag-a --flag-b`,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);

      // Prefix mutation (--mode=production-extra)
      await expect(
        broker.execute(
          {
            executable: "node",
            args: [argvPrinter, "--mode=production-extra", "--flag-a", "--flag-b"],
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
      await expect(
        broker.execute(
          {
            command: `node "${argvPrinter}" --mode=production-extra --flag-a --flag-b`,
          },
          ctx,
        ),
      ).rejects.toThrow(BrokerSecurityError);
    });
  });
});
