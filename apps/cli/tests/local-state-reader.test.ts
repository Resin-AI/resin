import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalDatabaseConnection } from "@resin/db";
import type { HarnessSession } from "@resin/harness-contracts";
import {
  HARNESS_VERIFIED_MIN_EVENTS,
  HARNESS_VERIFIED_MIN_SESSIONS,
  HarnessVersionStatsRecorder,
  type PipelineProcessResult,
  classifyHarnessVersionEvidence,
} from "@resin/observer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalStateReader } from "../src/service/local-state-reader.js";

const PROJECT_ID = "8f0a906f-e0e5-4674-a998-08494abdbc3e";
const OTHER_PROJECT_ID = "01d09c72-9043-49f2-a41e-5a8ea95a3a4c";

let root: string;
let project: string;
let dataDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-state-reader-"));
  project = path.join(root, "project");
  dataDir = path.join(root, "data");
  await fs.mkdir(path.join(project, ".resin"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".resin", "project.json"),
    JSON.stringify({
      schemaKind: "project_metadata",
      schemaVersion: "1.0.0",
      projectId: PROJECT_ID,
      name: "project",
      createdAt: "2026-08-28T00:59:00.878Z",
    }),
  );
  await fs.writeFile(
    path.join(project, ".resin", "resin.lock"),
    JSON.stringify({
      schemaKind: "tool_lock",
      schemaVersion: "1.0.0",
      projectId: PROJECT_ID,
      updatedAt: "2026-09-29T17:38:16.674Z",
      tools: {},
    }),
  );
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

function seedStateDb(seed: (conn: LocalDatabaseConnection) => void | Promise<void>): Promise<void> {
  const conn = new LocalDatabaseConnection({ path: path.join(dataDir, "state.db") }).open();
  conn.exec(`CREATE TABLE catalog_snapshots (
    snapshot_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    tools_json TEXT NOT NULL DEFAULT '{}', digest TEXT NOT NULL)`);
  return Promise.resolve(seed(conn)).finally(() => conn.close());
}

function snapshot(
  conn: LocalDatabaseConnection,
  id: string,
  workspaceId: string,
  timestamp: string,
  tools: Record<string, { scope: string; status: string }>,
): void {
  conn.run(
    "INSERT INTO catalog_snapshots (snapshot_id, workspace_id, timestamp, tools_json, digest) VALUES (?, ?, ?, ?, ?)",
    [id, workspaceId, timestamp, JSON.stringify(tools), id],
  );
}

const SYSTEM_TOOLS = {
  sys_search_tools: { scope: "global", status: "active" },
  sys_get_tool_schema: { scope: "global", status: "active" },
  sys_invoke_tool: { scope: "global", status: "active" },
  sys_manage_tools: { scope: "global", status: "active" },
};

