import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ToolManifest,
  type V1ToolCertificate,
  type V1UnsignedToolCertificate,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
  toolCertificateSigningPayload,
} from "@resin/contracts";
import { ArtifactCache, encodeDeterministicTar } from "@resin/runtime";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudCatalogClient, type ToolCertificatesFetchResult } from "../../src/proxy/client.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import {
  TOOL_CERTIFICATE_EVENT,
  type ToolCertificateIdentity,
  type ToolCertificateNotificationLatch,
  ToolCertificateReporter,
  type ToolCertificateReporterOptions,
  type ToolCertificateSubject,
  evaluateToolCertificate,
} from "../../src/proxy/tool-certificate-verifier.js";
import {
  TOOL_SIGNATURES_STATE_FILE_NAME,
  ToolSignatureStateStore,
} from "../../src/proxy/tool-signature-state.js";
import {
  type ToolSigningTrust,
  type TrustedToolSigningKey,
  freezeToolSigningTrust,
} from "../../src/proxy/tool-signing-trust.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const ORIGIN = "https://cloud.test";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TOOL_ID = "33333333-3333-4333-8333-333333333333";
const IDENTITY: ToolCertificateIdentity = {
  cloudUrl: ORIGIN,
  accountId: "acc_cert",
  workspaceId: "ws_cert",
};

const signingKeys = crypto.generateKeyPairSync("ed25519");
const strangerKeys = crypto.generateKeyPairSync("ed25519");
const pemOf = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();
const PINNED_KEY: TrustedToolSigningKey = {
  keyId: "test-tool-signing",
  algorithm: "ed25519",
  publicKeyPem: pemOf(signingKeys.publicKey),
  environment: "staging",
};
const TRUST: ToolSigningTrust = freezeToolSigningTrust({ [ORIGIN]: [PINNED_KEY] });

const SUBJECT: ToolCertificateSubject = {
  toolId: TOOL_ID,
  name: "calc_tool",
  version: "1.0.0",
  manifestDigest: "b".repeat(64),
  artifactDigest: "a".repeat(64),
};

