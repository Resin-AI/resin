import type {
  CatalogSnapshot,
  DeploymentRecord,
  NormalizedSessionEvent,
  ToolManifest,
} from "@resin/contracts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  RefreshResult,
} from "@resin/harness-contracts";
import type {
  ArtifactDownloadMetadata,
  ArtifactDownloadRequest,
  CatalogSnapshotRequest,
  CatalogSnapshotResponse,
  DeploymentStatusReportRequest,
  DeploymentStatusReportResponse,
  DeviceAuthBootstrapRequest,
  DeviceAuthBootstrapResponse,
  HealthNegotiateRequest,
  HealthNegotiateResponse,
  InstallationRegisterRequest,
  InstallationRegisterResponse,
  ObservationBatchRequest,
  ObservationBatchResponse,
  StreamMessage,
} from "@resin/protocol";
import { describe, expect, it } from "vitest";
import {
  type ApiHandlerClient,
  type RegistryAdapter,
  type StorageAdapter,
  type StreamProtocolAdapter,
  defineAdapterSuite,
  defineApiHandlerSuite,
  defineRegistrySuite,
  defineStorageRoundTripSuite,
  defineStreamProtocolSuite,
} from "../src/consumer-suites.js";
import {
  validArtifactDownloadMetadata,
  validCatalogSnapshotResponse,
  validDeploymentStatusReportResponse,
  validDeviceAuthBootstrapResponse,
  validHealthNegotiateResponse,
  validInstallationRegisterResponse,
  validObservationBatchResponse,
} from "../src/golden/protocol.js";

