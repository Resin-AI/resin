import { describe, expect, it } from "vitest";
import {
  CODEX_ADAPTER_CAPABILITIES,
  CODEX_DEFAULT_REFRESH_CAPABILITY,
  CODEX_DISPLAY_NAME,
  CODEX_HARNESS_ID,
  CODEX_OBSERVATION_FIDELITY,
  CodexCliAdapter,
  CodexHarnessAdapter,
  CodexRefreshHandler,
  CodexSessionDecoder,
  CodexSessionEventSource,
  applyCodexMcpConfig,
  decodeCodexRecord,
  decodeCodexTranscript,
  findCodexExecutable,
  handleCodexCatalogRefresh,
  planCodexMcpConfig,
  probeCodexInstallation,
  probeCodexVersion,
  resolveCodexPaths,
  rollbackCodexMcpConfig,
  updateJsonMcpConfig,
  updateTomlMcpConfig,
  verifyCodexMcpConfig,
} from "../src/index.js";

describe("Codex Adapter Package Public Surface", () => {
  it("exports all required adapter classes, functions, and constants", () => {
    // Classes
    expect(CodexHarnessAdapter).toBeDefined();
    expect(CodexCliAdapter).toBeDefined();
    expect(CodexSessionDecoder).toBeDefined();
    expect(CodexSessionEventSource).toBeDefined();
    expect(CodexRefreshHandler).toBeDefined();

    // Functions
    expect(findCodexExecutable).toBeTypeOf("function");
    expect(probeCodexVersion).toBeTypeOf("function");
    expect(resolveCodexPaths).toBeTypeOf("function");
    expect(probeCodexInstallation).toBeTypeOf("function");
    expect(updateTomlMcpConfig).toBeTypeOf("function");
    expect(updateJsonMcpConfig).toBeTypeOf("function");
    expect(planCodexMcpConfig).toBeTypeOf("function");
    expect(applyCodexMcpConfig).toBeTypeOf("function");
    expect(rollbackCodexMcpConfig).toBeTypeOf("function");
    expect(verifyCodexMcpConfig).toBeTypeOf("function");
    expect(decodeCodexRecord).toBeTypeOf("function");
    expect(decodeCodexTranscript).toBeTypeOf("function");
    expect(handleCodexCatalogRefresh).toBeTypeOf("function");

    // Constants
    expect(CODEX_HARNESS_ID).toBe("codex-cli");
    expect(CODEX_DISPLAY_NAME).toBe("Codex CLI");
    expect(CODEX_ADAPTER_CAPABILITIES).toBeDefined();
    expect(CODEX_OBSERVATION_FIDELITY).toBeDefined();
    expect(CODEX_DEFAULT_REFRESH_CAPABILITY).toBeDefined();
  });

  it("instantiates CodexHarnessAdapter with default capabilities", () => {
    const adapter = new CodexHarnessAdapter();
    expect(adapter.id).toBe("codex-cli");
    expect(adapter.name).toBe("Codex CLI");
    expect(adapter.version).toBe("0.1.0");

    const caps = adapter.getCapabilities();
    expect(caps.supportsMultiWorkspace).toBe(true);
    expect(caps.fidelity.transcriptAvailability).toBe("file_tail");
  });
});
