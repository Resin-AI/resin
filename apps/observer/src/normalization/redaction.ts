import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { RedactionMeta, RedactionStrategy } from "@resin/contracts";
import { ContentScanner } from "./scanner.js";

/**
 * Configuration options for RedactionEngine.
 */
export interface RedactionConfig {
  /** Whether privacy redaction is enabled (default: true) */
  enabled?: boolean;
  /** Redaction strategy ("mask" | "tokenize" | "drop" | "synthetic" | "none") */
  strategy?: RedactionStrategy;
  /** Home directory path to alias (defaults to os.homedir()) */
  homeDir?: string;
  /** Repository/workspace root path to alias */
  repoRoot?: string;
  /** Additional custom path or string aliases (e.g. { "/Users/alice/projects/app": "$REPO_ROOT" }) */
  pathAliases?: Record<string, string>;
  /** Environment variable names whose values must be scrubbed from content */
  sensitiveEnvVars?: string[];
  /** Custom explicit secret strings to redact */
  customSecrets?: string[];
  /** Whether to scan text content for API keys, tokens, and credentials (default: true) */
  scanContent?: boolean;
  /** Whether to scan and redact high-entropy strings (default: true) */
  redactHighEntropy?: boolean;
  /** Entropy threshold for high-entropy string scanner (default: 4.3) */
  entropyThreshold?: number;
  /** Maximum string length before truncation (default: 65536, set to 0 to disable) */
  maxStringLength?: number;
  /** Field names classified as local-only that should be stripped or masked */
  localOnlyFields?: string[];
  /** Custom secret scanner instance */
  scanner?: ContentScanner;
}

/**
 * Result of redacting a payload or event.
 */
export interface RedactionResult<T = unknown> {
  data: T;
  isRedacted: boolean;
  redactedFields: string[];
  redactionStrategy: RedactionStrategy;
  scrubbedPatterns: string[];
  fingerprintHashes: string[];
}

const DEFAULT_SENSITIVE_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "DATABASE_URL",
  "REDIS_URL",
  "SECRET_KEY_BASE",
  "JWT_SECRET",
  "AUTH_TOKEN",
  "API_KEY",
  "PRIVATE_KEY",
  "SLACK_BOT_TOKEN",
  "DISCORD_TOKEN",
];

const DEFAULT_LOCAL_ONLY_FIELDS = [
  "workingDirectory",
  "cwd",
  "socketPath",
  "internalSocket",
  "localAuthToken",
  "authToken",
  "clientSecret",
];

const PRESERVED_IDENTIFIER_FIELDS = new Set([
  "sourceSessionId",
  "branchPointEventId",
  "subagentId",
  "parentId",
  "callId",
  "toolName",
  "filePath",
  "operation",
  "triggerReason",
  "lifecycleType",
  "errorType",
  "candidateRef",
  "harnessName",
  "workspaceId",
  "provider",
  "source",
]);

function computeFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/**
 * Engine executing configurable privacy transformations.
 */
export class RedactionEngine {
  private readonly config: RedactionConfig;
  private readonly scanner: ContentScanner;
  private readonly pathReplacements: Array<{ pattern: string; replacement: string }>;
  private readonly envSecretReplacements: Array<{
    secret: string;
    placeholder: string;
    name: string;
  }>;
  private readonly customSecretReplacements: Array<{ secret: string; fingerprint: string }>;
  private readonly localOnlyFieldsSet: Set<string>;

  constructor(config: RedactionConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      strategy: config.strategy ?? "mask",
      homeDir: config.homeDir ?? os.homedir(),
      repoRoot: config.repoRoot,
      pathAliases: config.pathAliases ?? {},
      sensitiveEnvVars: config.sensitiveEnvVars ?? DEFAULT_SENSITIVE_ENV_VARS,
      customSecrets: config.customSecrets ?? [],
      scanContent: config.scanContent ?? true,
      redactHighEntropy: config.redactHighEntropy ?? true,
      entropyThreshold: config.entropyThreshold ?? 4.3,
      maxStringLength: config.maxStringLength ?? 65536,
      localOnlyFields: config.localOnlyFields ?? DEFAULT_LOCAL_ONLY_FIELDS,
    };

