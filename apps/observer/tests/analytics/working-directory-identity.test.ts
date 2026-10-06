/**
 * Each recorded call carries a keyed, equality-only identity of the directory it ran in, so the
 * cloud can tell two repositories apart inside one agent turn without ever seeing a path.
 */
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  RESIN_WORKING_DIRECTORY_METADATA_KEY,
  type WorkingDirectoryIdentity,
  readWorkingDirectoryIdentity,
} from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { FilePrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  type EffectiveDirectory,
  WorkingDirectoryIdentifier,
  effectiveWorkingDirectory,
} from "../../src/analytics/working-directory-identity.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
  WorkflowCallRecorder,
} from "../../src/index.js";
import { resolvePaths } from "../../src/paths.js";

const timestamp = "2026-09-19T00:00:00.000Z";
const SESSION_ROOT = "/synthetic/zq-alpha-repo";
const OTHER_REPO = "/synthetic/zq-beta-repo";

const session: HarnessSession = {
  sessionId: "sess_working_directory_identity",
  workspaceId: "ws_working_directory_identity",
  harnessId: "omp",
  transcriptPath: "/synthetic/transcripts/session.jsonl",
  status: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: {},
};

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resin-working-directory-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function posix(directory: string): EffectiveDirectory {
  return { path: directory, flavor: "posix" };
}

function identifier(key: Uint8Array, findRepositoryRoot = () => undefined) {
  return new WorkingDirectoryIdentifier({ deviceKey: () => key, findRepositoryRoot });
}

function bashCall(sequenceNumber: number, callId: string, cwd?: string): RawHarnessRecord {
  return {
    recordId: `working_directory_record_${sequenceNumber}`,
    sessionId: session.sessionId,
    harnessId: "omp",
    sequenceNumber,
    timestamp,
    recordType: "custom",
    rawPayload: JSON.stringify({
      type: "custom",
      customType: "tool_execution_start",
      data: {
        toolCallId: callId,
        toolName: "bash",
        args: { command: "pnpm test", ...(cwd === undefined ? {} : { cwd }) },
      },
    }),
    cursor: {
      offset: sequenceNumber * 100,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  };
}

/** Records the calls through one installation (its own Resin home) and returns what it uploaded. */
async function captureUploads(
  resinHome: string,
  calls: ReadonlyArray<{ callId: string; cwd?: string }>,
) {
  const store = new FilePrivateValueStore(resolvePaths({ resinHome, env: {} }).dataDir);
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(new OmpRecordDecoder());
  const payloads: string[] = [];
  const uploaded: NormalizedSessionEvent[] = [];
  // SAFETY: the fake implements the only cloud method used by this unattributed coordinator.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  client.sendObservationBatch = vi.fn(async (input) => {
    payloads.push(JSON.stringify(input));
    uploaded.push(...input.observations.map((event) => NormalizedSessionEventSchema.parse(event)));
    return {
      batchId: input.batchId,
      status: "accepted",
      acceptedCount: input.observations.length,
      rejectedCount: 0,
      errors: [],
    };
  });
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: client,
    coalesceDwellMs: 0,
    privateValueStore: store,
    workflowCallRecorder: new WorkflowCallRecorder({
      privateValues: store,
      privateValueOwnerWorkspaceId: session.workspaceId,
    }),
    resolveSessionWorkingDirectory: (observed) =>
      observed.workspaceId === session.workspaceId ? SESSION_ROOT : undefined,
  });
  try {
    for (const [index, call] of calls.entries()) {
      await coordinator.handleRecords(
        session,
        [bashCall(index + 1, call.callId, call.cwd)],
        vi.fn(),
      );
    }
  } finally {
    coordinator.dispose();
  }
  const identities = new Map<string, WorkingDirectoryIdentity | undefined>();
  for (const event of uploaded) {
    if (event.type !== "tool_call") continue;
    identities.set(
      event.callId,
      readWorkingDirectoryIdentity(event.metadata?.[RESIN_WORKING_DIRECTORY_METADATA_KEY]),
    );
  }
  return { payloads: payloads.join("\n"), identities, key: Buffer.from(store.redactionKey()) };
}

