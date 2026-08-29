import { createHash } from "node:crypto";
import { type NormalizedSessionEvent, hashCanonicalContent } from "@resin/contracts";
import type { StreamMessage } from "@resin/protocol";
import { allValidDomainEvents } from "./golden/domain.js";
/**
 * Deterministic Fake Environment
 *
 * Provides deterministic clocks, seeded ID/UUID generators, in-memory filesystems,
 * content-addressable artifact stores, and mock control streams.
 */

// ============================================================================
// 1. Fake Clock
// ============================================================================

export class FakeClock {
  private currentEpochMs: number;
  private readonly initialEpochMs: number;

  constructor(initialTime: number | string | Date = "2026-08-17T12:00:00.000Z") {
    this.initialEpochMs =
      Object.prototype.toString.call(initialTime) === "[object Number]"
        ? Number(initialTime)
        : new Date(initialTime).getTime();
    this.currentEpochMs = this.initialEpochMs;
  }

  /** Current epoch milliseconds */
  now(): number {
    return this.currentEpochMs;
  }

  /** Current ISO 8601 string */
  iso(): string {
    return new Date(this.currentEpochMs).toISOString();
  }

  /** Advance clock by delta milliseconds */
  advance(deltaMs: number): number {
    if (deltaMs < 0) {
      throw new Error(`Clock cannot be moved backwards in advance(): ${deltaMs}`);
    }
    this.currentEpochMs += deltaMs;
    return this.currentEpochMs;
  }

  /** Set clock to a specific target time */
  set(targetTime: number | string | Date): number {
    this.currentEpochMs =
      Object.prototype.toString.call(targetTime) === "[object Number]"
        ? Number(targetTime)
        : new Date(targetTime).getTime();
    return this.currentEpochMs;
  }

  /** Advance clock to a specific target time (fails if target is in the past) */
  advanceTo(targetTime: number | string | Date): number {
    const targetMs = Number.isFinite(targetTime)
      ? Number(targetTime)
      : new Date(targetTime).getTime();
    if (targetMs < this.currentEpochMs) {
      throw new Error(
        `Target time ${new Date(targetMs).toISOString()} is behind current time ${this.iso()}`,
      );
    }
    this.currentEpochMs = targetMs;
    return this.currentEpochMs;
  }

  /** Reset clock to initial time */
  reset(time?: number | string | Date): void {
    this.currentEpochMs =
      time !== undefined
        ? Object.prototype.toString.call(time) === "[object Number]"
          ? Number(time)
          : new Date(time).getTime()
        : this.initialEpochMs;
  }
}

// ============================================================================
// 2. Deterministic ID Generator
// ============================================================================

export class DeterministicIdGenerator {
  private counter: number;
  private rngState: number;
  private readonly initialSeed: number;

  constructor(seed = 42) {
    this.initialSeed = seed;
    this.rngState = seed;
    this.counter = 0;
  }

  /** Linear congruential generator step */
  private nextRandom(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) % 4294967296;
    return this.rngState / 4294967296;
  }

  /** Next sequential identifier with prefix */
  nextId(prefix = "id"): string {
    this.counter++;
    const padded = String(this.counter).padStart(6, "0");
    return `${prefix}_${padded}`;
  }

  /** Next deterministic RFC4122 v4 UUID */
  nextUuid(): string {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(this.nextRandom() * 256);
    }
    // Set version 4 (0100) and variant (10xx)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  /** Next deterministic 26-char Crockford base32 ULID */
  nextUlid(timestampMs = 1786968000000): string {
    const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let time = timestampMs;
    const timeChars: string[] = new Array(10);
    for (let i = 9; i >= 0; i--) {
      timeChars[i] = ENCODING[time % 32];
      time = Math.floor(time / 32);
    }

    const randChars: string[] = new Array(16);
    for (let i = 0; i < 16; i++) {
      randChars[i] = ENCODING[Math.floor(this.nextRandom() * 32)];
    }

    return `${timeChars.join("")}${randChars.join("")}`;
  }

  /** Reset generator to initial seed */
  reset(seed?: number): void {
    this.rngState = seed !== undefined ? seed : this.initialSeed;
    this.counter = 0;
  }
}