    this.scanner =
      config.scanner ??
      new ContentScanner({
        scanEntropy: this.config.redactHighEntropy,
        entropyThreshold: this.config.entropyThreshold,
      });

    this.localOnlyFieldsSet = new Set(this.config.localOnlyFields);

    // Build ordered path replacements (longest path first to avoid prefix shadowing)
    const rawPathMap: Record<string, string> = { ...this.config.pathAliases };

    if (this.config.repoRoot && this.config.repoRoot.length > 1) {
      rawPathMap[this.config.repoRoot] = "$REPO_ROOT";
      rawPathMap[path.resolve(this.config.repoRoot)] = "$REPO_ROOT";
    }

    if (this.config.homeDir && this.config.homeDir.length > 1) {
      rawPathMap[this.config.homeDir] = "$HOME";
      rawPathMap[path.resolve(this.config.homeDir)] = "$HOME";
    }

    this.pathReplacements = Object.entries(rawPathMap)
      .filter(([k]) => k.length > 1)
      .sort((a, b) => b[0].length - a[0].length)
      .map(([pattern, replacement]) => ({ pattern, replacement }));

    // Build env secrets list
    this.envSecretReplacements = [];
    for (const envVarName of this.config.sensitiveEnvVars ?? []) {
      const val = process.env[envVarName];
      if (val && typeof val === "string" && val.trim().length >= 6) {
        const fp = computeFingerprint(val);
        this.envSecretReplacements.push({
          secret: val,
          placeholder: `[REDACTED_ENV:${envVarName}:${fp}]`,
          name: envVarName,
        });
      }
    }

