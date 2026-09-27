import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AdapterCapabilities,
  CatalogChangeSummary,
  ConfigBackup,
  ConfigFsBridge,
  ConfigMutationPlan,
  HarnessAdapter,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  RefreshResult,
  SessionEventSource,
  SessionStatus,
  SourceCursor,
} from "@resin/harness-contracts";
import {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  applyConfigMutation,
  createObservationFidelity,
  createRefreshResult,
  defaultFsBridge,
  determineRefreshOutcome,
} from "@resin/harness-contracts";
import { planGrokMcpConfig, verifyGrokMcpConfig } from "./config-planner.js";
import { GROK_TESTED_VERSIONS, probeGrokInstallation } from "./discovery.js";
import {
  GROK_HARNESS_ID,
  resolveGrokConfigPath,
  resolveGrokHome,
  resolveGrokSessionsDir,
} from "./paths.js";
import { GrokSessionEventSource } from "./source.js";
import {
  type GrokSessionEntry,
  computeGrokForkPrefixOffset,
  isGrokTurnOpen,
  listGrokProjects,
  listGrokSessions,
  readGrokSubagentParents,
} from "./store.js";

export const GROK_ADAPTER_CAPABILITIES: AdapterCapabilities = {
  refresh: {
    supportsNativeListChange: true,
    supportsContextNudge: false,
    requiresSessionRestart: false,
    description:
      "Grok re-lists an MCP server's tools when it pushes notifications/tools/list_changed; its search_tool/use_tool meta-tools see the refreshed catalog in the running session.",
  },
  fidelity: createObservationFidelity({
    transcriptAvailability: "file_tail",
    toolCallVisibility: "full",
    toolResultVisibility: "full",
    subagentVisibility: "full",
    mcpListChange: "supported",
    contextNudge: "unsupported",
    notes:
      "Tails the append-only updates.jsonl each Grok session (TUI, headless, ACP) writes; subagents are separate linked sessions.",
  }),
  supportedTransports: ["stdio", "http", "sse"],
  supportsMultiWorkspace: true,
  supportsConcurrentSessions: true,
  features: { forks: true, rewind: true, subagents: true, compaction: true },
};

export interface GrokHarnessAdapterOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  fsBridge?: ConfigFsBridge;
  /** Only report running sessions (see `listSessions`). */
  activeOnly?: boolean;
  pollIntervalMs?: number;
}

function workspaceIdFor(cwd: string): string {
  return `ws_grok_${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`;
}

/**
 * How long an unfinished prompt with no new `updates.jsonl` writes still counts as running. A
 * killed headless run never writes `turn_completed`; past this it is reported completed.
 */
