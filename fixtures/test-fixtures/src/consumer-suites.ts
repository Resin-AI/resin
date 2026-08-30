import {
  type AuditRecord,
  type CatalogSnapshot,
  type DeploymentRecord,
  type DeviceRecord,
  type InvocationRecord,
  type NormalizedSessionEvent,
  type TelemetryRecord,
  type ToolManifest,
  type ToolVersion,
  type WorkspaceRecord,
  hashCanonicalContent,
} from "@resin/contracts";
import type {
  HarnessAdapter,
  HarnessInstallation,
  HarnessSession,
  RefreshResult,
  SessionEventSource,
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
import {
  allValidDomainEvents,
  validCatalogSnapshot,
  validDeploymentRecord,
  validToolManifest,
} from "./golden/domain.js";
import { validHarnessWorkspace } from "./golden/harness.js";
import {
  validArtifactDownloadRequest,
  validCatalogSnapshotRequest,
  validDeploymentStatusReportRequest,
  validDeviceAuthBootstrapRequest,
  validHealthNegotiateRequest,
  validInstallationRegisterRequest,
  validObservationBatchRequest,
} from "./golden/protocol.js";

/**
 * Consumer Test Suites
 *
 * Importable test suites that downstream packages can run against storage round trips,
 * API handlers, harness adapters, registries, and stream protocols.
 */

export interface TestContext {
  assert: (condition: boolean, message: string) => void;
  assertEqual: <T>(actual: T, expected: T, message?: string) => void;
}

const defaultAssert: TestContext = {
  assert(condition: boolean, message: string) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
  },
  assertEqual<T>(actual: T, expected: T, message?: string) {
    const actStr = JSON.stringify(actual);
    const expStr = JSON.stringify(expected);
    if (actStr !== expStr) {
      throw new Error(
        `Assertion failed: ${message || "values differ"}\nExpected: ${expStr}\nReceived: ${actStr}`,
      );
    }
  },
};

// ============================================================================
// 1. Storage Round-Trip Suite
// ============================================================================

export interface StorageAdapter {
  saveSessionEvents(sessionId: string, events: NormalizedSessionEvent[]): Promise<void>;
  getSessionEvents(sessionId: string): Promise<NormalizedSessionEvent[]>;
  saveToolManifest(manifest: ToolManifest): Promise<void>;
  getToolManifest(toolId: string): Promise<ToolManifest | null>;
  saveDeployment(deployment: DeploymentRecord): Promise<void>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
}

export interface StorageSuiteOptions {
  name?: string;
  createAdapter: () => Promise<StorageAdapter>;
  cleanupAdapter?: (adapter: StorageAdapter) => Promise<void>;
}

export function defineStorageRoundTripSuite(options: StorageSuiteOptions) {
  return async (ctx: TestContext = defaultAssert) => {
    const adapter = await options.createAdapter();
    try {
      // 1. Session Events Round Trip
      const sessionId = "ses_roundtrip_001";
      await adapter.saveSessionEvents(sessionId, allValidDomainEvents);
      const loadedEvents = await adapter.getSessionEvents(sessionId);

      ctx.assert(
        loadedEvents.length === allValidDomainEvents.length,
        "All session events retrieved",
      );
      for (let i = 0; i < allValidDomainEvents.length; i++) {
        const expected = allValidDomainEvents[i];
        const actual = loadedEvents[i];
        ctx.assertEqual(actual.eventId, expected.eventId, `Event ${i} ID matches`);
        ctx.assertEqual(actual.type, expected.type, `Event ${i} type matches`);
        ctx.assertEqual(actual.timestamp, expected.timestamp, `Event ${i} timestamp matches`);
        ctx.assertEqual(
          hashCanonicalContent({
            eventId: actual.eventId,
            schemaVersion: actual.schemaVersion,
            sessionId: actual.sessionId,
            timestamp: actual.timestamp,
            type: actual.type,
          }),
          hashCanonicalContent({
            eventId: expected.eventId,
            schemaVersion: expected.schemaVersion,
            sessionId: expected.sessionId,
            timestamp: expected.timestamp,
            type: expected.type,
          }),
          `Event ${i} canonical digest matches`,
        );
      }

      // 2. Tool Manifest Round Trip
      await adapter.saveToolManifest(validToolManifest);
      const loadedTool = await adapter.getToolManifest(validToolManifest.id);
      ctx.assert(loadedTool !== null, "Tool manifest retrieved");
      ctx.assertEqual(loadedTool?.id, validToolManifest.id, "Tool ID matches");
      ctx.assertEqual(loadedTool?.version, validToolManifest.version, "Tool version matches");

      // 3. Deployment Record Round Trip
      await adapter.saveDeployment(validDeploymentRecord);
      const loadedDep = await adapter.getDeployment(validDeploymentRecord.deploymentId);
      ctx.assert(loadedDep !== null, "Deployment record retrieved");
      ctx.assertEqual(
        loadedDep?.deploymentId,
        validDeploymentRecord.deploymentId,
        "Deployment ID matches",
      );
      ctx.assertEqual(loadedDep?.state, validDeploymentRecord.state, "Deployment state matches");
    } finally {
      if (options.cleanupAdapter) {
        await options.cleanupAdapter(adapter);
      }
    }
  };
}

