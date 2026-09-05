import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ToolManifest,
  ToolManifestSchema,
  ToolVersionSchema,
  type V1LockedToolEntry,
  hashCanonicalContent,
} from "@resin/contracts";
import { createInMemoryStateStore } from "@resin/db";
import { CloudCredentialStore } from "@resin/observer";
import type { AccountToolAccessResponse, CatalogSnapshotResponse } from "@resin/protocol";
import { ArtifactCache } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient, type CloudRequestIdentity } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { createProductionProxyRuntime } from "../../src/proxy/runtime.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ManagedToolAccess } from "../../src/proxy/tool-access.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { resolveWorkspaceContext } from "../../src/workspace-resolver.js";

const identity: CloudRequestIdentity = {
  cloudUrl: "https://cloud.example.test",
  accountId: "account-a",
  userId: "user-a",
  workspaceId: "workspace-a",
  deviceId: "device-a",
  installationId: "installation-a",
  accessToken: "token-a",
};
const confirmation = (
  toolAccess: AccountToolAccessResponse["toolAccess"],
): AccountToolAccessResponse => ({
  schemaVersion: "1.0.0",
  accountId: identity.accountId,
  userId: identity.userId,
  toolAccess,
});
const toolId = "33333333-3333-4333-8333-333333333333";
const projectId = "11111111-1111-4111-8111-111111111111";

function manifest(id = toolId, name = "managed"): ToolManifest {
  const tool = ToolManifestSchema.parse({
    id,
    name,
    version: "1.0.0",
    description: name,
    parameters: {},
    runtime: { runtime: "node" },
    capabilities: {},
    digest: "0".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
    metadata: {
      source: "registry",
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      artifactDigest: "a".repeat(64),
    },
  });
  tool.digest = computeManifestDigest(tool);
  return tool;
}
function entry(tool: ToolManifest): V1LockedToolEntry {
  return {
    toolId: tool.id,
    name: tool.name,
    version: tool.version,
    manifestDigest: computeManifestDigest(tool),
    artifactDigest: "a".repeat(64),
    status: "active",
  };
}
function snapshot(tools: ToolManifest[]): CatalogSnapshotResponse {
  return {
    snapshotVersion: "one",
    generatedAt: "2026-09-01T00:00:00.000Z",
    tools,
    activeDeployments: [],
    checksum: hashCanonicalContent({ tools, activeDeployments: [] }),
  };
}

