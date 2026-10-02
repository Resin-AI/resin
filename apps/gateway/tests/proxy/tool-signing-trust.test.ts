import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PINNED_TOOL_SIGNING_TRUST,
  PRODUCTION_CLOUD_ORIGIN,
  STAGING_CLOUD_ORIGIN,
  type TrustedToolSigningKey,
  trustedToolSigningKeysFor,
} from "../../src/proxy/tool-signing-trust.js";

describe("pinned tool signing trust", () => {
  it("pins exactly the production and staging origins", () => {
    expect(Object.keys(PINNED_TOOL_SIGNING_TRUST).sort()).toEqual(
      [PRODUCTION_CLOUD_ORIGIN, STAGING_CLOUD_ORIGIN].sort(),
    );
    expect(PRODUCTION_CLOUD_ORIGIN).toBe("https://api.resin.sh");
    expect(STAGING_CLOUD_ORIGIN).toBe("https://67sho46k61.execute-api.us-east-1.amazonaws.com");
  });

  it("parses every pinned key as an Ed25519 SPKI public key", () => {
    for (const keys of Object.values(PINNED_TOOL_SIGNING_TRUST)) {
      for (const key of keys) {
        const parsed = createPublicKey({ key: key.publicKeyPem, format: "pem" });
        expect(parsed.type).toBe("public");
        expect(parsed.asymmetricKeyType).toBe("ed25519");
        expect(key.algorithm).toBe("ed25519");
        // Round-trips as SPKI DER: 12-byte Ed25519 SPKI header + 32-byte key.
        expect(parsed.export({ type: "spki", format: "der" }).length).toBe(44);
      }
    }
  });

  it("maps each origin only to its own environment's key", () => {
    const production = trustedToolSigningKeysFor("https://api.resin.sh");
    const staging = trustedToolSigningKeysFor(
      "https://67sho46k61.execute-api.us-east-1.amazonaws.com/staging",
    );
    expect(production?.map((key: TrustedToolSigningKey) => [key.keyId, key.environment])).toEqual([
      ["production-tool-signing-2026-10", "production"],
    ]);
    expect(staging?.map((key: TrustedToolSigningKey) => [key.keyId, key.environment])).toEqual([
      ["staging-tool-signing-2026-10", "staging"],
    ]);
    const productionPems = new Set(production?.map((key) => key.publicKeyPem));
    expect(staging?.some((key) => productionPems.has(key.publicKeyPem))).toBe(false);
  });

  it("trusts no key for any other origin", () => {
    for (const url of [
      "http://api.resin.sh",
      "https://api.resin.sh:8443",
      "https://evil.api.resin.sh",
      "https://api.resin.sh.evil.example",
      "http://127.0.0.1:43123",
      "not a url",
    ]) {
      expect(trustedToolSigningKeysFor(url)).toBeUndefined();
    }
  });

  it("cannot be modified at runtime", () => {
    const keys = PINNED_TOOL_SIGNING_TRUST[PRODUCTION_CLOUD_ORIGIN];
    expect(Object.isFrozen(PINNED_TOOL_SIGNING_TRUST)).toBe(true);
    expect(Object.isFrozen(keys)).toBe(true);
    expect(keys?.every((key) => Object.isFrozen(key))).toBe(true);
    expect(() => {
      (PINNED_TOOL_SIGNING_TRUST as Record<string, unknown>)["https://evil.example"] = [];
    }).toThrow(TypeError);
  });
});
