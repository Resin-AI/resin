import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceIdFromPath,
  detectOmpVersion,
  discoverOmpSessions,
  discoverOmpWorkspaces,
  findOmpExecutable,
  inspectBreadcrumbs,
  probeOmpInstallation,
  resolveOmpHome,
} from "../src/discovery.js";

describe("OMP Discovery, Installation Probing & Breadcrumbs", () => {
  it("resolves OMP home directory accurately with overrides and defaults", () => {
    const custom = resolveOmpHome({ customHome: "/custom/omp/home" });
    expect(custom).toBe(path.resolve("/custom/omp/home"));

    const fromEnv = resolveOmpHome({
      env: { OMP_HOME: "/env/omp" } as unknown as NodeJS.ProcessEnv,
    });
    expect(fromEnv).toBe(path.resolve("/env/omp"));

    const fromResinEnv = resolveOmpHome({
      env: { RESIN_OMP_HOME: "/te/omp" } as unknown as NodeJS.ProcessEnv,
    });
    expect(fromResinEnv).toBe(path.resolve("/te/omp"));

    const fallback = resolveOmpHome({
      homeDir: "/user/home",
      env: {} as unknown as NodeJS.ProcessEnv,
    });
    expect(fallback).toBe(path.resolve("/user/home/.omp"));
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
        env: { OMP_BIN: mockBin } as unknown as NodeJS.ProcessEnv,
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
        env: { PATH: "", HOME: path.join(tmpDir, "home") } as unknown as NodeJS.ProcessEnv,
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
      env: { PATH: "", HOME: "/nonexistent/user/home" } as unknown as NodeJS.ProcessEnv,
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

  it("creates clean workspace IDs from paths", () => {
    expect(createWorkspaceIdFromPath("/home/user/project-1")).toBe("home-user-project-1");
    expect(createWorkspaceIdFromPath("C:\\Users\\User\\Workspace")).toBe("C-Users-User-Workspace");
  });
});
