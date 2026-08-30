import { describe, expect, it, vi } from "vitest";
import { main, mcpCommand, parseArgs, parseMcpArgs } from "../src/index.js";

describe("cli", () => {
  it("parses CLI arguments", () => {
    const res = parseArgs(["node", "cli", "evolve", "--dry-run", "--tool=t1"]);
    expect(res.command).toBe("evolve");
    expect(res.flags["dry-run"]).toBe(true);
    expect(res.flags.tool).toBe("t1");
  });

  describe("mcp command and flags", () => {
    it("parses mcp flags with defaults and explicit overrides", () => {
      const defaultFlags = parseMcpArgs([]);
      expect(defaultFlags.standaloneFallback).toBe(true);
      expect(defaultFlags.standaloneMode).toBe(false);
      expect(defaultFlags.showHelp).toBe(false);

      const parsed = parseMcpArgs([
        "-s",
        "-S",
        "/tmp/daemon.sock",
        "-C",
        "/custom/dir",
        "-d",
        "/custom/db.sqlite",
        "-H",
        "custom-harness",
      ]);
      expect(parsed.standaloneMode).toBe(true);
      expect(parsed.standaloneFallback).toBe(true);
      expect(parsed.socketPath).toBe("/tmp/daemon.sock");
      expect(parsed.cwd).toBe("/custom/dir");
      expect(parsed.dbPath).toBe("/custom/db.sqlite");
      expect(parsed.harnessId).toBe("custom-harness");

      const noStandalone = parseMcpArgs(["--no-standalone", "--socket=/path/to/sock"]);
      expect(noStandalone.standaloneFallback).toBe(false);
      expect(noStandalone.socketPath).toBe("/path/to/sock");
    });

    it("prints mcp help on main(['mcp', '--help']) with exit code 0", async () => {
      let output = "";
      const stdout = {
        write: (chunk: string) => {
          output += chunk;
          return true;
        },
      };

      const exitCode = await main(["mcp", "--help"], { stdout });
      expect(exitCode).toBe(0);
      expect(output).toContain("Usage:\n  resin mcp [options]");
      expect(output).toContain("--standalone");
      expect(output).toContain("--socket <path>");
    });

    it("includes mcp in global help", async () => {
      let output = "";
      const stdout = {
        write: (chunk: string) => {
          output += chunk;
          return true;
        },
      };

      const exitCode = await main(["help"], { stdout });
      expect(exitCode).toBe(0);
      expect(output).toContain("mcp");
      expect(output).toContain("Connect AI harnesses to Resin Gateway");
    });

    it("routes mcp before startup health checks and without extra stdout", async () => {
      let stdoutOutput = "";
      let stderrOutput = "";
      const stdout = {
        write: (chunk: string) => {
          stdoutOutput += chunk;
          return true;
        },
      };
      const stderr = {
        write: (chunk: string) => {
          stderrOutput += chunk;
          return true;
        },
      };

      const healthCheckRunner = vi.fn();
      const exitCode = await main(["mcp", "--help"], {
        stdout,
        stderr,
        harnessHealthRunner: healthCheckRunner,
        isInitialized: true,
      });

      expect(exitCode).toBe(0);
      expect(healthCheckRunner).not.toHaveBeenCalled();
      expect(stdoutOutput).toContain("Usage:\n  resin mcp [options]");
    });

    it("does not statically import mcp command in cli entrypoint", async () => {
      const fs = await import("node:fs");
      const cliSource = fs.readFileSync(new URL("../src/bin/cli.ts", import.meta.url), "utf8");
      expect(cliSource).not.toMatch(/^import .* from ["']\.\.?\/commands\/mcp(?:\.js)?["'];?/m);
      expect(cliSource).toMatch(/import\(["']\.\.\/commands\/mcp\.js["']\)/);
    });

    it("handles shim failure and returns error exit code", async () => {
      let stderrOutput = "";
      const stderr = {
        write: (chunk: string) => {
          stderrOutput += chunk;
          return true;
        },
      };

      const exitCode = await mcpCommand([], {
        stderr,
        shimFactory: () => ({
          start: async () => ({ mode: "failed" }),
          stop: async () => {},
        }),
      });

      expect(exitCode).toBe(1);
    });

    it("handles fatal exceptions cleanly", async () => {
      let stderrOutput = "";
      const stderr = {
        write: (chunk: string) => {
          stderrOutput += chunk;
          return true;
        },
      };

      const exitCode = await mcpCommand([], {
        stderr,
        shimFactory: () => ({
          start: async () => {
            throw new Error("Bridge connection failed");
          },
          stop: async () => {},
        }),
      });

      expect(exitCode).toBe(1);
      expect(stderrOutput).toContain("Fatal MCP error: Bridge connection failed");
    });
  });
});