describe("openLocalStateReader servedCatalog", () => {
  it("counts the active non-system tools of the workspace's latest served snapshot", async () => {
    await seedStateDb((conn) => {
      snapshot(conn, "old", PROJECT_ID, "2026-09-29T10:00:00.000Z", {
        ...SYSTEM_TOOLS,
        tool_a: { scope: "workspace", status: "active" },
        tool_b: { scope: "workspace", status: "active" },
        tool_c: { scope: "workspace", status: "active" },
      });
      snapshot(conn, "new", PROJECT_ID, "2026-09-29T18:00:00.000Z", {
        ...SYSTEM_TOOLS,
        tool_a: { scope: "workspace", status: "active" },
        tool_disabled: { scope: "workspace", status: "disabled" },
      });
      // Another workspace's newer catalog must not leak into this one.
      snapshot(conn, "other", OTHER_PROJECT_ID, "2026-09-29T19:00:00.000Z", {
        ...SYSTEM_TOOLS,
        x: { scope: "workspace", status: "active" },
        y: { scope: "workspace", status: "active" },
      });
    });
    const reader = openLocalStateReader({ dataDir });
    try {
      expect(await reader.servedCatalog(project)).toEqual({
        available: true,
        workspaceId: PROJECT_ID,
        customToolsCount: 1,
        asOf: "2026-09-29T18:00:00.000Z",
      });
    } finally {
      reader.close();
    }
  });

  it("reports a served catalog holding only system tools as an available 0", async () => {
    await seedStateDb((conn) =>
      snapshot(conn, "s", PROJECT_ID, "2026-09-29T18:00:00.000Z", SYSTEM_TOOLS),
    );
    const reader = openLocalStateReader({ dataDir });
    try {
      expect(await reader.servedCatalog(project)).toMatchObject({
        available: true,
        customToolsCount: 0,
      });
    } finally {
      reader.close();
    }
  });

  it("names why the catalog is unavailable instead of counting 0", async () => {
    const missing = openLocalStateReader({ dataDir });
    expect(await missing.servedCatalog(project)).toEqual({
      available: false,
      reason: "state_db_missing",
      workspaceId: null,
    });
    missing.close();
    // Reading must not have created the store.
    await expect(fs.stat(dataDir)).rejects.toThrow();

    await seedStateDb(() => {});
    const reader = openLocalStateReader({ dataDir });
    try {
      expect(await reader.servedCatalog(project)).toEqual({
        available: false,
        reason: "no_snapshot",
        workspaceId: PROJECT_ID,
      });
      const elsewhere = path.join(root, "not-a-project");
      await fs.mkdir(elsewhere);
      expect(await reader.servedCatalog(elsewhere)).toEqual({
        available: false,
        reason: "no_workspace",
        workspaceId: null,
      });
    } finally {
      reader.close();
    }
  });

  it("reports an unparseable snapshot as unreadable", async () => {
    await seedStateDb((conn) =>
      conn.run(
        "INSERT INTO catalog_snapshots (snapshot_id, workspace_id, timestamp, tools_json, digest) VALUES ('bad', ?, '2026-09-29T18:00:00.000Z', 'not json', 'bad')",
        [PROJECT_ID],
      ),
    );
    const reader = openLocalStateReader({ dataDir });
    try {
      expect(await reader.servedCatalog(project)).toMatchObject({
        available: false,
        reason: "snapshot_unreadable",
      });
    } finally {
      reader.close();
    }
  });
});

describe("openLocalStateReader harnessVersionStats", () => {
  function batch(count: number): PipelineProcessResult[] {
    // SAFETY: the recorder only reads `status`, `isDuplicate` and `event.type`.
    return Array.from({ length: count }, () => ({
      status: "success",
      isDuplicate: false,
      event: { type: "message" },
    })) as unknown as PipelineProcessResult[];
  }

  it("reads what the observer's recorder persisted, per harness version", async () => {
    const writer = new LocalDatabaseConnection({ path: path.join(dataDir, "state.db") }).open();
    const recorder = new HarnessVersionStatsRecorder({
      conn: writer,
      resolveVersion: async () => "18.4.0",
    });
    for (let index = 0; index < HARNESS_VERIFIED_MIN_SESSIONS; index += 1) {
      const session: HarnessSession = {
        sessionId: `s${index}`,
        workspaceId: "ws",
        harnessId: "omp",
        transcriptPath: `/tmp/s${index}.jsonl`,
        status: "active",
        createdAt: "2026-09-29T12:00:00.000Z",
        updatedAt: "2026-09-29T12:00:00.000Z",
        metadata: {},
      };
      recorder.record(session, batch(HARNESS_VERIFIED_MIN_EVENTS / HARNESS_VERIFIED_MIN_SESSIONS));
    }
    await recorder.flush();
    writer.close();

    const reader = openLocalStateReader({ dataDir });
    try {
      const stats = reader.harnessVersionStats("omp", "18.4.0");
      expect(stats).toMatchObject({
        sessionsOk: HARNESS_VERIFIED_MIN_SESSIONS,
        eventsDecoded: HARNESS_VERIFIED_MIN_EVENTS,
      });
      expect(classifyHarnessVersionEvidence(stats).kind).toBe("verified");
      expect(reader.harnessVersionStats("omp", "18.5.0")).toBeNull();
      expect(reader.harnessVersionStats("pi", "18.4.0")).toBeNull();
    } finally {
      reader.close();
    }
  });

  it("has no stats from a store that predates them", async () => {
    await seedStateDb(() => {});
    const reader = openLocalStateReader({ dataDir });
    try {
      expect(reader.harnessVersionStats("omp", "18.4.0")).toBeNull();
    } finally {
      reader.close();
    }
  });
});
