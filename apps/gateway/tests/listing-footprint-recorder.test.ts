import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ListingFootprintRecord,
  ListingFootprintRecordSchema,
  listingTextTokens,
  listingToolTokens,
} from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LISTING_FOOTPRINT_RETENTION_MS,
  createListingFootprintRecorder,
  pruneListingFootprintRecords,
} from "../src/shim/listing-footprint-recorder.js";
import type { ServedListingSurface } from "../src/shim/tool-search-surface.js";

const GUIDANCE = "<!-- resin:start -->\nUse Resin's learned tools.\n<!-- resin:end -->";

const surface: ServedListingSurface = {
  clientName: "claude-code",
  instructions: "Resin's learned tools for this workspace:\n- build_site({})",
  tools: [
    { name: "invoke_tool", description: "Runs a tool.", inputSchema: { type: "object" } },
    { name: "build_site", description: "Builds the site.", inputSchema: { type: "object" } },
  ],
  listedToolIds: ["tool_build"],
  capped: false,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-footprints-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const records = (): ListingFootprintRecord[] =>
  fs
    .readdirSync(dir)
    .map((name) =>
      ListingFootprintRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))),
    );

describe("listing footprint recorder", () => {
  it("records the served surface once, with the guidance block in its instructions, and closes it", () => {
    const recorder = createListingFootprintRecorder({
      dir,
      cwd: "/work/site",
      guidanceBlock: () => GUIDANCE,
    });
    recorder.served(surface);
    // The same surface served again adds nothing.
    recorder.served({ ...surface });

    const [record, ...others] = records();
    expect(others).toEqual([]);
    expect(record?.harnessId).toBe("claude-code");
    expect(record?.cwd).toBe(path.resolve("/work/site"));
    expect(record?.pid).toBe(process.pid);
    expect(record?.closedAt).toBeUndefined();
    expect(record?.surfaces).toHaveLength(1);
    const footprint = record?.surfaces[0]?.footprint;
    expect(footprint?.instructionsTokens).toBe(
      listingTextTokens(surface.instructions) + listingTextTokens(GUIDANCE),
    );
    expect(footprint?.toolsTokens).toBe(
      surface.tools.reduce((sum, tool) => sum + listingToolTokens(tool), 0),
    );
    expect(footprint?.toolCount).toBe(2);
    expect(footprint?.toolIds).toEqual(["tool_build"]);

    // A changed surface is appended.
    recorder.served({ ...surface, tools: surface.tools.slice(0, 1), listedToolIds: [] });
    expect(records()[0]?.surfaces).toHaveLength(2);

    recorder.close();
    expect(records()[0]?.closedAt).toEqual(expect.any(String));
  });

  it("names the harness by its explicit id, or by a client name it maps", () => {
    const explicit = createListingFootprintRecorder({
      dir,
      cwd: dir,
      harnessId: "omp",
      guidanceBlock: () => "",
    });
    explicit.served({ ...surface, clientName: "generic thing" });
    const codex = createListingFootprintRecorder({
      dir,
      cwd: dir,
      guidanceBlock: () => "",
      // A second record file in the same process needs another start time.
      now: () => new Date(Date.now() + 1_000),
    });
    codex.served({ ...surface, clientName: "codex-mcp-client" });
    expect(
      records()
        .map((record) => record.harnessId)
        .sort(),
    ).toEqual(["codex-cli", "omp"]);
    // Without a guidance block, only the server instructions count.
    expect(records()[0]?.surfaces[0]?.footprint.instructionsTokens).toBe(
      listingTextTokens(surface.instructions),
    );
  });

  it("records nothing for a harness it cannot name, an unreadable guidance block, or nothing served", () => {
    const unnamed = createListingFootprintRecorder({ dir, cwd: dir, guidanceBlock: () => "" });
    unnamed.served({ ...surface, clientName: "generic thing" });
    unnamed.close();

    const unreadable = createListingFootprintRecorder({
      dir,
      cwd: dir,
      guidanceBlock: () => undefined,
    });
    unreadable.served(surface);
    unreadable.close();

    const idle = createListingFootprintRecorder({ dir, cwd: dir, guidanceBlock: () => GUIDANCE });
    idle.close();

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("closes the record of a gateway that exited and deletes one closed past retention", () => {
    const now = new Date();
    const footprint = {
      version: 1 as const,
      tokenMethod: "utf8_div4_v1" as const,
      instructionsTokens: 10,
      toolsTokens: 5,
      totalTokens: 15,
      toolCount: 1,
      toolIds: [],
      capped: false,
    };
    const base = {
      version: 1 as const,
      harnessId: "claude-code",
      cwd: "/work/site",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      surfaces: [{ servedAt: new Date(now.getTime() - 60_000).toISOString(), footprint }],
    };
    // A process that has already exited.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    if (deadPid === undefined) throw new Error("No exited process to point a record at");
    const write = (name: string, record: ListingFootprintRecord) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify(record));
    write("dead.json", { ...base, pid: deadPid });
    write("expired.json", {
      ...base,
      pid: process.pid,
      closedAt: new Date(now.getTime() - LISTING_FOOTPRINT_RETENTION_MS - 60_000).toISOString(),
    });
    write("running.json", { ...base, pid: process.pid });

    pruneListingFootprintRecords(dir, now);

    expect(fs.readdirSync(dir).sort()).toEqual(["dead.json", "running.json"]);
    const read = (name: string) =>
      ListingFootprintRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    expect(read("dead.json").closedAt).toEqual(expect.any(String));
    expect(read("running.json").closedAt).toBeUndefined();
  });
});
