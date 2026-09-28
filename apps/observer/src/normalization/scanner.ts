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
  /** Shortest captured value the rule redacts (default 6). Structural credential slots use less. */
  minLength?: number;
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

/** Longest run between path separators a path-shaped value may have (a file or directory name). */
const MAX_PATH_RUN_LENGTH = 12;

/**
 * Whether a high-entropy candidate is an ordinary file path (`backups/inventory-2025-06-01.sql`)
 * rather than a key. Standard base64 has `/` but none of `.`, `-`, `_`; URL-safe base64 has no `/`;
 * a random key has long runs between separators; URL userinfo, `key=value` pairs and base64 padding
 * carry `@`, `:`, `=` or `+`. Named-secret rules still scan every value.
 */
function isPathShaped(candidate: string): boolean {
  return (
    candidate.includes("/") &&
    /[._-]/.test(candidate) &&
    !/[@:=+]/.test(candidate) &&
    candidate.split(/[/._-]/).every((run) => run.length <= MAX_PATH_RUN_LENGTH)
  );
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
      /(?:password|passwd|api_key|apikey|auth_token|client_secret|private_token)["']?\s*[:=]\s*["']?([^"'\s\n\r]{8,})["']?/gi,
    confidence: "medium",
  },
  {
    id: "cli_secret_flag",
    name: "Secret Passed After a Long Command-Line Flag",
    secretType: "CREDENTIAL",
    regex:
      /--(?:password|passwd|pass|token|secret|api-?key|access-token|auth-token|client-secret)(?:\s+|=)["']?([^"'\s-][^"'\s]{5,})["']?/gi,
    confidence: "medium",
  },
  {
    id: "secret_named_assignment",
    name: "Assignment to a Secret-Named Variable",
    secretType: "CREDENTIAL",
    // DB_PASS='v', ERP_PASSWORD=v, GH_TOKEN=v, access_token=v: the variable name marks the value.
    regex:
      /\b[A-Za-z0-9_]*(?:PASS|PASSWD|PASSWORD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)\s*=\s*["']?([^"'\s;&|]{6,})["']?/gi,
    confidence: "medium",
  },
  {
    id: "cli_password_argument",
    name: "Password Argument of a Known Client",
    secretType: "CREDENTIAL",
    // sshpass -p V, docker login -p V, redis-cli -a V, and the attached mysql-family -pV form.
    regex:
      /(?:\bsshpass\s+-p\s*|\bdocker\s+login\b[^\n|;&]*?\s-p\s+|\bredis-cli\b[^\n|;&]*?\s-a\s+|\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?\s-p)["']?([^"'\s]{6,})["']?/g,
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
  {
    id: "url_credentials",
    name: "Password in URL Userinfo",
    secretType: "URL_CREDENTIAL",
    // postgres://app:pw@db, redis://:pw@cache, https://user:pat@git.example: the password slot.
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]*:([^\s@"'`/\\]+)@/gi,
    minLength: 1,
    confidence: "high",
  },
  {
    id: "authorization_header",
    name: "HTTP Authorization Credentials",
    secretType: "AUTHORIZATION",
    regex:
      /\b(?:Proxy-)?Authorization\s*:\s*(?:(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key)\s+)?([^\s"'`,;\\]+)/gi,
    minLength: 3,
    confidence: "high",
  },
  {
    id: "secret_header",
    name: "Secret-Named HTTP Header",
    secretType: "HEADER_CREDENTIAL",
    // X-Api-Key, DD-API-KEY, X-Auth-Token, Private-Token, X-Secret: a hyphenated header name with a
    // key/token/secret/auth segment. `Author:` or YAML `key:` lack that shape and stay intact.
    regex:
      /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+-)+(?:[A-Za-z0-9]*(?:key|token|secret|auth|password)[A-Za-z0-9]*)(?:-[A-Za-z0-9]+)*\s*:\s*(?:(?:Basic|Bearer|Token)\s+)?([^\s"'`,;\\]+)|(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]*(?:key|token|secret|auth|password)[A-Za-z0-9]*)(?:-[A-Za-z0-9]+)+\s*:\s*(?:(?:Basic|Bearer|Token)\s+)?([^\s"'`,;\\]+)/gi,
    minLength: 3,
    confidence: "high",
  },
  {
    id: "http_client_user",
    name: "Credentials Passed to an HTTP Client",
    secretType: "CREDENTIAL",
    // curl -u user:pw, curl -uuser:pw, curl --user=user:pw, wget --user user:pw, http -a user:pw.
    regex:
      /\b(?:curl|wget|https?|httpie|xh)\b[^\n|;&]*?\s(?:-u\s*|--user(?:\s+|=)|-a\s+|--auth(?:\s+|=))["']?[^\s"':]*:([^\s"'`\\]+)/g,
    minLength: 1,
    confidence: "high",
  },
  {
    id: "netrc_password",
    name: "Password in a .netrc Entry",
    secretType: "CREDENTIAL",
    // `machine h login u password V` on one line, or a `password V` line of a multi-line entry.
    regex:
      /\b(?:machine\s+\S+|default)\s+(?:login\s+\S+\s+)?password\s+([^\s"'`\\]+)|^[ \t]*password[ \t]+([^\s"'`\\]+)[ \t]*$/gm,
    minLength: 1,
    confidence: "high",
  },
  {
    id: "cookie_header",
    name: "HTTP Cookie Values",
    secretType: "COOKIE",
    regex: /\b(?:Set-)?Cookie\s*:\s*([^\n"'`\\]+)/gi,
    minLength: 3,
    confidence: "high",
  },
  {
    id: "http_client_password_flag",
    name: "Password Flag of an HTTP Client",
    secretType: "CREDENTIAL",
    regex: /--(?:http-|ftp-|proxy-)password(?:\s+|=)["']?([^"'\s]+)/g,
    minLength: 1,
    confidence: "high",
  },
];

/** Context words announcing that the next value on the line is a credential. */
const SECRET_CONTEXT =
  /(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|bearer|session|cookie|signature)[^\n]{0,24}$/i;

/** Git subcommands whose hex arguments and outputs are object names, not secrets. */
const GIT_OBJECT_CONTEXT =
  /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*(?:checkout|switch|show|log|revert|cherry-pick|reset|rebase|diff|merge|merge-base|rev-parse|rev-list|branch|tag|bisect|blame|cat-file|ls-tree|describe|fetch|push|commit|reflog|format-patch|am|apply|notes|worktree|submodule|stash|restore|grep|shortlog|name-rev|for-each-ref|update-ref|verify-commit)\b/;

/** Checksum tools: their arguments and the checksum lines they read or print are content hashes. */
const CHECKSUM_TOOL_CONTEXT =
  /\b(?:sha(?:1|224|256|384|512)sum|shasum|md5sum|md5|b2sum|b3sum|cksum|openssl\s+dgst|certutil\s+-hashfile)\b/;

/** Labels that name the following hex value a digest or revision. */
const HASH_LABEL_CONTEXT =
  /(?:\b(?:sha(?:1|224|256|384|512)?|md5|blake2b?|blake3|digest|checksum|hash|integrity|commit|revision|rev|oid|object|tree|parent|etag|Merge)\b["']?\s*[:=@-]?\s*["']?|@sha256:|\bsha256:)$/i;

/** Lengths of the common hex digests (md5, sha1, sha224, sha256, sha384, sha512). */
const DIGEST_HEX_LENGTHS = new Set([32, 40, 56, 64, 96, 128]);

function lineAround(text: string, start: number, end: number): { before: string; line: string } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline === -1 ? text.length : newline;
  return { before: text.slice(lineStart, start), line: text.slice(lineStart, lineEnd) };
}

/**
 * Whether a hex run is a git object name or content digest in its ordinary, non-secret setting:
 * a git command on the line, `commit <sha>` log output, a checksum tool, a `sha256:`-style label,
 * or a `<digest>  <file>` checksum-list line. A secret label right before the value wins.
 */
function isHashContext(text: string, start: number, end: number): boolean {
  const { before, line } = lineAround(text, start, end);
  if (SECRET_CONTEXT.test(before.slice(-32))) return false;
  if (HASH_LABEL_CONTEXT.test(before)) return true;
  if (GIT_OBJECT_CONTEXT.test(line) || CHECKSUM_TOOL_CONTEXT.test(line)) return true;
  const length = end - start;
  // `<digest>  <file>` / `<digest> *<file>` rows of sha256sum output or SHA256SUMS files.
  if (
    DIGEST_HEX_LENGTHS.has(length) &&
    before.trim() === "" &&
    /^ (?: |\*)\S/.test(text.slice(end, end + 3))
  ) {
    return true;
  }
  // git log --oneline / raw output rows led by an abbreviated or full object name.
  return length === 40 && /^\s*$/.test(before) && /^\s+\S/.test(text.slice(end, end + 2));
}

/**
 * Shannon entropy normalized by the most a string of this length over this alphabet can carry,
 * so hex (4 bits max) and short base62 keys are scored on the same 0-1 scale as base64.
 */
export function normalizedEntropy(str: string, alphabetSize: number): number {
  const ceiling = Math.log2(Math.min(alphabetSize, str.length));
  return ceiling > 0 ? calculateShannonEntropy(str) / ceiling : 0;
}

/** A 32+ hex run with both digits and letters, bounded by non-alphanumerics. */
const HEX_RUN = /(?<![A-Za-z0-9])(?:[0-9a-f]{32,}|[0-9A-F]{32,})(?![A-Za-z0-9])/g;
const UUID_RUN =
  /(?<![A-Za-z0-9-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![A-Za-z0-9-])/g;
/** A bare base62 run (no path, dot, dash or underscore neighbours) of key length. */
const BASE62_RUN = /(?<![A-Za-z0-9_+/.\\-])[A-Za-z0-9]{16,64}(?![A-Za-z0-9_+/.\\-])/g;
/** Minimum alphabet-normalized entropy of a random-looking hex or base62 run. */
const MIN_NORMALIZED_ENTROPY = 0.85;
/**
 * Minimum share of adjacent base62 characters that change class (upper/lower/digit). Random keys
 * average about 0.62; camelCase identifiers (`base64ToUint8Array` 0.47, `HTMLInputElement2` 0.25)
 * stay below. About nine in ten random 16-35 character keys clear it.
 */
const MIN_BASE62_CLASS_SWITCH_RATE = 0.5;

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
    if (!text) {
      return [];
    }

    const matches: SecretMatch[] = [];

    // 1. Run regex-based rules
    for (const rule of this.rules) {
      const regex = new RegExp(rule.regex.source, rule.regex.flags);
      const minLength = rule.minLength ?? 6;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        // If there's a capture group (e.g. key value in password: "xxx"), use the first defined one
        const groupIndex = match.findIndex((group, index) => index > 0 && group !== undefined);
        const matchedValue = groupIndex > 0 ? match[groupIndex] : match[0];
        // Skip trivial or short captures or already redacted placeholders
        if (
          matchedValue.length < minLength ||
          matchedValue.startsWith("[REDACTED") ||
          matchedValue.includes("[REDACTED_")
        ) {
          continue;
        }

        // Captures are suffixes of the match: the value slot is the last occurrence.
        const matchStart =
          groupIndex > 0 ? match.index + match[0].lastIndexOf(matchedValue) : match.index;
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
      const covered = (start: number, end: number) =>
        matches.some((m) => start < m.end && end > m.start);
      const push = (patternId: string, candidate: string, start: number, entropy: number) =>
        matches.push({
          patternId,
          secretType: "HIGH_ENTROPY_SECRET",
          match: candidate,
          start,
          end: start + candidate.length,
          confidence: "medium",
          entropy,
        });

      // 2a. Hex keys (Datadog, Algolia, Twilio, HMAC secrets): a hex alphabet caps Shannon entropy
      // at 4 bits, so score against that ceiling. Digests in git/checksum settings stay intact.
      const digests: Array<{ start: number; end: number }> = [];
      for (const hex of text.matchAll(HEX_RUN)) {
        const candidate = hex[0];
        const start = hex.index;
        const end = start + candidate.length;
        if (!/[0-9]/.test(candidate) || !/[a-f]/i.test(candidate) || covered(start, end)) continue;
        const score = normalizedEntropy(candidate, 16);
        if (score < MIN_NORMALIZED_ENTROPY) continue;
        // A digest named by a path or file (`build-<sha>.log`, `/cache/<md5>/x`) is content-addressed,
        // unless a value slot (`key=`, `token:`) or a secret label (`token`, `/hooks/`) precedes it.
        const lineBefore = lineAround(text, start, end).before;
        const pathNeighbour =
          (/[/._-]/.test(text[start - 1] ?? "") || /[/._-]/.test(text[end] ?? "")) &&
          !/[=:]$/.test(lineBefore) &&
          !SECRET_CONTEXT.test(lineBefore.slice(-32)) &&
          !/hooks?\/$/i.test(lineBefore);
        if (pathNeighbour || isHashContext(text, start, end)) {
          digests.push({ start, end });
          continue;
        }
        push("high_entropy_hex_secret", candidate, start, calculateShannonEntropy(candidate));
      }

      // 2b. UUIDs are ordinary identifiers unless a secret label (api key, token) introduces them.
      for (const uuid of text.matchAll(UUID_RUN)) {
        const candidate = uuid[0];
        const start = uuid.index;
        const end = start + candidate.length;
        if (covered(start, end)) continue;
        if (!SECRET_CONTEXT.test(lineAround(text, start, end).before.slice(-32))) continue;
        push("uuid_secret", candidate, start, calculateShannonEntropy(candidate));
      }

      // 2c. Short random base62 keys: all three character classes, near-maximal entropy for their
      // length, and frequent class switches. Identifiers keep letters of one case in word runs.
      for (const run of text.matchAll(BASE62_RUN)) {
        const candidate = run[0];
        const start = run.index;
        const end = start + candidate.length;
        if (
          !/[A-Z]/.test(candidate) ||
          !/[a-z]/.test(candidate) ||
          !/[0-9]/.test(candidate) ||
          covered(start, end)
        ) {
          continue;
        }
        if (normalizedEntropy(candidate, 62) < MIN_NORMALIZED_ENTROPY) continue;
        let switches = 0;
        let previousClass = "";
        for (const ch of candidate) {
          const charClass =
            ch >= "a" && ch <= "z" ? "lower" : ch >= "A" && ch <= "Z" ? "upper" : "digit";
          if (previousClass !== "" && charClass !== previousClass) switches++;
          previousClass = charClass;
        }
        if (switches / (candidate.length - 1) < MIN_BASE62_CLASS_SWITCH_RATE) continue;
        push("high_entropy_base62_secret", candidate, start, calculateShannonEntropy(candidate));
      }

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
        if (covered(start, end) || isPathShaped(candidate)) {
          continue;
        }
        // `alpine@sha256:<digest>`: once the exempt digest is set aside, too little is left to be a key.
        const digestChars = digests
          .filter((digest) => digest.start >= start && digest.end <= end)
          .reduce((sum, digest) => sum + digest.end - digest.start, 0);
        if (digestChars > 0 && candidate.length - digestChars < 20) {
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
