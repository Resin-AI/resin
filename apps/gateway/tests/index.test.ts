import { describe, expect, it } from "vitest";
import * as GatewayExports from "../src/index.js";
import {
  CatalogRefreshCoordinator,
  CloudInvocationRouter,
  LocalMcpGateway,
  McpConnection,
  McpFrameDecoder,
  McpProtocolError,
  McpStdioShim,
  RegistryGatewayRouter,
  SYSTEM_META_TOOL_IDS,
  SYSTEM_META_TOOL_NAMES,
  ToolRegistry,
  createGateway,
  createRegistryGatewayRouter,
  createSystemMetaTools,
  encodeMcpMessage,
  redactSensitiveText,
  resolveWorkspaceContext,
} from "../src/index.js";

describe("Gateway Package Index Exports", () => {
  it("exports all core production classes, functions, and helpers", () => {
    expect(LocalMcpGateway).toBeDefined();
    expect(RegistryGatewayRouter).toBeDefined();
    expect(createRegistryGatewayRouter).toBeDefined();
    expect(McpConnection).toBeDefined();
    expect(McpFrameDecoder).toBeDefined();
    expect(McpProtocolError).toBeDefined();
    expect(McpStdioShim).toBeDefined();
    expect(encodeMcpMessage).toBeDefined();
    expect(resolveWorkspaceContext).toBeDefined();
    expect(redactSensitiveText).toBeDefined();
    expect(ToolRegistry).toBeDefined();
    expect(SYSTEM_META_TOOL_NAMES).toBeDefined();
    expect(SYSTEM_META_TOOL_IDS).toBeDefined();
    expect(createSystemMetaTools).toBeDefined();
    expect(CatalogRefreshCoordinator).toBeDefined();
    expect(CloudInvocationRouter).toBeDefined();
  });
  it("never exports test fixtures or mocks in production index", () => {
    // Verify no undefined exports
    for (const [_key, value] of Object.entries(GatewayExports)) {
      expect(value).toBeDefined();
    }
    expect("FakeRefreshAdapter" in GatewayExports).toBe(false);
    expect("createRefreshMatrix" in GatewayExports).toBe(false);
    expect("createDefaultUtilityTools" in GatewayExports).toBe(false);
    expect("FakeNotificationSink" in GatewayExports).toBe(false);
    expect("createMockConnection" in GatewayExports).toBe(false);
  });

  it("createGateway helper starts and stops cleanly", async () => {
    const gw = createGateway();
    await expect(gw.start()).resolves.toBeUndefined();
    await expect(gw.stop()).resolves.toBeUndefined();
  });
});
