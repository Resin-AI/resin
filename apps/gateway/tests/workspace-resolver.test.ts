import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import {
  bootstrapProject,
  readProjectMetadata,
  readToolLock,
  writeProjectMetadata,
  writeToolLock,
} from "../src/project/project-bootstrap.js";
import type { InitializeResult, JsonRpcSuccessResponse } from "../src/protocol/types.js";
import {
  canonicalizePath,
  findGitRoot,
  generateWorkspaceId,
  resolveGitMetadata,
  resolveProjectResinDir,
  resolveWorkspaceContext,
  uriOrPathToFsPath,
} from "../src/workspace-resolver.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Workspace Resolver & Project Bootstrap", () => {
  describe("Path Normalization & Symlink Utilities", () => {
    it("converts file:// URIs and standard paths to normalized fs paths", () => {
      const tmpDir = os.tmpdir();
      const fileUrl = pathToFileURL(tmpDir).href;
      const resolvedFromUrl = uriOrPathToFsPath(fileUrl);
      expect(path.normalize(resolvedFromUrl)).toBe(path.normalize(tmpDir));

      const standardPath = path.join(tmpDir, "subfolder");
      expect(uriOrPathToFsPath(standardPath)).toBe(path.resolve(standardPath));
    });

    it("canonicalizes symlinks properly", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ws-test-"));
      const targetDir = path.join(baseDir, "real_target");
      const linkDir = path.join(baseDir, "symlink_dir");

      fs.mkdirSync(targetDir, { recursive: true });
      try {
        fs.symlinkSync(targetDir, linkDir, "dir");
        const canonicalTarget = canonicalizePath(targetDir);
        const canonicalLink = canonicalizePath(linkDir);
        expect(canonicalLink).toBe(canonicalTarget);
      } catch {
        // Symlinks might require elevated privileges on some platforms
        const canonicalLink = canonicalizePath(linkDir);
        expect(Object.prototype.toString.call(canonicalLink)).toBe("[object String]");
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("detects enclosing git root", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-git-test-"));
      const gitDir = path.join(baseDir, ".git");
      const subfolder = path.join(baseDir, "nested", "deep", "dir");

      fs.mkdirSync(gitDir, { recursive: true });
      fs.mkdirSync(subfolder, { recursive: true });

      try {
        const detected = findGitRoot(subfolder);
        expect(detected).toBe(canonicalizePath(baseDir));
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("generates deterministic fallback workspace IDs", () => {
      const p1 = "/path/to/my-repo";
      const id1 = generateWorkspaceId(p1);
      const id2 = generateWorkspaceId(p1);
      expect(id1).toBe(id2);
      expect(id1.startsWith("ws_my-repo_")).toBe(true);

      const p2 = "/path/to/another-repo";
      const id3 = generateWorkspaceId(p2);
      expect(id3).not.toBe(id1);
    });
  });

  describe("Automatic Project Bootstrap", () => {
    it("bootstraps a fresh non-Git directory and generates valid UUID and metadata", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-fresh-nongit-"));
      try {
        const res = bootstrapProject(tmp);

        expect(res.projectId).toMatch(UUID_V4_REGEX);
        expect(res.projectRoot).toBe(canonicalizePath(tmp));
        expect(res.resinDir).toBe(path.join(canonicalizePath(tmp), ".resin"));
        expect(fs.existsSync(res.projectJsonPath)).toBe(true);
        expect(fs.existsSync(res.lockPath)).toBe(true);

        const project = readProjectMetadata(tmp);
        expect(project.schemaKind).toBe("project_metadata");
        expect(project.schemaVersion).toBe("1.0.0");
        expect(project.projectId).toBe(res.projectId);
        expect(project.createdAt).toBeDefined();

        const lock = readToolLock(tmp);
        expect(lock.schemaKind).toBe("tool_lock");
        expect(lock.schemaVersion).toBe("1.0.0");
        expect(lock.projectId).toBe(res.projectId);
        expect(lock.tools).toEqual({});
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("prioritizes Git root when started in a nested subdirectory", () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-git-sub-"));
      const gitDir = path.join(repoDir, ".git");
      const subDir = path.join(repoDir, "packages", "deep", "service");

      fs.mkdirSync(gitDir, { recursive: true });
      fs.mkdirSync(subDir, { recursive: true });

      try {
        const ctx = resolveWorkspaceContext({ cwd: subDir });

        expect(ctx.gitRoot).toBe(canonicalizePath(repoDir));
        expect(ctx.projectRoot).toBe(canonicalizePath(repoDir));
        expect(ctx.canonicalRoot).toBe(canonicalizePath(repoDir));
        expect(ctx.workspaceId).toBe(ctx.projectId);
        expect(ctx.projectId).toMatch(UUID_V4_REGEX);

        // Metadata created at Git root, NOT in the subdirectory
        expect(fs.existsSync(path.join(repoDir, ".resin", "project.json"))).toBe(true);
        expect(fs.existsSync(path.join(repoDir, ".resin", "resin.lock"))).toBe(true);
        expect(fs.existsSync(path.join(subDir, ".resin"))).toBe(false);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("preserves stable project UUID and lock across repeated starts", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-repeated-"));
      try {
        const first = resolveWorkspaceContext({ cwd: tmp });
        const second = resolveWorkspaceContext({ cwd: tmp });

        expect(first.projectId).toBe(second.projectId);
        expect(first.workspaceId).toBe(second.workspaceId);
        expect(first.projectJsonPath).toBe(second.projectJsonPath);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("handles concurrent bootstrap starts safely with exclusive locking", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-concurrent-"));
      try {
        const results = Array.from({ length: 8 }).map(() =>
          bootstrapProject(tmp, { lockTimeoutMs: 5000 }),
        );

        const firstId = results[0].projectId;
        for (const res of results) {
          expect(res.projectId).toBe(firstId);
        }

        const project = readProjectMetadata(tmp);
        const lock = readToolLock(tmp);
        expect(project.projectId).toBe(firstId);
        expect(lock.projectId).toBe(firstId);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("preserves UUID and lock when project directory is moved/renamed", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "resin-move-base-"));
      const origDir = path.join(base, "original_app");
      const movedDir = path.join(base, "renamed_app");
      fs.mkdirSync(origDir, { recursive: true });

      try {
        const initial = bootstrapProject(origDir);
        const initialId = initial.projectId;

        // Add a locked tool entry to test preservation across rename
        const lock = readToolLock(origDir);
        lock.tools["sample-tool"] = {
          toolId: "a0000000-0000-4000-8000-000000000001",
          name: "sample-tool",
          version: "1.2.3",
          manifestDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          artifactDigest: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          status: "active",
        };
        writeToolLock(origDir, lock);

        // Move directory
        fs.renameSync(origDir, movedDir);

        const movedCtx = resolveWorkspaceContext({ cwd: movedDir });
        expect(movedCtx.projectId).toBe(initialId);
        expect(movedCtx.workspaceId).toBe(initialId);

        const movedLock = readToolLock(movedDir);
        expect(movedLock.projectId).toBe(initialId);
        expect(movedLock.tools["sample-tool"]).toBeDefined();
        expect(movedLock.tools["sample-tool"].version).toBe("1.2.3");
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("supports explicit read-only bootstrap when valid metadata is committed", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-readonly-bs-"));
      try {
        const initial = bootstrapProject(tmp);
        expect(initial.isReadOnly).toBe(false);

        const roResult = bootstrapProject(tmp, { readOnly: true });
        expect(roResult.isReadOnly).toBe(true);
        expect(roResult.projectId).toBe(initial.projectId);
        expect(roResult.projectRoot).toBe(initial.projectRoot);
        expect(roResult.project.projectId).toBe(initial.projectId);
        expect(roResult.lock.projectId).toBe(initial.projectId);
        expect(fs.existsSync(path.join(roResult.resinDir, ".bootstrap.lock"))).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("fails closed in read-only mode if metadata is missing or directory not present", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-readonly-fail-"));
      try {
        expect(() => bootstrapProject(tmp, { readOnly: true })).toThrow(
          /Cannot bootstrap read-only project/,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("Deterministic Partial State Recovery", () => {
    it("recovers from project-only partial state by recreating matching empty lock", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-partial-proj-"));
      try {
        const resinDir = path.join(tmp, ".resin");
        fs.mkdirSync(resinDir, { recursive: true });

        const customId = "11111111-2222-4333-8444-555555555555";
        writeProjectMetadata(tmp, {
          schemaKind: "project_metadata",
          schemaVersion: "1.0.0",
          projectId: customId,
          name: "recovered-project",
          createdAt: "2026-08-25T00:00:00.000Z",
        });

        // Verify lock does not exist
        expect(fs.existsSync(path.join(resinDir, "resin.lock"))).toBe(false);

        const res = bootstrapProject(tmp);
        expect(res.projectId).toBe(customId);
        expect(res.recoveredPartialState).toBe("project_recreated_lock");

        expect(fs.existsSync(path.join(resinDir, "resin.lock"))).toBe(true);
        const lock = readToolLock(tmp);
        expect(lock.projectId).toBe(customId);
        expect(lock.tools).toEqual({});
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("recovers from lock-only partial state by adopting lock's projectId into project.json", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-partial-lock-"));
      try {
        const resinDir = path.join(tmp, ".resin");
        fs.mkdirSync(resinDir, { recursive: true });

        const customId = "99999999-8888-4777-8666-555555555555";
        writeToolLock(tmp, {
          schemaKind: "tool_lock",
          schemaVersion: "1.0.0",
          projectId: customId,
          updatedAt: "2026-08-25T01:00:00.000Z",
          tools: {},
        });

        // Verify project.json does not exist
        expect(fs.existsSync(path.join(resinDir, "project.json"))).toBe(false);

        const res = bootstrapProject(tmp);
        expect(res.projectId).toBe(customId);
        expect(res.recoveredPartialState).toBe("lock_recreated_project");

        expect(fs.existsSync(path.join(resinDir, "project.json"))).toBe(true);
        const project = readProjectMetadata(tmp);
        expect(project.projectId).toBe(customId);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("Fail-Closed Security, Mismatches & Edge Cases", () => {
    it("fails closed when project.json and resin.lock projectIds mismatch", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-mismatch-"));
      try {
        const resinDir = path.join(tmp, ".resin");
        fs.mkdirSync(resinDir, { recursive: true });

        writeProjectMetadata(tmp, {
          schemaKind: "project_metadata",
          schemaVersion: "1.0.0",
          projectId: "11111111-1111-4111-8111-111111111111",
          name: "mismatched-project",
          createdAt: new Date().toISOString(),
        });

        writeToolLock(tmp, {
          schemaKind: "tool_lock",
          schemaVersion: "1.0.0",
          projectId: "22222222-2222-4222-8222-222222222222",
          updatedAt: new Date().toISOString(),
          tools: {},
        });

        expect(() => bootstrapProject(tmp)).toThrow(/Project ID mismatch/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("fails closed when project.json has corrupt JSON syntax", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-corrupt-json-"));
      try {
        const resinDir = path.join(tmp, ".resin");
        fs.mkdirSync(resinDir, { recursive: true });
        fs.writeFileSync(path.join(resinDir, "project.json"), "invalid json content {", "utf8");

        expect(() => bootstrapProject(tmp)).toThrow();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("fails closed when metadata schema version is unsupported", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-bad-version-"));
      try {
        const resinDir = path.join(tmp, ".resin");
        fs.mkdirSync(resinDir, { recursive: true });
        fs.writeFileSync(
          path.join(resinDir, "project.json"),
          JSON.stringify({
            schemaKind: "project_metadata",
            schemaVersion: "99.0.0",
            projectId: "11111111-1111-4111-8111-111111111111",
            name: "future-project",
            createdAt: new Date().toISOString(),
          }),
          "utf8",
        );

        expect(() => bootstrapProject(tmp)).toThrow();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("fails closed when committed metadata contains secrets or forbidden patterns", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-secret-check-"));
      try {
        const resinDir = path.join(tmp, ".resin");
        fs.mkdirSync(resinDir, { recursive: true });
        fs.writeFileSync(
          path.join(resinDir, "project.json"),
          JSON.stringify({
            schemaKind: "project_metadata",
            schemaVersion: "1.0.0",
            projectId: "11111111-1111-4111-8111-111111111111",
            name: "leaky-project",
            apiKey: "sk-secret-token-12345",
            createdAt: new Date().toISOString(),
          }),
          "utf8",
        );

        expect(() => bootstrapProject(tmp)).toThrow(/Forbidden credential\/secret field/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("fails closed when .resin directory is a symbolic link", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "resin-sym-resin-"));
      const realResin = path.join(base, "real_resin");
      const projectRoot = path.join(base, "proj");
      const symResin = path.join(projectRoot, ".resin");

      fs.mkdirSync(realResin, { recursive: true });
      fs.mkdirSync(projectRoot, { recursive: true });

      try {
        fs.symlinkSync(realResin, symResin, "dir");
        expect(() => bootstrapProject(projectRoot)).toThrow(/Security violation: '.resin'/);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("fails closed when project.json or resin.lock is a symbolic link", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "resin-sym-file-"));
      const projectRoot = path.join(base, "proj");
      const resinDir = path.join(projectRoot, ".resin");
      const targetFile = path.join(base, "external.json");

      fs.mkdirSync(resinDir, { recursive: true });
      fs.writeFileSync(targetFile, "{}", "utf8");

      try {
        fs.symlinkSync(targetFile, path.join(resinDir, "project.json"));
        expect(() => bootstrapProject(projectRoot)).toThrow(/Security violation: 'project.json'/);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("fails closed on case collision for .resin directory", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "resin-case-resin-"));
      try {
        fs.mkdirSync(path.join(base, ".Resin"), { recursive: true });
        expect(() => bootstrapProject(base)).toThrow(/Security violation: case collision detected/);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("fails closed on case collision inside .resin directory", () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "resin-case-inner-"));
      const resinDir = path.join(base, ".resin");
      fs.mkdirSync(resinDir, { recursive: true });

      try {
        fs.writeFileSync(path.join(resinDir, "Project.JSON"), "{}", "utf8");
        expect(() => bootstrapProject(base)).toThrow(/Security violation: case collision detected/);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("recovers from stale lockfiles gracefully", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-stale-lock-"));
      const resinDir = path.join(tmp, ".resin");
      fs.mkdirSync(resinDir, { recursive: true });

      const lockPath = path.join(resinDir, ".bootstrap.lock");
      // Write stale lock with timestamp 1 hour in the past and dead PID
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 9999999, createdAt: Date.now() - 3600000 }),
        "utf8",
      );

      try {
        const res = bootstrapProject(tmp, {
          staleLockThresholdMs: 100,
          lockTimeoutMs: 2000,
        });
        expect(res.projectId).toMatch(UUID_V4_REGEX);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("cleans up stale temp files during bootstrap", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-stale-temp-"));
      const resinDir = path.join(tmp, ".resin");
      fs.mkdirSync(resinDir, { recursive: true });

      const staleTemp = path.join(resinDir, ".tmp-project.json-12345-old");
      fs.writeFileSync(staleTemp, "partial content", "utf8");
      // Set mtime to 2 minutes ago
      const oldTime = new Date(Date.now() - 120_000);
      fs.utimesSync(staleTemp, oldTime, oldTime);

      try {
        bootstrapProject(tmp);
        expect(fs.existsSync(staleTemp)).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("supports disableBootstrap option for isolated non-persistent resolution", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-disabled-"));
      try {
        const ctx = resolveWorkspaceContext({
          cwd: tmp,
          disableBootstrap: true,
        });

        expect(ctx.workspaceId.startsWith("ws_")).toBe(true);
        expect(fs.existsSync(path.join(tmp, ".resin"))).toBe(false);
        expect(ctx.project).toBeUndefined();
        expect(ctx.lock).toBeUndefined();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("does not mutate filesystem or throw on synthetic or nonexistent paths", () => {
      const syntheticPath = "/mock/nonexistent/workspace/alpha";
      const ctx = resolveWorkspaceContext({ cwd: syntheticPath });

      expect(ctx.workspaceId.startsWith("ws_")).toBe(true);
      expect(ctx.projectId).toBe(ctx.workspaceId);
      expect(ctx.project).toBeUndefined();
      expect(ctx.lock).toBeUndefined();
      expect(fs.existsSync(syntheticPath)).toBe(false);
    });
  });

  describe("Resolution Priority Hierarchy", () => {
    it("Priority 1: resolves from customRoots or initParams workspaceFolders", () => {
      const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), "resin-p1-"));
      try {
        const ctx = resolveWorkspaceContext({
          initParams: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test-client" },
            capabilities: {},
            workspaceFolders: [{ uri: pathToFileURL(tmp1).href, name: "test-workspace" }],
          },
          env: { RESIN_WORKSPACE: "/some/ignored/path" },
          cwd: "/another/ignored/path",
        });

        expect(ctx.source).toBe("roots");
        expect(ctx.name).toBe("test-workspace");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(tmp1));
        expect(ctx.roots).toHaveLength(1);
        expect(ctx.projectId).toMatch(UUID_V4_REGEX);
      } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
      }
    });

    it("Priority 1b: resolves from initParams rootUri / rootPath", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-rooturi-"));
      try {
        const ctx = resolveWorkspaceContext({
          initParams: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test-client" },
            capabilities: {},
            rootUri: pathToFileURL(tmp).href,
          },
          env: {},
        });

        expect(ctx.source).toBe("init_param");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(tmp));
        expect(ctx.projectId).toMatch(UUID_V4_REGEX);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("Priority 2: resolves from harness environment variables when init params absent", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-env-"));
      try {
        const ctx = resolveWorkspaceContext({
          env: {
            CLAUDE_WORKSPACE: tmp,
          },
          cwd: "/ignored/cwd",
        });

        expect(ctx.source).toBe("harness_session");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(tmp));
        expect(ctx.projectId).toMatch(UUID_V4_REGEX);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("Priority 3: falls back to CWD when neither init params nor env are provided", () => {
      const customCwd = fs.mkdtempSync(path.join(os.tmpdir(), "resin-cwd-"));
      try {
        const ctx = resolveWorkspaceContext({
          cwd: customCwd,
          env: {},
        });

        expect(ctx.source).toBe("cwd_fallback");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(customCwd));
        expect(ctx.projectId).toMatch(UUID_V4_REGEX);
      } finally {
        fs.rmSync(customCwd, { recursive: true, force: true });
      }
    });
  });

  describe("Gateway Connection & Initialize Lifecycle", () => {
    it("proves createConnection has zero filesystem side effects on real existing directory", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-gateway-conn-"));
      try {
        const router = new FakeGatewayRouter();
        const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
        const conn = gateway.createConnection({ cwd: tmpDir });

        expect(fs.existsSync(path.join(tmpDir, ".resin"))).toBe(false);
        expect(conn.workspaceContext.workspaceId.startsWith("ws_")).toBe(true);
        expect(conn.workspaceContext.project).toBeUndefined();
        expect(conn.workspaceContext.lock).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("bootstraps synchronously on initialize for real existing startup directory", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-gateway-init-"));
      try {
        const router = new FakeGatewayRouter();
        const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
        const conn = gateway.createConnection({ cwd: tmpDir });

        const initReq = {
          jsonrpc: "2.0" as const,
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "claude-code", version: "1.0.4" },
            capabilities: {},
            rootUri: pathToFileURL(tmpDir).href,
          },
        };

        // SAFETY: Gateway response is confirmed to be InitializeResult success response.
        const resp = (await gateway.handleMessage(
          conn.connectionId,
          initReq,
        )) as JsonRpcSuccessResponse<InitializeResult>;

        expect(resp.error).toBeUndefined();
        expect(conn.isInitialized).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".resin", "project.json"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".resin", "resin.lock"))).toBe(true);
        expect(conn.workspaceContext.projectId).toMatch(UUID_V4_REGEX);
        expect(conn.workspaceContext.workspaceId).toBe(conn.workspaceContext.projectId);
        expect(conn.workspaceContext.project).toBeDefined();
        expect(conn.workspaceContext.lock).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("handles initialize on synthetic/nonexistent path without mutating filesystem or throwing", async () => {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
      const conn = gateway.createConnection();

      const initReq = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-client", version: "1.0.0" },
          capabilities: {},
          rootUri: "file:///mock/nonexistent/workspace/beta",
        },
      };

      // SAFETY: Gateway response is confirmed to be InitializeResult success response.
      const resp = (await gateway.handleMessage(
        conn.connectionId,
        initReq,
      )) as JsonRpcSuccessResponse<InitializeResult>;

      expect(resp.error).toBeUndefined();
      expect(conn.isInitialized).toBe(true);
      expect(conn.workspaceContext.workspaceId.startsWith("ws_")).toBe(true);
      expect(conn.workspaceContext.project).toBeUndefined();
    });

    it("canonicalizes Git subfolder to Git root during gateway initialize and exposes startupPath", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-gw-git-"));
      const gitDir = path.join(baseDir, ".git");
      const subfolder = path.join(baseDir, "services", "api", "v1");
      fs.mkdirSync(gitDir, { recursive: true });
      fs.mkdirSync(subfolder, { recursive: true });

      try {
        const router = new FakeGatewayRouter();
        const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
        const conn = gateway.createConnection();

        const initReq = {
          jsonrpc: "2.0" as const,
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test-client", version: "1.0.0" },
            capabilities: {},
            rootUri: pathToFileURL(subfolder).href,
          },
        };

        // SAFETY: Gateway response is confirmed to be InitializeResult success response.
        const resp = (await gateway.handleMessage(
          conn.connectionId,
          initReq,
        )) as JsonRpcSuccessResponse<InitializeResult>;

        expect(resp.error).toBeUndefined();
        expect(conn.isInitialized).toBe(true);
        expect(conn.workspaceContext.projectRoot).toBe(canonicalizePath(baseDir));
        expect(conn.workspaceContext.startupPath).toBe(canonicalizePath(subfolder));
        expect(conn.workspaceContext.gitRoot).toBe(canonicalizePath(baseDir));
        expect(conn.workspaceContext.resinDir).toBe(path.join(canonicalizePath(baseDir), ".resin"));
        expect(fs.existsSync(path.join(baseDir, ".resin", "project.json"))).toBe(true);
        expect(fs.existsSync(path.join(baseDir, ".resin", "resin.lock"))).toBe(true);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe("Linked Git Worktrees & Precedence Semantics", () => {
    it("shares main repository .resin and project identity from a linked worktree", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-wt-real-"));
      const mainDir = path.join(baseDir, "main");
      const wtDir = path.join(baseDir, "feature-wt");

      try {
        fs.mkdirSync(mainDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: mainDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: mainDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: mainDir });

        // Bootstrap main project
        const mainBoot = bootstrapProject(mainDir, { projectName: "main-project" });
        expect(fs.existsSync(path.join(mainDir, ".resin", "project.json"))).toBe(true);
        expect(fs.existsSync(path.join(mainDir, ".resin", "resin.lock"))).toBe(true);

        // Create real git worktree
        execFileSync("git", ["worktree", "add", "-q", wtDir, "-b", "feature-branch"], {
          cwd: mainDir,
        });

        // Resolve git metadata
        const meta = resolveGitMetadata(wtDir);
        expect(meta).toBeDefined();
        expect(meta?.isLinkedWorktree).toBe(true);
        expect(meta?.worktreeRoot).toBe(canonicalizePath(wtDir));
        expect(meta?.primaryRoot).toBe(canonicalizePath(mainDir));

        // Resolve workspace context from the linked worktree
        const ctx = resolveWorkspaceContext({ cwd: wtDir });
        expect(ctx.projectId).toBe(mainBoot.projectId);
        expect(ctx.workspaceId).toBe(mainBoot.projectId);
        // Execution cwd / projectRoot stays feature checkout
        expect(ctx.projectRoot).toBe(canonicalizePath(wtDir));
        expect(ctx.canonicalRoot).toBe(canonicalizePath(wtDir));
        expect(ctx.startupPath).toBe(canonicalizePath(wtDir));
        expect(ctx.gitRoot).toBe(canonicalizePath(wtDir));
        // .resin and lockfile are shared from main
        expect(ctx.resinDir).toBe(path.join(canonicalizePath(mainDir), ".resin"));
        expect(ctx.projectJsonPath).toBe(
          path.join(canonicalizePath(mainDir), ".resin", "project.json"),
        );
        expect(ctx.lockPath).toBe(path.join(canonicalizePath(mainDir), ".resin", "resin.lock"));
        expect(ctx.project?.projectId).toBe(mainBoot.projectId);
        expect(ctx.lock?.projectId).toBe(mainBoot.projectId);

        // Verify no .resin directory was created in the linked worktree
        expect(fs.existsSync(path.join(wtDir, ".resin"))).toBe(false);

        // Verify readProjectMetadata and readToolLock read from main repo
        expect(readProjectMetadata(wtDir).projectId).toBe(mainBoot.projectId);
        expect(readToolLock(wtDir).projectId).toBe(mainBoot.projectId);

        // Nested subfolder in linked worktree
        const subfolder = path.join(wtDir, "src", "nested", "pkg");
        fs.mkdirSync(subfolder, { recursive: true });
        const subCtx = resolveWorkspaceContext({ cwd: subfolder });
        expect(subCtx.projectId).toBe(mainBoot.projectId);
        expect(subCtx.projectRoot).toBe(canonicalizePath(wtDir));
        expect(subCtx.startupPath).toBe(canonicalizePath(subfolder));
        expect(subCtx.gitRoot).toBe(canonicalizePath(wtDir));
        expect(subCtx.resinDir).toBe(path.join(canonicalizePath(mainDir), ".resin"));
        expect(fs.existsSync(path.join(subfolder, ".resin"))).toBe(false);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("gateway initialize on linked worktree shares main project and keeps execution/startup cwd in feature checkout", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-gw-wt-"));
      const mainDir = path.join(baseDir, "main");
      const wtDir = path.join(baseDir, "feature-checkout");
      const subfolder = path.join(wtDir, "services", "feature");

      try {
        fs.mkdirSync(mainDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: mainDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: mainDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: mainDir });

        const mainBoot = bootstrapProject(mainDir, { projectName: "shared-main" });

        // Create real git worktree
        execFileSync("git", ["worktree", "add", "-q", wtDir, "-b", "feature-x"], { cwd: mainDir });
        fs.mkdirSync(subfolder, { recursive: true });

        const router = new FakeGatewayRouter();
        const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
        const conn = gateway.createConnection();

        const initReq = {
          jsonrpc: "2.0" as const,
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test-client", version: "1.0.0" },
            capabilities: {},
            rootUri: pathToFileURL(subfolder).href,
          },
        };

        const resp = (await gateway.handleMessage(
          conn.connectionId,
          initReq,
        )) as JsonRpcSuccessResponse<InitializeResult>;

        expect(resp.error).toBeUndefined();
        expect(conn.isInitialized).toBe(true);

        // Verify execution / startup cwd stays in the feature checkout
        expect(conn.workspaceContext.startupPath).toBe(canonicalizePath(subfolder));
        expect(conn.workspaceContext.projectRoot).toBe(canonicalizePath(wtDir));
        expect(conn.workspaceContext.canonicalRoot).toBe(canonicalizePath(wtDir));
        expect(conn.workspaceContext.gitRoot).toBe(canonicalizePath(wtDir));
        expect(conn.workspaceContext.roots[0].path).toBe(canonicalizePath(subfolder));

        // Verify project identity and lock are shared from main
        expect(conn.workspaceContext.projectId).toBe(mainBoot.projectId);
        expect(conn.workspaceContext.workspaceId).toBe(mainBoot.projectId);
        expect(conn.workspaceContext.project?.projectId).toBe(mainBoot.projectId);
        expect(conn.workspaceContext.lock?.projectId).toBe(mainBoot.projectId);
        expect(conn.workspaceContext.resinDir).toBe(path.join(canonicalizePath(mainDir), ".resin"));
        expect(conn.workspaceContext.projectJsonPath).toBe(
          path.join(canonicalizePath(mainDir), ".resin", "project.json"),
        );
        expect(conn.workspaceContext.lockPath).toBe(
          path.join(canonicalizePath(mainDir), ".resin", "resin.lock"),
        );

        // Feature checkout has NO separate .resin created
        expect(fs.existsSync(path.join(wtDir, ".resin"))).toBe(false);
        expect(fs.existsSync(path.join(subfolder, ".resin"))).toBe(false);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("main existing state wins over stale linked-worktree .resin from old behavior", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-wt-precedence-"));
      const mainDir = path.join(baseDir, "main");
      const wtDir = path.join(baseDir, "wt-stale");

      try {
        fs.mkdirSync(mainDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: mainDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: mainDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: mainDir });

        const mainBoot = bootstrapProject(mainDir, { projectName: "main-primary" });
        const mainProjectId = mainBoot.projectId;

        // Real worktree
        execFileSync("git", ["worktree", "add", "-q", wtDir, "-b", "b-stale"], { cwd: mainDir });

        // Simulate old behavior: a stale, distinct .resin was created in the worktree
        const staleResinDir = path.join(wtDir, ".resin");
        fs.mkdirSync(staleResinDir, { recursive: true });
        const staleProjectId = "00000000-0000-4000-8000-000000000001";
        writeProjectMetadata(staleResinDir, {
          schemaKind: "project_metadata",
          schemaVersion: "1.0.0",
          projectId: staleProjectId,
          name: "stale-worktree-project",
          createdAt: new Date().toISOString(),
        });
        writeToolLock(staleResinDir, {
          schemaKind: "tool_lock",
          schemaVersion: "1.0.0",
          projectId: staleProjectId,
          updatedAt: new Date().toISOString(),
          tools: {},
        });

        // Main existing state must win:
        const resolvedResin = resolveProjectResinDir(wtDir);
        expect(resolvedResin).toBe(path.join(canonicalizePath(mainDir), ".resin"));

        const ctx = resolveWorkspaceContext({ cwd: wtDir });
        expect(ctx.projectId).toBe(mainProjectId);
        expect(ctx.projectId).not.toBe(staleProjectId);
        expect(ctx.projectRoot).toBe(canonicalizePath(wtDir));
        expect(ctx.gitRoot).toBe(canonicalizePath(wtDir));
        expect(ctx.resinDir).toBe(path.join(canonicalizePath(mainDir), ".resin"));

        // readProjectMetadata and readToolLock from worktree path must return main state
        expect(readProjectMetadata(wtDir).projectId).toBe(mainProjectId);
        expect(readToolLock(wtDir).projectId).toBe(mainProjectId);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });
    it("existing empty main .resin directory wins over stale linked-worktree metadata", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-wt-empty-main-"));
      const mainDir = path.join(baseDir, "main");
      const wtDir = path.join(baseDir, "wt-stale-empty-main");

      try {
        fs.mkdirSync(mainDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: mainDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: mainDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: mainDir });

        // Main has an existing, empty .resin directory (no project.json or resin.lock yet)
        const mainResinDir = path.join(mainDir, ".resin");
        fs.mkdirSync(mainResinDir, { recursive: true });

        // Real worktree
        execFileSync("git", ["worktree", "add", "-q", wtDir, "-b", "b-stale-empty"], {
          cwd: mainDir,
        });

        // Worktree has stale metadata
        const staleResinDir = path.join(wtDir, ".resin");
        fs.mkdirSync(staleResinDir, { recursive: true });
        const staleProjectId = "00000000-0000-4000-8000-000000000002";
        writeProjectMetadata(staleResinDir, {
          schemaKind: "project_metadata",
          schemaVersion: "1.0.0",
          projectId: staleProjectId,
          name: "stale-wt",
          createdAt: new Date().toISOString(),
        });

        // The existing empty main .resin directory must win:
        const resolvedResin = resolveProjectResinDir(wtDir);
        expect(resolvedResin).toBe(path.join(canonicalizePath(mainDir), ".resin"));

        // Bootstrapping from the worktree bootstraps in main repo .resin
        const ctx = resolveWorkspaceContext({ cwd: wtDir });
        expect(ctx.projectId).not.toBe(staleProjectId);
        expect(ctx.resinDir).toBe(path.join(canonicalizePath(mainDir), ".resin"));
        expect(fs.existsSync(path.join(mainResinDir, "project.json"))).toBe(true);
        expect(fs.existsSync(path.join(mainResinDir, "resin.lock"))).toBe(true);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("resolves worktrees created from another linked worktree using real git fixtures", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-wt-chained-real-"));
      const mainDir = path.join(baseDir, "main");
      const wt1Dir = path.join(baseDir, "wt1");
      const wt2Dir = path.join(baseDir, "wt2");

      try {
        fs.mkdirSync(mainDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: mainDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: mainDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: mainDir });

        const mainBoot = bootstrapProject(mainDir, { projectName: "main-repo" });

        // wt1 created from main
        execFileSync("git", ["worktree", "add", "-q", wt1Dir, "-b", "b1"], { cwd: mainDir });

        // wt2 created from wt1 (worktree created from another linked worktree)
        execFileSync("git", ["worktree", "add", "-q", wt2Dir, "-b", "b2"], { cwd: wt1Dir });

        const meta2 = resolveGitMetadata(wt2Dir);
        expect(meta2).toBeDefined();
        expect(meta2?.isLinkedWorktree).toBe(true);
        expect(meta2?.worktreeRoot).toBe(canonicalizePath(wt2Dir));
        expect(meta2?.primaryRoot).toBe(canonicalizePath(mainDir));

        const ctx2 = resolveWorkspaceContext({ cwd: wt2Dir });
        expect(ctx2.projectId).toBe(mainBoot.projectId);
        expect(ctx2.projectRoot).toBe(canonicalizePath(wt2Dir));
        expect(ctx2.gitRoot).toBe(canonicalizePath(wt2Dir));
        expect(ctx2.resinDir).toBe(path.join(canonicalizePath(mainDir), ".resin"));
        expect(fs.existsSync(path.join(wt2Dir, ".resin"))).toBe(false);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("bootstraps in main repository root when starting in a fresh linked worktree without existing state", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-wt-fresh-"));
      const mainDir = path.join(baseDir, "main");
      const wtDir = path.join(baseDir, "wt-fresh");

      try {
        fs.mkdirSync(mainDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: mainDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: mainDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: mainDir });

        // No .resin in main, no .resin in wt
        execFileSync("git", ["worktree", "add", "-q", wtDir, "-b", "b-fresh"], { cwd: mainDir });

        // Bootstrap initiated from the worktree
        const res = bootstrapProject(wtDir);
        expect(res.projectRoot).toBe(canonicalizePath(wtDir));
        expect(res.resinDir).toBe(path.join(canonicalizePath(mainDir), ".resin"));

        // Created in main repository, NOT in the worktree
        expect(fs.existsSync(path.join(mainDir, ".resin", "project.json"))).toBe(true);
        expect(fs.existsSync(path.join(mainDir, ".resin", "resin.lock"))).toBe(true);
        expect(fs.existsSync(path.join(wtDir, ".resin"))).toBe(false);

        // Main repo now shares this exact project identity
        const mainCtx = resolveWorkspaceContext({ cwd: mainDir });
        expect(mainCtx.projectId).toBe(res.projectId);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("preserves standalone behavior for repository without shared state when worktree has own .resin", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-wt-standalone-"));
      const mainDir = path.join(baseDir, "main");
      const wtDir = path.join(baseDir, "wt-solo");

      try {
        fs.mkdirSync(mainDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: mainDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: mainDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: mainDir });

        // Main has NO .resin
        execFileSync("git", ["worktree", "add", "-q", wtDir, "-b", "b-solo"], { cwd: mainDir });

        // Worktree has its own standalone .resin
        const wtResin = path.join(wtDir, ".resin");
        fs.mkdirSync(wtResin, { recursive: true });
        const soloId = "11111111-2222-4000-8000-333333333333";
        writeProjectMetadata(wtResin, {
          schemaKind: "project_metadata",
          schemaVersion: "1.0.0",
          projectId: soloId,
          name: "solo-wt",
          createdAt: new Date().toISOString(),
        });
        writeToolLock(wtResin, {
          schemaKind: "tool_lock",
          schemaVersion: "1.0.0",
          projectId: soloId,
          updatedAt: new Date().toISOString(),
          tools: {},
        });

        // Preserves standalone behavior because main has no shared state
        expect(resolveProjectResinDir(wtDir)).toBe(path.join(canonicalizePath(wtDir), ".resin"));
        const ctx = resolveWorkspaceContext({ cwd: wtDir });
        expect(ctx.projectId).toBe(soloId);
        expect(ctx.projectRoot).toBe(canonicalizePath(wtDir));
        expect(ctx.resinDir).toBe(path.join(canonicalizePath(wtDir), ".resin"));
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("treats Git submodules as independent projects without linking to superproject", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-submodule-"));
      const superDir = path.join(baseDir, "super");
      const subDir = path.join(baseDir, "child");

      try {
        fs.mkdirSync(superDir, { recursive: true });
        fs.mkdirSync(subDir, { recursive: true });

        execFileSync("git", ["init", "-q"], { cwd: superDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: superDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: superDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init-super"], {
          cwd: superDir,
        });

        execFileSync("git", ["init", "-q"], { cwd: subDir });
        execFileSync("git", ["config", "user.name", "test"], { cwd: subDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: subDir });
        execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init-sub"], { cwd: subDir });

        // Bootstrap superproject
        const superBoot = bootstrapProject(superDir, { projectName: "super-project" });

        // Add real submodule
        execFileSync(
          "git",
          [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            subDir,
            "modules/child-service",
          ],
          { cwd: superDir },
        );

        const actualSubDir = path.join(superDir, "modules", "child-service");
        const meta = resolveGitMetadata(actualSubDir);
        expect(meta).toBeDefined();
        expect(meta?.isLinkedWorktree).toBe(false);
        expect(meta?.worktreeRoot).toBe(canonicalizePath(actualSubDir));
        expect(meta?.primaryRoot).toBe(canonicalizePath(actualSubDir));

        // Resolving submodule must NOT inherit superproject identity
        const subCtx = resolveWorkspaceContext({ cwd: actualSubDir });
        expect(subCtx.projectId).not.toBe(superBoot.projectId);
        expect(subCtx.projectRoot).toBe(canonicalizePath(actualSubDir));
        expect(subCtx.resinDir).toBe(path.join(canonicalizePath(actualSubDir), ".resin"));
        expect(fs.existsSync(path.join(actualSubDir, ".resin", "project.json"))).toBe(true);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("treats repositories with --separate-git-dir as independent projects", () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-separate-git-"));
      const workDir = path.join(baseDir, "checkout");
      const gitDir = path.join(baseDir, "standalone.git");

      try {
        execFileSync("git", ["init", "-q", `--separate-git-dir=${gitDir}`, workDir]);

        const meta = resolveGitMetadata(workDir);
        expect(meta).toBeDefined();
        expect(meta?.isLinkedWorktree).toBe(false);
        expect(meta?.worktreeRoot).toBe(canonicalizePath(workDir));
        expect(meta?.primaryRoot).toBe(canonicalizePath(workDir));

        const ctx = resolveWorkspaceContext({ cwd: workDir });
        expect(ctx.projectRoot).toBe(canonicalizePath(workDir));
        expect(ctx.resinDir).toBe(path.join(canonicalizePath(workDir), ".resin"));
        expect(fs.existsSync(path.join(workDir, ".resin", "project.json"))).toBe(true);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });
  });
});
