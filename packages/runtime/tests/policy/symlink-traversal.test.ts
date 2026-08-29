import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerSecurityError, FilesystemBroker } from "../../src/brokers/index.js";
import {
  PolicyCanonicalizationError,
  canonicalizePath,
  isPathInsideRoot,
  isPathPermitted,
  isSensitivePath,
  matchesPathPattern,
  resolvePlatformAliases,
  validatePathCharacters,
} from "../../src/policy/canonicalizers.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Symlink Traversal, Escape, and Platform Aliases Security Corpus", () => {
  let tempWorkspace: string;
  let outsideDir: string;
  let scratchDir: string;
  let broker: FilesystemBroker;

  beforeAll(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "te_symlink_ws_"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "te_symlink_outside_"));
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "te_symlink_scratch_"));

    // Populate outside files
    fs.writeFileSync(path.join(outsideDir, "outside_secret.txt"), "OUTSIDE_CONFIDENTIAL");
    fs.writeFileSync(path.join(outsideDir, "system_shadow"), "ROOT_SHADOW_ENTRY");

    // Populate workspace files
    fs.writeFileSync(path.join(tempWorkspace, "safe.txt"), "SAFE_CONTENT");
    fs.writeFileSync(path.join(tempWorkspace, ".env"), "API_KEY=sensitive123");
    fs.writeFileSync(path.join(tempWorkspace, ".env.production"), "PROD_SECRET=xyz789");
    fs.writeFileSync(path.join(tempWorkspace, ".env.example"), "API_KEY=your_key_here");

    const gitDir = path.join(tempWorkspace, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0");

    const sshDir = path.join(tempWorkspace, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "id_rsa"), "MOCK_PRIVATE_KEY");

    // Create nested subdirectories
    const subDir = path.join(tempWorkspace, "subdir", "nested");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "nested_safe.txt"), "NESTED_SAFE");
    fs.writeFileSync(path.join(subDir, ".env"), "NESTED_SECRET");

    // Create Symlinks inside workspace
    try {
      // 1. Symlink to outside file
      fs.symlinkSync(
        path.join(outsideDir, "outside_secret.txt"),
        path.join(tempWorkspace, "symlink_to_outside.txt"),
      );

      // 2. Symlink to outside directory
      fs.symlinkSync(outsideDir, path.join(tempWorkspace, "symlink_outside_dir"));

      // 3. Symlink to sensitive .git inside workspace
      fs.symlinkSync(gitDir, path.join(tempWorkspace, "innocent_looking_git_link"));

      // 4. Symlink to sensitive .env
      fs.symlinkSync(
        path.join(tempWorkspace, ".env"),
        path.join(tempWorkspace, "innocent_env_link.txt"),
      );

      // 5. Relative symlink climbing out
      fs.symlinkSync("../outside_secret.txt", path.join(tempWorkspace, "relative_climb_link.txt"));
    } catch {
      // If symlink creation fails on restricted platforms, tests adapt
    }

    broker = new FilesystemBroker();
  });

  afterAll(() => {
    try {
      if (fs.existsSync(tempWorkspace)) fs.rmSync(tempWorkspace, { recursive: true, force: true });
      if (fs.existsSync(outsideDir)) fs.rmSync(outsideDir, { recursive: true, force: true });
      if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  });

  const createGrant = (overrides: Record<string, unknown> = {}) => {
    return createInvocationGrant({
      grantId: "grant_symlink_test",
      invocationId: "inv_symlink_001",
      toolId: "symlink_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_symlink",
      envelopeId: "env_symlink",
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: ["**/.forbidden*"],
          maxFileSizeBytes: 1024 * 1024,
          ...overrides,
        },
      },
    });
  };

  describe("Escape and Parent Traversal Attack Corpus", () => {
    const traversalPayloads = [
      "../../outside_secret.txt",
      "../outside_secret.txt",
      "....//....//outside_secret.txt",
      "subdir/../../outside_secret.txt",
      "{{workspace}}/../../../etc/passwd",
      "%2e%2e/outside_secret.txt",
      "%2e%2e%2foutside_secret.txt",
      "%252e%252e%252foutside_secret.txt",
      "..%2foutside_secret.txt",
      "..%5coutside_secret.txt",
    ];

    for (const payload of traversalPayloads) {
      it(`blocks traversal escape attempt: ${payload}`, async () => {
        const ctx = {
          workspaceRoot: tempWorkspace,
          scratchDir,
          grant: createGrant(),
          invocationId: "inv_symlink_001",
          toolId: "symlink_tool",
          toolVersion: "1.0.0",
        };

        await expect(broker.readFile({ path: payload }, ctx)).rejects.toThrow();
      });
    }
  });

  describe("Symlink-Swap and Symlink Escape Corpus", () => {
    it("blocks reading a symlink pointing to an outside file", async () => {
      const ctx = {
        workspaceRoot: tempWorkspace,
        scratchDir,
        grant: createGrant(),
        invocationId: "inv_symlink_001",
        toolId: "symlink_tool",
        toolVersion: "1.0.0",
      };

      const symlinkFile = path.join(tempWorkspace, "symlink_to_outside.txt");
      if (fs.existsSync(symlinkFile)) {
        await expect(broker.readFile({ path: "symlink_to_outside.txt" }, ctx)).rejects.toThrowError(
          BrokerSecurityError,
        );
      }
    });

    it("blocks writing to a path under a symlinked outside directory", async () => {
      const ctx = {
        workspaceRoot: tempWorkspace,
        scratchDir,
        grant: createGrant({ writePaths: ["**/*"] }),
        invocationId: "inv_symlink_001",
        toolId: "symlink_tool",
        toolVersion: "1.0.0",
      };

      const symlinkDir = path.join(tempWorkspace, "symlink_outside_dir");
      if (fs.existsSync(symlinkDir)) {
        await expect(
          broker.writeFile(
            { path: "symlink_outside_dir/escaped_write.txt", content: "PWNED" },
            ctx,
          ),
        ).rejects.toThrowError(BrokerSecurityError);
      }
    });

    it("blocks symlinks pointing to sensitive .git even inside workspace", async () => {
      const ctx = {
        workspaceRoot: tempWorkspace,
        scratchDir,
        grant: createGrant({ readPaths: ["**/*"] }),
        invocationId: "inv_symlink_001",
        toolId: "symlink_tool",
        toolVersion: "1.0.0",
      };

      const linkGit = path.join(tempWorkspace, "innocent_looking_git_link");
      if (fs.existsSync(linkGit)) {
        await expect(
          broker.readFile({ path: "innocent_looking_git_link/config" }, ctx),
        ).rejects.toThrowError(BrokerSecurityError);
      }
    });

    it("blocks symlinks pointing to sensitive .env even with alias name", async () => {
      const ctx = {
        workspaceRoot: tempWorkspace,
        scratchDir,
        grant: createGrant({ readPaths: ["**/*"] }),
        invocationId: "inv_symlink_001",
        toolId: "symlink_tool",
        toolVersion: "1.0.0",
      };

      const linkEnv = path.join(tempWorkspace, "innocent_env_link.txt");
      if (fs.existsSync(linkEnv)) {
        await expect(broker.readFile({ path: "innocent_env_link.txt" }, ctx)).rejects.toThrowError(
          BrokerSecurityError,
        );
      }
    });
  });

  describe("Sensitive Paths Under Authorized Wildcard Workspace Patterns", () => {
    const sensitiveFiles = [
      ".env",
      ".env.production",
      ".git/config",
      ".ssh/id_rsa",
      "subdir/nested/.env",
    ];

    for (const sensFile of sensitiveFiles) {
      it(`denies access to sensitive path '${sensFile}' even with readPaths: ['**/*'] and allowWorkspaceRoot: true`, async () => {
        const ctx = {
          workspaceRoot: tempWorkspace,
          scratchDir,
          grant: createGrant({ allowWorkspaceRoot: true, readPaths: ["**/*"] }),
          invocationId: "inv_symlink_001",
          toolId: "symlink_tool",
          toolVersion: "1.0.0",
        };

        await expect(broker.readFile({ path: sensFile }, ctx)).rejects.toThrowError(
          /Access to sensitive or hidden path is denied|Resolved target points to sensitive/,
        );
      });
    }

    it("allows non-sensitive workspace files under wildcard pattern", async () => {
      const ctx = {
        workspaceRoot: tempWorkspace,
        scratchDir,
        grant: createGrant({ allowWorkspaceRoot: true, readPaths: ["**/*"] }),
        invocationId: "inv_symlink_001",
        toolId: "symlink_tool",
        toolVersion: "1.0.0",
      };

      const res = await broker.readFile({ path: "safe.txt" }, ctx);
      expect(res.content).toBe("SAFE_CONTENT");

      const nestedRes = await broker.readFile({ path: "subdir/nested/nested_safe.txt" }, ctx);
      expect(nestedRes.content).toBe("NESTED_SAFE");
    });

    it("allows explicit literal non-wildcard sensitive match (e.g. .env.example)", async () => {
      const ctx = {
        workspaceRoot: tempWorkspace,
        scratchDir,
        grant: createGrant({ allowWorkspaceRoot: true, readPaths: [".env.example"] }),
        invocationId: "inv_symlink_001",
        toolId: "symlink_tool",
        toolVersion: "1.0.0",
      };

      const res = await broker.readFile({ path: ".env.example" }, ctx);
      expect(res.content).toBe("API_KEY=your_key_here");
    });
  });

  describe("Scratch-to-Workspace Boundary Enforcement", () => {
    it("denies access to workspace files when grant only allows scratch temp directory", async () => {
      const ctx = {
        workspaceRoot: tempWorkspace,
        scratchDir,
        grant: createGrant({ allowWorkspaceRoot: false, allowTemp: true, readPaths: [] }),
        invocationId: "inv_symlink_001",
        toolId: "symlink_tool",
        toolVersion: "1.0.0",
      };

      // Create a scratch file
      fs.writeFileSync(path.join(scratchDir, "scratch_file.txt"), "SCRATCH_DATA");

      // Reading scratch file succeeds
      const scratchRes = await broker.readFile(
        { path: path.join(scratchDir, "scratch_file.txt") },
        ctx,
      );
      expect(scratchRes.content).toBe("SCRATCH_DATA");

      // Reading workspace safe.txt fails
      await expect(broker.readFile({ path: "safe.txt" }, ctx)).rejects.toThrowError(
        BrokerSecurityError,
      );
    });
  });

  describe("Malformed Paths Corpus", () => {
    it("rejects empty path", () => {
      expect(() => validatePathCharacters("")).toThrowError(PolicyCanonicalizationError);
    });

    it("rejects null bytes in path", () => {
      expect(() => validatePathCharacters("safe.txt\0evil")).toThrowError(
        PolicyCanonicalizationError,
      );
    });

    it("rejects control characters", () => {
      expect(() => validatePathCharacters("safe\x01file.txt")).toThrowError(
        PolicyCanonicalizationError,
      );
      expect(() => validatePathCharacters("safe\x1ffile.txt")).toThrowError(
        PolicyCanonicalizationError,
      );
    });

    it("rejects reserved Windows device names", () => {
      expect(() => validatePathCharacters("CON")).toThrowError(PolicyCanonicalizationError);
      expect(() => validatePathCharacters("PRN.txt")).toThrowError(PolicyCanonicalizationError);
      expect(() => validatePathCharacters("subdir/AUX/file.txt")).toThrowError(
        PolicyCanonicalizationError,
      );
      expect(() => validatePathCharacters("NUL")).toThrowError(PolicyCanonicalizationError);
      expect(() => validatePathCharacters("COM1")).toThrowError(PolicyCanonicalizationError);
      expect(() => validatePathCharacters("LPT2.dat")).toThrowError(PolicyCanonicalizationError);
    });

    it("rejects NTFS alternative data streams colons", () => {
      expect(() => validatePathCharacters("file.txt:stream")).toThrowError(
        PolicyCanonicalizationError,
      );
      expect(() => validatePathCharacters("data.json:$DATA")).toThrowError(
        PolicyCanonicalizationError,
      );
    });
  });

  describe("Platform-Specific Path Aliases (macOS / WSL)", () => {
    it("resolves macOS /private/var and /private/tmp aliases", () => {
      expect(resolvePlatformAliases("/private/var/folders/xyz")).toBe("/var/folders/xyz");
      expect(resolvePlatformAliases("/private/tmp/scratch")).toBe("/tmp/scratch");
      expect(resolvePlatformAliases("/private/etc/passwd")).toBe("/etc/passwd");
    });

    it("resolves WSL /mnt/c aliases to standard format", () => {
      expect(resolvePlatformAliases("/mnt/c/Users/project")).toBe("c:/Users/project");
      expect(resolvePlatformAliases("/mnt/d/data/workspace")).toBe("d:/data/workspace");
    });

    it("correctly identifies containment with platform aliases", () => {
      expect(isPathInsideRoot("/private/var/app/data.txt", "/var/app")).toBe(true);
      expect(isPathInsideRoot("/var/app/data.txt", "/private/var/app")).toBe(true);
      expect(isPathInsideRoot("/private/tmp/job/run.log", "/tmp/job")).toBe(true);
      expect(isPathInsideRoot("/mnt/c/project/file.ts", "c:/project")).toBe(true);
    });
  });
});
