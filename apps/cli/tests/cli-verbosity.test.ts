import { describe, expect, it, vi } from "vitest";
import { main } from "../src/bin/cli.js";
import { parseUpgradeFlags, upgradeCommand } from "../src/commands/upgrade.js";
import { parseInitFlags } from "../src/commands/init.js";
import { CliOutput, resolveVerbosity } from "../src/output.js";

describe("CLI Verbosity Policy & Output Controls", () => {
  describe("resolveVerbosity", () => {
    it("defaults to 'default' when no flags or env vars are set", () => {
      expect(resolveVerbosity({})).toBe("default");
      expect(resolveVerbosity({ args: ["init"], env: {} })).toBe("default");
    });

    it("resolves 'verbose' from CLI flags --verbose and -v", () => {
      expect(resolveVerbosity({ args: ["--verbose"] })).toBe("verbose");
      expect(resolveVerbosity({ args: ["-v"] })).toBe("verbose");
      expect(resolveVerbosity({ flags: { verbose: true } })).toBe("verbose");
    });

    it("resolves 'quiet' from CLI flags --quiet and -q", () => {
      expect(resolveVerbosity({ args: ["--quiet"] })).toBe("quiet");
      expect(resolveVerbosity({ args: ["-q"] })).toBe("quiet");
      expect(resolveVerbosity({ flags: { quiet: true } })).toBe("quiet");
    });

    it("resolves from environment variables when flags are absent", () => {
      expect(resolveVerbosity({ env: { RESIN_VERBOSE: "1" } })).toBe("verbose");
      expect(resolveVerbosity({ env: { RESIN_VERBOSE: "true" } })).toBe("verbose");
      expect(resolveVerbosity({ env: { RESIN_QUIET: "1" } })).toBe("quiet");
      expect(resolveVerbosity({ env: { RESIN_QUIET: "true" } })).toBe("quiet");
    });

    it("CLI flags take precedence over environment variables", () => {
      expect(
        resolveVerbosity({
          args: ["--quiet"],
          env: { RESIN_VERBOSE: "1" },
        }),
      ).toBe("quiet");

      expect(
        resolveVerbosity({
          args: ["--verbose"],
          env: { RESIN_QUIET: "1" },
        }),
      ).toBe("verbose");
    });
  });

  describe("CliOutput abstraction", () => {
    it("gates step/diagnostic logs behind verbose mode", () => {
      let defaultOut = "";
      const defaultHandler = new CliOutput({
        verbosity: "default",
        stdout: { write: (c) => { defaultOut += c; return true; } },
      });
      defaultHandler.step("==> Step 1/11");
      expect(defaultOut).toBe("");

      let verboseOut = "";
      const verboseHandler = new CliOutput({
        verbosity: "verbose",
        stdout: { write: (c) => { verboseOut += c; return true; } },
      });
      verboseHandler.step("==> Step 1/11");
      expect(verboseOut).toContain("==> Step 1/11");
    });

    it("suppresses standard log and success output in quiet mode", () => {
      let quietOut = "";
      const quietHandler = new CliOutput({
        verbosity: "quiet",
        stdout: { write: (c) => { quietOut += c; return true; } },
      });
      quietHandler.log("Some progress");
      quietHandler.success("Resin initialization complete.");
      expect(quietOut).toBe("");

      let defaultOut = "";
      const defaultHandler = new CliOutput({
        verbosity: "default",
        stdout: { write: (c) => { defaultOut += c; return true; } },
      });
      defaultHandler.success("Resin initialization complete.");
      expect(defaultOut).toContain("Resin initialization complete.");
    });

    it("always routes errors to stderr across all verbosity levels", () => {
      let quietErr = "";
      const quietHandler = new CliOutput({
        verbosity: "quiet",
        stderr: { write: (c) => { quietErr += c; return true; } },
      });
      quietHandler.error("Error: something failed");
      expect(quietErr).toContain("Error: something failed");
    });
  });

  describe("Flag parsing for init and upgrade", () => {
    it("parses -v and --verbose in init flags", () => {
      expect(parseInitFlags(["--verbose"]).verbose).toBe(true);
      expect(parseInitFlags(["-v"]).verbose).toBe(true);
    });

    it("parses -q and --quiet in init flags", () => {
      expect(parseInitFlags(["--quiet"]).quiet).toBe(true);
      expect(parseInitFlags(["-q"]).quiet).toBe(true);
    });

    it("parses -v, --verbose, -q, --quiet in upgrade flags", () => {
      expect(parseUpgradeFlags(["--verbose"]).verbose).toBe(true);
      expect(parseUpgradeFlags(["-v"]).verbose).toBe(true);
      expect(parseUpgradeFlags(["--quiet"]).quiet).toBe(true);
      expect(parseUpgradeFlags(["-q"]).quiet).toBe(true);
    });
  });

  describe("CLI router version and verbosity flag handling", () => {
    it("outputs version on -V, --version, and version command", async () => {
      let stdout = "";
      const outStream = {
        isTTY: true,
        write: (c: string) => { stdout += c; return true; },
      };

      const code1 = await main(["-V"], { stdout: outStream });
      expect(code1).toBe(0);
      expect(stdout).toMatch(/^resin v\d+\.\d+\.\d+/);

      stdout = "";
      const code2 = await main(["--version"], { stdout: outStream });
      expect(code2).toBe(0);
      expect(stdout).toMatch(/^resin v\d+\.\d+\.\d+/);

      stdout = "";
      const code3 = await main(["version"], { stdout: outStream });
      expect(code3).toBe(0);
      expect(stdout).toMatch(/^resin v\d+\.\d+\.\d+/);
    });

    it("does not treat -v as version; -v is verbose mode", async () => {
      let stdout = "";
      const outStream = {
        isTTY: true,
        write: (c: string) => { stdout += c; return true; },
      };

      // With isInitialized: true and no autoOnboard, running "-v" prints global help with verbose mode, not "resin v..."
      const code = await main(["-v"], {
        stdout: outStream,
        isInitialized: true,
        autoOnboard: false,
      });
      expect(code).toBe(0);
      expect(stdout).not.toMatch(/^resin v\d+\.\d+\.\d+\n$/);
      expect(stdout).toContain("Global Options:");
      expect(stdout).toContain("-V, --version");
    });
  });

  describe("Upgrade command quiet output", () => {
    it("suppresses success message in quiet mode while maintaining exitCode 0", async () => {
      let stdout = "";
      let stderr = "";
      const mockEngine = {
        run: vi.fn().mockResolvedValue({
          success: true,
          status: "completed",
          activeVersion: "0.2.0",
          stepsCompleted: ["verify", "activate"],
        }),
      };

      const exitCode = await upgradeCommand(["--quiet", "--force"], {
        engine: mockEngine,
        stdout: { write: (c) => { stdout += c; return true; } },
        stderr: { write: (c) => { stderr += c; return true; } },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    });
  });
});
