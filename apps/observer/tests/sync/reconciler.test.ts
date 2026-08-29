import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeploymentActivator } from "../../src/sync/activator.js";
import { ArtifactTransferClient } from "../../src/sync/client.js";
import { LocalPreactivationChecker } from "../../src/sync/preactivation.js";
import { DeploymentReconciler } from "../../src/sync/reconciler.js";
import {
  createSampleCapabilityEnvelope,
  createSampleToolManifest,
  createSignedTestBundle,
} from "./fixtures.js";

describe("DeploymentReconciler", () => {
  let store: LocalStateStore;
  let activator: DeploymentActivator;
  let preactivation: LocalPreactivationChecker;
  let client: ArtifactTransferClient;
  let reconciler: DeploymentReconciler;

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
  });

  afterEach(() => {
    store.close();
  });

  describe("Crash Recovery & In-Flight State Cleanup", () => {
    it("cleans up incomplete in-flight activating state on daemon restart", async () => {
      const timestamp = new Date().toISOString();

      // Insert an incomplete in-flight activating deployment record
      store.conn.run(
        `INSERT INTO deployment_records (
          deployment_id, workspace_id, tool_id, tool_version, state, history_json, active_traffic_percentage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'activating', '[]', 0, ?, ?);`,
        ["dep_inflight", "ws-crash", "crashed-tool", "2.0.0", timestamp, timestamp],
      );

      const result = await reconciler.reconcile({ workspaceId: "ws-crash" });

      expect(
        result.actions.some((a) => a.action === "rolled_back" && a.toolId === "crashed-tool"),
      ).toBe(true);

      const depRow = store.conn.get<{ state: string }>(
        "SELECT state FROM deployment_records WHERE deployment_id = ?;",
        ["dep_inflight"],
      );
      expect(depRow?.state).toBe("rolled_back");
    });

    it("finalizes in-flight rolling_back state to rolled_back", async () => {
      const timestamp = new Date().toISOString();

      store.conn.run(
        `INSERT INTO deployment_records (
          deployment_id, workspace_id, tool_id, tool_version, state, history_json, active_traffic_percentage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'rolling_back', '[]', 0, ?, ?);`,
        ["dep_rb_inflight", "ws-crash-rb", "rb-tool", "2.0.0", timestamp, timestamp],
      );

      const result = await reconciler.reconcile({ workspaceId: "ws-crash-rb" });

      expect(result.actions.some((a) => a.action === "rolled_back" && a.toolId === "rb-tool")).toBe(
        true,
      );

      const depRow = store.conn.get<{ state: string }>(
        "SELECT state FROM deployment_records WHERE deployment_id = ?;",
        ["dep_rb_inflight"],
      );
      expect(depRow?.state).toBe("rolled_back");
    });
  });

  describe("User Overrides Enforcement", () => {
    it("suspends disabled tools even if desired state specifies them as active", async () => {
      const manifest = createSampleToolManifest("user-disabled", "1.0.0");
      await activator.stageTool(manifest);
      await activator.activate({
        workspaceId: "ws-ov",
        toolId: "user-disabled",
        version: "1.0.0",
      });

      // User override disables the tool
      const result = await reconciler.reconcile({
        workspaceId: "ws-ov",
        overrides: [
          {
            toolId: "user-disabled",
            workspaceId: "ws-ov",
            action: "disable",
            isEnabled: false,
          },
        ],
        desiredTools: {
          "user-disabled": { version: "1.0.0" },
        },
      });

      expect(result.suspendedTools).toContain("user-disabled");
      expect(result.activeTools["user-disabled"]).toBeUndefined();
    });

    it("restores pinned version and skips newer cloud desired version", async () => {
      // Stage v1 and v2
      const v1 = createSampleToolManifest("pinned-tool", "1.0.0");
      const v2 = createSampleToolManifest("pinned-tool", "2.0.0");
      await activator.stageTool(v1);
      await activator.stageTool(v2);

      // Initially activate v2
      await activator.activate({ workspaceId: "ws-pin", toolId: "pinned-tool", version: "2.0.0" });

      // Reconcile with user pin to 1.0.0 while cloud desires 2.0.0
      const result = await reconciler.reconcile({
        workspaceId: "ws-pin",
        overrides: [
          {
            toolId: "pinned-tool",
            workspaceId: "ws-pin",
            action: "pin",
            pinnedVersion: "1.0.0",
            isEnabled: true,
          },
        ],
        desiredTools: {
          "pinned-tool": { version: "2.0.0" },
        },
      });

      expect(result.activeTools["pinned-tool"]).toBe("1.0.0");
      expect(
        result.actions.some(
          (a) => a.toolId === "pinned-tool" && a.action === "activated" && a.version === "1.0.0",
        ),
      ).toBe(true);
    });
  });

  describe("Capability Envelope Compliance", () => {
    it("suspends active tools that violate a tightened workspace capability envelope", async () => {
      // Tool requires net outbound
      const manifest = createSampleToolManifest("net-active", "1.0.0", {
        capabilities: {
          net: {
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedHosts: [],
            allowedPorts: [443],
            allowedProtocols: ["https"],
            allowLocalhost: false,
            denyPrivateRanges: true,
          },
        },
      });
      await activator.stageTool(manifest);
      await activator.activate({ workspaceId: "ws-tight", toolId: "net-active", version: "1.0.0" });

      // Tightened envelope disallows outbound network
      const tightenedEnvelope = createSampleCapabilityEnvelope("ws-tight", {
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

      const result = await reconciler.reconcile({
        workspaceId: "ws-tight",
        envelope: tightenedEnvelope,
      });

      expect(result.suspendedTools).toContain("net-active");
      expect(result.activeTools["net-active"]).toBeUndefined();
    });
  });

  describe("Desired State Cloud Reconciliation", () => {
    it("downloads and activates missing tools from cloud desired state", async () => {
      const manifest = createSampleToolManifest("cloud-tool", "1.0.0");
      const { archiveBuffer, digest } = createSignedTestBundle(manifest);

      const downloadClient = new ArtifactTransferClient({
        downloadHandler: async (reqDigest) => {
          if (reqDigest === digest) return archiveBuffer;
          throw new Error("Not found");
        },
      });

      const cloudReconciler = new DeploymentReconciler({
        conn: store.conn,
        activator,
        preactivation,
        client: downloadClient,
      });

      const result = await cloudReconciler.reconcile({
        workspaceId: "ws-cloud",
        desiredTools: {
          "cloud-tool": { version: "1.0.0", digest },
        },
      });

      expect(result.activeTools["cloud-tool"]).toBe("1.0.0");
      expect(result.appliedActionsCount).toBeGreaterThanOrEqual(1);
    });

    it("skips tools that are already active at the desired version", async () => {
      const manifest = createSampleToolManifest("synced-tool", "1.0.0");
      await activator.stageTool(manifest);
      await activator.activate({
        workspaceId: "ws-sync",
        toolId: "synced-tool",
        version: "1.0.0",
      });

      const result = await reconciler.reconcile({
        workspaceId: "ws-sync",
        desiredTools: {
          "synced-tool": { version: "1.0.0" },
        },
      });

      expect(result.activeTools["synced-tool"]).toBe("1.0.0");
      const skipAction = result.actions.find((a) => a.toolId === "synced-tool");
      expect(skipAction?.status).toBe("skipped");
    });
  });
});
