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

  it("does not export test doubles, fakes, mocks, or test fixture tools in production index", () => {
    const exportsObj = GatewayExports as Record<string, unknown>;
    expect(exportsObj.FakeGatewayRouter).toBeUndefined();
    expect(exportsObj.MockCloudMcpService).toBeUndefined();
    expect(exportsObj.FakeRefreshAdapter).toBeUndefined();
    expect(exportsObj.createRefreshMatrix).toBeUndefined();
    expect(exportsObj.createDefaultUtilityTools).toBeUndefined();
    expect(exportsObj.FakeNotificationSink).toBeUndefined();
    expect(exportsObj.createMockConnection).toBeUndefined();
  });

  it("createGateway helper starts and stops cleanly", async () => {
    const gw = createGateway();
    await expect(gw.start()).resolves.toBeUndefined();
    await expect(gw.stop()).resolves.toBeUndefined();
  });
});