let root: string;
let artifactCache: ArtifactCache;
let access: ManagedToolAccess;
let registry: ToolRegistry;
beforeEach(() => {
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-tool-access-"));
  artifactCache = new ArtifactCache({ cacheDir: path.join(root, "artifacts") });
  access = new ManagedToolAccess(path.join(root, "access"), artifactCache, identity);
  registry = new ToolRegistry({ autoHydrate: false });
  registry.setManagedToolAccess(access);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
function cacheTool(tool: ToolManifest): void {
  const target = artifactCache.getArtifactPath(entry(tool).artifactDigest);
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(tool));
  fs.writeFileSync(path.join(target, "src", "index.js"), "export default () => 'managed';");
  expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
}
function register(tool: ToolManifest): void {
  registry.registerToolSync({
    ...entry(tool),
    manifest: tool,
    scope: "workspace",
    workspaceId: identity.workspaceId,
    handler: async () => ({ content: [{ type: "text", text: tool.name }] }),
  });
}
function coordinator(
  fetchFn: typeof fetch,
  lockManager?: ProjectLockManager,
): CloudCatalogSyncCoordinator {
  const client = new CloudCatalogClient({
    identityProvider: async () => identity,
    workspaceId: identity.workspaceId,
    deviceId: identity.deviceId,
    fetchFn,
  });
  return new CloudCatalogSyncCoordinator({
    client,
    cache: new CloudCatalogCache(),
    router: new CloudInvocationRouter(),
    registry,
    artifactCache,
    managedToolAccess: access,
    workspaceId: identity.workspaceId,
    lockManager,
  });
}

describe("Positive tool-access confirmation", () => {
  it.each([
    [
      "unauthorized",
      () => new Response(JSON.stringify(confirmation("subscription_inactive")), { status: 401 }),
    ],
    [
      "product forbidden",
      () => new Response(JSON.stringify(confirmation("subscription_inactive")), { status: 403 }),
    ],
    ["old server", () => new Response("not found", { status: 404 })],
    ["server error", () => new Response("failed", { status: 503 })],
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "/login" } })],
    [
      "non-final success",
      () => new Response(JSON.stringify(confirmation("subscription_inactive")), { status: 202 }),
    ],
    ["malformed JSON", () => new Response("{")],
    ["wrong schema", () => Response.json({ toolAccess: "subscription_inactive" })],
    [
      "wrong account",
      () => Response.json({ ...confirmation("subscription_inactive"), accountId: "other" }),
    ],
    [
      "wrong user",
      () => Response.json({ ...confirmation("subscription_inactive"), userId: "other" }),
    ],
    [
      "offline",
      () => {
        throw new TypeError("offline");
      },
    ],
    [
      "timeout",
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ],
  ] as const)("preserves cached tools on %s", async (_name, response) => {
    const tool = manifest();
    cacheTool(tool);
    register(tool);
    const sync = coordinator(async () => response());
    await sync.checkToolAccess();
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeDefined();
    expect(access.isInactive()).toBe(false);
  });

  it("uses authenticated no-store/no-redirect proof and keeps active tools unchanged", async () => {
    const tool = manifest();
    cacheTool(tool);
    register(tool);
    let seen: RequestInit | undefined;
    const sync = coordinator(async (_url, init) => {
      seen = init;
      return Response.json(confirmation("allowed"));
    });
    await sync.checkToolAccess();
    expect(new Headers(seen?.headers).get("authorization")).toBe("Bearer token-a");
    expect(seen?.redirect).toBe("error");
    expect(new Headers(seen?.headers).get("cache-control")).toBe("no-store");
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeDefined();
  });

  it("rejects an origin switch and an identity change while a response is in flight", async () => {
    const switched = { ...identity, cloudUrl: "https://different.example.test" };
    const client = new CloudCatalogClient({
      identityProvider: async () => switched,
      fetchFn: async () => Response.json(confirmation("subscription_inactive")),
    });
    expect(await client.fetchToolAccess(identity)).toBeNull();
    let calls = 0;
    const changing = new CloudCatalogClient({
      identityProvider: async () => (++calls === 1 ? identity : switched),
      fetchFn: async () => Response.json(confirmation("subscription_inactive")),
    });
    expect(await changing.fetchToolAccess(identity)).toBeNull();
  });
});

