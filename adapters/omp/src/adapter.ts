import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  type AdapterCapabilities,
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  type CatalogChangeSummary,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  type HarnessInstallation,
  type HarnessSession,
  type HarnessWorkspace,
  type ProbeInstallationOptions,
  type RefreshResult,
  type SessionEventSource,
  type SourceCursor,
  type StrictHarnessAdapter,
  TIER1_HIGH_FIDELITY,
} from "@resin/harness-contracts";
import {
  applyOmpMcpConfig,
  planOmpMcpConfig,
  rollbackOmpMcpConfig,
  verifyOmpMcpConfig,
} from "./config-planner.js";
import {
  type OmpDiscoveryCatalog,
  type OmpDiscoveryOptions,
  type ParsedTranscript,
  buildOmpDiscoveryCatalog,
  discoverOmpSessions,
  discoverOmpWorkspaces,
  inspectTranscriptFile,
  probeOmpInstallation,
} from "./discovery.js";
import { getOmpRefreshCapability, handleOmpCatalogRefresh } from "./refresh.js";
import { OmpSessionEventSource } from "./source.js";

/**
 * Harness adapter for Oh My Pi (OMP) agent harness.
 * Implements high-fidelity observation, session tailing, MCP configuration, and catalog refresh.
 */
export interface OmpHarnessAdapterOptions {
  fsBridge?: ConfigFsBridge;
  discoveryOptions?: OmpDiscoveryOptions;
  customHome?: string;
  ompHome?: string;
  searchPaths?: string[];
  customExecutablePath?: string;
  customConfigPath?: string;
  checkPermissions?: boolean;
  now?: number | Date;
  activeOnly?: boolean;
  onInspectTranscript?: (filePath: string) => void;
}

interface TranscriptFileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface TranscriptInspectionCacheEntry {
  identity: TranscriptFileIdentity;
  transcript: ParsedTranscript;
}

// Matches inspectTranscriptFile's stale-to-idle threshold.
const TRANSCRIPT_STATUS_SETTLE_MS = 60_000;

async function getTranscriptFileIdentity(filePath: string): Promise<TranscriptFileIdentity | null> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs || stat.mtime.getTime(),
      ctimeMs: stat.ctimeMs || stat.ctime.getTime(),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch {
    return null;
  }
}

