import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AdapterCapabilities,
  CatalogChangeSummary,
  ConfigBackup,
  ConfigFsBridge,
  ConfigMutationPlan,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  ProbeInstallationOptions,
  RefreshResult,
  SessionEventSource,
  SourceCursor,
  StrictHarnessAdapter,
} from "@resin/harness-contracts";
import {
  TIER2_MEDIUM_FIDELITY,
  applyConfigMutation,
  createRefreshResult,
  defaultFsBridge,
} from "@resin/harness-contracts";
import { planOpencodeMcpConfig, verifyOpencodeMcpConfig } from "./config-planner.js";
import {
  OPENCODE_TESTED_VERSIONS,
  type OpencodeExecFunction,
  probeOpencodeInstallation,
} from "./discovery.js";
import {
  resolveOpencodeDbPath,
  resolveOpencodeLegacyStorageDir,
  resolveOpencodeMcpConfigPath,
} from "./paths.js";
import { OPENCODE_HARNESS_ID, OpencodeSessionEventSource } from "./source.js";
import { type OpencodeSessionInfo, type OpencodeStore, openOpencodeStore } from "./store.js";

/** Sessions updated this recently count as active for initial attachment. */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export interface OpencodeHarnessAdapterOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides store discovery (tests, or a store at a custom location). */
  store?: OpencodeStore;
  fsBridge?: ConfigFsBridge;
  exec?: OpencodeExecFunction;
  pollingIntervalMs?: number;
  now?: () => number;
}

export function opencodeWorkspaceId(directory: string): string {
  return `opencode-${createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)}`;
}

/** Harness adapter for OpenCode (sst/opencode), reading its SQLite store or legacy JSON tree. */
export class OpencodeHarnessAdapter implements StrictHarnessAdapter {
  readonly id = OPENCODE_HARNESS_ID;
  readonly name = "OpenCode";
  readonly version = "0.1.0";
  readonly supportedHarnessVersions = [...OPENCODE_TESTED_VERSIONS];

  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fsBridge: ConfigFsBridge;
  private readonly now: () => number;

  constructor(private readonly options: OpencodeHarnessAdapterOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.env = options.env ?? process.env;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.now = options.now ?? Date.now;
  }

  /** The store OpenCode currently uses, re-resolved so a store created later is found. */
  store(): OpencodeStore | null {
    return (
      this.options.store ??
      openOpencodeStore({
        dbPath: resolveOpencodeDbPath(this.home, this.env),
        legacyStorageDir: resolveOpencodeLegacyStorageDir(this.home, this.env),
      })
    );
  }

  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    return await probeOpencodeInstallation({
      home: this.home,
      env: options?.env ?? this.env,
      configPath: options?.customConfigPath,
      executablePath: options?.customExecutablePath ?? options?.executablePath,
      exec: this.options.exec,
    });
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const store = this.store();
    if (!store) return [];
    const byDirectory = new Map<string, OpencodeSessionInfo[]>();
    for (const session of store.listSessions()) {
      if (!session.directory) continue;
      const list = byDirectory.get(session.directory) ?? [];
      list.push(session);
      byDirectory.set(session.directory, list);
    }
    const configPath = resolveOpencodeMcpConfigPath(this.home, this.env);
    return [...byDirectory.entries()].map(([directory, sessions]) => ({
      workspaceId: opencodeWorkspaceId(directory),
      rootPath: directory,
      name: path.basename(directory) || directory,
      harnessId: this.id,
      configPath,
      mcpConfigPath: configPath,
      metadata: { store: store.kind, sessionCount: sessions.length },
    }));
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const store = this.store();
    if (!store) return [];
    const root = path.resolve(workspace.rootPath);
    return store
      .listSessions()
      .filter((session) => session.directory && path.resolve(session.directory) === root)
      .map((session) => {
        const updated = session.time?.updated ?? session.time?.created ?? 0;
        const active =
          session.time?.archived === undefined && this.now() - updated < ACTIVE_WINDOW_MS;
        return {
          sessionId: session.id,
          workspaceId: workspace.workspaceId,
          harnessId: this.id,
          transcriptPath: store.location,
          // Quiet sessions are idle, not completed: OpenCode sessions can be resumed.
          status: active ? "active" : "idle",
          createdAt: new Date(session.time?.created ?? 0).toISOString(),
          updatedAt: new Date(updated).toISOString(),
          metadata: {
            store: store.kind,
            title: session.title,
            harnessVersion: session.version,
            parentSessionId: session.parentID,
          },
        } satisfies HarnessSession;
      });
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const active = (await this.listSessions(workspace)).filter(
      (session) => session.status === "active" && !session.metadata.parentSessionId,
    );
    return active.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    const store = this.store();
    if (!store) {
      throw new Error(`No OpenCode store found for session ${session.sessionId}`);
    }
    return new OpencodeSessionEventSource(store, session, cursor, {
      pollingIntervalMs: this.options.pollingIntervalMs,
    });
  }

  async planMcpConfig(
    _workspace: HarnessWorkspace,
    _gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    return await planOpencodeMcpConfig({
      targetPath: resolveOpencodeMcpConfigPath(this.home, this.env),
      fsBridge: this.fsBridge,
    });
  }

  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return await applyConfigMutation(plan, this.fsBridge);
  }

  async verifyMcpConfig(_workspace: HarnessWorkspace): Promise<boolean> {
    return await verifyOpencodeMcpConfig({
      targetPath: resolveOpencodeMcpConfigPath(this.home, this.env),
      fsBridge: this.fsBridge,
    });
  }

  async notifyCatalogRefresh(
    _workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    return createRefreshResult("next_session_required", {
      message:
        "OpenCode lists MCP tools when a session connects; updated Resin tools appear in the next OpenCode session.",
      catalogVersion: changeSummary.catalogVersion,
      appliedAt: changeSummary.timestamp,
      affectedToolCount:
        changeSummary.addedToolIds.length +
        changeSummary.updatedToolIds.length +
        changeSummary.removedToolIds.length,
    });
  }

  getCapabilities(): AdapterCapabilities {
    return {
      refresh: {
        supportsNativeListChange: false,
        supportsContextNudge: false,
        requiresSessionRestart: true,
        description:
          "Not verified to reload MCP tool lists mid-session; new sessions pick up changes.",
      },
      fidelity: {
        ...TIER2_MEDIUM_FIDELITY,
        transcriptAvailability: "polling",
        toolCallVisibility: "full",
        toolResultVisibility: "full",
        subagentVisibility: "full",
        mcpListChange: "requires_restart",
        contextNudge: "via_file",
      },
      supportedTransports: ["stdio", "http"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: { sqliteStore: true, legacyJsonStore: true, subagentSessions: true },
    };
  }
}