describe("effective working directory", () => {
  it("resolves the call's directory against the session's, or uses the session's", () => {
    expect(effectiveWorkingDirectory(undefined, "/w/repo")).toEqual(posix("/w/repo"));
    expect(effectiveWorkingDirectory("", "/w/repo/")).toEqual(posix("/w/repo"));
    expect(effectiveWorkingDirectory(".", "/w/repo")).toEqual(posix("/w/repo"));
    expect(effectiveWorkingDirectory("packages/a/../b", "/w/repo")).toEqual(
      posix("/w/repo/packages/b"),
    );
    expect(effectiveWorkingDirectory("/w/other", "/w/repo")).toEqual(posix("/w/other"));
    expect(effectiveWorkingDirectory("~/work", "/w/repo", "/home/someone")).toEqual(
      posix("/home/someone/work"),
    );
    expect(effectiveWorkingDirectory("file:///w/other/", undefined)).toEqual(posix("/w/other"));
    expect(effectiveWorkingDirectory("C:\\Work\\Repo\\", undefined)).toEqual({
      path: "C:\\Work\\Repo",
      flavor: "win32",
    });
  });

  it("is unknown when a relative or absent directory has no absolute session directory", () => {
    expect(effectiveWorkingDirectory("packages/a", undefined)).toBeUndefined();
    expect(effectiveWorkingDirectory(undefined, undefined)).toBeUndefined();
    expect(effectiveWorkingDirectory(undefined, "relative/root")).toBeUndefined();
  });
});

describe("working directory identity", () => {
  const key = Buffer.alloc(32, 7);

  it("is equal for the same directory and differs for different ones within an installation", () => {
    const ids = identifier(key);
    const repo = ids.identify(posix("/w/repo"));
    expect(repo?.directory).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.identify(posix("/w/repo"))).toEqual(repo);
    expect(identifier(key).identify(posix("/w/repo"))).toEqual(repo);
    expect(ids.identify(posix("/w/other"))?.directory).not.toBe(repo?.directory);
    expect(ids.identify(posix("/w/repo/sub"))?.directory).not.toBe(repo?.directory);
  });

  it("differs across installations, whose secrets differ", () => {
    const first = identifier(Buffer.alloc(32, 1)).identify(posix("/w/repo"));
    const second = identifier(Buffer.alloc(32, 2)).identify(posix("/w/repo"));
    expect(first?.directory).not.toBe(second?.directory);
  });

  it("folds case for Windows paths only", () => {
    const ids = identifier(key);
    expect(ids.identify({ path: "C:\\Work\\Repo", flavor: "win32" })).toEqual(
      ids.identify({ path: "c:\\work\\repo", flavor: "win32" }),
    );
    expect(ids.identify(posix("/W/Repo"))).not.toEqual(ids.identify(posix("/w/repo")));
  });

  it("produces nothing without the device secret", () => {
    const ids = new WorkingDirectoryIdentifier({ deviceKey: () => undefined });
    expect(ids.identify(posix("/w/repo"))).toBeUndefined();
  });

  it("identifies the enclosing repository in the same space as directories", () => {
    const root = temporaryDirectory();
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "packages", "core");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere\n");
    const ids = new WorkingDirectoryIdentifier({ deviceKey: () => key });
    const flavor = process.platform === "win32" ? "win32" : "posix";
    const atRoot = ids.identify({ path: repo, flavor });
    const inside = ids.identify({ path: nested, flavor });
    expect(atRoot?.repository).toBe(atRoot?.directory);
    expect(inside?.repository).toBe(atRoot?.directory);
    expect(inside?.directory).not.toBe(atRoot?.directory);
    const tree = ids.identify({ path: worktree, flavor });
    expect(tree?.repository).toBe(tree?.directory);
    expect(ids.identify({ path: root, flavor })?.repository).toBeUndefined();
  });
});