function sameTranscriptIdentity(
  left: TranscriptFileIdentity,
  right: TranscriptFileIdentity,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function refreshCachedCanonicalPaths(
  transcript: ParsedTranscript,
): Promise<ParsedTranscript> {
  const canonicalPath = await fsp
    .realpath(transcript.filePath)
    .catch(() => path.resolve(transcript.filePath));
  const headerCwd = transcript.headerCwd;
  const canonicalCwd = headerCwd
    ? await fsp.realpath(headerCwd).catch(() => path.resolve(headerCwd))
    : null;
  return { ...transcript, canonicalPath, canonicalCwd };
}

export class OmpHarnessAdapter implements StrictHarnessAdapter {
  readonly id = "omp";
  readonly name = "omp";
  readonly version = "0.1.0";
  readonly supportedHarnessVersions: readonly string[] = ["^0.1.0", ">=0.1.0", ">=0.0.1", "*"];

  private readonly fsBridge?: ConfigFsBridge;
  private discoveryOptions?: OmpDiscoveryOptions;
  private cachedCatalog?: OmpDiscoveryCatalog;
  private readonly transcriptCache = new Map<string, TranscriptInspectionCacheEntry>();
  private workspaceListInFlight?: Promise<HarnessWorkspace[]>;
  constructor(options?: OmpHarnessAdapterOptions & OmpDiscoveryOptions) {
    this.fsBridge = options?.fsBridge;
    this.discoveryOptions = {
      activeOnly: true,
      ...options?.discoveryOptions,
      ...options,
    };
  }

  get catalog(): OmpDiscoveryCatalog | undefined {
    return this.cachedCatalog;
  }

  get inspectedFilePaths(): readonly string[] {
    return this.cachedCatalog?.inspectedFilePaths ?? [];
  }
  /**
   * Probes the system for an OMP installation and checks its readiness.
   */
  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    if (options) {
      this.discoveryOptions = { ...this.discoveryOptions, ...options };
    }
    return probeOmpInstallation({ ...this.discoveryOptions, ...options });
  }

  /**
   * Discovers registered and active OMP workspaces.
   * Scans OMP home once per refresh cycle and caches the catalog.
   */
  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    if (this.workspaceListInFlight) return this.workspaceListInFlight;

    const scan = this.refreshWorkspaceCatalog();
    this.workspaceListInFlight = scan;
    try {
      return await scan;
    } finally {
      if (this.workspaceListInFlight === scan) this.workspaceListInFlight = undefined;
    }
  }

  private async refreshWorkspaceCatalog(): Promise<HarnessWorkspace[]> {
    const discoveryOptions = this.discoveryOptions;
    if (
      discoveryOptions?.activeOnly !== false ||
      discoveryOptions.inspectTranscript ||
      discoveryOptions.onInspectTranscript
    ) {
      const catalog = await buildOmpDiscoveryCatalog(discoveryOptions);
      this.transcriptCache.clear();
      this.cachedCatalog = catalog;
      return catalog.workspaces;
    }

    const cycleCache = new Map<string, TranscriptInspectionCacheEntry>();
    const pathsWithFutureTerminalMessages = new Set<string>();
    const noteFutureTerminalMessage = (filePath: string): void => {
      pathsWithFutureTerminalMessages.add(filePath);
    };
    const catalog = await buildOmpDiscoveryCatalog({
      ...discoveryOptions,
      inspectTranscript: async (filePath, options) => {
        const before = await getTranscriptFileIdentity(filePath);
        const nowMs =
          options?.now instanceof Date
            ? options.now.getTime()
            : typeof options?.now === "number"
              ? options.now
              : Date.now();
        const ageMs = before ? nowMs - before.mtimeMs : Number.NEGATIVE_INFINITY;
        const historical = before !== null && ageMs > TRANSCRIPT_STATUS_SETTLE_MS;
        const cached = this.transcriptCache.get(filePath);

        if (before && historical && cached && sameTranscriptIdentity(before, cached.identity)) {
          const transcript = await refreshCachedCanonicalPaths(cached.transcript);
          cycleCache.set(filePath, { identity: before, transcript });
          return transcript;
        }

        const transcript = await inspectTranscriptFile(filePath, {
          ...options,
          onFutureTerminalMessage: noteFutureTerminalMessage,
        });
        if (
          !before ||
          !historical ||
          !transcript ||
          transcript.status === "active" ||
          pathsWithFutureTerminalMessages.has(filePath)
        ) {
          return transcript;
        }

        const after = await getTranscriptFileIdentity(filePath);
        if (after && sameTranscriptIdentity(before, after)) {
          cycleCache.set(filePath, { identity: after, transcript });
        }
        return transcript;
      },
    });

    this.transcriptCache.clear();
    for (const [filePath, entry] of cycleCache) this.transcriptCache.set(filePath, entry);
    this.cachedCatalog = catalog;
    return catalog.workspaces;
  }
  /**
   * Convenience alias for listWorkspaces.
   */
  async discoverWorkspaces(): Promise<HarnessWorkspace[]> {
    return this.listWorkspaces();
  }

  /**
   * Discovers sessions and JSONL transcripts within a given OMP workspace.
   */
  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    if (!this.cachedCatalog) {
      this.cachedCatalog = await buildOmpDiscoveryCatalog(this.discoveryOptions);
    }
    return this.cachedCatalog.getSessionsForWorkspace(workspace);
  }

  /**
   * Convenience alias for listSessions.
   */
  async discoverSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    return this.listSessions(workspace);
  }

  /**
   * Resolves the currently active session for a workspace, if any.
   */
  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = await this.listSessions(workspace);
    const active = sessions.find((s) => s.status === "active");
    return active ?? (sessions.length > 0 ? sessions[0] : null);
  }

  /**
   * Creates an event source that tails the append-only JSONL session file.
   */
  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return new OmpSessionEventSource(session, cursor);
  }

  /**
   * Convenience alias for openEventSource.
   */
  async createEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return this.openEventSource(session, cursor);
  }

  /**
   * Proposes an atomic MCP configuration mutation to wire the Resin Gateway.
   */
  async planMcpConfig(
    workspace: HarnessWorkspace,
    gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    return planOmpMcpConfig({
      workspace,
      gatewayUrl,
      fsBridge: this.fsBridge,
      command: CANONICAL_RESIN_MCP_COMMAND,
      args: [...CANONICAL_RESIN_MCP_ARGS],
    });
  }

  /**
   * Atomically applies the MCP mutation plan with backup preservation.
   */
  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyOmpMcpConfig(plan, this.fsBridge);
  }

  /**
   * Verifies that the workspace or global OMP config is properly connected to Gateway.
   */
  async verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    return verifyOmpMcpConfig({ workspace, fsBridge: this.fsBridge });
  }

  /**
   * Reverts a previously applied configuration mutation.
   */
  async rollbackMcpConfig(backup: ConfigBackup): Promise<void> {
    return rollbackOmpMcpConfig(backup, this.fsBridge);
  }

  /**
   * Notifies OMP of tool catalog updates via native list change or context nudge.
   */
  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    this.cachedCatalog = undefined;
    return handleOmpCatalogRefresh(workspace, changeSummary);
  }

  /**
   * Returns complete capability profile for Oh My Pi adapter.
   */
  getCapabilities(): AdapterCapabilities {
    return {
      refresh: getOmpRefreshCapability(),
      fidelity: TIER1_HIGH_FIDELITY,
      supportedTransports: ["stdio", "sse", "websocket", "http"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: {
        streaming: true,
        subagents: true,
        compaction: true,
        branching: true,
        commandExec: true,
        fileEdits: true,
      },
    };
  }
}

/**
 * Backward compatibility alias.
 */
export const OmpAdapter = OmpHarnessAdapter;
