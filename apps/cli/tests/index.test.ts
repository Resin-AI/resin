import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  isDirectServiceSupervisorEntry,
  main,
  mcpCommand,
  parseArgs,
  parseMcpArgs,
} from "../src/index.js";

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
      expect(defaultFlags.standaloneMode).toBe(true);
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
      expect(parsed.standaloneMode).toBe(false);
      expect(parsed.standaloneFallback).toBe(true);
      expect(parsed.socketPath).toBe("/tmp/daemon.sock");
      expect(parsed.cwd).toBe("/custom/dir");
      expect(parsed.dbPath).toBe("/custom/db.sqlite");
      expect(parsed.harnessId).toBe("custom-harness");

      const noStandalone = parseMcpArgs(["--no-standalone", "--socket=/path/to/sock"]);
      expect(noStandalone.standaloneFallback).toBe(false);
      expect(noStandalone.standaloneMode).toBe(false);
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

  describe("isDirectServiceSupervisorEntry", () => {
    it("detects direct entry when argv1 invokes the script through a directory symlink", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-symlink-test-"));
      try {
        const versionDir = path.join(tmpDir, "versions", "1.0.23", "apps", "cli", "dist");
        fs.mkdirSync(versionDir, { recursive: true });
        const realScriptPath = path.join(versionDir, "index.js");
        fs.writeFileSync(realScriptPath, "// test", "utf8");

        const currentSymlink = path.join(tmpDir, "current");
        fs.symlinkSync(path.join(tmpDir, "versions", "1.0.23"), currentSymlink, "dir");

        const symlinkedArgv = path.join(currentSymlink, "apps", "cli", "dist", "index.js");
        const canonicalMetaUrl = pathToFileURL(realScriptPath).href;

        expect(isDirectServiceSupervisorEntry(canonicalMetaUrl, symlinkedArgv)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("detects direct entry when argv1 is a direct file symlink to the script", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-symlink-file-test-"));
      try {
        const targetFile = path.join(tmpDir, "target.js");
        const linkFile = path.join(tmpDir, "link.js");
        fs.writeFileSync(targetFile, "// target", "utf8");
        fs.symlinkSync(targetFile, linkFile, "file");

        const canonicalMetaUrl = pathToFileURL(targetFile).href;

        expect(isDirectServiceSupervisorEntry(canonicalMetaUrl, linkFile)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("handles mock or nonexistent paths matching the expected identity", () => {
      const mockPath = "/mock/virtual/apps/cli/dist/index.js";
      const mockMetaUrl = pathToFileURL(mockPath).href;

      expect(isDirectServiceSupervisorEntry(mockMetaUrl, mockPath)).toBe(true);
    });

    it("returns false for nonexistent paths with mismatched identities", () => {
      const mockArgv = "/mock/virtual/apps/cli/dist/index.js";
      const mockMetaUrl = pathToFileURL("/mock/virtual/apps/cli/dist/other.js").href;

      expect(isDirectServiceSupervisorEntry(mockMetaUrl, mockArgv)).toBe(false);
    });

    it("returns false when imported by an unrelated script or CLI binary", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-negative-test-"));
      try {
        const cliEntry = path.join(tmpDir, "cli.js");
        const indexModule = path.join(tmpDir, "index.js");
        fs.writeFileSync(cliEntry, "// cli", "utf8");
        fs.writeFileSync(indexModule, "// index", "utf8");

        const moduleMetaUrl = pathToFileURL(indexModule).href;
        expect(isDirectServiceSupervisorEntry(moduleMetaUrl, cliEntry)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns false when argv1 is undefined or empty", () => {
      expect(isDirectServiceSupervisorEntry(import.meta.url, undefined)).toBe(false);
      expect(isDirectServiceSupervisorEntry(import.meta.url, "")).toBe(false);
    });

    it("returns false for invalid or non-file metaUrl strings", () => {
      expect(
        isDirectServiceSupervisorEntry("https://example.com/index.js", "/some/path/index.js"),
      ).toBe(false);
      expect(isDirectServiceSupervisorEntry("not-a-valid-url", "/some/path/index.js")).toBe(false);
    });
  });
});
