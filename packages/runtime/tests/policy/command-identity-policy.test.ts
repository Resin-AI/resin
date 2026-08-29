import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityEnvelope, CapabilityManifest } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PolicyCanonicalizationError,
  canonicalizeCommand,
  canonicalizeCommandCapability,
  containsForbiddenArgMetacharacters,
  containsShellMetacharacters,
  intersectCapabilities,
  isDangerousEnvVar,
  isDangerousOption,
  isInterpreterEscapeArg,
  isPathInsideRoot,
  isResponseFileEscape,
  isShellExecutable,
  resolveCanonicalBinary,
  verifyExecutableIdentity,
} from "../../src/policy/index.js";

describe("Command Identity Policy & Verification", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd_identity_test_"));
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("canonicalizeCommand validation", () => {
    it("canonicalizes valid command and binary names", () => {
      expect(canonicalizeCommand("git")).toBe("git");
      expect(canonicalizeCommand("/usr/bin/git")).toBe("/usr/bin/git");
      expect(canonicalizeCommand("  node  ")).toBe("node");
    });

    it("rejects empty or whitespace command names", () => {
      expect(() => canonicalizeCommand("")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("   ")).toThrow(PolicyCanonicalizationError);
    });

    it("rejects path traversal in command names", () => {
      expect(() => canonicalizeCommand("../git")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("bin/../../etc/passwd")).toThrow(
        PolicyCanonicalizationError,
      );
    });

    it("rejects shell metacharacters in command names", () => {
      expect(() => canonicalizeCommand("git; rm -rf /")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("git && whoami")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("node | cat")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("echo `id`")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("echo $(id)")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("git\nmalicious")).toThrow(PolicyCanonicalizationError);
      expect(() => canonicalizeCommand("git\0null")).toThrow(PolicyCanonicalizationError);
    });
  });

  describe("resolveCanonicalBinary & immutable identity evidence", () => {
    it("resolves node to process.execPath with full identity metadata", () => {
      const identity = resolveCanonicalBinary("node", { computeDigest: true });

      expect(identity.canonicalPath).toBe(process.execPath);
      expect(identity.realPath).toBe(fs.realpathSync(process.execPath));
      expect(identity.inode).toBeDefined();
      expect(identity.device).toBeDefined();
      expect(identity.size).toBeGreaterThan(0);
      expect(identity.mtimeMs).toBeGreaterThan(0);
      expect(identity.sha256).toBeDefined();
      expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it("resolves canonical absolute path through symlinks", () => {
      const realTarget = path.join(tempDir, "real_binary");
      fs.writeFileSync(realTarget, "#!/bin/sh\necho real", { mode: 0o755 });

      const symlinkPath = path.join(tempDir, "symlink_binary");
      fs.symlinkSync(realTarget, symlinkPath);

      const identity = resolveCanonicalBinary(symlinkPath, { computeDigest: true });
      expect(identity.canonicalPath).toBe(path.resolve(symlinkPath));
      expect(identity.realPath).toBe(fs.realpathSync(realTarget));
      expect(identity.sha256).toBeDefined();
    });

    it("rejects non-existent binary when allowNonExistent is false", () => {
      expect(() =>
        resolveCanonicalBinary("/non/existent/path/to/binary_12345", {
          allowNonExistent: false,
        }),
      ).toThrow(PolicyCanonicalizationError);
    });

    it("provides deterministic fallback when allowNonExistent is true", () => {
      const identity = resolveCanonicalBinary("some_future_tool", {
        allowNonExistent: true,
      });
      expect(identity.canonicalPath).toBe("/usr/bin/some_future_tool");
      expect(identity.realPath).toBe("/usr/bin/some_future_tool");
    });
  });

  describe("verifyExecutableIdentity pre-spawn re-resolution", () => {
    it("verifies unchanged binary successfully", () => {
      const binPath = path.join(tempDir, "stable_bin");
      fs.writeFileSync(binPath, "#!/bin/sh\necho stable", { mode: 0o755 });

      const identity = resolveCanonicalBinary(binPath, { computeDigest: true });
      const verification = verifyExecutableIdentity(identity);

      expect(verification.valid).toBe(true);
      expect(verification.reason).toBeUndefined();
    });

    it("detects symlink swap attack before execution", () => {
      const originalTarget = path.join(tempDir, "legit_target");
      fs.writeFileSync(originalTarget, "#!/bin/sh\necho legit", { mode: 0o755 });

      const maliciousTarget = path.join(tempDir, "evil_target");
      fs.writeFileSync(maliciousTarget, "#!/bin/sh\necho evil", { mode: 0o755 });

      const symlink = path.join(tempDir, "dynamic_symlink");
      fs.symlinkSync(originalTarget, symlink);

      // 1. Capture initial identity
      const identity = resolveCanonicalBinary(symlink, { computeDigest: true });

      // 2. Adversary swaps symlink underneath
      fs.unlinkSync(symlink);
      fs.symlinkSync(maliciousTarget, symlink);

      // 3. Pre-spawn verification detects swap
      const verification = verifyExecutableIdentity(identity);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("Executable realpath mismatch");
    });

    it("detects file replacement / inode change attack", () => {
      const targetFile = path.join(tempDir, "replaceable_bin");
      fs.writeFileSync(targetFile, "#!/bin/sh\necho original", { mode: 0o755 });

      const identity = resolveCanonicalBinary(targetFile, { computeDigest: true });

      // Adversary removes file and replaces with new file at same path
      fs.unlinkSync(targetFile);
      fs.writeFileSync(targetFile, "#!/bin/sh\necho hijacked", { mode: 0o755 });

      const verification = verifyExecutableIdentity(identity);
      // Either inode or SHA256 digest detects the modification
      expect(verification.valid).toBe(false);
      expect(verification.reason).toBeDefined();
    });

    it("detects binary content tampering via SHA256 digest", () => {
      const targetFile = path.join(tempDir, "tampered_bin");
      fs.writeFileSync(targetFile, "#!/bin/sh\necho original", { mode: 0o755 });

      const identity = resolveCanonicalBinary(targetFile, { computeDigest: true });

      // In-place append without changing inode
      fs.appendFileSync(targetFile, "\necho backdoor");

      const verification = verifyExecutableIdentity(identity);
      expect(verification.valid).toBe(false);
    });

    it("fails verification if binary was deleted", () => {
      const targetFile = path.join(tempDir, "deleted_bin");
      fs.writeFileSync(targetFile, "#!/bin/sh\necho temp", { mode: 0o755 });

      const identity = resolveCanonicalBinary(targetFile);
      fs.unlinkSync(targetFile);

      const verification = verifyExecutableIdentity(identity);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("does not exist");
    });
  });

  describe("Security checkers: metacharacters, interpreter escapes, and dangerous env", () => {
    it("identifies interpreter escape flags for node, python, ruby, and shells", () => {
      expect(isInterpreterEscapeArg("node", "-e")).toBe(true);
      expect(isInterpreterEscapeArg("node", "--eval")).toBe(true);
      expect(isInterpreterEscapeArg("node", "-p")).toBe(true);
      expect(isInterpreterEscapeArg("node", "--inspect")).toBe(true);
      expect(isInterpreterEscapeArg("python3", "-c")).toBe(true);
      expect(isInterpreterEscapeArg("python3", "-m")).toBe(true);
      expect(isInterpreterEscapeArg("ruby", "-e")).toBe(true);
      expect(isInterpreterEscapeArg("sh", "-c")).toBe(true);
      expect(isInterpreterEscapeArg("powershell", "-Command")).toBe(true);

      // Safe script files
      expect(isInterpreterEscapeArg("node", "index.js")).toBe(false);
      expect(isInterpreterEscapeArg("python3", "script.py")).toBe(false);
      expect(isInterpreterEscapeArg("git", "status")).toBe(false);
    });

    it("detects dangerous git command options", () => {
      expect(isDangerousOption("git", "--upload-pack=/tmp/evil")).toBe(true);
      expect(isDangerousOption("git", "-c core.fsmonitor=touch /tmp/pwned")).toBe(true);
      expect(isDangerousOption("git", "-c protocol.ext.allow=always")).toBe(true);
      expect(isDangerousOption("git", "--exec=evil")).toBe(true);

      expect(isDangerousOption("git", "status")).toBe(false);
      expect(isDangerousOption("git", "diff")).toBe(false);
    });

    it("detects response file boundary escapes", () => {
      expect(isResponseFileEscape("@/etc/shadow", tempDir)).toBe(true);
      expect(isResponseFileEscape("@../../outside.txt", tempDir)).toBe(true);
      expect(isResponseFileEscape("@subfolder/response.txt", tempDir)).toBe(false);
      expect(isResponseFileEscape("normal_argument", tempDir)).toBe(false);
    });

    it("detects dangerous environment variables and prefixes", () => {
      expect(isDangerousEnvVar("LD_PRELOAD")).toBe(true);
      expect(isDangerousEnvVar("LD_LIBRARY_PATH")).toBe(true);
      expect(isDangerousEnvVar("DYLD_INSERT_LIBRARIES")).toBe(true);
      expect(isDangerousEnvVar("NODE_OPTIONS")).toBe(true);
      expect(isDangerousEnvVar("PYTHONPATH")).toBe(true);
      expect(isDangerousEnvVar("PYTHONHOME")).toBe(true);
      expect(isDangerousEnvVar("BASH_ENV")).toBe(true);
      expect(isDangerousEnvVar("GLIBC_TUNABLES")).toBe(true);
      expect(isDangerousEnvVar("IFS")).toBe(true);

      // Safe variables
      expect(isDangerousEnvVar("NODE_ENV")).toBe(false);
      expect(isDangerousEnvVar("PORT")).toBe(false);
      expect(isDangerousEnvVar("LOG_LEVEL")).toBe(false);
    });

    it("detects forbidden argument metacharacters", () => {
      expect(containsForbiddenArgMetacharacters("arg;whoami")).toBe(true);
      expect(containsForbiddenArgMetacharacters("arg|cat")).toBe(true);
      expect(containsForbiddenArgMetacharacters("`whoami`")).toBe(true);
      expect(containsForbiddenArgMetacharacters("$(id)")).toBe(true);
      expect(containsForbiddenArgMetacharacters("line1\nline2")).toBe(true);
      expect(containsForbiddenArgMetacharacters("null\0byte")).toBe(true);

      expect(containsForbiddenArgMetacharacters("--config=production.json")).toBe(false);
      expect(containsForbiddenArgMetacharacters("valid-file-name.ts")).toBe(false);
    });
  });

  describe("Capability Intersection for Command Identities", () => {
    it("rejects command expansion when binary is not in envelope", () => {
      const envelope: CapabilityEnvelope = {
        envelopeId: "env_1",
        workspaceId: "ws_1",
        version: "1.0.0",
        command: {
          allowShellExecution: false,
          allowedBinaries: ["/usr/bin/git"],
          allowedCommands: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: ["PATH"],
        },
        createdAt: new Date().toISOString(),
      };

      const requested: CapabilityManifest = {
        command: {
          allowShellExecution: false,
          allowedBinaries: ["/tmp/malicious/git"],
          allowedCommands: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: ["PATH"],
        },
      };

      const result = intersectCapabilities(requested, envelope);
      expect(result.expansionAttempted).toBe(true);
      expect(result.violations.some((v) => v.code === "CMD_BINARY_EXPANSION")).toBe(true);
    });

    it("rejects shell execution expansion when envelope forbids it", () => {
      const envelope: CapabilityEnvelope = {
        envelopeId: "env_1",
        workspaceId: "ws_1",
        version: "1.0.0",
        command: {
          allowShellExecution: false,
          allowedBinaries: ["node"],
        },
        createdAt: new Date().toISOString(),
      };

      const requested: CapabilityManifest = {
        command: {
          allowShellExecution: true,
          allowedBinaries: ["node"],
        },
      };

      const result = intersectCapabilities(requested, envelope);
      expect(result.expansionAttempted).toBe(true);
      expect(result.violations.some((v) => v.code === "CMD_SHELL_FORBIDDEN")).toBe(true);
    });
    it("filters out dangerous environment variables during intersection", () => {
      const envelope: CapabilityEnvelope = {
        envelopeId: "env_1",
        workspaceId: "ws_1",
        version: "1.0.0",
        command: {
          allowEnvPassthrough: ["NODE_ENV", "LD_PRELOAD"],
        },
        createdAt: new Date().toISOString(),
      };

      const requested: CapabilityManifest = {
        command: {
          allowEnvPassthrough: ["NODE_ENV", "LD_PRELOAD"],
        },
      };

      const result = intersectCapabilities(requested, envelope);
      expect(result.violations.some((v) => v.code === "CMD_ENV_EXPANSION")).toBe(true);
      expect(result.grantCapabilities.command?.allowEnvPassthrough).not.toContain("LD_PRELOAD");
    });
  });
});
