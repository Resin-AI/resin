import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/index.js";

describe("cli", () => {
  it("parses CLI arguments", () => {
    const res = parseArgs(["node", "cli", "evolve", "--dry-run", "--tool=t1"]);
    expect(res.command).toBe("evolve");
    expect(res.flags["dry-run"]).toBe(true);
    expect(res.flags.tool).toBe("t1");
  });
});
