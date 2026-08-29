import { describe, expect, it } from "vitest";
import { DefaultRuntimeEngine } from "../src/index.js";

describe("runtime", () => {
  it("initializes default engine", async () => {
    const engine = new DefaultRuntimeEngine();
    expect(engine.isReady()).toBe(true);
    const res = await engine.run({ id: "t1", name: "tool", version: "1.0", description: "desc" });
    expect(res.payload.toolId).toBe("t1");
  });
});
