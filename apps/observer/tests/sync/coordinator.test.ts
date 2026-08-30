import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeploymentActivator } from "../../src/sync/activator.js";
import { ArtifactTransferClient, InMemoryKeyStore } from "../../src/sync/client.js";
import {
  type ControlStreamAdapter,
  DeploymentSyncCoordinator,
} from "../../src/sync/coordinator.js";
import { LocalPreactivationChecker } from "../../src/sync/preactivation.js";
import { DeploymentReconciler } from "../../src/sync/reconciler.js";
import type { DeploymentCommandMessage, DeploymentSyncStatusReport } from "../../src/sync/types.js";
import {
  createSampleCapabilityEnvelope,
  createSampleToolManifest,
  createSignedTestBundle,
  generateTestSigningKey,
} from "./fixtures.js";

describe("DeploymentSyncCoordinator", () => {
  let store: LocalStateStore;
  let activator: DeploymentActivator;
  let preactivation: LocalPreactivationChecker;
  let client: ArtifactTransferClient;
  let reconciler: DeploymentReconciler;
  let coordinator: DeploymentSyncCoordinator;

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    activator = new DeploymentActivator({ conn: store.conn, toolRepo: store.tools });
    preactivation = new LocalPreactivationChecker();
    client = new ArtifactTransferClient();
    reconciler = new DeploymentReconciler({
      conn: store.conn,
      activator,
      preactivation,
      client,
      toolRepo: store.tools,
    });
    coordinator = new DeploymentSyncCoordinator({
      conn: store.conn,
      activator,
      preactivation,
      client,
      reconciler,
      defaultWorkspaceId: "ws-coord",
    });
  });

  afterEach(() => {
    coordinator.detachAllStreams();
    store.close();
  });

  it("processes online deployment command end-to-end: download -> verify trust -> check policy -> atomic activation", async () => {
    const { keyEntry, signPayload } = generateTestSigningKey("trusted-coord-key", "production");
    const keyStore = new InMemoryKeyStore([keyEntry]);

    const manifest = createSampleToolManifest("coord-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, {
      keyId: keyEntry.keyId,
      signPayload,
    });

    const verifyingClient = new ArtifactTransferClient({
      keyStore,
      verifySignature: true,
      downloadHandler: async (reqDigest) => {
        if (reqDigest === digest) return archiveBuffer;
        throw new Error("Not found");
      },
    });

    const customCoordinator = new DeploymentSyncCoordinator({
      conn: store.conn,
      activator,
      preactivation,
      client: verifyingClient,
      reconciler,
      defaultWorkspaceId: "ws-coord",
    });

    // Save workspace envelope
    const envelope = createSampleCapabilityEnvelope("ws-coord");
    store.conn.run(
      `INSERT INTO workspaces (workspace_id, root_path, name, capability_envelope_json, active_tools_json, created_at, updated_at)
       VALUES ('ws-coord', '/workspaces/ws-coord', 'ws-coord', ?, '{}', datetime('now'), datetime('now'));`,
      [JSON.stringify(envelope)],
    );

    const command: DeploymentCommandMessage = {
      commandId: "cmd-deploy-1",
      commandType: "deploy",
      deploymentId: "dep-coord-1",
      toolId: "coord-tool",
      version: "1.0.0",
      workspaceId: "ws-coord",
      targetDigest: digest,
      reason: "Initial deployment via coordinator",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const report = await customCoordinator.handleCommand(command);

    expect(report.commandId).toBe("cmd-deploy-1");
    expect(report.deploymentId).toBe("dep-coord-1");
    expect(report.toolId).toBe("coord-tool");
    expect(report.status).toBe("active");
    expect(report.catalogRevision).toBe(1);
    expect(report.catalogDigest).toBeDefined();

    // Verify DB state
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-coord"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools["coord-tool"]).toBe("1.0.0");
  });

  it("rejects deployment command when local capability envelope policy is violated", async () => {
    // Tool requests net outbound
    const manifest = createSampleToolManifest("violating-tool", "1.0.0", {
      capabilities: {
        net: {
          allowOutbound: true,
          allowedDomains: ["api.evil.com"],
          allowedHosts: [],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
      },
    });

    const { archiveBuffer, digest } = createSignedTestBundle(manifest);

    const downloadClient = new ArtifactTransferClient({
      downloadHandler: async () => archiveBuffer,
    });

    const customCoordinator = new DeploymentSyncCoordinator({
      conn: store.conn,
      activator,
      preactivation,
      client: downloadClient,
      reconciler,
      defaultWorkspaceId: "ws-restrict",
    });

    // Workspace envelope disallows network
    const envelope = createSampleCapabilityEnvelope("ws-restrict", {
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: [],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
    });

    store.conn.run(
      `INSERT INTO workspaces (workspace_id, root_path, name, capability_envelope_json, active_tools_json, created_at, updated_at)
       VALUES ('ws-restrict', '/workspaces/ws-restrict', 'ws-restrict', ?, '{}', datetime('now'), datetime('now'));`,
      [JSON.stringify(envelope)],
    );

    const command: DeploymentCommandMessage = {
      commandId: "cmd-reject-1",
      commandType: "deploy",
      deploymentId: "dep-reject-1",
      toolId: "violating-tool",
      version: "1.0.0",
      workspaceId: "ws-restrict",
      targetDigest: digest,
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const report = await customCoordinator.handleCommand(command);

    expect(report.status).toBe("rejected");
    expect(report.errorCode).toBe("NET_OUTBOUND_DISALLOWED");
    expect(report.errorMessage).toContain("allowOutbound=false");

    // Verify tool was not activated
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-restrict"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools["violating-tool"]).toBeUndefined();
  });

  it("respects user pin and disable overrides during command handling", async () => {
    const manifest = createSampleToolManifest("overridden-tool", "2.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest);

    const downloadClient = new ArtifactTransferClient({
      downloadHandler: async () => archiveBuffer,
    });

    const customCoordinator = new DeploymentSyncCoordinator({
      conn: store.conn,
      activator,
      preactivation,
      client: downloadClient,
      reconciler,
      defaultWorkspaceId: "ws-ov-test",
    });

    // 1. Tool is disabled by user via user_tool_controls table
    store.conn.run(`
      CREATE TABLE IF NOT EXISTS user_tool_controls (
        workspace_id TEXT PRIMARY KEY,
        pinned_versions_json TEXT NOT NULL DEFAULT '{}',
        disabled_tools_json TEXT NOT NULL DEFAULT '[]',
        rollbacks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);

    store.conn.run(
      `INSERT INTO user_tool_controls (workspace_id, disabled_tools_json, updated_at)
       VALUES ('ws-ov-test', '["overridden-tool"]', datetime('now'));`,
    );

    const deployCommand: DeploymentCommandMessage = {
      commandId: "cmd-disabled-test",
      commandType: "deploy",
      deploymentId: "dep-disabled",
      toolId: "overridden-tool",
      version: "2.0.0",
      workspaceId: "ws-ov-test",
      targetDigest: digest,
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const report = await customCoordinator.handleCommand(deployCommand);
    expect(report.status).toBe("rejected");
    expect(report.errorCode).toBe("USER_DISABLED_OVERRIDE");
  });

  it("ensures idempotency by returning cached status report for duplicate command IDs", async () => {
    const manifest = createSampleToolManifest("idempotent-tool", "1.0.0");
    await activator.stageTool(manifest);

    const command: DeploymentCommandMessage = {
      commandId: "cmd-idempotent-1",
      commandType: "activate",
      deploymentId: "dep-idem-1",
      toolId: "idempotent-tool",
      version: "1.0.0",
      workspaceId: "ws-coord",
      manifest,
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const report1 = await coordinator.handleCommand(command);
    const report2 = await coordinator.handleCommand(command);

    expect(report1).toEqual(report2);
    expect(report1.status).toBe("active");
  });

  it("executes concurrent deployment and rollback commands in deterministic causal order", async () => {
    // Stage v1 and v2
    const v1 = createSampleToolManifest("race-tool", "1.0.0");
    const v2 = createSampleToolManifest("race-tool", "2.0.0");
    await activator.stageTool(v1);
    await activator.stageTool(v2);

    const cmd1: DeploymentCommandMessage = {
      commandId: "cmd-seq-1",
      commandType: "activate",
      deploymentId: "dep-seq-1",
      toolId: "race-tool",
      version: "1.0.0",
      workspaceId: "ws-coord",
      manifest: v1,
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const cmd2: DeploymentCommandMessage = {
      commandId: "cmd-seq-2",
      commandType: "activate",
      deploymentId: "dep-seq-2",
      toolId: "race-tool",
      version: "2.0.0",
      workspaceId: "ws-coord",
      manifest: v2,
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const cmd3: DeploymentCommandMessage = {
      commandId: "cmd-seq-3",
      commandType: "rollback",
      deploymentId: "dep-seq-2",
      toolId: "race-tool",
      version: "2.0.0",
      workspaceId: "ws-coord",
      reason: "Emergency rollback after v2",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    // Fire all three commands concurrently
    const [res1, res2, res3] = await Promise.all([
      coordinator.handleCommand(cmd1),
      coordinator.handleCommand(cmd2),
      coordinator.handleCommand(cmd3),
    ]);

    expect(res1.status).toBe("active");
    expect(res2.status).toBe("active");
    expect(res3.status).toBe("rolled_back");

    // Final active version in workspace must be v1.0.0 (strictly rolled back)
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-coord"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools["race-tool"]).toBe("1.0.0");
  });

  it("integrates with control stream adapter, processing commands and sending acknowledgements", async () => {
    let commandHandler: ((cmd: DeploymentCommandMessage) => Promise<void> | void) | null = null;
    const sentReports: DeploymentSyncStatusReport[] = [];

    const mockStream: ControlStreamAdapter = {
      onCommand: (handler) => {
        commandHandler = handler;
        return () => {
          commandHandler = null;
        };
      },
      sendStatusReport: (report) => {
        sentReports.push(report);
      },
    };

    coordinator.attachControlStream(mockStream);
    expect(commandHandler).toBeDefined();

    const manifest = createSampleToolManifest("stream-tool", "1.0.0");
    await activator.stageTool(manifest);

    const cmd: DeploymentCommandMessage = {
      commandId: "cmd-stream-1",
      commandType: "activate",
      deploymentId: "dep-stream-1",
      toolId: "stream-tool",
      version: "1.0.0",
      workspaceId: "ws-coord",
      manifest,
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    if (commandHandler) {
      // SAFETY: Handler function accepts DeploymentCommandMessage in test.
      await (commandHandler as (cmd: DeploymentCommandMessage) => Promise<void>)(cmd);
    }

    expect(sentReports).toHaveLength(1);
    expect(sentReports[0].commandId).toBe("cmd-stream-1");
    expect(sentReports[0].status).toBe("active");
  });

  it("maintains local tools active offline and performs full reconciliation on reconnect", async () => {
    // 1. Tool is active locally
    const manifest = createSampleToolManifest("offline-tool", "1.0.0");
    await activator.stageTool(manifest);
    await activator.activate({
      workspaceId: "ws-offline",
      toolId: "offline-tool",
      version: "1.0.0",
    });

    // Offline check: local DB still serves active tools
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-offline"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools["offline-tool"]).toBe("1.0.0");

    // 2. Reconnect with new desired tool from cloud
    const newManifest = createSampleToolManifest("cloud-reconnect-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(newManifest);

    const reconnectClient = new ArtifactTransferClient({
      downloadHandler: async () => archiveBuffer,
    });

    const reconnectCoordinator = new DeploymentSyncCoordinator({
      conn: store.conn,
      activator,
      preactivation,
      client: reconnectClient,
      reconciler: new DeploymentReconciler({
        conn: store.conn,
        activator,
        preactivation,
        client: reconnectClient,
      }),
      defaultWorkspaceId: "ws-offline",
    });

    const syncResult = await reconnectCoordinator.sync({
      workspaceId: "ws-offline",
      desiredTools: {
        "offline-tool": { version: "1.0.0" },
        "cloud-reconnect-tool": { version: "1.0.0", digest },
      },
    });

    expect(syncResult.activeTools["offline-tool"]).toBe("1.0.0");
    expect(syncResult.activeTools["cloud-reconnect-tool"]).toBe("1.0.0");
  });
});
