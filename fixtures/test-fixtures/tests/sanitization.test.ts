import { describe, expect, it } from "vitest";
import {
  SanitizationViolationError,
  assertSanitized,
  isSensitive,
  redactSensitiveText,
  sanitizeFixture,
  scanForSensitiveData,
} from "../src/sanitization.js";

describe("Fixture Sanitization Engine", () => {
  describe("Secret Scanning & Redaction", () => {
    it("detects OpenAI / AI API keys", () => {
      const text = "Client initialized with sk-proj-1234567890abcdef1234567890abcdef";
      const findings = scanForSensitiveData(text);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].category).toBe("secret");
      expect(findings[0].rule).toBe("openai_api_key");

      const redacted = redactSensitiveText(text);
      expect(redacted).toContain("<REDACTED_API_KEY>");
      expect(redacted).not.toContain("sk-proj-");
    });

    it("detects GitHub tokens", () => {
      const text = "Cloning with ghp_1234567890abcdef1234567890abcdef12";
      const findings = scanForSensitiveData(text);
      expect(findings.some((f) => f.rule === "github_token")).toBe(true);

      const redacted = redactSensitiveText(text);
      expect(redacted).toContain("<REDACTED_GITHUB_TOKEN>");
    });

    it("detects Slack tokens", () => {
      const text = "Webhook using xoxb-1234567890-abcdefghij";
      const findings = scanForSensitiveData(text);
      expect(findings.some((f) => f.rule === "slack_token")).toBe(true);

      const redacted = redactSensitiveText(text);
      expect(redacted).toContain("<REDACTED_SLACK_TOKEN>");
    });

    it("detects AWS Access Keys", () => {
      const text = "Connecting to S3 with key AKIAIOSFODNN7EXAMPLE";
      const findings = scanForSensitiveData(text);
      expect(findings.some((f) => f.rule === "aws_access_key")).toBe(true);

      const redacted = redactSensitiveText(text);
      expect(redacted).toContain("<REDACTED_AWS_KEY>");
    });

    it("detects JWT tokens", () => {
      const text =
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN_mock_signature_part_here";
      const findings = scanForSensitiveData(text);
      expect(findings.some((f) => f.rule === "jwt_token" || f.rule === "bearer_token")).toBe(true);

      const redacted = redactSensitiveText(text);
      expect(redacted).not.toContain("dozjgN_mock_signature");
    });

    it("detects PEM private keys", () => {
      const pemKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0mockKeyContentHere1234567890abcdef
-----END RSA PRIVATE KEY-----`;
      const findings = scanForSensitiveData(pemKey);
      expect(findings.some((f) => f.rule === "pem_private_key")).toBe(true);

      const redacted = redactSensitiveText(pemKey);
      expect(redacted).toBe("<REDACTED_PRIVATE_KEY>");
    });
  });

  describe("User Path Normalization & Redaction", () => {
    it("normalizes Linux user home paths to sandbox", () => {
      const text = "Reading config from /home/alice_smith/.config/tool.json";
      const findings = scanForSensitiveData(text);
      expect(findings.some((f) => f.category === "user_path")).toBe(true);

      const normalized = redactSensitiveText(text, { normalizeUserPaths: true });
      expect(normalized).toBe("Reading config from /home/sandbox/.config/tool.json");
    });

    it("normalizes macOS user home paths to sandbox", () => {
      const text = "Loaded /Users/bob_dev/Library/Preferences/app.json";
      const findings = scanForSensitiveData(text);
      expect(findings.some((f) => f.category === "user_path")).toBe(true);

      const normalized = redactSensitiveText(text, { normalizeUserPaths: true });
      expect(normalized).toBe("Loaded /Users/sandbox/Library/Preferences/app.json");
    });

    it("normalizes Windows user profile paths", () => {
      const text = "Writing to C:\\Users\\charlie_smith\\AppData\\Local\\config.json";
      const findings = scanForSensitiveData(text);
      expect(findings.some((f) => f.category === "user_path")).toBe(true);

      const normalized = redactSensitiveText(text, { normalizeUserPaths: true });
      expect(normalized).toBe("Writing to C:\\Users\\sandbox\\AppData\\Local\\config.json");
    });
  });

  describe("Private IP Scanning", () => {
    it("detects RFC 1918 private IPv4 addresses", () => {
      const text10 = "Connected to 10.0.4.15 on port 8080";
      const text172 = "Connected to 172.20.10.5 on port 5432";
      const text192 = "Connected to 192.168.1.100 on port 22";

      expect(scanForSensitiveData(text10).some((f) => f.category === "private_ip")).toBe(true);
      expect(scanForSensitiveData(text172).some((f) => f.category === "private_ip")).toBe(true);
      expect(scanForSensitiveData(text192).some((f) => f.category === "private_ip")).toBe(true);
    });

    it("respects allowLoopback option", () => {
      const loopback = "http://127.0.0.1:8080/v1/health";
      expect(scanForSensitiveData(loopback, { allowLoopback: true }).length).toBe(0);
      expect(scanForSensitiveData(loopback, { allowLoopback: false }).length).toBeGreaterThan(0);
    });
  });

  describe("Connection String Redaction", () => {
    it("redacts credentials from database URIs", () => {
      const uri = "postgresql://dbuser:supersecretpass123@db.internal.corp:5432/production";
      const findings = scanForSensitiveData(uri);
      expect(findings.some((f) => f.category === "connection_string")).toBe(true);

      const redacted = redactSensitiveText(uri);
      expect(redacted).not.toContain("supersecretpass123");
      expect(redacted).toContain("redacted");
    });
  });

  describe("Deep Fixture Sanitization", () => {
    it("sanitizes complex nested fixture objects and arrays", () => {
      const fixture = {
        sessionId: "ses_001",
        userProfile: {
          homeDir: "/Users/dev_user/project",
          apiKey: "sk-proj-1234567890abcdef1234567890abcdef",
        },
        logs: ["Connect to 192.168.0.50", "Token ghp_1234567890abcdef1234567890abcdef12 provided"],
      };

      const cleaned = sanitizeFixture(fixture, { normalizeUserPaths: true });
      expect(cleaned.userProfile.homeDir).toBe("/Users/sandbox/project");
      expect(cleaned.userProfile.apiKey).toBe("<REDACTED_SECRET>");
      expect(cleaned.logs[0]).toContain("<REDACTED_PRIVATE_IP>");
      expect(cleaned.logs[1]).toContain("<REDACTED_GITHUB_TOKEN>");
    });

    it("assertSanitized passes for clean fixtures and throws SanitizationViolationError on violations", () => {
      const cleanFixture = {
        id: "evt_001",
        path: "/workspaces/resin/src/index.ts",
        status: "ok",
      };
      expect(() => assertSanitized(cleanFixture, "cleanFixture")).not.toThrow();

      const dirtyFixture = {
        id: "evt_002",
        secret: "superSecretPassword123",
      };
      expect(() => assertSanitized(dirtyFixture, "dirtyFixture")).toThrow(
        SanitizationViolationError,
      );
    });

    it("isSensitive returns true when sensitivity is detected", () => {
      expect(isSensitive("sk-proj-1234567890abcdef1234567890abcdef")).toBe(true);
      expect(isSensitive("hello world standard text")).toBe(false);
    });
  });
});
