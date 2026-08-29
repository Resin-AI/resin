import type {
  AdapterCapabilities,
  CatalogChangeSummary,
  ConfigBackup,
  ConfigMutationPlan,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  RawHarnessRecord,
  RefreshResult,
  SourceCursor,
} from "@resin/harness-contracts";
import { FIXTURE_DIGEST, FIXTURE_TIMESTAMP, FIXTURE_WORKSPACE_ID } from "./domain.js";

// ============================================================================
// Harness Installations & Workspaces - Valid Fixtures
// ============================================================================

export const validHarnessInstallation: HarnessInstallation = {
  harnessId: "cline",
  displayName: "Cline VSCode Extension",
  version: "3.2.0",
  executablePath: "/usr/local/bin/code",
  configPath: "/Users/sandbox/.vscode/extensions/saoudrizwan.claude-dev/settings.json",
  isInstalled: true,
  status: "ready",
  detectedAt: FIXTURE_TIMESTAMP,
  metadata: {},
};

export const validHarnessSession: HarnessSession = {
  sessionId: "ses_cline_001",
  workspaceId: FIXTURE_WORKSPACE_ID,
  harnessId: "cline",
  transcriptPath: "/Users/sandbox/.cline/transcripts/ses_cline_001.json",
  status: "active",
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  metadata: {
    model: "claude-3-7-sonnet",
    temperature: 0.2,
  },
};

export const validHarnessWorkspace: HarnessWorkspace = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  rootPath: "/workspaces/resin",
  name: "Resin",
  harnessId: "cline",
  configPath: "/workspaces/resin/.cline/config.json",
  metadata: {},
};

// ============================================================================
// Raw Records & Cursors - Valid Fixtures
// ============================================================================

export const validSourceCursor: SourceCursor = {
  offset: 1048,
  line: 42,
  sequence: 1,
  checkpoint: FIXTURE_DIGEST,
  timestamp: FIXTURE_TIMESTAMP,
};

export const validRawHarnessRecord: RawHarnessRecord = {
  recordId: "raw_rec_001",
  sessionId: "ses_cline_001",
  harnessId: "cline",
  sequenceNumber: 1,
  timestamp: FIXTURE_TIMESTAMP,
  recordType: "tool_call",
  rawPayload: {
    action: "execute_command",
    command: "pnpm test",
    exit_status: 0,
  },
  cursor: validSourceCursor,
  metadata: {},
};

// ============================================================================
// Configuration Mutation, Backups & Rollbacks - Valid Fixtures
// ============================================================================

export const validConfigBackup: ConfigBackup = {
  backupId: "bak_001",
  targetPath: "/workspaces/resin/.cline/config.json",
  backupPath: "/workspaces/resin/.cline/config.json.bak_001",
  contentHash: FIXTURE_DIGEST,
  originalContent: '{"tools": []}',
  createdAt: FIXTURE_TIMESTAMP,
  restored: false,
};

export const validConfigMutationPlan: ConfigMutationPlan = {
  planId: "plan_mut_001",
  harnessId: "cline",
  targetPath: "/workspaces/resin/.cline/config.json",
  preconditionHash: FIXTURE_DIGEST,
  plannedContent: '{"tools": [{"name": "fast_ast_grep", "version": "1.0.0"}]}',
  description: "Inject fast_ast_grep tool into Cline configuration",
  createdAt: FIXTURE_TIMESTAMP,
  metadata: {},
};
// ============================================================================

export const validCatalogChangeSummary: CatalogChangeSummary = {
  addedToolIds: ["fast_ast_grep"],
  updatedToolIds: [],
  removedToolIds: [],
  catalogVersion: "1.0.0",
  timestamp: FIXTURE_TIMESTAMP,
};

export const validAdapterCapabilities: AdapterCapabilities = {
  refresh: {
    supportsNativeListChange: true,
    supportsContextNudge: true,
    requiresSessionRestart: false,
    description: "Supports native MCP list changes and context nudges",
  },
  fidelity: {
    transcriptAvailability: "stream",
    toolCallVisibility: "full",
    toolResultVisibility: "full",
    subagentVisibility: "full",
    mcpListChange: "supported",
    contextNudge: "supported",
    overallScore: 100,
    notes: "Full real-time streaming",
  },
  supportedTransports: ["stdio", "http"],
  supportsMultiWorkspace: true,
  supportsConcurrentSessions: true,
  features: {},
};

export const validRefreshResult: RefreshResult = {
  outcome: "context_nudge",
  appliedAt: FIXTURE_TIMESTAMP,
  message: "Sent tool catalog refresh context nudge to Cline session.",
  catalogVersion: "1.0.0",
  affectedToolCount: 1,
  requiresRestart: false,
  details: {
    toolsInjected: 1,
  },
};

// ============================================================================
// Invalid Harness Fixtures for Negative Testing
// ============================================================================

export const invalidHarnessFixtures = {
  invalidInstallationBadStatus: {
    ...validHarnessInstallation,
    status: "corrupted_beyond_repair",
  },
  invalidSessionMissingHarness: {
    sessionId: "ses_001",
    workspaceId: FIXTURE_WORKSPACE_ID,
    transcriptPath: "/path",
    status: "active",
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
  },
  invalidRawRecordNegativeSequence: {
    ...validRawHarnessRecord,
    sequenceNumber: -5,
  },
  invalidAdapterBadFidelity: {
    ...validAdapterCapabilities,
    fidelity: {
      ...validAdapterCapabilities.fidelity,
      transcriptAvailability: "quantum_subspace",
    },
  },
};
