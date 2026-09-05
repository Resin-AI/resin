import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));
vi.mock("../src/shim/stdio-bridge.js", () => ({
  McpStdioShim: class {
    constructor(options: Record<string, unknown>) {
      captured.options = options;
    }
    async start() {
      return { mode: "daemon_ipc" };
    }
    async stop() {}
  },
}));
import { main, printHelp } from "../src/bin/mcp-shim.js";

afterEach(() => vi.restoreAllMocks());

describe("mcp-shim startup flag", () => {
  it("documents the disabled-by-default opt-in", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("--enable-tool-search"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("disabled by default"));
  });

  it.each([false, true])("passes enableToolSearch=%s to its shim", async (enabled) => {
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    try {
      await main(enabled ? ["--enable-tool-search"] : []);
      expect(captured.options.enableToolSearch).toBe(enabled);
    } finally {
      for (const listener of process.listeners("SIGINT")) {
        if (!beforeInt.includes(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!beforeTerm.includes(listener)) process.removeListener("SIGTERM", listener);
      }
    }
  });
});
