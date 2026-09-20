/** Local-only workflow values. Exact V2 originals never become uploaded event fields. */
import { createHash, randomUUID } from "node:crypto";
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
}

const STORE_FILE = "private-values.json";
const STORE_DIR = "private-values";
const MAX_ENTRIES = 4096;
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

interface PrivateEntry {
  value: unknown;
  at: number;
  origin?: PrivateValueOrigin;
  representation?: PrivateValueRepresentation;
}
interface ImmutableEntry extends PrivateEntry {
  key: string;
}

function assertSameEntry(current: PrivateEntry, next: PrivateEntry, key: string): void {
  if (
    !isDeepStrictEqual(current.value, next.value) ||
    !isDeepStrictEqual(current.origin, next.origin) ||
    (current.representation ?? "redacted") !== (next.representation ?? "redacted")
  ) {
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
  private loadedMtimeMs = -1;
  private readonly immutableEntries = new Map<string, ImmutableEntry>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, STORE_DIR, STORE_FILE);
  }

  static default(): FilePrivateValueStore {
    FilePrivateValueStore.shared ??= new FilePrivateValueStore(
      path.join(os.homedir(), ".resin", "data"),
    );
    return FilePrivateValueStore.shared;
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
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      // A missing legacy file starts empty. V2 entries are independent of this file.
    }
    if (this.entries && mtimeMs === this.loadedMtimeMs) return this.entries;
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
      this.loadedMtimeMs = mtimeMs;
    } catch {
      // Existing behavior: unavailable legacy values fail resolution, never become guessed data.
    }
    return this.entries;
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
    this.entries = undefined;
    this.loadedMtimeMs = -1;
    const entries = this.load();
    const existing = entries.get(key);
    if (key.startsWith("private:") && existing !== undefined) {
      assertSameEntry(existing, entry, key);
      return;
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
