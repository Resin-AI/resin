import fs from "node:fs";
import path from "node:path";
import { LocalDatabaseConnection } from "@resin/db";
import type {
  DaemonModule,
  DaemonModuleProviderContext,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "@resin/observer";
import { ArtifactCache } from "@resin/runtime";

export const STORED_TOOL_GC_MODULE_ID = "stored-tool-gc";
/** How long a stored tool must stay unnamed by the catalog and every lock before it is removed. */
export const ORPHANED_STORED_TOOL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Per digest, when a pass first found the stored tool orphaned. */
export const ORPHANED_STORED_TOOLS_FILE_NAME = "stored-tool-orphans.json";
const DEFAULT_INITIAL_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DIGEST = /^[0-9a-f]{64}$/;

/** What still names stored tools: tool IDs and artifact digests. */
export interface StoredToolNames {
  toolIds: ReadonlySet<string>;
  artifactDigests: ReadonlySet<string>;
}

/**
 * Tool IDs every retained catalog snapshot in `<dataDir>/state.db` serves, across workspaces.
 * Undefined when no snapshot can be read or none lists a tool: an unknown catalog never makes a
 * stored tool look unserved.
 */
export function readServedToolIds(dataDir: string): ReadonlySet<string> | undefined {
  const stateDbPath = path.join(dataDir, "state.db");
  if (!fs.existsSync(stateDbPath)) return undefined;
  const conn = new LocalDatabaseConnection({ path: stateDbPath, readOnly: true }).open();
  try {
    const toolIds = new Set<string>();
    for (const row of conn.all<{ tools_json: string }>(
      "SELECT tools_json FROM catalog_snapshots",
    )) {
      const tools: unknown = JSON.parse(row.tools_json);
      if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
        throw new Error("A catalog snapshot's tools are not an object");
      }
      for (const toolId of Object.keys(tools)) toolIds.add(toolId);
    }
    return toolIds.size === 0 ? undefined : toolIds;
  } finally {
    conn.close();
  }
}

/**
 * Tool IDs and artifact digests pinned by every project lock this device synced managed tools into
 * (the locks its managed-tool-access receipts name). A lock that no longer exists pins nothing; a
 * receipt or lock that cannot be read throws, so the pass removes nothing.
 */
