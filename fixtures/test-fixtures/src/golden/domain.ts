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
  NormalizedSessionEvent,
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
} from "@resin/contracts";

export const FIXTURE_TIMESTAMP = "2026-08-17T12:00:00.000Z";
export const FIXTURE_SESSION_ID = "01J5XYZ7890ABCDEFGHJKMNPQR";
export const FIXTURE_WORKSPACE_ID = "ws_dev_primary_01";
export const FIXTURE_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const defaultRedaction = {
  isRedacted: false,
  redactedFields: [],
  redactionStrategy: "none" as const,
  scrubbedPatterns: [],
};

const defaultSourceLocation = {
  filePath: "src/tools/index.ts",
  line: 42,
  column: 1,
};

// ============================================================================
// Normalized Session Events - Valid Fixtures
// ============================================================================

export const validMessageEvent: NormalizedMessageEvent = {
  eventId: "evt_msg_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 1, turnIndex: 0, stepIndex: 0 },
  redaction: defaultRedaction,
  type: "message",
  role: "user",
  content: "Refactor the authentication middleware to use JWT verification.",
  contentParts: [
    {
      type: "text",
      text: "Refactor the authentication middleware to use JWT verification.",
    },
  ],
};

export const validModelReasoningEvent: NormalizedModelReasoningEvent = {
  eventId: "evt_reason_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 2, turnIndex: 0, stepIndex: 1 },
  redaction: defaultRedaction,
  type: "model_reasoning",
  reasoningContent:
    "The user wants to replace session-based auth with JWT tokens. I will examine src/auth.ts.",
  tokenCount: 24,
  durationMs: 450,
};

export const validToolDiscoveryEvent: NormalizedToolDiscoveryEvent = {
  eventId: "evt_disc_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 3, turnIndex: 0, stepIndex: 2 },
  redaction: defaultRedaction,
  type: "tool_discovery",
  source: "mcp",
  tools: [
    {
      name: "readFile",
      description: "Read file contents",
      provider: "builtin",
    },
  ],
};

export const validToolCallEvent: NormalizedToolCallEvent = {
  eventId: "evt_call_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 4, turnIndex: 0, stepIndex: 3 },
  redaction: defaultRedaction,
  type: "tool_call",
  callId: "call_01JABCDEF",
  toolName: "readFile",
  parameters: { path: "src/auth.ts" },
  isShadow: false,
};

export const validToolResultEvent: NormalizedToolResultEvent = {
  eventId: "evt_res_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 5, turnIndex: 0, stepIndex: 4 },
  redaction: defaultRedaction,
  type: "tool_result",
  callId: "call_01JABCDEF",
  toolName: "readFile",
  result: { content: "export function auth() { return true; }" },
  executionDurationMs: 45,
  isError: false,
  isShadow: false,
};

export const validCommandExecEvent: NormalizedCommandExecEvent = {
  eventId: "evt_cmd_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 6, turnIndex: 0, stepIndex: 5 },
  redaction: defaultRedaction,
  type: "command_exec",
  command: "pnpm",
  args: ["test", "auth"],
  exitCode: 0,
  stdout: "PASS src/auth.test.ts",
  stderr: "",
  durationMs: 1200,
};

export const validFileEditEvent: NormalizedFileEditEvent = {
  eventId: "evt_edit_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 7, turnIndex: 0, stepIndex: 6 },
  redaction: defaultRedaction,
  type: "file_edit",
  filePath: "src/auth.ts",
  operation: "update",
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
  redaction: defaultRedaction,
  type: "error",
  errorType: "ERR_FILE_NOT_FOUND",
  message: "Cannot find module src/secret.ts",
  recoverable: true,
  details: { attemptedPath: "src/secret.ts" },
};

export const validCompactionEvent: NormalizedCompactionEvent = {
  eventId: "evt_comp_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 9, turnIndex: 0, stepIndex: 8 },
  redaction: defaultRedaction,
  type: "compaction",
  triggerReason: "context_limit",
  tokensBefore: 4500,
  tokensAfter: 1200,
  preservedContextSummary: "Read auth file and planned refactoring",
};

