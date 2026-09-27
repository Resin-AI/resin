import {
  type AccountToolAccessResponse,
  AccountToolAccessResponseSchema,
  type CatalogSnapshotResponse,
  PROTOCOL_VERSION,
} from "@resin/protocol";
import {
  type CatalogSnapshotFetchResult,
  type CloudCatalogClient,
  type CloudIdentityProvider,
  type CloudRequestIdentity,
  verifyCatalogSnapshot,
} from "./client.js";
import type { DeviceSyncEntry, DeviceSyncScope, DeviceSyncStore } from "./device-sync-store.js";

const CATALOG_KIND = "catalog-snapshot";
const TOOL_ACCESS_KIND = "tool-access";

export interface SharedCloudSyncOptions {
  store: DeviceSyncStore;
  client: CloudCatalogClient;
  identityProvider: CloudIdentityProvider;
  /** Reports a shared-cache write that failed; the sync itself still succeeds. */
  onError?: (error: Error) => void;
}

export interface SharedCatalogRequest {
  /** The snapshot this gateway holds, if any. */
  current?: CatalogSnapshotResponse;
  /** How old a peer's answer may be and still be served; the gateway's sync interval. */
  maxAgeMs: number;
  /** Only serve a peer answer whose cloud request started after this call. */
  fresh?: boolean;
}

/**
 * Everything the cloud's answer depends on. Gateways of one login on one device share all of it;
 * a different cloud, account, user, workspace, device, installation or protocol never matches.
 */