const GROK_OPEN_TURN_FRESH_MS = 30 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class GrokHarnessAdapter implements HarnessAdapter {
  readonly id = GROK_HARNESS_ID;
  readonly name = "Grok Build";
  readonly version = "0.1.0";
  readonly supportedHarnessVersions = GROK_TESTED_VERSIONS;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fsBridge: ConfigFsBridge;
  private readonly activeOnly: boolean;
  private readonly pollIntervalMs?: number;
  private readonly entries = new Map<string, GrokSessionEntry>();

  constructor(options: GrokHarnessAdapterOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.env = options.env ?? process.env;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.activeOnly = options.activeOnly ?? false;
    this.pollIntervalMs = options.pollIntervalMs;
  }

  probeInstallation(): Promise<HarnessInstallation | null> {
    return probeGrokInstallation({
      home: this.home,
      env: this.env,
      configPath: resolveGrokConfigPath(this.home, this.env),
    });
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const configPath = resolveGrokConfigPath(this.home, this.env);
    const projects = await listGrokProjects(resolveGrokSessionsDir(this.home, this.env));
    return projects.map(({ cwd, dir }) => ({
      workspaceId: workspaceIdFor(cwd),
      rootPath: cwd,
      name: path.basename(cwd) || cwd,
      harnessId: GROK_HARNESS_ID,
      configPath,
      mcpConfigPath: configPath,
      metadata: { sessionsDir: dir },
    }));
  }

  private async activeSessionIds(): Promise<Set<string>> {
    const active = new Set<string>();
    try {
      const file = path.join(resolveGrokHome(this.home, this.env), "active_sessions.json");
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      for (const item of Array.isArray(parsed) ? parsed : []) {
        const entry = item as { session_id?: unknown; pid?: unknown };
        if (typeof entry.session_id === "string" && typeof entry.pid === "number") {
          if (isPidAlive(entry.pid)) active.add(entry.session_id);
        }
      }
    } catch {
      // No registry: no session is known to be running.
    }
    return active;
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const sessionsDir = workspace.metadata.sessionsDir;
    if (typeof sessionsDir !== "string") return [];
    const entries = await listGrokSessions(sessionsDir, workspace.rootPath);
    const [active, subagentParents] = await Promise.all([
      this.activeSessionIds(),
      readGrokSubagentParents(entries),
    ]);
    const sessions: HarnessSession[] = [];
    for (const entry of entries) {
      // A headless `grok -p` run need not appear in `active_sessions.json`; it is still running
      // while its last prompt has no `turn_completed` yet.
      const isActive =
        active.has(entry.sessionId) ||
        (Date.now() - entry.updatesMtime.getTime() < GROK_OPEN_TURN_FRESH_MS &&
          (await isGrokTurnOpen(entry.updatesPath)));
      if (this.activeOnly && !isActive) continue;
      this.entries.set(entry.sessionId, entry);
      const summary = entry.summary;
      const updatedAt = entry.updatesMtime.toISOString();
      const status: SessionStatus = isActive ? "active" : "completed";
      const subagentParent = subagentParents.get(entry.sessionId);
      sessions.push({
        sessionId: entry.sessionId,
        workspaceId: workspace.workspaceId,
        harnessId: GROK_HARNESS_ID,
        transcriptPath: entry.updatesPath,
        status,
        createdAt: summary?.createdAt ?? updatedAt,
        updatedAt,
        metadata: {
          fileMtime: updatedAt,
          cwd: entry.cwd,
          sessionDir: entry.sessionDir,
          // Subagent children are captured as their own agent sessions linked to the parent.
          sessionKind: summary?.sessionKind === "subagent" ? "agent" : "user",
          grokSessionKind: summary?.sessionKind ?? null,
          ...(subagentParent ? { parentSessionId: subagentParent } : {}),
          ...(summary?.parentSessionId ? { forkedFromSessionId: summary.parentSessionId } : {}),
          ...(summary?.modelId ? { model: summary.modelId } : {}),
        },
      });
    }
    return sessions;
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = (await this.listSessions(workspace)).filter((s) => s.status === "active");
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    const entry = this.entries.get(session.sessionId);
    const parentId = entry?.summary?.parentSessionId;
    let startOffset = 0;
    if (entry && parentId) {
      // Forks share the parent's cwd directory; a worktree fork lives under another cwd.
      const siblings = path.join(path.dirname(entry.sessionDir), parentId, "updates.jsonl");
      startOffset = await computeGrokForkPrefixOffset(entry.updatesPath, siblings);
      if (startOffset === 0) {
        for (const other of this.entries.values()) {
          if (other.sessionId !== parentId) continue;
          startOffset = await computeGrokForkPrefixOffset(entry.updatesPath, other.updatesPath);
        }
      }
    }
    return new GrokSessionEventSource({
      filePath: session.transcriptPath,
      sessionId: session.sessionId,
      startOffset,
      ...(parentId ? { forkParentSessionId: parentId } : {}),
      ...(cursor ? { initialCursor: cursor } : {}),
      ...(this.pollIntervalMs !== undefined ? { pollIntervalMs: this.pollIntervalMs } : {}),
    });
  }

  planMcpConfig(workspace: HarnessWorkspace): Promise<ConfigMutationPlan> {
    return planGrokMcpConfig({
      targetPath: workspace.mcpConfigPath ?? workspace.configPath,
      command: CANONICAL_RESIN_MCP_COMMAND,
      args: CANONICAL_RESIN_MCP_ARGS,
      fsBridge: this.fsBridge,
    });
  }

  applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyConfigMutation(plan, this.fsBridge);
  }

  verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    return verifyGrokMcpConfig({
      targetPath: workspace.mcpConfigPath ?? workspace.configPath,
      command: CANONICAL_RESIN_MCP_COMMAND,
      fsBridge: this.fsBridge,
    });
  }

  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    const outcome = determineRefreshOutcome(GROK_ADAPTER_CAPABILITIES.refresh);
    const affected =
      changeSummary.addedToolIds.length +
      changeSummary.updatedToolIds.length +
      changeSummary.removedToolIds.length;
    return createRefreshResult(outcome, {
      catalogVersion: changeSummary.catalogVersion,
      affectedToolCount: affected,
      message: `Resin gateway pushes tools/list_changed; Grok sessions in ${workspace.rootPath} re-list its tools.`,
      requiresRestart: false,
    });
  }

  getCapabilities(): AdapterCapabilities {
    return GROK_ADAPTER_CAPABILITIES;
  }
}
