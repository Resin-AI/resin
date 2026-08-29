import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, createMessage } from "../src/index.js";

describe("protocol", () => {
  it("creates protocol messages", () => {
    const msg = createMessage("test", { key: "value" });
    expect(msg.type).toBe("test");
    expect(msg.payload).toEqual({ key: "value" });
    expect(PROTOCOL_VERSION).toBe("1.0.0");
  });
});
