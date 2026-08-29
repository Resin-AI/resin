import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PolicyCanonicalizationError,
  canonicalizeCommand,
  canonicalizeCommandCapability,
  canonicalizeEnvName,
  canonicalizeFsCapability,
  canonicalizeHost,
  canonicalizeNetCapability,
  canonicalizePath,
  canonicalizePort,
  canonicalizeScheme,
  canonicalizeSecretCapability,
  canonicalizeSecretName,
  canonicalizeSecretPrefix,
  containsShellMetacharacters,
  isDangerousEnvVar,
  isPathInsideRoot,
  isPathPermitted,
  isPrivateOrReservedIp,
  isSecretAllowed,
  isShellExecutable,
  matchesArgPattern,
  matchesHostPattern,
  matchesPathPattern,
  validateWorkingDir,
} from "../../src/policy/canonicalizers.js";

const testWorkspace = path.resolve("/tmp/resin-test-ws");

describe("Filesystem Canonicalizer", () => {
  it("canonicalizes paths inside the workspace root", () => {
    const result = canonicalizePath("src/index.ts", testWorkspace);
    expect(result).toBe(`${testWorkspace}/src/index.ts`.replace(/\\/g, "/"));
  });

  it("normalizes unicode to NFC", () => {
    // Decomposed e + acute accent vs composed e-acute
    const decomposed = "src/cafe\u0301.ts";
    const composed = "src/caf\u00e9.ts";
    const result1 = canonicalizePath(decomposed, testWorkspace);
    const result2 = canonicalizePath(composed, testWorkspace);
    expect(result1).toBe(result2);
  });

  it("expands <WORKSPACE_ROOT> placeholder", () => {
    const result = canonicalizePath("<WORKSPACE_ROOT>/data/file.json", testWorkspace);
    expect(result).toBe(`${testWorkspace}/data/file.json`.replace(/\\/g, "/"));
  });

  it("rejects path traversal attempting to escape workspace root", () => {
    expect(() => {
      canonicalizePath("../../etc/passwd", testWorkspace);
    }).toThrow(PolicyCanonicalizationError);

    expect(() => {
      canonicalizePath("src/../../..", testWorkspace);
    }).toThrow(PolicyCanonicalizationError);
  });

  it("rejects null bytes and control characters", () => {
    expect(() => {
      canonicalizePath("src/index.ts\0.js", testWorkspace);
    }).toThrow(PolicyCanonicalizationError);

    expect(() => {
      canonicalizePath("src/\x01bad.ts", testWorkspace);
    }).toThrow(PolicyCanonicalizationError);
  });

  it("rejects encoded traversal sequences", () => {
    expect(() => {
      canonicalizePath("src/%2e%2e/secret", testWorkspace);
    }).toThrow(PolicyCanonicalizationError);

    expect(() => {
      canonicalizePath("src/..%2fsecret", testWorkspace);
    }).toThrow(PolicyCanonicalizationError);
  });

  it("allows temp directory when allowTemp is enabled", () => {
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, "scratch/file.tmp");
    const result = canonicalizePath(tempFilePath, testWorkspace, {
      allowTemp: true,
      tempDir,
    });
    expect(result).toBe(tempFilePath.replace(/\\/g, "/"));
  });

  it("denies temp directory when allowTemp is disabled", () => {
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, "scratch/file.tmp");
    expect(() => {
      canonicalizePath(tempFilePath, testWorkspace, { allowTemp: false });
    }).toThrow(PolicyCanonicalizationError);
  });

  it("matches glob path patterns accurately", () => {
    expect(matchesPathPattern("src/utils/math.ts", "src/**/*.ts", testWorkspace)).toBe(true);
    expect(matchesPathPattern("src/index.js", "src/**/*.ts", testWorkspace)).toBe(false);
    expect(matchesPathPattern("dist/bundle.js", "<WORKSPACE_ROOT>/dist/**", testWorkspace)).toBe(
      true,
    );
    expect(matchesPathPattern("secret.env", ".env*", testWorkspace)).toBe(false);
    expect(matchesPathPattern(".env.local", ".env*", testWorkspace)).toBe(true);
  });

  it("enforces deny paths with strict priority", () => {
    const allowed = ["src/**", "dist/**"];
    const denied = ["src/secrets/**", "**/.env*"];

    expect(isPathPermitted("src/index.ts", allowed, denied, testWorkspace)).toBe(true);
    expect(isPathPermitted("src/secrets/key.pem", allowed, denied, testWorkspace)).toBe(false);
    expect(isPathPermitted(".env", allowed, denied, testWorkspace)).toBe(false);
  });

  it("canonicalizes full FsCapability object deterministically", () => {
    const cap = canonicalizeFsCapability(
      {
        readPaths: ["src/b.ts", "src/a.ts", "src/b.ts"],
        writePaths: ["dist/output.js"],
        allowWorkspaceRoot: true,
        allowTemp: false,
        denyPaths: [".git/**"],
        maxFileSizeBytes: 5242880,
      },
      testWorkspace,
    );

    expect(cap.readPaths).toHaveLength(2);
    expect(cap.readPaths[0]).toContain("src/a.ts");
    expect(cap.readPaths[1]).toContain("src/b.ts");
    expect(cap.denyPaths).toHaveLength(1);
    expect(cap.maxFileSizeBytes).toBe(5242880);
  });
});

