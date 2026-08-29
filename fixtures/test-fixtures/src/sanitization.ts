/**
 * Fixture Sanitization Engine
 *
 * Prevents secrets (API keys, tokens, passwords), user home directory paths,
 * private IP addresses, and proprietary tokens from entering fixtures and test datasets.
 * Compliant with ADR 0005 (Privacy and Data Residency Boundaries).
 */

export interface SensitivityFinding {
  path: string;
  category: "secret" | "user_path" | "private_ip" | "connection_string";
  rule: string;
  match: string;
  sample: string;
}

export interface SanitizationOptions {
  /** Replace user home directory paths with sandbox equivalents rather than generic redaction */
  normalizeUserPaths?: boolean;
  /** Allow local loopback addresses (127.0.0.1, localhost) in test fixtures */
  allowLoopback?: boolean;
  /** Custom additional sensitive patterns */
  customRules?: Array<{
    name: string;
    category: "secret" | "user_path" | "private_ip" | "connection_string";
    pattern: RegExp;
    replacement: string;
  }>;
  /** Set of object keys whose values should always be completely redacted */
  secretKeyNames?: string[];
}

export interface ScanOptions {
  allowLoopback?: boolean;
  customRules?: Array<{
    name: string;
    category: "secret" | "user_path" | "private_ip" | "connection_string";
    pattern: RegExp;
  }>;
  secretKeyNames?: string[];
}

export class SanitizationViolationError extends Error {
  public readonly findings: SensitivityFinding[];
  public readonly fixtureName?: string;

  constructor(findings: SensitivityFinding[], fixtureName?: string) {
    const summary = findings
      .map(
        (f) =>
          `  - [${f.category.toUpperCase()}] at "${f.path}": matched ${f.rule} ("${f.sample}")`,
      )
      .join("\n");
    const nameStr = fixtureName ? ` in "${fixtureName}"` : "";
    super(
      `Fixture sanitization failed${nameStr} with ${findings.length} violation(s):\n${summary}`,
    );
    this.name = "SanitizationViolationError";
    this.findings = findings;
    this.fixtureName = fixtureName;
  }
}

// ============================================================================
// Detection & Redaction Rules
// ============================================================================

const DEFAULT_SECRET_KEYS: Record<string, true> = {
  password: true,
  passwd: true,
  secret: true,
  apikey: true,
  api_key: true,
  access_token: true,
  refreshtoken: true,
  refresh_token: true,
  private_key: true,
  privatekey: true,
  authorization: true,
  auth_token: true,
  authtoken: true,
  secret_key: true,
  client_secret: true,
};

const SECRET_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  replacement: string;
}> = [
  // OpenAI & Standard AI API keys
  {
    name: "openai_api_key",
    pattern: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b/g,
    replacement: "<REDACTED_API_KEY>",
  },
  // GitHub Personal & OAuth Tokens
  {
    name: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}\b|\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g,
    replacement: "<REDACTED_GITHUB_TOKEN>",
  },
  // Slack Tokens
  {
    name: "slack_token",
    pattern: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g,
    replacement: "<REDACTED_SLACK_TOKEN>",
  },
  // AWS Access Key ID
  {
    name: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "<REDACTED_AWS_KEY>",
  },
  // JWT Tokens (3-part base64url)
  {
    name: "jwt_token",
    pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: "<REDACTED_JWT_TOKEN>",
  },
  // PEM Private Keys
  {
    name: "pem_private_key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "<REDACTED_PRIVATE_KEY>",
  },
  // Bearer Token headers
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{25,}/g,
    replacement: "Bearer <REDACTED_TOKEN>",
  },
];

const CONNECTION_STRING_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  replacement: string;
}> = [
  {
    name: "postgres_uri",
    pattern: /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^/\s]+/g,
    replacement: "postgresql://user:redacted@localhost:5432",
  },
  {
    name: "mongodb_uri",
    pattern: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^/\s]+/g,
    replacement: "mongodb://user:redacted@localhost:27017",
  },
  {
    name: "redis_uri",
    pattern: /redis:\/\/(?::[^@]+@)?[^/\s]+/g,
    replacement: "redis://localhost:6379",
  },
];

