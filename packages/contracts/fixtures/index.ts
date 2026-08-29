import type {
  AuditRecord,
  CapabilityEnvelope,
  CapabilityGrant,
  CatalogSnapshot,
  DeadLetterRecord,
  DeploymentRecord,
  DeviceRecord,
  InstallationRecord,
  InvocationRecord,
  NormalizedBranchForkEvent,
  NormalizedCommandExecEvent,
  NormalizedCompactionEvent,
  NormalizedErrorEvent,
  NormalizedFileEditEvent,
  NormalizedMessageEvent,
  NormalizedModelReasoningEvent,
  NormalizedSessionLifecycleEvent,
  NormalizedSubagentLifecycleEvent,
  NormalizedToolCallEvent,
  NormalizedToolDiscoveryEvent,
  NormalizedToolResultEvent,
  NormalizedUnknownPassthroughEvent,
  SyncCursor,
  TelemetryRecord,
  ToolManifest,
  ToolVersion,
  WorkspaceRecord,
} from "../src/index.js";

// Common shared test timestamps & IDs
export const FIXTURE_TIMESTAMP = "2026-08-17T12:00:00.000Z";
export const FIXTURE_SESSION_ID = "01J5XYZ7890ABCDEFGHJKMNPQR";
export const FIXTURE_WORKSPACE_ID = "ws_dev_primary_01";
export const FIXTURE_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const validMessageEvent: NormalizedMessageEvent = {
  eventId: "evt_msg_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 1, turnIndex: 0, stepIndex: 0 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "message",
  role: "user",
  content: "Please find all files containing SQL queries.",
  model: "claude-3-7-sonnet",
};

export const validModelReasoningEvent: NormalizedModelReasoningEvent = {
  eventId: "evt_rsn_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 2, turnIndex: 0, stepIndex: 1 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "model_reasoning",
  reasoningContent:
    "The user wants to locate SQL queries across the workspace. I should search for SELECT, INSERT, UPDATE, DELETE.",
  tokenCount: 42,
  durationMs: 120,
};

export const validToolDiscoveryEvent: NormalizedToolDiscoveryEvent = {
  eventId: "evt_dsc_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 3, turnIndex: 0, stepIndex: 2 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "tool_discovery",
  tools: [
    {
      name: "ripgrep_search",
      description: "Search workspace using ripgrep",
      provider: "mcp-server-filesystem",
    },
  ],
  source: "mcp",
};

export const validToolCallEvent: NormalizedToolCallEvent = {
  eventId: "evt_call_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 4, turnIndex: 0, stepIndex: 3 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "tool_call",
  callId: "call_rg_99",
  toolName: "ripgrep_search",
  parameters: { query: "SELECT\\s+\\*\\s+FROM", path: "src" },
  isShadow: false,
};

export const validToolResultEvent: NormalizedToolResultEvent = {
  eventId: "evt_res_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 5, turnIndex: 0, stepIndex: 4 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "tool_result",
  callId: "call_rg_99",
  toolName: "ripgrep_search",
  result: { matches: [{ file: "src/db.ts", line: 42, match: "SELECT * FROM users" }] },
  isError: false,
  executionDurationMs: 14.5,
  outputSizeBytes: 128,
  isShadow: false,
};

export const validCommandExecEvent: NormalizedCommandExecEvent = {
  eventId: "evt_cmd_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 6, turnIndex: 0, stepIndex: 5 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "command_exec",
  command: "git status --porcelain",
  args: ["--porcelain"],
  cwd: "/workspace",
  exitCode: 0,
  stdout: "M src/db.ts\n",
  stderr: "",
  durationMs: 25,
};

export const validFileEditEvent: NormalizedFileEditEvent = {
  eventId: "evt_edit_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 7, turnIndex: 0, stepIndex: 6 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "file_edit",
  filePath: "src/db.ts",
  operation: "update",
  patch: "@@ -42,1 +42,1 @@\n-SELECT * FROM users\n+SELECT id, name FROM users",
  beforeHash: FIXTURE_DIGEST,
  afterHash: FIXTURE_DIGEST,
  diffStats: { linesAdded: 1, linesRemoved: 1 },
};

export const validErrorEvent: NormalizedErrorEvent = {
  eventId: "evt_err_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 8, turnIndex: 0, stepIndex: 7 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "error",
  errorType: "FileSystemError",
  message: "ENOENT: no such file or directory",
  recoverable: true,
};