describe("Managed removal and restart protection", () => {
  it("adopts pre-upgrade cloud ownership, removes only matching lock/cache entries and blocks saved handlers", async () => {
    const tool = manifest();
    const local = manifest("44444444-4444-4444-8444-444444444444", "user_authored");
    local.metadata = {};
    local.digest = computeManifestDigest(local);
    const manager = new ProjectLockManager({ lockPath: path.join(root, "project"), projectId });
    manager.reconcileQualified(entry(tool));
    manager.reconcileQualified({ ...entry(local), artifactDigest: "b".repeat(64) });
    cacheTool(tool);
    await artifactCache.addReference(entry(tool).artifactDigest, {
      refId: `${projectId}:${tool.name}`,
      toolId: tool.id,
      version: tool.version,
    });
    fs.writeFileSync(path.join(root, "project", "user.txt"), "keep me");
    register(tool);
    register(local);
    const saved = (await registry.getTool(tool.id, identity.workspaceId))!.handler!;
    const context = resolveWorkspaceContext({ cwd: root, disableBootstrap: true });
    const sync = coordinator(
      async () => Response.json(confirmation("subscription_inactive")),
      manager,
    );
    await sync.checkToolAccess();
    await sync.checkToolAccess();
    expect(manager.read().tools[tool.name]).toBeUndefined();
    expect(manager.read().tools[local.name]).toBeDefined();
    expect(fs.readFileSync(path.join(root, "project", "user.txt"), "utf8")).toBe("keep me");
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeUndefined();
    expect(await registry.getTool(local.id, identity.workspaceId)).toBeDefined();
    await expect(saved(context, {})).rejects.toThrow();
    const restarted = new ManagedToolAccess(access.stateDir, artifactCache);
    expect(restarted.isBlocked(entry(tool))).toBe(true);
    access.confirm(confirmation("allowed"));
    expect(access.isBlocked(entry(tool))).toBe(true); // renewal alone is not activation
    access.record(entry(tool), identity.workspaceId, manager);
    register(tool);
    expect(access.isBlocked(entry(tool))).toBe(false);
    await expect(saved(context, {})).rejects.toThrow();
  });

  it("preserves other-account and shared references without granting the denied account invocation", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool), identity.workspaceId);
    const otherIdentity = { ...identity, accountId: "account-b", userId: "user-b" };
    const other = new ManagedToolAccess(access.stateDir, artifactCache, otherIdentity);
    other.record(entry(tool), "other-workspace");
    other.confirm({
      ...confirmation("allowed"),
      accountId: otherIdentity.accountId,
      userId: otherIdentity.userId,
    });
    await artifactCache.addReference(entry(tool).artifactDigest, {
      refId: "user-local",
      toolId: "local",
    });
    access.confirm(confirmation("subscription_inactive"));
    await access.cleanup(registry);
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
    expect(
      (await artifactCache.getReferences(entry(tool).artifactDigest)).map((ref) => ref.refId),
    ).toEqual(["user-local"]);
    expect(access.isBlocked(entry(tool))).toBe(true);
    expect(other.isBlocked(entry(tool))).toBe(false);
  });

  it("does not let a stale in-memory denial override another process's renewal", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool));
    access.confirm(confirmation("subscription_inactive"));
    const other = new ManagedToolAccess(access.stateDir, artifactCache, identity);
    other.confirm(confirmation("allowed"));
    other.record(entry(tool));
    await access.cleanup();
    expect(access.isInactive()).toBe(false);
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
  });

  it("preserves artifacts on corrupt references and retries cleanup after references are repaired", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool));
    access.confirm(confirmation("subscription_inactive"));
    fs.writeFileSync(artifactCache.refsFilePath, "{");
    await expect(access.cleanup()).rejects.toThrow();
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
    fs.writeFileSync(artifactCache.refsFilePath, "{}");
    await access.cleanup();
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
  });

  it("removes owned SQLite metadata despite unrelated corrupt snapshots and cannot rehydrate it", async () => {
    const store = await createInMemoryStateStore();
    try {
      const tool = manifest();
      const local = manifest("55555555-5555-4555-8555-555555555555", "local");
      local.metadata = {};
      local.digest = computeManifestDigest(local);
      for (const current of [tool, local]) {
        await store.tools.saveToolVersion(
          ToolVersionSchema.parse({
            toolId: current.id,
            version: current.version,
            manifest: current,
            manifestDigest: `sha256:${computeManifestDigest(current)}`,
            artifactDigest: `sha256:${entry(current).artifactDigest}`,
            artifact: {
              artifactDigest: `sha256:${entry(current).artifactDigest}`,
              bundleReference: {
                uri: "embedded:tool",
                hash: entry(current).artifactDigest,
                sizeBytes: 32,
                format: "embedded",
              },
              entrypoint: "tool.js",
              sourceCode: `export default () => '${current.name}';`,
            },
            provenance: {
              synthesizedAt: current.createdAt,
              synthesizerModel: "fixture",
              deterministicBuildHash: "0".repeat(64),
            },
            status: "active",
            createdAt: current.createdAt,
            createdBy: "fixture",
          }),
        );
      }
      store.conn.run(
        "INSERT INTO catalog_snapshots(snapshot_id, workspace_id, timestamp, tools_json, digest) VALUES (?, ?, ?, ?, ?);",
        ["corrupt", "unrelated", tool.createdAt, "{", "0".repeat(64)],
      );
      registry = new ToolRegistry({ db: store, autoHydrate: false });
      registry.setManagedToolAccess(access);
      await coordinator(async () =>
        Response.json(confirmation("subscription_inactive")),
      ).checkToolAccess();
      expect(await store.tools.getManifest(tool.id)).toBeNull();
      expect(await store.tools.getManifest(local.id)).not.toBeNull();
      await registry.hydrateFromStore();
      expect(await registry.getTool(tool.id)).toBeUndefined();
      expect(await store.tools.getToolVersion(tool.id, tool.version)).toBeNull();
      expect(
        (await store.tools.getToolVersion(local.id, local.version))?.artifact.sourceCode,
      ).toContain(local.name);
      expect(await registry.getTool(local.id)).toBeDefined();
      expect(
        store.conn.get<{ tools_json: string }>(
          "SELECT tools_json FROM catalog_snapshots WHERE snapshot_id = ?;",
          ["corrupt"],
        )?.tools_json,
      ).toBe("{");
    } finally {
      store.close();
    }
  });

  it("releases the shared lease when a sync fails so later confirmed cleanup can proceed", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool));
    vi.spyOn(access, "adopt").mockImplementationOnce(() => {
      throw new Error("read failure");
    });
    const sync = coordinator(async () => Response.json(confirmation("subscription_inactive")));
    await expect(sync.checkToolAccess()).rejects.toThrow("read failure");
    await sync.checkToolAccess();
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
  });

  it("serializes competing synchronizers while catalog work is in flight, then removes its result", async () => {
    const tool = manifest();
    const pending = Promise.withResolvers<CatalogSnapshotResponse>();
    const started = Promise.withResolvers<void>();
    const firstClient = new CloudCatalogClient({
      workspaceId: identity.workspaceId,
      deviceId: identity.deviceId,
      identityProvider: async () => identity,
      fetchFn: async () => Response.json(confirmation("allowed")),
      snapshotFetcher: async () => {
        started.resolve();
        return pending.promise;
      },
    });
    const first = new CloudCatalogSyncCoordinator({
      client: firstClient,
      cache: new CloudCatalogCache(),
      router: new CloudInvocationRouter(),
      registry,
      workspaceId: identity.workspaceId,
      managedToolAccess: access,
    });
    const second = coordinator(async () => Response.json(confirmation("subscription_inactive")));
    const running = first.sync();
    await started.promise;
    await second.checkToolAccess(); // cannot interleave with the first process's lease
    pending.resolve(snapshot([tool]));
    await running;
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeDefined();
    await second.checkToolAccess();
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeUndefined();
    await first.sync();
    // The first client's explicit allowed proof can restore only through its normal catalog sync.
    expect(access.isInactive()).toBe(false);
  });

  it("production probes before forbidden project registration and keeps probing when product sync is disabled", async () => {
    const tool = manifest();
    register(tool);
    cacheTool(tool);
    const store = new CloudCredentialStore({ resinHome: path.join(root, "resin-home") });
    vi.spyOn(store, "load").mockResolvedValue({ status: "valid" });
    vi.spyOn(store, "getRequestIdentity").mockResolvedValue(identity);
    let accessRequests = 0;
    let state: AccountToolAccessResponse["toolAccess"] = "allowed";
    const runtime = await createProductionProxyRuntime({
      registry,
      credentialStore: store,
      resinHome: path.join(root, "resin-home"),
      artifactCache,
      fetchFn: async (url) => {
        if (String(url).endsWith("/v1/account/tool-access")) {
          accessRequests++;
          return Response.json(confirmation(state));
        }
        return new Response("forbidden", { status: 403 });
      },
    });
    fs.mkdirSync(path.join(root, "project"));
    const workspace = resolveWorkspaceContext({ cwd: path.join(root, "project") });
    await runtime.onWorkspaceReady(workspace);
    expect(runtime.isCloudEnabled).toBe(false);
    state = "subscription_inactive";
    await runtime.sync();
    await runtime.stop();
    expect(accessRequests).toBeGreaterThanOrEqual(2);
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeUndefined();
  });

  it("preserves a symlinked project lock target while removing independently owned cache bytes", async () => {
    const tool = manifest();
    const manager = new ProjectLockManager({ lockPath: path.join(root, "project"), projectId });
    manager.reconcileQualified(entry(tool));
    access.record(entry(tool), identity.workspaceId, manager);
    cacheTool(tool);
    const original = fs.readFileSync(manager.lockPath, "utf8");
    const target = path.join(root, "user-lock.json");
    fs.renameSync(manager.lockPath, target);
    fs.symlinkSync(target, manager.lockPath);
    access.confirm(confirmation("subscription_inactive"));
    await expect(access.cleanup()).rejects.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
    await expect(
      artifactCache.removeOwnedArtifactReference(
        "../user-lock.json",
        undefined,
        tool.id,
        tool.version,
      ),
    ).rejects.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("blocks cached direct execution in a credential-less cold runtime after confirmed denial", async () => {
    const tool = manifest();
    const resinHome = path.join(root, "resin-home");
    const persistent = new ManagedToolAccess(
      path.join(resinHome, "state", "managed-tool-access"),
      artifactCache,
      identity,
    );
    persistent.record(entry(tool));
    persistent.confirm(confirmation("subscription_inactive"));
    cacheTool(tool);
    const store = new CloudCredentialStore({ resinHome });
    vi.spyOn(store, "load").mockResolvedValue({ status: "missing" });
    const runtime = await createProductionProxyRuntime({
      resinHome,
      artifactCache,
      credentialStore: store,
    });
    await expect(
      runtime.executor!.execute({
        entry: entry(tool),
        parameters: {},
        context: resolveWorkspaceContext({ cwd: root, disableBootstrap: true }),
      }),
    ).rejects.toThrow("Managed tool access is unavailable");
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
  });
});