    // Build custom secrets list
    this.customSecretReplacements = (this.config.customSecrets ?? [])
      .filter((s) => typeof s === "string" && s.trim().length >= 4)
      .map((secret) => ({
        secret,
        fingerprint: computeFingerprint(secret),
      }));
  }

  /**
   * Redacts a single string according to privacy transforms.
   */
  redactString(
    text: string,
    fieldPath = "",
  ): {
    redactedText: string;
    changed: boolean;
    patterns: string[];
    fingerprints: string[];
  } {
    if (!text || typeof text !== "string") {
      return { redactedText: text, changed: false, patterns: [], fingerprints: [] };
    }

    if (!this.config.enabled) {
      return { redactedText: text, changed: false, patterns: [], fingerprints: [] };
    }

    let current = text;
    let changed = false;
    const patterns: string[] = [];
    const fingerprints: string[] = [];

    // 1. Path Aliasing (Repo root, Home directory, custom aliases)
    for (const { pattern, replacement } of this.pathReplacements) {
      if (current.includes(pattern)) {
        current = current.split(pattern).join(replacement);
        changed = true;
        patterns.push(`path_alias:${replacement}`);
      }
    }

    // 2. Sensitive Env Var Values
    for (const { secret, placeholder, name } of this.envSecretReplacements) {
      if (current.includes(secret)) {
        current = current.split(secret).join(placeholder);
        changed = true;
        patterns.push(`env_var:${name}`);
        fingerprints.push(placeholder);
      }
    }

    // 3. Custom Secrets
    for (const { secret, fingerprint } of this.customSecretReplacements) {
      if (current.includes(secret)) {
        const placeholder = `[REDACTED_SECRET:${fingerprint}]`;
        current = current.split(secret).join(placeholder);
        changed = true;
        patterns.push("custom_secret");
        fingerprints.push(fingerprint);
      }
    }

    // 4. Content Scanning (Regex & High Entropy)
    if (this.config.scanContent) {
      const matches = this.scanner.scan(current);
      if (matches.length > 0) {
        // Replace from end to start to keep offsets valid
        for (let i = matches.length - 1; i >= 0; i--) {
          const m = matches[i];
          const fp = computeFingerprint(m.match);
          const placeholder = `[REDACTED_${m.secretType}:${fp}]`;
          current = current.slice(0, m.start) + placeholder + current.slice(m.end);
          changed = true;
          patterns.push(m.patternId);
          fingerprints.push(fp);
        }
      }
    }

    // 5. Content Truncation (if enabled)
    if (
      this.config.maxStringLength &&
      this.config.maxStringLength > 0 &&
      current.length > this.config.maxStringLength
    ) {
      const originalLen = current.length;
      current = `${current.slice(0, this.config.maxStringLength)}... [TRUNCATED ${originalLen - this.config.maxStringLength} chars]`;
      changed = true;
      patterns.push(`truncation:${fieldPath || "string"}`);
    }

    return {
      redactedText: current,
      changed,
      patterns,
      fingerprints,
    };
  }

  /**
   * Deeply transforms and redacts any value (object, array, string, primitive).
   */
  redact<T = unknown>(value: T): RedactionResult<T> {
    if (!this.config.enabled) {
      return {
        data: value,
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none",
        scrubbedPatterns: [],
        fingerprintHashes: [],
      };
    }

    const redactedFieldsSet = new Set<string>();
    const patternsSet = new Set<string>();
    const fingerprintsSet = new Set<string>();

    const transform = (current: unknown, currentPath: string): unknown => {
      if (current === null || current === undefined) {
        return current;
      }

      // String transformation
      if (typeof current === "string") {
        const { redactedText, changed, patterns, fingerprints } = this.redactString(
          current,
          currentPath,
        );
        if (changed) {
          if (currentPath) {
            redactedFieldsSet.add(currentPath);
          }
          for (const p of patterns) patternsSet.add(p);
          for (const f of fingerprints) fingerprintsSet.add(f);
        }
        return redactedText;
      }

      // Array transformation
      if (Array.isArray(current)) {
        return current.map((item, idx) =>
          transform(item, currentPath ? `${currentPath}[${idx}]` : `[${idx}]`),
        );
      }

      // Object transformation
      if (typeof current === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(current as Record<string, unknown>)) {
          const fieldPath = currentPath ? `${currentPath}.${key}` : key;

          // Preserved identifier / keyword field check
          if (PRESERVED_IDENTIFIER_FIELDS.has(key)) {
            result[key] = val;
            continue;
          }

          // Local-only field check (strip or mask)
          if (this.localOnlyFieldsSet.has(key)) {
            redactedFieldsSet.add(fieldPath);
            patternsSet.add(`local_only_field:${key}`);
            if (this.config.strategy === "drop") {
              continue;
            }
            result[key] = `[REDACTED_LOCAL_FIELD:${key}]`;
            continue;
          }

          result[key] = transform(val, fieldPath);
        }
        return result;
      }

      return current;
    };

    const transformedData = transform(value, "") as T;
    const isRedacted = redactedFieldsSet.size > 0 || patternsSet.size > 0;

    return {
      data: transformedData,
      isRedacted,
      redactedFields: Array.from(redactedFieldsSet).sort(),
      redactionStrategy: isRedacted ? (this.config.strategy ?? "mask") : "none",
      scrubbedPatterns: Array.from(patternsSet).sort(),
      fingerprintHashes: Array.from(fingerprintsSet).sort(),
    };
  }

  /**
   * Helper to build a complete RedactionMeta object from a RedactionResult.
   */
  createRedactionMeta(result: RedactionResult): RedactionMeta {
    return {
      isRedacted: result.isRedacted,
      redactedFields: result.redactedFields,
      redactionStrategy: result.redactionStrategy,
      scrubbedPatterns: result.scrubbedPatterns,
      redactedAt: result.isRedacted ? new Date().toISOString() : undefined,
    };
  }
}
