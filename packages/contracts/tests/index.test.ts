import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "../src/index.js";

describe("contracts", () => {
  it("exports CONTRACTS_VERSION as 1.0.0", () => {
    expect(CONTRACTS_VERSION).toBe("1.0.0");
  });
});
