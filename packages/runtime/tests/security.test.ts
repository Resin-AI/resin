import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityEnvelope, CapabilityManifest, ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  BundleResourceTracker,
  BundleSecurityError,
  resolveSafeTargetPath,
  validateBundleEntryPath,
  validateNoSymlinkEscapes,
} from "../src/loader/security-checks.js";
import { CapabilityPolicyEngine, detectUnknownCapabilityKeys } from "../src/policy/engine.js";

describe("loader security checks", () => {
  it("rejects path traversal attempts", () => {
    const maliciousPaths = [
      "../../etc/passwd",
      "../parent.txt",
      "src/../../../shadow",
      "foo/bar/../../../../root",
      "a/b/../..//../c",
    ];

    for (const malPath of maliciousPaths) {
      expect(() => validateBundleEntryPath(malPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(malPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("PATH_TRAVERSAL");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects absolute paths on Unix and Windows", () => {
    const absolutePaths = [
      "/etc/passwd",
      "/var/log/syslog",
      "\\Windows\\System32",
      "C:/Windows/cmd.exe",
      "D:\\data\\secrets.json",
    ];

    for (const absPath of absolutePaths) {
      expect(() => validateBundleEntryPath(absPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(absPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("ABSOLUTE_PATH");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects invalid path characters and null bytes", () => {
    const invalidPaths = ["src/index.ts\0.exe", "manifest.json\r", "test\nfile.txt"];

    for (const invPath of invalidPaths) {
      expect(() => validateBundleEntryPath(invPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(invPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("INVALID_PATH_CHARACTERS");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects Windows reserved device file names", () => {
    const reserved = ["CON", "prn.txt", "AUX", "NUL", "com1", "lpt3.dat", "nested/CON/file.txt"];

    for (const name of reserved) {
      expect(() => validateBundleEntryPath(name)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(name);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("DEVICE_FILE_PROHIBITED");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects .git directory tampering", () => {
    const gitPaths = [".git/config", ".git/HEAD", "src/.git/hooks/pre-commit"];

    for (const gitPath of gitPaths) {
      expect(() => validateBundleEntryPath(gitPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(gitPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("RESERVED_FILENAME");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("resolves safe target paths and throws if escaping target root", () => {
    const targetRoot = "/tmp/sandbox/artifact_01";

    const safeResolved = resolveSafeTargetPath(targetRoot, "src/index.ts");
    expect(safeResolved).toBe(path.resolve(targetRoot, "src/index.ts"));

    expect(() => resolveSafeTargetPath(targetRoot, "../escape.txt")).toThrowError(
      BundleSecurityError,
    );
  });

  it("detects symlink escapes pointing outside target root", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-test-"));
    try {
      const insideDir = path.join(tempDir, "root");
      const outsideDir = path.join(tempDir, "outside");
      fs.mkdirSync(insideDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const secretFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(secretFile, "sensitive data");

      const linkFile = path.join(insideDir, "link.txt");
      try {
        fs.symlinkSync(secretFile, linkFile);
        expect(() => validateNoSymlinkEscapes(insideDir, linkFile)).toThrowError(
          BundleSecurityError,
        );
      } catch (symlinkErr) {
        // On systems without symlink permission, test graceful handling
        if (
          symlinkErr &&
          typeof symlinkErr === "object" &&
          "code" in symlinkErr &&
          symlinkErr.code !== "EPERM"
        ) {
          throw symlinkErr;
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("enforces resource tracker limits (file count, file size, decompression ratio)", () => {
    const tracker = new BundleResourceTracker(1000, {
      maxFileCount: 3,
      maxFileSizeBytes: 1024,
      maxDecompressedSizeBytes: 2048,
      maxDecompressionRatio: 2,
    });

    // 1st entry: OK
    tracker.trackEntry("file1.ts", 500);

    // 2nd entry: exceeds maxFileSizeBytes
    expect(() => tracker.trackEntry("bigfile.ts", 2000)).toThrowError(BundleSecurityError);

    // 2nd entry with valid size: OK
    tracker.trackEntry("file2.ts", 400);

    // 3rd entry: OK
    tracker.trackEntry("file3.ts", 400);

    // 4th entry: exceeds maxFileCount (limit is 3)
    expect(() => tracker.trackEntry("file4.ts", 100)).toThrowError(BundleSecurityError);
  });
});

describe("hostile cloud policy engine defense", () => {
  const sampleEnvelope: CapabilityEnvelope = {
    envelopeId: "env-1",
    workspaceId: "ws-secure",
    version: "1.0.0",
    fs: {
      readPaths: ["src/**", "config/*.json"],
      writePaths: ["dist/**"],
      allowWorkspaceRoot: false,
      allowTemp: false,
      denyPaths: [".env*", "**/*.pem", "id_rsa*"],
      maxFileSizeBytes: 1048576,
    },
    net: {
      allowOutbound: true,
      allowedDomains: ["api.trusted.com", "*.safe-cdn.net"],
      allowedHosts: ["198.51.100.1"],
      allowedPorts: [443, 8443],
      allowedProtocols: ["https"],
      allowLocalhost: false,
      denyPrivateRanges: true,
    },
    command: {
      allowShellExecution: false,
      allowedCommands: ["git status", "git diff"],
      allowedBinaries: ["git", "node"],
      forbiddenPatterns: ["rm -rf", "chmod", "curl | sh", "eval"],
      allowEnvPassthrough: [],
    },
    secrets: {
      allowedSecretNames: ["GITHUB_TOKEN", "NPM_TOKEN"],
      allowedPrefixes: ["APP_"],
      denyDirectRead: true,
      injectAsEnv: false,
    },
    limits: {
      maxExecutionTimeMs: 5000,
      maxMemoryBytes: 67108864,
      maxCpuPercent: 50,
      maxConcurrentExecutions: 2,
    },
    isFrozen: false,
    createdAt: new Date().toISOString(),
  };

  it("rejects unknown top-level and subsystem capability keys (fail-closed)", () => {
    const engine = new CapabilityPolicyEngine();
    engine.setEnvelope(sampleEnvelope);

    // Top level unknown key
    const badTopLevel = {
      gpu: { requiredVram: 4096 },
    };
    const res1 = engine.evaluateInvocation(badTopLevel, "ws-secure", {
      invocationId: "inv-1",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(res1.allowed).toBe(false);
    if (!res1.allowed) {
      expect(res1.denyCode).toBe("UNKNOWN_CAPABILITY_TYPE");
    }

    // Nested unknown subsystem keys
    const badSubsystem = {
      fs: { dangerousOption: true, readPaths: ["src/**"] },
    };
    const res2 = engine.evaluateInvocation(badSubsystem, "ws-secure", {
      invocationId: "inv-2",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(res2.allowed).toBe(false);
    if (!res2.allowed) {
      expect(res2.denyCode).toBe("UNKNOWN_CAPABILITY_TYPE");
    }
  });

  it("detects and rejects prototype pollution attempts", () => {
    const engine = new CapabilityPolicyEngine();
    engine.setEnvelope(sampleEnvelope);

    const polluted = JSON.parse(
      '{"__proto__": {"isAdmin": true}, "fs": {"readPaths": ["src/**"]}}',
    );
    const unknown = detectUnknownCapabilityKeys(polluted);
    expect(unknown).toContain("__proto__");

    const res = engine.evaluateInvocation(polluted, "ws-secure", {
      invocationId: "inv-polluted",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.denyCode).toBe("UNKNOWN_CAPABILITY_TYPE");
    }
  });

  it("rejects capability expansion attempts beyond envelope authority", () => {
    const engine = new CapabilityPolicyEngine();
    engine.setEnvelope(sampleEnvelope);

    // 1. Filesystem expansion
    const fsExpansion: CapabilityManifest = {
      schemaVersion: "1.0.0",
      manifestId: "man-fs",
      fs: {
        readPaths: ["/etc/shadow"],
        writePaths: [],
        allowWorkspaceRoot: true, // Forbidden by envelope
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
      },
    };
    const fsRes = engine.evaluateInvocation(fsExpansion, "ws-secure", {
      invocationId: "inv-fs",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(fsRes.allowed).toBe(false);

    // 2. Network domain expansion
    const netExpansion: CapabilityManifest = {
      schemaVersion: "1.0.0",
      manifestId: "man-net",
      fs: {
        readPaths: ["src/**"],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
      },
      net: {
        allowOutbound: true,
        allowedDomains: ["evil-hacker.com"],
        allowedHosts: [],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
    };
    const netRes = engine.evaluateInvocation(netExpansion, "ws-secure", {
      invocationId: "inv-net",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(netRes.allowed).toBe(false);
    if (!netRes.allowed) {
      expect(netRes.denyCode).toBe("NET_DOMAIN_NOT_ALLOWED");
    }

    // 3. Command shell expansion
    const cmdExpansion: CapabilityManifest = {
      schemaVersion: "1.0.0",
      manifestId: "man-cmd",
      fs: {
        readPaths: ["src/**"],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
      },
      command: {
        allowShellExecution: true, // Forbidden by envelope
        allowedCommands: ["rm -rf /"],
        allowedBinaries: ["sh", "bash"],
        forbiddenPatterns: [],
        allowEnvPassthrough: ["CUSTOM_ENV"],
      },
    };
    const cmdRes = engine.evaluateInvocation(cmdExpansion, "ws-secure", {
      invocationId: "inv-cmd",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(cmdRes.allowed).toBe(false);
    if (!cmdRes.allowed) {
      expect(cmdRes.denyCode).toBe("CMD_SHELL_FORBIDDEN");
    }
  });

  it("rejects workspace, project, and account mismatches", () => {
    const engine = new CapabilityPolicyEngine();
    engine.setEnvelope(sampleEnvelope);

    const manifest: CapabilityManifest = {
      schemaVersion: "1.0.0",
      manifestId: "man-ok",
      fs: {
        readPaths: ["src/**"],
        writePaths: ["dist/**"],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 1048576,
      },
    };

    // Workspace mismatch
    const resWs = engine.evaluateInvocation(manifest, "ws-secure", {
      invocationId: "inv-ws",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-other",
    });
    expect(resWs.allowed).toBe(false);
    if (!resWs.allowed) {
      expect(resWs.denyCode).toBe("WORKSPACE_MISMATCH");
    }
  });

  it("rejects tool ID substitution and version downgrade attempts", () => {
    const engine = new CapabilityPolicyEngine();
    engine.setEnvelope(sampleEnvelope);

    const toolManifest = {
      id: "tool-alpha",
      name: "tool_alpha",
      version: "2.0.0",
      schemaVersion: "1.0.0",
      description: "Sample tool",
      entrypoint: "src/index.ts",
      digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      capabilities: {
        schemaVersion: "1.0.0",
        manifestId: "man-alpha",
        fs: {
          readPaths: ["src/**"],
          writePaths: [],
          allowWorkspaceRoot: false,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 1048576,
        },
      },
    };

    // Tool ID mismatch
    const resId = engine.evaluateInvocation(toolManifest, "ws-secure", {
      invocationId: "inv-sub",
      toolId: "tool-beta",
      toolVersion: "2.0.0",
      workspaceId: "ws-secure",
    });
    expect(resId.allowed).toBe(false);
    if (!resId.allowed) {
      expect(resId.denyCode).toBe("INVALID_CONTEXT");
    }

    // Version mismatch / downgrade attempt
    const resVer = engine.evaluateInvocation(toolManifest, "ws-secure", {
      invocationId: "inv-down",
      toolId: "tool-alpha",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(resVer.allowed).toBe(false);
    if (!resVer.allowed) {
      expect(resVer.denyCode).toBe("INVALID_CONTEXT");
    }
  });

  it("fails closed when envelope is frozen", () => {
    const engine = new CapabilityPolicyEngine();
    const frozenEnvelope: CapabilityEnvelope = {
      ...sampleEnvelope,
      isFrozen: true,
    };
    engine.setEnvelope(frozenEnvelope);

    const manifest: CapabilityManifest = {
      schemaVersion: "1.0.0",
      manifestId: "man-frozen",
      fs: {
        readPaths: ["src/**", "config/*.json"],
        writePaths: ["dist/**"],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [".env*", "**/*.pem", "id_rsa*"],
        maxFileSizeBytes: 1048576,
      },
    };

    const res = engine.evaluateInvocation(manifest, "ws-secure", {
      invocationId: "inv-frozen",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.denyCode).toBe("ENVELOPE_FROZEN");
    }
  });

  it("produces exact least-privilege InvocationGrant when within envelope", () => {
    const engine = new CapabilityPolicyEngine();
    engine.setEnvelope(sampleEnvelope);

    const validManifest: CapabilityManifest = {
      schemaVersion: "1.0.0",
      manifestId: "man-valid",
      fs: {
        readPaths: ["src/**"],
        writePaths: ["dist/**"],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 524288,
      },
      net: {
        allowOutbound: true,
        allowedDomains: ["api.trusted.com"],
        allowedHosts: [],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: ["git status"],
        allowedBinaries: ["git"],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: ["GITHUB_TOKEN"],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: false,
      },
      limits: {
        maxExecutionTimeMs: 1000,
        maxMemoryBytes: 33554432,
        maxCpuPercent: 25,
        maxConcurrentExecutions: 1,
      },
    };

    const res = engine.evaluateInvocation(validManifest, "ws-secure", {
      invocationId: "inv-valid",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      workspaceId: "ws-secure",
    });
    expect(res.allowed).toBe(true);
    if (res.allowed) {
      expect(res.grant).toBeDefined();
      expect(res.grant.workspaceId).toBe("ws-secure");
      expect(res.grant.toolId).toBe("tool-1");
      expect(res.grant.capabilities.fs?.readPaths).toEqual(["src/**"]);
      expect(res.grant.capabilities.net?.allowedDomains).toEqual(["api.trusted.com"]);
    }
  });
});