// ============================================================================
// 2. API Handler Suite
// ============================================================================

export type RawHttpRequestBody =
  | string
  | number
  | boolean
  | null
  | undefined
  | RawHttpRequestRecord
  | RawHttpRequestBody[];

export interface RawHttpRequestRecord {
  [key: string]: RawHttpRequestBody;
}

export interface ApiHandlerClient {
  registerInstallation(req: InstallationRegisterRequest): Promise<InstallationRegisterResponse>;
  bootstrapDevice(req: DeviceAuthBootstrapRequest): Promise<DeviceAuthBootstrapResponse>;
  pushObservations(req: ObservationBatchRequest): Promise<ObservationBatchResponse>;
  fetchCatalogSnapshot(req: CatalogSnapshotRequest): Promise<CatalogSnapshotResponse>;
  downloadArtifact(req: ArtifactDownloadRequest): Promise<ArtifactDownloadMetadata>;
  reportDeploymentStatus(
    req: DeploymentStatusReportRequest,
  ): Promise<DeploymentStatusReportResponse>;
  negotiateHealth(req: HealthNegotiateRequest): Promise<HealthNegotiateResponse>;
  sendRawRequest(
    method: string,
    path: string,
    body?: RawHttpRequestBody,
  ): Promise<{ status: number; data: RawHttpRequestBody }>;
}

export interface ApiHandlerSuiteOptions {
  name?: string;
  createClient: () => Promise<ApiHandlerClient>;
  cleanupClient?: (client: ApiHandlerClient) => Promise<void>;
}

export function defineApiHandlerSuite(options: ApiHandlerSuiteOptions) {
  return async (ctx: TestContext = defaultAssert) => {
    const client = await options.createClient();
    try {
      // 1. Installation Register
      const installRes = await client.registerInstallation(validInstallationRegisterRequest);
      ctx.assertEqual(
        installRes.installationId,
        validInstallationRegisterRequest.installationId,
        "Installation ID matches",
      );

      // 2. Device Bootstrap
      const bootstrapRes = await client.bootstrapDevice(validDeviceAuthBootstrapRequest);
      ctx.assert(Boolean(bootstrapRes.deviceCode), "Bootstrap returned deviceCode");
      ctx.assert(Boolean(bootstrapRes.userCode), "Bootstrap returned userCode");

      // 3. Push Observations
      const pushRes = await client.pushObservations(validObservationBatchRequest);
      ctx.assertEqual(pushRes.batchId, validObservationBatchRequest.batchId, "Batch ID echoed");
      ctx.assert(pushRes.status === "accepted" || pushRes.status === "partial", "Push accepted");

      // 4. Catalog Snapshot
      const catalogRes = await client.fetchCatalogSnapshot(validCatalogSnapshotRequest);
      ctx.assert(Boolean(catalogRes.snapshotVersion), "Snapshot version returned");
      ctx.assert(Array.isArray(catalogRes.tools), "Catalog tools returned as array");

      // 5. Artifact Download
      const artifactRes = await client.downloadArtifact(validArtifactDownloadRequest);
      ctx.assertEqual(
        artifactRes.digest,
        validArtifactDownloadRequest.digest,
        "Artifact digest matches",
      );
      ctx.assert(Boolean(artifactRes.downloadUrl), "Download URL returned");

      // 6. Deployment Status Report
      const depRes = await client.reportDeploymentStatus(validDeploymentStatusReportRequest);
      ctx.assert(depRes.acknowledged, "Deployment status report acknowledged");
      ctx.assert(Array.isArray(depRes.syncCommands), "Sync commands returned as array");
      // 7. Health Negotiate
      const healthRes = await client.negotiateHealth(validHealthNegotiateRequest);
      ctx.assert(Boolean(healthRes.serverVersion), "Health returned server version");

      // 8. Invalid Request Rejection
      const badRes = await client.sendRawRequest("POST", "/v1/observations/batch", {
        bad: "payload",
      });
      ctx.assert(
        badRes.status >= 400 && badRes.status < 500,
        "Malformed request returns 4xx status",
      );
    } finally {
      if (options.cleanupClient) {
        await options.cleanupClient(client);
      }
    }
  };
}