describe("working directory identity capture", () => {
  it("tells two repositories apart inside one session without uploading a path or the secret", async () => {
    const resinHome = path.join(temporaryDirectory(), ".resin");
    const { payloads, identities, key } = await captureUploads(resinHome, [
      { callId: "call_session_root" },
      { callId: "call_other_repo", cwd: OTHER_REPO },
      { callId: "call_explicit_root", cwd: SESSION_ROOT },
      { callId: "call_relative", cwd: "packages/zq-gamma" },
      { callId: "call_other_again", cwd: `${OTHER_REPO}/` },
    ]);
    const sessionRoot = identities.get("call_session_root")?.directory;
    const otherRepo = identities.get("call_other_repo")?.directory;
    expect(sessionRoot).toMatch(/^[0-9a-f]{32}$/);
    expect(otherRepo).toMatch(/^[0-9a-f]{32}$/);
    expect(otherRepo).not.toBe(sessionRoot);
    expect(identities.get("call_explicit_root")?.directory).toBe(sessionRoot);
    expect(identities.get("call_other_again")?.directory).toBe(otherRepo);
    const relative = identities.get("call_relative")?.directory;
    expect(relative).toMatch(/^[0-9a-f]{32}$/);
    expect([sessionRoot, otherRepo]).not.toContain(relative);

    // No path text and no form of the device secret (or the key derived from it) leaves.
    for (const text of ["/synthetic", "zq-alpha", "zq-beta", "zq-gamma", "packages/"]) {
      expect(payloads).not.toContain(text);
    }
    for (const encoding of ["hex", "base64", "base64url"] as const) {
      expect(payloads).not.toContain(key.toString(encoding));
    }
    const derived = createHmac("sha256", key).update("resin:working-directory-identity:v1");
    expect(payloads).not.toContain(derived.digest("hex"));
  });

  it("keeps the secret owner-only under the Resin home, and other installations get other identities", async () => {
    const firstHome = path.join(temporaryDirectory(), ".resin");
    const secondHome = path.join(temporaryDirectory(), ".resin");
    const first = await captureUploads(firstHome, [{ callId: "call_root" }]);
    const second = await captureUploads(secondHome, [{ callId: "call_root" }]);
    expect(first.identities.get("call_root")?.directory).toMatch(/^[0-9a-f]{32}$/);
    expect(second.identities.get("call_root")?.directory).toMatch(/^[0-9a-f]{32}$/);
    expect(first.identities.get("call_root")?.directory).not.toBe(
      second.identities.get("call_root")?.directory,
    );

    const keyFile = path.join(firstHome, "data", "private-values", "redaction-key");
    expect(fs.readFileSync(keyFile)).toEqual(first.key);
    if (process.platform !== "win32") {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }
    // A restarted installation keeps its identities: the secret persists.
    const again = await captureUploads(firstHome, [{ callId: "call_root" }]);
    expect(again.identities.get("call_root")).toEqual(first.identities.get("call_root"));
  });
});

describe("working directory identity projection", () => {
  const base = {
    eventId: "evt_working_directory_projection",
    sessionId: "sess_working_directory_projection",
    schemaVersion: "1.0.0",
    timestamp,
    causalRef: { causalSequence: 1 },
    redaction: {
      isRedacted: false,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "tool_call",
    callId: "call_projection",
    toolName: "bash",
    parameters: { command: "pnpm test" },
    isShadow: false,
  } as const;

  it("copies a well-formed identity and drops anything else under its key", () => {
    const identity = { directory: "a".repeat(32), repository: "b".repeat(32) };
    const kept = projectEventToMetadataOnly({
      ...base,
      metadata: { [RESIN_WORKING_DIRECTORY_METADATA_KEY]: identity },
    });
    expect(kept.metadata?.[RESIN_WORKING_DIRECTORY_METADATA_KEY]).toEqual(identity);

    for (const forged of [
      { directory: "/synthetic/zq-alpha-repo" },
      { directory: "a".repeat(32), path: "/synthetic/zq-alpha-repo" },
      { directory: "A".repeat(32) },
      "/synthetic/zq-alpha-repo",
    ]) {
      const projected = projectEventToMetadataOnly({
        ...base,
        metadata: { [RESIN_WORKING_DIRECTORY_METADATA_KEY]: forged },
      });
      expect(projected.metadata?.[RESIN_WORKING_DIRECTORY_METADATA_KEY]).toBeUndefined();
      expect(JSON.stringify(projected)).not.toContain("zq-alpha");
    }
  });

  it("replaces an identity a transcript supplied with the device's own", () => {
    const key = Buffer.alloc(32, 9);
    const ids = identifier(key);
    const event: NormalizedSessionEvent = {
      ...base,
      metadata: { [RESIN_WORKING_DIRECTORY_METADATA_KEY]: { directory: "c".repeat(32) } },
    };
    // Without the pipeline's retained original the directory is unknown: nothing is attached.
    ids.annotate(event, event, "/w/repo");
    expect(event.metadata?.[RESIN_WORKING_DIRECTORY_METADATA_KEY]).toBeUndefined();
  });
});
