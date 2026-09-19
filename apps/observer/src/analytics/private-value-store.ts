/**
 * The private value store: the local-only record that lets a recorded workflow replay
 * values the privacy layer removed.
 *
 * Redaction replaces a secret with a deterministic placeholder; the recipe replaces a
 * placeholder-bearing leaf with a `private:` reference. Neither the placeholder nor the
 * reference can be executed — only this store can say what they stood for. It therefore
 * lives only on the machine that produced the recording: the workflow that is uploaded
 * carries references, and the executor resolves them here at invocation time.
 *
 * Two key namespaces share one file:
 * - `[REDACTED_...]` placeholder → the original JSON value the placeholder replaced.
 * - `private:<scope>:<n>` reference → the redacted leaf the reference stands for.
 *
 * Resolution substitutes placeholders inside the stored leaf, so a private reference
 * always yields the original value while the store itself never holds a plaintext
 * secret under a `private:` key.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Where a stored value came from. A `private:` reference is a name, not a capability: the
 * workspace that recorded the value is what an executor checks before resolving it, so a
 * workflow that merely knows another recording's reference string is still refused.
 */
export interface PrivateValueOrigin {
  workspaceId?: string;
}

export interface PrivateValueStore {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, origin?: PrivateValueOrigin): void;
  /** The recorded origin of a key, when the writer stated one. */
  origin?(key: string): PrivateValueOrigin | undefined;
}

const STORE_FILE = "private-values.json";
const STORE_DIR = "private-values";
const MAX_ENTRIES = 4096;

const PLACEHOLDER_PATTERN = /\[REDACTED_[A-Z_]+:[^\]]+\]/g;
const PLACEHOLDER_TEST = /\[REDACTED_[A-Z_]+:[^\]]+\]/;

/** True when a recorded leaf still carries a redaction placeholder. */
export function containsRedactionPlaceholder(value: string): boolean {
  return PLACEHOLDER_TEST.test(value);
}

/**
 * Resolves a `private:` reference to the original value: the stored leaf is the
 * redacted form, so every placeholder inside it is substituted from the same store.
 * A placeholder the store cannot resolve fails honestly rather than replaying a mask.
 */
export function resolvePrivateReference(store: PrivateValueStore, reference: string): unknown {
  const stored = store.get(reference);
  if (stored === undefined) {
    throw new Error(`private reference '${reference}' is not in the local value store`);
  }
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

/**
 * A JSON file under `<dataDir>/private-values/`, written atomically with owner-only
 * permissions. Entries are bounded; the oldest written entries are evicted first.
 */
export class FilePrivateValueStore implements PrivateValueStore {
  private static shared: FilePrivateValueStore | undefined;

  private readonly file: string;
  private entries:
    | Map<string, { value: unknown; at: number; origin?: PrivateValueOrigin }>
    | undefined;
  private loadedMtimeMs = -1;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, STORE_DIR, STORE_FILE);
  }

  /**
   * The default store location: the daemon's data directory under ~/.resin. One shared
   * instance per process so the redaction hook and the carrier recorder observe the
   * same entries without a second read of the file.
   */
  static default(): FilePrivateValueStore {
    FilePrivateValueStore.shared ??= new FilePrivateValueStore(
      path.join(os.homedir(), ".resin", "data"),
    );
    return FilePrivateValueStore.shared;
  }

  private load(): Map<string, { value: unknown; at: number; origin?: PrivateValueOrigin }> {
    // Reload only when the file changed on disk: a long-lived executor must see secrets
    // recorded after its first resolution, not a snapshot cached forever. The mtime gate
    // keeps the shared instance cheap when nothing was written.
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      // Missing file: fall through and serve whatever is cached (empty on first call).
    }
    if (this.entries && mtimeMs === this.loadedMtimeMs) return this.entries;
    this.entries = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
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
          });
        }
      }
      this.loadedMtimeMs = mtimeMs;
    } catch {
      // A missing or unreadable store is an empty one; resolution fails honestly later.
    }
    return this.entries;
  }

  get(key: string): unknown | undefined {
    return this.load().get(key)?.value;
  }

  origin(key: string): PrivateValueOrigin | undefined {
    return this.load().get(key)?.origin;
  }

  set(key: string, value: unknown, origin?: PrivateValueOrigin): void {
    // Always merge against the latest on-disk view before writing. A stable reference is immutable:
    // redelivery is idempotent, while a different value or owner for the same identity is corruption.
    this.entries = undefined;
    this.loadedMtimeMs = -1;
    const entries = this.load();
    const existing = entries.get(key);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.value, value) || !isDeepStrictEqual(existing.origin, origin)) {
        throw new Error(`private value reference '${key}' already exists with different content or origin`);
      }
      return;
    }
    entries.set(key, { value, at: Date.now(), ...(origin ? { origin } : {}) });
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    const body: Record<string, unknown> = {};
    for (const [k, entry] of entries)
      body[k] = {
        value: entry.value,
        at: entry.at,
        ...(entry.origin ? { origin: entry.origin } : {}),
      };
    const tmp = `${this.file}.${process.pid}.${createHash("sha1").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    // loadedMtimeMs is deliberately left stale: the next load() re-stats and re-reads,
    // which captures this write and any external write with no same-tick miss window.
  }
}

/** Test and in-process seam: same contract, nothing persisted. */
export class InMemoryPrivateValueStore implements PrivateValueStore {
  private readonly entries = new Map<string, { value: unknown; origin?: PrivateValueOrigin }>();

  get(key: string): unknown | undefined {
    return this.entries.get(key)?.value;
  }

  origin(key: string): PrivateValueOrigin | undefined {
    return this.entries.get(key)?.origin;
  }

  set(key: string, value: unknown, origin?: PrivateValueOrigin): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.value, value) || !isDeepStrictEqual(existing.origin, origin)) {
        throw new Error(`private value reference '${key}' already exists with different content or origin`);
      }
      return;
    }
    this.entries.set(key, { value, ...(origin ? { origin } : {}) });
  }
}