export function readPinnedStoredTools(stateDir: string): StoredToolNames {
  const receiptsDir = path.join(stateDir, "managed-tool-access", "tools");
  const lockPaths = new Set<string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(receiptsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const receipt: unknown = JSON.parse(fs.readFileSync(path.join(receiptsDir, name), "utf8"));
    const lockPath = (receipt as { lockPath?: unknown } | null)?.lockPath;
    if (typeof lockPath === "string") lockPaths.add(lockPath);
  }
  const toolIds = new Set<string>();
  const artifactDigests = new Set<string>();
  for (const lockPath of lockPaths) {
    let text: string;
    try {
      text = fs.readFileSync(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const tools = (JSON.parse(text) as { tools?: unknown } | null)?.tools;
    if (typeof tools !== "object" || tools === null) continue;
    for (const entry of Object.values(tools)) {
      const { toolId, artifactDigest } = (entry ?? {}) as Record<string, unknown>;
      if (typeof toolId === "string") toolIds.add(toolId);
      if (typeof artifactDigest === "string") artifactDigests.add(artifactDigest.toLowerCase());
    }
  }
  return { toolIds, artifactDigests };
}

export interface OrphanedStoredToolSweepResult {
  /** Stored tool digests examined. */
  examined: number;
  /** Digests nothing names any more, including those removed by this pass. */
  orphaned: number;
  removed: number;
}

/**
 * Removes stored tools (artifact directories under the artifact cache) that neither the served
 * catalog nor any known project lock has named for `graceMs`. Each orphan's first sighting is kept
 * in `ledgerPath`; a stored tool named again leaves the ledger. A reference without a tool ID or
 * version, or of any kind but `active`, keeps its tool. Removal goes through the cache's
 * owned-reference release, so bytes go only once their last reference does.
 */
export async function sweepOrphanedStoredTools(options: {
  cache: ArtifactCache;
  served: ReadonlySet<string>;
  pinned: StoredToolNames;
  ledgerPath: string;
  now?: number;
  graceMs?: number;
}): Promise<OrphanedStoredToolSweepResult> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? ORPHANED_STORED_TOOL_GRACE_MS;
  const references = await options.cache.getAllReferences();
  let ledger: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(options.ledgerPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      ledger = parsed as Record<string, number>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const result: OrphanedStoredToolSweepResult = { examined: 0, orphaned: 0, removed: 0 };
  const nextLedger: Record<string, number> = {};
  for (const digest of Object.keys(references)) {
    if (!DIGEST.test(digest)) continue;
    result.examined++;
    const refs = references[digest] ?? [];
    const named =
      refs.length === 0 ||
      options.pinned.artifactDigests.has(digest) ||
      refs.some(
        (ref) =>
          ref.toolId === undefined ||
          ref.version === undefined ||
          (ref.refType ?? "active") !== "active" ||
          options.served.has(ref.toolId) ||
          options.pinned.toolIds.has(ref.toolId),
      );
    if (named) continue;
    result.orphaned++;
    const firstSeen = typeof ledger[digest] === "number" ? ledger[digest] : now;
    if (now - firstSeen < graceMs) {
      nextLedger[digest] = firstSeen;
      continue;
    }
    for (const ref of refs) {
      // `named` above proved every reference carries both.
      await options.cache.removeOwnedArtifactReference(
        digest,
        ref.refId,
        ref.toolId as string,
        ref.version as string,
      );
    }
    result.removed++;
  }

  const temporary = `${options.ledgerPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(options.ledgerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(nextLedger), { mode: 0o600 });
  fs.renameSync(temporary, options.ledgerPath);
  return result;
}

export interface StoredToolGcModuleOptions {
  dataDir: string;
  stateDir: string;
  cache?: ArtifactCache;
  logger?: DaemonModuleProviderContext["logger"];
  initialDelayMs?: number;
  intervalMs?: number;
  graceMs?: number;
}

/**
 * Periodically removes stored tools nothing serves or pins any more (see
 * `sweepOrphanedStoredTools`). A stored tool keeps every private value its workflow names alive,
 * so one left behind by a deleted project or a retired tool pinned them forever. A pass that cannot
 * read the catalog or a lock removes nothing.
 */
export class StoredToolGcModule implements DaemonModule {
  readonly id = STORED_TOOL_GC_MODULE_ID;
  readonly name = "Stored Tool Cleanup";
  readonly critical = false;

  private state: ModuleLifecycleState = "uninitialized";
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<OrphanedStoredToolSweepResult | undefined> | undefined;
  private lastError: string | null = null;
  private readonly cache: ArtifactCache;

  constructor(private readonly options: StoredToolGcModuleOptions) {
    this.cache =
      options.cache ?? new ArtifactCache({ cacheDir: path.join(options.dataDir, "artifacts") });
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(_context: ModuleContext): Promise<void> {
    this.state = "starting";
    this.schedule(this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    this.state = "ready";
  }

  async stop(_context: ModuleContext): Promise<void> {
    this.state = "stopping";
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    this.state = "stopped";
  }

  /** Runs one pass now, or joins the one in progress. Undefined when the pass was skipped. */
  runOnce(): Promise<OrphanedStoredToolSweepResult | undefined> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async healthCheck(): Promise<ModuleHealth> {
    return this.lastError === null
      ? { status: "ready", lastCheckTime: Date.now() }
      : { status: "degraded", message: this.lastError, lastCheckTime: Date.now() };
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        if (this.state === "ready") this.schedule(this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async pass(): Promise<OrphanedStoredToolSweepResult | undefined> {
    try {
      const served = readServedToolIds(this.options.dataDir);
      if (served === undefined) {
        this.lastError = null;
        return undefined;
      }
      const result = await sweepOrphanedStoredTools({
        cache: this.cache,
        served,
        pinned: readPinnedStoredTools(this.options.stateDir),
        ledgerPath: path.join(this.options.stateDir, ORPHANED_STORED_TOOLS_FILE_NAME),
        ...(this.options.graceMs === undefined ? {} : { graceMs: this.options.graceMs }),
      });
      this.lastError = null;
      if (result.removed > 0) {
        this.options.logger?.info("Removed stored tools nothing serves or pins", {
          examined: result.examined,
          orphaned: result.orphaned,
          removed: result.removed,
        });
      }
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn("Stored tool cleanup pass skipped", { reason: this.lastError });
      return undefined;
    }
  }
}

/** The daemon's stored-tool cleanup for an enrolled device. */
export function createStoredToolGcDaemonModule(
  context: DaemonModuleProviderContext,
): StoredToolGcModule {
  return new StoredToolGcModule({
    dataDir: context.paths.dataDir,
    stateDir: context.paths.stateDir,
    logger: context.logger,
  });
}
