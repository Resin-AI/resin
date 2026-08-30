import { randomUUID } from "node:crypto";
import {
  type AdapterCapabilities,
  AmbiguousActiveSessionError,
  type CatalogChangeSummary,
  CatalogRefreshError,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  type HarnessAdapter,
  type HarnessInstallation,
  HarnessPermissionError,
  type HarnessSession,
  type HarnessWorkspace,
  InMemoryConfigFsBridge,
  InaccessibleTranscriptError,
  MissingHarnessError,
  type ProbeInstallationOptions,
  type RawHarnessRecord,
  type RecordListener,
  type RecordType,
  type RefreshOutcome,
  type RefreshResult,
  type SessionEventSource,
  type SourceCursor,
  TIER1_HIGH_FIDELITY,
  UnsupportedVersionError,
  applyConfigMutation,
  computeConfigHash,
  createRefreshResult,
  planConfigMutation,
} from "@resin/harness-contracts";
import type { JsonObject } from "../src/normalization/redaction.js";

/**
 * Deterministic fake SessionEventSource for testing transcript streaming, checkpoints, and rotations.
 */
export class FakeSessionEventSource implements SessionEventSource {
  private records: RawHarnessRecord[] = [];
  private cursorIndex = 0;
  private currentCursor: SourceCursor | null = null;
  private listeners = new Set<RecordListener>();
  private rotated = false;
  private truncated = false;
  private closed = false;

  constructor(
    readonly sessionId: string,
    initialRecords: RawHarnessRecord[] = [],
    initialCursor?: SourceCursor,
  ) {
    this.records = [...initialRecords];
    if (initialCursor) {
      this.checkpoint(initialCursor);
    }
  }

  async readNext(batchSize = 10): Promise<RawHarnessRecord[]> {
    if (this.closed) {
      return [];
    }

    if (this.cursorIndex >= this.records.length) {
      return [];
    }

    const nextBatch = this.records.slice(this.cursorIndex, this.cursorIndex + batchSize);
    this.cursorIndex += nextBatch.length;

    const lastRecord = nextBatch[nextBatch.length - 1];
    if (lastRecord) {
      this.currentCursor = { ...lastRecord.cursor };
    }

    return nextBatch;
  }

  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.currentCursor = { ...cursor };
    // Find index of record corresponding to this cursor sequence
    const foundIndex = this.records.findIndex((r) => r.cursor.sequence === cursor.sequence);
    if (foundIndex !== -1) {
      this.cursorIndex = foundIndex + 1;
    } else {
      this.cursorIndex = Math.min(cursor.sequence + 1, this.records.length);
    }
  }

  getCursor(): SourceCursor | null {
    return this.currentCursor ? { ...this.currentCursor } : null;
  }

  async detectRotation(): Promise<boolean> {
    return this.rotated || this.truncated;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }

  // --- Testing Simulation Helpers ---

  appendRecord(
    payload: JsonValue,
    recordType: RecordType = "transcript_line",
    harnessId = "fake",
  ): RawHarnessRecord {
    const sequenceNumber = this.records.length;
    const offset = sequenceNumber * 128;
    const line = sequenceNumber + 1;
    const timestamp = new Date().toISOString();

    const record: RawHarnessRecord = {
      recordId: randomUUID(),
      sessionId: this.sessionId,
      harnessId,
      sequenceNumber,
      timestamp,
      recordType,
      rawPayload: payload,
      cursor: {
        offset,
        line,
        sequence: sequenceNumber,
        checkpoint: computeConfigHash(JSON.stringify(payload)),
        timestamp,
      },
      metadata: {},
    };

    this.records.push(record);

    // Notify listeners asynchronously
    for (const listener of this.listeners) {
      try {
        listener([record]);
      } catch {
        // Suppress listener errors during broadcast
      }
    }

    return record;
  }

  appendRecords(records: RawHarnessRecord[]): void {
    this.records.push(...records);
    for (const listener of this.listeners) {
      try {
        listener(records);
      } catch {
        // Suppress listener errors
      }
    }
  }

  simulateRotation(): void {
    this.rotated = true;
  }

  simulateTruncation(): void {
    this.truncated = true;
    this.records = [];
    this.cursorIndex = 0;
  }

  resetRotation(): void {
    this.rotated = false;
    this.truncated = false;
  }

  isClosed(): boolean {
    return this.closed;
  }

  getRecordCount(): number {
    return this.records.length;
  }

  getAllRecords(): readonly RawHarnessRecord[] {
    return [...this.records];
  }
}