describe("Network Canonicalizer", () => {
  it("canonicalizes hostnames: lowercases and trims trailing dots", () => {
    expect(canonicalizeHost("API.GitHub.com.")).toBe("api.github.com");
    expect(canonicalizeHost("https://Registry.NPMJS.org/foo")).toBe("registry.npmjs.org");
    expect(canonicalizeHost("*.AWS.Amazon.com")).toBe("*.aws.amazon.com");
  });

  it("validates and canonicalizes schemes/protocols", () => {
    expect(canonicalizeScheme("HTTPS://")).toBe("https");
    expect(canonicalizeScheme("http:")).toBe("http");
    expect(canonicalizeScheme("wss")).toBe("wss");
    expect(() => canonicalizeScheme("ftp")).toThrow(PolicyCanonicalizationError);
    expect(() => canonicalizeScheme("file")).toThrow(PolicyCanonicalizationError);
  });

  it("canonicalizes ports and defaults", () => {
    expect(canonicalizePort(443, "https")).toBe(443);
    expect(canonicalizePort("8080")).toBe(8080);
    expect(canonicalizePort(undefined, "https")).toBe(443);
    expect(canonicalizePort(undefined, "http")).toBe(80);
    expect(() => canonicalizePort(70000)).toThrow(PolicyCanonicalizationError);
    expect(() => canonicalizePort(-1)).toThrow(PolicyCanonicalizationError);
  });

  it("matches wildcard host patterns", () => {
    expect(matchesHostPattern("api.github.com", "*.github.com")).toBe(true);
    expect(matchesHostPattern("raw.githubusercontent.com", "*.githubusercontent.com")).toBe(true);
    expect(matchesHostPattern("github.com", "*.github.com")).toBe(true);
    expect(matchesHostPattern("evil-github.com", "*.github.com")).toBe(false);
    expect(matchesHostPattern("google.com", "*.github.com")).toBe(false);
  });

  describe("Private and Reserved IP Blocking", () => {
    it("identifies localhost hostnames as private", () => {
      expect(isPrivateOrReservedIp("localhost")).toBe(true);
      expect(isPrivateOrReservedIp("app.localhost")).toBe(true);
      expect(isPrivateOrReservedIp("service.local")).toBe(true);
    });

    it("identifies IPv4 loopback and private ranges as private", () => {
      expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("127.10.20.30")).toBe(true);
      expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("10.255.255.255")).toBe(true);
      expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
      expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
      expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true); // AWS/Cloud metadata service
      expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true); // CGNAT
      expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
      expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true); // Multicast
      expect(isPrivateOrReservedIp("240.0.0.1")).toBe(true); // Reserved
    });

    it("identifies decimal, hex, and octal bypass representations as private", () => {
      expect(isPrivateOrReservedIp("2130706433")).toBe(true); // 127.0.0.1 as integer
      expect(isPrivateOrReservedIp("0x7f000001")).toBe(true); // 127.0.0.1 as hex
      expect(isPrivateOrReservedIp("0177.0.0.1")).toBe(true); // 127.0.0.1 with octal
    });

    it("identifies IPv6 loopback, link-local, and unique local addresses as private", () => {
      expect(isPrivateOrReservedIp("::1")).toBe(true);
      expect(isPrivateOrReservedIp("::")).toBe(true);
      expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
      expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
      expect(isPrivateOrReservedIp("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("::ffff:10.0.0.1")).toBe(true);
    });

    it("identifies public IP addresses as non-private", () => {
      expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
      expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
      expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
      expect(isPrivateOrReservedIp("172.32.0.1")).toBe(false); // Outside 172.16-172.31
      expect(isPrivateOrReservedIp("api.github.com")).toBe(false);
    });
  });

  it("canonicalizes full NetCapability deterministically", () => {
    const netCap = canonicalizeNetCapability({
      allowOutbound: true,
      allowedDomains: ["api.github.com", "API.GITHUB.COM", "registry.npmjs.org"],
      allowedPorts: [443, 80, 443],
      allowedProtocols: ["https", "http"],
      allowLocalhost: false,
      denyPrivateRanges: true,
    });

    expect(netCap.allowedDomains).toEqual(["api.github.com", "registry.npmjs.org"]);
    expect(netCap.allowedPorts).toEqual([80, 443]);
    expect(netCap.allowedProtocols).toEqual(["http", "https"]);
  });
});

