import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeHarnessAdapter } from "@resin/adapter-claude-code";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserverCoordinator, SourceCursorManager } from "../../src/tailing/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude discovery through the observer", () => {
  it("attaches a discovered session to its exact hyphenated workspace and ingests appended records once", async () => {
    vi.useFakeTimers();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-claude-discovery-"));
    temporaryDirectories.push(home);
    const workspaceRoot = path.join(home, "workspaces", "my-project", "feature-work");
    const encodedProject = workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDirectory = path.join(home, ".claude", "projects", encodedProject);
    const transcriptPath = path.join(projectDirectory, "session-discovery.jsonl");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(projectDirectory, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(process, "cwd").mockReturnValue(workspaceRoot);

    const firstRecord = {
      type: "user",
      uuid: "message-history",
      sessionId: "session-discovery",
      cwd: workspaceRoot,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Inspect the synthetic fixture." },
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(firstRecord)}\n`);

    const adapter = new ClaudeHarnessAdapter();
    const coordinator = new ObserverCoordinator({
      cursorManager: new SourceCursorManager(),
      defaultBackfillPolicy: { mode: "latest" },
      pollIntervalMs: 50,
    });
    const notifyTerminal = vi.spyOn(coordinator.getTailer(), "notifyTerminalState");
    const received: RawHarnessRecord[] = [];
    coordinator.onRecords(async (_session, records, ack) => {
      received.push(...records);
      await ack();
    });
    coordinator.registerAdapter(adapter);

    try {
      const workspaces = await adapter.listWorkspaces();
      expect(workspaces.map((workspace) => workspace.rootPath)).toEqual([workspaceRoot]);
      const firstPoll = await coordinator.pollOnce();
      expect(firstPoll.errors).toEqual([]);
      expect(firstPoll.sessionsAttached).toBe(1);
      expect(coordinator.getTailer().getActiveSessions()).toEqual(["session-discovery"]);
      await coordinator.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(received).toHaveLength(0);
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({ ...firstRecord, uuid: "message-one" })}\n`,
      );
      await vi.waitFor(() => expect(received).toHaveLength(1));

      // A quiet interactive session may resume later; silence must not finalize capture.
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      const idlePoll = await coordinator.pollOnce();
      expect(notifyTerminal).not.toHaveBeenCalled();
      expect(idlePoll.sessionsDetached).toBe(0);

      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({ ...firstRecord, uuid: "message-two", message: { role: "user", content: "Verify the next fixture." } })}\n`,
      );
      fs.utimesSync(
        transcriptPath,
        new Date(firstRecord.timestamp),
        new Date(firstRecord.timestamp),
      );
      // Backlog must drain even while the attached session is classified idle.
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(notifyTerminal).not.toHaveBeenCalled();

      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({ ...firstRecord, uuid: "message-three" })}\n`,
      );
      fs.utimesSync(transcriptPath, new Date(), new Date());
      const secondPoll = await coordinator.pollOnce();
      expect(secondPoll.sessionsAttached).toBe(0);
      await vi.waitFor(() => expect(received).toHaveLength(3));
      await vi.advanceTimersByTimeAsync(100);
      expect(received).toHaveLength(3);
      expect(coordinator.getDiagnostics().totalRecordsAcknowledged).toBe(3);
    } finally {
      await coordinator.stop();
    }
  });
});
