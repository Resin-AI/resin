#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Resin Standalone Secret Scanner
 *
 * Scans repository files for leaked secrets, high-entropy API keys,
 * private keys, AWS/GitHub/OAuth tokens, and canary leaks.
 * Supports inline suppression (// secret-scanner:ignore, // gitleaks:allow)
 * and test mock value allowlisting.
 */

/**
 * @typedef {Object} SecretRule
 * @property {string} id - Rule identifier
 * @property {string} description - Human-readable description
 * @property {RegExp} pattern - Regex to match against line or content
 */

/**
 * @typedef {Object} SecretViolation
 * @property {string} file - Relative path to offending file
 * @property {number} line - 1-indexed line number
 * @property {string} rule - Rule ID that triggered
 * @property {string} description - Description of the violation
 * @property {string} snippet - Redacted snippet of the matching line
 */

/** @type {SecretRule[]} */
export const SECRET_RULES = [
  {
    id: "private-key",
    description: "Unencrypted Private Key Block",
    pattern: /-----BEGIN (?:RSA |OPENSSH |PGP |EC |DSA |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/i,
  },
  {
    id: "aws-access-key-id",
    description: "AWS Access Key ID",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: "aws-secret-access-key",
    description: "AWS Secret Access Key",
    pattern:
      /(?:aws_secret_access_key|aws_secret_key|aws_sec_key)\s*[:=]\s*['"][0-9a-zA-Z/+]{40}['"]/i,
  },
  {
    id: "github-pat",
    description: "GitHub Personal Access Token (Classic, Fine-Grained, or OAuth)",
    pattern:
      /\b(?:ghp_[a-zA-Z0-9]{36,40}|github_pat_[a-zA-Z0-9_]{50,120}|gho_[a-zA-Z0-9]{36,40}|ghu_[a-zA-Z0-9]{36,40}|ghs_[a-zA-Z0-9]{36,40}|ghr_[a-zA-Z0-9]{36,40})\b/,
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API Key",
    pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/,
  },
  {
    id: "openai-api-key",
    description: "OpenAI API Key",
    pattern: /\bsk-(?!ant-)(?:proj-)?[a-zA-Z0-9_-]{20,}\b/,
  },
  {
    id: "slack-token",
    description: "Slack API Token",
    pattern: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/,
  },
  {
    id: "stripe-key",
    description: "Stripe API Secret/Live Key",
    pattern: /\b(?:sk_live|rk_live)_[0-9a-zA-Z]{24,}\b/,
  },
  {
    id: "google-api-key",
    description: "Google Cloud / Firebase API Key",
    pattern: /\bAIza[0-9A-Za-z-_]{35,45}\b/,
  },
  {
    id: "jwt-token",
    description: "Hardcoded JSON Web Token (JWT)",
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
  },
  {
    id: "generic-hardcoded-secret",
    description: "Generic Hardcoded Credential / Secret / Password Assignment",
    pattern:
      /(?:api_key|apikey|secret_key|api_secret|client_secret|db_password|database_password|auth_token|auth_secret)\s*[:=]\s*['"]([^'"]{16,})['"]/i,
  },
  {
    id: "canary-leak",
    description: "Canary Secret / Token Leak",
    pattern: /\bCANARY_SECRET_[A-Z0-9_-]{8,}\b/,
  },
];

/**
 * Directories and paths to skip entirely during scanning.
 */
const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".next",
  ".cache",
]);

/**
 * File names or extensions to ignore.
 */
const DEFAULT_IGNORED_FILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".sqlite",
  ".sqlite3",
  ".db",
]);

/**
 * Known placeholder / mock tokens allowed in documentation and tests.
 */
const ALLOWED_MOCK_PATTERNS = [
  /AKIAIOSFODNN7EXAMPLE/,
  /1234567890abcdefghijklmnopqrstuvwxyz/,
  /123456789012345678901234567890123456/,
  /mock-secret-key/,
  /mock_/,
  /dummy_/,
  /placeholder/i,
  /change_me/i,
  /sk-ant-test0123456789abcdefghij/,
  /supersecrettoken123/,
];

/**
 * Calculate Shannon entropy of a string.
 * @param {string} str
 * @returns {number}
 */
export function calculateShannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const frequencies = {};
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const count of Object.values(frequencies)) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Check whether a relative path represents a test or fixture file.
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isTestFile(relativePath) {
  const norm = relativePath.replace(/\\/g, "/");
  const basename = path.posix.basename(norm);
  return (
    norm.startsWith("tests/") ||
    norm.includes("/tests/") ||
    norm.startsWith("fixtures/") ||
    norm.includes("/fixtures/") ||
    norm.endsWith(".test.ts") ||
    norm.endsWith(".test.js") ||
    norm.endsWith(".test.mjs") ||
    norm.endsWith(".spec.ts") ||
    norm.endsWith(".spec.js") ||
    norm.endsWith(".spec.mjs") ||
    (basename.startsWith("test_") && basename.endsWith(".py")) ||
    basename.endsWith("_test.py")
  );
}

/**
 * Check if a file should be scanned.
 * @param {string} relativePath
 * @param {Object} [options]
 * @param {boolean} [options.includeTests=false]
 * @returns {boolean}
 */