export const validBranchForkEvent: NormalizedBranchForkEvent = {
  eventId: "evt_fork_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 10, turnIndex: 0, stepIndex: 9 },
  redaction: defaultRedaction,
  type: "branch_fork",
  sourceSessionId: FIXTURE_SESSION_ID,
  branchPointEventId: "evt_edit_001",
  branchName: "experiment_jwt",
};

export const validSubagentLifecycleEvent: NormalizedSubagentLifecycleEvent = {
  eventId: "evt_subagent_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 11, turnIndex: 0, stepIndex: 10 },
  redaction: defaultRedaction,
  type: "subagent_lifecycle",
  subagentId: "sub_01JABCDEF",
  lifecycleType: "spawn",
  role: "task",
  reason: "Run test suite in isolated worktree",
};

export const validSessionLifecycleEvent: NormalizedSessionLifecycleEvent = {
  eventId: "evt_lifecycle_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 12, turnIndex: 0, stepIndex: 11 },
  redaction: defaultRedaction,
  type: "session_lifecycle",
  lifecycleType: "resume",
  harnessName: "cline",
  workspaceId: FIXTURE_WORKSPACE_ID,
};

export const validUnknownPassthroughEvent: NormalizedUnknownPassthroughEvent = {
  eventId: "evt_unknown_001",
  schemaVersion: "1.0.0",
  sessionId: FIXTURE_SESSION_ID,
  timestamp: FIXTURE_TIMESTAMP,
  causalRef: { causalSequence: 13, turnIndex: 0, stepIndex: 12 },
  redaction: defaultRedaction,
  type: "unknown_passthrough",
  rawEventType: "custom_harness_ping",
  rawPayload: { ping: true },
};

export const allValidDomainEvents: NormalizedSessionEvent[] = [
  validMessageEvent,
  validModelReasoningEvent,
  validToolDiscoveryEvent,
  validToolCallEvent,
  validToolResultEvent,
  validCommandExecEvent,
  validFileEditEvent,
  validErrorEvent,
  validCompactionEvent,
  validBranchForkEvent,
  validSubagentLifecycleEvent,
  validSessionLifecycleEvent,
  validUnknownPassthroughEvent,
];

// ============================================================================
// Tools, Capabilities & Manifests - Valid Fixtures
// ============================================================================

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
      allowedProtocols: [],
      allowLocalhost: false,
      denyPrivateRanges: true,
    },
    command: {
      allowShellExecution: false,
      allowedCommands: [],
      allowedBinaries: [],
      forbiddenPatterns: ["rm -rf", "sudo", "eval"],
      allowEnvPassthrough: ["PATH", "DENO_DIR"],
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
      metadata: {},
    },
  ],
  activeTrafficPercentage: 10,
  createdAt: FIXTURE_TIMESTAMP,
};

export const validWorkspaceRecord: WorkspaceRecord = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  rootPath: "/workspaces/resin",
  name: "Resin Core",
  config: {},
  capabilityEnvelope: validCapabilityEnvelope,
  activeTools: { fast_ast_grep: "1.0.0" },
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
};

export const validDeviceRecord: DeviceRecord = {
  deviceId: "dev_01JABCDEF",
  hostname: "macbook-pro.local",
  platform: "darwin",
  arch: "arm64",
  osVersion: "15.3.0",
  cpuCores: 10,
  totalMemoryMb: 32768,
  daemonVersion: "0.1.0",
  registeredAt: FIXTURE_TIMESTAMP,
  lastSeenAt: FIXTURE_TIMESTAMP,
};

export const validInstallationRecord: InstallationRecord = {
  installationId: "inst_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  toolId: "fast_ast_grep",
  toolVersion: "1.0.0",
  deploymentId: "dep_001",
  installedAt: FIXTURE_TIMESTAMP,
  state: "active",
  configOverrides: {},
};

