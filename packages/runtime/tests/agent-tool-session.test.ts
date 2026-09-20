import { describe, expect, it } from "vitest";
import { AgentToolSession } from "../src/workflow/agent-tool-session.js";

/** An unfamiliar tool server: ordinary JSON in, ordinary JSON out. */
function server(calls: Array<{ tool: string; args: Record<string, unknown> }>) {
  return async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === "vendor_fetch") return { body: { rows: [{ id: `row-${args.source}` }] } };
    if (tool === "vendor_derive")
      return { values: [`${(args.entry as { id: string }).id}-derived`] };
    if (tool === "vendor_write") return { path: `/out/${args.blob}.txt` };
    return { uploaded: args.artifact, token: args.token };
  };
}

describe("agent-facing tool session", () => {
  it("composes four calls through handles and reports the connections used", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const session = new AgentToolSession("sess_agent", server(calls));

    const run = async (source: string, token: string) => {
      const fetched = await session.call("vendor_fetch", { source: { value: source } });
      const derived = await session.call("vendor_derive", {
        entry: { reference: fetched.handle, path: ["body", "rows", 0] },
      });
      const written = await session.call("vendor_write", {
        blob: { reference: derived.handle, path: ["values", 0] },
      });
      return session.call("vendor_upload", {
        artifact: { reference: written.handle, path: ["path"] },
        token: { value: token },
      });
    };

    const first = await run("alpha", "token-local-1");
    // The server saw plain JSON with the nested value resolved; the agent kept the handle.
    expect(calls[1]?.args.entry).toEqual({ id: "row-alpha" });
    expect(first.handle.handle).toMatch(/^ref:sess_agent:call_/);

    calls.length = 0;
    const second = await run("beta", "token-local-2");
    // Fresh values flow downstream on each run, and the private-looking token stayed local.
    expect(calls[1]?.args.entry).toEqual({ id: "row-beta" });
    expect(calls[3]?.args.artifact).toBe("/out/row-beta-derived.txt");
    expect(calls[3]?.args.token).toBe("token-local-2");
    expect(second.result).toEqual({
      uploaded: "/out/row-beta-derived.txt",
      token: "token-local-2",
    });

    // The session reports exactly which argument used which reference, nested paths included.
    const firstCall = session.recordedCalls().find((entry) => entry.callId === "call_2")!;
    // The connection the caller used...
    expect(firstCall.references).toEqual({
      entry: { reference: "ref:sess_agent:call_1", path: ["body", "rows", 0] },
    });
    // ...and the inputs it supplied, with their types, so the tool can take new ones.
    expect(session.recordedCalls().find((entry) => entry.callId === "call_1")!.inputs).toEqual([
      { name: "call_1_source", argument: "source", type: "string" },
    ]);
    expect(session.recordedCalls().find((entry) => entry.callId === "call_4")!.inputs).toEqual([
      { name: "call_4_token", argument: "token", type: "string" },
    ]);
    expect(session.referencesUsed().map((use) => use.reference)).toEqual([
      "ref:sess_agent:call_1",
      "ref:sess_agent:call_2",
      "ref:sess_agent:call_3",
      "ref:sess_agent:call_5",
      "ref:sess_agent:call_6",
      "ref:sess_agent:call_7",
    ]);
  });
});
