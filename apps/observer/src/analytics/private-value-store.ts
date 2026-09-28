/** Local-only workflow values. Exact V2 originals never become uploaded event fields. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface PrivateValueOrigin {
  workspaceId?: string;
}

export type PrivateValueRepresentation = "literal" | "redacted";

export interface PrivateValueStore {
  get(key: string): unknown | undefined;
  set(
    key: string,
    value: unknown,
    origin?: PrivateValueOrigin,
    representation?: PrivateValueRepresentation,
  ): void;
  origin?(key: string): PrivateValueOrigin | undefined;
  representation?(key: string): PrivateValueRepresentation | undefined;
  /**
   * Device-local HMAC key that tags redaction placeholders. Stable for this store so one secret
   * keeps one placeholder across sessions; never uploaded.
   */
  redactionKey?(): Uint8Array;
}

const STORE_FILE = "private-values.json";
const STORE_DIR = "private-values";
const MAX_ENTRIES = 4096;
const REDACTION_KEY_FILE = "redaction-key";
const REDACTION_KEY_BYTES = 32;
const PLACEHOLDER_PATTERN = /\[REDACTED_[A-Z_]+:[^\]]+\]/g;
const PLACEHOLDER_TEST = /\[REDACTED_[A-Z_]+:[^\]]+\]/;

export function containsRedactionPlaceholder(value: string): boolean {
  return PLACEHOLDER_TEST.test(value);
}

/** Legacy masks are resolved locally; exact originals retain their types and literal text. */
export function resolvePrivateReference(store: PrivateValueStore, reference: string): unknown {
  const stored = store.get(reference);
  if (stored === undefined)
    throw new Error(`private reference '${reference}' is not in the local value store`);
  if (store.representation?.(reference) === "literal") return stored;
  const substitute = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(PLACEHOLDER_PATTERN, (placeholder) => {
        const original = store.get(placeholder);
        if (original === undefined) {
          throw new Error(
            `private reference '${reference}' needs '${placeholder}', which is not in the local value store`,
          );
        }
        return typeof original === "string" ? original : JSON.stringify(original);
      });
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = substitute(entry);
      return out;
    }
    return value;
  };
  return substitute(stored);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why the key file cannot be trusted as this user's private key; undefined when it can. */
function redactionKeyProblem(target: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (!stat.isFile()) return "not a regular file";
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return "owned by another user";
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return "mode looser than 0600";
  if (stat.size !== REDACTION_KEY_BYTES) return "truncated or corrupt";
  return undefined;
}

