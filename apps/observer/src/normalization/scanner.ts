/**
 * Match result from secret scanning.
 */
export interface SecretMatch {
  patternId: string;
  secretType: string;
  match: string;
  start: number;
  end: number;
  confidence: "high" | "medium" | "low";
  entropy?: number;
}

/**
 * Scanner rule definition.
 */
export interface ScannerRule {
  id: string;
  name: string;
  secretType: string;
  regex: RegExp;
  minEntropy?: number;
  confidence: "high" | "medium" | "low";
}

/**
 * Computes the Shannon entropy of a string (in bits per symbol).
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) {
    return 0;
  }

  const charCounts: Record<string, number> = {};
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    charCounts[ch] = (charCounts[ch] ?? 0) + 1;
  }

  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(charCounts)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

export const DEFAULT_SCANNER_RULES: ScannerRule[] = [
  {
    id: "openai_api_key",
    name: "OpenAI API Key",
    secretType: "OPENAI_API_KEY",
    regex: /\bsk-(?!ant-)(?:proj-|admin-|none-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    confidence: "high",
  },
  {
    id: "anthropic_api_key",
    name: "Anthropic API Key",
    secretType: "ANTHROPIC_API_KEY",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    confidence: "high",
  },
  {
    id: "github_token",
    name: "GitHub Personal Access Token",
    secretType: "GITHUB_TOKEN",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    confidence: "high",
  },
  {
    id: "aws_access_key",
    name: "AWS Access Key ID",
    secretType: "AWS_ACCESS_KEY_ID",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    confidence: "high",
  },
  {
    id: "aws_secret_key",
    name: "AWS Secret Access Key",
    secretType: "AWS_SECRET_KEY",
    regex:
      /(?:aws_secret_access_key|aws_secret_key|secret_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    confidence: "high",
  },
  {
    id: "jwt_token",
    name: "JSON Web Token (JWT)",
    secretType: "JWT",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confidence: "high",
  },
  {
    id: "private_key",
    name: "PEM Private Key",
    secretType: "PRIVATE_KEY",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    confidence: "high",
  },
  {
    id: "bearer_token",
    name: "Bearer Token",
    secretType: "BEARER_TOKEN",
    regex: /\bBearer\s+([A-Za-z0-9_\-\.]{24,})\b/gi,
    confidence: "medium",
  },
  {
    id: "generic_credential",
    name: "Generic Password or Credential Assignment",
    secretType: "CREDENTIAL",
    regex:
      /(?:password|passwd|api_key|apikey|auth_token|client_secret|private_token)\s*[:=]\s*["']?([^"'\s\n\r]{8,})["']?/gi,
    confidence: "medium",
  },
  {
    id: "slack_token",
    name: "Slack API Token",
    secretType: "SLACK_TOKEN",
    regex: /\bxox[baprs]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}\b/g,
    confidence: "high",
  },
  {
    id: "google_api_key",
    name: "Google API Key",
    secretType: "GOOGLE_API_KEY",
    regex: /\bAIza[0-9A-Za-z-_]{35}\b/g,
    confidence: "high",
  },
];

/**
 * Options for configuring ContentScanner.
 */
export interface ContentScannerOptions {
  rules?: ScannerRule[];
  scanEntropy?: boolean;
  entropyThreshold?: number;
  minHighEntropyLength?: number;
}

/**
 * Scanner for identifying credentials, API tokens, and high-entropy strings in text content.
 */
export class ContentScanner {
  private readonly rules: ScannerRule[];
  private readonly scanEntropy: boolean;
  private readonly entropyThreshold: number;
  private readonly minHighEntropyLength: number;

  constructor(options: ContentScannerOptions = {}) {
    this.rules = options.rules ?? [...DEFAULT_SCANNER_RULES];
    this.scanEntropy = options.scanEntropy ?? true;
    this.entropyThreshold = options.entropyThreshold ?? 4.3;
    this.minHighEntropyLength = options.minHighEntropyLength ?? 24;
  }

  /**
   * Adds a custom rule to the scanner.
   */
  addRule(rule: ScannerRule): void {
    this.rules.push(rule);
  }

  /**
   * Scans a text string and returns all matched secrets sorted by starting offset.
   */
  scan(text: string): SecretMatch[] {
    if (!text || typeof text !== "string") {
      return [];
    }

    const matches: SecretMatch[] = [];

    // 1. Run regex-based rules
    for (const rule of this.rules) {
      const regex = new RegExp(rule.regex.source, rule.regex.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        // If there's a capture group (e.g. key value in password: "xxx"), use group 1
        const matchedValue = match[1] ?? match[0];
        // Skip trivial or short captures or already redacted placeholders
        if (
          matchedValue.length < 6 ||
          matchedValue.startsWith("[REDACTED") ||
          matchedValue.includes("[REDACTED_")
        ) {
          continue;
        }

        const matchStart = match[1] ? match.index + match[0].indexOf(match[1]) : match.index;
        const matchEnd = matchStart + matchedValue.length;
        const entropy = calculateShannonEntropy(matchedValue);

        if (rule.minEntropy !== undefined && entropy < rule.minEntropy) {
          continue;
        }

        matches.push({
          patternId: rule.id,
          secretType: rule.secretType,
          match: matchedValue,
          start: matchStart,
          end: matchEnd,
          confidence: rule.confidence,
          entropy,
        });
      }
    }

    // 2. High-entropy standalone word scanner (if enabled)
    if (this.scanEntropy) {
      const tokenRegex = /[^\s"'\`\(\)\[\]\{\}<>]{20,}/g;
      let tokenMatch: RegExpExecArray | null;

      while ((tokenMatch = tokenRegex.exec(text)) !== null) {
        const candidate = tokenMatch[0];
        const start = tokenMatch.index;
        const end = start + candidate.length;

        // Skip if already covered by another rule match or already redacted
        if (candidate.startsWith("[REDACTED") || candidate.includes("[REDACTED_")) {
          continue;
        }
        const alreadyCovered = matches.some(
          (m) => (start >= m.start && start < m.end) || (end > m.start && end <= m.end),
        );
        if (alreadyCovered) {
          continue;
        }

        // Must have character diversity (mixed case or letters + digits or special symbols)
        const hasUpper = /[A-Z]/.test(candidate);
        const hasLower = /[a-z]/.test(candidate);
        const hasDigit = /[0-9]/.test(candidate);
        const hasSpecial = /[^A-Za-z0-9]/.test(candidate);
        const charSetCount =
          (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0) + (hasSpecial ? 1 : 0);

        if (charSetCount >= 2) {
          const entropy = calculateShannonEntropy(candidate);
          if (entropy >= this.entropyThreshold) {
            matches.push({
              patternId: "high_entropy_secret",
              secretType: "HIGH_ENTROPY_SECRET",
              match: candidate,
              start,
              end,
              confidence: entropy >= 4.8 ? "high" : "medium",
              entropy,
            });
          }
        }
      }
    }

    // Sort matches by start position ascending
    matches.sort((a, b) => a.start - b.start);

    // Filter out overlapping matches, keeping the longer / earlier match
    const nonOverlapping: SecretMatch[] = [];
    let lastEnd = -1;

    for (const m of matches) {
      if (m.start >= lastEnd) {
        nonOverlapping.push(m);
        lastEnd = m.end;
      }
    }

    return nonOverlapping;
  }

  /**
   * Fast check if text contains any secrets.
   */
  hasSecrets(text: string): boolean {
    return this.scan(text).length > 0;
  }
}