describe("Consumer Test Suites", () => {
  describe("Storage Round-Trip Suite", () => {
    it("runs successfully against an in-memory StorageAdapter", async () => {
      const storageState = {
        events: new Map<string, NormalizedSessionEvent[]>(),
        tools: new Map<string, ToolManifest>(),
        deployments: new Map<string, DeploymentRecord>(),
      };

      const mockStorage: StorageAdapter = {
        async saveSessionEvents(sessionId, events) {
          storageState.events.set(sessionId, [...events]);
        },
        async getSessionEvents(sessionId) {
          return storageState.events.get(sessionId) || [];
        },
        async saveToolManifest(manifest) {
          storageState.tools.set(manifest.id, manifest);
        },
        async getToolManifest(id) {
          return storageState.tools.get(id) || null;
        },
        async saveDeployment(deployment) {
          storageState.deployments.set(deployment.deploymentId, deployment);
        },
        async getDeployment(id) {
          return storageState.deployments.get(id) || null;
        },
      };

      const suite = defineStorageRoundTripSuite({
        createAdapter: async () => mockStorage,
      });

      await expect(suite()).resolves.toBeUndefined();
    });
  });

  describe("API Handler Suite", () => {
    it("runs successfully against a compliant ApiHandlerClient", async () => {
      const mockClient: ApiHandlerClient = {
        async registerInstallation(
          req: InstallationRegisterRequest,
        ): Promise<InstallationRegisterResponse> {
          return {
            ...validInstallationRegisterResponse,
            installationId: req.installationId,
          };
        },
        async bootstrapDevice(
          _req: DeviceAuthBootstrapRequest,
        ): Promise<DeviceAuthBootstrapResponse> {
          return validDeviceAuthBootstrapResponse;
        },
        async pushObservations(req: ObservationBatchRequest): Promise<ObservationBatchResponse> {
          return {
            ...validObservationBatchResponse,
            batchId: req.batchId,
          };
        },
        async fetchCatalogSnapshot(_req: CatalogSnapshotRequest): Promise<CatalogSnapshotResponse> {
          return validCatalogSnapshotResponse;
        },
        async downloadArtifact(req: ArtifactDownloadRequest): Promise<ArtifactDownloadMetadata> {
          return {
            ...validArtifactDownloadMetadata,
            digest: req.digest,
          };
        },
        async reportDeploymentStatus(
          req: DeploymentStatusReportRequest,
        ): Promise<DeploymentStatusReportResponse> {
          return {
            ...validDeploymentStatusReportResponse,
            acknowledged: true,
            syncCommands: req.deployments.map((d) => ({
              deploymentId: d.deploymentId,
              action: "continue",
            })),
          };
        },
        async negotiateHealth(_req: HealthNegotiateRequest): Promise<HealthNegotiateResponse> {
          return validHealthNegotiateResponse;
        },
        async sendRawRequest(_method, _path, _body) {
          return { status: 400, data: { error: "bad_request" } };
        },
      };

      const suite = defineApiHandlerSuite({
        createClient: async () => mockClient,
      });

      await expect(suite()).resolves.toBeUndefined();
    });
  });

  describe("Adapter Conformance Suite", () => {
    it("runs successfully against a compliant HarnessAdapter", async () => {
      const mockAdapter: HarnessAdapter = {
        id: "mock-harness",
        version: "1.0.0",
        async probeInstallation(): Promise<HarnessInstallation> {
          return {
            harnessId: "mock-harness",
            displayName: "Mock Harness",
            version: "1.0.0",
            isInstalled: true,
            status: "ready",
            detectedAt: new Date().toISOString(),
            metadata: {},
          };
        },
        async listWorkspaces(): Promise<HarnessWorkspace[]> {
          return [];
        },
        async listSessions(): Promise<HarnessSession[]> {
          return [];
        },
        getCapabilities(): AdapterCapabilities {
          return {
            refresh: {
              supportsNativeListChange: true,
              supportsContextNudge: true,
              requiresSessionRestart: false,
            },
            fidelity: {
              transcriptAvailability: "stream",
              toolCallVisibility: "full",
              toolResultVisibility: "full",
              subagentVisibility: "full",
              mcpListChange: "supported",
              contextNudge: "supported",
              overallScore: 100,
            },
            supportedTransports: ["stdio"],
            supportsMultiWorkspace: true,
            supportsConcurrentSessions: true,
            features: {},
          };
        },
        async notifyCatalogRefresh(): Promise<RefreshResult> {
          return {
            outcome: "context_nudge",
            appliedAt: new Date().toISOString(),
            message: "Refreshed",
            catalogVersion: "1.0.0",
            affectedToolCount: 1,
            requiresRestart: false,
            details: {},
          };
        },
      };

      const suite = defineAdapterSuite({
        createAdapter: async () => mockAdapter,
      });

      await expect(suite()).resolves.toBeUndefined();
    });
  });

  describe("Registry Suite", () => {
    it("runs successfully against a compliant RegistryAdapter", async () => {
      const tools = new Map<string, ToolManifest>();

      const mockRegistry: RegistryAdapter = {
        async registerTool(manifest) {
          tools.set(manifest.id, manifest);
        },
        async getTool(toolId) {
          return tools.get(toolId) || null;
        },
        async createSnapshot(): Promise<CatalogSnapshot> {
          const toolSummaries: Record<
            string,
            {
              toolId: string;
              version: string;
              manifestDigest: string;
              scope: "workspace";
              status: "active";
            }
          > = {};
          for (const t of tools.values()) {
            toolSummaries[t.id] = {
              toolId: t.id,
              version: t.version,
              manifestDigest: t.digest,
              scope: "workspace",
              status: "active",
            };
          }
          return {
            snapshotId: "snap_001",
            workspaceId: "ws_001",
            timestamp: new Date().toISOString(),
            tools: toolSummaries,
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          };
        },
      };

      const suite = defineRegistrySuite({
        createRegistry: async () => mockRegistry,
      });

      await expect(suite()).resolves.toBeUndefined();
    });
  });

  describe("Stream Protocol Suite", () => {
    it("runs successfully against a compliant StreamProtocolAdapter", async () => {
      let connected = false;

      const mockStream: StreamProtocolAdapter = {
        async connect() {
          connected = true;
        },
        async disconnect() {
          connected = false;
        },
        isConnected() {
          return connected;
        },
        async sendMessage(_msg: StreamMessage) {},
        async receiveMessage(): Promise<StreamMessage> {
          return {
            messageId: "msg_srv_001",
            sequence: 1,
            timestamp: new Date().toISOString(),
            payload: {
              type: "server.heartbeat_ack",
              sequence: 1,
              serverTime: new Date().toISOString(),
              timestamp: new Date().toISOString(),
            },
          };
        },
      };

      const suite = defineStreamProtocolSuite({
        createStream: async () => mockStream,
      });

      await expect(suite()).resolves.toBeUndefined();
    });
  });
});