// ============================================================================
// 3. In-Memory Virtual FileSystem
// ============================================================================

export interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
}

export type FsWatchCallback = (event: { eventType: "change" | "rename"; path: string }) => void;
export interface DirectoryPresenceMap {
  [dirPath: string]: true | undefined;
}

export class InMemoryFileSystem {
  private files: Record<string, Uint8Array> = {};
  private directories: DirectoryPresenceMap = { "/": true };
  private mtimes: Record<string, number> = {};
  private watchers: Array<{ pattern: string; callback: FsWatchCallback }> = [];

  constructor() {
    this.directories["/"] = true;
  }

  private normalize(path: string): string {
    let clean = path.replace(/\\/g, "/");
    if (!clean.startsWith("/")) clean = `/${clean}`;
    return clean.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  }

  exists(path: string): boolean {
    const norm = this.normalize(path);
    return this.files[norm] !== undefined || this.directories[norm] === true;
  }

  readFile(path: string, encoding?: "utf8"): string | Uint8Array {
    const norm = this.normalize(path);
    const data = this.files[norm];
    if (!data) {
      throw new Error(`ENOENT: no such file at "${path}"`);
    }
    return encoding === "utf8" ? new TextDecoder().decode(data) : data;
  }

  writeFile(path: string, content: string | Uint8Array): void {
    const norm = this.normalize(path);
    const parentDir = norm.substring(0, norm.lastIndexOf("/")) || "/";
    if (!this.directories[parentDir]) {
      this.mkdir(parentDir, { recursive: true });
    }

    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
    this.files[norm] = bytes;
    this.mtimes[norm] = Date.now();

    this.notifyWatchers(norm, "change");
  }

  mkdir(path: string, options: { recursive?: boolean } = {}): void {
    const norm = this.normalize(path);
    if (this.directories[norm]) return;

    const parts = norm.split("/").filter(Boolean);
    let curr = "";
    for (let i = 0; i < parts.length; i++) {
      curr += `/${parts[i]}`;
      if (!this.directories[curr]) {
        if (!options.recursive && i < parts.length - 1) {
          throw new Error(`ENOENT: parent directory does not exist: "${curr}"`);
        }
        this.directories[curr] = true;
      }
    }
  }

  rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): void {
    const norm = this.normalize(path);
    if (this.files[norm] !== undefined) {
      delete this.files[norm];
      delete this.mtimes[norm];
      this.notifyWatchers(norm, "rename");
      return;
    }

    if (this.directories[norm] === true) {
      if (options.recursive) {
        for (const f of Object.keys(this.files)) {
          if (f.startsWith(`${norm}/`)) {
            delete this.files[f];
            delete this.mtimes[f];
          }
        }
        for (const d of Object.keys(this.directories)) {
          if (d.startsWith(`${norm}/`) || d === norm) {
            delete this.directories[d];
          }
        }
      } else {
        delete this.directories[norm];
      }
      return;
    }

    if (!options.force) {
      throw new Error(`ENOENT: file or directory not found: "${path}"`);
    }
  }

  readdir(path: string): string[] {
    const norm = this.normalize(path);
    if (!this.directories[norm]) {
      throw new Error(`ENOTDIR: not a directory: "${path}"`);
    }

    const prefix = norm === "/" ? "/" : `${norm}/`;
    const results = new Set<string>();

    for (const f of Object.keys(this.files)) {
      if (f.startsWith(prefix)) {
        const sub = f.slice(prefix.length);
        const firstSegment = sub.split("/")[0];
        if (firstSegment) results.add(firstSegment);
      }
    }

    for (const d of Object.keys(this.directories)) {
      if (d !== norm && d.startsWith(prefix)) {
        const sub = d.slice(prefix.length);
        const firstSegment = sub.split("/")[0];
        if (firstSegment) results.add(firstSegment);
      }
    }

    return Array.from(results).sort();
  }

  stat(path: string): FileStat {
    const norm = this.normalize(path);
    if (this.files[norm] !== undefined) {
      return {
        size: this.files[norm].length,
        isFile: true,
        isDirectory: false,
        mtimeMs: this.mtimes[norm] || Date.now(),
      };
    }
    if (this.directories[norm] === true) {
      return {
        size: 0,
        isFile: false,
        isDirectory: true,
        mtimeMs: Date.now(),
      };
    }
    throw new Error(`ENOENT: no such file or directory "${path}"`);
  }

  watch(path: string, callback: FsWatchCallback): () => void {
    const norm = this.normalize(path);
    const entry = { pattern: norm, callback };
    this.watchers.push(entry);
    return () => {
      this.watchers = this.watchers.filter((w) => w !== entry);
    };
  }

  private notifyWatchers(path: string, eventType: "change" | "rename"): void {
    for (const watcher of this.watchers) {
      if (path === watcher.pattern || path.startsWith(`${watcher.pattern}/`)) {
        watcher.callback({ eventType, path });
      }
    }
  }

  clear(): void {
    this.files = {};
    this.directories = { "/": true };
    this.mtimes = {};
    this.watchers = [];
  }
}

// ============================================================================
// 4. In-Memory Content-Addressable Artifact Store
// ============================================================================

export type FakeEnvironmentMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FakeEnvironmentMetadataRecord
  | FakeEnvironmentMetadataValue[];

export interface FakeEnvironmentMetadataRecord {
  [key: string]: FakeEnvironmentMetadataValue;
}

export interface ListedArtifact {
  digest: string;
  size: number;
  metadata?: FakeEnvironmentMetadataRecord;
  createdAt: string;
}
export interface StoredArtifact {
  digest: string;
  size: number;
  content: Uint8Array;
  metadata?: FakeEnvironmentMetadataRecord;
  createdAt: string;
}

export class InMemoryArtifactStore {
  private artifacts: Record<string, StoredArtifact> = {};

  async put(
    content: string | Uint8Array,
    metadata?: FakeEnvironmentMetadataRecord,
  ): Promise<{ digest: string; size: number }> {
    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const size = bytes.length;

    this.artifacts[digest] = {
      digest,
      size,
      content: new Uint8Array(bytes),
      metadata,
      createdAt: new Date().toISOString(),
    };

    return { digest, size };
  }

  async get(digest: string): Promise<Uint8Array | null> {
    const item = this.artifacts[digest];
    return item ? item.content : null;
  }

  async getText(digest: string): Promise<string | null> {
    const item = this.artifacts[digest];
    return item ? new TextDecoder().decode(item.content) : null;
  }

  async has(digest: string): Promise<boolean> {
    return this.artifacts[digest] !== undefined;
  }

  async delete(digest: string): Promise<boolean> {
    if (this.artifacts[digest]) {
      delete this.artifacts[digest];
      return true;
    }
    return false;
  }

  async verifyIntegrity(digest: string): Promise<boolean> {
    const item = this.artifacts[digest];
    if (!item) return false;
    const actualDigest = createHash("sha256").update(item.content).digest("hex");
    return actualDigest === digest;
  }

  async list(): Promise<ListedArtifact[]> {
    return Object.values(this.artifacts).map((a) => ({
      digest: a.digest,
      size: a.size,
      metadata: a.metadata,
      createdAt: a.createdAt,
    }));
  }

  async clear(): Promise<void> {
    this.artifacts = {};
  }
}

// ============================================================================
// 5. Fake Control Stream
// ============================================================================

