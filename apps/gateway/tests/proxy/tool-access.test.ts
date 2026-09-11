import crypto from "node:crypto";
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
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeUndefined();
    expect(await registry.getTool(local.id, identity.workspaceId)).toBeDefined();
    await expect(saved(context, {})).rejects.toThrow();
    // Live cleanup hides tools from dispatch while retaining shared bytes until quiescent purge
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
    await access.purgeInactiveTools(registry);
    expect(manager.read().tools[tool.name]).toBeUndefined();
    expect(manager.read().tools[local.name]).toBeDefined();
    expect(fs.readFileSync(path.join(root, "project", "user.txt"), "utf8")).toBe("keep me");
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
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
    await expect(access.purgeInactiveTools()).rejects.toThrow();
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
    fs.writeFileSync(artifactCache.refsFilePath, "{}");
    await access.purgeInactiveTools();
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
      await access.purgeInactiveTools(registry);
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

  it("continues entitlement checks after hydration failure and permits later quiescent purge", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool));
    vi.spyOn(access, "adopt").mockImplementationOnce(() => {
      throw new Error("read failure");
    });
    const sync = coordinator(async () => Response.json(confirmation("subscription_inactive")));
    await sync.checkToolAccess();
    await sync.checkToolAccess();
    await access.purgeInactiveTools();
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(false);
  });

  it("allows competing synchronizers while catalog work is in flight and rejects stale activation", async () => {
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
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeUndefined();
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
    await runtime.sync();
    expect(runtime.isCloudEnabled).toBe(false);
    state = "subscription_inactive";
    await runtime.sync();
    await runtime.stop();
    expect(accessRequests).toBeGreaterThanOrEqual(2);
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeUndefined();
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
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
    await expect(access.purgeInactiveTools()).rejects.toThrow();
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
    // Live deactivation preserves shared bytes; only quiescent maintenance may evict them.
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
  });
});

