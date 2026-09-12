import { describe, expect, it } from "vitest";
import type { CallToolResult } from "../../src/protocol/types.js";
import { CommandFailureDiagnostics } from "../../src/proxy/command-failures.js";

const response = (): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ success: false, summary: "Completed" }) }],
});

function diagnostic(result: CallToolResult) {
  const last = result.content.at(-1);
  if (!last || last.type !== "text") throw new Error("Missing diagnostic text");
  return JSON.parse(last.text);
}

describe("CommandFailureDiagnostics", () => {
  it("preserves the broker result and original output while exposing redacted failure details", async () => {
    const diagnostics = new CommandFailureDiagnostics("/workspace");
    const brokerResult = {
      exitCode: 2,
      stdout: "unused output",
      stderr: "failed /workspace/test.ts [REDACTED]",
    };
    const handler = diagnostics.wrap(async () => brokerResult);
    expect(
      await handler("cmd", "execute", {
        args: ["private-argument"],
        env: { TOKEN: "private-value" },
      }),
    ).toBe(brokerResult);
    const original = response();
    const result = diagnostics.append(original, 4096);
    expect(result.content[0]).toBe(original.content[0]);
    expect(original.content).toHaveLength(1);
    expect(diagnostic(result)).toEqual({
      commandFailures: [
        { step: 1, exitCode: 2, stderr: "failed <WORKSPACE>/test.ts [REDACTED]", truncated: false },
      ],
      omittedCommandFailures: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-argument|private-value|unused output/);
    expect(diagnostics.isReportedFailure({ success: false })).toBe(true);
  });

  it.each(["execute", "exec"])(
    "retains empty-stderr exit codes from the %s action",
    async (action) => {
      const diagnostics = new CommandFailureDiagnostics("");
      await diagnostics.wrap(async () => ({ exitCode: 1, stderr: "" }))("cmd", action);
      expect(diagnostic(diagnostics.append(response(), 4096)).commandFailures[0]).toEqual({
        step: 1,
        exitCode: 1,
        stderr: "",
        truncated: false,
      });
    },
  );

  it("counts commands, not other broker operations, and ignores successful or malformed results", async () => {
    const diagnostics = new CommandFailureDiagnostics("");
    await diagnostics.wrap(async () => ({ exitCode: 1, stderr: "not a command" }))(
      "fs",
      "readFile",
    );
    await diagnostics.wrap(async () => ({ exitCode: 1, stderr: "not execute" }))("cmd", "inspect");
    await diagnostics.wrap(async () => ({ exitCode: 0, stderr: "warning" }))("cmd", "execute");
    await diagnostics.wrap(async () => ({ exitCode: "1", stderr: "invalid" }))("cmd", "execute");
    await diagnostics.wrap(async () => null)("cmd", "execute");
    expect(diagnostics.hasFailures).toBe(false);
    await diagnostics.wrap(async () => ({ exitCode: 3, stderr: "failure" }))("cmd", "execute");
    expect(diagnostic(diagnostics.append(response(), 4096)).commandFailures[0].step).toBe(4);
  });

  it("does not treat handled nonzero statuses or arbitrary false values as tool failure", async () => {
    const diagnostics = new CommandFailureDiagnostics("");
    expect(diagnostics.isReportedFailure({ success: false })).toBe(false);
    await diagnostics.wrap(async () => ({ exitCode: 1 }))("cmd", "execute");
    for (const output of [{ success: true }, { found: false }, null, false, "false", []]) {
      expect(diagnostics.isReportedFailure(output)).toBe(false);
    }
  });

  it("keeps request order when concurrent command responses finish out of order", async () => {
    const diagnostics = new CommandFailureDiagnostics("");
    let resolveFirst: (value: { exitCode: number }) => void = () => {};
    const first = new Promise<{ exitCode: number }>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const handler = diagnostics.wrap(async () => (++calls === 1 ? first : { exitCode: 2 }));
    const pending = handler("cmd", "execute");
    await handler("cmd", "execute");
    resolveFirst({ exitCode: 1 });
    await pending;
    expect(
      diagnostic(diagnostics.append(response(), 4096)).commandFailures.map(
        (failure: { step: number }) => failure.step,
      ),
    ).toEqual([1, 2]);
  });

  it("bounds cardinality, UTF-8 stderr, escaped JSON and the complete response budget", async () => {
    const diagnostics = new CommandFailureDiagnostics("");
    const handler = diagnostics.wrap(async () => ({
      exitCode: 1,
      stderr: "\u0001\u4e2d".repeat(3000),
    }));
    for (let index = 0; index < 7; index++) await handler("cmd", "execute");
    for (const budget of [1024, 4096, 16384]) {
      const result = diagnostics.append(response(), budget);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget);
      const details = diagnostic(result);
      expect(details.commandFailures.length).toBeLessThanOrEqual(4);
      expect(details.omittedCommandFailures).toBe(7 - details.commandFailures.length);
      for (const failure of details.commandFailures) {
        expect(Buffer.byteLength(failure.stderr)).toBeLessThanOrEqual(2048);
        expect(failure.stderr).not.toContain("\ufffd");
        expect(failure.truncated).toBe(true);
      }
      const last = result.content.at(-1);
      expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThanOrEqual(8192);
    }
  });

  it("does not alter an existing response when there is no budget or no failure", async () => {
    const diagnostics = new CommandFailureDiagnostics("");
    const original = response();
    expect(diagnostics.append(original, 4096)).toBe(original);
    await diagnostics.wrap(async () => ({ exitCode: 1, stderr: "failure" }))("cmd", "execute");
    expect(diagnostics.append(original, Buffer.byteLength(JSON.stringify(original)))).toBe(
      original,
    );
    expect(diagnostics.append(original, Buffer.byteLength(JSON.stringify(original)) + 30)).toBe(
      original,
    );
  });

  it("keeps diagnostics scoped to one invocation and propagates broker rejections unchanged", async () => {
    const first = new CommandFailureDiagnostics("");
    await first.wrap(async () => ({ exitCode: 1, stderr: "first invocation" }))("cmd", "execute");
    const next = new CommandFailureDiagnostics("");
    const error = new Error("Existing broker error");
    await expect(
      next.wrap(async () => {
        throw error;
      })("cmd", "execute"),
    ).rejects.toBe(error);
    expect(next.hasFailures).toBe(false);
    expect(next.append(response(), 4096).content).toHaveLength(1);
    expect(first.hasFailures).toBe(true);
  });
});
