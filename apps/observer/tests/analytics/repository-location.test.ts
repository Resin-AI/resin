/**
 * Recorded calls carry the repository they ran in — a hash of its root commits, the same for every
 * checkout — and the directory relative to the checkout's root, so a plan can run in the caller's
 * own checkout instead of the recorded absolute path.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  RESIN_REPOSITORY_METADATA_KEY,
  type RepositoryLocationMetadata,
  readRepositoryLocationMetadata,
} from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { FilePrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
  WorkflowCallRecorder,
} from "../../src/index.js";
import { resolvePaths } from "../../src/paths.js";
import {
  clearRepositoryIdentityCache,
  repositoryIdentity,
  repositoryRelativeDirectory,
} from "../../src/repository-identity.js";

const timestamp = "2026-09-19T00:00:00.000Z";
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
};
const savedEnv: Record<string, string | undefined> = {};
const scratch: string[] = [];

beforeAll(() => {
  for (const [name, value] of Object.entries(GIT_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  clearRepositoryIdentityCache();
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `resin-repo-${label}-`)));
  scratch.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

function makeRepository(seed: string): string {
  const root = tempDir(seed);
  git(root, "init", "-q");
  fs.mkdirSync(path.join(root, "pkg", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "app", "README"), `${seed}\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", `seed ${seed}`);
  return root;
}

describe("repositoryIdentity", () => {
  it("is the same for every worktree and clone of one repository and differs across repositories", () => {
    const main = makeRepository("alpha");
    const worktree = path.join(tempDir("worktree"), "checkout");
    git(main, "worktree", "add", "-q", worktree);
    const clone = path.join(tempDir("clone"), "checkout");
    git(main, "clone", "-q", main, clone);
    const other = makeRepository("beta");

    const id = repositoryIdentity(main)?.id;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(repositoryIdentity(path.join(worktree, "pkg"))).toEqual({ id, root: worktree });
    expect(repositoryIdentity(path.join(clone, "pkg", "app"))).toEqual({ id, root: clone });
    expect(repositoryIdentity(other)?.id).not.toBe(id);
    const roots = git(main, "rev-list", "--max-parents=0", "HEAD").trim();
    expect(id).toBe(createHash("sha256").update(roots).digest("hex"));
  });

  it("is undefined outside git, without commits, in a shallow clone, or for a missing directory", () => {
    expect(repositoryIdentity(tempDir("plain"))).toBeUndefined();
    const empty = tempDir("empty");
    git(empty, "init", "-q");
    expect(repositoryIdentity(empty)).toBeUndefined();
    const deep = makeRepository("gamma");
    fs.writeFileSync(path.join(deep, "second"), "2\n");
    git(deep, "add", ".");
    git(deep, "commit", "-q", "-m", "second");
    const shallow = path.join(tempDir("shallow"), "checkout");
    git(deep, "clone", "-q", "--depth", "1", `file://${deep}`, shallow);
    expect(repositoryIdentity(shallow)).toBeUndefined();
    expect(repositoryIdentity(path.join(deep, "does-not-exist"))).toBeUndefined();
  });

  it("gives the directory relative to the checkout root in POSIX form", () => {
    const root = makeRepository("delta");
    expect(repositoryRelativeDirectory(root, root)).toBe("");
    expect(repositoryRelativeDirectory(root, path.join(root, "pkg", "app"))).toBe("pkg/app");
    expect(repositoryRelativeDirectory(root, tempDir("outside"))).toBeUndefined();
  });
});

const session: HarnessSession = {
  sessionId: "sess_repository_location",
  workspaceId: "ws_repository_location",
  harnessId: "omp",
  transcriptPath: "/synthetic/transcripts/session.jsonl",
  status: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: {},
};

function bashCall(
  sequenceNumber: number,
  callId: string,
  command: string,
  cwd?: string,
): RawHarnessRecord {
  return {
    recordId: `repository_location_record_${sequenceNumber}`,
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
        args: { command, ...(cwd === undefined ? {} : { cwd }) },
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

async function captureUploads(
  sessionRoot: string,
  calls: ReadonlyArray<{ callId: string; command: string; cwd?: string }>,
) {
  const resinHome = tempDir("home");
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
      observed.workspaceId === session.workspaceId ? sessionRoot : undefined,
  });
  try {
    for (const [index, call] of calls.entries()) {
      await coordinator.handleRecords(
        session,
        [bashCall(index + 1, call.callId, call.command, call.cwd)],
        vi.fn(),
      );
    }
  } finally {
    coordinator.dispose();
  }
  const locations = new Map<string, RepositoryLocationMetadata | undefined>();
  const raw = new Map<string, unknown>();
  for (const event of uploaded) {
    if (event.type !== "tool_call") continue;
    raw.set(event.callId, event.metadata?.[RESIN_REPOSITORY_METADATA_KEY]);
    locations.set(
      event.callId,
      readRepositoryLocationMetadata(event.metadata?.[RESIN_REPOSITORY_METADATA_KEY]),
    );
  }
  return { locations, raw, payload: payloads.join("\n") };
}

describe("repository location annotation", () => {
  it("attaches the repository id and repository-relative directory of each shell call", async () => {
    const root = makeRepository("epsilon");
    const outside = tempDir("outside");
    const id = repositoryIdentity(root)!.id;

    const { locations, raw, payload } = await captureUploads(root, [
      { callId: "call_root", command: "pnpm test" },
      { callId: "call_subdir", command: "pnpm test", cwd: path.join(root, "pkg") },
      { callId: "call_relative", command: "pnpm test", cwd: "pkg/app" },
      { callId: "call_cd", command: `cd ${root}/pkg/app && pnpm test` },
      { callId: "call_outside", command: "pnpm test", cwd: outside },
      { callId: "call_cd_outside", command: `cd ${outside} && pnpm test` },
    ]);

    expect(locations.get("call_root")).toEqual({ id, path: "" });
    expect(locations.get("call_subdir")).toEqual({ id, path: "pkg" });
    expect(locations.get("call_relative")).toEqual({ id, path: "pkg/app" });
    expect(locations.get("call_cd")).toEqual({ id, path: "pkg/app", leadingCd: true });
    expect(locations.get("call_outside")).toBeUndefined();
    expect(locations.get("call_cd_outside")).toBeUndefined();
    // Well formed: exactly the frozen shape, nothing else under the key.
    for (const [callId, value] of raw) {
      if (value !== undefined) expect(readRepositoryLocationMetadata(value), callId).toEqual(value);
    }
    // The checkout's absolute location never leaves the device under this key.
    expect(JSON.stringify([...raw.values()])).not.toContain(root);
    expect(payload).toContain(id);
  });

  it("projects only a well-formed carrier and drops forged ones", () => {
    const base = {
      eventId: "evt_repository_location",
      sessionId: session.sessionId,
      harnessId: "omp",
      timestamp,
      sequenceNumber: 1,
      type: "tool_call",
      callId: "call_projected",
      toolName: "bash",
      parameters: { command: "pnpm test" },
    } as unknown as NormalizedSessionEvent;
    const valid = { id: "a".repeat(64), path: "pkg/app" };
    const kept = projectEventToMetadataOnly({
      ...base,
      metadata: { [RESIN_REPOSITORY_METADATA_KEY]: valid },
    } as NormalizedSessionEvent);
    expect(kept.metadata?.[RESIN_REPOSITORY_METADATA_KEY]).toEqual(valid);
    for (const forged of [
      { id: "a".repeat(64), path: "/synthetic/zq-absolute" },
      { id: "a".repeat(64), path: "../escape" },
      { id: "A".repeat(64), path: "" },
      { id: "a".repeat(64), path: "pkg", root: "/synthetic/zq-root" },
      { id: "a".repeat(64), path: "pkg", leadingCd: false },
      "a".repeat(64),
    ]) {
      const projected = projectEventToMetadataOnly({
        ...base,
        metadata: { [RESIN_REPOSITORY_METADATA_KEY]: forged },
      } as NormalizedSessionEvent);
      expect(projected.metadata?.[RESIN_REPOSITORY_METADATA_KEY]).toBeUndefined();
    }
  });
});