describe("Lock-free concurrent authorization and stale-protection semantics", () => {
  it("supports independent simultaneous owners without locking or cross-blocking", async () => {
    const toolA = manifest("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tool_a");
    const toolB = manifest("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "tool_b");
    cacheTool(toolA);
    cacheTool(toolB);

    const identityA = { ...identity, accountId: "account-alpha", userId: "user-alpha" };
    const identityB = { ...identity, accountId: "account-beta", userId: "user-beta" };

    const accessA = new ManagedToolAccess(access.stateDir, artifactCache, identityA);
    const accessB = new ManagedToolAccess(access.stateDir, artifactCache, identityB);

    const confA = accessA.confirm({
      ...confirmation("allowed"),
      accountId: identityA.accountId,
      userId: identityA.userId,
    });
    const confB = accessB.confirm({
      ...confirmation("allowed"),
      accountId: identityB.accountId,
      userId: identityB.userId,
    });

    expect(confA?.toolAccess).toBe("allowed");
    expect(confB?.toolAccess).toBe("allowed");

    accessA.record(entry(toolA), "ws-a", undefined, false, confA);
    accessB.record(entry(toolB), "ws-b", undefined, false, confB);

    expect(accessA.isBlocked(entry(toolA))).toBe(false);
    expect(accessB.isBlocked(entry(toolB))).toBe(false);

    // Deny owner A: owner A is blocked, but owner B remains active and unaffected
    accessA.confirm({
      ...confirmation("subscription_inactive"),
      accountId: identityA.accountId,
      userId: identityA.userId,
    });
    expect(accessA.isInactive()).toBe(true);
    expect(accessA.isBlocked(entry(toolA))).toBe(true);
    expect(accessB.isInactive()).toBe(false);
    expect(accessB.isBlocked(entry(toolB))).toBe(false);
  });

  it("rejects a stale allowance after denial so durable negative authorization always wins", async () => {
    const tool = manifest();
    cacheTool(tool);

    // Initial state: unconfirmed / allowed
    const observedBeforeDenial = access.captureConfirmation();

    // Concurrent denial occurs and is durably persisted
    const denial = access.confirm(confirmation("subscription_inactive"));
    expect(denial?.toolAccess).toBe("subscription_inactive");
    expect(access.isInactive()).toBe(true);

    // Stale response fetched based on pre-denial observation arrives with "allowed"
    const staleResult = access.confirm(confirmation("allowed"), observedBeforeDenial);
    expect(staleResult).toBeUndefined(); // Stale allowance rejected!

    // Durable denial is preserved
    expect(access.isInactive()).toBe(true);
    access.record(entry(tool), identity.workspaceId);
    expect(access.isBlocked(entry(tool))).toBe(true);
  });

  it("allows renewal when observed state reflects the denial epoch, requiring re-activation", async () => {
    const tool = manifest();
    cacheTool(tool);

    access.record(entry(tool), identity.workspaceId);
    access.confirm(confirmation("subscription_inactive"));
    expect(access.isInactive()).toBe(true);
    expect(access.isBlocked(entry(tool))).toBe(true);

    // Observe the inactive state prior to cloud renewal check
    const observedInactive = access.captureConfirmation();
    expect(observedInactive.toolAccess).toBe("subscription_inactive");

    // Cloud confirms subscription is now allowed
    const renewed = access.confirm(confirmation("allowed"), observedInactive);
    expect(renewed).toBeDefined();
    expect(renewed?.toolAccess).toBe("allowed");
    expect(access.isInactive()).toBe(false);

    // Renewal alone is not activation: pre-denial recorded tool remains blocked until re-recorded
    expect(access.isBlocked(entry(tool))).toBe(true);

    // Re-recording with renewed confirmation unblocks the tool
    access.record(entry(tool), identity.workspaceId, undefined, false, renewed);
    expect(access.isBlocked(entry(tool))).toBe(false);
  });

  it("never stamps a stale activation with a newer revocation epoch", async () => {
    const tool = manifest();
    cacheTool(tool);

    // First confirmation: allowed
    const allowedConfirmation = access.confirm(confirmation("allowed"));
    expect(allowedConfirmation?.toolAccess).toBe("allowed");

    // Async download / reconciliation in flight... during this time, a denial occurs!
    const denialConfirmation = access.confirm(confirmation("subscription_inactive"));
    expect(denialConfirmation?.toolAccess).toBe("subscription_inactive");

    // In-flight sync finishes and attempts to record using the earlier allowed confirmation
    access.record(entry(tool), identity.workspaceId, undefined, false, allowedConfirmation);

    // Because activation receipt was bound to the pre-denial epoch, it is immediately blocked
    expect(access.isBlocked(entry(tool))).toBe(true);
  });

  it("preserves shared artifacts during cleanup when another owner remains active", async () => {
    const tool = manifest();
    cacheTool(tool);

    const identityA = { ...identity, accountId: "account-share-a", userId: "user-share-a" };
    const identityB = { ...identity, accountId: "account-share-b", userId: "user-share-b" };

    const accessA = new ManagedToolAccess(access.stateDir, artifactCache, identityA);
    const accessB = new ManagedToolAccess(access.stateDir, artifactCache, identityB);

    const confA = accessA.confirm({
      ...confirmation("allowed"),
      accountId: identityA.accountId,
      userId: identityA.userId,
    });
    const confB = accessB.confirm({
      ...confirmation("allowed"),
      accountId: identityB.accountId,
      userId: identityB.userId,
    });

    accessA.record(entry(tool), "ws-a", undefined, false, confA);
    accessB.record(entry(tool), "ws-b", undefined, false, confB);

    await artifactCache.addReference(entry(tool).artifactDigest, {
      refId: `share:${tool.name}`,
      toolId: tool.id,
      version: tool.version,
    });

    // Owner A is revoked
    accessA.confirm({
      ...confirmation("subscription_inactive"),
      accountId: identityA.accountId,
      userId: identityA.userId,
    });
    expect(accessA.isInactive()).toBe(true);

    // Owner A cleans up: because Owner B is active and shares the artifact, artifact must not be removed
    await accessA.cleanup(registry);

    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
    expect(accessA.isBlocked(entry(tool))).toBe(true);
    expect(accessB.isBlocked(entry(tool))).toBe(false);
  });

  it("imports and honors legacy JSON owner metadata without existing database", async () => {
    const tool = manifest();
    cacheTool(tool);

    const accountsDir = path.join(access.stateDir, "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });

    // Compute owner key manually matching legacy format
    const legacyCloudOrigin = new URL(identity.cloudUrl).origin;
    const legacyOwnerKey = crypto
      .createHash("sha256")
      .update(JSON.stringify([legacyCloudOrigin, identity.accountId]))
      .digest("hex");

    const legacyRevocationId = crypto.randomUUID();
    const legacyOwner = {
      schemaVersion: "1.0.0",
      accountId: identity.accountId,
      userId: identity.userId,
      cloudUrl: legacyCloudOrigin,
      toolAccess: "subscription_inactive",
      revocationId: legacyRevocationId,
      proofId: crypto.randomUUID(),
    };

    fs.writeFileSync(path.join(accountsDir, `${legacyOwnerKey}.json`), JSON.stringify(legacyOwner));

    // Fresh ManagedToolAccess instance on the existing stateDir with only legacy files
    const legacyAccess = new ManagedToolAccess(access.stateDir, artifactCache, identity);
    expect(legacyAccess.isInactive()).toBe(true);

    const captured = legacyAccess.captureConfirmation();
    expect(captured.toolAccess).toBe("subscription_inactive");
    expect(captured.revocationId).toBe(legacyRevocationId);

    // Renewal can proceed from legacy captured state
    const renewed = legacyAccess.confirm(confirmation("allowed"), captured);
    expect(renewed).toBeDefined();
    expect(renewed?.toolAccess).toBe("allowed");
    expect(legacyAccess.isInactive()).toBe(false);
  });

  it("retains in-memory denial when persistence throws so negative authorization is fail-closed", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool), identity.workspaceId);

    // Mock write to throw during confirm denial persistence
    vi.spyOn(access as unknown as { write: () => unknown }, "write").mockImplementationOnce(() => {
      throw new Error("disk failure during denial persistence");
    });

    // Confirmation throws error due to persistence failure
    expect(() => access.confirm(confirmation("subscription_inactive"), {})).toThrow(
      "disk failure during denial persistence",
    );

    // Denial is nevertheless retained in memory!
    expect(access.isInactive()).toBe(true);
    expect(access.isBlocked(entry(tool))).toBe(true);
  });

  it("honors live legacy process revocations without allowing legacy allowance to overwrite database denial", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool), identity.workspaceId);

    // Database has allowed confirmation
    access.confirm(confirmation("allowed"));
    expect(access.isInactive()).toBe(false);

    // Another live legacy process writes a revocation directly to accounts directory
    const legacyCloudOrigin = new URL(identity.cloudUrl).origin;
    const legacyOwnerKey = crypto
      .createHash("sha256")
      .update(JSON.stringify([legacyCloudOrigin, identity.accountId]))
      .digest("hex");
    const accountsDir = path.join(access.stateDir, "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });

    const legacyRevocation = {
      schemaVersion: "1.0.0",
      accountId: identity.accountId,
      userId: identity.userId,
      cloudUrl: legacyCloudOrigin,
      toolAccess: "subscription_inactive",
      revocationId: crypto.randomUUID(),
      proofId: crypto.randomUUID(),
    };
    fs.writeFileSync(
      path.join(accountsDir, `${legacyOwnerKey}.json`),
      JSON.stringify(legacyRevocation),
    );

    // readOwners honors the live legacy denial
    expect(access.isInactive()).toBe(true);
    expect(access.isBlocked(entry(tool))).toBe(true);

    // Conversely: if DB has denial, a stale legacy file with "allowed" must NEVER overwrite it
    access.confirm(confirmation("subscription_inactive"));
    const staleLegacyAllowed = {
      schemaVersion: "1.0.0",
      accountId: identity.accountId,
      userId: identity.userId,
      cloudUrl: legacyCloudOrigin,
      toolAccess: "allowed",
      proofId: crypto.randomUUID(),
    };
    fs.writeFileSync(
      path.join(accountsDir, `${legacyOwnerKey}.json`),
      JSON.stringify(staleLegacyAllowed),
    );

    // Authoritative denial remains winning
    expect(access.isInactive()).toBe(true);
  });

  it("prevents stale confirmation from overwriting newer active receipt and validates confirmation identity", async () => {
    const tool = manifest();
    cacheTool(tool);

    // Initial valid allowed confirmation & record
    const conf1 = access.confirm(confirmation("allowed"));
    expect(conf1?.toolAccess).toBe("allowed");
    access.record(entry(tool), identity.workspaceId, undefined, false, conf1);
    expect(access.isBlocked(entry(tool))).toBe(false);

    // Denial occurs, then renewal occurs, creating a new active epoch
    access.confirm(confirmation("subscription_inactive"));
    expect(access.isBlocked(entry(tool))).toBe(true);

    const renewed = access.confirm(confirmation("allowed"), access.captureConfirmation());
    expect(renewed?.toolAccess).toBe("allowed");

    // Re-record with renewed confirmation makes it active under new epoch
    access.record(entry(tool), identity.workspaceId, undefined, false, renewed);
    expect(access.isBlocked(entry(tool))).toBe(false);

    // A stale in-flight worker now attempts to record with conf1 (from before the denial/renewal)
    access.record(entry(tool), identity.workspaceId, undefined, false, conf1);

    // The newer active receipt is preserved; not overwritten with the stale pre-denial activation!
    expect(access.isBlocked(entry(tool))).toBe(false);

    // Also: mismatched confirmation identity is rejected
    const mismatchedConf: ManagedToolConfirmation = {
      ...renewed,
      accountId: "wrong-account",
    };
    // Should be rejected and not touch the record
    access.record(entry(tool), identity.workspaceId, undefined, false, mismatchedConf);
    expect(access.isBlocked(entry(tool))).toBe(false);
  });

  it("deterministically rejects stale allowed CAS when live legacy JSON denial arrives in flight", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool), identity.workspaceId);

    // Initial state: positive allowed confirmed in DB
    const initialAllowed = access.confirm(confirmation("allowed"));
    expect(initialAllowed?.toolAccess).toBe("allowed");
    expect(access.isInactive()).toBe(false);

    // Agent captures pre-denial observation for an in-flight network request
    const observedAllowed = access.captureConfirmation();
    expect(observedAllowed.toolAccess).toBe("allowed");

    // Barrier interleaving: before the in-flight network response is confirmed,
    // an external legacy process writes a positive denial to accounts/${ownerKey}.json
    const legacyCloudOrigin = new URL(identity.cloudUrl).origin;
    const legacyOwnerKey = crypto
      .createHash("sha256")
      .update(JSON.stringify([legacyCloudOrigin, identity.accountId]))
      .digest("hex");
    const accountsDir = path.join(access.stateDir, "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });

    const liveLegacyRevocation = {
      schemaVersion: "1.0.0",
      accountId: identity.accountId,
      userId: identity.userId,
      cloudUrl: legacyCloudOrigin,
      toolAccess: "subscription_inactive",
      revocationId: crypto.randomUUID(),
      proofId: crypto.randomUUID(),
    };
    fs.writeFileSync(
      path.join(accountsDir, `${legacyOwnerKey}.json`),
      JSON.stringify(liveLegacyRevocation),
    );

    // Now the in-flight allowed response arrives and calls confirm(allowed, observedAllowed)
    const result = access.confirm(confirmation("allowed"), observedAllowed);

    // Stale allowance MUST be rejected: confirm returns undefined!
    expect(result).toBeUndefined();

    // Authoritative denial is imported into DB and enforced
    expect(access.isInactive()).toBe(true);
    expect(access.isBlocked(entry(tool))).toBe(true);
  });

  it("proves live cleanup never invokes async destructive cache API while concurrent renewal succeeds", async () => {
    const tool = manifest();
    cacheTool(tool);
    register(tool);
    access.record(entry(tool), identity.workspaceId);

    // Denial occurs
    access.confirm(confirmation("subscription_inactive"));
    expect(access.isInactive()).toBe(true);
    expect(access.isBlocked(entry(tool))).toBe(true);

    // Spy on destructive cache API to verify live cleanup NEVER invokes it
    const removeRefSpy = vi.spyOn(artifactCache, "removeOwnedArtifactReference");

    // Run live cleanup (production non-destructive cleanup)
    await access.cleanup(registry);

    // In-memory tool registry immediately forgets the blocked tool
    expect(await registry.getTool(tool.id, identity.workspaceId)).toBeUndefined();

    // Destructive cache API was NEVER called during live cleanup
    expect(removeRefSpy).not.toHaveBeenCalled();

    // Artifact remains intact and cached
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);

    // Concurrent renewal succeeds immediately without race conditions
    const renewed = access.confirm(confirmation("allowed"), access.captureConfirmation());
    expect(renewed?.toolAccess).toBe("allowed");
    access.record(entry(tool), identity.workspaceId, undefined, false, renewed);

    // Tool is unblocked immediately and still has its cached artifact
    expect(access.isBlocked(entry(tool))).toBe(false);
    expect(artifactCache.isArtifactCached(entry(tool).artifactDigest)).toBe(true);
  });

  it("avoids renewal deadlock when two independent workers observe allowed, both deny, and one renews", async () => {
    const tool = manifest();
    cacheTool(tool);

    const accessA = new ManagedToolAccess(access.stateDir, artifactCache, identity);
    const accessB = new ManagedToolAccess(access.stateDir, artifactCache, identity);

    // Initial state: allowed confirmed in DB
    accessA.confirm(confirmation("allowed"));
    accessA.record(entry(tool), identity.workspaceId);
    expect(accessA.isBlocked(entry(tool))).toBe(false);

    // Both independent instances capture confirmation while allowed
    const obsA = accessA.captureConfirmation();
    const obsB = accessB.captureConfirmation();
    expect(obsA.toolAccess).toBe("allowed");
    expect(obsB.toolAccess).toBe("allowed");

    // Both instances confirm denial independently
    const denialA = accessA.confirm(confirmation("subscription_inactive"), obsA);
    const denialB = accessB.confirm(confirmation("subscription_inactive"), obsB);

    expect(denialA?.toolAccess).toBe("subscription_inactive");
    expect(denialB?.toolAccess).toBe("subscription_inactive");

    // Both MUST share the exact same canonical revocationId epoch!
    expect(denialA?.revocationId).toBeDefined();
    expect(denialB?.revocationId).toBeDefined();
    expect(denialB?.revocationId).toBe(denialA?.revocationId);

    // Both capture the current inactive state
    const inactiveObsA = accessA.captureConfirmation();
    const inactiveObsB = accessB.captureConfirmation();

    expect(inactiveObsA.revocationId).toBe(denialA?.revocationId);
    expect(inactiveObsB.revocationId).toBe(denialA?.revocationId);

    // Now renewal occurs: CAS must match the canonical revocationId without deadlock
    const renewedA = accessA.confirm(confirmation("allowed"), inactiveObsA);
    expect(renewedA).toBeDefined();
    expect(renewedA?.toolAccess).toBe("allowed");
    expect(renewedA?.revocationId).toBe(denialA?.revocationId);

    expect(accessA.isInactive()).toBe(false);
    expect(accessB.isInactive()).toBe(false);

    // Re-record with renewed confirmation unblocks the tool
    accessA.record(entry(tool), identity.workspaceId, undefined, false, renewedA);
    expect(accessA.isBlocked(entry(tool))).toBe(false);
    expect(accessB.isBlocked(entry(tool))).toBe(false);
  });

  it("fails closed on proven managed tuples across warm and cold processes when DB read fails after mirror write failure", async () => {
    const tool = manifest();
    cacheTool(tool);
    access.record(entry(tool), identity.workspaceId);

    // Initial state: positive confirmation
    access.confirm(confirmation("allowed"));
    expect(access.isBlocked(entry(tool))).toBe(false);

    // Denial committed to SQLite DB, but file mirror write fails
    // (Leaving accounts/${id}.json with the old "allowed" confirmation!)
    const accountsFile = path.join(
      access.stateDir,
      "accounts",
      `${crypto
        .createHash("sha256")
        .update(JSON.stringify([new URL(identity.cloudUrl).origin, identity.accountId]))
        .digest("hex")}.json`,
    );
    const staleAllowedJson = fs.readFileSync(accountsFile, "utf8");

    // Commit denial to DB
    access.confirm(confirmation("subscription_inactive"));
    expect(access.isInactive()).toBe(true);

    // Restore the stale allowed JSON to simulate failed mirror write
    fs.writeFileSync(accountsFile, staleAllowedJson);

    // 1. Warm process: subsequent DB read fails (e.g. temporary SQLite I/O failure)
    vi.spyOn(access as unknown as { getDb: () => unknown }, "getDb").mockImplementationOnce(() => {
      throw new Error("temporary DB failure");
    });

    // Proven managed tuple must be blocked (fail-closed, does not trust stale allowed JSON!)
    expect(access.isBlocked(entry(tool))).toBe(true);

    // Sys and unmanaged tuples are NOT blocked
    expect(access.isBlocked({ toolId: "unmanaged-system-tool" })).toBe(false);

    // 2. Cold process: new ManagedToolAccess instance (even credentialless) where DB read fails
    const cold = new ManagedToolAccess(access.stateDir, artifactCache);
    vi.spyOn(cold as unknown as { getDb: () => unknown }, "getDb").mockImplementationOnce(() => {
      throw new Error("cold DB failure");
    });

    // Proven managed tuple is blocked even in cold credentialless process
    expect(cold.isBlocked(entry(tool))).toBe(true);

    // Sys and unmanaged tuples remain unblocked
    expect(cold.isBlocked({ toolId: "unmanaged-system-tool" })).toBe(false);
  });

  it("recovers cleanly on retry when getDb throws during initial pragma or table setup", async () => {
    const freshStateDir = path.join(root, "fresh-state");
    const freshAccess = new ManagedToolAccess(freshStateDir, artifactCache, identity);

    // Induce throw during initDb on first attempt
    const initialize = vi
      .spyOn(freshAccess as unknown as { initDb: (db: unknown) => void }, "initDb")
      .mockImplementationOnce(() => {
        throw new Error("pragma or schema setup failure");
      });

    // Initialization failure is contained and fails closed, rather than crashing the gateway.
    expect(freshAccess.isInactive()).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();

    // Verify broken connection was NOT cached: freshAccess db property must be undefined
    expect(Reflect.get(freshAccess, "db")).toBeUndefined();

    // Second attempt (retry): initDb succeeds normally without being stuck on broken connection
    const conf = freshAccess.confirm(confirmation("allowed"));
    expect(conf?.toolAccess).toBe("allowed");
    expect(Reflect.get(freshAccess, "db")).toBeDefined();
    expect(freshAccess.isInactive()).toBe(false);
  });
  it("rereads only matching receipts while observing new receipts and sibling renewal", () => {
    const target = manifest();
    access.confirm(confirmation("allowed"));
    access.record(entry(target));
    for (let index = 0; index < 20; index++) {
      access.record(entry(manifest(crypto.randomUUID(), `unrelated_${index}`)));
    }
    expect(access.isBlocked(entry(target))).toBe(false);
    const reads = vi.spyOn(fs, "readFileSync");
    const listings = vi.spyOn(fs, "readdirSync");
    expect(access.isBlocked(entry(target))).toBe(false);
    const receiptPrefix = `${path.join(access.stateDir, "tools")}${path.sep}`;
    expect(
      reads.mock.calls.filter(([file]) => String(file).startsWith(receiptPrefix)),
    ).toHaveLength(1);
    expect(
      listings.mock.calls.filter(
        ([directory]) => directory === path.join(access.stateDir, "tools"),
      ),
    ).toHaveLength(0);
    listings.mockRestore();
    reads.mockRestore();

    const sibling = new ManagedToolAccess(access.stateDir, artifactCache, identity);
    sibling.confirm(confirmation("subscription_inactive"));
    expect(access.isBlocked(entry(target))).toBe(true);
    sibling.confirm(confirmation("allowed"));
    sibling.record(entry(target));
    expect(access.isBlocked(entry(target))).toBe(false);

    const added = manifest(crypto.randomUUID(), "added_by_sibling");
    sibling.record(entry(added));
    expect(access.isManaged(entry(added))).toBe(true);
    expect(access.isBlocked(entry(added))).toBe(false);
  });

  it("caches the owners directory and reuses parses while honoring live revocations", async () => {
    const target = manifest();
    access.confirm(confirmation("allowed"));
    access.record(entry(target));
    expect(access.isBlocked(entry(target))).toBe(false);

    const ownersDir = path.join(access.stateDir, "accounts");
    const ownerPrefix = `${ownersDir}${path.sep}`;
    const reads = vi.spyOn(fs, "readFileSync");
    const listings = vi.spyOn(fs, "readdirSync");

    // Repeated ownership checks must not re-list or re-parse the owners directory.
    for (let index = 0; index < 25; index++) {
      access.isBlocked(entry(target));
      access.isManaged(entry(target));
    }
    expect(reads.mock.calls.filter(([file]) => String(file).startsWith(ownerPrefix))).toHaveLength(
      0,
    );
    expect(listings.mock.calls.filter(([directory]) => directory === ownersDir)).toHaveLength(0);
    listings.mockRestore();
    reads.mockRestore();

    // A live legacy revocation written in place must still be observed.
    const ownerFile = fs.readdirSync(ownersDir).find((name) => name.endsWith(".json"));
    expect(ownerFile).toBeDefined();
    const ownerPath = path.join(ownersDir, ownerFile!);
    const revoked = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    fs.writeFileSync(
      ownerPath,
      JSON.stringify({ ...revoked, toolAccess: "subscription_inactive" }),
      { mode: 0o600 },
    );
    const revived = new ManagedToolAccess(access.stateDir, artifactCache, identity);
    expect(revived.isBlocked(entry(target))).toBe(true);
  });

  it("indexes thousands of synthetic receipts and verifies warm target lookups, cross-process denial, failclosed durability, and redundant mkdir elimination", async () => {
    const target = manifest();
    access.confirm(confirmation("allowed"));
    access.record(entry(target));

    const toolsDir = path.join(access.stateDir, "tools");
    const syntheticOwner = crypto
      .createHash("sha256")
      .update(JSON.stringify(["https://cloud.example.test", "account-a"]))
      .digest("hex");
    for (let i = 0; i < 1200; i++) {
      const syntheticToolId = crypto.randomUUID();
      const syntheticEntry = {
        toolId: syntheticToolId,
        name: `synthetic_${i}`,
        version: "1.0.0",
        manifestDigest: "0".repeat(64),
        artifactDigest: "a".repeat(64),
        status: "active" as const,
      };
      const receipt = {
        owner: syntheticOwner,
        entry: syntheticEntry,
      };
      const fileKey = crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
      const receiptPath = path.join(toolsDir, `${fileKey}.json`);
      fs.writeFileSync(
        receiptPath,
        JSON.stringify({
          ...receipt,
          activationId: undefined,
        }),
      );
    }

    // Warm discovery with initial query
    expect(access.isBlocked(entry(target))).toBe(false);

    const reads = vi.spyOn(fs, "readFileSync");
    const listings = vi.spyOn(fs, "readdirSync");
    const mkdirs = vi.spyOn(fs, "mkdirSync");

    // 5 warm iterations of isBlocked and isManaged for target
    for (let i = 0; i < 5; i++) {
      expect(access.isBlocked(entry(target))).toBe(false);
      expect(access.isManaged(entry(target))).toBe(true);
    }

    const receiptPrefix = `${toolsDir}${path.sep}`;
    const targetReads = reads.mock.calls.filter(([file]) => String(file).startsWith(receiptPrefix));
    // Exactly 1 read per query (5 isBlocked + 5 isManaged = 10 reads)
    expect(targetReads).toHaveLength(10);
    const readPaths = new Set(targetReads.map(([f]) => String(f)));
    // All 10 reads visited the single target receipt path, not the other 1200 synthetic files
    expect(readPaths.size).toBe(1);

    // Warm directory: 0 readdirSync calls on toolsDir
    const toolListings = listings.mock.calls.filter(([dir]) => dir === toolsDir);
    expect(toolListings).toHaveLength(0);

    // Redundant mkdirSync eliminated when DB is already open
    const stateDirMkdirs = mkdirs.mock.calls.filter(([dir]) => dir === access.stateDir);
    expect(stateDirMkdirs).toHaveLength(0);

    // Unknown/unmanaged tool lookup on warm directory: 0 file reads and 0 readdir
    const unknownTool = manifest(crypto.randomUUID(), "unknown");
    reads.mockClear();
    expect(access.isManaged(entry(unknownTool))).toBe(false);
    expect(access.isBlocked(entry(unknownTool))).toBe(false);
    const unknownReads = reads.mock.calls.filter(([file]) =>
      String(file).startsWith(receiptPrefix),
    );
    expect(unknownReads).toHaveLength(0);

    listings.mockRestore();
    reads.mockRestore();
    mkdirs.mockRestore();

    // Live cross-process denial and reactivation observing SQLite immediately
    const sibling = new ManagedToolAccess(access.stateDir, artifactCache, identity);
    sibling.confirm(confirmation("subscription_inactive"));
    expect(access.isBlocked(entry(target))).toBe(true);
    expect(access.isInactive()).toBe(true);

    sibling.confirm(confirmation("allowed"));
    sibling.record(entry(target));
    expect(access.isBlocked(entry(target))).toBe(false);
    expect(access.isInactive()).toBe(false);

    // New receipt / new tuple
    const newTool = manifest(crypto.randomUUID(), "new_tool");
    expect(access.isManaged(entry(newTool))).toBe(false);
    sibling.record(entry(newTool));
    expect(access.isManaged(entry(newTool))).toBe(true);
    expect(access.isBlocked(entry(newTool))).toBe(false);

    // Fail-closed provenance on deleted receipt file
    const targetFile = [...readPaths][0];
    expect(fs.existsSync(targetFile)).toBe(true);
    fs.unlinkSync(targetFile);
    expect(fs.existsSync(targetFile)).toBe(false);

    // Retains known receipt (fail-closed provenance policy)
    expect(access.isManaged(entry(target))).toBe(true);
    expect(access.isBlocked(entry(target))).toBe(false);

    // If sibling denies while receipt is deleted, denial is honored immediately
    sibling.confirm(confirmation("subscription_inactive"));
    expect(access.isBlocked(entry(target))).toBe(true);

    // Fail-closed provenance on corrupted receipt file
    sibling.confirm(confirmation("allowed"));
    fs.writeFileSync(targetFile, "{ corrupt receipt json");
    expect(access.isManaged(entry(target))).toBe(true);
    expect(access.isBlocked(entry(target))).toBe(true);

    // Overwriting corrupt receipt with valid record restores access
    sibling.record(entry(target));
    expect(access.isBlocked(entry(target))).toBe(false);

    // Arbitrary directory change and atomic replacement
    const atomicTemp = `${targetFile}.atomic.tmp`;
    fs.writeFileSync(atomicTemp, fs.readFileSync(targetFile, "utf8"));
    fs.renameSync(atomicTemp, targetFile);
    expect(access.isBlocked(entry(target))).toBe(false);
    expect(access.isManaged(entry(target))).toBe(true);
  });

  it("retries unresolved receipts upon in-place repair without directory revision change and enforces authority unavailable failclosed and cross-account deny", async () => {
    const inplaceTool = manifest(crypto.randomUUID(), "inplace_tool");
    const toolsDir = path.join(access.stateDir, "tools");
    const syntheticOwner = crypto
      .createHash("sha256")
      .update(JSON.stringify(["https://cloud.example.test", "account-a"]))
      .digest("hex");
    const receipt = {
      owner: syntheticOwner,
      entry: entry(inplaceTool),
    };
    const fileKey = crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const inplacePath = path.join(toolsDir, `${fileKey}.json`);
    // Write initial malformed file
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(inplacePath, "{ unparseable initial json");

    // Warm access discovery runs; malformed file fails to parse and is tracked in unresolvedReceiptNames
    expect(access.isManaged(entry(inplaceTool))).toBe(false);
    expect(access.isBlocked(entry(inplaceTool))).toBe(false);

    // Repair the file IN-PLACE without rename and preserve directory revision
    const statBefore = fs.statSync(toolsDir, { bigint: true });
    const fixedContent = JSON.stringify({
      ...receipt,
      activationId: "active-revocation-token",
    });
    const fd = fs.openSync(inplacePath, "r+");
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, fixedContent, 0, "utf8");
    fs.closeSync(fd);

    // Verify directory stat dev:ino:mtimeNs:ctimeNs did NOT change
    const statAfter = fs.statSync(toolsDir, { bigint: true });
    const revBefore = `${statBefore.dev}:${statBefore.ino}:${statBefore.mtimeNs}:${statBefore.ctimeNs}`;
    const revAfter = `${statAfter.dev}:${statAfter.ino}:${statAfter.mtimeNs}:${statAfter.ctimeNs}`;
    expect(revAfter).toBe(revBefore);

    // On next lookup without directory revision change, retryUnresolved reads the repaired file
    expect(access.isManaged(entry(inplaceTool))).toBe(true);
    expect(access.isBlocked(entry(inplaceTool))).toBe(true);

    // Authority unavailable: fail closed on proven managed tuples, unblocked on unmanaged
    const unmanagedTool = manifest(crypto.randomUUID(), "unmanaged_tool");
    expect(access.isManaged(entry(unmanagedTool))).toBe(false);
    expect(access.isBlocked(entry(unmanagedTool))).toBe(false);

    // Use existing DB failure mock pattern to force authority failure
    const dbFailureMock = vi
      .spyOn(access as unknown as { getDb: () => unknown }, "getDb")
      .mockImplementation(() => {
        throw new Error("temporary DB failure");
      });
    expect(access.isBlocked(entry(inplaceTool))).toBe(true);
    expect(access.isBlocked(entry(unmanagedTool))).toBe(false);

    // Restore DB failure mock before confirming recovery
    dbFailureMock.mockRestore();
    access.confirm(confirmation("allowed"));
    expect(access.isInactive()).toBe(false);

    // Cross-account deny / cross-owner equality:
    const otherIdentity: CloudRequestIdentity = {
      ...identity,
      accountId: "account-b",
      userId: "user-b",
    };
    const otherAccess = new ManagedToolAccess(access.stateDir, artifactCache, otherIdentity);
    otherAccess.confirm({
      schemaVersion: "1.0.0",
      accountId: "account-b",
      userId: "user-b",
      toolAccess: "allowed",
    });
    otherAccess.record(entry(inplaceTool));

    // Account A still has stale activation on its own receipt, so A remains blocked!
    expect(access.isBlocked(entry(inplaceTool))).toBe(true);
    // Account B has a fresh active activation, so B is unblocked!
    expect(otherAccess.isBlocked(entry(inplaceTool))).toBe(false);

    // Credentialless caller observes valid active owner (B) and is unblocked
    const credentialless = new ManagedToolAccess(access.stateDir, artifactCache);
    expect(credentialless.isBlocked(entry(inplaceTool))).toBe(false);

    // When account-b is revoked, cross-owner deny is observed
    otherAccess.confirm({
      schemaVersion: "1.0.0",
      accountId: "account-b",
      userId: "user-b",
      toolAccess: "subscription_inactive",
    });
    expect(otherAccess.isBlocked(entry(inplaceTool))).toBe(true);
    expect(access.isBlocked(entry(inplaceTool))).toBe(true);
    expect(credentialless.isBlocked(entry(inplaceTool))).toBe(true);

    // Failure-recovery: transient read error on unresolved receipt does NOT delete it from unresolved set
    const retryRecoveryTool = manifest(crypto.randomUUID(), "retry_recovery_tool");
    const recoveryReceipt = {
      owner: syntheticOwner,
      entry: entry(retryRecoveryTool),
    };
    const recoveryKey = crypto
      .createHash("sha256")
      .update(JSON.stringify(recoveryReceipt))
      .digest("hex");
    const recoveryPath = path.join(toolsDir, `${recoveryKey}.json`);
    fs.writeFileSync(recoveryPath, "{ malformed before transient eacces");

    // Trigger discovery to place in unresolvedReceiptNames
    expect(access.isManaged(entry(retryRecoveryTool))).toBe(false);

    // Simulate transient read error during retry (e.g. EACCES on ancestor)
    const originalReadFile = fs.readFileSync;
    const transientErrorSpy = vi.spyOn(fs, "readFileSync").mockImplementation((p, opts) => {
      if (String(p) === recoveryPath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalReadFile(p, opts);
    });

    // Lookup triggers retryUnresolved which hits the transient error; receipt must be retained in unresolved set
    expect(access.isManaged(entry(retryRecoveryTool))).toBe(false);
    transientErrorSpy.mockRestore();

    // Now write valid content in-place without directory revision change
    const validRecoveryContent = JSON.stringify({
      ...recoveryReceipt,
      activationId: "active-token",
    });
    const recoveryFd = fs.openSync(recoveryPath, "r+");
    fs.ftruncateSync(recoveryFd, 0);
    fs.writeSync(recoveryFd, validRecoveryContent, 0, "utf8");
    fs.closeSync(recoveryFd);

    // On next lookup, retryUnresolved recovers and parses the receipt!
    expect(access.isManaged(entry(retryRecoveryTool))).toBe(true);
  });
});
