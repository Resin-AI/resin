import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildOmpDiscoveryCatalog,
  classifyTranscriptSessionKind,
  collectTranscriptFiles,
  createWorkspaceIdFromPath,
  detectOmpVersion,
  discoverOmpSessions,
  discoverOmpWorkspaces,
  findOmpExecutable,
  inspectBreadcrumbs,
  inspectTranscriptFile,
  probeOmpInstallation,
  resolveOmpHome,
} from "../src/discovery.js";

describe("OMP Discovery, Installation Probing & Breadcrumbs", () => {
  it("resolves OMP home directory accurately with overrides and defaults", () => {
    const custom = resolveOmpHome({ customHome: "/custom/omp/home" });
    expect(custom).toBe(path.resolve("/custom/omp/home"));

    const fromEnv = resolveOmpHome({
      env: { OMP_HOME: "/env/omp" },
    });
    expect(fromEnv).toBe(path.resolve("/env/omp"));

    const fromResinEnv = resolveOmpHome({
      env: { RESIN_OMP_HOME: "/te/omp" },
    });
    expect(fromResinEnv).toBe(path.resolve("/te/omp"));

    const fallback = resolveOmpHome({
      homeDir: "/user/home",
      env: {},
    });
  });

  it("probes executable from custom path, env var, and directory search", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-probe-test-"));
    try {
      const mockBin = path.join(tmpDir, "omp");
      await fsp.writeFile(mockBin, "#!/bin/sh\necho omp 1.4.2\n", { mode: 0o755 });

      // Direct custom path
      const foundCustom = await findOmpExecutable({ customExecutablePath: mockBin });
      expect(foundCustom).toBe(mockBin);

      // Non-existent custom path
      const notFoundCustom = await findOmpExecutable({
        customExecutablePath: "/nonexistent/bin/omp",
      });
      expect(notFoundCustom).toBeNull();

      // Search paths
      const foundInSearch = await findOmpExecutable({ searchPaths: [tmpDir] });
      expect(foundInSearch).toBe(mockBin);

      // Env OMP_BIN
      const foundEnv = await findOmpExecutable({
        env: { OMP_BIN: mockBin },
      });
      expect(foundEnv).toBe(mockBin);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects version from executable or package.json fallback", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-ver-test-"));
    try {
      const mockBin = path.join(tmpDir, "bin", "omp");
      await fsp.mkdir(path.dirname(mockBin), { recursive: true });
      await fsp.writeFile(mockBin, "#!/bin/sh\necho omp 0.12.5\n", { mode: 0o755 });

      const version = await detectOmpVersion(mockBin);
      expect(version).toBe("0.12.5");

      // Package.json fallback
      const nonExecBin = path.join(tmpDir, "pkg-bin", "omp");
      await fsp.mkdir(path.dirname(nonExecBin), { recursive: true });
      await fsp.writeFile(nonExecBin, "not-executable");
      await fsp.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "omp", version: "2.3.0" }),
      );

      const pkgVersion = await detectOmpVersion(nonExecBin);
      expect(pkgVersion).toBe("2.3.0");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("probes installation returning ready status when executable exists", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-inst-test-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      await fsp.mkdir(path.join(ompHome, "bin"), { recursive: true });
      const mockBin = path.join(ompHome, "bin", "omp");
      await fsp.writeFile(mockBin, "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });

      const installation = await probeOmpInstallation({
        customHome: ompHome,
        customExecutablePath: mockBin,
      });

      expect(installation).not.toBeNull();
      expect(installation?.harnessId).toBe("omp");
      expect(installation?.status).toBe("ready");
      expect(installation?.version).toBe("1.0.0");
      expect(installation?.executablePath).toBe(mockBin);
      expect(installation?.configPath).toBe(path.join(ompHome, "agent", "mcp.json"));
      expect(installation?.isInstalled).toBe(true);
      expect(installation?.metadata.streaming).toBe(true);
      expect(installation?.metadata.subagents).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports missing_executable when home exists but executable is absent", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-missing-exec-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      await fsp.mkdir(ompHome, { recursive: true });

      const installation = await probeOmpInstallation({
        customHome: ompHome,
        homeDir: path.join(tmpDir, "home"),
        searchPaths: [],
        env: { PATH: "", HOME: path.join(tmpDir, "home") },
      });

      expect(installation).not.toBeNull();
      expect(installation?.status).toBe("missing_executable");
      expect(installation?.isInstalled).toBe(false);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when neither OMP home nor executable is found", async () => {
    const installation = await probeOmpInstallation({
      customHome: "/nonexistent/omp/dir",
      homeDir: "/nonexistent/user/home",
      searchPaths: [],
      env: { PATH: "", HOME: "/nonexistent/user/home" },
    });

    expect(installation).toBeNull();
  });

  it("inspects breadcrumbs and active session pointers", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-bc-test-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const bcDir = path.join(ompHome, "breadcrumbs");
      await fsp.mkdir(bcDir, { recursive: true });

      await fsp.writeFile(
        path.join(bcDir, "session-101.json"),
        JSON.stringify({
          sessionId: "session-101",
          workspacePath: "/projects/alpha",
          timestamp: "2026-08-17T12:00:00.000Z",
          pid: 4501,
          status: "active",
        }),
      );

      await fsp.writeFile(
        path.join(ompHome, "active_session.json"),
        JSON.stringify({
          sessionId: "session-active-1",
          workspacePath: "/projects/beta",
          timestamp: "2026-08-17T12:05:00.000Z",
        }),
      );

      const breadcrumbs = await inspectBreadcrumbs(ompHome);
      expect(breadcrumbs.length).toBe(2);
      expect(breadcrumbs.some((b) => b.sessionId === "session-101" && b.pid === 4501)).toBe(true);
      expect(breadcrumbs.some((b) => b.sessionId === "session-active-1")).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("discovers workspaces from workspaces.json, searchPaths, and breadcrumbs", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-ws-test-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      await fsp.mkdir(ompHome, { recursive: true });

      // 1. Registered workspace in workspaces.json
      const wsPathA = path.join(tmpDir, "repo-a");
      await fsp.mkdir(wsPathA, { recursive: true });
      await fsp.writeFile(
        path.join(ompHome, "workspaces.json"),
        JSON.stringify({
          workspaces: [{ rootPath: wsPathA, name: "repo-a", workspaceId: "ws-repo-a" }],
        }),
      );

      // 2. Workspace found via searchPaths with .omp
      const wsPathB = path.join(tmpDir, "repo-b");
      await fsp.mkdir(path.join(wsPathB, ".omp"), { recursive: true });

      const workspaces = await discoverOmpWorkspaces({
        customHome: ompHome,
        searchPaths: [wsPathB],
      });

      expect(workspaces.length).toBeGreaterThanOrEqual(2);
      expect(workspaces.some((w) => w.rootPath === wsPathA && w.workspaceId === "ws-repo-a")).toBe(
        true,
      );
      expect(workspaces.some((w) => w.rootPath === wsPathB)).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("discovers sessions in a workspace and parses metadata correctly", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-disc-"));
    try {
      const wsPath = path.join(tmpDir, "workspace");
      const sessionsDir = path.join(wsPath, ".omp", "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const sessionFile1 = path.join(sessionsDir, "session-alpha.jsonl");
      await fsp.writeFile(
        sessionFile1,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-17T10:00:00.000Z",
          }),
          JSON.stringify({ type: "message", role: "user", content: "hello" }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "end",
            timestamp: "2026-08-17T10:05:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      const sessionFile2 = path.join(sessionsDir, "session-beta.jsonl");
      await fsp.writeFile(
        sessionFile2,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-17T11:00:00.000Z",
          }),
          JSON.stringify({ type: "message", role: "user", content: "running..." }),
        ].join("\n")}\n`,
      );

      const workspace = {
        workspaceId: "ws-test",
        rootPath: wsPath,
        name: "workspace",
        harnessId: "omp",
        configPath: path.join(wsPath, ".omp", "config.json"),
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome: path.join(tmpDir, ".omp") });
      expect(sessions.length).toBe(2);

      const alpha = sessions.find((s) => s.sessionId === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha?.status).toBe("completed");
      expect(alpha?.createdAt).toBe("2026-08-17T10:00:00.000Z");
      expect(alpha?.updatedAt).toBe("2026-08-17T10:05:00.000Z");
      expect(alpha?.metadata.totalLines).toBe(3);

      const beta = sessions.find((s) => s.sessionId === "beta");
      expect(beta).toBeDefined();
      expect(beta?.status).toBe("active");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("discovers sessions in current ~/.omp/agent/sessions/<workspace-key>/ layout without duplicates", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-agent-session-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const workspaceKey = "-Projects-my-app";
      const agentSessionsDir = path.join(ompHome, "agent", "sessions", workspaceKey);
      await fsp.mkdir(agentSessionsDir, { recursive: true });

      const transcriptPath = path.join(agentSessionsDir, "session.jsonl");
      await fsp.writeFile(
        transcriptPath,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-27T14:00:00.000Z",
          }),
          JSON.stringify({ type: "message", role: "user", content: "hello world" }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "end",
            timestamp: "2026-08-27T14:10:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      const workspace = {
        workspaceId: "test-workspace",
        rootPath: "/projects/my-app",
        name: "my-app",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome });
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("test-workspace-main");
      expect(sessions[0].transcriptPath).toBe(transcriptPath);
      expect(sessions[0].status).toBe("completed");
      expect(sessions[0].createdAt).toBe("2026-08-27T14:00:00.000Z");
      expect(sessions[0].updatedAt).toBe("2026-08-27T14:10:00.000Z");
      expect(sessions[0].metadata.totalLines).toBe(3);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("marks recent no-lifecycle v18 transcript as active within 60s mtime grace", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-v18-active-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "v18-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-projects-v18-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const transcriptPath = path.join(sessionsDir, "recent.jsonl");
      const now = new Date();
      await fsp.writeFile(
        transcriptPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "v18-active-sess-1",
            cwd: wsPath,
            timestamp: now.toISOString(),
          }),
          JSON.stringify({ type: "message", role: "user", content: "Working on active task" }),
        ].join("\n")}\n`,
      );

      const workspace = {
        workspaceId: "ws-v18-app",
        rootPath: wsPath,
        name: "v18-app",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome, now });
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("v18-active-sess-1");
      expect(sessions[0].status).toBe("active");
      expect(sessions[0].transcriptPath).toBe(transcriptPath);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("marks no-lifecycle v18 transcript as completed when mtime is older than 60s", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-v18-stale-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "v18-stale-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-projects-v18-stale-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const transcriptPath = path.join(sessionsDir, "stale.jsonl");
      const staleTime = new Date(Date.now() - 120_000); // 2 minutes ago
      await fsp.writeFile(
        transcriptPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "v18-stale-sess-1",
            cwd: wsPath,
            timestamp: staleTime.toISOString(),
          }),
          JSON.stringify({ type: "message", role: "user", content: "Done earlier" }),
        ].join("\n")}\n`,
      );

      // Set mtime to 120 seconds in the past
      await fsp.utimes(transcriptPath, staleTime, staleTime);

      const workspace = {
        workspaceId: "ws-v18-stale-app",
        rootPath: wsPath,
        name: "v18-stale-app",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome });
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("v18-stale-sess-1");
      expect(sessions[0].status).toBe("completed");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("expires stale non-terminal lifecycle records while preserving explicit terminal status", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-explicit-lifecycle-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "explicit-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-projects-explicit-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      // 1. Session with explicit start but old mtime (10 hours ago) -> completed
      const startTranscript = path.join(sessionsDir, "session-start.jsonl");
      const tenHoursAgo = new Date(Date.now() - 36_000_000);
      await fsp.writeFile(
        startTranscript,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "sess-explicit-start",
            cwd: wsPath,
            timestamp: tenHoursAgo.toISOString(),
          }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: tenHoursAgo.toISOString(),
          }),
          JSON.stringify({ type: "message", role: "user", content: "Working..." }),
        ].join("\n")}\n`,
      );
      await fsp.utimes(startTranscript, tenHoursAgo, tenHoursAgo);

      // 2. Session with explicit end but brand new mtime (now) -> completed
      const endTranscript = path.join(sessionsDir, "session-end.jsonl");
      const now = new Date();
      await fsp.writeFile(
        endTranscript,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "sess-explicit-end",
            cwd: wsPath,
            timestamp: now.toISOString(),
          }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "end",
            timestamp: now.toISOString(),
          }),
        ].join("\n")}\n`,
      );

      const workspace = {
        workspaceId: "ws-explicit-app",
        rootPath: wsPath,
        name: "explicit-app",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome });
      const startSession = sessions.find((s) => s.sessionId === "sess-explicit-start");
      const endSession = sessions.find((s) => s.sessionId === "sess-explicit-end");

      expect(startSession).toBeDefined();
      expect(startSession?.status).toBe("completed");

      expect(endSession).toBeDefined();
      expect(endSession?.status).toBe("completed");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("assigns sessions only to the exact workspace owning the header cwd", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-workspace-isolation-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPathA = path.join(tmpDir, "project-alpha");
      const wsPathB = path.join(tmpDir, "project-beta");
      await fsp.mkdir(wsPathA, { recursive: true });
      await fsp.mkdir(wsPathB, { recursive: true });

      const sessionsDir = path.join(ompHome, "agent", "sessions", "shared-parent");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const transcriptPathA = path.join(sessionsDir, "session-a.jsonl");
      await fsp.writeFile(
        transcriptPathA,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "sess-for-alpha",
            cwd: wsPathA,
            timestamp: new Date().toISOString(),
          }),
        ].join("\n")}\n`,
      );

      const workspaceA = {
        workspaceId: "ws-alpha",
        rootPath: wsPathA,
        name: "project-alpha",
        harnessId: "omp",
      };

      const workspaceB = {
        workspaceId: "ws-beta",
        rootPath: wsPathB,
        name: "project-beta",
        harnessId: "omp",
      };

      const sessionsA = await discoverOmpSessions(workspaceA, { ompHome });
      const sessionsB = await discoverOmpSessions(workspaceB, { ompHome });

      expect(sessionsA.map((s) => s.sessionId)).toContain("sess-for-alpha");
      expect(sessionsB.map((s) => s.sessionId)).not.toContain("sess-for-alpha");
      expect(sessionsB.length).toBe(0);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("deduplicates alias symlinks and duplicate session IDs to yield exactly one session", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-dedupe-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "dedupe-project");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-dedupe-project");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const canonicalFile = path.join(sessionsDir, "canonical.jsonl");
      await fsp.writeFile(
        canonicalFile,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "deduped-sess-1",
            cwd: wsPath,
            timestamp: "2026-08-31T10:00:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      // Symlink pointing to canonical
      const symlinkFile = path.join(sessionsDir, "current.jsonl");
      await fsp.symlink(canonicalFile, symlinkFile);

      // Sibling file with same header session id
      const duplicateFile = path.join(sessionsDir, "copy.jsonl");
      await fsp.writeFile(
        duplicateFile,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "deduped-sess-1",
            cwd: wsPath,
            timestamp: "2026-08-31T10:00:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      const workspace = {
        workspaceId: "ws-dedupe",
        rootPath: wsPath,
        name: "dedupe-project",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome });
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("deduped-sess-1");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("inspects large transcripts via bounded chunks without calling whole-file readFile", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-bounded-reads-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "large-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-projects-large-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const transcriptPath = path.join(sessionsDir, "large-session.jsonl");
      // Construct a >100 KiB file with session header at top and end lifecycle at bottom
      const rows: string[] = [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "large-session-id",
          cwd: wsPath,
          timestamp: "2026-08-30T10:00:00.000Z",
        }),
      ];
      const filler = "X".repeat(500);
      for (let i = 0; i < 300; i++) {
        rows.push(JSON.stringify({ type: "message", role: "assistant", content: filler, i }));
      }
      rows.push(
        JSON.stringify({
          type: "session_lifecycle",
          lifecycleType: "end",
          timestamp: "2026-08-30T12:00:00.000Z",
        }),
      );
      await fsp.writeFile(transcriptPath, `${rows.join("\n")}\n`);

      const stat = await fsp.stat(transcriptPath);
      expect(stat.size).toBeGreaterThan(100 * 1024); // > 100 KiB

      const workspace = {
        workspaceId: "ws-large-app",
        rootPath: wsPath,
        name: "large-app",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome });

      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("large-session-id");
      expect(sessions[0].status).toBe("completed");
      expect(sessions[0].createdAt).toBe("2026-08-30T10:00:00.000Z");
      expect(sessions[0].updatedAt).toBe("2026-08-30T12:00:00.000Z");
      expect(sessions[0].metadata.inspectedBytes).toBeDefined();
      expect(Number(sessions[0].metadata.inspectedBytes)).toBeLessThan(stat.size);
      expect(Number(sessions[0].metadata.inspectedBytes)).toBeLessThanOrEqual(128 * 1024);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("builds and reuses OmpDiscoveryCatalog scanning OMP home in a single pass", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-catalog-scan-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "catalog-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-projects-catalog-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const transcriptPath = path.join(sessionsDir, "session.jsonl");
      await fsp.writeFile(
        transcriptPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "catalog-sess-1",
            cwd: wsPath,
            timestamp: "2026-08-31T09:00:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      const catalog = await buildOmpDiscoveryCatalog({ customHome: ompHome });
      expect(catalog.workspaces.length).toBeGreaterThanOrEqual(1);
      expect(catalog.workspaces.some((w) => w.rootPath === wsPath)).toBe(true);

      const targetWs = catalog.workspaces.find((w) => w.rootPath === wsPath)!;
      const sessions = catalog.getSessionsForWorkspace(targetWs);
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("catalog-sess-1");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("skips full inspection for transcripts outside the active-only terminal grace window", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-active-only-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "active-only-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-projects-active-only-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const staleTranscriptPath = path.join(sessionsDir, "stale-session.jsonl");
      const staleTime = new Date(Date.now() - 600_000);
      await fsp.writeFile(
        staleTranscriptPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "stale-sess-1",
            cwd: wsPath,
            timestamp: staleTime.toISOString(),
          }),
        ].join("\n")}\n`,
      );
      await fsp.utimes(staleTranscriptPath, staleTime, staleTime);

      const activeTranscriptPath = path.join(sessionsDir, "active-session.jsonl");
      const activeTime = staleTime; // Old session identity; the fresh file mtime represents new activity.
      await fsp.writeFile(
        activeTranscriptPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "active-sess-1",
            cwd: wsPath,
            timestamp: activeTime.toISOString(),
          }),
        ].join("\n")}\n`,
      );
      // Active-only build
      const activeCatalog = await buildOmpDiscoveryCatalog({
        customHome: ompHome,
        activeOnly: true,
      });

      const openedPaths = activeCatalog.inspectedFilePaths;
      expect(openedPaths).toContain(activeTranscriptPath);
      expect(openedPaths).not.toContain(staleTranscriptPath);

      const ws = activeCatalog.workspaces.find((w) => w.rootPath === wsPath)!;
      const activeSessions = activeCatalog.getSessionsForWorkspace(ws);
      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0].sessionId).toBe("active-sess-1");

      // Standalone/explicit discoverOmpSessions still returns completed/stale sessions
      const allSessions = await discoverOmpSessions(ws, { ompHome });
      expect(allSessions.length).toBe(2);
      expect(allSessions.some((s) => s.sessionId === "stale-sess-1")).toBe(true);
      expect(allSessions.some((s) => s.sessionId === "active-sess-1")).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("discovers active long-running transcript with old ISO timestamp filename but recent mtime while skipping old-mtime peers", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-long-running-reg-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "long-running-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-long-running-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      // 1. Long-running session started 2 hours ago (filename: 2 hours ago), but recently appended (mtime: now)
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      const longRunningFileName = `${twoHoursAgo.toISOString().replace(/:/g, "-")}.jsonl`;
      const longRunningPath = path.join(sessionsDir, longRunningFileName);
      const recentTime = new Date();
      await fsp.writeFile(
        longRunningPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "long-running-sess-1",
            cwd: wsPath,
            timestamp: twoHoursAgo.toISOString(),
          }),
          JSON.stringify({
            type: "message",
            timestamp: recentTime.toISOString(),
            content: "still going",
          }),
        ].join("\n")}\n`,
      );
      await fsp.utimes(longRunningPath, recentTime, recentTime);

      // 2. Old-mtime peer created 2 hours ago, last modified 2 hours ago
      const oldPeerFileName = `${new Date(twoHoursAgo.getTime() + 1000).toISOString().replace(/:/g, "-")}.jsonl`;
      const oldPeerPath = path.join(sessionsDir, oldPeerFileName);
      await fsp.writeFile(
        oldPeerPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "old-peer-sess-2",
            cwd: wsPath,
            timestamp: twoHoursAgo.toISOString(),
          }),
        ].join("\n")}\n`,
      );
      await fsp.utimes(oldPeerPath, twoHoursAgo, twoHoursAgo);

      // 3. Active-only discovery
      const catalog = await buildOmpDiscoveryCatalog({
        customHome: ompHome,
        activeOnly: true,
      });

      // Assertions
      const openedPaths = catalog.inspectedFilePaths;
      expect(openedPaths).toContain(longRunningPath);
      expect(openedPaths).not.toContain(oldPeerPath);
      expect(openedPaths.length).toBe(1);

      const ws = catalog.workspaces.find((w) => w.rootPath === wsPath)!;
      expect(ws).toBeDefined();
      const sessions = catalog.getSessionsForWorkspace(ws);
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("long-running-sess-1");
      expect(sessions[0].status).toBe("active");

      // Standalone discovery without activeOnly still returns both
      const allSessions = await discoverOmpSessions(ws, { ompHome });
      expect(allSessions.length).toBe(2);
      expect(allSessions.some((s) => s.sessionId === "long-running-sess-1")).toBe(true);
      expect(allSessions.some((s) => s.sessionId === "old-peer-sess-2")).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stale start-only transcript becomes completed after 60s inactivity timeout", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-stale-session-"));
    try {
      const wsPath = path.join(tmpDir, "workspace");
      const sessionsDir = path.join(wsPath, ".omp", "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const sessionFile = path.join(sessionsDir, "session-print-mode.jsonl");
      await fsp.writeFile(
        sessionFile,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-20T10:00:00.000Z",
          }),
          JSON.stringify({ type: "message", role: "user", content: "one-shot prompt" }),
          JSON.stringify({ type: "message", role: "assistant", content: "one-shot response" }),
        ].join("\n")}\n`,
      );

      // Backdate mtime to 120 seconds ago (> 60s inactivity timeout)
      const staleTime = new Date(Date.now() - 120_000);
      await fsp.utimes(sessionFile, staleTime, staleTime);

      const workspace = {
        workspaceId: "ws-stale-test",
        rootPath: wsPath,
        name: "workspace",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome: path.join(tmpDir, ".omp") });
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("print-mode");
      expect(sessions[0].status).toBe("completed");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recent start-only transcript remains active within 60s window", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-recent-session-"));
    try {
      const wsPath = path.join(tmpDir, "workspace");
      const sessionsDir = path.join(wsPath, ".omp", "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const sessionFile = path.join(sessionsDir, "session-live.jsonl");
      await fsp.writeFile(
        sessionFile,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-20T10:00:00.000Z",
          }),
          JSON.stringify({ type: "message", role: "user", content: "live turn" }),
        ].join("\n")}\n`,
      );

      // Recent mtime (5 seconds ago, <= 60s window)
      const recentTime = new Date(Date.now() - 5_000);
      await fsp.utimes(sessionFile, recentTime, recentTime);

      const workspace = {
        workspaceId: "ws-recent-test",
        rootPath: wsPath,
        name: "workspace",
        harnessId: "omp",
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome: path.join(tmpDir, ".omp") });
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("live");
      expect(sessions[0].status).toBe("active");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recent pause transcript remains idle within 60s window and becomes completed when stale", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-idle-session-"));
    try {
      const wsPath = path.join(tmpDir, "workspace");
      const sessionsDir = path.join(wsPath, ".omp", "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const idleFile = path.join(sessionsDir, "session-idle.jsonl");
      await fsp.writeFile(
        idleFile,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-20T10:00:00.000Z",
          }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "pause",
            timestamp: "2026-08-20T10:01:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      const workspace = {
        workspaceId: "ws-idle-test",
        rootPath: wsPath,
        name: "workspace",
        harnessId: "omp",
      };

      // When recent -> idle
      const recentTime = new Date(Date.now() - 5_000);
      await fsp.utimes(idleFile, recentTime, recentTime);
      const recentSessions = await discoverOmpSessions(workspace, {
        ompHome: path.join(tmpDir, ".omp"),
      });
      expect(recentSessions[0].status).toBe("idle");

      // When stale -> completed
      const staleTime = new Date(Date.now() - 120_000);
      await fsp.utimes(idleFile, staleTime, staleTime);
      const staleSessions = await discoverOmpSessions(workspace, {
        ompHome: path.join(tmpDir, ".omp"),
      });
      expect(staleSessions[0].status).toBe("completed");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("explicit terminal status (end / crash) always wins regardless of recent or stale mtime", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-terminal-session-"));
    try {
      const wsPath = path.join(tmpDir, "workspace");
      const sessionsDir = path.join(wsPath, ".omp", "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const endFile = path.join(sessionsDir, "session-ended.jsonl");
      await fsp.writeFile(
        endFile,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-20T10:00:00.000Z",
          }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "end",
            timestamp: "2026-08-20T10:05:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      const crashFile = path.join(sessionsDir, "session-crashed.jsonl");
      await fsp.writeFile(
        crashFile,
        `${[
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: "2026-08-20T10:00:00.000Z",
          }),
          JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "crash",
            timestamp: "2026-08-20T10:02:00.000Z",
          }),
        ].join("\n")}\n`,
      );

      const workspace = {
        workspaceId: "ws-terminal-test",
        rootPath: wsPath,
        name: "workspace",
        harnessId: "omp",
      };

      // Both files with recent mtimes (1 second ago)
      const recentTime = new Date(Date.now() - 1_000);
      await fsp.utimes(endFile, recentTime, recentTime);
      await fsp.utimes(crashFile, recentTime, recentTime);
      let sessions = await discoverOmpSessions(workspace, { ompHome: path.join(tmpDir, ".omp") });
      expect(sessions.find((s) => s.sessionId === "ended")?.status).toBe("completed");
      expect(sessions.find((s) => s.sessionId === "crashed")?.status).toBe("failed");

      // Both files with stale mtimes (200 seconds ago)
      const staleTime = new Date(Date.now() - 200_000);
      await fsp.utimes(endFile, staleTime, staleTime);
      await fsp.utimes(crashFile, staleTime, staleTime);
      sessions = await discoverOmpSessions(workspace, { ompHome: path.join(tmpDir, ".omp") });
      expect(sessions.find((s) => s.sessionId === "ended")?.status).toBe("completed");
      expect(sessions.find((s) => s.sessionId === "crashed")?.status).toBe("failed");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates clean workspace IDs from paths", () => {
    expect(createWorkspaceIdFromPath("/home/user/project-1")).toBe("home-user-project-1");
    expect(createWorkspaceIdFromPath("C:\\Users\\User\\Workspace")).toBe("C-Users-User-Workspace");
  });

  it("collects nested directories, ignores cycles/aliases, respects max depth, and preserves deterministic ordering and catalog dedupe", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-nested-traversal-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "nested-project");
      await fsp.mkdir(wsPath, { recursive: true });

      // Build a nested directory tree inside ompHome/agent/sessions/-nested-project
      // Root (depth 0): ompHome/agent/sessions/-nested-project
      const rootSessionsDir = path.join(ompHome, "agent", "sessions", "-nested-project");
      const level1 = path.join(rootSessionsDir, "level1"); // depth 1
      const level2 = path.join(level1, "level2"); // depth 2
      const level3 = path.join(level2, "level3"); // depth 3
      const level4 = path.join(level3, "level4"); // depth 4
      const level5 = path.join(level4, "level5"); // depth 5 (exceeds max depth 4)

      await fsp.mkdir(level5, { recursive: true });

      // Create transcripts at various depths
      const fileL0 = path.join(rootSessionsDir, "session_l0.jsonl");
      const fileL1 = path.join(level1, "session_l1.jsonl");
      const fileL2 = path.join(level2, "session_l2.jsonl");
      const fileL3 = path.join(level3, "session_l3.jsonl");
      const fileL4 = path.join(level4, "session_l4.jsonl");
      const fileL5 = path.join(level5, "session_l5_exceeds.jsonl");

      const makeSessionRow = (id: string) =>
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id,
            cwd: wsPath,
            timestamp: "2026-08-31T12:00:00.000Z",
          }),
        ].join("\n")}\n`;

      await fsp.writeFile(fileL0, makeSessionRow("sess-l0"));
      await fsp.writeFile(fileL1, makeSessionRow("sess-l1"));
      await fsp.writeFile(fileL2, makeSessionRow("sess-l2"));
      await fsp.writeFile(fileL3, makeSessionRow("sess-l3"));
      await fsp.writeFile(fileL4, makeSessionRow("sess-l4"));
      await fsp.writeFile(fileL5, makeSessionRow("sess-l5"));

      // Non-jsonl files should be ignored
      await fsp.writeFile(path.join(level1, "ignored.txt"), "some text");
      await fsp.writeFile(path.join(level2, "ignored.json"), "{}");

      // File alias: symlink pointing to fileL0
      const symlinkFile = path.join(level2, "alias_l0.jsonl");
      await fsp.symlink(fileL0, symlinkFile);

      // Directory cycle: symlink from level2 pointing to rootSessionsDir
      const cycleDir = path.join(level2, "cycle_to_root");
      await fsp.symlink(rootSessionsDir, cycleDir);

      // Sibling directory symlink
      const siblingDir = path.join(rootSessionsDir, "sibling");
      await fsp.mkdir(siblingDir, { recursive: true });
      const siblingFile = path.join(siblingDir, "sibling_session.jsonl");
      await fsp.writeFile(siblingFile, makeSessionRow("sess-sibling"));
      const siblingCycle = path.join(siblingDir, "loop_to_level1");
      await fsp.symlink(level1, siblingCycle);

      // Broken symlink
      const brokenSymlink = path.join(siblingDir, "broken_link");
      await fsp.symlink(path.join(tmpDir, "non_existent_target"), brokenSymlink);

      // 1. Test collectTranscriptFiles directly
      const run1 = await collectTranscriptFiles([rootSessionsDir]);
      const run2 = await collectTranscriptFiles([rootSessionsDir]);

      // Prove deterministic ordering across runs
      expect(run1).toEqual(run2);

      // Verify all valid unique files up to depth 4 are collected
      expect(run1).toContain(fileL0);
      expect(run1).toContain(fileL1);
      expect(run1).toContain(fileL2);
      expect(run1).toContain(fileL3);
      expect(run1).toContain(fileL4);
      expect(run1).toContain(siblingFile);
      expect(run1).toContain(symlinkFile);

      // Verify depth > 4 is excluded
      expect(run1).not.toContain(fileL5);

      // Verify non-jsonl and broken links are excluded
      expect(run1).not.toContain(path.join(level1, "ignored.txt"));
      expect(run1).not.toContain(path.join(level2, "ignored.json"));
      expect(run1).not.toContain(brokenSymlink);

      // Verify files list is strictly sorted
      const sorted = [...run1].sort((a, b) => a.localeCompare(b));
      expect(run1).toEqual(sorted);

      // 2. Test catalog building and deduplication
      const workspace = {
        workspaceId: "ws-nested",
        rootPath: wsPath,
        name: "nested-project",
        harnessId: "omp",
      };

      const catalog = await buildOmpDiscoveryCatalog({ ompHome, customHome: ompHome });
      const sessions = catalog.getSessionsForWorkspace(workspace);

      // sess-l0 is pointed to by both fileL0 and symlinkFile (alias_l0.jsonl)
      // Catalog deduplication must ensure sess-l0 appears exactly once
      // Note: from ompHome/agent/sessions (depth 0), level3 is depth 4, so sess-l0..sess-l3 + sess-sibling are discovered.
      const sessionIds = sessions.map((s) => s.sessionId).sort();
      expect(sessionIds).toEqual(["sess-l0", "sess-l1", "sess-l2", "sess-l3", "sess-sibling"]);
      expect(sessions.length).toBe(5);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("identifies completed session status when transcript ends with agent_end or terminal session envelope", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-discovery-transcript-"));
    try {
      const t1Path = path.join(tmpDir, "session-agent-end.jsonl");
      await fsp.writeFile(
        t1Path,
        `${[
          JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-09-01T10:00:00Z" }),
          JSON.stringify({ type: "agent_start", timestamp: "2026-09-01T10:00:01Z" }),
          JSON.stringify({
            type: "agent_end",
            status: "completed",
            timestamp: "2026-09-01T10:00:10Z",
          }),
        ].join("\n")}\n`,
      );

      const parsed1 = await inspectTranscriptFile(t1Path);
      expect(parsed1?.status).toBe("completed");
      expect(parsed1?.sessionId).toBe("sess-1");

      const t2Path = path.join(tmpDir, "session-terminal.jsonl");
      await fsp.writeFile(
        t2Path,
        `${[
          JSON.stringify({ type: "session", id: "sess-2", timestamp: "2026-09-01T10:00:00Z" }),
          JSON.stringify({
            type: "session",
            status: "completed",
            timestamp: "2026-09-01T10:00:05Z",
          }),
        ].join("\n")}\n`,
      );

      const parsed2 = await inspectTranscriptFile(t2Path);
      expect(parsed2?.status).toBe("completed");
      expect(parsed2?.sessionId).toBe("sess-2");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("identifies failed session status when transcript ends with error or crash", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-discovery-fail-"));
    try {
      const t1Path = path.join(tmpDir, "session-agent-crash.jsonl");
      await fsp.writeFile(
        t1Path,
        `${[
          JSON.stringify({ type: "session", id: "sess-fail-1", timestamp: "2026-09-01T10:00:00Z" }),
          JSON.stringify({ type: "agent_start", timestamp: "2026-09-01T10:00:01Z" }),
          JSON.stringify({
            type: "agent_end",
            status: "failed",
            error: "fatal crash",
            timestamp: "2026-09-01T10:00:10Z",
          }),
        ].join("\n")}\n`,
      );

      const parsed1 = await inspectTranscriptFile(t1Path);
      expect(parsed1?.status).toBe("failed");
      expect(parsed1?.sessionId).toBe("sess-fail-1");

      const t2Path = path.join(tmpDir, "session-term-error.jsonl");
      await fsp.writeFile(
        t2Path,
        `${[
          JSON.stringify({ type: "session", id: "sess-fail-2", timestamp: "2026-09-01T10:00:00Z" }),
          JSON.stringify({
            type: "session",
            status: "crash",
            reason: "oom",
            timestamp: "2026-09-01T10:00:05Z",
          }),
        ].join("\n")}\n`,
      );

      const parsed2 = await inspectTranscriptFile(t2Path);
      expect(parsed2?.status).toBe("failed");
      expect(parsed2?.sessionId).toBe("sess-fail-2");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies user vs subagent transcripts by directory nesting and exposes sessionKind on HarnessSession metadata", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-kind-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsSlug = "test-project";
      const wsDir = path.join(tmpDir, wsSlug);
      await fsp.mkdir(wsDir, { recursive: true });

      const sessionsDir = path.join(ompHome, "agent", "sessions", wsSlug);
      const parentSessionDir = path.join(sessionsDir, "20260902T120000_a1b2c3d4");
      await fsp.mkdir(parentSessionDir, { recursive: true });

      // User session: directly under workspace slug directory
      const userTranscriptPath = path.join(sessionsDir, "20260902T120000_a1b2c3d4.jsonl");
      await fsp.writeFile(
        userTranscriptPath,
        `${[
          JSON.stringify({
            type: "session",
            id: "sess-user-1",
            cwd: wsDir,
            timestamp: "2026-09-02T12:00:00Z",
          }),
          JSON.stringify({ type: "agent_start", timestamp: "2026-09-02T12:00:01Z" }),
          JSON.stringify({
            type: "agent_end",
            status: "completed",
            timestamp: "2026-09-02T12:00:10Z",
          }),
        ].join("\n")}\n`,
      );

      // Subagent transcript: nested under the parent session's directory
      const subagentTranscriptPath = path.join(parentSessionDir, "scout.jsonl");
      await fsp.writeFile(
        subagentTranscriptPath,
        `${[
          JSON.stringify({
            type: "session",
            id: "sess-subagent-1",
            cwd: wsDir,
            timestamp: "2026-09-02T12:00:02Z",
          }),
          JSON.stringify({ type: "agent_start", timestamp: "2026-09-02T12:00:03Z" }),
          JSON.stringify({
            type: "agent_end",
            status: "completed",
            timestamp: "2026-09-02T12:00:08Z",
          }),
        ].join("\n")}\n`,
      );

      // 1. Direct classification helper
      const workspace = {
        workspaceId: "ws-test",
        rootPath: wsDir,
        name: wsSlug,
        harnessId: "omp",
      };
      expect(classifyTranscriptSessionKind(userTranscriptPath, workspace)).toBe("user");
      expect(classifyTranscriptSessionKind(subagentTranscriptPath, workspace)).toBe("agent");

      // 2. inspectTranscriptFile
      const userParsed = await inspectTranscriptFile(userTranscriptPath);
      const subagentParsed = await inspectTranscriptFile(subagentTranscriptPath);
      expect(userParsed?.sessionKind).toBe("user");
      expect(subagentParsed?.sessionKind).toBe("agent");

      // 3. Catalog discovery
      const catalog = await buildOmpDiscoveryCatalog({ ompHome, searchPaths: [wsDir] });
      const sessions = catalog.getSessionsForWorkspace(workspace);

      const userSession = sessions.find((s) => s.sessionId === "sess-user-1");
      const subagentSession = sessions.find((s) => s.sessionId === "sess-subagent-1");

      expect(userSession).toBeDefined();
      expect(userSession?.metadata.sessionKind).toBe("user");

      expect(subagentSession).toBeDefined();
      expect(subagentSession?.metadata.sessionKind).toBe("agent");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