export const validCompactionEvent: NormalizedCompactionEvent = {
  eventId: "evt_cmp_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 9, turnIndex: 1, stepIndex: 0 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "compaction",
  triggerReason: "context_limit",
  tokensBefore: 180000,
  tokensAfter: 25000,
  preservedContextSummary: "User asked to optimize SQL queries in src/db.ts.",
};

export const validBranchForkEvent: NormalizedBranchForkEvent = {
  eventId: "evt_fork_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 10, turnIndex: 1, stepIndex: 1 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "branch_fork",
  sourceSessionId: "01J5OLD_SESSION_1234567890",
  branchPointEventId: "evt_msg_001",
  forkReason: "Parallel subagent exploration",
  branchName: "experiment-fast-sql",
};

export const validSubagentLifecycleEvent: NormalizedSubagentLifecycleEvent = {
  eventId: "evt_sub_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 11, turnIndex: 1, stepIndex: 2 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "subagent_lifecycle",
  subagentId: "subagent_reviewer_01",
  lifecycleType: "spawn",
  role: "code_reviewer",
  reason: "Review SQL query parameterization",
};

export const validSessionLifecycleEvent: NormalizedSessionLifecycleEvent = {
  eventId: "evt_sess_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 12, turnIndex: 1, stepIndex: 3 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "session_lifecycle",
  lifecycleType: "start",
  harnessName: "omp",
  workspaceId: FIXTURE_WORKSPACE_ID,
};

export const validUnknownPassthroughEvent: NormalizedUnknownPassthroughEvent = {
  eventId: "evt_unk_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 13, turnIndex: 1, stepIndex: 4 },
  redaction: {
    isRedacted: false,
    redactedFields: [],
    redactionStrategy: "none",
    scrubbedPatterns: [],
  },
  type: "unknown_passthrough",
  rawEventType: "custom_harness_telemetry",
  rawPayload: { customField: 12345, tags: ["experimental", "beta"] },
};

export const validToolManifest: ToolManifest = {
  id: "fast_ast_grep",
  name: "Fast AST Grep",
  version: "1.0.0",
  description: "Search TypeScript/JavaScript code by AST pattern",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "AST pattern" },
      path: { type: "string", description: "Search directory" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      matches: { type: "array" },
    },
  },
  runtime: {
    runtime: "deno",
    minRuntimeVersion: "1.40.0",
    memoryLimitMb: 128,
    timeoutMs: 15000,
    cpuLimitPercent: 100,
    maxOutputSizeBytes: 1048576,
  },
  capabilities: {
    fs: {
      readPaths: ["src/**", "tests/**"],
      writePaths: [],
      allowWorkspaceRoot: true,
      allowTemp: false,
      denyPaths: [".git/**", ".env*"],
      maxFileSizeBytes: 10485760,
    },
    net: {
      allowOutbound: false,
      allowedDomains: [],
      allowedHosts: [],
      allowedPorts: [],
      allowedProtocols: ["https"],
      allowLocalhost: false,
      denyPrivateRanges: true,
    },
    command: {
      allowShellExecution: false,
      allowedCommands: [],
      allowedBinaries: [],
      forbiddenPatterns: [],
      allowEnvPassthrough: [],
    },
    secrets: {
      allowedSecretNames: [],
      allowedPrefixes: [],
      denyDirectRead: true,
      injectAsEnv: false,
    },
    limits: {
      maxConcurrentExecutions: 2,
      maxCpuUsagePercent: 100,
      maxMemoryMb: 128,
      maxExecutionTimeMs: 15000,
      maxOutputSizeBytes: 1048576,
    },
  },
  limits: {
    timeoutMs: 15000,
    maxOutputBytes: 1048576,
    maxMemoryBytes: 134217728,
    maxConcurrentInvocations: 2,
  },
  scope: "workspace",
  digest: FIXTURE_DIGEST,
  metadata: { author: "Resin Autonomous Synthesizer" },
  createdAt: FIXTURE_TIMESTAMP,
};

export const validCapabilityGrant: CapabilityGrant = {
  grantId: "grant_001",
  workspaceId: FIXTURE_WORKSPACE_ID,
  toolId: "fast_ast_grep",
  grantedAt: FIXTURE_TIMESTAMP,
  grantType: "explicit",
  capabilities: validToolManifest.capabilities,
  actor: { type: "user", id: "dev_user_01" },
  reason: "User accepted candidate evolution proposal",
};

