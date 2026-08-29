import { describe, expect, it } from "vitest";
import { CRYPTO_VERSION, sha256 } from "../src/index.js";

describe("crypto", () => {
  it("computes sha256 hash", () => {
    expect(sha256("test")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    expect(CRYPTO_VERSION).toBe("0.1.0");
  });
});