function scopeOf(identity: CloudRequestIdentity): DeviceSyncScope {
  return {
    cloudUrl: identity.cloudUrl.replace(/\/+$/, ""),
    accountId: identity.accountId,
    userId: identity.userId,
    workspaceId: identity.workspaceId,
    deviceId: identity.deviceId,
    installationId: identity.installationId,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Lets every gateway of one OS user share a single catalog snapshot and tool-access answer per
 * sync interval. One gateway calls the cloud and publishes the answer through the
 * {@link DeviceSyncStore}; the others read it. A gateway never serves its own publication, so a
 * gateway without peers calls the cloud on every sync exactly as before.
 */
export class SharedCloudSync {
  private readonly store: DeviceSyncStore;
  private readonly client: CloudCatalogClient;
  private readonly identityProvider: CloudIdentityProvider;
  private readonly onError?: (error: Error) => void;
  /** Body version this instance last published; unchanged answers then only refresh the entry. */
  private publishedBodyVersion?: string;

  constructor(options: SharedCloudSyncOptions) {
    this.store = options.store;
    this.client = options.client;
    this.identityProvider = options.identityProvider;
    this.onError = options.onError;
  }

  /**
   * Account tool access. A failed request (null: unknown) is never shared, so each gateway still
   * decides for itself when the cloud cannot be reached.
   */
  async fetchToolAccess(
    expected: Pick<CloudRequestIdentity, "cloudUrl" | "accountId" | "userId"> | undefined,
    maxAgeMs: number,
  ): Promise<AccountToolAccessResponse | null> {
    const identity = await this.currentIdentity();
    if (!identity) return await this.client.fetchToolAccess(expected);
    if (
      expected &&
      (identity.cloudUrl !== expected.cloudUrl ||
        identity.accountId !== expected.accountId ||
        identity.userId !== expected.userId)
    ) {
      return null;
    }
    const scope = scopeOf(identity);
    const requestedAt = this.store.now();
    return await this.store.coordinate<AccountToolAccessResponse | null>({
      kind: TOOL_ACCESS_KIND,
      scope,
      notBefore: requestedAt - maxAgeMs,
      fromPeer: (entry) => {
        const parsed = AccountToolAccessResponseSchema.safeParse(entry.payload);
        if (
          !parsed.success ||
          parsed.data.accountId !== identity.accountId ||
          parsed.data.userId !== identity.userId
        ) {
          return undefined;
        }
        return parsed.data;
      },
      fetch: async () => {
        const fetchedAt = this.store.now();
        const response = await this.client.fetchToolAccess(expected);
        if (response) {
          this.publish(TOOL_ACCESS_KIND, scope, { fetchedAt, payload: response });
        }
        return response;
      },
    });
  }

  /**
   * Catalog snapshot relative to `current`: `unchanged` when the shared or fetched version is the
   * one this gateway holds, otherwise the verified full snapshot. When the cloud answers
   * `unchanged` for a version other than the one requested, nothing is published and that answer
   * is returned as-is for the caller's protocol guard.
   */
  async fetchCatalog(request: SharedCatalogRequest): Promise<CatalogSnapshotFetchResult> {
    const { current } = request;
    const requestedAt = this.store.now();
    const identity = await this.currentIdentity();
    if (!identity) {
      return await this.client.fetchCatalogSnapshotResult({
        currentVersion: current?.snapshotVersion,
        acceptUnchanged: true,
      });
    }
    const scope = scopeOf(identity);
    const relativeToCurrent = (snapshot: CatalogSnapshotResponse): CatalogSnapshotFetchResult =>
      current && current.snapshotVersion === snapshot.snapshotVersion
        ? { kind: "unchanged", snapshotVersion: snapshot.snapshotVersion }
        : { kind: "snapshot", snapshot };

    return await this.store.coordinate<CatalogSnapshotFetchResult>({
      kind: CATALOG_KIND,
      scope,
      notBefore: request.fresh ? requestedAt : requestedAt - request.maxAgeMs,
      fromPeer: (entry) => {
        if (!entry.version) return undefined;
        if (current && entry.version === current.snapshotVersion) {
          return { kind: "unchanged", snapshotVersion: entry.version };
        }
        const snapshot = this.readSharedSnapshot(scope, entry);
        return snapshot ? { kind: "snapshot", snapshot } : undefined;
      },
      fetch: async (previous) => {
        const fetchedAt = this.store.now();
        // Only offer the cloud a version this gateway can prove it holds: its own snapshot, or the
        // last shared one after re-verifying it.
        const base = current ?? (previous ? this.readSharedSnapshot(scope, previous) : undefined);
        const result = await this.client.fetchCatalogSnapshotResult({
          currentVersion: base?.snapshotVersion,
          acceptUnchanged: base !== undefined,
        });
        let latest: CatalogSnapshotResponse;
        if (result.kind === "snapshot") {
          latest = result.snapshot;
        } else if (base && result.snapshotVersion === base.snapshotVersion) {
          latest = base;
        } else {
          return result;
        }
        const needsBody =
          this.publishedBodyVersion !== latest.snapshotVersion ||
          previous?.version !== latest.snapshotVersion;
        const published = this.publish(
          CATALOG_KIND,
          scope,
          { fetchedAt, version: latest.snapshotVersion },
          needsBody ? { version: latest.snapshotVersion, value: latest } : undefined,
        );
        if (published && needsBody) this.publishedBodyVersion = latest.snapshotVersion;
        return relativeToCurrent(latest);
      },
    });
  }

  private readSharedSnapshot(
    scope: DeviceSyncScope,
    entry: DeviceSyncEntry,
  ): CatalogSnapshotResponse | undefined {
    if (!entry.version) return undefined;
    const body = this.store.readBody(CATALOG_KIND, scope, entry.version);
    if (body === undefined) return undefined;
    try {
      // The file is re-verified like a cloud response: schema, checksum and manifest digests.
      const snapshot = verifyCatalogSnapshot(body);
      return snapshot.snapshotVersion === entry.version ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  private publish(
    kind: string,
    scope: DeviceSyncScope,
    record: { fetchedAt: number; version?: string; payload?: unknown },
    body?: { version: string; value: unknown },
  ): boolean {
    try {
      // Never replace an answer whose cloud request started after this one (a stale-lock takeover
      // can leave two fetches in flight); peers must not step back to older data.
      const existing = this.store.read(kind, scope);
      if (
        existing &&
        existing.writer !== this.store.writerId &&
        existing.fetchedAt > record.fetchedAt
      ) {
        return false;
      }
      this.store.write(kind, scope, record, body);
      return true;
    } catch (error) {
      // A peer must not keep serving the answer this write meant to replace.
      this.store.remove(kind, scope);
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private async currentIdentity(): Promise<CloudRequestIdentity | null> {
    try {
      return await this.identityProvider();
    } catch {
      return null;
    }
  }
}