const USER_PATH_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  normalizeReplacement: (match: string) => string;
  genericReplacement: string;
}> = [
  // Linux / BSD user homes: /home/username/...
  {
    name: "linux_user_home",
    pattern: /\/home\/(?!sandbox\b)[a-zA-Z0-9._-]+(\/[^\s"'`\\]*)?/g,
    normalizeReplacement: (m) => m.replace(/\/home\/[a-zA-Z0-9._-]+/, "/home/sandbox"),
    genericReplacement: "<REDACTED_USER_PATH>",
  },
  // macOS user homes: /Users/username/...
  {
    name: "macos_user_home",
    pattern: /\/Users\/(?!sandbox\b)[a-zA-Z0-9._-]+(\/[^\s"'`\\]*)?/g,
    normalizeReplacement: (m) => m.replace(/\/Users\/[a-zA-Z0-9._-]+/, "/Users/sandbox"),
    genericReplacement: "<REDACTED_USER_PATH>",
  },
  // Windows user profile: C:\Users\username\...
  {
    name: "windows_user_home",
    pattern:
      /[a-zA-Z]:\\(?:Users|Documents and Settings)\\(?!sandbox\b)[a-zA-Z0-9._-]+(\\[^\s"'`\\]*)?/g,
    normalizeReplacement: (m) =>
      m.replace(
        /[a-zA-Z]:\\(?:Users|Documents and Settings)\\[a-zA-Z0-9._-]+/,
        "C:\\Users\\sandbox",
      ),
    genericReplacement: "<REDACTED_USER_PATH>",
  },
  // Tilde path
  {
    name: "tilde_user_path",
    pattern: /~(?:\/(?!sandbox\b)[a-zA-Z0-9._-]+(?:\/[^\s"'`\\]*)?)/g,
    normalizeReplacement: (m) => m.replace(/~\/[a-zA-Z0-9._-]+/, "~/sandbox"),
    genericReplacement: "<REDACTED_USER_PATH>",
  },
];

const PRIVATE_IP_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  replacement: string;
  isLoopback?: boolean;
}> = [
  // 10.0.0.0/8
  {
    name: "private_ip_10",
    pattern:
      /\b10\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    replacement: "<REDACTED_PRIVATE_IP>",
  },
  // 172.16.0.0/12
  {
    name: "private_ip_172",
    pattern:
      /\b172\.(?:1[6-9]|2\d|3[0-1])\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    replacement: "<REDACTED_PRIVATE_IP>",
  },
  // 192.168.0.0/16
  {
    name: "private_ip_192_168",
    pattern:
      /\b192\.168\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    replacement: "<REDACTED_PRIVATE_IP>",
  },
  // 127.0.0.0/8 loopback (when loopback is not allowed)
  {
    name: "loopback_ip",
    pattern:
      /\b127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    replacement: "<REDACTED_LOOPBACK_IP>",
    isLoopback: true,
  },
  // IPv6 ULA (fc00::/7) or Link-local (fe80::/10)
  {
    name: "private_ipv6",
    pattern: /\b(?:fd[0-9a-fA-F]{2}|fe80):[0-9a-fA-F:]+\b/g,
    replacement: "<REDACTED_PRIVATE_IPV6>",
  },
];

// ============================================================================
// Core Scanning & Redaction Functions
// ============================================================================

/**
 * Scan a text string or structured object for any sensitive information.
 */
export function scanForSensitiveData(
  target: unknown,
  options: ScanOptions = {},
): SensitivityFinding[] {
  const findings: SensitivityFinding[] = [];
  const allowLoopback = options.allowLoopback ?? true;
  const customSecretKeys: Record<string, true> = {};
  if (options.secretKeyNames) {
    for (const k of options.secretKeyNames) {
      customSecretKeys[k.toLowerCase()] = true;
    }
  }

  function scanText(text: string, pathStr: string): void {
    // 1. Secrets
    for (const rule of SECRET_PATTERNS) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          path: pathStr,
          category: "secret",
          rule: rule.name,
          match: match[0],
          sample: match[0].length > 30 ? `${match[0].slice(0, 27)}...` : match[0],
        });
      }
    }

    // 2. Connection Strings
    for (const rule of CONNECTION_STRING_PATTERNS) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          path: pathStr,
          category: "connection_string",
          rule: rule.name,
          match: match[0],
          sample: match[0].length > 30 ? `${match[0].slice(0, 27)}...` : match[0],
        });
      }
    }

    // 3. User Paths
    for (const rule of USER_PATH_PATTERNS) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          path: pathStr,
          category: "user_path",
          rule: rule.name,
          match: match[0],
          sample: match[0],
        });
      }
    }

    // 4. Private IPs
    for (const rule of PRIVATE_IP_PATTERNS) {
      if (rule.isLoopback && allowLoopback) {
        continue;
      }
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          path: pathStr,
          category: "private_ip",
          rule: rule.name,
          match: match[0],
          sample: match[0],
        });
      }
    }

    // 5. Custom Rules
    if (options.customRules) {
      for (const rule of options.customRules) {
        const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          findings.push({
            path: pathStr,
            category: rule.category,
            rule: rule.name,
            match: match[0],
            sample: match[0].length > 30 ? `${match[0].slice(0, 27)}...` : match[0],
          });
        }
      }
    }
  }

  function traverse(value: unknown, currentPath: string): void {
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      scanText(value, currentPath || "$");
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        traverse(value[i], `${currentPath}[${i}]`);
      }
      return;
    }

    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const subPath = currentPath ? `${currentPath}.${k}` : k;
        const lowerKey = k.toLowerCase();

        if (
          (DEFAULT_SECRET_KEYS[lowerKey] || customSecretKeys[lowerKey]) &&
          typeof v === "string" &&
          v.length > 0 &&
          !v.startsWith("<REDACTED_")
        ) {
          findings.push({
            path: subPath,
            category: "secret",
            rule: "sensitive_key_name",
            match: v,
            sample: v.length > 20 ? `${v.slice(0, 17)}...` : v,
          });
        }

        traverse(v, subPath);
      }
    }
  }

  traverse(target, "");
  return findings;
}

