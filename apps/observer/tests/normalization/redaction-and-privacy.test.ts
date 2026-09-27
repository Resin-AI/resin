import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  ContentScanner,
  NormalizationPipeline,
  RedactionEngine,
  calculateShannonEntropy,
} from "../../src/normalization/index.js";

describe("Privacy Redaction & Secret Scrubbing", () => {
  const homeDir = "/home/developer";
  const repoRoot = "/home/developer/projects/my-app";

  it("computes Shannon entropy accurately", () => {
    expect(calculateShannonEntropy("")).toBe(0);
    // All same characters -> 0 entropy
    expect(calculateShannonEntropy("aaaaaaaaaaaaaaaa")).toBe(0);
    // High randomness -> high entropy > 4.0
    const highEntropy = "a9B$kL8!xZ2#pQ7*vN4^";
    expect(calculateShannonEntropy(highEntropy)).toBeGreaterThan(4.0);
  });

  describe("high-entropy scanning of path-shaped values", () => {
    const flagged = (text: string, entropyThreshold?: number) =>
      new ContentScanner(entropyThreshold === undefined ? {} : { entropyThreshold })
        .scan(text)
        .map((match) => match.match);

    it.each([
      "backups/inventory-2025-06-01.sql",
      "backups/inventory-2025-06-01.sql.gz",
      "data/archive/2025-06/inventory-2025-06-01.sql.gz",
    ])("does not flag the file path %s", (path) => {
      expect(flagged(`./dbtool restore-test ${path}`)).toEqual([]);
    });

    it.each([
      [
        "a standard-base64 key with short runs between slashes",
        "k9QxB2vT/mZ4pL7r/Yc3Nw8K/dF6hJ1s/Ea5Gu0Wq",
      ],
      ["a URL-safe base64 key", "k9QxB2vT_mZ4pL7r-Yc3Nw8KdF6hJ1sEa5Gu0Wq"],
      ["the AWS example secret", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
      [
        "a URL with userinfo credentials",
        "https://deploy:Zx9Kq2Lm7Pv4Tn8R@git.example.com/org/repo.git",
      ],
      ["a key=value secret", "API_SECRET=Zx9Kq2Lm7Pv4Tn8RwY3b"],
      [
        "a JWT",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ],
    ])("still flags %s", (_name, secret) => {
      expect(flagged(`value ${secret} end`).length).toBeGreaterThan(0);
    });

    it("still flags hex whenever the entropy threshold admits it", () => {
      // Hex carries at most 4 bits per character, under the default threshold; a lower one flags it.
      expect(
        flagged("value 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b end", 3.5).length,
      ).toBeGreaterThan(0);
    });
  });

  it("scans and detects multiple types of secrets in text", () => {
    const scanner = new ContentScanner();

    const sampleText = `
      OpenAI: sk-proj-1234567890abcdef1234567890abcdef
      Anthropic: sk-ant-api03-abcdef1234567890abcdef1234567890_xyz
      GitHub: ghp_1234567890abcdef1234567890abcdef1234
      AWS Access: AKIAIOSFODNN7EXAMPLE
      JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
      Bearer: Bearer mySecretTokenValueWithEnoughLength123456
      Private Key:
      -----BEGIN PRIVATE KEY-----
      MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7V3D
      -----END PRIVATE KEY-----
    `;

    const matches = scanner.scan(sampleText);
    const types = matches.map((m) => m.secretType);

    expect(types).toContain("OPENAI_API_KEY");
    expect(types).toContain("ANTHROPIC_API_KEY");
    expect(types).toContain("GITHUB_TOKEN");
    expect(types).toContain("AWS_ACCESS_KEY_ID");
    expect(types).toContain("JWT");
    expect(types).toContain("PRIVATE_KEY");
    expect(types).toContain("BEARER_TOKEN");
  });

  it("redacts seeded secrets, paths, and env vars through RedactionEngine", () => {
    const engine = new RedactionEngine({
      homeDir,
      repoRoot,
      customSecrets: ["SuperSpecialSecret9988"],
    });

    const payload = {
      message:
        "Connected to repo at /home/developer/projects/my-app/src/index.ts in /home/developer.",
      authInfo: {
        apiKey: "sk-proj-99887766554433221100aabbccddeeff",
        custom: "Here is SuperSpecialSecret9988 for authentication.",
        nested: [
          "Check file /home/developer/secrets.txt",
          "GitHub token: ghp_abcdef1234567890abcdef1234567890abcd",
        ],
      },
      socketPath: "/var/run/internal.sock",
    };

    const result = engine.redact(payload);

    expect(result.isRedacted).toBe(true);
    expect(result.redactionStrategy).toBe("mask");

    // SAFETY: RedactionResult preserves input payload type structure.
    const redactedData = result.data as typeof payload;

    // Check path aliasing
    expect(redactedData.message).toContain("$REPO_ROOT/src/index.ts");
    expect(redactedData.message).toContain("$HOME");
    expect(redactedData.message).not.toContain("/home/developer/projects/my-app");
    expect(redactedData.message).not.toContain("/home/developer.");

    // Check OpenAI API key redacted
    expect(redactedData.authInfo.apiKey).toContain("[REDACTED_OPENAI_API_KEY:");
    expect(redactedData.authInfo.apiKey).not.toContain("sk-proj-99887766554433221100aabbccddeeff");

    // Check custom secret redacted
    expect(redactedData.authInfo.custom).toContain("[REDACTED_SECRET:");
    expect(redactedData.authInfo.custom).not.toContain("SuperSpecialSecret9988");

    // Check nested array redactions
    expect(redactedData.authInfo.nested[0]).toContain("$HOME/secrets.txt");
    expect(redactedData.authInfo.nested[1]).toContain("[REDACTED_GITHUB_TOKEN:");

    // Check local-only field masked
    expect(redactedData.socketPath).toBe("[REDACTED_LOCAL_FIELD:socketPath]");

    // Check fingerprints tracked
    expect(result.fingerprintHashes.length).toBeGreaterThan(0);
    expect(result.scrubbedPatterns.length).toBeGreaterThan(0);
  });

  it("redacts high-entropy strings and truncates oversized text", () => {
    const engine = new RedactionEngine({
      homeDir,
      repoRoot,
      maxStringLength: 50,
      redactHighEntropy: true,
      entropyThreshold: 4.0,
    });

    const highEntropyString = "K9#mQ2$vL8!zX4@wP7^rN1&bT5*cY3~e";
    const longString =
      "This is a very long string that should exceed the 50 character limit configured for content truncation testing.";

    const result = engine.redact({
      secret: highEntropyString,
      longText: longString,
    });

    // SAFETY: RedactionResult data matches expected input object shape.
    const data = result.data as { secret: string; longText: string };

    expect(data.secret).toContain("[REDACTED_HIGH_ENTROPY_SECRET:");
    expect(data.longText).toContain("[TRUNCATED");
    expect(data.longText.length).toBeLessThan(longString.length);
  });

  it("runs full privacy pipeline over a raw record containing secrets", async () => {
    const pipeline = new NormalizationPipeline({
      redactionConfig: {
        homeDir,
        repoRoot,
        customSecrets: ["InternalPassword123!"],
      },
    });

    const rawRecord: RawHarnessRecord = {
      recordId: "rec_secret_1",
      sessionId: "01J5XYZ7890ABCDEFGHJKMNPQR",
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp: "2026-08-17T12:00:00.000Z",
      recordType: "transcript_line",
      rawPayload: {
        role: "user",
        content: `
          Please deploy to /home/developer/projects/my-app with
          API_KEY: sk-proj-123456789012345678901234567890 and
          password: InternalPassword123!
        `,
      },
      cursor: {
        offset: 0,
        line: 1,
        sequence: 1,
        timestamp: "2026-08-17T12:00:00.000Z",
      },
      metadata: {},
    };

    const results = await pipeline.processRecord(rawRecord);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("success");

    if (results[0].status === "success") {
      const event = results[0].event;
      expect(event.type).toBe("message");
      if (event.type === "message") {
        expect(event.content).toContain("$REPO_ROOT");
        expect(event.content).not.toContain("/home/developer/projects/my-app");
        expect(event.content).toContain("[REDACTED_OPENAI_API_KEY:");
        expect(event.content).not.toContain("sk-proj-123456789012345678901234567890");
        expect(event.content).toContain("[REDACTED_SECRET:");
        expect(event.content).not.toContain("InternalPassword123!");
      }

      expect(event.redaction.isRedacted).toBe(true);
      expect(event.redaction.redactionStrategy).toBe("mask");
      expect(event.redaction.redactedFields.length).toBeGreaterThan(0);
      expect(event.redaction.scrubbedPatterns.length).toBeGreaterThan(0);
    }
  });
});
