import { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcpServer } from "../../src/workflow/mcp-connection.js";

// A child whose spawn failed has no pid but keeps a never-initialised libuv handle until the error
// is delivered; kill() on it signals whatever pid that memory holds. Closing such a child must not
// signal anything. These tests only spy: no real signal is sent.
describe("a failed spawn never signals another process", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closing a stdio MCP server whose command does not exist sends no signal", async () => {
    const childKill = vi.spyOn(ChildProcess.prototype, "kill");
    const processKill = vi.spyOn(process, "kill");

    await expect(
      connectMcpServer({
        name: "missing",
        transport: { kind: "stdio", command: "resin-nonexistent-mcp-server-12345" },
      }),
    ).rejects.toThrow();

    expect(childKill).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
  });
});
