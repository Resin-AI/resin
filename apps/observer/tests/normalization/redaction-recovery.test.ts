import { describe, expect, it } from "vitest";
import { RedactionEngine } from "../../src/normalization/redaction.js";

/** A privacy mask must remain reversible locally without disclosing its original upstream. */
describe("redaction recovery callback", () => {
  it("retains the local callback for nested secret and local-field substitutions", () => {
    const originals = new Map<string, unknown>();
    const engine = new RedactionEngine({
      customSecrets: ["capture-private-original"],
      scanContent: false,
      onRedact: (placeholder, original) => originals.set(placeholder, original),
    });
    const result = engine.redact({
      nested: { values: ["before capture-private-original after"] },
      cwd: "/private/workspace",
    });
    expect(JSON.stringify(result.data)).not.toContain("capture-private-original");
    expect([...originals.values()]).toContain("capture-private-original");
    expect(originals.get("[REDACTED_LOCAL_FIELD:cwd]")).toBe("/private/workspace");
  });
});