function certify(
  subject: ToolCertificateSubject,
  overrides: Partial<V1UnsignedToolCertificate> = {},
  options: { privateKey?: KeyObject; keyId?: string } = {},
): V1ToolCertificate {
  const unsigned: V1UnsignedToolCertificate = {
    schemaKind: V1_SCHEMA_KINDS.TOOL_CERTIFICATE,
    schemaVersion: V1_SCHEMA_VERSION,
    certificateId: crypto.randomUUID(),
    accountId: IDENTITY.accountId,
    workspaceId: IDENTITY.workspaceId,
    toolId: subject.toolId,
    toolName: subject.name,
    version: subject.version,
    artifactDigest: subject.artifactDigest,
    manifestDigest: subject.manifestDigest,
    issuedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
  const signature = crypto
    .sign(
      null,
      toolCertificateSigningPayload(unsigned),
      options.privateKey ?? signingKeys.privateKey,
    )
    .toString("hex");
  return {
    ...unsigned,
    signature: {
      keyId: options.keyId ?? PINNED_KEY.keyId,
      algorithm: "ed25519",
      signature,
      signedAt: "2026-10-01T12:00:01.000Z",
    },
  };
}

function evaluate(
  certificates: V1ToolCertificate[],
  keys: readonly TrustedToolSigningKey[] | undefined = [PINNED_KEY],
  verifiedArtifactDigest = SUBJECT.artifactDigest,
) {
  return evaluateToolCertificate({
    certificates,
    keys,
    identity: IDENTITY,
    subject: SUBJECT,
    verifiedArtifactDigest,
  });
}

describe("evaluateToolCertificate", () => {
  it("verifies a pinned-key certificate bound to the credential and the lock entry", () => {
    expect(evaluate([certify(SUBJECT)])).toBe("verified");
    // Digest spelling (prefix, case) does not matter.
    expect(evaluate([certify(SUBJECT)], [PINNED_KEY], `sha256:${"A".repeat(64)}`)).toBe("verified");
  });

  it("reports missing-certificate when no certificate names this tool version", () => {
    expect(evaluate([])).toBe("missing-certificate");
    expect(evaluate([certify({ ...SUBJECT, version: "1.0.1" })])).toBe("missing-certificate");
  });

  it("reports unpinned-origin when the cloud origin has no pinned key", () => {
    expect(
      evaluateToolCertificate({
        certificates: [certify(SUBJECT)],
        keys: undefined,
        identity: IDENTITY,
        subject: SUBJECT,
        verifiedArtifactDigest: SUBJECT.artifactDigest,
      }),
    ).toBe("unpinned-origin");
  });

  it("reports unknown-key for a key id that is not pinned", () => {
    expect(evaluate([certify(SUBJECT, {}, { keyId: "attacker-key" })])).toBe("unknown-key");
  });

  it("reports invalid-signature for a pinned key id with a signature from another key", () => {
    expect(evaluate([certify(SUBJECT, {}, { privateKey: strangerKeys.privateKey })])).toBe(
      "invalid-signature",
    );
    const tampered = { ...certify(SUBJECT), issuedAt: "2026-10-02T00:00:00.000Z" };
    expect(evaluate([tampered])).toBe("invalid-signature");
  });

  it.each([
    ["accountId", { accountId: "acc_other" }],
    ["workspaceId", { workspaceId: "ws_other" }],
    ["toolName", { toolName: "other_tool" }],
  ] as const)("reports binding-mismatch for a different %s", (_field, overrides) => {
    expect(evaluate([certify(SUBJECT, overrides)])).toBe("binding-mismatch");
  });

  it("reports digest-mismatch for a different artifact or manifest digest", () => {
    expect(evaluate([certify(SUBJECT, { artifactDigest: "c".repeat(64) })])).toBe(
      "digest-mismatch",
    );
    expect(evaluate([certify(SUBJECT)], [PINNED_KEY], "c".repeat(64))).toBe("digest-mismatch");
    expect(evaluate([certify(SUBJECT, { manifestDigest: "c".repeat(64) })])).toBe(
      "digest-mismatch",
    );
  });

  it("prefers a verifying certificate over failing ones for the same version", () => {
    expect(evaluate([certify(SUBJECT, {}, { keyId: "attacker-key" }), certify(SUBJECT)])).toBe(
      "verified",
    );
  });
});

describe("ToolCertificateReporter passes", () => {
  let dir: string;
  let store: ToolSignatureStateStore;
  let latch: ToolCertificateNotificationLatch;
  let warn: Mock<(message: string) => void>;
  let reportEvent: Mock<(event: string, props: Record<string, string>) => void>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-certs-"));
    store = new ToolSignatureStateStore({
      filePath: path.join(dir, TOOL_SIGNATURES_STATE_FILE_NAME),
    });
    latch = { warned: false, reported: new Set() };
    warn = vi.fn<(message: string) => void>();
    reportEvent = vi.fn<(event: string, props: Record<string, string>) => void>();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function reporter(overrides: Partial<ToolCertificateReporterOptions> = {}) {
    return new ToolCertificateReporter({
      identity: async () => IDENTITY,
      fetchCertificates: async () => ({ kind: "not-issued" }),
      store,
      trust: TRUST,
      warn,
      reportEvent,
      latch,
      ...overrides,
    });
  }

  it("treats a 404 (cloud not issuing) as missing-certificate with no warning or event", async () => {
    const pass = reporter().beginPass({ online: true, projectId: PROJECT });
    expect(await pass.check(SUBJECT, SUBJECT.artifactDigest)).toBe("missing-certificate");
    await pass.finish();
    expect(warn).not.toHaveBeenCalled();
    expect(reportEvent).not.toHaveBeenCalled();
    expect(store.readSummary()).toMatchObject({
      mode: "report-only",
      verified: 0,
      missing: 1,
      failed: 0,
    });
  });

  it("fetches once per pass, stores certificates, and reuses them offline", async () => {
    const fetchCertificates = vi.fn(
      async (): Promise<ToolCertificatesFetchResult> => ({
        kind: "certificates",
        certificates: [certify(SUBJECT)],
        rejected: 0,
      }),
    );
    const online = reporter({ fetchCertificates }).beginPass({ online: true, projectId: PROJECT });
    expect(await online.check(SUBJECT, SUBJECT.artifactDigest)).toBe("verified");
    expect(await online.check(SUBJECT, SUBJECT.artifactDigest)).toBe("verified");
    await online.finish();
    expect(fetchCertificates).toHaveBeenCalledOnce();

    const offline = reporter({ fetchCertificates }).beginPass({
      online: false,
      projectId: PROJECT,
    });
    expect(await offline.check(SUBJECT, SUBJECT.artifactDigest)).toBe("verified");
    await offline.finish();
    expect(fetchCertificates).toHaveBeenCalledOnce();
    // The summary reflects the latest pass of each project: one tool version, verified.
    expect(store.readSummary()).toMatchObject({ verified: 1, missing: 0, failed: 0 });
  });

  it("falls back to stored certificates when the endpoint fails", async () => {
    const first = reporter({
      fetchCertificates: async () => ({
        kind: "certificates",
        certificates: [certify(SUBJECT)],
        rejected: 0,
      }),
    }).beginPass({ online: true, projectId: PROJECT });
    await first.check(SUBJECT, SUBJECT.artifactDigest);
    await first.finish();

    const failing = reporter({
      fetchCertificates: async () => {
        throw new Error("HTTP 503");
      },
    }).beginPass({ online: true, projectId: PROJECT });
    expect(await failing.check(SUBJECT, SUBJECT.artifactDigest)).toBe("verified");
  });

  it("does not request certificates from an unpinned cloud", async () => {
    const fetchCertificates = vi.fn(
      async (): Promise<ToolCertificatesFetchResult> => ({ kind: "not-issued" }),
    );
    const pass = reporter({
      identity: async () => ({ ...IDENTITY, cloudUrl: "https://unpinned.test" }),
      fetchCertificates,
    }).beginPass({ online: true, projectId: PROJECT });
    expect(await pass.check(SUBJECT, SUBJECT.artifactDigest)).toBe("unpinned-origin");
    await pass.finish();
    expect(fetchCertificates).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(store.readSummary()).toMatchObject({ unpinned: 1, failed: 0 });
  });

  it("warns once per process and reports one event per failure class with fixed strings only", async () => {
    const other: ToolCertificateSubject = {
      ...SUBJECT,
      toolId: "44444444-4444-4444-8444-444444444444",
      name: "other_tool",
    };
    const fetchCertificates = async (): Promise<ToolCertificatesFetchResult> => ({
      kind: "certificates",
      certificates: [
        certify(SUBJECT, {}, { privateKey: strangerKeys.privateKey }),
        certify(other, { workspaceId: "ws_other" }),
      ],
      rejected: 0,
    });
    for (let round = 0; round < 2; round += 1) {
      const pass = reporter({ fetchCertificates }).beginPass({ online: true, projectId: PROJECT });
      expect(await pass.check(SUBJECT, SUBJECT.artifactDigest)).toBe("invalid-signature");
      expect(await pass.check(other, other.artifactDigest)).toBe("binding-mismatch");
      await pass.finish();
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(reportEvent.mock.calls).toEqual([
      [TOOL_CERTIFICATE_EVENT, { outcome: "invalid-signature", mode: "report-only" }],
      [TOOL_CERTIFICATE_EVENT, { outcome: "binding-mismatch", mode: "report-only" }],
    ]);
    const sent = JSON.stringify([warn.mock.calls, reportEvent.mock.calls]);
    for (const secret of [
      TOOL_ID,
      "calc_tool",
      "other_tool",
      "ws_cert",
      "acc_cert",
      "a".repeat(64),
    ]) {
      expect(sent).not.toContain(secret);
    }
    expect(store.readSummary()).toMatchObject({ verified: 0, missing: 0, failed: 2 });
  });

  it("isolates internal errors: a throwing identity or store never escapes", async () => {
    const pass = reporter({
      identity: async () => {
        throw new Error("credential store exploded");
      },
    }).beginPass({ online: true, projectId: PROJECT });
    await expect(pass.check(SUBJECT, SUBJECT.artifactDigest)).resolves.toBeUndefined();
    await expect(pass.finish()).resolves.toBeUndefined();
    expect(reportEvent).toHaveBeenCalledWith(TOOL_CERTIFICATE_EVENT, {
      outcome: "verifier-error",
      mode: "report-only",
    });

    const brokenStore = new ToolSignatureStateStore({
      filePath: path.join(dir, "missing", "\0bad"),
    });
    const second = reporter({ store: brokenStore }).beginPass({
      online: false,
      projectId: PROJECT,
    });
    expect(await second.check(SUBJECT, SUBJECT.artifactDigest)).toBe("missing-certificate");
    await expect(second.finish()).resolves.toBeUndefined();
  });

  it("only blocks in the internal enforce mode", async () => {
    const reportOnly = reporter().beginPass({ online: true, projectId: PROJECT });
    expect(reportOnly.blocks("invalid-signature")).toBe(false);
    expect(reportOnly.blocks(undefined)).toBe(false);
    const enforced = reporter({ enforce: true }).beginPass({ online: true, projectId: PROJECT });
    expect(enforced.blocks("verified")).toBe(false);
    expect(enforced.blocks("missing-certificate")).toBe(true);
  });
});

function makeManifest(id: string, name: string, version: string): ToolManifest {
  const base = {
    id,
    name,
    version,
    description: `Tool ${name}`,
    parameters: {
      type: "object" as const,
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    },
    runtime: {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 5000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    limits: {
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https" as const],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: [],
        allowedBinaries: [],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 5000,
        maxOutputSizeBytes: 1048576,
      },
    },
    scope: "workspace" as const,
    metadata: {},
    createdAt: "2026-08-17T12:00:00.000Z",
  };
  return { ...base, digest: computeManifestDigest(base) };
}

describe("report-only certificate checks in locked tool sync", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-certs-sync-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(options: Partial<ToolCertificateReporterOptions> = {}) {
    const lockManager = new ProjectLockManager({
      lockPath: path.join(dir, "resin.lock"),
      projectId: PROJECT,
    });
    const artifactCache = new ArtifactCache({ cacheDir: path.join(dir, "artifacts") });
    const manifest = makeManifest(TOOL_ID, "calc_tool", "1.0.0");
    const { archive } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(manifest) },
      { path: "src/index.js", content: "export default () => 'ok';" },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(archive).digest("hex");
    const entry = {
      toolId: TOOL_ID,
      name: "calc_tool",
      version: "1.0.0",
      manifestDigest: manifest.digest ?? "",
      artifactDigest,
      status: "active" as const,
    };
    lockManager.reconcileQualified(entry);
    const store = new ToolSignatureStateStore({
      filePath: path.join(dir, "state", TOOL_SIGNATURES_STATE_FILE_NAME),
    });
    const cache = new CloudCatalogCache();
    const registry = new ToolRegistry();
    const coordinator = new CloudCatalogSyncCoordinator({
      client: new CloudCatalogClient({ workspaceId: "ws-1", deviceId: "dev-1", baseUrl: ORIGIN }),
      cache,
      router: new CloudInvocationRouter({ catalogCache: cache }),
      registry,
      workspaceId: "ws-1",
      lockManager,
      transferClient: { downloadArtifact: async () => ({ bytes: archive }) },
      artifactCache,
      toolCertificates: new ToolCertificateReporter({
        identity: async () => IDENTITY,
        fetchCertificates: async () => ({
          kind: "certificates",
          // Signed by a key the client does not pin under this key id.
          certificates: [
            certify({ ...entry, artifactDigest }, {}, { privateKey: strangerKeys.privateKey }),
          ],
          rejected: 0,
        }),
        store,
        trust: TRUST,
        warn: () => {},
        reportEvent: () => {},
        latch: { warned: false, reported: new Set() },
        ...options,
      }),
    });
    return { coordinator, registry, store, lockManager, artifactCache, cache };
  }

  it("activates and invokes a tool whose certificate fails, on download and from cache", async () => {
    const { coordinator, registry, store, lockManager, artifactCache, cache } = setup();

    const downloaded = await coordinator.reconcileLockedTools();
    expect(downloaded).toMatchObject({ activated: ["calc_tool"], failed: [] });
    expect(store.readSummary()).toMatchObject({ failed: 1, verified: 0 });

    const cached = await coordinator.reconcileLockedToolsOffline();
    expect(cached).toMatchObject({ activated: ["calc_tool"], failed: [] });
    expect(store.readSummary()).toMatchObject({ failed: 1 });
    expect(registry.isToolActiveForWorkspace?.(TOOL_ID, "1.0.0", "ws-1")).toBe(true);

    const executor = new LocalArtifactExecutor({ cache: artifactCache });
    const execute = vi.spyOn(executor, "execute").mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const router = new CloudInvocationRouter({
      catalogCache: cache,
      localExecutor: executor,
      lockManager,
    });
    const context: WorkspaceContext = {
      workspaceId: "ws-1",
      projectId: PROJECT,
      projectRoot: dir,
      canonicalRoot: dir,
      startupPath: dir,
      isReadOnly: false,
      name: "project",
      source: "cwd_fallback",
      roots: [],
    };
    const result = await router.forwardInvocation(TOOL_ID, { input: "x" }, context);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("still activates when every part of the certificate check throws", async () => {
    const { coordinator, store } = setup({
      identity: async () => {
        throw new Error("boom");
      },
      fetchCertificates: async () => {
        throw new Error("boom");
      },
    });
    expect(await coordinator.reconcileLockedTools()).toMatchObject({
      activated: ["calc_tool"],
      failed: [],
    });
    expect(store.readSummary()).toBeUndefined();
  });

  it("blocks activation only under the internal enforce option", async () => {
    const { coordinator } = setup({ enforce: true });
    expect(await coordinator.reconcileLockedTools()).toMatchObject({
      activated: [],
      failed: ["calc_tool"],
    });
  });
});

describe("CloudCatalogClient.fetchToolCertificates", () => {
  function client(fetchFn: typeof fetch, circuitBreaker = new CloudCircuitBreaker()) {
    return new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: `${ORIGIN}/`,
      authToken: "token",
      fetchFn,
      circuitBreaker,
    });
  }

  it("reads 404 as a cloud that does not issue certificates", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 }));
    await expect(client(fetchFn).fetchToolCertificates()).resolves.toEqual({ kind: "not-issued" });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/v1/catalog/certificates`);
    expect(url.searchParams.get("workspaceId")).toBe("ws-1");
  });

  it("keeps valid certificates and drops malformed ones", async () => {
    const valid = certify(SUBJECT);
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ certificates: [valid, { ...valid, toolId: "nope" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client(fetchFn).fetchToolCertificates()).resolves.toEqual({
      kind: "certificates",
      certificates: [valid],
      rejected: 1,
    });
  });

  it("throws on server errors without tripping the catalog circuit breaker", async () => {
    const breaker = new CloudCircuitBreaker();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    const catalog = client(fetchFn, breaker);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(catalog.fetchToolCertificates()).rejects.toThrow(/HTTP 503/);
    }
    expect(breaker.canExecute()).toBe(true);
    expect(catalog.isCloudPaused()).toBe(false);
  });
});
