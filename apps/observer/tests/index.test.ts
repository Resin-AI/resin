import { createMessage } from "@resin/protocol";
import { describe, expect, it } from "vitest";
import { createObserver } from "../src/index.js";

describe("observer", () => {
  it("records and counts events", () => {
    const obs = createObserver();
    obs.recordEvent(createMessage("test", {}));
    expect(obs.getEventCount()).toBe(1);
  });
});