/** Writes a fresh key durably to a temporary file, then hands it to `publish` to place it. */
function publishRedactionKey(target: string, publish: (temporary: string) => void): void {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeSync(fd, randomBytes(REDACTION_KEY_BYTES));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    publish(temporary);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

interface PrivateEntry {
  value: unknown;
  at: number;
  origin?: PrivateValueOrigin;
  representation?: PrivateValueRepresentation;
}
interface ImmutableEntry extends PrivateEntry {
  key: string;
}

function isSameEntry(current: PrivateEntry, next: PrivateEntry): boolean {
  return (
    isDeepStrictEqual(current.value, next.value) &&
    isDeepStrictEqual(current.origin, next.origin) &&
    (current.representation ?? "redacted") === (next.representation ?? "redacted")
  );
}

function assertSameEntry(current: PrivateEntry, next: PrivateEntry, key: string): void {
  if (!isSameEntry(current, next)) {
    throw new Error(
      `private value reference '${key}' already exists with different content or origin (different value or owner)`,
    );
  }
}

function snapshot(
  value: unknown,
  origin: PrivateValueOrigin | undefined,
  representation: PrivateValueRepresentation,
): PrivateEntry {
  const result = JSON.parse(
    JSON.stringify({ value, origin, representation, at: Date.now() }),
  ) as PrivateEntry;
  if (!Object.hasOwn(result, "value")) throw new Error("A private reference requires a JSON value");
  return result;
}

/**
 * New references are immutable owner-only files, atomically created without overwriting a winner.
 * This removes the concurrent shared-JSON read/modify/write race for captured workflow values.
 * Legacy entries remain readable. The cache is bounded; referenced V2 files are not evicted.
 */
export class FilePrivateValueStore implements PrivateValueStore {
  private static shared: FilePrivateValueStore | undefined;
  private readonly file: string;
  private entries: Map<string, PrivateEntry> | undefined;
  /** Stat signature of the legacy file last read or written by this instance. */
  private loadedSignature: string | undefined;
  private readonly immutableEntries = new Map<string, ImmutableEntry>();
  private deviceRedactionKey: Buffer | undefined;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, STORE_DIR, STORE_FILE);
  }

  static default(): FilePrivateValueStore {
    FilePrivateValueStore.shared ??= new FilePrivateValueStore(
      path.join(os.homedir(), ".resin", "data"),
    );
    return FilePrivateValueStore.shared;
  }

  /**
   * Owner-only random key, created once per device beside the private values it protects. A
   * concurrent creator loses to the first published key, so every process tags alike. A key file
   * another user owns, readable or writable by others, or of the wrong size is replaced with a
   * fresh key after a warning: placeholders are store keys, so every value recorded under the old
   * key keeps resolving through its stored mapping; only new placeholders carry the new tag.
   */
  redactionKey(): Uint8Array {
    if (this.deviceRedactionKey !== undefined) return this.deviceRedactionKey;
    const target = path.join(path.dirname(this.file), REDACTION_KEY_FILE);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    let problem = redactionKeyProblem(target);
    if (problem === "missing") {
      publishRedactionKey(target, (temporary) => {
        try {
          fs.linkSync(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      });
      problem = redactionKeyProblem(target);
    }
    if (problem !== undefined) {
      process.emitWarning(
        `Replacing the local redaction key at '${target}' (${problem}); earlier placeholders still resolve locally`,
      );
      publishRedactionKey(target, (temporary) => fs.renameSync(temporary, target));
      problem = redactionKeyProblem(target);
      if (problem !== undefined) {
        throw new Error(`Cannot establish the local redaction key at '${target}' (${problem})`);
      }
    }
    const key = fs.readFileSync(target);
    this.deviceRedactionKey = key;
    return key;
  }

  private immutablePath(key: string): string {
    return path.join(
      path.dirname(this.file),
      "entries-v2",
      `${createHash("sha256").update(key).digest("hex")}.json`,
    );
  }

  private readImmutable(key: string): ImmutableEntry | undefined {
    const cached = this.immutableEntries.get(key);
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = fs.readFileSync(this.immutablePath(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot read local private reference '${key}'`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Corrupt local private reference '${key}'`);
    }
    if (
      !isPlainObject(value) ||
      value.key !== key ||
      !Object.hasOwn(value, "value") ||
      (value.representation !== "literal" && value.representation !== "redacted")
    ) {
      throw new Error(`Invalid local private reference '${key}'`);
    }
    const entry = value as unknown as ImmutableEntry;
    this.immutableEntries.set(key, entry);
    if (this.immutableEntries.size > MAX_ENTRIES) {
      const oldest = this.immutableEntries.keys().next().value;
      if (oldest !== undefined) this.immutableEntries.delete(oldest);
    }
    return entry;
  }

  private writeImmutable(key: string, entry: PrivateEntry): void {
    const current = this.readImmutable(key);
    if (current !== undefined) {
      assertSameEntry(current, entry, key);
      return;
    }
    const target = this.immutablePath(key);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...entry, key }), { flag: "wx", mode: 0o600 });
      try {
        // A hard link atomically publishes only if absent. rename would overwrite a concurrent value.
        fs.linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = this.readImmutable(key);
        if (winner === undefined) throw new Error(`Missing concurrent private reference '${key}'`);
        assertSameEntry(winner, entry, key);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private load(): Map<string, PrivateEntry> {
    const signature = this.legacySignature();
    if (this.entries && signature === this.loadedSignature) return this.entries;
    this.entries = new Map();
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (isPlainObject(raw)) {
        for (const [key, entry] of Object.entries(raw)) {
          const origin =
            isPlainObject(entry) && isPlainObject(entry.origin)
              ? (entry.origin as PrivateValueOrigin)
              : undefined;
          this.entries.set(key, {
            value: isPlainObject(entry) && "value" in entry ? entry.value : entry,
            at: isPlainObject(entry) && typeof entry.at === "number" ? entry.at : 0,
            ...(origin ? { origin } : {}),
            ...(isPlainObject(entry) && entry.representation === "literal"
              ? { representation: "literal" as const }
              : {}),
          });
        }
      }
      this.loadedSignature = signature;
    } catch {
      // Existing behavior: unavailable legacy values fail resolution, never become guessed data.
    }
    return this.entries;
  }

  /**
   * Every legacy write renames a fresh temp file into place, so the inode changes with each
   * writer; with mtime and size this detects another process's write even within one mtime tick.
   */
  private legacySignature(): string | undefined {
    try {
      const stat = fs.statSync(this.file, { bigint: true });
      return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    } catch {
      // A missing legacy file starts empty. V2 entries are independent of this file.
      return undefined;
    }
  }

  get(key: string): unknown | undefined {
    return key.startsWith("private:v2:")
      ? structuredClone(this.readImmutable(key)?.value)
      : this.load().get(key)?.value;
  }

  origin(key: string): PrivateValueOrigin | undefined {
    return key.startsWith("private:v2:")
      ? structuredClone(this.readImmutable(key)?.origin)
      : this.load().get(key)?.origin;
  }

  representation(key: string): PrivateValueRepresentation | undefined {
    return key.startsWith("private:v2:")
      ? this.readImmutable(key)?.representation
      : this.load().get(key)?.representation;
  }

  set(
    key: string,
    value: unknown,
    origin?: PrivateValueOrigin,
    representation: PrivateValueRepresentation = "redacted",
  ): void {
    const entry = snapshot(value, origin, representation);
    if (key.startsWith("private:v2:")) {
      this.writeImmutable(key, entry);
      return;
    }
    // load() re-reads only when another writer changed the file since this instance last saw it.
    const entries = this.load();
    const existing = entries.get(key);
    if (existing !== undefined && key.startsWith("private:")) {
      assertSameEntry(existing, entry, key);
      return;
    }
    if (existing !== undefined && isSameEntry(existing, entry)) {
      // Refresh recency only when eviction is within reach (store over half full) and the entry has
      // fallen into the older half of the retained time window, so hot aliases never reach eviction
      // while a key cycling below capacity is never rewritten.
      if (entries.size <= MAX_ENTRIES / 2) return;
      const oldestKey = entries.keys().next().value;
      const oldestAt =
        oldestKey === undefined ? entry.at : (entries.get(oldestKey)?.at ?? entry.at);
      if (existing.at >= (oldestAt + entry.at) / 2) return;
    }
    // Legacy placeholder keys are aliases, not unique reference identities.
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      /* Filesystems without POSIX modes. */
    }
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries)), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
      this.loadedSignature = this.legacySignature();
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* Filesystems without POSIX modes. */
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/** Same identity/value rules for tests and non-persisting local consumers. */
export class InMemoryPrivateValueStore implements PrivateValueStore {
  private readonly entries = new Map<string, PrivateEntry>();
  private readonly deviceRedactionKey = randomBytes(REDACTION_KEY_BYTES);
  redactionKey(): Uint8Array {
    return this.deviceRedactionKey;
  }
  get(key: string): unknown | undefined {
    return structuredClone(this.entries.get(key)?.value);
  }
  origin(key: string): PrivateValueOrigin | undefined {
    return structuredClone(this.entries.get(key)?.origin);
  }
  representation(key: string): PrivateValueRepresentation | undefined {
    return this.entries.get(key)?.representation;
  }
  set(
    key: string,
    value: unknown,
    origin?: PrivateValueOrigin,
    representation: PrivateValueRepresentation = "redacted",
  ): void {
    const next = snapshot(value, origin, representation);
    const current = this.entries.get(key);
    if (key.startsWith("private:") && current !== undefined) assertSameEntry(current, next, key);
    this.entries.set(key, next);
  }
}