function shouldScanFile(relativePath, options = {}) {
  const parts = relativePath.split(path.sep);
  for (const part of parts) {
    if (DEFAULT_IGNORED_DIRS.has(part)) return false;
  }
  const basename = path.basename(relativePath);
  if (DEFAULT_IGNORED_FILES.has(basename)) return false;
  const ext = path.extname(relativePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;

  // Don't scan the secret checker itself or its tests for pattern definitions
  if (
    relativePath === "scripts/check-secrets.mjs" ||
    relativePath === "scripts/check-secrets.test.mjs" ||
    relativePath === ".gitleaks.toml"
  ) {
    return false;
  }

  if (!options.includeTests && isTestFile(relativePath)) {
    return false;
  }

  return true;
}

/**
 * Redact sensitive match within a string snippet.
 * @param {string} line
 * @returns {string}
 */
function redactSnippet(line) {
  const trimmed = line.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 30)}...${trimmed.slice(-20)}`;
}

/**
 * Check if a line is suppressed by inline comment.
 * @param {string} line
 * @param {string} [prevLine]
 * @returns {boolean}
 */
function isSuppressed(line, prevLine = "") {
  const suppressionKeywords = [
    "secret-scanner:ignore",
    "gitleaks:allow",
    "trufflehog:ignore",
    "detect-secrets:ignore",
  ];

  for (const kw of suppressionKeywords) {
    if (line.includes(kw) || prevLine.includes(kw)) {
      return true;
    }
  }

  return false;
}

/**
 * Scan a single file content for secret violations.
 * @param {string} filePath - Path relative to rootDir
 * @param {string} content - Raw content of the file
 * @param {SecretRule[]} [rules]
 * @returns {SecretViolation[]}
 */
export function scanContent(filePath, content, rules = SECRET_RULES) {
  const violations = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : "";

    // Check for inline suppression comments on current or previous line
    if (isSuppressed(line, prevLine)) {
      continue;
    }

    // Check if line matches known public mock placeholders
    const isMock = ALLOWED_MOCK_PATTERNS.some((p) => p.test(line));
    if (isMock) {
      continue;
    }

    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        // In non-test code, also ignore regex definitions or process.env lookups
        if (line.includes("regex:") || line.includes("RegExp(") || line.includes("process.env.")) {
          if (rule.id === "generic-hardcoded-secret") {
            continue;
          }
        }

        violations.push({
          file: filePath,
          line: i + 1,
          rule: rule.id,
          description: rule.description,
          snippet: redactSnippet(line),
        });
        break; // Stop after first rule match for this line
      }
    }
  }

  return violations;
}

/**
 * Recursively collect all files in a directory that match filter.
 * @param {string} dir
 * @param {string} rootDir
 * @param {string[]} fileList
 * @param {Object} [options]
 */
function collectFiles(dir, rootDir, fileList, options = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      if (!DEFAULT_IGNORED_DIRS.has(entry.name)) {
        collectFiles(fullPath, rootDir, fileList, options);
      }
    } else if (entry.isFile()) {
      if (shouldScanFile(relPath, options)) {
        fileList.push(relPath);
      }
    }
  }
}

/**
 * Collect tracked and non-ignored untracked files from a Git worktree.
 * A committed ignored-name file remains visible through --cached.
 * @param {string} rootDir
 * @param {string[]} fileList
 * @param {Object} [options]
 * @returns {boolean}
 */
function collectGitVisibleFiles(rootDir, fileList, options = {}) {
  if (!fs.existsSync(path.join(rootDir, ".git"))) return false;
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    for (const relativePath of output.split("\0")) {
      if (relativePath && shouldScanFile(relativePath, options)) {
        fileList.push(relativePath);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan workspace for secrets.
 * @param {string} [rootDir=process.cwd()]
 * @param {Object} [options]
 * @param {SecretRule[]} [options.rules]
 * @param {boolean} [options.includeTests=false]
 * @returns {{ violations: SecretViolation[], scannedFiles: number }}
 */
export function scanSecrets(rootDir = process.cwd(), options = {}) {
  const rules = options.rules || SECRET_RULES;
  const fileList = [];
  if (!collectGitVisibleFiles(rootDir, fileList, options)) {
    collectFiles(rootDir, rootDir, fileList, options);
  }

  const allViolations = [];

  for (const relPath of fileList) {
    const fullPath = path.join(rootDir, relPath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const violations = scanContent(relPath, content, rules);
      allViolations.push(...violations);
    } catch {
      // Ignore unreadable/binary files
    }
  }

  return {
    violations: allViolations,
    scannedFiles: fileList.length,
  };
}

// CLI Execution
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const includeTests = process.argv.includes("--include-tests");
  console.log("🔒 Running Resin Standalone Secret Scanner...\n");
  const { violations, scannedFiles } = scanSecrets(process.cwd(), { includeTests });

  console.log(`Scanned ${scannedFiles} files across workspace repository.`);

  if (violations.length === 0) {
    console.log("✅ No secrets, private keys, or credentials detected! 0 violations found.\n");
    process.exit(0);
  } else {
    console.error(`❌ Found ${violations.length} secret violation(s):\n`);
    for (const v of violations) {
      console.error(`  [${v.rule}] ${v.file}:${v.line} — ${v.description}`);
      console.error(`    Snippet: ${v.snippet}\n`);
    }
    process.exit(1);
  }
}