export type StreamMessageHandler<T = unknown> = (message: StreamMessage<T>) => void;

export class FakeControlStream {
  private sequence = 0;
  private connected = true;
  private messageHistory: StreamMessage<unknown>[] = [];
  private listeners: StreamMessageHandler<unknown>[] = [];
  public dropRate = 0;

  constructor() {
    this.reset();
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.connected = false;
  }

  reconnect(): void {
    this.connected = true;
  }

  onMessage(listener: StreamMessageHandler<unknown>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  send<T = unknown>(payload: T): StreamMessage<T> {
    if (!this.connected) {
      throw new Error("Cannot send on disconnected FakeControlStream");
    }

    this.sequence++;
    const message: StreamMessage<T> = {
      messageId: `msg-${String(this.sequence).padStart(6, "0")}`,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      payload,
    };

    if (this.dropRate > 0 && Math.random() < this.dropRate) {
      // Simulate dropped packet
      return message;
    }

    // SAFETY: Stream message with generic payload is recorded in history.
    this.messageHistory.push(message as StreamMessage<unknown>);

    for (const listener of this.listeners) {
      // SAFETY: Stream message with generic payload is broadcast to stream listeners.
      listener(message as StreamMessage<unknown>);
    }

    return message;
  }

  getHistory(): StreamMessage<unknown>[] {
    return [...this.messageHistory];
  }

  reset(): void {
    this.sequence = 0;
    this.connected = true;
    this.messageHistory = [];
    this.listeners = [];
    this.dropRate = 0;
  }
}

// ============================================================================
// 6. Fake Transcript Source
// ============================================================================

export class FakeTranscriptSource {
  private events: NormalizedSessionEvent[];
  private currentIndex = 0;

  constructor(customEvents?: NormalizedSessionEvent[]) {
    this.events = customEvents ? [...customEvents] : [...allValidDomainEvents];
  }

  hasNext(): boolean {
    return this.currentIndex < this.events.length;
  }

  next(): NormalizedSessionEvent | null {
    if (!this.hasNext()) return null;
    const evt = this.events[this.currentIndex];
    this.currentIndex++;
    return evt;
  }

  nextBatch(batchSize: number): NormalizedSessionEvent[] {
    const batch: NormalizedSessionEvent[] = [];
    for (let i = 0; i < batchSize && this.hasNext(); i++) {
      const evt = this.next();
      if (evt) batch.push(evt);
    }
    return batch;
  }

  reset(): void {
    this.currentIndex = 0;
  }

  seek(index: number): void {
    this.currentIndex = Math.max(0, Math.min(index, this.events.length));
  }

  getAllEvents(): NormalizedSessionEvent[] {
    return [...this.events];
  }
}

// ============================================================================
// 7. Deterministic Environment Factory
// ============================================================================

export interface DeterministicEnvironment {
  clock: FakeClock;
  idGen: DeterministicIdGenerator;
  fs: InMemoryFileSystem;
  artifactStore: InMemoryArtifactStore;
  controlStream: FakeControlStream;
  transcriptSource: FakeTranscriptSource;
  reset(): void;
}

export function createDeterministicEnvironment(
  options: {
    initialTime?: string | number | Date;
    seed?: number;
    events?: NormalizedSessionEvent[];
  } = {},
): DeterministicEnvironment {
  const clock = new FakeClock(options.initialTime);
  const idGen = new DeterministicIdGenerator(options.seed);
  const fs = new InMemoryFileSystem();
  const artifactStore = new InMemoryArtifactStore();
  const controlStream = new FakeControlStream();
  const transcriptSource = new FakeTranscriptSource(options.events);

  return {
    clock,
    idGen,
    fs,
    artifactStore,
    controlStream,
    transcriptSource,
    reset(): void {
      clock.reset();
      idGen.reset();
      fs.clear();
      artifactStore.clear();
      controlStream.reset();
      transcriptSource.reset();
    },
  };
}
