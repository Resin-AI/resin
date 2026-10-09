import { createHmac, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { RedactionMeta, RedactionStrategy } from "@resin/contracts";
import { z } from "zod";
import { type RedactionSpan, locateReplacements } from "./redaction-spans.js";
import { ContentScanner } from "./scanner.js";
import { WindowsIdentityScrubber, environmentValue, isWindowsPath } from "./windows-identity.js";

export type JsonPrimitive = string | number | boolean | null | undefined;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type { RedactionSpan } from "./redaction-spans.js";

export interface RedactedStringResult {
  redactedText: string;
  changed: boolean;
  patterns: string[];
  fingerprints: string[];
  /** Program sources only: each replacement's span in the input, when all could be located. */
  spans?: RedactionSpan[];
}

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
  /**
   * Environment variable names whose values must be scrubbed from content. Unset: the default
   * list plus every secret-named variable (`*_TOKEN`, `*_PASSWORD`, `DATABASE_URL`, ...) found in
   * `environment`.
   */
  sensitiveEnvVars?: string[];
  /**
   * Environment of the harness session whose content is redacted, when its adapter exposes it.
   * Defaults to this process's environment.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Platform the redacted session ran on (default: this process's). A Windows session also scrubs
   * its `USERNAME`, `USERDOMAIN`, `USERDNSDOMAIN` and `COMPUTERNAME` values and looks variables up
   * case-insensitively; Windows home directories are scrubbed from every session's content.
   */
  platform?: NodeJS.Platform;
  /**
   * Device-local HMAC key for placeholder tags. It never leaves the device, so an uploaded tag
   * cannot be matched against guessed secrets or correlated across devices. Defaults to a fresh
   * random key for this engine.
   */
  fingerprintKey?: Uint8Array;
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
  /**
   * Local-only hook invoked for every placeholder substitution, with the placeholder
   * string and the original value it replaced. The workflow capture uses it to keep a
   * private value recoverable on this machine without ever carrying it upstream.
   */
  onRedact?: (placeholder: string, original: JsonValue) => void;
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

/** Variable names that mark their value a credential, scrubbed when present in the environment. */
const SECRET_ENV_NAME =
  /(?:PASS|PASSWD|PASSWORD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)$|^(?:DATABASE|REDIS|MONGO(?:DB)?|POSTGRES(?:QL)?|MYSQL|AMQP|RABBITMQ|BROKER|CACHE)_URL$/i;

/** Hex characters of the keyed tag carried by each placeholder. */
const FINGERPRINT_HEX_LENGTH = 16;

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
  "producedByCallId",
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

/** Field names whose value is a content digest when it is shaped like one. */
const DIGEST_FIELD_NAME = /(?:hash|digest|sha(?:1|256|512)?|checksum)$/i;
const DIGEST_VALUE = /^(?:sha(?:1|256|512):)?(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$/i;

/** Keyed tag: without the device key an uploaded tag confirms nothing about a guessed secret. */
function computeFingerprint(key: Uint8Array, secret: string): string {
  return createHmac("sha256", key).update(secret).digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
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
  private readonly windowsIdentity: WindowsIdentityScrubber;
  private readonly fingerprintKey: Uint8Array;
  private readonly localOnlyFieldsSet: Set<string>;
  private readonly preserveWorkspaceRootCwd: boolean;

  constructor(config: RedactionConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      strategy: config.strategy ?? "mask",
      homeDir: config.homeDir ?? os.homedir(),
      repoRoot: config.repoRoot,
      pathAliases: config.pathAliases ?? {},
      sensitiveEnvVars: config.sensitiveEnvVars,
      customSecrets: config.customSecrets ?? [],
      scanContent: config.scanContent ?? true,
      redactHighEntropy: config.redactHighEntropy ?? true,
      entropyThreshold: config.entropyThreshold ?? 4.3,
      maxStringLength: config.maxStringLength ?? 65536,
      localOnlyFields: config.localOnlyFields ?? DEFAULT_LOCAL_ONLY_FIELDS,
      onRedact: config.onRedact,
    };
    this.fingerprintKey = config.fingerprintKey ?? randomBytes(32);

    this.scanner =
      config.scanner ??
      new ContentScanner({
        scanEntropy: this.config.redactHighEntropy,
        entropyThreshold: this.config.entropyThreshold,
      });

    this.localOnlyFieldsSet = new Set(this.config.localOnlyFields);
    this.preserveWorkspaceRootCwd =
      config.strategy !== "drop" &&
      !config.localOnlyFields?.some((field) => field === "cwd" || field === "workingDirectory");

    // Build ordered path replacements (longest path first to avoid prefix shadowing)
    const rawPathMap: Record<string, string> = {};
    if (this.config.pathAliases) {
      Object.assign(rawPathMap, this.config.pathAliases);
    }

    if (this.config.repoRoot && this.config.repoRoot.length > 1) {
      rawPathMap[this.config.repoRoot] = "$REPO_ROOT";
      rawPathMap[path.resolve(this.config.repoRoot)] = "$REPO_ROOT";
    }

    // A Windows home is aliased by the Windows identity step in every spelling (separators, case,
    // `\\?\` prefix), which a literal replacement here would pre-empt with a partial match.
    if (
      this.config.homeDir &&
      this.config.homeDir.length > 1 &&
      !isWindowsPath(this.config.homeDir)
    ) {
      rawPathMap[this.config.homeDir] = "$HOME";
      rawPathMap[path.resolve(this.config.homeDir)] = "$HOME";
    }

    this.pathReplacements = Object.entries(rawPathMap)
      .filter(([k]) => k.length > 1)
      .sort((a, b) => b[0].length - a[0].length)
      .map(([pattern, replacement]) => ({ pattern, replacement }));

    // Build env secrets list from the session's environment
    const environment = config.environment ?? process.env;
    const platform = config.platform ?? process.platform;
    this.windowsIdentity = new WindowsIdentityScrubber({
      homeDir: this.config.homeDir,
      environment,
      platform,
    });
    const sensitiveEnvVars =
      this.config.sensitiveEnvVars ??
      Array.from(
        new Set([
          ...DEFAULT_SENSITIVE_ENV_VARS,
          ...Object.keys(environment).filter((name) => SECRET_ENV_NAME.test(name)),
        ]),
      );
    this.envSecretReplacements = [];
    for (const envVarName of sensitiveEnvVars) {
      const val = environmentValue(environment, envVarName, platform);
      if (val && val.trim().length >= 6) {
        const fp = computeFingerprint(this.fingerprintKey, val);
        this.envSecretReplacements.push({
          secret: val,
          placeholder: `[REDACTED_ENV:${envVarName}:${fp}]`,
          name: envVarName,
        });
      }
    }
    // Longest value first so a secret containing another is replaced whole.
    this.envSecretReplacements.sort((a, b) => b.secret.length - a.secret.length);

    // Build custom secrets list
    this.customSecretReplacements = (this.config.customSecrets ?? [])
      .filter((s) => Boolean(s) && s.trim().length >= 4)
      .map((secret) => ({
        secret,
        fingerprint: computeFingerprint(this.fingerprintKey, secret),
      }));
  }

  /**
   * Redacts a single string according to privacy transforms.
   */
  redactString(text: string, fieldPath = ""): RedactedStringResult {
    return this.redactText(text, fieldPath);
  }

  /**
   * Redacts the opaque identifiers stored under `keys` of `record` (strings or string arrays), such
   * as a provider response id (`msg_…`, `resp_…`) or a harness record id. Every explicit transform
   * still applies (known credential formats, secret values from the environment, custom secrets,
   * identity scrubbing); only the high-entropy heuristic is skipped, because a random-looking id is
   * what an identifier is, and scrubbing it would break the identity it carries. Redacted fields are
   * reported by key.
   */
  redactOpaqueIdentifiers(
    record: JsonObject,
    keys: readonly string[],
  ): RedactionResult<JsonObject> {
    const redactedFields = new Set<string>();
    const patterns = new Set<string>();
    const fingerprints = new Set<string>();
    const scrub = (id: string, key: string): string => {
      const scrubbed = this.redactText(id, key, undefined, false);
      if (scrubbed.changed) {
        redactedFields.add(key);
        for (const p of scrubbed.patterns) patterns.add(p);
        for (const f of scrubbed.fingerprints) fingerprints.add(f);
      }
      return scrubbed.redactedText;
    };
    const data: JsonObject = { ...record };
    for (const key of keys) {
      const value = data[key];
      if (typeof value === "string") {
        data[key] = scrub(value, key);
      } else if (Array.isArray(value)) {
        data[key] = value.map((id) => (typeof id === "string" ? scrub(id, key) : id));
      }
    }
    const isRedacted = redactedFields.size > 0;
    return {
      data,
      isRedacted,
      redactedFields: Array.from(redactedFields).sort(),
      redactionStrategy: isRedacted ? (this.config.strategy ?? "mask") : "none",
      scrubbedPatterns: Array.from(patterns).sort(),
      fingerprintHashes: Array.from(fingerprints).sort(),
    };
  }

  /** `record` hears every replacement text with the text it replaced, at whatever step it ran. */
  private redactText(
    text: string,
    fieldPath: string,
    record?: (replacement: string, original: string) => void,
    entropyHeuristics = true,
  ): RedactedStringResult {
    if (!text) {
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
        record?.(replacement, pattern);
      }
    }

    // 2. Sensitive Env Var Values
    for (const { secret, placeholder, name } of this.envSecretReplacements) {
      if (current.includes(secret)) {
        current = current.split(secret).join(placeholder);
        changed = true;
        patterns.push(`env_var:${name}`);
        fingerprints.push(placeholder);
        this.config.onRedact?.(placeholder, secret);
        record?.(placeholder, secret);
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
        this.config.onRedact?.(placeholder, secret);
        record?.(placeholder, secret);
      }
    }

    // 3b. Windows identity: home directories in every spelling, OneDrive organizations, and the
    // session's user, domain and machine names. After the secret values, which may contain them.
    const identity = this.windowsIdentity.scrub(
      current,
      (type, original) => {
        const fingerprint = computeFingerprint(this.fingerprintKey, original);
        const placeholder = `[REDACTED_${type}:${fingerprint}]`;
        fingerprints.push(fingerprint);
        this.config.onRedact?.(placeholder, original);
        record?.(placeholder, original);
        return placeholder;
      },
      record,
    );
    if (identity.text !== current) {
      current = identity.text;
      changed = true;
      patterns.push(...identity.patterns);
    }

    // 4. Content Scanning (Regex & High Entropy)
    if (this.config.scanContent) {
      const matches = this.scanner
        .scan(current)
        .filter((m) => entropyHeuristics || m.secretType !== "HIGH_ENTROPY_SECRET");
      if (matches.length > 0) {
        // Replace from end to start to keep offsets valid
        for (let i = matches.length - 1; i >= 0; i--) {
          const m = matches[i];
          const fp = computeFingerprint(this.fingerprintKey, m.match);
          const placeholder = `[REDACTED_${m.secretType}:${fp}]`;
          current = current.slice(0, m.start) + placeholder + current.slice(m.end);
          changed = true;
          patterns.push(m.patternId);
          this.config.onRedact?.(placeholder, m.match);
          record?.(placeholder, m.match);
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
   * Produces a source view eligible for projection, never an executable replacement for the
   * locally retained original. Disabled scanning or truncation cannot authorize source sharing.
   * The result carries where each replacement sits in `source` (`spans`), when every replacement
   * can be located exactly, so a projection can redact each value in place.
   */
  redactProgramSource(source: string): RedactedStringResult | undefined {
    if (
      !this.config.enabled ||
      !this.config.scanContent ||
      !this.config.redactHighEntropy ||
      this.config.strategy === "none"
    ) {
      return undefined;
    }
    const replaced = new Map<string, Set<string>>();
    const result = this.redactText(source, "program", (replacement, original) => {
      if (original.length === 0) return;
      const originals = replaced.get(replacement) ?? new Set<string>();
      originals.add(original);
      replaced.set(replacement, originals);
    });
    if (result.patterns.some((pattern) => pattern.startsWith("truncation:"))) return undefined;
    const spans = result.changed ? locateReplacements(source, result.redactedText, replaced) : [];
    return spans === undefined ? result : { ...result, spans };
  }

  /**
   * Deeply transforms and redacts any value (object, array, string, primitive).
   */
  redact<T = unknown>(
    value: T,
    workspaceRootCwdField?: "cwd" | "parameters.cwd",
  ): RedactionResult<T> {
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

    const transform = <V>(current: V, currentPath: string): JsonValue => {
      if (current === null || current === undefined) {
        return current === null ? null : undefined;
      }

      // String transformation
      const stringParsed = z.string().safeParse(current);
      if (stringParsed.success) {
        const { redactedText, changed, patterns, fingerprints } = this.redactString(
          stringParsed.data,
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
      const objectParsed = z.record(z.unknown()).safeParse(current);
      if (objectParsed.success) {
        const result: JsonObject = {};
        for (const [key, val] of Object.entries(objectParsed.data)) {
          // An optional field with no value is absent evidence, not a private JSON leaf.
          if (val === undefined) continue;
          const fieldPath = currentPath ? `${currentPath}.${key}` : key;

          // Preserved identifier / keyword field check
          if (PRESERVED_IDENTIFIER_FIELDS.has(key)) {
            // SAFETY: Preserved identifier fields are kept intact without redaction.
            result[key] = val as JsonValue;
            continue;
          }
          // A request id is the opaque identity usage accounting dedupes by, so it is scanned only
          // for explicit secrets: a provider id such as `msg_…` or `resp_…` would otherwise read as a
          // high-entropy secret and lose its identity.
          if (fieldPath === "providerUsage.requestId" && typeof val === "string") {
            const scrubbed = this.redactText(val, fieldPath, undefined, false);
            if (scrubbed.changed) {
              redactedFieldsSet.add(fieldPath);
              for (const p of scrubbed.patterns) patternsSet.add(p);
              for (const f of scrubbed.fingerprints) fingerprintsSet.add(f);
            }
            result[key] = scrubbed.redactedText;
            continue;
          }

          // Content digests (beforeHash, afterHash, contentSha256) are hashes, not secrets.
          if (DIGEST_FIELD_NAME.test(key) && typeof val === "string" && DIGEST_VALUE.test(val)) {
            result[key] = val;
            continue;
          }

          // Local-only field check (strip or mask)
          if (
            this.localOnlyFieldsSet.has(key) ||
            (fieldPath === workspaceRootCwdField && !this.preserveWorkspaceRootCwd)
          ) {
            // Only the caller's semantic cwd slot can carry root evidence. Never recover
            // it from a placeholder or preserve unrelated/nested local-only fields.
            if (
              this.preserveWorkspaceRootCwd &&
              fieldPath === workspaceRootCwdField &&
              (val === "." || val === "./") &&
              !this.redactString(val, fieldPath).changed
            ) {
              result[key] = ".";
              continue;
            }
            redactedFieldsSet.add(fieldPath);
            patternsSet.add(`local_only_field:${key}`);
            if (this.config.strategy === "drop") {
              continue;
            }
            result[key] = `[REDACTED_LOCAL_FIELD:${key}]`;
            this.config.onRedact?.(`[REDACTED_LOCAL_FIELD:${key}]`, val as JsonValue);
            continue;
          }

          result[key] = transform(val, fieldPath);
        }
        return result;
      }

      const numParsed = z.number().safeParse(current);
      if (numParsed.success) return numParsed.data;

      const boolParsed = z.boolean().safeParse(current);
      if (boolParsed.success) return boolParsed.data;

      return null;
    };

    // SAFETY: transform traverses and deep-clones the input structure while preserving type T.
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