// ============================================================================
// 3. Adapter Conformance Suite
// ============================================================================

export interface AdapterSuiteOptions {
  name?: string;
  createAdapter: () => Promise<HarnessAdapter>;
  cleanupAdapter?: (adapter: HarnessAdapter) => Promise<void>;
}

export function defineAdapterSuite(options: AdapterSuiteOptions) {
  return async (ctx: TestContext = defaultAssert) => {
    const adapter = await options.createAdapter();
    try {
      // 1. Probe Installation
      if (adapter.probeInstallation) {
        const installation = await adapter.probeInstallation();
        if (installation) {
          ctx.assert(Boolean(installation.harnessId), "Probe returned harnessId");
          ctx.assert(Boolean(installation.version), "Probe returned version");
          ctx.assert(Boolean(installation.status), "Probe returned status");
        }
      }

      // 2. Discover Workspaces & Sessions
      if (adapter.listWorkspaces) {
        const workspaces = await adapter.listWorkspaces();
        ctx.assert(Array.isArray(workspaces), "Workspaces returned as array");
      }

      if (adapter.listSessions) {
        const sessions = await adapter.listSessions(validHarnessWorkspace);
        ctx.assert(Array.isArray(sessions), "Sessions returned as array");
      }
      // 3. Capabilities
      if (adapter.getCapabilities) {
        const caps = adapter.getCapabilities();
        ctx.assert(Boolean(caps.refresh), "Adapter has refresh capability descriptor");
        ctx.assert(Boolean(caps.fidelity), "Adapter has fidelity capability descriptor");
        ctx.assert(Array.isArray(caps.supportedTransports), "Adapter has supported transports");
      }
    } finally {
      if (options.cleanupAdapter) {
        await options.cleanupAdapter(adapter);
      }
    }
  };
}

// ============================================================================
// 4. Registry Suite
// ============================================================================

export interface RegistryAdapter {
  registerTool(manifest: ToolManifest): Promise<void>;
  getTool(toolId: string): Promise<ToolManifest | null>;
  createSnapshot(): Promise<CatalogSnapshot>;
}

export interface RegistrySuiteOptions {
  name?: string;
  createRegistry: () => Promise<RegistryAdapter>;
  cleanupRegistry?: (registry: RegistryAdapter) => Promise<void>;
}

export function defineRegistrySuite(options: RegistrySuiteOptions) {
  return async (ctx: TestContext = defaultAssert) => {
    const registry = await options.createRegistry();
    try {
      // 1. Tool Registration
      await registry.registerTool(validToolManifest);
      const tool = await registry.getTool(validToolManifest.id);
      ctx.assert(tool !== null, "Tool registered and retrieved");
      ctx.assertEqual(tool?.id, validToolManifest.id, "Tool ID matches");

      // 2. Snapshot Generation
      const snap = await registry.createSnapshot();
      ctx.assert(Boolean(snap.snapshotId), "Snapshot has snapshotId");
      ctx.assert(Boolean(snap.digest), "Snapshot has digest");
      ctx.assert(Object.keys(snap.tools).length >= 1, "Snapshot includes registered tool");
    } finally {
      if (options.cleanupRegistry) {
        await options.cleanupRegistry(registry);
      }
    }
  };
}

// ============================================================================
// 5. Stream Protocol Suite
// ============================================================================

export interface StreamProtocolAdapter {
  connect(): Promise<void>;
  sendMessage(msg: StreamMessage): Promise<void>;
  receiveMessage(): Promise<StreamMessage>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export interface StreamSuiteOptions {
  name?: string;
  createStream: () => Promise<StreamProtocolAdapter>;
  cleanupStream?: (stream: StreamProtocolAdapter) => Promise<void>;
}

export function defineStreamProtocolSuite(options: StreamSuiteOptions) {
  return async (ctx: TestContext = defaultAssert) => {
    const stream = await options.createStream();
    try {
      await stream.connect();
      ctx.assert(stream.isConnected(), "Stream is connected");

      // Send Heartbeat
      const hbMsg: StreamMessage = {
        messageId: "msg_test_hb_001",
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: {
          type: "client.heartbeat",
          timestamp: new Date().toISOString(),
          sequence: 1,
          uptimeMs: 1000,
        },
      };
      await stream.sendMessage(hbMsg);

      // Receive ACK / response
      const reply = await stream.receiveMessage();
      ctx.assert(Boolean(reply.messageId), "Reply message received with messageId");
      ctx.assert(reply.sequence >= 1, "Reply message sequence is valid");
    } finally {
      if (stream.isConnected()) {
        await stream.disconnect();
      }
      if (options.cleanupStream) {
        await options.cleanupStream(stream);
      }
    }
  };
}
