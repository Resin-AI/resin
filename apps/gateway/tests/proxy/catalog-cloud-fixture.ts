import { type ToolManifest, ToolManifestSchema, hashCanonicalContent } from "@resin/contracts";
import {
  type AccountToolAccessResponse,
  CATALOG_CAPABILITIES_HEADER,
  CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY,
  type CatalogSnapshotResponse,
  parseCatalogCapabilities,
} from "@resin/protocol";
import type { CloudRequestIdentity } from "../../src/proxy/client.js";
import { computeManifestDigest } from "../../src/registry/validator.js";

export const identityA: CloudRequestIdentity = {
  cloudUrl: "https://cloud.example.test",
  accountId: "account-a",
  userId: "user-a",
  workspaceId: "workspace-a",
  deviceId: "device-a",
  installationId: "installation-a",
  accessToken: "token-a",
};

export function catalogTool(id: string, name: string, version = "1.0.0"): ToolManifest {
  const tool = ToolManifestSchema.parse({
    id,
    name,
    version,
    description: name,
    parameters: {},
    runtime: { runtime: "node" },
    capabilities: {},
    digest: "0".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
    metadata: { source: "registry", artifactDigest: "a".repeat(64) },
  });
  tool.digest = computeManifestDigest(tool);
  return tool;
}

export function catalogSnapshot(version: string, tools: ToolManifest[]): CatalogSnapshotResponse {
  return {
    snapshotVersion: version,
    generatedAt: "2026-09-01T00:00:00.000Z",
    tools,
    activeDeployments: [],
    checksum: hashCanonicalContent({ tools, activeDeployments: [] }),
  };
}

export interface CatalogRequestRecord {
  workspaceId: string | null;
  currentVersion: string | null;
  capabilities: string | null;
}

/**
 * An in-memory cloud that implements the `snapshot-unchanged-v1` contract for
 * `GET /v1/catalog/snapshot` and answers `GET /v1/account/tool-access`.
 */
export class FakeCatalogCloud {
  readonly catalogRequests: CatalogRequestRecord[] = [];
  toolAccessRequests = 0;
  /** Replaces the contract's unchanged answer, to model a misbehaving server. */
  unchangedOverride?: (currentVersion: string) => unknown;
  /** Holds catalog responses until released. */
  catalogGate?: Promise<void>;
  private readonly snapshots = new Map<string, CatalogSnapshotResponse>();

  constructor(snapshot: CatalogSnapshotResponse, workspaceId = identityA.workspaceId) {
    this.snapshots.set(workspaceId, snapshot);
  }

  setSnapshot(snapshot: CatalogSnapshotResponse, workspaceId = identityA.workspaceId): void {
    this.snapshots.set(workspaceId, snapshot);
  }

  readonly fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/v1/account/tool-access") {
      this.toolAccessRequests++;
      const body: AccountToolAccessResponse = {
        schemaVersion: "1.0.0",
        accountId: headers.get("x-account-id") ?? "",
        userId: headers.get("x-user-id") ?? "",
        toolAccess: "allowed",
      };
      return Response.json(body);
    }
    if (url.pathname === "/v1/catalog/snapshot") {
      const workspaceId = url.searchParams.get("workspaceId");
      const currentVersion = url.searchParams.get("currentVersion");
      const capabilities = headers.get(CATALOG_CAPABILITIES_HEADER);
      this.catalogRequests.push({ workspaceId, currentVersion, capabilities });
      if (this.catalogGate) await this.catalogGate;
      const snapshot = this.snapshots.get(workspaceId ?? "");
      if (!snapshot) return new Response(null, { status: 404, statusText: "Not Found" });
      const accepts = parseCatalogCapabilities(capabilities).has(
        CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY,
      );
      if (accepts && currentVersion) {
        if (this.unchangedOverride) return Response.json(this.unchangedOverride(currentVersion));
        if (currentVersion === snapshot.snapshotVersion) {
          return Response.json({ unchanged: true, snapshotVersion: snapshot.snapshotVersion });
        }
      }
      return Response.json(snapshot);
    }
    return new Response(null, { status: 404, statusText: "Not Found" });
  };
}