/**
 * Redact sensitive substrings inside a text string.
 */
export function redactSensitiveText(text: string, options: SanitizationOptions = {}): string {
  let result = text;
  const allowLoopback = options.allowLoopback ?? true;
  const normalizePaths = options.normalizeUserPaths ?? true;

  // 1. Secrets
  for (const rule of SECRET_PATTERNS) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 2. Connection Strings
  for (const rule of CONNECTION_STRING_PATTERNS) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 3. User Paths
  for (const rule of USER_PATH_PATTERNS) {
    if (normalizePaths) {
      result = result.replace(rule.pattern, (m) => rule.normalizeReplacement(m));
    } else {
      result = result.replace(rule.pattern, rule.genericReplacement);
    }
  }

  // 4. Private IPs
  for (const rule of PRIVATE_IP_PATTERNS) {
    if (rule.isLoopback && allowLoopback) {
      continue;
    }
    result = result.replace(rule.pattern, rule.replacement);
  }

  // 5. Custom Rules
  if (options.customRules) {
    for (const rule of options.customRules) {
      result = result.replace(rule.pattern, rule.replacement);
    }
  }

  return result;
}

/**
 * Deeply clone and sanitize any fixture object, string, or dataset.
 */
export function sanitizeFixture<T>(target: T, options: SanitizationOptions = {}): T {
  const customSecretKeys: Record<string, true> = {};
  if (options.secretKeyNames) {
    for (const k of options.secretKeyNames) {
      customSecretKeys[k.toLowerCase()] = true;
    }
  }

  function transform(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return redactSensitiveText(value, options);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => transform(item));
    }

    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const lowerKey = k.toLowerCase();
        if (
          (DEFAULT_SECRET_KEYS[lowerKey] || customSecretKeys[lowerKey]) &&
          typeof v === "string"
        ) {
          result[k] = "<REDACTED_SECRET>";
        } else {
          result[k] = transform(v);
        }
      }
      return result;
    }

    return value;
  }

  return transform(target) as T;
}

/**
 * Assert that a fixture or dataset contains zero sensitive secrets, private paths, or unauthorized IPs.
 * Throws SanitizationViolationError if any sensitive data is discovered.
 */
export function assertSanitized(
  target: unknown,
  fixtureName?: string,
  options: ScanOptions = {},
): void {
  const findings = scanForSensitiveData(target, options);
  if (findings.length > 0) {
    throw new SanitizationViolationError(findings, fixtureName);
  }
}

/**
 * Check if a text contains any sensitive information.
 */
export function isSensitive(text: string, options: ScanOptions = {}): boolean {
  return scanForSensitiveData(text, options).length > 0;
}