export const validCapabilityEnvelope: CapabilityEnvelope = {
  envelopeId: "env_ws_001",
  workspaceId: FIXTURE_WORKSPACE_ID,
  version: "1.0.0",
  fs: {
    readPaths: ["**"],
    writePaths: [".resin/**", "tmp/**"],
    allowWorkspaceRoot: true,
    allowTemp: true,
    denyPaths: ["**/.git/config", "**/.env*"],
    maxFileSizeBytes: 52428800,
  },
  net: {
    allowOutbound: true,
    allowedDomains: ["api.github.com", "registry.npmjs.org"],
    allowedHosts: ["api.github.com"],
    allowedPorts: [443],
    allowedProtocols: ["https"],
    allowLocalhost: false,
    denyPrivateRanges: true,
  },
  command: {
    allowShellExecution: false,
    allowedCommands: ["git status", "git diff"],
    allowedBinaries: ["git"],
    forbiddenPatterns: ["rm -rf", "sudo"],
    allowEnvPassthrough: ["PATH"],
  },
  secrets: {
    allowedSecretNames: ["GITHUB_TOKEN"],
    allowedPrefixes: ["RESIN_"],
    denyDirectRead: true,
    injectAsEnv: true,
  },
  limits: {
    maxConcurrentExecutions: 4,
    maxCpuUsagePercent: 100,
    maxMemoryMb: 512,
    maxExecutionTimeMs: 60000,
    maxOutputSizeBytes: 5242880,
  },
  isFrozen: false,
  createdAt: FIXTURE_TIMESTAMP,
};

export const validToolVersion: ToolVersion = {
  toolId: "fast_ast_grep",
  version: "1.0.0",
  manifestDigest: FIXTURE_DIGEST,
  artifactDigest: FIXTURE_DIGEST,
  manifest: validToolManifest,
  artifact: {
    artifactDigest: FIXTURE_DIGEST,
    bundleReference: {
      uri: "file:///workspace/.resin/bundles/fast_ast_grep.bundle.js",
      hash: FIXTURE_DIGEST,
      sizeBytes: 8192,
      format: "js_bundle",
    },
    entrypoint: "run",
    sourceCode: "export async function run() {}",
    checksums: { "bundle.js": FIXTURE_DIGEST },
  },
  provenance: {
    sourceCandidateId: "cand_fast_ast_01",
    synthesizedAt: FIXTURE_TIMESTAMP,
    synthesizerModel: "claude-3-7-sonnet",
    promptHash: FIXTURE_DIGEST,
    deterministicBuildHash: FIXTURE_DIGEST,
    environment: { DENO_VERSION: "1.40.0" },
  },
  signature: {
    signature: "base64-signature-placeholder",
    keyId: "local-ed25519-key-01",
    algorithm: "ed25519",
    signedAt: FIXTURE_TIMESTAMP,
  },
  status: "active",
  createdAt: FIXTURE_TIMESTAMP,
  createdBy: "Resin Daemon",
};

export const validDeploymentRecord: DeploymentRecord = {
  deploymentId: "dep_001",
  workspaceId: FIXTURE_WORKSPACE_ID,
  toolId: "fast_ast_grep",
  toolVersion: "1.0.0",
  state: "canary",
  canaryConfig: {
    strategy: "shadow",
    trafficPercentage: 10,
    durationMinutes: 30,
    maxShadowWorkers: 2,
    autoRollbackThresholds: {
      maxErrorRate: 0.05,
      maxLatencyP95Ms: 5000,
      maxSchemaMismatchRate: 0.01,
      consecutiveFailureThreshold: 3,
    },
  },
  history: [
    {
      fromState: "drafted",
      toState: "validating",
      timestamp: FIXTURE_TIMESTAMP,
      reason: "validation_started",
      actor: { type: "daemon", id: "resin-daemon" },
    },
    {
      fromState: "validating",
      toState: "replaying",
      timestamp: FIXTURE_TIMESTAMP,
      reason: "replay_started",
      actor: { type: "daemon", id: "resin-daemon" },
    },
    {
      fromState: "replaying",
      toState: "eligible",
      timestamp: FIXTURE_TIMESTAMP,
      reason: "marked_eligible",
      actor: { type: "daemon", id: "resin-daemon" },
    },
    {
      fromState: "eligible",
      toState: "canary",
      timestamp: FIXTURE_TIMESTAMP,
      reason: "canary_started",
      actor: { type: "daemon", id: "resin-daemon" },
    },
  ],
  activeTrafficPercentage: 10,
  createdAt: FIXTURE_TIMESTAMP,
};
export const validWorkspaceRecord: WorkspaceRecord = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  rootPath: "/home/user/project",
  name: "My Awesome Project",
  config: { autonomousEvolution: true },
  capabilityEnvelope: validCapabilityEnvelope,
  activeTools: { fast_ast_grep: "1.0.0" },
  createdAt: FIXTURE_TIMESTAMP,
};

