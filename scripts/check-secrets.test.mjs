import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  SECRET_RULES,
  calculateShannonEntropy,
  isTestFile,
  scanContent,
  scanSecrets,
} from "./check-secrets.mjs";

describe("check-secrets", () => {
  const rootDir = process.cwd();

  describe("Rule Definitions", () => {
    it("defines rules for all key secret categories", () => {
      const ruleIds = SECRET_RULES.map((r) => r.id);
      expect(ruleIds).toContain("private-key");
      expect(ruleIds).toContain("aws-access-key-id");
      expect(ruleIds).toContain("aws-secret-access-key");
      expect(ruleIds).toContain("github-pat");
      expect(ruleIds).toContain("openai-api-key");
      expect(ruleIds).toContain("anthropic-api-key");
      expect(ruleIds).toContain("slack-token");
      expect(ruleIds).toContain("stripe-key");
      expect(ruleIds).toContain("google-api-key");
      expect(ruleIds).toContain("jwt-token");
      expect(ruleIds).toContain("generic-hardcoded-secret");
      expect(ruleIds).toContain("canary-leak");
    });
  });

  describe("calculateShannonEntropy", () => {
    it("returns 0 for empty string", () => {
      expect(calculateShannonEntropy("")).toBe(0);
    });

    it("returns 0 for single character repeated", () => {
      expect(calculateShannonEntropy("aaaaaa")).toBe(0);
    });

    it("returns higher entropy for random string than repetitive string", () => {
      const lowEntropy = calculateShannonEntropy("abababababab");
      const highEntropy = calculateShannonEntropy("a8F9#zK2$qL1!mN0");
      expect(highEntropy).toBeGreaterThan(lowEntropy);
    });
  });

  describe("isTestFile", () => {
    it("identifies test files and fixtures accurately", () => {
      expect(isTestFile("apps/cli/tests/index.test.ts")).toBe(true);
      expect(isTestFile("packages/runtime/src/auth.spec.js")).toBe(true);
      expect(isTestFile("fixtures/test-fixtures/src/index.ts")).toBe(true);
      expect(isTestFile("scripts/test_creation_qualification.py")).toBe(true);
      expect(isTestFile("scripts/qualification_test.py")).toBe(true);
      expect(isTestFile("apps/cloud/src/server/api.ts")).toBe(false);
      expect(isTestFile("scripts/package-release.mjs")).toBe(false);
    });
  });

  describe("scanContent detection", () => {
    it("detects private key blocks", () => {
      const content = `
const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
`;
      const violations = scanContent("src/auth.ts", content);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].rule).toBe("private-key");
    });

    it("detects AWS Access Key IDs", () => {
      const content = 'const awsKey = "AKIA1234567890ABCDEF";';
      const violations = scanContent("src/storage.ts", content);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("aws-access-key-id");
    });

    it("detects AWS Secret Access Keys", () => {
      const content = 'const aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";';
      const violations = scanContent("src/aws.ts", content);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("aws-secret-access-key");
    });

    it("detects GitHub PATs (classic & fine-grained)", () => {
      const classic = 'const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";';
      const violationsClassic = scanContent("src/github.ts", classic);
      expect(violationsClassic).toHaveLength(1);
      expect(violationsClassic[0].rule).toBe("github-pat");

      const fineGrained =
        'const pat = "github_pat_11AAAAAAA0123456789abc_defghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012";';
      const violationsFine = scanContent("src/github.ts", fineGrained);
      expect(violationsFine).toHaveLength(1);
      expect(violationsFine[0].rule).toBe("github-pat");
    });

    it("detects OpenAI and Anthropic API keys", () => {
      const openAi = 'const openAiKey = "sk-proj-abc1234567890def1234567890";';
      const violationsOai = scanContent("src/ai.ts", openAi);
      expect(violationsOai).toHaveLength(1);
      expect(violationsOai[0].rule).toBe("openai-api-key");

      const anthropic = 'const anthropicKey = "sk-ant-api03-abcdef1234567890ghij";';
      const violationsAnt = scanContent("src/ai.ts", anthropic);
      expect(violationsAnt).toHaveLength(1);
      expect(violationsAnt[0].rule).toBe("anthropic-api-key");
    });

    it("detects Slack tokens and Stripe keys", () => {
      const slack = 'const slackBot = "xoxb-1234567890-123456789012-abcdef123456";';
      expect(scanContent("src/slack.ts", slack)[0].rule).toBe("slack-token");

      const stripe = 'const stripeSecret = "sk_live_51AbCdEfGhIjKlMnOpQrStUvWxYz01234";';
      expect(scanContent("src/stripe.ts", stripe)[0].rule).toBe("stripe-key");
    });

    it("detects Google API keys", () => {
      const google = 'const gkey = "AIzaSyD-1234567890abcdefghijklmnopqrstuv";';
      expect(scanContent("src/google.ts", google)[0].rule).toBe("google-api-key");
    });

    it("detects canary token leaks", () => {
      const canary = 'const leak = "CANARY_SECRET_PROD_DATABASE_ADMIN";';
      const violations = scanContent("src/config.ts", canary);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("canary-leak");
    });
  });

  describe("Suppression and allowlisting", () => {
    it("respects inline secret-scanner:ignore comment", () => {
      const content =
        'const key = "AKIA1234567890ABCDEF"; // secret-scanner:ignore - intentional test dummy';
      const violations = scanContent("src/storage.ts", content);
      expect(violations).toHaveLength(0);
    });

    it("respects inline gitleaks:allow comment", () => {
      const content = 'const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"; // gitleaks:allow';
      const violations = scanContent("src/github.ts", content);
      expect(violations).toHaveLength(0);
    });

    it("respects previous-line suppression comment", () => {
      const content = `
// secret-scanner:ignore
const key = "AKIA1234567890ABCDEF";
`;
      const violations = scanContent("src/storage.ts", content);
      expect(violations).toHaveLength(0);
    });

    it("allows standard mock dummy patterns", () => {
      const content = 'const docKey = "AKIAIOSFODNN7EXAMPLE";';
      const violations = scanContent("src/aws.ts", content);
      expect(violations).toHaveLength(0);
    });
  });

  describe("scanSecrets live repository check", () => {
    it("scans the workspace repository and finds 0 secret leaks", () => {
      const result = scanSecrets(rootDir);
      expect(result.violations).toEqual([]);
      expect(result.scannedFiles).toBeGreaterThan(100);
    });

    it("flags violations in a temporary directory with a real leaked token", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-test-leak-"));
      try {
        const secretFilePath = path.join(tempDir, "leaked-credentials.ts");
        fs.writeFileSync(secretFilePath, 'export const AWS_KEY = "AKIA1234567890ABCDEF";\n');

        const result = scanSecrets(tempDir);
        expect(result.violations.length).toBe(1);
        expect(result.violations[0].rule).toBe("aws-access-key-id");
        expect(result.violations[0].file).toBe("leaked-credentials.ts");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
    it("skips gitignored local secrets while still scanning tracked ignored-name files", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-git-"));
      try {
        execFileSync("git", ["init", "--quiet"], { cwd: tempDir });
        fs.writeFileSync(path.join(tempDir, ".gitignore"), ".env\n", "utf8");
        fs.writeFileSync(
          path.join(tempDir, ".env"),
          "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n",
          "utf8",
        );
        fs.writeFileSync(path.join(tempDir, "safe.ts"), "export const safe = true;\n", "utf8");

        expect(scanSecrets(tempDir).violations).toEqual([]);

        execFileSync("git", ["add", ".gitignore", "safe.ts"], { cwd: tempDir });
        execFileSync("git", ["add", "--force", ".env"], { cwd: tempDir });
        const trackedResult = scanSecrets(tempDir);
        expect(trackedResult.violations).toHaveLength(1);
        expect(trackedResult.violations[0].file).toBe(".env");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