export const validInvocationRecord: InvocationRecord = {
  invocationId: "inv_001",
  sessionId: FIXTURE_SESSION_ID,
  workspaceId: FIXTURE_WORKSPACE_ID,
  toolId: "fast_ast_grep",
  toolVersion: "1.0.0",
  startedAt: FIXTURE_TIMESTAMP,
  completedAt: FIXTURE_TIMESTAMP,
  durationMs: 45,
  status: "success",
  inputDigest: FIXTURE_DIGEST,
  outputDigest: FIXTURE_DIGEST,
  resourceUsage: { cpuTimeMs: 12, memoryBytes: 1048576, shadowRun: false },
};

export const validTelemetryRecord: TelemetryRecord = {
  telemetryId: "tel_001",
  deviceId: "dev_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  metricName: "tool_latency_ms",
  metricType: "gauge",
  value: 45.0,
  tags: { toolId: "fast_ast_grep" },
  timestamp: FIXTURE_TIMESTAMP,
};

export const validAuditRecord: AuditRecord = {
  auditId: "aud_001",
  timestamp: FIXTURE_TIMESTAMP,
  eventType: "tool_deployed",
  actor: { type: "agent", id: "evolution_agent" },
  workspaceId: FIXTURE_WORKSPACE_ID,
  resourceType: "tool",
  resourceId: "fast_ast_grep@1.0.0",
  action: "deploy",
  status: "success",
  details: { strategy: "shadow" },
};

export const validDeadLetterRecord: DeadLetterRecord = {
  deadLetterId: "dl_001",
  originalEventType: "tool_call",
  payload: { tool: "missing_tool" },
  errorReason: "Unknown tool name",
  failedAt: FIXTURE_TIMESTAMP,
  retryCount: 0,
  status: "pending",
};

export const validSyncCursor: SyncCursor = {
  cursorId: "cur_001",
  deviceId: "dev_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  entityType: "telemetry",
  lastSyncedSequence: 42,
  lastSyncedTimestamp: FIXTURE_TIMESTAMP,
  syncToken: FIXTURE_DIGEST,
};

// ============================================================================
// Invalid Fixtures for Negative Testing
// ============================================================================

export const invalidDomainFixtures = {
  missingEventType: {
    eventId: "evt_001",
    schemaVersion: "1.0.0",
    sessionId: FIXTURE_SESSION_ID,
    timestamp: FIXTURE_TIMESTAMP,
    causalRef: { causalSequence: 1, turnIndex: 0, stepIndex: 0 },
    redaction: defaultRedaction,
  },
  invalidTimestamp: {
    ...validMessageEvent,
    timestamp: "yesterday afternoon",
  },
  invalidToolCallMissingCallId: {
    eventId: "evt_call_bad",
    schemaVersion: "1.0.0",
    sessionId: FIXTURE_SESSION_ID,
    timestamp: FIXTURE_TIMESTAMP,
    causalRef: { causalSequence: 1, turnIndex: 0, stepIndex: 0 },
    redaction: defaultRedaction,
    type: "tool_call",
    toolName: "readFile",
    toolVersion: "1.0.0",
    arguments: {},
  },
  invalidToolManifestVersion: {
    ...validToolManifest,
    version: "not-a-semver",
  },
  invalidToolManifestEmptyId: {
    ...validToolManifest,
    id: "",
  },
  invalidDeploymentBadState: {
    ...validDeploymentRecord,
    state: "exploded",
  },
  invalidWorkspaceMissingPath: {
    workspaceId: FIXTURE_WORKSPACE_ID,
    name: "Resin",
    capabilityEnvelope: validCapabilityEnvelope,
    createdAt: FIXTURE_TIMESTAMP,
  },
  invalidDigestWrongLength: {
    ...validToolVersion,
    manifestDigest: "too-short",
  },
};