export interface FakeHarnessSimulatedErrors {
  missingHarness?: boolean;
  unsupportedVersion?: boolean;
  inaccessibleTranscript?: boolean;
  ambiguousSession?: boolean;
  permissionError?: boolean;
  refreshError?: boolean;
}

/**
 * Deterministic fake HarnessAdapter for unit, contract, and integration tests.
 */
export class FakeHarnessAdapter implements HarnessAdapter {
  readonly id: string;
  readonly version: string;
  readonly supportedHarnessVersions: readonly string[];

  private installation: HarnessInstallation | null;
  private workspaces = new Map<string, HarnessWorkspace>();
  private sessions = new Map<string, HarnessSession[]>();
  private activeSessions = new Map<string, string | null>();
  private eventSources = new Map<string, FakeSessionEventSource>();
  private capabilities: AdapterCapabilities;
  private fsBridge: ConfigFsBridge;
  private refreshOutcome: RefreshOutcome = "native_list_change";

  public simulatedErrors: FakeHarnessSimulatedErrors = {};

  constructor(options?: {
    id?: string;
    version?: string;
    supportedHarnessVersions?: string[];
    installation?: HarnessInstallation | null;
    capabilities?: Partial<AdapterCapabilities>;
    fsBridge?: ConfigFsBridge;
    refreshOutcome?: RefreshOutcome;
  }) {
    this.id = options?.id ?? "fake";
    this.version = options?.version ?? "0.1.0";
    this.supportedHarnessVersions = options?.supportedHarnessVersions ?? [
      "1.0.0",
      "1.1.0",
      "2.0.0",
    ];

    const now = new Date().toISOString();
    this.installation =
      options?.installation !== undefined
        ? options.installation
        : {
            harnessId: this.id,
            displayName: "Fake AI Harness",
            version: "1.0.0",
            executablePath: "/usr/local/bin/fake-harness",
            configPath: "/home/user/.fake/config.json",
            isInstalled: true,
            status: "ready",
            detectedAt: now,
            metadata: {},
          };

    this.capabilities = {
      refresh: {
        supportsNativeListChange: true,
        supportsContextNudge: true,
        requiresSessionRestart: false,
        description: "Fake refresh capability",
      },
      fidelity: TIER1_HIGH_FIDELITY,
      supportedTransports: ["stdio", "sse"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: { mock: true },
      ...options?.capabilities,
    };

    this.fsBridge = options?.fsBridge ?? new InMemoryConfigFsBridge();
    if (options?.refreshOutcome) {
      this.refreshOutcome = options.refreshOutcome;
    }
  }

  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    if (this.simulatedErrors.missingHarness) {
      return null;
    }

    if (this.simulatedErrors.permissionError) {
      throw new HarnessPermissionError("Permission denied probing fake harness", {
        harnessId: this.id,
        targetPath: options?.customExecutablePath,
      });
    }

    if (this.simulatedErrors.unsupportedVersion && this.installation) {
      return {
        ...this.installation,
        status: "unsupported_version",
        version: "0.0.1",
      };
    }

    return this.installation ? { ...this.installation } : null;
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    if (this.simulatedErrors.missingHarness) {
      throw new MissingHarnessError(`Harness ${this.id} is not installed`, {
        harnessId: this.id,
      });
    }
    return Array.from(this.workspaces.values());
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    return this.sessions.get(workspace.workspaceId) ?? [];
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    if (this.simulatedErrors.ambiguousSession) {
      const candidates = (this.sessions.get(workspace.workspaceId) ?? []).map((s) => s.sessionId);
      throw new AmbiguousActiveSessionError(
        `Ambiguous active session in workspace ${workspace.workspaceId}`,
        {
          harnessId: this.id,
          candidateSessionIds: candidates.length > 0 ? candidates : ["session-1", "session-2"],
        },
      );
    }

    const activeId = this.activeSessions.get(workspace.workspaceId);
    if (!activeId) {
      return null;
    }

    const workspaceSessions = this.sessions.get(workspace.workspaceId) ?? [];
    return workspaceSessions.find((s) => s.sessionId === activeId) ?? null;
  }

  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    if (this.simulatedErrors.inaccessibleTranscript) {
      throw new InaccessibleTranscriptError(
        `Cannot access transcript at ${session.transcriptPath}`,
        {
          harnessId: this.id,
          path: session.transcriptPath,
        },
      );
    }