describe("Command Canonicalizer", () => {
  it("canonicalizes valid command names", () => {
    expect(canonicalizeCommand("git")).toBe("git");
    expect(canonicalizeCommand("/usr/bin/git")).toBe("/usr/bin/git");
  });

  it("identifies shell executables", () => {
    expect(isShellExecutable("sh")).toBe(true);
    expect(isShellExecutable("bash")).toBe(true);
    expect(isShellExecutable("/bin/bash")).toBe(true);
    expect(isShellExecutable("zsh")).toBe(true);
    expect(isShellExecutable("cmd.exe")).toBe(true);
    expect(isShellExecutable("powershell.exe")).toBe(true);
    expect(isShellExecutable("pwsh")).toBe(true);

    expect(isShellExecutable("git")).toBe(false);
    expect(isShellExecutable("node")).toBe(false);
    expect(isShellExecutable("python3")).toBe(false);
  });

  it("detects dangerous shell metacharacters", () => {
    expect(containsShellMetacharacters("git clone foo; rm -rf /")).toBe(true);
    expect(containsShellMetacharacters("git && whoami")).toBe(true);
    expect(containsShellMetacharacters("cat file | grep secret")).toBe(true);
    expect(containsShellMetacharacters("echo `whoami`")).toBe(true);
    expect(containsShellMetacharacters("echo $(whoami)")).toBe(true);
    expect(containsShellMetacharacters("git > /tmp/out")).toBe(true);
    expect(containsShellMetacharacters("git\nmalicious")).toBe(true);

    expect(containsShellMetacharacters("git status")).toBe(false);
    expect(containsShellMetacharacters("npm run build")).toBe(false);
  });

  it("identifies dangerous environment variables", () => {
    expect(isDangerousEnvVar("LD_PRELOAD")).toBe(true);
    expect(isDangerousEnvVar("NODE_OPTIONS")).toBe(true);
    expect(isDangerousEnvVar("PYTHONPATH")).toBe(true);
    expect(isDangerousEnvVar("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isDangerousEnvVar("BASH_ENV")).toBe(true);

    expect(isDangerousEnvVar("NODE_ENV")).toBe(false);
    expect(isDangerousEnvVar("PORT")).toBe(false);
    expect(isDangerousEnvVar("RUST_LOG")).toBe(false);
  });

  it("validates environment variable names", () => {
    expect(canonicalizeEnvName("NODE_ENV")).toBe("NODE_ENV");
    expect(canonicalizeEnvName("API_KEY_123")).toBe("API_KEY_123");
    expect(() => canonicalizeEnvName("BAD-NAME")).toThrow(PolicyCanonicalizationError);
    expect(() => canonicalizeEnvName("123_VAR")).toThrow(PolicyCanonicalizationError);
  });

  it("validates working directories against workspace root", () => {
    expect(() => {
      validateWorkingDir("src", testWorkspace);
    }).not.toThrow();

    expect(() => {
      validateWorkingDir("../../outside", testWorkspace);
    }).toThrow(PolicyCanonicalizationError);
  });

  it("matches argument patterns (regex and wildcard)", () => {
    expect(matchesArgPattern("--filter=test", "--filter=*")).toBe(true);
    expect(matchesArgPattern("--verbose", "^--[a-z]+$")).toBe(true);
    expect(matchesArgPattern("invalid!", "^--[a-z]+$")).toBe(false);
  });

  it("canonicalizes full CommandCapability deterministically", () => {
    const cmdCap = canonicalizeCommandCapability({
      allowShellExecution: false,
      allowedCommands: ["git", "node", "git"],
      allowedBinaries: ["/usr/bin/git"],
      forbiddenPatterns: ["rm -rf", "sudo"],
      allowEnvPassthrough: ["NODE_ENV", "PORT", "LD_PRELOAD"], // LD_PRELOAD should be filtered out
    });

    expect(cmdCap.allowedCommands).toEqual(["git", "node"]);
    expect(cmdCap.allowEnvPassthrough).toEqual(["NODE_ENV", "PORT"]);
  });
});

describe("Secret Canonicalizer", () => {
  it("canonicalizes and validates secret names and prefixes", () => {
    expect(canonicalizeSecretName("GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
    expect(canonicalizeSecretName("OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
    expect(canonicalizeSecretPrefix("AWS_")).toBe("AWS_");

    expect(() => canonicalizeSecretName("")).toThrow(PolicyCanonicalizationError);
    expect(() => canonicalizeSecretName("BAD TOKEN")).toThrow(PolicyCanonicalizationError);
    expect(() => canonicalizeSecretPrefix("")).toThrow(PolicyCanonicalizationError);
  });

  it("checks secret authorization via names and prefixes", () => {
    const allowedNames = ["STRIPE_KEY", "DATABASE_URL"];
    const allowedPrefixes = ["GITHUB_", "AWS_"];

    expect(isSecretAllowed("STRIPE_KEY", allowedNames, allowedPrefixes)).toBe(true);
    expect(isSecretAllowed("GITHUB_TOKEN", allowedNames, allowedPrefixes)).toBe(true);
    expect(isSecretAllowed("AWS_SECRET_KEY", allowedNames, allowedPrefixes)).toBe(true);
    expect(isSecretAllowed("PRIVATE_KEY", allowedNames, allowedPrefixes)).toBe(false);
  });

  it("canonicalizes full SecretCapability deterministically", () => {
    const secCap = canonicalizeSecretCapability({
      allowedSecretNames: ["SECRET_B", "SECRET_A", "SECRET_B"],
      allowedPrefixes: ["APP_", "APP_"],
      denyDirectRead: true,
      injectAsEnv: true,
    });

    expect(secCap.allowedSecretNames).toEqual(["SECRET_A", "SECRET_B"]);
    expect(secCap.allowedPrefixes).toEqual(["APP_"]);
    expect(secCap.denyDirectRead).toBe(true);
  });
});
