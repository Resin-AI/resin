// Adapter implementation & capabilities
export {
  CodexHarnessAdapter,
  CodexCliAdapter,
  CODEX_ADAPTER_CAPABILITIES,
  CODEX_OBSERVATION_FIDELITY,
  type CodexHarnessAdapterOptions,
} from "./adapter.js";

// Host discovery & version probing
export {
  CODEX_HARNESS_ID,
  CODEX_DISPLAY_NAME,
  CODEX_MIN_SUPPORTED_VERSION,
  type CodexResolvedPaths,
  type CommandExecutor,
  type PathLookupFn,
  getCandidateBinaryNames,
  defaultPathLookup,
  findCodexExecutable,
  extractSemver,
  compareSemver,
  defaultCommandExecutor,
  probeCodexVersion,
  resolveCodexPaths,
  probeCodexInstallation,
} from "./discovery.js";

// MCP Configuration Planner (TOML & JSON)
export {
  DEFAULT_GATEWAY_SERVER_NAME,
  type PlanCodexMcpConfigOptions,
  updateTomlMcpConfig,
  updateJsonMcpConfig,
  planCodexMcpConfig,
  applyCodexMcpConfig,
  rollbackCodexMcpConfig,
  verifyCodexMcpConfig,
} from "./config-planner.js";

// Rollout and Transcript Event Decoder
export {
  DEFAULT_SCHEMA_VERSION,
  type CodexDecoderOptions,
  CodexSessionDecoder,
  CodexRecordDecoder,
  decodeCodexRecord,
  decodeCodexTranscript,
} from "./decoder.js";

// Session Event Source
export {
  CodexSessionEventSource,
  type CodexSessionEventSourceOptions,
} from "./source.js";

// Catalog Refresh Notification Handler
export {
  CODEX_DEFAULT_REFRESH_CAPABILITY,
  type CodexRefreshHandlerOptions,
  CodexRefreshHandler,
  handleCodexCatalogRefresh,
} from "./refresh.js";
