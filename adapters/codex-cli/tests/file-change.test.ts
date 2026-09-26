import { readCodexCommandMetadata } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { CodexSessionDecoder } from "../src/decoder.js";

/** The canonical effect record of a real Codex 0.156 service-config session. */
function fileChange(changes: Record<string, unknown>, status = "completed") {
  return {
    type: "event_msg",
    timestamp: "2026-09-26T13:11:09.891Z",
    payload: {
      type: "item_completed",
      item: {
        type: "FileChange",
        id: "exec-0947ff9f-1987-4725-a62a-de453be37700",
        changes,
        status,
        stdout: "Success. Updated the following files:\nM /app/services.yaml\n",
        stderr: "",
      },
      started_at_ms: 1790428269859,
      completed_at_ms: 1790428269891,
    },
  };
}

const SERVICES_DIFF =
  "@@ -11,2 +11,5 @@\n     path: /orders\n+  - name: media\n+    port: 8083\n+    path: /media\n \n";

function decode(record: unknown) {
  return new CodexSessionDecoder({ sessionId: "s" }).decodeRecord(record as never);
}

describe("Codex FileChange items", () => {
  it("decodes the real update into one Codex-native edit with a self-describing diff", () => {
    const events = decode(
      fileChange({
        "/app/services.yaml": { type: "update", unified_diff: SERVICES_DIFF, move_path: null },
      }),
    );
    expect(events).toHaveLength(1);
    const edit = events[0]!;
    expect(edit.type).toBe("file_edit");
    if (edit.type !== "file_edit") return;
    expect(edit.filePath).toBe("/app/services.yaml");
    expect(edit.operation).toBe("update");
    expect(edit.patch).toBe(`--- /app/services.yaml\n+++ /app/services.yaml\n${SERVICES_DIFF}`);
    expect(readCodexCommandMetadata(edit.metadata)).toEqual({
      version: 1,
      kind: "file-change",
      nativeId: "exec-0947ff9f-1987-4725-a62a-de453be37700",
    });
  });

  it("restates whole-file adds and deletes as diffs, one edit per path with distinct ids", () => {
    const events = decode(
      fileChange({
        "/app/new.txt": { type: "add", content: "one\ntwo\n" },
        "/app/old.txt": { type: "delete", content: "gone\n" },
      }),
    );
    expect(events.map((event) => (event.type === "file_edit" ? event.patch : undefined))).toEqual([
      "--- /dev/null\n+++ /app/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
      "--- /app/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n",
    ]);
    expect(events.map((event) => event.type === "file_edit" && event.operation)).toEqual([
      "create",
      "delete",
    ]);
    const ids = events.map((event) => readCodexCommandMetadata(event.metadata));
    expect(ids.map((id) => (id?.kind === "file-change" ? id.nativeId : undefined))).toEqual([
      "exec-0947ff9f-1987-4725-a62a-de453be37700-0",
      "exec-0947ff9f-1987-4725-a62a-de453be37700-1",
    ]);
  });

  it.each([
    [
      "a rename",
      { "/app/a": { type: "update", unified_diff: SERVICES_DIFF, move_path: "/app/b" } },
    ],
    [
      "an unknown field",
      { "/app/a": { type: "update", unified_diff: SERVICES_DIFF, move_path: null, mode: 1 } },
    ],
    ["an unknown change type", { "/app/a": { type: "chmod", content: "" } }],
    ["content without a final newline", { "/app/a": { type: "add", content: "no newline" } }],
    [
      "a diff without a hunk",
      { "/app/a": { type: "update", unified_diff: "x\n", move_path: null } },
    ],
    ["no changes", {}],
  ])("decodes %s to nothing", (_, changes) => {
    expect(decode(fileChange(changes as Record<string, unknown>))).toEqual([]);
  });

  it("decodes an unfinished item to nothing", () => {
    const changes = {
      "/app/services.yaml": { type: "update", unified_diff: SERVICES_DIFF, move_path: null },
    };
    expect(decode(fileChange(changes, "in_progress"))).toEqual([]);
  });

  it("marks a code-mode cell that only applies a patch, and no other cell", () => {
    const cell = (input: string) =>
      decode({
        type: "response_item",
        timestamp: "2026-09-26T13:11:05.000Z",
        payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input },
      }).find((event) => event.type === "tool_call");
    const patch = JSON.stringify("*** Begin Patch\n*** Update File: /app/a\n@@\n+x\n*** End Patch");
    expect(
      readCodexCommandMetadata(cell(`text(await tools.apply_patch(${patch}));\n`)?.metadata),
    ).toEqual({ version: 1, kind: "patch-call" });
    expect(readCodexCommandMetadata(cell(`await tools.apply_patch(${patch});`)?.metadata)).toEqual({
      version: 1,
      kind: "patch-call",
    });
    for (const other of [
      `text(await tools.apply_patch(${patch})); text(await tools.exec_command({cmd:"ls"}));`,
      "const p = 'x'; text(await tools.apply_patch(p));",
    ]) {
      expect(readCodexCommandMetadata(cell(other)?.metadata)).toBeUndefined();
    }
  });
});
