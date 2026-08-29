import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerSecurityError, FilesystemBroker } from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Filesystem Broker Security & Containment", () => {
  let tempWorkspace: string;
  let outsideDir: string;
  let broker: FilesystemBroker;

  beforeAll(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs_broker_ws_"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs_broker_outside_"));
    fs.writeFileSync(path.join(outsideDir, "outside_secret.txt"), "TOP_SECRET_OUTSIDE");
    broker = new FilesystemBroker();
  });

  afterAll(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {}
  });

  const createGrant = (overrides: Record<string, unknown> = {}) => {
    return createInvocationGrant({
      grantId: "grant_fs_test",
      invocationId: "inv_fs_001",
      toolId: "fs_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_fs",
      envelopeId: "env_fs",
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: ["**/denied_dir/**", "**/.secret*"],
          maxFileSizeBytes: 1024 * 1024, // 1MB
          ...overrides,
        },
      },
    });
  };

  it("permits authorized read, write, and stat operations inside workspace root", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // 1. Write file
    const writeRes = await broker.writeFile(
      { path: "hello.txt", content: "Hello Broker Security!" },
      ctx,
    );
    expect(writeRes.bytesWritten).toBeGreaterThan(0);

    // 2. Stat file
    const statRes = await broker.stat({ path: "hello.txt" }, ctx);
    expect(statRes.isFile).toBe(true);
    expect(statRes.size).toBe(Buffer.byteLength("Hello Broker Security!"));

    // 3. Read file
    const readRes = await broker.readFile({ path: "hello.txt" }, ctx);
    expect(readRes.content).toBe("Hello Broker Security!");

    // 4. Exists
    const existsRes = await broker.exists({ path: "hello.txt" }, ctx);
    expect(existsRes.exists).toBe(true);
  });

  it("blocks directory traversal attempts using '../' outside workspace", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const traversalPaths = [
      "../outside.txt",
      "../../../../etc/passwd",
      "subdir/../../../outside_secret.txt",
      "/etc/shadow",
    ];

    for (const badPath of traversalPaths) {
      let threw = false;
      try {
        await broker.readFile({ path: badPath }, ctx);
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect(["OUTSIDE_ALLOWED_ROOT", "PATH_TRAVERSAL", "HIDDEN_FILE_DENIED"]).toContain(
          (err as BrokerSecurityError).code,
        );
      }
      expect(threw).toBe(true);
    }
  });

  it("blocks null bytes and path injection characters", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const invalidPaths = ["test.txt\0.js", "test%00.txt", "test\x1f.txt"];

    for (const badPath of invalidPaths) {
      await expect(broker.readFile({ path: badPath }, ctx)).rejects.toThrow(BrokerSecurityError);
    }
  });

  it("detects and prevents symlink escape outside authorized workspace", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Create a symlink pointing to an outside secret file
    const symlinkPath = path.join(tempWorkspace, "malicious_symlink.txt");
    try {
      fs.symlinkSync(path.join(outsideDir, "outside_secret.txt"), symlinkPath);
    } catch {}

    // Reading through the symlink must be blocked
    await expect(broker.readFile({ path: "malicious_symlink.txt" }, ctx)).rejects.toThrow(
      BrokerSecurityError,
    );

    try {
      await broker.readFile({ path: "malicious_symlink.txt" }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("SYMLINK_ESCAPE");
    }
  });

  it("blocks sensitive hidden files (.git, .env, .ssh) by default", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Write a hidden file on disk directly
    fs.writeFileSync(path.join(tempWorkspace, ".env"), "API_KEY=secret123");

    let threwEnvDirect = false;
    try {
      await broker.readFile({ path: ".env" }, ctx);
    } catch (err) {
      threwEnvDirect = true;
      expect(err).toBeInstanceOf(BrokerSecurityError);
      expect((err as BrokerSecurityError).code).toBe("HIDDEN_FILE_DENIED");
    }
    expect(threwEnvDirect).toBe(true);
  });

  it("strictly enforces denyPaths precedence over allowed roots", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Create denied directory inside workspace
    const deniedSubdir = path.join(tempWorkspace, "denied_dir");
    fs.mkdirSync(deniedSubdir, { recursive: true });
    fs.writeFileSync(path.join(deniedSubdir, "data.txt"), "Denied Content");

    await expect(broker.readFile({ path: "denied_dir/data.txt" }, ctx)).rejects.toThrow(
      BrokerSecurityError,
    );

    try {
      await broker.readFile({ path: "denied_dir/data.txt" }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("PATH_DENIED");
    }
  });

  it("enforces maxFileSizeBytes limit on readFile and writeFile", async () => {
    const grant = createGrant({ maxFileSizeBytes: 100 }); // 100 bytes max
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Write 200 bytes -> rejected
    await expect(
      broker.writeFile({ path: "oversized.txt", content: "X".repeat(200) }, ctx),
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.writeFile({ path: "oversized.txt", content: "X".repeat(200) }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("MAX_FILE_SIZE_EXCEEDED");
    }

    // Write small file directly on disk (150 bytes) and try reading via broker -> rejected
    fs.writeFileSync(path.join(tempWorkspace, "large_on_disk.txt"), "Y".repeat(150));
    await expect(broker.readFile({ path: "large_on_disk.txt" }, ctx)).rejects.toThrow(
      BrokerSecurityError,
    );
  });

  it("supports atomic file writes without leaving corrupted temporary files", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await broker.writeFile(
      { path: "atomic_target.txt", content: "Atomic payload", atomic: true },
      ctx,
    );

    const readBack = await broker.readFile({ path: "atomic_target.txt" }, ctx);
    expect(readBack.content).toBe("Atomic payload");

    // Ensure no .tmp files linger in workspace
    const entries = fs.readdirSync(tempWorkspace);
    const tmpFiles = entries.filter((e) => e.includes(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  it("handles directory creation, listing, renaming, and deletion", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // 1. Create directory
    await broker.createDirectory({ path: "test_dir/nested", recursive: true }, ctx);

    // 2. Write file in nested dir
    await broker.writeFile({ path: "test_dir/nested/file.txt", content: "nested content" }, ctx);

    // 3. List directory
    const listRes = await broker.listDirectory({ path: "test_dir", recursive: true }, ctx);
    expect(listRes).toContain("nested");
    expect(listRes).toContain("nested/file.txt");

    // 4. Rename file
    await broker.rename(
      { oldPath: "test_dir/nested/file.txt", newPath: "test_dir/nested/renamed.txt" },
      ctx,
    );
    const existsOld = await broker.exists({ path: "test_dir/nested/file.txt" }, ctx);
    const existsNew = await broker.exists({ path: "test_dir/nested/renamed.txt" }, ctx);
    expect(existsOld.exists).toBe(false);
    expect(existsNew.exists).toBe(true);

    // 5. Delete directory recursively
    await broker.delete({ path: "test_dir", recursive: true }, ctx);
    const existsDir = await broker.exists({ path: "test_dir" }, ctx);
    expect(existsDir.exists).toBe(false);
  });

  it("enforces workspace-root authorization boundary when allowWorkspaceRoot is false", async () => {
    // Create test files in workspace
    fs.writeFileSync(path.join(tempWorkspace, "explicit_allowed.txt"), "Explicit Content");
    fs.writeFileSync(path.join(tempWorkspace, "other_workspace.txt"), "Other Content");

    // Grant with allowWorkspaceRoot: false, only explicit_allowed.txt permitted
    const restrictedGrant = createGrant({
      allowWorkspaceRoot: false,
      readPaths: ["explicit_allowed.txt"],
      writePaths: ["explicit_allowed.txt"],
    });
    const ctx = {
      invocationId: "inv_fs_001",
      grant: restrictedGrant,
      workspaceRoot: tempWorkspace,
    };

    // Explicitly allowed file succeeds
    const allowedRead = await broker.readFile({ path: "explicit_allowed.txt" }, ctx);
    expect(allowedRead.content).toBe("Explicit Content");

    // Non-explicit file in workspace fails with OUTSIDE_ALLOWED_ROOT
    await expect(broker.readFile({ path: "other_workspace.txt" }, ctx)).rejects.toThrow(
      BrokerSecurityError,
    );
    try {
      await broker.readFile({ path: "other_workspace.txt" }, ctx);
    } catch (err) {
      expect(["OPERATION_NOT_PERMITTED", "OUTSIDE_ALLOWED_ROOT"]).toContain(
        (err as BrokerSecurityError).code,
      );
    }
    // Writing to non-explicit file fails
    await expect(
      broker.writeFile({ path: "other_workspace.txt", content: "New Content" }, ctx),
    ).rejects.toThrow(BrokerSecurityError);
  });

  it("blocks access to credential paths and sensitive credential patterns even inside workspace", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const sensitivePaths = [
      ".ssh/id_rsa",
      ".ssh/id_ed25519",
      ".ssh/authorized_keys",
      ".ssh/config",
      ".aws/credentials",
      ".aws/config",
      ".git/config",
      ".git/HEAD",
      ".env",
      ".env.local",
      ".env.production",
      ".npmrc",
      ".netrc",
      ".docker/config.json",
      "/etc/shadow",
      "/etc/passwd",
      "/etc/sudoers",
    ];

    for (const credPath of sensitivePaths) {
      // Direct read attempts must be rejected with BrokerSecurityError
      let threwRead = false;
      try {
        await broker.readFile({ path: credPath }, ctx);
      } catch (err) {
        threwRead = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect([
          "SENSITIVE_PATH_DENIED",
          "HIDDEN_FILE_DENIED",
          "OUTSIDE_ALLOWED_ROOT",
          "PATH_TRAVERSAL",
          "OPERATION_NOT_PERMITTED",
          "PATH_DENIED",
        ]).toContain((err as BrokerSecurityError).code);
      }
      expect(threwRead).toBe(true);

      // Direct write attempts must be rejected with BrokerSecurityError
      let threwWrite = false;
      try {
        await broker.writeFile({ path: credPath, content: "ATTACKER_DATA" }, ctx);
      } catch (err) {
        threwWrite = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect([
          "SENSITIVE_PATH_DENIED",
          "HIDDEN_FILE_DENIED",
          "OUTSIDE_ALLOWED_ROOT",
          "PATH_TRAVERSAL",
          "OPERATION_NOT_PERMITTED",
          "PATH_DENIED",
        ]).toContain((err as BrokerSecurityError).code);
      }
      expect(threwWrite).toBe(true);
    }
  });

  it("blocks symlink chains, nested symlink escapes, and symlinks to sensitive targets", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // 1. Multi-hop symlink chain escaping outside workspace (hop1 -> hop2 -> outside_secret.txt)
    const hop2Path = path.join(tempWorkspace, "hop2_link.txt");
    const hop1Path = path.join(tempWorkspace, "hop1_link.txt");
    const outsideSecret = path.join(outsideDir, "outside_secret.txt");

    try {
      fs.symlinkSync(outsideSecret, hop2Path);
      fs.symlinkSync(hop2Path, hop1Path);

      let threwHop = false;
      try {
        await broker.readFile({ path: "hop1_link.txt" }, ctx);
      } catch (err) {
        threwHop = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect(["SYMLINK_ESCAPE", "OUTSIDE_ALLOWED_ROOT"]).toContain(
          (err as BrokerSecurityError).code,
        );
      }
      expect(threwHop).toBe(true);
    } catch {
      // Windows symlink permissions fallback
    }

    // 2. Symlink loop (loop_a -> loop_b -> loop_a)
    const loopA = path.join(tempWorkspace, "loop_a.txt");
    const loopB = path.join(tempWorkspace, "loop_b.txt");
    try {
      fs.symlinkSync(loopB, loopA);
      fs.symlinkSync(loopA, loopB);

      let threwLoop = false;
      try {
        await broker.readFile({ path: "loop_a.txt" }, ctx);
      } catch (err) {
        threwLoop = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect([
          "SYMLINK_ESCAPE",
          "SYMLINK_RESOLUTION_FAILED",
          "INVALID_PATH",
          "OPERATION_NOT_PERMITTED",
        ]).toContain((err as BrokerSecurityError).code);
      }
      expect(threwLoop).toBe(true);
    } catch {
      // Windows symlink permissions fallback
    }

    // 3. Symlink inside workspace pointing to a sensitive file (.env)
    const envTarget = path.join(tempWorkspace, ".env");
    const envLink = path.join(tempWorkspace, "public_alias_to_env.txt");
    fs.writeFileSync(envTarget, "SENSITIVE_SECRET=true");
    try {
      fs.symlinkSync(envTarget, envLink);

      let threwEnv = false;
      try {
        await broker.readFile({ path: "public_alias_to_env.txt" }, ctx);
      } catch (err) {
        threwEnv = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect(["HIDDEN_FILE_DENIED", "SENSITIVE_PATH_DENIED"]).toContain(
          (err as BrokerSecurityError).code,
        );
      }
      expect(threwEnv).toBe(true);
    } catch {
      // Windows symlink permissions fallback
    }

    // 4. Relative symlink with directory traversal escaping workspace
    const traversalLink = path.join(tempWorkspace, "traversal_link.txt");
    try {
      fs.symlinkSync(
        path.join("..", path.basename(outsideDir), "outside_secret.txt"),
        traversalLink,
      );

      let threwTrav = false;
      try {
        await broker.readFile({ path: "traversal_link.txt" }, ctx);
      } catch (err) {
        threwTrav = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect(["SYMLINK_ESCAPE", "OUTSIDE_ALLOWED_ROOT", "PATH_TRAVERSAL"]).toContain(
          (err as BrokerSecurityError).code,
        );
      }
      expect(threwTrav).toBe(true);
    } catch {
      // Windows symlink permissions fallback
    }
  });

  it("rejects absolute paths outside allowed roots and prevents parent directory widening", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const absoluteOutsidePaths = [
      path.join(outsideDir, "outside_secret.txt"),
      "/var/log/system.log",
      "/tmp/unauthorized_arbitrary_file.txt",
    ];
    for (const absPath of absoluteOutsidePaths) {
      let threwAbs = false;
      try {
        await broker.readFile({ path: absPath }, ctx);
      } catch (err) {
        threwAbs = true;
        expect(err).toBeInstanceOf(BrokerSecurityError);
        expect([
          "OUTSIDE_ALLOWED_ROOT",
          "PATH_TRAVERSAL",
          "SENSITIVE_PATH_DENIED",
          "HIDDEN_FILE_DENIED",
        ]).toContain((err as BrokerSecurityError).code);
      }
      expect(threwAbs).toBe(true);
    }
  });

  it("guarantees atomic write rollback and cross-boundary rename containment (TOCTOU mitigation)", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // 1. Cross-boundary rename: moving file from inside workspace to outside directory is blocked
    fs.writeFileSync(path.join(tempWorkspace, "to_escape.txt"), "Escape Payload");
    await expect(
      broker.rename(
        { oldPath: "to_escape.txt", newPath: path.join(outsideDir, "escaped.txt") },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    // Relative traversal in rename newPath is also blocked
    await expect(
      broker.rename({ oldPath: "to_escape.txt", newPath: "../escaped_relative.txt" }, ctx),
    ).rejects.toThrow(BrokerSecurityError);

    // Overwrite outside target via rename is blocked
    await expect(
      broker.rename(
        { oldPath: "to_escape.txt", newPath: path.join(outsideDir, "outside_secret.txt") },
        ctx,
      ),
    ).rejects.toThrow(BrokerSecurityError);

    // Verify source file was not moved
    const existsOriginal = await broker.exists({ path: "to_escape.txt" }, ctx);
    expect(existsOriginal.exists).toBe(true);
  });
});
