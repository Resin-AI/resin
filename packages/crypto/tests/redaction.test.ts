import { describe, expect, it } from "vitest";
import { SecretRedactor } from "../src/redaction.js";

describe("SecretRedactor", () => {
  it("redacts exact registered secrets with named placeholders", () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret("sk-proj-1234567890abcdef", "OPENAI_KEY");

    const input = "Using OPENAI_KEY sk-proj-1234567890abcdef in API call";
    const redacted = redactor.redact(input);

    expect(redacted).toBe("Using OPENAI_KEY [REDACTED:OPENAI_KEY] in API call");
    expect(redacted).not.toContain("sk-proj-1234567890abcdef");
  });

  it("redacts base64, hex, and URL-encoded variants of registered secrets", () => {
    const redactor = new SecretRedactor();
    const rawSecret = "super-secret-token-value-99";
    redactor.registerSecret(rawSecret, "MY_TOKEN");

    // Base64
    const b64 = Buffer.from(rawSecret, "utf-8").toString("base64");
    const b64Input = `Auth header is Basic ${b64}`;
    expect(redactor.redact(b64Input)).toContain("[REDACTED_B64:MY_TOKEN]");

    // Hex
    const hex = Buffer.from(rawSecret, "utf-8").toString("hex");
    const hexInput = `Hex representation: ${hex}`;
    expect(redactor.redact(hexInput)).toContain("[REDACTED_HEX:MY_TOKEN]");

    // URL encoded
    const rawWithSpecial = "secret key with spaces & symbols = 123";
    redactor.registerSecret(rawWithSpecial, "SPECIAL_KEY");
    const urlEnc = encodeURIComponent(rawWithSpecial);
    const urlInput = `https://api.example.com/endpoint?token=${urlEnc}`;
    expect(redactor.redact(urlInput)).toContain("[REDACTED_URL:SPECIAL_KEY]");
  });

  it("redacts standard secret patterns (Bearer tokens, GitHub tokens, AWS keys)", () => {
    const redactor = new SecretRedactor();

    const text = [
      "Authorization: Bearer my-long-secret-bearer-token-123456789",
      "GitHub Token: ghp_123456789012345678901234567890123456",
      "AWS ID: AKIAIOSFODNN7EXAMPLE",
      'Config: {"api_key": "unregistered-secret-key-123"}',
    ].join("\n");

    const redacted = redactor.redact(text);

    expect(redacted).not.toContain("my-long-secret-bearer-token-123456789");
    expect(redacted).not.toContain("ghp_123456789012345678901234567890123456");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).toContain("Bearer [REDACTED_BEARER_TOKEN]");
    expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redacted).toContain("[REDACTED_AWS_KEY_ID]");
    expect(redacted).toContain('"api_key": "[REDACTED]"');
  });

  it("redacts nested objects, arrays, and Error objects", () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret("sensitive-db-password", "DB_PASS");

    const payload = {
      user: "admin",
      connection: {
        uri: "postgres://admin:sensitive-db-password@db.internal:5432",
        params: ["--password=sensitive-db-password"],
      },
    };

    const sanitized = redactor.redactObject(payload);
    expect(sanitized.connection.uri).toBe("postgres://admin:[REDACTED:DB_PASS]@db.internal:5432");
    expect(sanitized.connection.params[0]).toBe("--password=[REDACTED:DB_PASS]");

    const err = new Error("Failed to connect with password sensitive-db-password");
    const sanitizedErr = redactor.redactObject(err);
    expect(sanitizedErr.message).toBe("Failed to connect with password [REDACTED:DB_PASS]");
  });

  it("tracks fingerprints and secret count", () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret("secret-one", "S1");
    redactor.registerSecret("secret-two", "S2");

    expect(redactor.getRegisteredCount()).toBe(2);
    const fingerprints = redactor.getFingerprints();
    expect(fingerprints).toHaveLength(2);

    expect(redactor.hasSecret("Text containing secret-one")).toBe(true);
    expect(redactor.hasSecret("Clean text without any secrets")).toBe(false);

    redactor.unregisterSecret("S1");
    expect(redactor.getRegisteredCount()).toBe(1);
    expect(redactor.hasSecret("Text containing secret-one")).toBe(false);
  });
});
