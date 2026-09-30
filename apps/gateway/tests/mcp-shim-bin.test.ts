import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as StdioBridge from "../src/shim/stdio-bridge.js";

const captured = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  closeReason: "harness_closed" as string,
}));
vi.mock("../src/shim/stdio-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof StdioBridge>()),
  McpStdioShim: class {
    constructor(options: Record<string, unknown>) {
      captured.options = options;
    }
    async start() {
      return { mode: "daemon_ipc" };
    }
    async closed() {
      return captured.closeReason;
    }
    async stop() {}
  },
}));
import { main, printHelp } from "../src/bin/mcp-shim.js";

afterEach(() => vi.restoreAllMocks());

describe("mcp-shim startup flag", () => {
  it("documents the disabled-by-default opt-in and full catalog flags", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("--enable-tool-search"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("disabled by default"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("--full-catalog"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("--cwd"));
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

  it.each([false, true])("passes fullCatalog=%s to its shim", async (full) => {
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    try {
      await main(full ? ["--full-catalog"] : []);
      expect(captured.options.fullCatalog).toBe(full);
    } finally {
      for (const listener of process.listeners("SIGINT")) {
        if (!beforeInt.includes(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!beforeTerm.includes(listener)) process.removeListener("SIGTERM", listener);
      }
    }
  });

  it("preserves --cwd and propagates to its shim", async () => {
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    try {
      await main(["--cwd", "/custom/project/path"]);
      expect(captured.options.cwd).toBe("/custom/project/path");
    } finally {
      for (const listener of process.listeners("SIGINT")) {
        if (!beforeInt.includes(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!beforeTerm.includes(listener)) process.removeListener("SIGTERM", listener);
      }
    }
  });

  it.each([
    ["harness_closed", 0],
    ["daemon_closed", 0],
    ["stream_error", 1],
  ])("exits when the session ends (%s) with code %i", async (reason, code) => {
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    captured.closeReason = reason;
    try {
      await expect(main([])).resolves.toBe(code);
    } finally {
      captured.closeReason = "harness_closed";
      for (const listener of process.listeners("SIGINT")) {
        if (!beforeInt.includes(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!beforeTerm.includes(listener)) process.removeListener("SIGTERM", listener);
      }
    }
  });
});
