import { describe, expect, it } from "vitest";
import {
  WorkflowReferenceError,
  WorkflowReferenceScope,
  invokeWithReferences,
} from "../src/workflow/reference-invocation.js";

/** An unfamiliar tool server: it knows nothing about references, only the values it is given. */
function server(calls: Array<{ callId: string; args: Record<string, unknown> }>) {
  return async (callId: string, args: Record<string, unknown>) => {
    calls.push({ callId, args });
    switch (callId) {
      case "fetch":
        return { body: { rows: [{ id: `row-${args.source}`, size: 3 }] } };
      case "transform":
        return {
          stdout: `${(args.payload as { id: string }).id.toUpperCase()}#${String(args.depth)}`,
        };
      case "write":
        return { path: `/out/${args.content}.txt` };
      default:
        return { uploaded: args.artifact, token: args.token };
    }
  };
}

describe("reference-aware invocation", () => {
  it("passes fresh results between four calls while recording the references", async () => {
    const calls: Array<{ callId: string; args: Record<string, unknown> }> = [];
    const scope = new WorkflowReferenceScope("sess_1");
    const invoke = server(calls);

    const run = async (source: string) => {
      const fetch = await invokeWithReferences(
        scope,
        { callId: "fetch", arguments: { source: { kind: "value", value: source } } },
        invoke,
      );
      const transform = await invokeWithReferences(
        scope,
        {
          callId: "transform",
          arguments: {
            payload: {
              kind: "reference",
              reference: fetch.reference,
              path: ["body", "rows", 0],
            },
            depth: { kind: "value", value: 2 },
          },
        },
        invoke,
      );
      const write = await invokeWithReferences(
        scope,
        {
          callId: "write",
          arguments: {
            content: { kind: "reference", reference: transform.reference, path: ["stdout"] },
          },
        },
        invoke,
      );
      return invokeWithReferences(
        scope,
        {
          callId: "upload",
          arguments: {
            artifact: { kind: "reference", reference: write.reference, path: ["path"] },
            token: { kind: "value", value: `${source}-local` },
          },
        },
        invoke,
      );
    };

    await run("alpha");
    // The server received the resolved, nested value; the scope kept the reference.
    expect(calls[1]?.args.payload).toEqual({ id: "row-alpha", size: 3 });

    await run("beta");
    // A second run composes fresh values rather than replaying the recorded ones.
    expect(calls[5]?.args.payload).toEqual({ id: "row-beta", size: 3 });
    expect(calls[7]?.args.artifact).toBe("/out/ROW-BETA#2.txt");
    expect(calls[7]?.args.token).toBe("beta-local");

    // The recording preserves the connections, not just the values.
    expect(scope.referencesUsed().map((use) => use.reference)).toEqual([
      "ref:sess_1:fetch",
      "ref:sess_1:transform",
      "ref:sess_1:write",
      "ref:sess_1:fetch",
      "ref:sess_1:transform",
      "ref:sess_1:write",
    ]);
  });

  it("fails explicitly when a reference names nothing recorded", async () => {
    const scope = new WorkflowReferenceScope("sess_2");
    await expect(
      invokeWithReferences(
        scope,
        {
          callId: "upload",
          arguments: { artifact: { kind: "reference", reference: "ref:sess_2:missing" } },
        },
        async () => ({ uploaded: true }),
      ),
    ).rejects.toThrow(WorkflowReferenceError);
  });
});
