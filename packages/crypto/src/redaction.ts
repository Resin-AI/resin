import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { RedactedRecord, RedactionOptions } from "./types.js";

/**
 * Standard regular expressions for detecting sensitive tokens and credentials.
 */
const STANDARD_SECRET_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Bearer tokens in headers or strings
  {
    pattern: /\bBearer\s+([A-Za-z0-9_\-\.]{16,})\b/gi,
    description: "Bearer token",
  },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  {
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g,
    description: "GitHub token",
  },
  // AWS Access Key ID
  {
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    description: "AWS Access Key ID",
  },
  // AWS Secret Access Key in key-value pairs
  {
    pattern: /(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    description: "AWS Secret Access Key",
  },
  // Generic API Keys, tokens, passwords, and secrets in JSON/YAML/env key-value contexts
  {
    pattern:
      /(?:['"]?(?:api[_-]?key|secret|token|password|auth[_-]?token|access[_-]?token|private[_-]?key)['"]?\s*[:=]\s*['"]?)([^'"\s,;}{]+)(?:['"]?)/gi,
    description: "Generic API key or secret",
  },
  // PEM Private Keys
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    description: "PEM Private Key",
  },
  // JSON Web Tokens (JWT)
  {
    pattern: /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*\b/g,
    description: "JWT Token",
  },
];

/**
 * SecretRedactor tracks known secrets, their cryptographic fingerprints,
 * and encodings (hex, base64, URL-encoded), providing deterministic redaction
 * across strings, error objects, and structured payloads.
 */
export class SecretRedactor {
  private readonly maskText: string;
  private readonly redactEncodings: boolean;
  private readonly matchStandardPatterns: boolean;

  /**
   * Map of secret value -> set of metadata/aliases.
   */
  private readonly secretValues = new Set<string>();

  /**
   * Map of exact string literal -> replacement text.
   */
  private readonly literalReplacements = new Map<string, string>();

  /**
   * Set of SHA-256 fingerprints of registered secrets.
   */
  private readonly fingerprints = new Set<string>();

  /**
   * Map of secret name -> secret value.
   */
  private readonly nameToValue = new Map<string, string>();

  constructor(options: RedactionOptions = {}) {
    this.maskText = options.maskText ?? "[REDACTED_SECRET]";
    this.redactEncodings = options.redactEncodings !== false;
    this.matchStandardPatterns = options.matchStandardPatterns !== false;
  }

  /**
   * Computes SHA-256 fingerprint for a secret value.
   */
  static computeFingerprint(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  /**
   * Registers a secret value for automatic redaction.
   */
  registerSecret(value: string, name?: string): void {
    if (!value || value.trim().length === 0) {
      return;
    }
    const trimmedValue = value.trim();
    if (trimmedValue.length < 3) {
      // Avoid masking excessively short substrings (e.g. 1-2 chars) that could match everywhere
      return;
    }

    this.secretValues.add(trimmedValue);
    const fingerprint = SecretRedactor.computeFingerprint(trimmedValue);
    this.fingerprints.add(fingerprint);

    if (name) {
      this.nameToValue.set(name, trimmedValue);
      const namedMask = `[REDACTED:${name}]`;
      this.literalReplacements.set(trimmedValue, namedMask);
    } else {
      this.literalReplacements.set(trimmedValue, this.maskText);
    }

    if (this.redactEncodings) {
      // Base64 encoding
      const b64 = Buffer.from(trimmedValue, "utf-8").toString("base64");
      if (b64.length >= 4) {
        this.literalReplacements.set(b64, name ? `[REDACTED_B64:${name}]` : "[REDACTED_B64]");
      }

      // Hex encoding
      const hex = Buffer.from(trimmedValue, "utf-8").toString("hex");
      if (hex.length >= 6) {
        this.literalReplacements.set(hex, name ? `[REDACTED_HEX:${name}]` : "[REDACTED_HEX]");
      }

      // URL-encoded
      const urlEnc = encodeURIComponent(trimmedValue);
      if (urlEnc !== trimmedValue && urlEnc.length >= 4) {
        this.literalReplacements.set(urlEnc, name ? `[REDACTED_URL:${name}]` : "[REDACTED_URL]");
      }
    }
  }

  /**
   * Registers multiple secrets from an array or record mapping.
   */
  registerSecrets(secrets: string[] | Record<string, string>): void {
    if (Array.isArray(secrets)) {
      for (const secret of secrets) {
        this.registerSecret(secret);
      }
    } else if (secrets) {
      for (const [name, secret] of Object.entries(secrets)) {
        this.registerSecret(secret, name);
      }
    }
  }

  /**
   * Unregisters a secret by name or value.
   */
  unregisterSecret(nameOrValue: string): void {
    let value = nameOrValue;
    if (this.nameToValue.has(nameOrValue)) {
      value = this.nameToValue.get(nameOrValue)!;
      this.nameToValue.delete(nameOrValue);
    }

    this.secretValues.delete(value);
    this.literalReplacements.delete(value);

    if (this.redactEncodings) {
      const b64 = Buffer.from(value, "utf-8").toString("base64");
      this.literalReplacements.delete(b64);
      const hex = Buffer.from(value, "utf-8").toString("hex");
      this.literalReplacements.delete(hex);
      const urlEnc = encodeURIComponent(value);
      this.literalReplacements.delete(urlEnc);
    }

    const fingerprint = SecretRedactor.computeFingerprint(value);
    this.fingerprints.delete(fingerprint);
  }

  /**
   * Clears all registered secrets and fingerprints.
   */
  clear(): void {
    this.secretValues.clear();
    this.literalReplacements.clear();
    this.fingerprints.clear();
    this.nameToValue.clear();
  }

  /**
   * Checks if any registered secret or pattern exists within the given text.
   */
  hasSecret(text: string): boolean {
    if (!text) {
      return false;
    }
    // Check exact matches
    for (const secret of this.secretValues) {
      if (text.includes(secret)) {
        return true;
      }
    }

    // Check standard patterns
    if (this.matchStandardPatterns) {
      for (const { pattern } of STANDARD_SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Returns count of registered secrets.
   */
  getRegisteredCount(): number {
    return this.secretValues.size;
  }

  /**
   * Returns all SHA-256 fingerprints of registered secrets.
   */
  getFingerprints(): string[] {
    return Array.from(this.fingerprints);
  }

  /**
   * Redacts all registered secret values, encodings, and common secret patterns in the input text.
   */
  redact(input: string): string {
    if (!input) {
      return input;
    }
    let result = input;

    // 1. Redact known exact secrets and encodings, sorted by length descending to match longest first
    const sortedEntries = Array.from(this.literalReplacements.entries()).sort(
      (a, b) => b[0].length - a[0].length,
    );

    for (const [secretStr, mask] of sortedEntries) {
      if (result.includes(secretStr)) {
        result = result.replaceAll(secretStr, mask);
      }
    }

    // 2. Redact standard patterns
    if (this.matchStandardPatterns) {
      // Bearer tokens
      result = result.replaceAll(
        /\bBearer\s+([A-Za-z0-9_\-\.]{16,})\b/gi,
        "Bearer [REDACTED_BEARER_TOKEN]",
      );

      // GitHub tokens
      result = result.replaceAll(
        /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g,
        "[REDACTED_GITHUB_TOKEN]",
      );

      // AWS Access Key ID
      result = result.replaceAll(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY_ID]");

      // AWS Secret Access Key in key-value pairs
      result = result.replaceAll(
        /((?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})(['"]?)/gi,
        "$1[REDACTED_AWS_SECRET_KEY]$3",
      );

      // Generic credentials in key-value format: e.g. api_key="secret123" -> api_key="[REDACTED]"
      result = result.replaceAll(
        /((?:['"]?(?:api[_-]?key|secret|token|password|auth[_-]?token|access[_-]?token|private[_-]?key)['"]?\s*[:=]\s*['"]?))([^'"\s,;}{]+)(['"]?)/gi,
        (match, prefix, value, suffix) => {
          if (value.startsWith("[REDACTED")) {
            return match;
          }
          return `${prefix}[REDACTED]${suffix}`;
        },
      );

      // PEM Private Keys
      result = result.replaceAll(
        /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
        "[REDACTED_PRIVATE_KEY]",
      );
    }

    return result;
  }

  /**
   * Deeply traverses an object, array, error, or primitive and applies redaction to all strings.
   */
  redactObject<T>(obj: T): T {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (Object.prototype.toString.call(obj) === "[object String]") {
      // SAFETY: String primitive is redacted and returned with preserved type T.
      return this.redact(String(obj)) as T;
    }

    if (
      Object.prototype.toString.call(obj) === "[object Number]" ||
      Object.prototype.toString.call(obj) === "[object Boolean]" ||
      Object.prototype.toString.call(obj) === "[object BigInt]"
    ) {
      return obj;
    }

    if (Array.isArray(obj)) {
      // SAFETY: Array elements are recursively redacted and returned with preserved array type T.
      return obj.map((item) => this.redactObject(item)) as T;
    }

    if (obj instanceof Error) {
      // SAFETY: Error constructor is instantiated to preserve specific Error subclass.
      const ErrorCtor = obj.constructor as new (msg: string) => Error;
      const sanitizedError = new ErrorCtor(this.redact(obj.message));
      sanitizedError.name = obj.name;
      if (obj.stack) {
        sanitizedError.stack = this.redact(obj.stack);
      }
      // SAFETY: Redacted Error instance matches return type T.
      return sanitizedError as T;
    }

    if (Object.prototype.toString.call(obj) === "[object Object]") {
      const result: RedactedRecord = {};
      // SAFETY: Plain object entries are extracted for recursive key and value redaction.
      for (const [key, value] of Object.entries(obj as object)) {
        const sanitizedKey = this.redact(key);
        result[sanitizedKey] = this.redactObject(value);
      }
      // SAFETY: Redacted property map matches return type T.
      return result as T;
    }

    return obj;
  }
}