    let source = this.eventSources.get(session.sessionId);
    if (!source) {
      source = new FakeSessionEventSource(session.sessionId, [], cursor);
      this.eventSources.set(session.sessionId, source);
    } else if (cursor) {
      await source.checkpoint(cursor);
    }

    return source;
  }

  async planMcpConfig(
    workspace: HarnessWorkspace,
    gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    const currentContent = await this.fsBridge.readFile(workspace.configPath);
    let parsedConfig: JsonObject = {};

    if (currentContent) {
      try {
        parsedConfig = JSON.parse(currentContent);
      } catch {
        parsedConfig = {};
      }
    }

    // SAFETY: Parsed config mcpServers is a record dictionary.
    const mcpServers = (parsedConfig.mcpServers as JsonObject) ?? {};
    mcpServers.resin = {
      url: gatewayUrl,
      transport: "sse",
    };

    const plannedContent = JSON.stringify(
      {
        ...parsedConfig,
        mcpServers,
      },
      null,
      2,
    );

    return planConfigMutation({
      harnessId: this.id,
      targetPath: workspace.configPath,
      currentContent,
      plannedContent,
      description: `Add Resin Gateway MCP server at ${gatewayUrl}`,
    });
  }

  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyConfigMutation(plan, this.fsBridge);
  }

  async verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    const content = await this.fsBridge.readFile(workspace.configPath);
    if (!content) {
      return false;
    }
    try {
      const parsed = JSON.parse(content);
      return Boolean(parsed.mcpServers?.resin);
    } catch {
      return false;
    }
  }

  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    if (this.simulatedErrors.refreshError) {
      throw new CatalogRefreshError(
        `Failed to notify refresh for workspace ${workspace.workspaceId}`,
        {
          harnessId: this.id,
        },
      );
    }

    const totalAffected =
      changeSummary.addedToolIds.length +
      changeSummary.updatedToolIds.length +
      changeSummary.removedToolIds.length;

    return createRefreshResult(this.refreshOutcome, {
      message: `Catalog refreshed for workspace ${workspace.name}: ${totalAffected} tools changed`,
      catalogVersion: changeSummary.catalogVersion,
      affectedToolCount: totalAffected,
    });
  }

  getCapabilities(): AdapterCapabilities {
    return { ...this.capabilities };
  }

  // --- Seed & Setup Helpers for Tests ---

  setInstallation(installation: HarnessInstallation | null): void {
    this.installation = installation;
  }

  addWorkspace(workspace: HarnessWorkspace): void {
    this.workspaces.set(workspace.workspaceId, workspace);
  }

  addSession(session: HarnessSession): void {
    const existing = this.sessions.get(session.workspaceId) ?? [];
    this.sessions.set(session.workspaceId, [...existing, session]);
  }

  setActiveSession(workspaceId: string, sessionId: string | null): void {
    this.activeSessions.set(workspaceId, sessionId);
  }

  setCapabilities(capabilities: AdapterCapabilities): void {
    this.capabilities = { ...capabilities };
  }

  setRefreshOutcome(outcome: RefreshOutcome): void {
    this.refreshOutcome = outcome;
  }

  getFsBridge(): ConfigFsBridge {
    return this.fsBridge;
  }

  getOrCreateEventSource(sessionId: string): FakeSessionEventSource {
    let source = this.eventSources.get(sessionId);
    if (!source) {
      source = new FakeSessionEventSource(sessionId);
      this.eventSources.set(sessionId, source);
    }
    return source;
  }
}