export const validDeviceRecord: DeviceRecord = {
  deviceId: "dev_01JABCDEF",
  hostname: "macbook-pro.local",
  platform: "darwin",
  arch: "arm64",
  osVersion: "macOS 15.1",
  cpuCores: 12,
  totalMemoryMb: 32768,
  daemonVersion: "0.1.0",
  registeredAt: FIXTURE_TIMESTAMP,
  lastSeenAt: FIXTURE_TIMESTAMP,
};

export const validInstallationRecord: InstallationRecord = {
  installationId: "inst_001",
  workspaceId: FIXTURE_WORKSPACE_ID,
  toolId: "fast_ast_grep",
  toolVersion: "1.0.0",
  deploymentId: "dep_001",
  installedAt: FIXTURE_TIMESTAMP,
  state: "active",
  configOverrides: {},
};

export const validCatalogSnapshot: CatalogSnapshot = {
  snapshotId: "cat_snap_001",
  workspaceId: FIXTURE_WORKSPACE_ID,
  timestamp: FIXTURE_TIMESTAMP,
  tools: {
    fast_ast_grep: {
      toolId: "fast_ast_grep",
      version: "1.0.0",
      manifestDigest: FIXTURE_DIGEST,
      scope: "workspace",
      status: "active",
    },
  },
  digest: FIXTURE_DIGEST,
};

export const validInvocationRecord: InvocationRecord = {
  invocationId: "inv_001",
  sessionId: FIXTURE_SESSION_ID,
  workspaceId: FIXTURE_WORKSPACE_ID,
  toolId: "fast_ast_grep",
  toolVersion: "1.0.0",
  startedAt: FIXTURE_TIMESTAMP,
  completedAt: FIXTURE_TIMESTAMP,
  durationMs: 14.5,
  status: "success",
  inputDigest: FIXTURE_DIGEST,
  outputDigest: FIXTURE_DIGEST,
  resourceUsage: {
    cpuTimeMs: 12.0,
    memoryBytes: 4194304,
    shadowRun: false,
  },
};

export const validAuditRecord: AuditRecord = {
  auditId: "aud_001",
  timestamp: FIXTURE_TIMESTAMP,
  eventType: "tool_promoted",
  actor: { type: "user", id: "dev_user_01" },
  workspaceId: FIXTURE_WORKSPACE_ID,
  resourceType: "deployment",
  resourceId: "dep_001",
  action: "promote_to_active",
  status: "success",
  details: { previousState: "canary", newState: "promoted" },
};

export const validTelemetryRecord: TelemetryRecord = {
  telemetryId: "tel_001",
  timestamp: FIXTURE_TIMESTAMP,
  deviceId: "dev_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  metricName: "gateway.tool_invocation.duration_ms",
  metricType: "histogram",
  value: 14.5,
  tags: { toolId: "fast_ast_grep", status: "success" },
};

export const validSyncCursor: SyncCursor = {
  cursorId: "cur_001",
  deviceId: "dev_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  entityType: "telemetry",
  lastSyncedSequence: 42,
  lastSyncedTimestamp: FIXTURE_TIMESTAMP,
  syncToken: "tok_sync_abc123",
};

export const validDeadLetterRecord: DeadLetterRecord = {
  deadLetterId: "dlq_001",
  originalEventType: "raw_hook_event",
  payload: { corrupted: true, raw: "malformed JSON..." },
  errorReason: "JSON parse syntax error at byte 42",
  failedAt: FIXTURE_TIMESTAMP,
  retryCount: 3,
  status: "exhausted",
};

// Invalid fixture objects for negative testing
export const invalidFixtures = {
  emptyIdentifier: "",
  invalidSemver: "1.0",
  invalidTimestamp: "not-a-timestamp",
  invalidSha256: "not-a-hash",
  negativeCausalSequence: -1,
  invalidEventType: "non_existent_event_type",
  invalidRole: "superadmin",
  invalidState: "magical_state",
  negativeDuration: -10,
  outOfRangeScore: 1.5,
  invalidPort: 70000,
  invalidCpuPercent: 150,
  missingRequiredField: {
    eventId: "evt_001",
    // missing schemaVersion, sessionId, etc.
  },
};
