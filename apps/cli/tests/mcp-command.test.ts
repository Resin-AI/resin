import stream from "node:stream";
import { describe, expect, it } from "vitest";
import { mcpCommand, parseMcpArgs, printMcpHelp } from "../src/commands/mcp.js";

describe("resin mcp command", () => {
  it("defaults a bare invocation to the in-process gateway", () => {
    expect(parseMcpArgs([])).toMatchObject({
      standaloneMode: true,
      standaloneFallback: true,
      enableToolSearch: false,
      socketPath: undefined,
    });
  });

  it("requires daemon mode only when explicitly requested", () => {
    expect(parseMcpArgs(["--no-standalone"])).toMatchObject({
      standaloneMode: false,
      standaloneFallback: false,
    });
    expect(parseMcpArgs(["--socket", "/tmp/resin.sock"])).toMatchObject({
      standaloneMode: false,
      standaloneFallback: true,
      socketPath: "/tmp/resin.sock",
    });
  });

  it("documents explicit tool search opt-in", () => {
    expect(parseMcpArgs(["--enable-tool-search"]).enableToolSearch).toBe(true);
    let help = "";
    printMcpHelp({
      write: (chunk) => {
        help += chunk;
        return true;
      },
    });
    expect(help).toContain("--enable-tool-search");
    expect(help).toContain("disabled by default");
  });

  it.each([false, true])("propagates enableToolSearch=%s to the shim", async (enabled) => {
    await expect(
      mcpCommand(enabled ? ["--enable-tool-search"] : [], {
        shimFactory: (options) => {
          expect(options.enableToolSearch).toBe(enabled);
          return { start: async () => ({ mode: "daemon_ipc" }), stop: async () => {} };
        },
      }),
    ).resolves.toBe(0);
  });

  it("starts a bare invocation without selecting the daemon socket", async () => {
    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();
    let socketPath: string | undefined;
    let maxStartupAttempts: number | undefined;

    const result = mcpCommand([], {
      stdin,
      stdout,
      stderr,
      shimFactory: (options) => {
        socketPath = options.socketPath;
        maxStartupAttempts = options.maxStartupAttempts;
        return {
          start: async () => ({ mode: "standalone_inprocess" }),
          stop: async () => {},
        };
      },
    });

    queueMicrotask(() => stdin.end());

    await expect(result).resolves.toBe(0);
    expect(socketPath).toBe("");
    expect(maxStartupAttempts).toBe(0);
  });
});
